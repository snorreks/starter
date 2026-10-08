//! Process entrypoint: `encode`, `fixture`, `--version`, `--help`.
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
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::flag;

use starter_media::cli;
use starter_media::encode::{Encoder, Tools};
#[cfg(test)]
use starter_media::error::ErrorCode;
use starter_media::fixture;
use starter_media::release_identity;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&argv) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            // The failure's public sentence first, so a log line is readable on
            // its own; the detail after it, for an operator with the task.
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
  starter-media encode --input <file> --output <file> [--preset <id>] [--attempt-id <id>]
  starter-media fixture --out <file>
  starter-media --version

ENVIRONMENT
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
        "encode" => encode(&argv[1..]),
        "fixture" => build_fixture(&argv[1..]),
        other => {
            print!("{USAGE}");
            Err(Failure::usage(format!("unknown command: {other}")))
        }
    }
}

/// The finite encode entrypoint.
fn encode(argv: &[String]) -> Result<(), Failure> {
    let args = cli::parse_encode_args(argv).map_err(Failure::usage)?;
    let encoder = Encoder::new(Tools::from_env());
    let cancel = starter_media::process::CancelToken::new();
    let sigterm = flag::register(SIGTERM, cancel.flag().clone())
        .map_err(|error| Failure::usage(format!("SIGTERM: {error}")))?;
    let sigint = match flag::register(SIGINT, cancel.flag().clone()) {
        Ok(id) => id,
        Err(error) => {
            signal_hook::low_level::unregister(sigterm);
            return Err(Failure::usage(format!("SIGINT: {error}")));
        }
    };
    let result = cli::run_encode(&args, &encoder, cancel);
    signal_hook::low_level::unregister(sigterm);
    signal_hook::low_level::unregister(sigint);
    match result {
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
/// has a non-success status distinct from usage errors.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_code_has_a_distinct_enough_exit_status() {
        let codes = [
            ErrorCode::InputEmpty,
            ErrorCode::PayloadTooLarge,
            ErrorCode::UnsupportedPreset,
            ErrorCode::InvalidMedia,
            ErrorCode::OutputTooLarge,
            ErrorCode::InvalidOutput,
            ErrorCode::DeadlineExceeded,
            ErrorCode::Cancelled,
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
