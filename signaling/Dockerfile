# Build
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

# Runtime
FROM debian:stable-slim
RUN useradd -m app
COPY --from=build /app/target/release/gametracker-signal /usr/local/bin/gametracker-signal
USER app
ENV PORT=8080
EXPOSE 8080
CMD ["gametracker-signal"]
