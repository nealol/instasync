# Multi-stage build for the InstaSync auth server.
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
RUN cargo build --release --bin instasync-server

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

# --- runtime ---------------------------------------------------------------
# rustls + webpki roots need ca-certificates to validate the OIDC provider's TLS.
FROM debian:bookworm-slim AS runtime
# git is the backend of the per-vault audit log / backup (see src/git.rs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/instasync-server /usr/local/bin/instasync-server
COPY --from=ysweet /usr/local/bin/y-sweet /usr/local/bin/y-sweet
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
    DATABASE_URL=sqlite:///data/instasync.db?mode=rwc \
    RUST_LOG=instasync_server=info,warn

EXPOSE 8081
ENTRYPOINT ["docker-entrypoint.sh"]
