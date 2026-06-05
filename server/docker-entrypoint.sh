#!/usr/bin/env bash
# Run the internal y-sweet sync server and the InstaSync auth server side by side
# in one container. The auth server reverse-proxies y-sweet under /d/*, so only
# this container's single port (BIND_ADDR / 8081) needs to be exposed and the
# only URL the Obsidian plugin needs is this server's.
set -euo pipefail

: "${YSWEET_INTERNAL_PORT:=8080}"
: "${YSWEET_STORE:=/data/ysweet}"
: "${PUBLIC_BASE_URL:=http://127.0.0.1:8081}"
# Store binary blobs on the persistent volume next to the y-sweet data by default.
: "${BLOB_DIR:=/data/blobs}"
export BLOB_DIR
# The auth server reaches y-sweet here; keep it in sync with the internal port.
export YSWEET_URL="http://127.0.0.1:${YSWEET_INTERNAL_PORT}"

if [[ -z "${YSWEET_AUTH_KEY:-}" ]]; then
  echo "FATAL: YSWEET_AUTH_KEY is required (shared key for y-sweet + auth server)." >&2
  echo "Generate one with: docker run --rm --entrypoint y-sweet <image> gen-auth --json" >&2
  exit 1
fi

mkdir -p "${YSWEET_STORE}" "${BLOB_DIR}"

# y-sweet bakes --url-prefix (this server's public URL) into the tokens it mints,
# so clients connect back to /d/* on the auth server, which proxies them here.
y-sweet serve "${YSWEET_STORE}" \
  --host 127.0.0.1 \
  --port "${YSWEET_INTERNAL_PORT}" \
  --auth "${YSWEET_AUTH_KEY}" \
  --url-prefix "${PUBLIC_BASE_URL}" \
  --prod &
YSWEET_PID=$!

instasync-server &
SERVER_PID=$!

# Take the whole container down if either process exits, and forward signals.
term() {
  kill -TERM "${YSWEET_PID}" "${SERVER_PID}" 2>/dev/null || true
}
trap term TERM INT

wait -n
status=$?
term
wait || true
exit "${status}"
