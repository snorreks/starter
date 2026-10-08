//! The encoding core: one function, shared by the HTTP entrypoint and the CLI.
//!
//! Both entrypoints call [`Encoder::encode_from_bytes`] or
//! [`Encoder::encode_from_path`]. There is no second implementation of "run
//! FFmpeg, check the result" for the CLI to drift away from the server.
//!
//! What an encode owns, for its whole lifetime:
//!
//! * one temp directory, removed on every exit path — success, refusal,
//!   subprocess failure, deadline, cancellation — because the returned value
//!   *owns* it and drops it;
//! * one input file written from the caller's bytes;
//! * at most one FFmpeg child, supervised to its deadline and reaped;
//! * the output size checked against the cap *before* validation reads it;
//! * one FFprobe validation of the file FFmpeg actually wrote;
//! * one SHA-256 over exactly those bytes.
//!
//! What it deliberately does not do: retry. Invalid media is terminal, and the
//! retry budget belongs to the caller that owns the job record.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tempfile::TempDir;

use crate::error::{ErrorCode, ProcessorError, Result};
use crate::preset::Preset;
use crate::probe;
use crate::process::{
    file_len, CancelToken, ProcessOutcome, ProcessRequest, ProcessRunner, SystemProcessRunner,
    TerminationReason,
};
use crate::protocol::{EncodeSuccessDocument, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES};

/// How the encoder finds the tools it drives.
///
/// Paths are resolved once, at construction, from the environment
/// (`MEDIA_FFMPEG_PATH`, `MEDIA_FFPROBE_PATH`). A request cannot change them:
/// there is no endpoint that accepts a binary path or an argument.
#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Resolve from the environment, defaulting to the names on `PATH`.
    pub fn from_env() -> Self {
        Self {
            ffmpeg: std::env::var_os("MEDIA_FFMPEG_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("ffmpeg")),
            ffprobe: std::env::var_os("MEDIA_FFPROBE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("ffprobe")),
        }
    }
}

/// The encoder. Cheap to clone-by-`Arc`; holds no request state, so two callers
/// cannot interfere except through the single in-flight gate in the HTTP layer.
pub struct Encoder {
    tools: Tools,
    runner: Arc<dyn ProcessRunner>,
    temp_root: Option<PathBuf>,
    /// A ceiling that can only *lower* the preset's deadline.
    ///
    /// Present so a test can drive the encoder's own deadline path against real
    /// FFmpeg in milliseconds instead of 120 seconds. It cannot raise the
    /// budget: a longer encode than the preset allows is not something any caller
    /// can ask for, in a test or in production.
    deadline_cap: Option<std::time::Duration>,
}

impl Encoder {
    /// The production encoder: real subprocesses, real clock.
    pub fn new(tools: Tools) -> Self {
        Self {
            tools,
            runner: Arc::new(SystemProcessRunner::new(crate::clock::system_clock())),
            temp_root: None,
            deadline_cap: None,
        }
    }

    /// An encoder over an injected runner and clock. Used by tests to prove the
    /// deadline and cancellation paths against real child processes, and by the
    /// unit tests that need to prove a refusal never reached FFmpeg at all.
    pub fn with_runner(tools: Tools, runner: Arc<dyn ProcessRunner>) -> Self {
        Self {
            tools,
            runner,
            temp_root: None,
            deadline_cap: None,
        }
    }

    /// Lower the effective deadline. See [`Encoder::deadline_cap`].
    pub fn with_deadline_cap(mut self, cap: std::time::Duration) -> Self {
        self.deadline_cap = Some(cap);
        self
    }

    /// The deadline this encoder will actually enforce for `preset`.
    fn effective_deadline(&self, preset: &Preset) -> std::time::Duration {
        match self.deadline_cap {
            Some(cap) if cap < preset.deadline => cap,
            _ => preset.deadline,
        }
    }

    /// Place temp directories under `root` instead of the system default.
    ///
    /// The container uses this so every byte a request can write lives under one
    /// known, inspectable directory, and a test can assert the directory is
    /// empty afterwards.
    pub fn with_temp_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.temp_root = Some(root.into());
        self
    }

    pub fn tools(&self) -> &Tools {
        &self.tools
    }

    /// Encode bytes the caller already holds (the HTTP request body).
    pub fn encode_from_bytes(
        &self,
        input: &[u8],
        preset: &Preset,
        attempt_id: &str,
        cancel: CancelToken,
    ) -> Result<EncodedOutput> {
        check_input_size(input.len() as u64)?;
        let temp = self.temp_dir()?;
        let input_path = temp.path().join("input.bin");
        // A failed write leaves the directory behind; it drops here.
        std::fs::write(&input_path, input).map_err(|error| {
            ProcessorError::new(ErrorCode::Internal)
                .with_path(&input_path)
                .with_detail(error.to_string())
        })?;
        self.encode_at(&input_path, preset, attempt_id, cancel, temp)
    }

    /// Encode a file already on local disk (the CLI).
    pub fn encode_from_path(
        &self,
        input: &Path,
        output: Option<&Path>,
        preset: &Preset,
        attempt_id: &str,
        cancel: CancelToken,
    ) -> Result<EncodedOutput> {
        let length = file_len(input)?;
        check_input_size(length)?;
        let temp = self.temp_dir()?;
        // FFmpeg reads the caller's file directly: copying it would double the
        // disk the container needs for no benefit, and the input path is the
        // CLI operator's own file rather than a request body.
        let encoded = self.encode_at(input, preset, attempt_id, cancel, temp)?;
        if let Some(destination) = output {
            copy_output(&encoded, destination)?;
        }
        Ok(encoded)
    }

    /// The shared body: run, cap, validate, hash.
    fn encode_at(
        &self,
        input: &Path,
        preset: &Preset,
        attempt_id: &str,
        cancel: CancelToken,
        temp: TempDir,
    ) -> Result<EncodedOutput> {
        let output_path = preset.output_path(temp.path());

        let deadline = self.effective_deadline(preset);
        let mut request = ProcessRequest::new(
            self.tools.ffmpeg.clone(),
            preset.ffmpeg_args(input, &output_path),
            u64::try_from(deadline.as_millis()).unwrap_or(u64::MAX),
        );
        request.cancel = cancel.clone();
        let outcome = self.runner.run(&request)?;
        classify_ffmpeg(&outcome, preset)?;

        // Cap before validation: an over-cap file is refused without paying for
        // a probe of bytes the caller is not allowed to have.
        let output_bytes = file_len(&output_path)?;
        if output_bytes == 0 {
            return Err(ProcessorError::new(ErrorCode::InvalidMedia)
                .with_detail("ffmpeg exited zero and produced no output file"));
        }
        if output_bytes > MAX_OUTPUT_BYTES {
            return Err(ProcessorError::new(ErrorCode::OutputTooLarge)
                .with_detail(format!("{output_bytes} bytes > {MAX_OUTPUT_BYTES}")));
        }

        let probe_summary = probe::validate(
            &output_path,
            preset,
            self.runner.as_ref(),
            &self.tools.ffprobe,
        )?;
        probe::check_duration(&probe_summary, preset)?;

        let output_sha256 = sha256_of(&output_path)?;

        Ok(EncodedOutput {
            success: EncodeSuccessDocument {
                protocol: crate::protocol::PROTOCOL_ID.to_string(),
                preset: preset.id.to_string(),
                attempt_id: attempt_id.to_string(),
                output_bytes,
                output_sha256,
                probe: probe_summary,
            },
            temp: Some(temp),
            output_path,
        })
    }

    /// Create a temp directory under the configured root, when there is one.
    fn temp_dir(&self) -> Result<TempDir> {
        match &self.temp_root {
            // The root must already exist: creating it here would put a
            // container-wide directory under a path this process may not own,
            // and its failure would look like a per-request failure.
            Some(root) => tempfile::Builder::new()
                .prefix("encode-")
                .tempdir_in(root)
                .map_err(|error| {
                    ProcessorError::new(ErrorCode::Internal)
                        .with_path(root)
                        .with_detail(error.to_string())
                }),
            None => tempfile::Builder::new()
                .prefix("encode-")
                .tempdir()
                .map_err(|error| {
                    ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
                }),
        }
    }
}

/// A validated encode, owning the temp directory that holds the output.
///
/// Dropping this value removes the directory. The HTTP handler therefore holds
/// the files for exactly as long as it streams them, whether it finishes or the
/// write fails halfway.
#[derive(Debug)]
pub struct EncodedOutput {
    pub success: EncodeSuccessDocument,
    temp: Option<TempDir>,
    output_path: PathBuf,
}

impl EncodedOutput {
    /// Stream the output file to `sink`, hashing nothing new: the hash in
    /// [`EncodeSuccessDocument`] was computed from this same file.
    pub fn copy_to(&self, mut sink: impl std::io::Write) -> Result<u64> {
        let mut file = std::fs::File::open(&self.output_path).map_err(|error| {
            ProcessorError::new(ErrorCode::Internal)
                .with_path(&self.output_path)
                .with_detail(error.to_string())
        })?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut written: u64 = 0;
        loop {
            let read = file.read(&mut buffer).map_err(|error| {
                ProcessorError::new(ErrorCode::Internal)
                    .with_path(&self.output_path)
                    .with_detail(error.to_string())
            })?;
            if read == 0 {
                break;
            }
            sink.write_all(&buffer[..read]).map_err(|error| {
                ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
            })?;
            written += read as u64;
        }
        Ok(written)
    }

    /// The temp directory path, for logging. Removed when this value drops.
    pub fn work_dir(&self) -> &Path {
        self.temp
            .as_ref()
            .map(TempDir::path)
            .unwrap_or_else(|| self.output_path.parent().unwrap_or(Path::new(".")))
    }

    /// The output file inside the temp directory.
    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

impl Drop for EncodedOutput {
    fn drop(&mut self) {
        // `TempDir` removes the tree on drop, but silently: a failed removal
        // would leave container disk consumed by bytes nobody will read again.
        // Taking it out and closing it explicitly turns that into a log line.
        // Failure is still not fatal to a response whose bytes were already
        // streamed, so it is reported rather than escalated.
        if let Some(temp) = self.temp.take() {
            if let Err(error) = temp.close() {
                // `PathInsideError` carries the directory it failed on.
                eprintln!("cleanup: could not remove a temporary directory: {error}");
            }
        }
    }
}

/// Refuse an input before any process starts.
fn check_input_size(length: u64) -> Result<()> {
    if length == 0 {
        return Err(ProcessorError::new(ErrorCode::InputEmpty));
    }
    if length > MAX_INPUT_BYTES {
        return Err(ProcessorError::new(ErrorCode::PayloadTooLarge)
            .with_detail(format!("{length} bytes > {}", MAX_INPUT_BYTES)));
    }
    Ok(())
}

/// Turn an FFmpeg exit status into a classified failure.
///
/// A nonzero exit is `invalid_media`, which is terminal — the same bytes fail
/// the same way. A killed child is a deadline or a cancellation, which are
/// retryable. Nothing here retries.
fn classify_ffmpeg(outcome: &ProcessOutcome, preset: &Preset) -> Result<()> {
    match outcome.terminated {
        Some(TerminationReason::Deadline) => {
            return Err(ProcessorError::new(ErrorCode::DeadlineExceeded)
                .with_detail(format!("ffmpeg exceeded {}ms", preset.deadline.as_millis())));
        }
        Some(TerminationReason::Cancelled) => {
            return Err(ProcessorError::new(ErrorCode::Cancelled)
                .with_detail("ffmpeg cancelled before completing"));
        }
        None => {}
    }
    if outcome.succeeded() {
        return Ok(());
    }
    Err(
        ProcessorError::new(ErrorCode::InvalidMedia).with_detail(format!(
            "ffmpeg exit {:?}, {} stderr bytes: {}",
            outcome.exit_code,
            outcome.stderr_total_bytes,
            outcome.stderr_tail.trim()
        )),
    )
}

fn sha256_of(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        ProcessorError::new(ErrorCode::Internal)
            .with_path(path)
            .with_detail(error.to_string())
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            ProcessorError::new(ErrorCode::Internal)
                .with_path(path)
                .with_detail(error.to_string())
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Copy a validated output to a caller-chosen CLI destination.
///
/// The copy happens while the temp directory still exists, and the hash reported
/// is the hash of the temp file, which is byte-identical to what was copied: the
/// copy is a read of the same bytes, not a re-encode.
fn copy_output(encoded: &EncodedOutput, destination: &Path) -> Result<()> {
    let mut file = std::fs::File::create(destination).map_err(|error| {
        ProcessorError::new(ErrorCode::Internal)
            .with_path(destination)
            .with_detail(error.to_string())
    })?;
    encoded.copy_to(&mut file).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::ProcessOutcome;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A runner that records whether it was called at all.
    struct CountingRunner {
        calls: AtomicUsize,
        outcome: ProcessOutcome,
    }

    impl ProcessRunner for CountingRunner {
        fn run(&self, _request: &ProcessRequest) -> Result<ProcessOutcome> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.outcome.clone())
        }
    }

    fn success_outcome() -> ProcessOutcome {
        ProcessOutcome {
            exit_code: Some(0),
            signal: None,
            stderr_tail: String::new(),
            stderr_total_bytes: 0,
            stdout: String::new(),
            stdout_total_bytes: 0,
            elapsed_ms: 5,
            terminated: None,
        }
    }

    #[test]
    fn an_oversized_body_is_refused_before_any_subprocess_starts() {
        let runner = Arc::new(CountingRunner {
            calls: AtomicUsize::new(0),
            outcome: success_outcome(),
        });
        let encoder = Encoder::with_runner(
            Tools {
                ffmpeg: PathBuf::from("ffmpeg"),
                ffprobe: PathBuf::from("ffprobe"),
            },
            runner.clone(),
        );
        let oversized = vec![0_u8; (MAX_INPUT_BYTES + 1) as usize];
        let error = encoder
            .encode_from_bytes(
                &oversized,
                &crate::preset::DEMO_180P_V1,
                "attempt-1",
                CancelToken::new(),
            )
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::PayloadTooLarge);
        assert_eq!(
            runner.calls.load(Ordering::SeqCst),
            0,
            "FFmpeg was spawned anyway"
        );
    }

    #[test]
    fn an_empty_body_is_refused_before_any_subprocess_starts() {
        let runner = Arc::new(CountingRunner {
            calls: AtomicUsize::new(0),
            outcome: success_outcome(),
        });
        let encoder = Encoder::with_runner(
            Tools {
                ffmpeg: PathBuf::from("ffmpeg"),
                ffprobe: PathBuf::from("ffprobe"),
            },
            runner.clone(),
        );
        let error = encoder
            .encode_from_bytes(
                &[],
                &crate::preset::DEMO_180P_V1,
                "attempt-1",
                CancelToken::new(),
            )
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::InputEmpty);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_nonzero_ffmpeg_exit_is_terminal_invalid_media() {
        let mut outcome = success_outcome();
        outcome.exit_code = Some(1);
        outcome.stderr_tail = "moov atom not found".into();
        let error = classify_ffmpeg(&outcome, &crate::preset::DEMO_180P_V1).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidMedia);
        assert!(!error.code().retryable());
        assert!(error.detail().unwrap().contains("moov atom not found"));
    }

    #[test]
    fn a_killed_child_is_a_retryable_deadline_or_cancellation() {
        let mut outcome = success_outcome();
        outcome.exit_code = None;
        outcome.terminated = Some(TerminationReason::Deadline);
        let error = classify_ffmpeg(&outcome, &crate::preset::DEMO_180P_V1).unwrap_err();
        assert_eq!(error.code(), ErrorCode::DeadlineExceeded);
        assert!(error.code().retryable());

        outcome.terminated = Some(TerminationReason::Cancelled);
        let error = classify_ffmpeg(&outcome, &crate::preset::DEMO_180P_V1).unwrap_err();
        assert_eq!(error.code(), ErrorCode::Cancelled);
        assert!(error.code().retryable());
    }
}
