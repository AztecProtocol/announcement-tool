#!/usr/bin/env bash
#
# Nightly backup of the announcement tool: Postgres dump + signal-cli data
# directory, encrypted, uploaded off-host, and restore-verified before being
# declared good. See concept doc §10b — this is a locked spec, not a
# proposal:
#
#   - Nightly compressed pg_dump of the whole database.
#   - Encrypted BEFORE upload (subscriptions holds subscriber emails — PII).
#   - Uploaded to S3-compatible object storage OFF the VM.
#   - Retention: 30 daily + 12 monthly.
#   - Restore-verified: every dump is restored into a scratch database and
#     row counts sanity-checked before the backup is declared successful.
#     "Untested backups are not backups."
#   - A failed or missing backup raises an alert on the same path as
#     channel health.
#   - The signal-cli data directory is included (the one stateful
#     credential that can't simply be re-issued).
#
# FAIL LOUDLY. set -euo pipefail below is load-bearing: a script that
# silently half-works (dump succeeds, upload silently no-ops, nobody
# notices) is worse than no backup at all, because it produces false
# confidence instead of a dump. Every failure path here prints what failed
# and exits non-zero — do not add `|| true` anywhere in this file without
# thinking hard about whether it hides a real failure.
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — all from the environment. Nothing here is a default that
# silently degrades security: BACKUP_ENCRYPTION_KEY and the S3 credentials
# are required, not optional-with-a-fallback.
# ---------------------------------------------------------------------------

: "${PGHOST:?PGHOST must be set}"
: "${PGPORT:=5432}"
: "${PGUSER:?PGUSER must be set}"
: "${PGDATABASE:?PGDATABASE must be set}"
: "${PGPASSWORD:?PGPASSWORD must be set}"
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set — see .env.prod.example}"

# S3-compatible destination. BACKUP_S3_BUCKET / _ENDPOINT identify where the
# encrypted archive goes; credentials are picked up by the aws-cli from the
# standard AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars (not read
# directly by this script, so they never appear in a `set -x` trace or a
# process listing here).
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-announce-backups}"

# Local-only escape hatch for testing without real object storage: if set,
# the "upload" leg copies the encrypted archive to this directory instead of
# calling S3. Production must NOT set this — its presence is logged loudly
# so it can never be mistaken for a real upload.
BACKUP_LOCAL_DEST="${BACKUP_LOCAL_DEST:-}"

RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-30}"
RETENTION_MONTHLY="${BACKUP_RETENTION_MONTHLY:-12}"

SIGNAL_DATA_DIR="${SIGNAL_DATA_DIR:-/signal-data}"

# Same alert path as channel health: the worker's dispatchHealthAlerts()
# emails ALERT_EMAIL_TO through the configured ESP whenever it finds an
# unhealthy channel. This script has no access to the app's TypeScript
# runtime (it is a standalone shell script so it can run from cron/compose
# without the app booting), so it reaches the *same destination* through
# the *same ESP provider's HTTP API* directly. Best-effort: if the alert
# itself fails to send, that is logged but must NOT mask the original
# backup failure's exit code.
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-}"
ESP_PROVIDER="${ESP_PROVIDER:-console}"
EMAIL_FROM="${EMAIL_FROM:-}"
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-}"
BREVO_API_KEY="${BREVO_API_KEY:-}"
RESEND_API_KEY="${RESEND_API_KEY:-}"

WORKDIR="$(mktemp -d /tmp/announce-backup.XXXXXX)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY_OF_MONTH="$(date -u +%d)"

trap 'rc=$?; cleanup "$rc"' EXIT

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$1" >&2; }

# ---------------------------------------------------------------------------
# Alerting — fires on the failure path only. Never let an alert-send error
# override the real exit code; it is logged and swallowed.
# ---------------------------------------------------------------------------
send_alert() {
  local subject="$1" body="$2"
  if [ -z "$ALERT_EMAIL_TO" ]; then
    log "ALERT_EMAIL_TO not set — alert NOT sent (would have said: $subject)"
    return 0
  fi
  case "$ESP_PROVIDER" in
    brevo)
      if [ -z "$BREVO_API_KEY" ] || [ -z "$EMAIL_FROM" ]; then
        log "ALERT SEND SKIPPED: BREVO_API_KEY/EMAIL_FROM not set"
        return 0
      fi
      curl -fsS -X POST "https://api.brevo.com/v3/smtp/email" \
        -H "api-key: $BREVO_API_KEY" -H "content-type: application/json" \
        -d "$(printf '{"sender":{"email":"%s","name":"%s"},"to":[{"email":"%s"}],"subject":"%s","textContent":"%s"}' \
          "$EMAIL_FROM" "${EMAIL_FROM_NAME:-Aztec Announcements}" "$ALERT_EMAIL_TO" "$subject" "$body")" \
        >/dev/null && log "alert sent via brevo to $ALERT_EMAIL_TO" \
        || log "WARNING: alert send via brevo FAILED (backup failure above still stands)"
      ;;
    resend)
      if [ -z "$RESEND_API_KEY" ] || [ -z "$EMAIL_FROM" ]; then
        log "ALERT SEND SKIPPED: RESEND_API_KEY/EMAIL_FROM not set"
        return 0
      fi
      curl -fsS -X POST "https://api.resend.com/emails" \
        -H "authorization: Bearer $RESEND_API_KEY" -H "content-type: application/json" \
        -d "$(printf '{"from":"%s","to":["%s"],"subject":"%s","text":"%s"}' \
          "$EMAIL_FROM" "$ALERT_EMAIL_TO" "$subject" "$body")" \
        >/dev/null && log "alert sent via resend to $ALERT_EMAIL_TO" \
        || log "WARNING: alert send via resend FAILED (backup failure above still stands)"
      ;;
    *)
      log "ALERT (console, ESP_PROVIDER=$ESP_PROVIDER): $subject -- $body"
      ;;
  esac
}

cleanup() {
  local rc="$1"
  if [ "$rc" -ne 0 ]; then
    log "FAILED (exit $rc) — see errors above"
    send_alert "Aztec announcements: backup FAILED" \
      "The nightly backup script exited with status $rc at ${STAMP}. Check the backup service logs on the VM immediately -- an untested or missing backup is not a backup."
  fi
  rm -rf "$WORKDIR"
  exit "$rc"
}

mkdir -p "$WORKDIR"
log "workdir: $WORKDIR"

# ---------------------------------------------------------------------------
# Step 1: dump the whole database, compressed.
# ---------------------------------------------------------------------------
DUMP_FILE="$WORKDIR/announce-${STAMP}.sql.gz"
log "dumping $PGDATABASE from $PGHOST:$PGPORT..."
pg_dump --no-owner --no-privileges | gzip -9 > "$DUMP_FILE"
if [ ! -s "$DUMP_FILE" ]; then
  log "ERROR: pg_dump produced an empty file"
  exit 1
fi
log "dump ok: $(wc -c < "$DUMP_FILE") bytes"

# ---------------------------------------------------------------------------
# Step 2: bundle in the signal-cli data directory (the one credential that
# cannot be re-issued — losing it means re-registering the phone number).
# ---------------------------------------------------------------------------
BUNDLE_FILE="$WORKDIR/announce-${STAMP}.tar"
STAGE_DIR="$WORKDIR/stage"
mkdir -p "$STAGE_DIR"
cp "$DUMP_FILE" "$STAGE_DIR/"
log "bundling dump + signal-cli data..."
if [ -d "$SIGNAL_DATA_DIR" ] && [ -n "$(ls -A "$SIGNAL_DATA_DIR" 2>/dev/null || true)" ]; then
  mkdir -p "$STAGE_DIR/signal-data"
  cp -a "$SIGNAL_DATA_DIR/." "$STAGE_DIR/signal-data/"
  log "signal-cli data included ($(du -sh "$SIGNAL_DATA_DIR" | cut -f1))"
else
  log "WARNING: $SIGNAL_DATA_DIR is empty or missing — bundling dump only. This is expected on a signal-cli account not yet registered, but check on a live VM."
fi
# Staging everything under one directory before taring — BusyBox tar (the
# Alpine-based backup image) does not reliably support GNU tar's multiple
# `-C dir file -C otherdir .` idiom in one invocation; a single `-C` avoids
# the ambiguity entirely.
tar -cf "$BUNDLE_FILE" -C "$STAGE_DIR" .

# ---------------------------------------------------------------------------
# Step 3: encrypt BEFORE upload. Symmetric AES-256, passphrase from
# BACKUP_ENCRYPTION_KEY. This happens before the archive ever leaves the
# process's own temp directory.
# ---------------------------------------------------------------------------
ENC_FILE="${BUNDLE_FILE}.gpg"
log "encrypting..."
gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_ENCRYPTION_KEY" \
  --symmetric --cipher-algo AES256 --output "$ENC_FILE" "$BUNDLE_FILE"
rm -f "$BUNDLE_FILE"   # plaintext bundle must not survive past this point
if [ ! -s "$ENC_FILE" ]; then
  log "ERROR: encryption produced an empty file"
  exit 1
fi
log "encrypted ok: $(wc -c < "$ENC_FILE") bytes"

# ---------------------------------------------------------------------------
# Step 4: restore-verify BEFORE calling this a successful backup. Restore
# into a scratch database, sanity-check row counts against the source,
# tear the scratch database down. This is the step that separates a real
# backup from a hopeful one. A corrupt/truncated dump must fail this step
# loudly, not slide through.
# ---------------------------------------------------------------------------
SCRATCH_DB="announce_backup_verify_$$"
log "restore-verify: creating scratch database $SCRATCH_DB..."
psql -d postgres -v ON_ERROR_STOP=1 -c "create database \"$SCRATCH_DB\";"

# Explicitly invoked on every exit path below (success and each failure
# branch) rather than via a RETURN trap — there is no enclosing function at
# script scope for RETURN to fire on.
verify_cleanup() {
  psql -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
}

# Decrypt + unpack into a scratch area so we restore from the exact bytes
# that would be uploaded, not from the pre-encryption plaintext.
VERIFY_DIR="$WORKDIR/verify"
mkdir -p "$VERIFY_DIR"
gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_ENCRYPTION_KEY" \
  --decrypt --output "$VERIFY_DIR/bundle.tar" "$ENC_FILE"
tar -xf "$VERIFY_DIR/bundle.tar" -C "$VERIFY_DIR"
RESTORE_SQL_GZ="$VERIFY_DIR/$(basename "$DUMP_FILE")"
if [ ! -s "$RESTORE_SQL_GZ" ]; then
  verify_cleanup
  log "ERROR: restore-verify found no dump file inside the decrypted bundle"
  exit 1
fi

set +e
gunzip -c "$RESTORE_SQL_GZ" | psql -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 >"$VERIFY_DIR/restore.log" 2>&1
RESTORE_RC=$?
set -e
if [ "$RESTORE_RC" -ne 0 ]; then
  log "ERROR: restore into scratch database FAILED (rc=$RESTORE_RC) — dump is corrupt or truncated"
  tail -n 40 "$VERIFY_DIR/restore.log" >&2 || true
  verify_cleanup
  exit 1
fi
log "restore into scratch database ok"

# Row-count sanity check: every table that exists in the source must exist
# in the restore with the same row count. This catches a truncated dump
# that still happens to be valid SQL (e.g. cut off after CREATE TABLE but
# before the COPY data, or partway through a COPY block that psql tolerated).
log "restore-verify: comparing row counts against source..."
TABLES="$(psql -d "$PGDATABASE" -At -c "select table_name from information_schema.tables where table_schema='public' order by 1;")"
if [ -z "$TABLES" ]; then
  verify_cleanup
  log "ERROR: source database reports zero tables — refusing to call this verified"
  exit 1
fi

MISMATCH=0
while IFS= read -r TBL; do
  [ -z "$TBL" ] && continue
  SRC_COUNT="$(psql -d "$PGDATABASE" -At -c "select count(*) from \"$TBL\";")"
  DST_COUNT="$(psql -d "$SCRATCH_DB" -At -c "select count(*) from \"$TBL\";" 2>/dev/null || echo "MISSING")"
  if [ "$DST_COUNT" = "MISSING" ]; then
    log "ERROR: table $TBL is missing from the restored dump"
    MISMATCH=1
  elif [ "$SRC_COUNT" != "$DST_COUNT" ]; then
    log "ERROR: row count mismatch on $TBL: source=$SRC_COUNT restored=$DST_COUNT"
    MISMATCH=1
  else
    log "  $TBL: $SRC_COUNT rows ok"
  fi
done <<< "$TABLES"

verify_cleanup

if [ "$MISMATCH" -ne 0 ]; then
  log "ERROR: restore-verify FAILED — row counts do not match. This dump is not a backup."
  exit 1
fi
log "restore-verify passed: all tables present with matching row counts"

# ---------------------------------------------------------------------------
# Step 5: upload the encrypted archive off-host. Only after verification.
# ---------------------------------------------------------------------------
REMOTE_NAME="${BACKUP_S3_PREFIX}/daily/announce-${STAMP}.tar.gpg"
if [ -n "$BACKUP_LOCAL_DEST" ]; then
  log "*** BACKUP_LOCAL_DEST is set: uploading to a LOCAL directory, NOT real object storage. Do not set this in production. ***"
  mkdir -p "$BACKUP_LOCAL_DEST/${BACKUP_S3_PREFIX}/daily"
  cp "$ENC_FILE" "$BACKUP_LOCAL_DEST/$REMOTE_NAME"
else
  log "uploading to s3://$BACKUP_S3_BUCKET/$REMOTE_NAME..."
  AWS_ARGS=(s3 cp "$ENC_FILE" "s3://$BACKUP_S3_BUCKET/$REMOTE_NAME")
  if [ -n "$BACKUP_S3_ENDPOINT" ]; then
    AWS_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  fi
  aws "${AWS_ARGS[@]}"
fi
log "upload ok: $REMOTE_NAME"

# Monthly copy: on the 1st of the month, also land a copy in the monthly
# prefix so retention pruning (below) can keep 12 of *those* independently
# of the daily churn.
if [ "$DAY_OF_MONTH" = "01" ]; then
  MONTHLY_NAME="${BACKUP_S3_PREFIX}/monthly/announce-${STAMP}.tar.gpg"
  log "1st of the month — also copying into monthly retention: $MONTHLY_NAME"
  if [ -n "$BACKUP_LOCAL_DEST" ]; then
    mkdir -p "$BACKUP_LOCAL_DEST/${BACKUP_S3_PREFIX}/monthly"
    cp "$ENC_FILE" "$BACKUP_LOCAL_DEST/$MONTHLY_NAME"
  else
    AWS_ARGS=(s3 cp "$ENC_FILE" "s3://$BACKUP_S3_BUCKET/$MONTHLY_NAME")
    if [ -n "$BACKUP_S3_ENDPOINT" ]; then
      AWS_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
    fi
    aws "${AWS_ARGS[@]}"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: retention — 30 daily + 12 monthly. List remote objects, keep the
# newest N per prefix, delete the rest. Failure to prune is logged but does
# NOT fail the whole run: today's backup is safely uploaded and verified
# either way, and an old backup outliving its retention window is a cost
# problem, not a data-loss one — unlike every step above it.
# ---------------------------------------------------------------------------
prune() {
  local prefix="$1" keep="$2"
  log "pruning $prefix to the newest $keep..."
  local names
  if [ -n "$BACKUP_LOCAL_DEST" ]; then
    names="$(ls -1 "$BACKUP_LOCAL_DEST/$prefix" 2>/dev/null | sort -r || true)"
    local i=0
    while IFS= read -r n; do
      [ -z "$n" ] && continue
      i=$((i+1))
      if [ "$i" -gt "$keep" ]; then
        rm -f "$BACKUP_LOCAL_DEST/$prefix/$n" && log "  pruned $n"
      fi
    done <<< "$names"
  else
    local list_args=(s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "$prefix/" --query "sort_by(Contents,&LastModified)[].Key" --output text)
    if [ -n "$BACKUP_S3_ENDPOINT" ]; then
      list_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
    fi
    names="$(aws "${list_args[@]}" 2>/dev/null || true)"
    local total
    total="$(printf '%s\n' "$names" | tr '\t' '\n' | grep -c . || true)"
    local to_delete=$((total - keep))
    if [ "$to_delete" -gt 0 ]; then
      printf '%s\n' "$names" | tr '\t' '\n' | grep . | head -n "$to_delete" | while IFS= read -r key; do
        local del_args=(s3 rm "s3://$BACKUP_S3_BUCKET/$key")
        if [ -n "$BACKUP_S3_ENDPOINT" ]; then
          del_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
        fi
        aws "${del_args[@]}" && log "  pruned $key"
      done
    fi
  fi
}

if ! prune "${BACKUP_S3_PREFIX}/daily" "$RETENTION_DAILY"; then
  log "WARNING: pruning daily retention failed (non-fatal — today's verified backup still stands)"
fi
if [ "$DAY_OF_MONTH" = "01" ]; then
  if ! prune "${BACKUP_S3_PREFIX}/monthly" "$RETENTION_MONTHLY"; then
    log "WARNING: pruning monthly retention failed (non-fatal)"
  fi
fi

log "backup complete: ${STAMP}, verified, uploaded to $REMOTE_NAME"
exit 0
