#!/usr/bin/env bash
#
# Periodic receive poll for the signal-cli-rest-api sidecar.
#
# signal-cli warns that an account that only ever SENDS and never RECEIVES
# degrades over time and sending silently stops working — there is no error
# at send time, `/v2/send` keeps returning 201, messages simply stop
# arriving. Hit live on 2026-08-11 (see README "Signal registration and
# operations"). The fix is calling `GET /v1/receive/{number}` on a schedule
# so the account looks like a normal, active client to Signal's servers.
#
# This script makes ONE receive call and exits; scheduling (how often, what
# to do on failure) lives in docker-compose.prod.yml, in the same
# sleep-loop-plus-entrypoint shape as the `backup` service uses for
# scripts/backup.sh — see the comment on that service before changing the
# pattern here.
#
# FAIL LOUDLY. set -euo pipefail is load-bearing: a poll that silently
# no-ops (curl fails, nobody notices, the account quietly degrades) is
# worse than no poll at all, because it produces false confidence instead
# of a real receive call. Every failure path here prints what failed and
# exits non-zero.
set -euo pipefail

: "${SIGNAL_API_BASE:?SIGNAL_API_BASE must be set}"
: "${SIGNAL_ACCOUNT:?SIGNAL_ACCOUNT must be set}"

log() { printf '[signal-receive %s] %s\n' "$(date -u +%H:%M:%S)" "$1" >&2; }

# The account number is part of the URL path, so it must be percent-encoded
# — Signal account numbers are E.164 (`+15551234567`), and the leading `+`
# is meaningful to some HTTP intermediaries if left unencoded.
ENCODED_ACCOUNT="$(printf '%s' "$SIGNAL_ACCOUNT" | sed 's/+/%2B/g')"
URL="${SIGNAL_API_BASE%/}/v1/receive/${ENCODED_ACCOUNT}"

log "polling $URL ..."

HTTP_CODE="$(curl -fsS -o /tmp/signal-receive-body.$$ -w '%{http_code}' "$URL" 2>/tmp/signal-receive-err.$$)" || {
  RC=$?
  log "ERROR: receive poll FAILED (curl exit $RC) — signal-cli-rest-api unreachable at $SIGNAL_API_BASE"
  cat /tmp/signal-receive-err.$$ >&2 || true
  rm -f /tmp/signal-receive-body.$$ /tmp/signal-receive-err.$$
  exit 1
}
rm -f /tmp/signal-receive-err.$$

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  log "ERROR: receive poll returned HTTP $HTTP_CODE (expected 2xx)"
  cat /tmp/signal-receive-body.$$ >&2 || true
  rm -f /tmp/signal-receive-body.$$
  exit 1
fi

MSG_COUNT="$(grep -o '{' /tmp/signal-receive-body.$$ 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
rm -f /tmp/signal-receive-body.$$
log "receive poll ok (HTTP $HTTP_CODE, ~$MSG_COUNT message object(s) in response)"
exit 0
