#!/usr/bin/env bash
# Prepare persistent directories, then run the single Realtime server process.
set -euo pipefail

: "${CRDT_STORE:=/data/crdt}"
export CRDT_STORE
: "${PUBLIC_BASE_URL:=http://127.0.0.1:8081}"
# Store binary blobs on the same persistent volume by default.
: "${BLOB_DIR:=/data/blobs}"
export BLOB_DIR
# Per-vault git audit/backup repositories live on the persistent volume too.
: "${GIT_DATA_DIR:=/data/git}"
export GIT_DATA_DIR

legacy_store=/data/ysweet
if [[ "${CRDT_STORE}" == "/data/crdt" && -d "${legacy_store}" ]] \
    && find "${legacy_store}" -mindepth 1 -print -quit | read -r _ \
    && { [[ ! -d "${CRDT_STORE}" ]] || ! find "${CRDT_STORE}" -mindepth 1 -print -quit | read -r _; }; then
    cat >&2 <<'EOF'
Refusing to start: legacy y-sweet data exists at /data/ysweet, but the native
CRDT store at /data/crdt is absent or empty. Stop every y-sweet process that
can write this store, then run:

  realtime-server crdt migrate-ysweet-cutover /data/ysweet /data/crdt YSWEET_PID

Do not copy or import the store while y-sweet may still be running.
EOF
    exit 1
fi

mkdir -p "${CRDT_STORE}" "${BLOB_DIR}" "${GIT_DATA_DIR}"
exec realtime-server
