#!/usr/bin/env bash
# Generates a throwaway CA + server cert for db-tls.integration.test.ts, plus
# a second, unrelated CA used only to prove verify-full rejects a server the
# CA did not sign. Output goes to a gitignored directory — never commit these.
set -euo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

# --- The real CA and the server cert it signs, for CN/SAN "localhost" ------
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout ca.key -out ca.crt -subj "/CN=announce-test-ca" 2>/dev/null

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
  -subj "/CN=localhost" 2>/dev/null

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 -sha256 \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1") 2>/dev/null

# --- A second, unrelated CA — used to prove verify-full rejects it ---------
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout wrong-ca.key -out wrong-ca.crt -subj "/CN=announce-wrong-ca" 2>/dev/null

rm -f server.csr ca.srl

# Postgres refuses to start unless the server key is 0600 and owned by the
# user running the process. The compose mount runs as the postgres image's
# default uid, so a permissive-but-not-writable mode covers both the host
# user (running this script) and the container.
chmod 600 server.key ca.key wrong-ca.key

echo "Wrote test certs to $OUT"
