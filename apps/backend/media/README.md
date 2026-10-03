# apps/backend/media — the bounded FFmpeg encode processor

## Purpose and runtime

One Rust crate with one encoding core and two entrypoints. It runs as a Linux
process — inside a Cloudflare Container, or as a finite batch command — and never
in the browser or in workerd.

| Entrypoint | Shape | Used by |
|---|---|---|
| `starter-media serve` | an HTTP server that stays up | a Cloudflare Container, reached from a Durable Object |
| `starter-media encode` | a command that encodes a local file and exits with a status | a finite batch runner (a Cloud Run Job, a cron container, an operator's laptop) |

Both call the same `encode` function. There is no second implementation of "run
FFmpeg, check the result" — the failure modes that get fixed in one and not the
other are the ones this crate cannot afford.

The web app, the database and the auth live elsewhere in this repository. This
crate knows nothing about D1, R2, Workflows or jobs, holds no credentials, and
exposes no public endpoint. It is the Linux process at the end of a request, and
its whole job is to turn bounded bytes into validated bytes or into a truthful
failure.

## What "bounded" means here, concretely

Every limit below is a constant in `src/protocol.rs` or a `const` in
`src/preset.rs`, and every one is checked in code. `/health` reports the same
numbers, so an operator can compare what the server promises against what it
does without reading this file.

| Bound | Value | Enforced in | What happens past it |
|---|---|---|---|
| request head | 16 KiB | `http::read_head` | connection refused, buffer never grows |
| request body | 5 MiB | `http::read_body`, before buffering | `400 payload_too_large` |
| output | 10 MiB | `encode`, before validation | `400 output_too_large` |
| FFmpeg deadline | 120 s | `process` poll loop, then kill + reap | `503 deadline_exceeded` |
| FFprobe deadline | 20 s | same poll loop | `503 deadline_exceeded` |
| encoding threads | 2 | `-threads 2` in the preset argv | — |
| concurrent encodes | 1 | the encode slot in `http` | `429 busy` |
| stderr retained | 8 KiB (tail) | reader thread in `process` | bytes are counted, not kept |
| attempt id | 128 chars of `[A-Za-z0-9._-]` | `http::validate_attempt_id` | `400 invalid_attempt_id` |
| probe document | 1 MiB | `probe::validate` | `400 invalid_output` |

`Transfer-Encoding: chunked` is refused outright. Honouring it would mean
implementing a length limit for a framing whose length the client may lie about;
`Content-Length` is the only framing this server reads.

## The protocol, frozen

Protocol `sample-v1`, preset `demo-180p-v1`, fixture `sample-v1`. These names
are a contract with the TypeScript side (PR F/H), and the golden documents in
[`fixtures/protocol/`](fixtures/protocol) are what both sides type against.
Regenerate with `cargo run --example generate_goldens`, read the diff, and change
both sides together — renaming a preset is a protocol change, not a refactor.

### `GET /health`

Liveness and identity. It reports the release, the protocol, the preset, the
fixture id and every bound above. It does **not** encode and it does not run
FFprobe: a poll that spends CPU inside FFmpeg is a load generator, not a health
check. The encode path is what proves the tools are present, and it fails
truthfully when they are not.

### `POST /encode`

```bash
curl -X POST http://127.0.0.1:8080/encode \
  --data-binary @fixtures/media/sample-v1.mp4 \
  -H 'content-type: application/octet-stream' \
  -H 'x-protocol: sample-v1' \
  -H 'x-preset: demo-180p-v1' \
  -H 'x-attempt-id: attempt-1' \
  --output out.mp4
```

* `x-preset` and `x-attempt-id` are required. `x-protocol` may be omitted, which
  means this build's protocol; a *different* value is refused, so a caller cannot
  silently skip the version check.
* The response body is the real MP4. Success carries `x-output-sha256`,
  `x-output-bytes`, `x-output-codec`, `x-output-dimensions`,
  `x-output-duration-ms`, plus the echoed `x-protocol`, `x-preset` and
  `x-attempt-id`.
* Failures are `{"error":{"code","message","retryable"}}`. `code` is a frozen
  token; `message` is a fixed sentence; `retryable` tells the caller whether the
  same bytes are worth sending again. **No FFmpeg stderr, no path and no
  caller-supplied text ever appears in a response.** The bounded stderr tail goes
  to the container's own log for an operator.

| Code | Status | Retryable | Means |
|---|---|---|---|
| `input_empty` | 400 | no | zero bytes arrived |
| `payload_too_large` | 400 | no | over 5 MiB, refused before reading the body |
| `unsupported_transfer_encoding` | 400 | no | chunked, or no `Content-Length` |
| `protocol_mismatch` | 400 | no | `x-protocol` names another protocol |
| `unsupported_preset` | 400 | no | absent, or not `demo-180p-v1` |
| `invalid_attempt_id` | 400 | no | absent, over 128 chars, or outside the charset |
| `invalid_media` | 400 | no | FFmpeg refused the input — **terminal, do not retry** |
| `output_too_large` | 400 | no | over 10 MiB |
| `invalid_output` | 400 | no | the output failed ffprobe validation |
| `not_found` | 404 | no | no such route |
| `busy` | 429 | yes | the one encode slot is taken |
| `deadline_exceeded` | 503 | yes | the deadline passed; the child was killed and reaped |
| `cancelled` | 503 | yes | the caller disconnected, or the container is stopping |
| `internal_error` | 500 | depends | an I/O failure with no better classification |

`invalid_media` being terminal is the important row. A caller that retries an
undecodable file burns its whole attempt allowance on a deterministic failure.

## The preset

`demo-180p-v1`, and it is the only one. The argv is built as a vector
(`preset::ffmpeg_args`) and spawned with `Command::args` — there is no string
concatenated into a command line anywhere in this crate, so a container whose
metadata is `; rm -rf /` is a filename.

```text
-hide_banner -nostdin -loglevel error -y
-i <input>
-map 0:v:0 -map 0:a:0?
-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -profile:v baseline
-r 24
-vf scale=320:180:force_original_aspect_ratio=decrease:flags=bicubic,
    pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1
-threads 2 -filter_threads 1 -fps_mode cfr
-c:a aac -b:a 64k -ac 2 -ar 44100          (video-only input → -an)
-map_metadata -1 -map_chapters -1
-fflags +bitexact -flags:v +bitexact -flags:a +bitexact
-movflags +faststart
<output>
```

`-nostdin` matters more than it looks: without it FFmpeg reads stdin, and a
server process whose stdin is a socket can block on a control character instead
of encoding. `-map_metadata -1` keeps attacker-controlled strings (title, author,
chapter names) out of the output, where they would survive the encode.

`bitexact` removes encoder version strings, so the same input on the same FFmpeg
build produces the same bytes — which is what makes the reported SHA-256 an
integrity value you can compare against a stored one. It is **not**
cross-host reproducibility: FFmpeg's output depends on the version and the CPU
flags it was built with. The shipped FFmpeg is pinned (see
[THIRD_PARTY.md](THIRD_PARTY.md)) and the fixture's provenance is recorded.

Validation is done by a real `ffprobe`, over the file FFmpeg actually wrote:
container must be MP4, video codec `h264`, frame size exactly 320x180, and a
duration between 1 s and 60 s. The floor exists because the classic false
success is a file that encoded one frame — right codec, right geometry, useless.
The ceiling exists because an input that loops for hours will happily consume
the whole deadline inside a container billed by the second. The demo fixture is
three seconds, but the window is deliberately *not* a fingerprint of it: the CLI
encodes local files with the same preset, so "three seconds exactly" would make
that entrypoint useless.

## Setup and commands

Requires Rust 1.98.1 (`rust-toolchain.toml` handles the pin if you have `rustup`),
a C toolchain for the `libc` dependency, and `ffmpeg`/`ffprobe` on `PATH`. Run
every command from `apps/backend/media`.

```bash
# build, format, lint, test — run manually or through Moon
cargo build --release --locked
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked

# the fixture generator (regenerating is deliberate; see below)
cargo run --release -- fixture --out fixtures/media/sample-v1.mp4

# the server, locally
cargo run -- serve --port 8080 --tmpdir /tmp/media
curl -s http://127.0.0.1:8080/health

# the CLI, locally
cargo run -- encode --input fixtures/media/sample-v1.mp4 --output /tmp/out.mp4
ffprobe -v error -show_streams -show_format /tmp/out.mp4
```

`cargo test` **needs** `ffmpeg` and `ffprobe`. It does not skip when they are
missing: the harness fails with a message naming the prerequisite, because a lane
that skips is a lane that reports nothing and passes.

### Exit status

`serve` exits 0 on a clean shutdown, and a signal-driven stop is a clean exit:
SIGTERM cancels in-flight encodes, waits for them to unwind (so their temp
directories are removed), and exits 0.

`encode` maps failures onto statuses a job runner can act on without reading
stderr:

| Status | Meaning | Status | Meaning |
|---:|---|---:|---|
| 0 | encoded, validated, written | 5 | input media could not be decoded |
| 2 | usage error | 6 | output failed validation or exceeded the cap |
| 3 | preset/protocol refused | 7 | deadline exceeded |
| 4 | input refused (empty or over the cap) | 8 | cancelled |
| | | 9 | I/O or internal error |

## The image

```bash
cd apps/backend/media
docker build -t starter-media:local .
docker run --rm -p 8080:8080 starter-media:local          # serve
docker run --rm starter-media:local --version
```

Two stages, both base images pinned by digest (`Dockerfile`). The runtime stage
is `debian:bookworm-slim` plus Debian's own `ffmpeg` and `ca-certificates`, and
it runs as the unprivileged user `media` (uid 10001) with every request's temp
files under `/var/tmp/media`. No compiler, no package manager, no source tree and
no secrets are in the final image.

**Not `scratch`.** This process execs `ffmpeg`, so it needs a userspace, a
dynamic loader, FFmpeg's shared libraries and CA certificates:

```text
$ ldd /usr/local/bin/starter-media
    linux-vdso.so.1
    libgcc_s.so.1 => /lib/x86_64-linux-gnu/libgcc_s.so.1
    libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6
    /lib64/ld-linux-x86-64.so.so.2
```

Making this binary musl-static would remove three lines above and nothing else:
FFmpeg would still be a dynamically linked process tree. The image is dominated
by FFmpeg's libraries, and pretending otherwise by shipping a static binary would
be size theatre.

There is deliberately no `HEALTHCHECK`: it would need `curl`, which this image
does not install, and a health check that cannot run reports the container dead.
`/health` is the liveness endpoint.

### Provenance and licences

[THIRD_PARTY.md](THIRD_PARTY.md) records the FFmpeg package version, the base
image digests, the licence obligations (Debian's FFmpeg is built with `--enable-gpl`
and `libx264`, so the shipped combination is GPL-2-or-later) and where the
notices live. It is updated whenever the `apt-get install` line changes; an
FFmpeg upgrade without a provenance update is a review finding.

### The fixture's provenance

`fixtures/media/sample-v1.mp4` is generated by FFmpeg's own `testsrc2` and `sine`
synthetic sources — not downloaded, not filmed, not a third-party clip. It is
committed so tests have bytes they can trust, and regenerable so the claim stays
falsifiable: `cargo run -- fixture --out /tmp/x.mp4` and `ffprobe /tmp/x.mp4`.
The exact FFmpeg version and the file's SHA-256 are in
[`fixtures/media/PROVENANCE.md`](fixtures/media/PROVENANCE.md). No test asserts
a hash of the *input*: FFmpeg's synthetic output can change between versions, so
tests assert the properties the protocol cares about.

## Measurements, and the profile they imply

Recorded from one `bash scripts/measure.sh` run on 2026-10-03 in this checkout,
`linux/amd64`, Docker 25.0.16, with Debian bookworm's FFmpeg 5.1.9. Run that
command from `apps/backend/media` (also Moon's `media:cargo-image` invocation).
The script checks size/output baselines with tolerances and reports observed
counts and timings; these observations are not fixed performance guarantees.

The run exited **1 with one DRIFT**: cgroup `memory.peak` was unavailable. Image
build, health, encodes, all five refusals, cleanup and SIGTERM checks passed.

| Measurement | Value from this run |
|---|---|
| final image | 540,099,230 bytes (540 MB) |
| `starter-media` binary | 791,840 bytes stripped |
| `ffmpeg` in the image | 293,288 bytes |
| cold start, `docker run` → first `200` on `/health` | 193, 178, 185, 179, 187 ms; mean 184 ms, max 193 ms (5 successful starts) |
| fixture encode (3 s, 320x180) | 424, 420, 417 ms; output 112,913 bytes on each of 3 attempts |
| peak container memory, fixture encode | unavailable; zero fallback reported as DRIFT, not a memory measurement |
| temp files after fixture encodes and 5 refusals | 0 |
| container exit status after SIGTERM | 0 |

The earlier profile study below is historical and was **not repeated by this
script run**. In particular, the script still checks the prior 61–62 MB fixture
memory baseline at 61.5 MB ±10 MB when a nonzero reading is available.

| Historical measurement | Prior value |
|---|---|
| peak container memory, fixture encode | 61–62 MB (cgroup `memory.peak`) |
| 30 s 720p encode (3.8 MiB input) | 2049, 2051, 2048 ms; output 757,704 bytes |
| peak container memory, 30 s 720p encode | ~118 MB (cgroup `memory.peak`) |
| thread scaling on that input | `-threads 1` 1253 ms, `2` 836 ms, `4` 660 ms |

**Chosen profile: `basic` (1/4 vCPU, 1 GiB memory, 4 GB disk).** The reasoning,
using the current timing/size results and the historical memory/thread study:

* Memory: 1 GiB is 8.5× the worst peak measured inside the input ceiling
  (118 MB) and 17× the demo fixture's (60 MB). `lite` (256 MiB) is only 2.2× the
  worst case, which is not enough headroom for a decoder working on an arbitrary
  5 MiB input this crate has never seen.
* CPU: the fixture encodes in 0.42 s on two threads. Quarter-vCPU oversubscribes
  those two threads, so budget roughly 4× — about 1.7 s — which is 1.4 % of the
  120 s deadline. Paying for `standard-1` (1/2 vCPU, 4 GiB) to save a second on a
  job that runs a handful of times an hour is not a trade worth making.
* Disk: 4 GB against a 540 MB image leaves room for the layer cache and the
  ~16 MB of temp a request at the input and output ceilings would need.
* Threads: `-threads 2` is the measured knee — 1.5× faster than one thread, and
  the third thread buys 21 % more for memory this profile does not have to spare.
  A second encoder thread only exists because there are two; with
  `MAX_CONCURRENT_ENCODES = 1` the alternative would be idle CPU waiting for a
  slot it cannot have.

If a second preset is added that decodes 1080p60 or higher-bit-depth input, this
table has to be re-measured and the profile revisited — `standard-1` is the next
step, not a guess. The processor works on any of the six documented instance
types; nothing in the code knows which one it is on.

Image size was measured, not minimised. 540 MB is what "Debian's FFmpeg, from
Debian's archive" costs, and it is paid once per cold instance. The obvious
alternative — a static FFmpeg from a third-party release channel — would cut it to
tens of megabytes and move the supply chain off a distribution archive onto a URL
whose checksum this repository would have to trust. That trade was declined, and
the number is recorded so the decision can be revisited with evidence.

## Lifecycle, and what this crate refuses to do

* **One in-flight encode.** A second caller gets `429 busy` immediately rather
  than queueing behind a container with one encode of CPU.
* **Disconnect cancels.** A reader thread watches the socket while an encode
  runs; EOF sets the cancel token, FFmpeg is killed and reaped, and the temp
  directory is removed. A caller that hangs up does not leave a container burning
  CPU for 120 seconds on bytes nobody will read.
* **SIGTERM cancels.** The signal handler sets the same token for every
  registered encode, then the process waits for them to unwind before exiting. The
  default disposition would end the process immediately, leaving FFmpeg running
  (it is not in the same process group kill) and its files on disk.
* **Temp directories are owned, not cleaned up.** `EncodedOutput` holds the
  `TempDir`, so the files live exactly as long as the response is being streamed
  and are removed on success, refusal, failure, deadline and cancellation alike.
* **Nothing is retried here.** Invalid media is terminal. The retry budget belongs
  to the caller that owns the job record.
* **No credentials, no network, no public route.** The container has no account
  key, no R2 key and no D1 access. Bytes arrive in the request and leave in the
  response; storing them is the jobs Worker's job.

## A future Cloud Run Job

The CLI exists for this, and nothing about the Cloudflare HTTP image would have
to change for a Cloud Run Job to reuse the encoding core — only the storage and
identity adaptation, which is **not implemented here**:

1. The job image is this image with `CMD ["encode", "--input", "…", "--output", "…"]`,
   or a job whose first step stages objects and then runs that command. It exits;
   it does not serve.
2. **Object staging — not implemented.** Download the input from Cloud Storage
   (`gsutil cp` or the client library) into the container's own writable path, or
   use a mounted bucket. The staging path is deliberately outside this crate: it
   would need a Cloud Storage client and credentials in the image, and this crate
   holds neither.
3. **Credentials — not implemented.** Cloud Run supplies identity through the
   metadata server and the job's service account, never through a baked-in key.
   That wiring belongs to a Cloud Run deployment, not to a crate that has never
   been given a GCP project.
4. **Invocation.** `starter-media encode --input /work/input.mp4 --output /work/output.mp4
   --attempt-id "$JOB_ATTEMPT"`, then `gsutil cp /work/output.mp4 gs://…`. The
   exit status table above is the contract: Cloud Run fails the task on a
   non-zero exit, and `7` (deadline) is the one worth a retry.
5. **Timeout.** Cloud Run's task timeout defaults to 10 minutes and is
   configurable; this process's own 120-second deadline fires well inside that, so
   the runner never has to kill it.
6. **What transfers unchanged:** the preset, the limits, the validation, the hash
   and the exit-status table. What does not: the HTTP layer, `/health`, and the
   container's port.

Nothing in this repository provisions GCP, and this PR does not require an
account from a second provider.

## Tests

```bash
cargo test --locked        # 73 tests: unit, protocol goldens, HTTP, real FFmpeg
```

| File | What it proves |
|---|---|
| `src/*.rs` unit tests | argv has no shell, limits are the values `/health` reports, error retry table, head/body bounds, `validate_attempt_id` charset |
| `src/process.rs` | a real FFmpeg child killed at its deadline, a real child cancelled, stderr bounded and counted, children **reaped** (`/proc/thread-self/children`) |
| `tests/protocol_golden.rs` | the golden documents match the types *and* this build's serialization, in both directions |
| `tests/encode_real.rs` | real encode → validated MP4, reproducible hash, cleanup on success/failure/cancel/deadline, CLI success and failure, validator rejecting a 640x360 and a one-frame encode |
| `tests/http_server.rs` | `/health`, a real `/encode` whose body a second `ffprobe` accepts, refusals, chunked refusal, disconnect cancellation, `429` while busy, SIGTERM cancelling an in-flight encode in the real binary |

The timeout and cancellation controls use an injected clock
(`clock::ManualClock`) against **real** child processes, because a test that waits
120 seconds proves the same thing more slowly. The invalid/oversized controls are
real refusals with real byte counts.

`apps/backend/media/scripts/measure.sh` runs the image and asserts the
measurements in the table above; it exits non-zero if a number stops matching, so
the README cannot drift away from the image without something failing.

## Related

* [THIRD_PARTY.md](THIRD_PARTY.md) — FFmpeg provenance, licences, notices.
* [`fixtures/media/PROVENANCE.md`](fixtures/media/PROVENANCE.md) — the fixture's
  generating command, FFmpeg version and hash.
* [`fixtures/protocol/`](fixtures/protocol) — golden wire documents shared with
  the TypeScript side.
* [docs/toolchain.md](../../../docs/toolchain.md) — the repository's Rust
  toolchain policy, shared with the native (Tauri) crate.
* [docs/capability-matrix.md](../../../docs/capability-matrix.md) — what this
  crate's lanes verify, and what was not run.