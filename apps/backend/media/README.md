# Finite FFmpeg processor

## Purpose

This first-party Rust project builds `starter-media`, a finite Rust CLI runtime
that executes inside the optional Cloud Run Job. It accepts one bounded encode
operation and exits with a truthful status. It does not run a web server.

## Setup

A fresh checkout needs the Rust toolchain pinned in `rust-toolchain.toml`,
FFmpeg and FFprobe for host-side tests, and Docker or Podman for the full
`test:compute` image lane. The image installs its own FFmpeg packages from
`Dockerfile.job`.

## Commands

```sh
cargo run --locked -- fixture --out /tmp/sample-v1.mp4
cargo run --locked -- encode --input /tmp/sample-v1.mp4 --output /tmp/encoded.mp4 --preset demo-180p-v1 --attempt-id attempt-1
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --all -- --check
```

The runner image is built from [Dockerfile.job](Dockerfile.job). The local compute lane builds and runs that image with real FFmpeg:

```sh
bun run test:compute
```

It requires Docker or Podman. The lane refuses when the engine is unavailable.

## Boundaries

- The CLI receives local file paths from the Cloud Run runner; it does not listen on a port or accept network requests.
- Input and output sizes, FFmpeg/FFprobe deadlines, encoder threads and retained stderr are bounded in `src/protocol.rs`, `src/preset.rs` and `src/process.rs`.
- SIGTERM and SIGINT cancel the real FFmpeg child, wait for it to exit and remove its temporary directory.
- The process holds no Supabase credential, Google service account key or persistent R2 credential. The runner obtains a platform identity token and uses short-lived grants through the web Worker.
- `sample-v1` and `demo-180p-v1` identify the encoded result contract. Changing them requires updating the corresponding shared schemas and compatibility checks.

## Validation

The `test:compute` lane runs the actual image and FFmpeg binary against local metadata/grant fixtures and checks the resulting bytes. Rust unit tests cover argument validation, bounded subprocess output, timeout/cancellation cleanup, and encode/probe failures. Hosted Cloud Run, Google IAM, Supabase, Cloudflare and cross-cloud transfer behavior are NOT RUN by this local lane.
