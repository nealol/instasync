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

mkdir -p "${CRDT_STORE}" "${BLOB_DIR}" "${GIT_DATA_DIR}"
exec realtime-server
