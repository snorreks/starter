//! Process entrypoint: `serve`, `encode`, `fixture`, `--version`, `--help`.
//!
//! Two things live here that do not belong in the library, because they are
//! properties of a *process* rather than of a function:
//!
//! * **Signal handling.** SIGTERM and SIGINT set one flag. A container runtime
//!   stops a container with SIGTERM and then waits; the default disposition would
//!   end this process immediately, in the middle of an FFmpeg child, leaving the
//!   child running (it is not in the same process group kill) and its temp
//!   directory on disk. Handling the signal and unwinding is what makes
//!   "SIGTERM cleans up" true rather than aspirational.
//! * **Argument parsing and exit status.** Small enough to write out; a parser
//!   crate would be a dependency for eight flags.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::flag;

use starter_media::cli;
use starter_media::encode::{Encoder, Tools};
#[cfg(test)]
use starter_media::error::ErrorCode;
use starter_media::fixture;
use starter_media::harness;
use starter_media::http::{Server, ServerConfig};
use starter_media::protocol::{DEFAULT_PORT, SHUTDOWN_GRACE_MS};
use starter_media::release_identity;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&argv) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            // The failure's public sentence first, so a log line is readable on
            // its own; the detail after it, for an operator with the container.
            eprintln!("{failure}");
            match failure.exit_code {
                Some(code) => ExitCode::from(code),
                None => ExitCode::from(2),
            }
        }
    }
}

/// A usage or runtime failure that knows its exit status.
struct Failure {
    message: String,
    exit_code: Option<u8>,
}

impl Failure {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: Some(2),
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<starter_media::ProcessorError> for Failure {
    fn from(error: starter_media::ProcessorError) -> Self {
        let detail = error.detail().map(|d| format!(": {d}")).unwrap_or_default();
        Self {
            message: format!("{error}{detail}"),
            exit_code: Some(cli::exit_code_for(error.code())),
        }
    }
}

const USAGE: &str = "\
starter-media — bounded FFmpeg encode processor

USAGE
  starter-media serve  [--port <n>] [--tmpdir <path>]
  starter-media encode --input <file> --output <file> [--preset <id>] [--attempt-id <id>]
  starter-media fixture --out <file>
  starter-media --version

ENVIRONMENT
  MEDIA_PORT           default listen port for `serve` (default 8080)
  MEDIA_TMPDIR         directory that owns every request's temp files
  MEDIA_FFMPEG_PATH    ffmpeg binary (default: ffmpeg on PATH)
  MEDIA_FFPROBE_PATH   ffprobe binary (default: ffprobe on PATH)

EXIT STATUS (encode)
  0 success   2 usage   3 preset/protocol   4 input refused
  5 undecodable input   6 invalid output   7 deadline   8 cancelled   9 internal
";

fn dispatch(argv: &[String]) -> Result<(), Failure> {
    let Some(command) = argv.first() else {
        print!("{USAGE}");
        return Err(Failure::usage("no command given"));
    };
    match command.as_str() {
        "--version" | "-V" | "version" => {
            println!("{}", release_identity());
            Ok(())
        }
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        "serve" => serve(&argv[1..]),
        "encode" => encode(&argv[1..]),
        "fixture" => build_fixture(&argv[1..]),
        other => {
            print!("{USAGE}");
            Err(Failure::usage(format!("unknown command: {other}")))
        }
    }
}

/// The HTTP entrypoint.
fn serve(argv: &[String]) -> Result<(), Failure> {
    let mut port = std::env::var("MEDIA_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let mut temp_root: Option<PathBuf> = std::env::var_os("MEDIA_TMPDIR").map(PathBuf::from);
    let mut index = 0;
    while index < argv.len() {
        match argv[index].as_str() {
            "--port" => {
                index += 1;
                port = argv
                    .get(index)
                    .and_then(|value| value.parse().ok())
                    .ok_or_else(|| Failure::usage("--port requires a number"))?;
            }
            "--tmpdir" => {
                index += 1;
                temp_root = Some(PathBuf::from(
                    argv.get(index)
                        .ok_or_else(|| Failure::usage("--tmpdir requires a path"))?,
                ));
            }
            other => return Err(Failure::usage(format!("unknown argument: {other}"))),
        }
        index += 1;
    }

    if let Some(root) = &temp_root {
        // Fail before binding: a missing temp root would otherwise surface as a
        // 500 on the first encode, long after the platform reported the
        // container as healthy.
        std::fs::create_dir_all(root).map_err(|error| Failure {
            message: format!("could not create temp root {}: {error}", root.display()),
            exit_code: Some(9),
        })?;
    }

    let shutdown = starter_media::http::ShutdownSignal::new();
    // register() returns after the handler is installed, so a SIGTERM arriving
    // during startup cannot be lost between the flag's creation and the
    // registration.
    flag::register(SIGTERM, shutdown.flag().clone())
        .map_err(|error| Failure::usage(format!("SIGTERM: {error}")))?;
    flag::register(SIGINT, shutdown.flag().clone())
        .map_err(|error| Failure::usage(format!("SIGINT: {error}")))?;

    let mut encoder = Encoder::new(Tools::from_env());
    if let Some(root) = temp_root {
        encoder = encoder.with_temp_root(root);
    }
    let address = format!("0.0.0.0:{port}");
    let server = Server::bind(
        &address,
        Arc::new(encoder),
        release_identity(),
        ServerConfig {
            shutdown: shutdown.clone(),
            encode_slot: Arc::new(Mutex::new(())),
        },
    )?;

    // The worker owns the accept loop; this thread owns the signals.
    let server = Arc::new(server);
    let worker = {
        let server = server.clone();
        std::thread::spawn(move || server.serve())
    };

    println!(
        "starter-media {} listening on {address}",
        release_identity()
    );

    while !shutdown.is_requested() {
        std::thread::sleep(Duration::from_millis(50));
    }

    // Unwind in two steps, in this order:
    // 1. Cancel every registered encode, so FFmpeg children are killed and reaped
    //    now rather than being left to their 120-second deadline.
    println!("shutdown: signal received, cancelling in-flight encodes");
    shutdown.cancel_all();
    let budget = Duration::from_millis(SHUTDOWN_GRACE_MS);
    let accept_loop_stopped = harness::wait_until(
        || worker.is_finished(),
        u64::try_from(budget.as_millis()).unwrap_or(u64::MAX),
    );
    match worker.join() {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("shutdown: server stopped with {error}"),
        Err(_) => eprintln!("shutdown: server thread panicked"),
    }
    // Wait for the cancelled encodes to finish unwinding. Their temp directories
    // are removed by the encode path, so exiting before this point is what would
    // leave a cancelled request's files on disk.
    if server.wait_for_idle(budget) {
        println!("shutdown: complete, no requests in flight");
    } else if accept_loop_stopped {
        println!("shutdown: complete, some requests were still unwinding at the grace limit");
    } else {
        eprintln!("shutdown: the accept loop did not stop within the grace period");
    }
    Ok(())
}

/// The finite encode entrypoint.
fn encode(argv: &[String]) -> Result<(), Failure> {
    let args = cli::parse_encode_args(argv).map_err(Failure::usage)?;
    let encoder = Encoder::new(Tools::from_env());
    match cli::run_encode(&args, &encoder) {
        Ok(encoded) => {
            cli::print_success(&encoded);
            Ok(())
        }
        Err(error) => {
            cli::print_failure(&error);
            Err(Failure {
                message: error.code().public_message().to_string(),
                exit_code: Some(cli::exit_code_for(error.code())),
            })
        }
    }
}

/// The fixture generator.
fn build_fixture(argv: &[String]) -> Result<(), Failure> {
    let mut output: Option<PathBuf> = None;
    let mut index = 0;
    while index < argv.len() {
        match argv[index].as_str() {
            "--out" => {
                index += 1;
                output = Some(PathBuf::from(
                    argv.get(index)
                        .ok_or_else(|| Failure::usage("--out requires a path"))?,
                ));
            }
            other => return Err(Failure::usage(format!("unknown argument: {other}"))),
        }
        index += 1;
    }
    let output = output.ok_or_else(|| Failure::usage("--out is required"))?;
    let tools = Tools::from_env();
    fixture::generate_default(&output, &tools.ffmpeg)?;
    println!("{}", output.display());
    Ok(())
}

/// Keep the compiler honest about the error table: every code the CLI can report
/// has a status, including the two the HTTP layer produces that the CLI cannot.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_code_has_a_distinct_enough_exit_status() {
        let codes = [
            ErrorCode::InputEmpty,
            ErrorCode::PayloadTooLarge,
            ErrorCode::UnsupportedTransferEncoding,
            ErrorCode::ProtocolMismatch,
            ErrorCode::UnsupportedPreset,
            ErrorCode::InvalidAttemptId,
            ErrorCode::Busy,
            ErrorCode::InvalidMedia,
            ErrorCode::OutputTooLarge,
            ErrorCode::InvalidOutput,
            ErrorCode::DeadlineExceeded,
            ErrorCode::Cancelled,
            ErrorCode::NotFound,
            ErrorCode::Internal,
        ];
        for code in codes {
            let status = cli::exit_code_for(code);
            assert_ne!(status, 0, "{} would look like success", code.wire());
            assert_ne!(
                status,
                2,
                "{} is a runtime failure, not a usage error",
                code.wire()
            );
        }
    }
}
