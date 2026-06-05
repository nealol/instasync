# Multi-stage build for the InstaSync auth server.
# Build context is the `server/` directory.

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

# --- runtime ---------------------------------------------------------------
# rustls + webpki roots need ca-certificates to validate the OIDC provider's TLS.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/instasync-server /usr/local/bin/instasync-server

# Persist the sqlite db under /data (mount a volume here).
RUN mkdir -p /data
WORKDIR /data
VOLUME ["/data"]

# Sensible container defaults; override the rest (YSWEET_*, OIDC_*) at runtime.
ENV BIND_ADDR=0.0.0.0:8081 \
    PUBLIC_BASE_URL=http://127.0.0.1:8081 \
    DATABASE_URL=sqlite:///data/instasync.db?mode=rwc \
    RUST_LOG=instasync_server=info,warn

EXPOSE 8081
ENTRYPOINT ["instasync-server"]
