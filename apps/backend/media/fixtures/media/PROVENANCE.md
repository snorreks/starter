# Provenance of `fixtures/media/sample-v1.mp4`

This file exists so the committed bytes are a **claim that can be checked**, not
an artefact of somebody's afternoon. Everything needed to re-derive it is here.

## How it was generated

```bash
cd apps/backend/media
cargo run --release -- fixture --out fixtures/media/sample-v1.mp4
```

which runs exactly this argv (see `src/fixture.rs`, `fixture_args`):

```text
-y -hide_banner -nostdin -loglevel error
-f lavfi -i testsrc2=size=320x180:rate=24:duration=3
-f lavfi -i sine=frequency=440:sample_rate=44100:duration=3
-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p
-c:a aac -b:a 96k -ac 2 -shortest
-fflags +bitexact -flags:v +bitexact -movflags +faststart
fixtures/media/sample-v1.mp4
```

Both inputs are FFmpeg's own synthetic generators: `testsrc2` draws a test
pattern, `sine` generates a 440 Hz tone. No camera, no screen recording, no
third-party clip, no download, no network access at any point.

## What was recorded

| | |
|---|---|
| Generated on | 2026-10-03 (Europe/Oslo) |
| FFmpeg | `9.0.1`, Copyright (c) 2000-2026 the FFmpeg developers |
| Platform | `linux/amd64` |
| Size | 159,078 bytes |
| SHA-256 | `8462519e98d9f8170fb1bb8f50bd95f6daa728fe800471f24101e6d7153df451` |
| Measured by | `ffprobe`: 320x180, 3.000000 s, `h264` + `aac`, `mov,mp4,m4a,3gp,3g2,mj2` |

Note that the container image ships FFmpeg **5.1.9** (Debian bookworm), not the
9.0.1 used here. That difference is deliberate and is exactly why no test asserts
a hash of this input: `testsrc2`'s output is a function of the FFmpeg build, so a
hash pinned to one version would fail on the other for no good reason.

## What a test may and may not assert about it

* **May:** the fixture is under the 5 MiB input ceiling; it decodes; it is
  320x180 h264 MP4; encoding it through the frozen preset produces a validated
  output; the same input twice produces the same output hash *on one host with
  one FFmpeg*.
* **May not:** that this exact SHA-256 exists in every checkout, or that the
  image's FFmpeg reproduces these bytes. Those would be claims about FFmpeg's
  version history, not about this repository.

## Checking it yourself

```bash
ffprobe -v error -print_format json -show_streams -show_format fixtures/media/sample-v1.mp4
sha256sum fixtures/media/sample-v1.mp4
cargo run --release -- fixture --out /tmp/regenerated.mp4 && sha256sum /tmp/regenerated.mp4
```

On this machine's FFmpeg the regenerated file has the same hash. On a different
FFmpeg version it may differ; that is information about FFmpeg, not a broken
fixture.