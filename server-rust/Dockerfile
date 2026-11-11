FROM rust:1.98.1-bookworm AS build
WORKDIR /app/server-rust
COPY server-rust/Cargo.toml server-rust/Cargo.lock server-rust/rust-toolchain.toml ./
COPY server-rust/src ./src
COPY server-rust/compat ./compat
COPY server/public /app/server/public
RUN cargo build --release --locked --bin sms-code-relay

FROM debian:bookworm-slim
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/bluegrain-llc/sms-reader"
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 relay && useradd --uid 10001 --gid relay --no-create-home relay
ENV PORT=8080
WORKDIR /app
COPY --from=build /app/server-rust/target/release/sms-code-relay ./sms-code-relay
USER 10001:10001
EXPOSE 8080
CMD ["/app/sms-code-relay"]
