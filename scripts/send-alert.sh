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
          "$_email_from" "${_email_from_name:-Aztec Announcements}" "$_alert_email_to" "$subject" "$body")" \
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
          "$_email_from" "$_alert_email_to" "$subject" "$body")" \
        >/dev/null && log "alert sent via resend to $_alert_email_to" \
        || log "WARNING: alert send via resend FAILED (original failure above still stands)"
      ;;
    *)
      log "ALERT (console, ESP_PROVIDER=$_esp_provider): $subject -- $body"
      ;;
  esac
}
