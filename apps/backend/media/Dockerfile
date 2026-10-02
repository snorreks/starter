# syntax=docker/dockerfile:1
#
# apps/backend/media/Dockerfile
#
# Two stages, both pinned by digest. A digest is a content hash: the tag can be
# moved by whoever publishes it, the digest cannot, so a build six months from
# now gets the same two base images this README's measurements were taken with.
# The digests below are the linux/amd64 manifests — the platform this crate's
# measurements were measured on, and the platform Cloudflare Containers runs.
# Rebuilding for another architecture means resolving the digest for it; that is
# a deliberate act, not an accident of a tag.
#
# Why not `scratch`: this process execs `ffmpeg`, so it needs a real userspace,
# a dynamic loader, FFmpeg's own shared libraries, and CA certificates. A static
# Rust binary would still not make the image static — see the note on
# `ldd` in the README.

ARG RUST_IMAGE=docker.io/library/rust@sha256:dacc9e51f252243eb59d2fb4cb4ad8b0d3f607b6a82c398cf8a321e59ff778a7
ARG RUNTIME_IMAGE=docker.io/library/debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

# ── Stage 1: build ─────────────────────────────────────────────────────────────────
FROM ${RUST_IMAGE} AS build

WORKDIR /src

# Dependencies first, in their own layer, so editing source does not re-download
# the registry. `mkdir src` with a stub target is the standard trick: Cargo needs
# a target to exist before it will build only the dependencies.
#
# `touch src/*.rs` after the real sources are copied is not decoration. Cargo
# decides to rebuild from file timestamps, and a copied source tree can carry a
# timestamp older than the artefacts it is compared against — which ships the stub
# (`fn main() {}`: no output, exit 0) instead of the program. The `test -n` below
# is the check that would have caught it.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
RUN mkdir -p src \
    && echo 'fn main() {}' > src/main.rs \
    && echo '' > src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src

COPY src ./src

# The revision this binary is, so `/health` can report it. A build with no
# revision (an untagged local build) reports "unversioned" rather than guessing.
ARG BUILD_GIT_REVISION=""
ENV BUILD_GIT_REVISION=${BUILD_GIT_REVISION}

# `--locked` is the point: it fails rather than resolving a different dependency.
# `--offline` proves the sources came from Cargo.lock and the registry cache, not
# from a network fetch of something new.
#
# The last line is a self-check, and it exists because of what happened here: an
# earlier version of this file produced an image whose `starter-media` printed
# nothing and exited 0 for every argument. A stub that succeeds is the most
# expensive kind of wrong artefact, so the build now refuses to finish unless the
# binary answers for itself.
RUN touch src/*.rs \
    && cargo build --release --locked --offline \
    && cp target/release/starter-media /usr/local/bin/starter-media \
    && strip /usr/local/bin/starter-media \
    && test -n "$(/usr/local/bin/starter-media --version)"

# ── Stage 2: runtime ──────────────────────────────────────────────────────────────
FROM ${RUNTIME_IMAGE}

# FFmpeg with libx264 and AAC, from Debian's own archive, and CA certificates so
# an outbound TLS client (none today) is not silently broken. No recommended
# packages: they are the difference between a 400 MB image and a 300 MB one, and
# none of them are needed to encode a three-second synthetic clip.
#
# Provenance, licences and the exact package versions the image was built with are
# in apps/backend/media/THIRD_PARTY.md. That file is updated whenever this line
# changes; an FFmpeg upgrade without a provenance update is a review finding.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A dedicated unprivileged user. The container never runs as root: the only
# capabilities the process needs are "exec a subprocess" and "write to its own
# temp directory", and a root process that spawns a subprocess parsing
# attacker-supplied media is the worst of both.
RUN groupadd --system --gid 10001 media \
    && useradd --system --uid 10001 --gid media --home-dir /nonexistent --shell /usr/sbin/nologin media \
    && mkdir -p /var/tmp/media \
    && chown media:media /var/tmp/media

COPY --from=build /usr/local/bin/starter-media /usr/local/bin/starter-media

# Where every request's temp files live. One directory, owned by the service
# user, inside the image: an operator can `docker exec` and look, and nothing is
# written to a path the process did not choose.
ENV MEDIA_TMPDIR=/var/tmp/media
ENV MEDIA_PORT=8080
ENV MEDIA_FFMPEG_PATH=/usr/bin/ffmpeg
ENV MEDIA_FFPROBE_PATH=/usr/bin/ffprobe

USER media:media
WORKDIR /var/tmp/media

# Cloudflare Containers routes to the container's port and treats a successful
# HTTP response on that port as readiness. There is deliberately no
# `HEALTHCHECK`: it would need curl, which this image does not install, and a
# health check that cannot run is a health check that reports the container dead.
# `/health` is the liveness endpoint, and it does not encode — see src/http.rs.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/starter-media"]
CMD ["serve"]