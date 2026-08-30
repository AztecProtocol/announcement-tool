#!/usr/bin/env bash
# Shared alert-sending helper, extracted from scripts/backup.sh's
# original inline send_alert() (fix round 1 on Task 6: the cert-reload
# hook needed the same alert path — "a failed or missing backup raises
# an alert on the same path as channel health" per the concept doc, and
# a failed cert-reload deserves exactly the same treatment, not a
# second, different mechanism). Both backup.sh and
# infra/ansible/roles/cert_reload/templates/cert-reload.sh.j2 source
# this file rather than each keeping their own copy of the curl/case
# logic, so the two alert paths cannot drift apart.
#
# Usage: source this file, then call `send_alert "$SUBJECT" "$BODY"`.
# Reads ALERT_EMAIL_TO / ESP_PROVIDER / EMAIL_FROM / EMAIL_FROM_NAME /
# BREVO_API_KEY / RESEND_API_KEY from the environment — same variable
# names the app and backup.sh already use, so no new configuration is
# needed on a host that already has backup.sh's .env set up (both are
# required there via the `:?` guards in docker-compose.split.yml).
#
# Best-effort by design: a failure to SEND an alert must never mask or
# override the real failure being reported. Every branch below logs and
# returns 0 even when the send itself fails.

# _json_escape STRING — prints STRING safe to place inside a double-quoted
# JSON string literal. cert-reload.sh.j2 passes file paths and excerpts of
# Postgres's own log output into $body; a `"` or `\` in either — plain in a
# file path, routine in a Postgres error line (e.g. a quoted role or file
# name) — would otherwise land in the request body unescaped and produce
# malformed JSON. Brevo/Resend then reject the request with a 400, which
# means the alert about a broken cert reload (or a failed backup) is
# exactly the one that silently fails to send. Prefer jq, which handles
# every JSON-special character (control characters, unicode) correctly;
# fall back to a plain sed pass over the two characters that break the
# hand-built printf templates below (backslash first, so escaping it
# doesn't double-escape the quotes added right after) when jq is not
# installed on the host.
_json_escape() {
  if command -v jq >/dev/null 2>&1; then
    jq -Rn --arg s "$1" '$s' | sed -e 's/^"//' -e 's/"$//'
  else
    # jq is preferred precisely because it also escapes control characters
    # (newlines, tabs) correctly; a bare sed pass over only `"`/`\` would
    # leave a literal newline in the JSON string body, which is itself
    # invalid JSON — cert-reload.sh.j2's log excerpts are realistically
    # multi-line, so this fallback has to fold newlines to `\n` too, not
    # just the two characters that break the printf quoting.
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}' \
      | sed -e '$ s/\\n$//'
  fi
}

send_alert() {
  local subject="$1" body="$2"
  local _alert_email_to="${ALERT_EMAIL_TO:-}"
  local _esp_provider="${ESP_PROVIDER:-console}"
  local _email_from="${EMAIL_FROM:-}"
  local _email_from_name="${EMAIL_FROM_NAME:-}"
  local _brevo_api_key="${BREVO_API_KEY:-}"
  local _resend_api_key="${RESEND_API_KEY:-}"

  if [ -z "$_alert_email_to" ]; then
    log "ALERT_EMAIL_TO not set — alert NOT sent (would have said: $subject)"
    return 0
  fi
  case "$_esp_provider" in
    brevo)
      if [ -z "$_brevo_api_key" ] || [ -z "$_email_from" ]; then
        log "ALERT SEND SKIPPED: BREVO_API_KEY/EMAIL_FROM not set"
        return 0
      fi
      curl -fsS -X POST "https://api.brevo.com/v3/smtp/email" \
        -H "api-key: $_brevo_api_key" -H "content-type: application/json" \
        -d "$(printf '{"sender":{"email":"%s","name":"%s"},"to":[{"email":"%s"}],"subject":"%s","textContent":"%s"}' \
          "$(_json_escape "$_email_from")" "$(_json_escape "${_email_from_name:-Aztec Announcements}")" \
          "$(_json_escape "$_alert_email_to")" "$(_json_escape "$subject")" "$(_json_escape "$body")")" \
        >/dev/null && log "alert sent via brevo to $_alert_email_to" \
        || log "WARNING: alert send via brevo FAILED (original failure above still stands)"
      ;;
    resend)
      if [ -z "$_resend_api_key" ] || [ -z "$_email_from" ]; then
        log "ALERT SEND SKIPPED: RESEND_API_KEY/EMAIL_FROM not set"
        return 0
      fi
      curl -fsS -X POST "https://api.resend.com/emails" \
        -H "authorization: Bearer $_resend_api_key" -H "content-type: application/json" \
        -d "$(printf '{"from":"%s","to":["%s"],"subject":"%s","text":"%s"}' \
          "$(_json_escape "$_email_from")" "$(_json_escape "$_alert_email_to")" \
          "$(_json_escape "$subject")" "$(_json_escape "$body")")" \
        >/dev/null && log "alert sent via resend to $_alert_email_to" \
        || log "WARNING: alert send via resend FAILED (original failure above still stands)"
      ;;
    *)
      log "ALERT (console, ESP_PROVIDER=$_esp_provider): $subject -- $body"
      ;;
  esac
}
