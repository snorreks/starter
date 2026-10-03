//! The synthetic input fixture, `sample-v1`.
//!
//! Provenance: this file is **generated, not downloaded and not recorded from a
//! person**. `starter-media fixture --out <path>` builds it from FFmpeg's
//! `testsrc2` and `sine` synthetic sources — no camera, no screen, no
//! copyrighted input, no network. The committed file under
//! `fixtures/media/sample-v1.mp4` was produced by exactly that command; the
//! recording, including the FFmpeg version that produced it, is in
//! `fixtures/media/PROVENANCE.md`.
//!
//! Why a generator instead of only a committed file: the tests need an input they
//! can trust byte-for-byte, and a committed file gives that. But the *reason* the
//! file is what it is has to be re-derivable by the next person, or the committed
//! bytes become an unfalsifiable claim. Two commands, both real, keep it honest:
//!
//! ```text
//! starter-media fixture --out /tmp/regenerated.mp4
//! ffprobe /tmp/regenerated.mp4   # 320x180, 3.0 s, h264/aac
//! ```
//!
//! Determinism: `testsrc2` is a function of its arguments, so the same FFmpeg
//! build produces the same bytes. Across FFmpeg versions the bytes can differ, so
//! no test asserts a hash of the *input*; tests assert the *properties* the
//! protocol cares about, and the input hash is recorded in the provenance file
//! for the exact build it was made with.

use std::path::Path;

use crate::error::{ErrorCode, ProcessorError, Result};
use crate::process::{
    ProcessOutcome, ProcessRequest, ProcessRunner, SystemProcessRunner, TerminationReason,
};
use crate::protocol::ENCODE_DEADLINE_MS;

/// Fixture dimensions and duration, matching the preset's expectations.
pub const FIXTURE_WIDTH: u32 = 320;
pub const FIXTURE_HEIGHT: u32 = 180;
pub const FIXTURE_SECONDS: u32 = 3;
pub const FIXTURE_FPS: u32 = 24;

/// FFmpeg arguments that build the fixture from synthetic sources.
///
/// Also an argv vector: no shell, and no string built from a path. The output path
/// is the last element and is passed through as one `OsString`.
pub fn fixture_args(output: &Path) -> Vec<std::ffi::OsString> {
    vec![
        // Overwrite without prompting: a generator that can block on "file
        // exists?" is a generator that can hang in CI.
        std::ffi::OsString::from("-y"),
        std::ffi::OsString::from("-hide_banner"),
        std::ffi::OsString::from("-nostdin"),
        std::ffi::OsString::from("-loglevel"),
        std::ffi::OsString::from("error"),
        std::ffi::OsString::from("-f"),
        std::ffi::OsString::from("lavfi"),
        std::ffi::OsString::from("-i"),
        std::ffi::OsString::from(format!(
            "testsrc2=size={FIXTURE_WIDTH}x{FIXTURE_HEIGHT}:rate={FIXTURE_FPS}:duration={FIXTURE_SECONDS}"
        )),
        std::ffi::OsString::from("-f"),
        std::ffi::OsString::from("lavfi"),
        std::ffi::OsString::from("-i"),
        std::ffi::OsString::from(format!(
            "sine=frequency=440:sample_rate=44100:duration={FIXTURE_SECONDS}"
        )),
        std::ffi::OsString::from("-c:v"),
        std::ffi::OsString::from("libx264"),
        std::ffi::OsString::from("-preset"),
        std::ffi::OsString::from("veryfast"),
        std::ffi::OsString::from("-crf"),
        std::ffi::OsString::from("18"),
        std::ffi::OsString::from("-pix_fmt"),
        std::ffi::OsString::from("yuv420p"),
        std::ffi::OsString::from("-c:a"),
        std::ffi::OsString::from("aac"),
        std::ffi::OsString::from("-b:a"),
        std::ffi::OsString::from("96k"),
        std::ffi::OsString::from("-ac"),
        std::ffi::OsString::from("2"),
        std::ffi::OsString::from("-shortest"),
        // Same bitexact flags as the preset, so the fixture is as reproducible
        // as the output the processor validates.
        std::ffi::OsString::from("-fflags"),
        std::ffi::OsString::from("+bitexact"),
        std::ffi::OsString::from("-flags:v"),
        std::ffi::OsString::from("+bitexact"),
        std::ffi::OsString::from("-movflags"),
        std::ffi::OsString::from("+faststart"),
        output.as_os_str().to_os_string(),
    ]
}

/// Build the fixture at `output`.
pub fn generate(output: &Path, ffmpeg: &Path, runner: &dyn ProcessRunner) -> Result<()> {
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|error| {
                ProcessorError::new(ErrorCode::Internal)
                    .with_path(parent)
                    .with_detail(error.to_string())
            })?;
        }
    }
    let request = ProcessRequest::new(
        ffmpeg.as_os_str().to_os_string(),
        fixture_args(output),
        ENCODE_DEADLINE_MS,
    );
    let outcome = runner.run(&request)?;
    check(&outcome)?;
    if crate::process::file_len(output)? == 0 {
        return Err(ProcessorError::new(ErrorCode::Internal)
            .with_detail("fixture generation produced an empty file"));
    }
    Ok(())
}

/// The same, over the production runner.
pub fn generate_default(output: &Path, ffmpeg: &Path) -> Result<()> {
    let runner = SystemProcessRunner::new(crate::clock::system_clock());
    generate(output, ffmpeg, &runner)
}

fn check(outcome: &ProcessOutcome) -> Result<()> {
    match outcome.terminated {
        Some(TerminationReason::Deadline) => {
            return Err(ProcessorError::new(ErrorCode::DeadlineExceeded)
                .with_detail("fixture generation exceeded its deadline"))
        }
        Some(TerminationReason::Cancelled) => {
            return Err(ProcessorError::new(ErrorCode::Cancelled)
                .with_detail("fixture generation cancelled"))
        }
        None => {}
    }
    if !outcome.succeeded() {
        return Err(
            ProcessorError::new(ErrorCode::Internal).with_detail(format!(
                "ffmpeg exit {:?} while generating the fixture: {}",
                outcome.exit_code,
                outcome.stderr_tail.trim()
            )),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_args_build_from_synthetic_sources_not_a_download() {
        let args: Vec<String> = fixture_args(Path::new("/tmp/sample-v1.mp4"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.iter().any(|a| a.starts_with("testsrc2=size=320x180")),
            "{args:?}"
        );
        assert!(
            args.iter().any(|a| a.starts_with("sine=frequency=440")),
            "{args:?}"
        );
        assert!(args.contains(&"lavfi".to_string()));
        assert!(args.contains(&"-nostdin".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/sample-v1.mp4"));
        // Nothing in the graph can reach the network.
        assert!(!args.iter().any(|a| a.contains("http")), "{args:?}");
    }
}
