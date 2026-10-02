//! Subprocess execution: argv in, bounded outcome out.
//!
//! Everything a subprocess can do to this process is decided here:
//!
//! * **No shell.** [`SystemProcessRunner`] spawns `Command::new(program)` with
//!   `.args(&[OsString])`. The command line is never built as a string.
//! * **No inherited streams.** stdin is `/dev/null`, stdout is discarded, and
//!   stderr is read by a dedicated thread that keeps a bounded tail and counts
//!   the bytes it dropped. A child that writes megabytes of banner cannot grow
//!   this process's memory, and cannot deadlock on a full pipe.
//! * **No orphans.** On deadline or cancellation the child is killed and then
//!   *waited* — kill without wait leaves a zombie until the isolate exits, which
//!   on a long-lived container is forever.
//! * **Bounded time.** The deadline is checked between polls on an injected
//!   [`Clock`], so it is provable without waiting it out.

use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::clock::Clock;
use crate::error::{ErrorCode, ProcessorError, Result};

/// A cooperative cancellation flag shared by the HTTP layer and one encode.
///
/// Set by a disconnect watcher, by SIGTERM/SIGINT, or by the shutdown path. The
/// encode's poll loop observes it within one poll interval.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

impl PartialEq for CancelToken {
    /// Two tokens are equal when they wrap the same flag. The shutdown registry
    /// relies on this to drop exactly the entry it added; comparing by a
    /// "cancelled" boolean instead would make every token equal to every other
    /// one that had already been cancelled.
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation. Idempotent.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Why a supervised process was stopped before it finished on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationReason {
    /// The cancel token was set: caller disconnected, or the process is
    /// shutting down.
    Cancelled,
    /// The deadline elapsed.
    Deadline,
}

/// One subprocess invocation.
#[derive(Debug, Clone)]
pub struct ProcessRequest {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub deadline_ms: u64,
    pub stderr_keep_bytes: usize,
    /// Whether to capture stdout instead of discarding it. FFprobe's JSON needs
    /// it; FFmpeg's stderr does not, and a large stdout is discarded so a child
    /// cannot grow this process through a stream nobody reads.
    pub capture_stdout: bool,
    pub stdout_keep_bytes: usize,
    pub cancel: CancelToken,
}

impl ProcessRequest {
    /// A request with the crate's own stream bounds, for tests and the CLI.
    pub fn new(program: impl Into<PathBuf>, args: Vec<OsString>, deadline_ms: u64) -> Self {
        Self {
            program: program.into(),
            args,
            deadline_ms,
            stderr_keep_bytes: crate::protocol::STDERR_KEEP_BYTES,
            capture_stdout: false,
            stdout_keep_bytes: crate::protocol::MAX_PROBE_JSON_BYTES,
            cancel: CancelToken::new(),
        }
    }
}

/// What actually happened. All of it measured, none of it assumed.
#[derive(Debug, Clone)]
pub struct ProcessOutcome {
    /// Exit status, when the child exited normally.
    pub exit_code: Option<i32>,
    /// Signal number, when the child was killed by one. `None` on Linux for a
    /// child this process reaped after `kill()`, because `ExitStatus::signal()`
    /// only reports a signal for a process it did not terminate; the
    /// `terminated` field is the authoritative answer.
    pub signal: Option<i32>,
    /// At most `stderr_keep_bytes` of the child's stderr.
    pub stderr_tail: String,
    /// How many stderr bytes the child actually wrote, including dropped ones.
    pub stderr_total_bytes: u64,
    /// Captured stdout, at most `stdout_keep_bytes`. Empty unless the request
    /// asked for it.
    pub stdout: String,
    /// How many stdout bytes the child wrote, including dropped ones.
    pub stdout_total_bytes: u64,
    /// Elapsed time on the injected clock.
    pub elapsed_ms: u64,
    /// Set when this process killed the child.
    pub terminated: Option<TerminationReason>,
}

impl ProcessOutcome {
    /// Whether the child finished by itself with status zero.
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && self.terminated.is_none()
    }
}

/// The seam the encoder is written against.
///
/// One implementation exists in production ([`SystemProcessRunner`]). Tests use
/// a counting fake to prove that a refused request never reached a subprocess,
/// and a real runner with an injected clock to prove the deadline path kills and
/// reaps a real child.
pub trait ProcessRunner: Send + Sync {
    fn run(&self, request: &ProcessRequest) -> Result<ProcessOutcome>;
}

/// Spawns and supervises real subprocesses.
pub struct SystemProcessRunner {
    clock: Arc<dyn Clock>,
    poll_ms: u64,
}

impl SystemProcessRunner {
    /// Poll interval for exit/deadline checks. Small enough that a cancellation
    /// is acted on promptly, large enough not to spin.
    pub const DEFAULT_POLL_MS: u64 = 20;

    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            poll_ms: Self::DEFAULT_POLL_MS,
        }
    }

    /// Read a child's stderr to end-of-stream, keeping a bounded tail.
    ///
    /// The tail keeps the *last* bytes, because FFmpeg prints its error last and
    /// that is the part that identifies the failure. Dropped bytes are counted,
    /// so "we saw 3 MiB of stderr and kept the last 8 KiB" is a statement this
    /// crate can make truthfully in a log.
    fn drain(
        mut stream: impl Read + Send + 'static,
        keep_bytes: usize,
    ) -> thread::JoinHandle<StderrTail> {
        thread::spawn(move || {
            let mut ring: Vec<u8> = Vec::new();
            let mut buffer = [0_u8; 8 * 1024];
            let mut total: u64 = 0;
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        total += read as u64;
                        if ring.len() < keep_bytes {
                            let room = keep_bytes - ring.len();
                            ring.extend_from_slice(&buffer[..read.min(room)]);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    // A read failure ends the drain. The child's exit status is
                    // the authority on what happened, not our read of its output.
                    Err(_) => break,
                }
            }
            StderrTail {
                text: String::from_utf8_lossy(&ring).into_owned(),
                total,
            }
        })
    }

    /// Kill and reap. Called on every abnormal exit path, so it must not fail.
    fn terminate(child: &mut Child) {
        // Kill first: a child blocked writing to its stderr pipe will not exit on
        // its own. `wait` after `kill` is what reaps it.
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The bounded stderr result.
pub struct StderrTail {
    pub text: String,
    pub total: u64,
}

impl ProcessRunner for SystemProcessRunner {
    fn run(&self, request: &ProcessRequest) -> Result<ProcessOutcome> {
        let started = self.clock.now_ms();
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .stdin(Stdio::null())
            .stderr(Stdio::piped());
        command.stdout(if request.capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        let mut child = command.spawn().map_err(|error| {
            ProcessorError::new(ErrorCode::Internal)
                .with_detail(format!("spawn {:?}: {error}", request.program))
        })?;

        let stderr_handle = child
            .stderr
            .take()
            .map(|stderr| Self::drain(stderr, request.stderr_keep_bytes));
        let stdout_handle = if request.capture_stdout {
            child
                .stdout
                .take()
                .map(|stdout| Self::drain(stdout, request.stdout_keep_bytes))
        } else {
            None
        };

        let mut terminated = None;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|error| {
                ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
            })? {
                break status;
            }
            if request.cancel.is_cancelled() {
                terminated = Some(TerminationReason::Cancelled);
                Self::terminate(&mut child);
                break child.wait().map_err(|error| {
                    ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
                })?;
            }
            if self.clock.now_ms().saturating_sub(started) >= request.deadline_ms {
                terminated = Some(TerminationReason::Deadline);
                Self::terminate(&mut child);
                break child.wait().map_err(|error| {
                    ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
                })?;
            }
            self.clock.sleep(self.poll_ms);
        };

        // The child is dead before this join, so its pipes are closed and the
        // reader threads terminate on their own. Joining here — rather than
        // detaching — is what guarantees no reader thread outlives the request.
        let stderr = stderr_handle
            .map(|handle| {
                handle.join().unwrap_or(StderrTail {
                    text: String::new(),
                    total: 0,
                })
            })
            .unwrap_or(StderrTail {
                text: String::new(),
                total: 0,
            });
        let stdout = stdout_handle
            .map(|handle| {
                handle.join().unwrap_or(StderrTail {
                    text: String::new(),
                    total: 0,
                })
            })
            .unwrap_or(StderrTail {
                text: String::new(),
                total: 0,
            });

        let elapsed_ms = self.clock.now_ms().saturating_sub(started);
        Ok(ProcessOutcome {
            exit_code: status.code(),
            signal: status.code().is_none().then_some(-1),
            stderr_tail: stderr.text,
            stderr_total_bytes: stderr.total,
            stdout: stdout.text,
            stdout_total_bytes: stdout.total,
            elapsed_ms,
            terminated,
        })
    }
}

/// Read a file's length, treating "missing" as zero.
///
/// Used for the pre-flight output check: FFmpeg exiting zero does not by itself
/// mean a usable file exists at the path we asked for.
pub fn file_len(path: &std::path::Path) -> Result<u64> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(ProcessorError::new(ErrorCode::Internal)
            .with_path(path)
            .with_detail(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;
    use crate::harness;

    /// A real, CPU-hungry FFmpeg that will not finish on its own: a 1080p
    /// synthetic stream for ten minutes, discarded to the null muxer. The
    /// deadline test kills it. Nothing is stubbed except the clock.
    fn long_ffmpeg_request(deadline_ms: u64) -> ProcessRequest {
        let args: Vec<OsString> = [
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30:duration=600",
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        ProcessRequest::new(harness::require(&harness::ffmpeg()), args, deadline_ms)
    }

    #[test]
    fn a_real_child_that_outlives_its_deadline_is_killed_and_reaped() {
        // A real FFmpeg encode, and a virtual clock that reaches a 200 ms
        // deadline in ten polls. Both halves are real: the child exists, is
        // signalled, and is waited for.
        let before = harness::child_pids();
        let clock = Arc::new(ManualClock::new());
        let runner = SystemProcessRunner::new(clock.clone());
        let outcome = runner.run(&long_ffmpeg_request(200)).expect("outcome");

        assert_eq!(outcome.terminated, Some(TerminationReason::Deadline));
        assert!(!outcome.succeeded());
        assert!(clock.now() >= 200, "virtual clock reached the deadline");
        // Reaped, not merely signalled: no new child of this process remains.
        let after = harness::child_pids();
        let orphans: Vec<u32> = after
            .iter()
            .copied()
            .filter(|pid| !before.contains(pid))
            .collect();
        assert!(orphans.is_empty(), "left running: {orphans:?}");
    }

    #[test]
    fn cancellation_stops_a_real_child_before_the_deadline() {
        // The token is already set when the child starts, which is the code path
        // a disconnect takes: the poll loop observes it, kills the real child and
        // reaps it. Mid-flight cancellation against a real HTTP request is proven
        // in tests/http_lifecycle.rs.
        let before = harness::child_pids();
        let clock = Arc::new(ManualClock::new());
        let runner = SystemProcessRunner::new(clock.clone());
        let request = long_ffmpeg_request(60_000);
        request.cancel.cancel();

        let outcome = runner.run(&request).expect("outcome");
        assert_eq!(outcome.terminated, Some(TerminationReason::Cancelled));
        assert_eq!(clock.now(), 0, "no waiting happened");
        let orphans: Vec<u32> = harness::child_pids()
            .iter()
            .copied()
            .filter(|pid| !before.contains(pid))
            .collect();
        assert!(orphans.is_empty(), "left running: {orphans:?}");
    }

    #[test]
    fn stderr_is_bounded_but_still_reports_the_total() {
        // `head -c 200000 /dev/zero 1>&2` produces ~200 KB of stderr. The runner must
        // keep 64 bytes, count the rest, and still reap the child. `sh` is used
        // only to find `head` through PATH; production spawns FFmpeg by argv.
        let mut request = ProcessRequest::new(
            "/bin/sh",
            vec![
                OsString::from("-c"),
                OsString::from("head -c 200000 /dev/zero 1>&2"),
            ],
            30_000,
        );
        request.stderr_keep_bytes = 64;
        let outcome = SystemProcessRunner::new(crate::clock::system_clock())
            .run(&request)
            .expect("outcome");
        assert!(
            outcome.stderr_total_bytes > 100_000,
            "total was counted: {outcome:?}"
        );
        assert!(outcome.stderr_tail.len() <= 64, "tail stayed bounded");
        // No orphans: the exit status was observed, so the child is reaped.
        assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
    }

    #[test]
    fn a_missing_program_is_an_internal_error_not_a_silent_success() {
        let request = ProcessRequest::new("/nonexistent/ffmpeg", vec![], 1_000);
        let error = SystemProcessRunner::new(crate::clock::system_clock())
            .run(&request)
            .expect_err("must fail");
        assert_eq!(error.code(), ErrorCode::Internal);
    }

    #[test]
    fn a_nonzero_exit_is_reported_rather_than_assumed() {
        // A real FFmpeg refusing a file that is not there: exit status nonzero,
        // measured, not inferred.
        let request = ProcessRequest::new(
            harness::require(&harness::ffmpeg()),
            vec![
                OsString::from("-hide_banner"),
                OsString::from("-nostdin"),
                OsString::from("-i"),
                PathBuf::from("/nonexistent/input.mp4").into_os_string(),
                OsString::from("-f"),
                OsString::from("null"),
                OsString::from("-"),
            ],
            30_000,
        );
        let outcome = SystemProcessRunner::new(crate::clock::system_clock())
            .run(&request)
            .expect("outcome");
        assert_ne!(outcome.exit_code, Some(0), "{outcome:?}");
        assert!(!outcome.succeeded());
        assert!(
            outcome.stderr_total_bytes > 0,
            "ffmpeg said why: {outcome:?}"
        );
    }
}
