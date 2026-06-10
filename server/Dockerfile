# Multi-stage build for the Realtime auth server.
# Build context is the `server/` directory.
#
# The final image bundles a stock y-sweet binary and runs it internally; the auth
# server reverse-proxies it under /d/*, so only one URL/port needs to be exposed
# and the Obsidian plugin only ever needs this server's URL.

# --- dependency planner (cargo-chef caches the heavy dep build) -------------
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# --- build -----------------------------------------------------------------
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Compile dependencies first; this layer is cached unless Cargo.toml/lock change.
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin realtime-server

# --- y-sweet binary --------------------------------------------------------
# Download the prebuilt y-sweet release matching the `y-sweet` npm version used
# by the plugin/tests (see package.json). Pin via build args.
FROM debian:bookworm-slim AS ysweet
ARG YSWEET_VERSION=0.9.1
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) ys_arch=linux-x64 ;; \
      arm64) ys_arch=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/drifting-in-space/y-sweet/releases/download/v${YSWEET_VERSION}/y-sweet-${ys_arch}.gz"; \
    curl -fsSL "${url}" | gunzip > /usr/local/bin/y-sweet; \
    chmod 0755 /usr/local/bin/y-sweet; \
    /usr/local/bin/y-sweet version

# --- cr-sqlite loadable extension ------------------------------------------
# Downloads the cr-sqlite loadable extension that backs synced plugin databases
# (server-side replica + git dumps). Its major version MUST match the client
# WASM's sync-format major (see CRSQLITE_VERSION / the plugin release asset).
# Replication degrades gracefully if this is absent, so the build tolerates a
# missing asset (the extension is simply not installed).
FROM debian:bookworm-slim AS crsqlite
# VERSION PIN: must stay on the same cr-sqlite minor line as the client WASM
# (`@vlcn.io/crsqlite-wasm` in the repo-root package.json, currently 0.16.x) —
# they share the `crsqlite-1` sync format. Bump both together, plus the
# checksums below and SYNC_FORMAT (src/pluginDb/types.ts) on wire changes.
ARG CRSQLITE_VERSION=0.16.3
# sha256 checksums of the pinned release zips; the download is verified when
# non-empty (override alongside CRSQLITE_VERSION when bumping the pin).
ARG CRSQLITE_SHA256_AMD64="8f6fd31a2be2ba8c3101aad067a504a2e63c8e9b51cc4ace786009c02e7ecbae"
ARG CRSQLITE_SHA256_ARM64="c26aac668db9f0c455a37cbfba2ae129a11313a1f5b30b4bdcee69cfa1d1f94a"
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) cr_arch=x86_64; cr_sha="${CRSQLITE_SHA256_AMD64}" ;; \
      arm64) cr_arch=aarch64; cr_sha="${CRSQLITE_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/vlcn-io/cr-sqlite/releases/download/v${CRSQLITE_VERSION}/crsqlite-linux-${cr_arch}.zip"; \
    mkdir -p /opt/crsqlite; \
    if curl -fsSL "${url}" -o /tmp/crsqlite.zip; then \
      if [ -n "${cr_sha}" ]; then echo "${cr_sha}  /tmp/crsqlite.zip" | sha256sum -c -; fi; \
      unzip -o /tmp/crsqlite.zip -d /opt/crsqlite; \
      find /opt/crsqlite -name 'crsqlite*.so' -exec cp {} /opt/crsqlite/crsqlite.so \; || true; \
    else \
      echo "WARN: cr-sqlite extension download failed; plugin-db replication disabled" >&2; \
    fi; \
    touch /opt/crsqlite/.ready

# --- runtime ---------------------------------------------------------------
# rustls + webpki roots need ca-certificates to validate the OIDC provider's TLS.
FROM debian:bookworm-slim AS runtime
# git is the backend of the per-vault audit log / backup (see src/git.rs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/realtime-server /usr/local/bin/realtime-server
COPY --from=ysweet /usr/local/bin/y-sweet /usr/local/bin/y-sweet
# Install the cr-sqlite extension if it was fetched (the dir always exists).
COPY --from=crsqlite /opt/crsqlite/ /usr/local/lib/crsqlite/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Persist the sqlite db and y-sweet store under /data (mount a volume here).
RUN mkdir -p /data
WORKDIR /data
VOLUME ["/data"]

# Sensible container defaults; override the rest (YSWEET_AUTH_KEY, OIDC_*) at runtime.
# PUBLIC_BASE_URL is baked into minted client tokens, so set it to the URL clients
# reach this server at (e.g. https://sync.example.com) in production.
ENV BIND_ADDR=0.0.0.0:8081 \
    PUBLIC_BASE_URL=http://127.0.0.1:8081 \
    YSWEET_INTERNAL_PORT=8080 \
    YSWEET_STORE=/data/ysweet \
    GIT_DATA_DIR=/data/git \
    DATABASE_URL=sqlite:///data/realtime.db?mode=rwc \
    CRSQLITE_EXT_PATH=/usr/local/lib/crsqlite/crsqlite.so \
    RUST_LOG=realtime_server=info,warn

EXPOSE 8081
ENTRYPOINT ["docker-entrypoint.sh"]
