//! The finite CLI: encode local files, exit with a real status.
//!
//! This is the half of the processor that a batch runner uses. It exists
//! because a Cloud Run Job, an ECS task or an operator's laptop wants exactly one
//! thing: run the encode, exit, and let the platform decide what an exit code
//! means. A server that stays up is the wrong shape for a job, and the
//! alternative — an operator shelling out to `curl` against a long-running
//! container — makes the exit status a human's job instead of the platform's.
//!
//! It calls [`crate::encode`] and nothing else. The preset, the deadline, the
//! output cap, the validation and the hash are the same code the HTTP route runs;
//! there is no second implementation of "encode and check" to drift.
//!
//! # Exit status
//!
//! | Status | Meaning | Retryable upstream |
//! |---:|---|---|
//! | 0 | encoded, validated, written | — |
//! | 2 | usage error (bad flag, missing argument) | no |
//! | 3 | unsupported preset or protocol | no |
//! | 4 | input refused (empty, or above the cap) | no |
//! | 5 | input media could not be decoded | no |
//! | 6 | output failed validation, or exceeded the cap | no |
//! | 7 | deadline exceeded | yes |
//! | 8 | cancelled by a signal | yes |
//! | 9 | I/O or internal error | depends |
//!
//! The distinction the table exists for: a job runner must be able to tell a
//! retryable transport-shaped failure from a deterministic one, and "exit 1 for
//! everything" makes that impossible without parsing stderr — which is the string
//! this crate deliberately keeps free of subprocess output.

use std::path::PathBuf;
use std::process::ExitCode;

use crate::encode::Encoder;
use crate::error::{ErrorCode, ProcessorError, Result};
use crate::preset::lookup;
use crate::process::CancelToken;
use crate::protocol::PRESET_ID;

/// The status a failure maps to. See the module table.
pub const fn exit_code_for(code: ErrorCode) -> u8 {
    match code {
        ErrorCode::UnsupportedPreset
        | ErrorCode::ProtocolMismatch
        | ErrorCode::InvalidAttemptId
        | ErrorCode::UnsupportedTransferEncoding => 3,
        ErrorCode::InputEmpty | ErrorCode::PayloadTooLarge => 4,
        ErrorCode::InvalidMedia => 5,
        ErrorCode::InvalidOutput | ErrorCode::OutputTooLarge => 6,
        ErrorCode::DeadlineExceeded => 7,
        ErrorCode::Cancelled | ErrorCode::Busy => 8,
        ErrorCode::NotFound | ErrorCode::Internal => 9,
    }
}

/// A parsed `encode` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodeArgs {
    pub input: PathBuf,
    pub output: PathBuf,
    pub preset: String,
    pub attempt_id: String,
}

/// Parse `encode` arguments. Unknown flags are an error rather than ignored, so
/// a job manifest with a typo'd flag fails instead of encoding with defaults.
pub fn parse_encode_args(argv: &[String]) -> std::result::Result<EncodeArgs, String> {
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut preset = PRESET_ID.to_string();
    let mut attempt_id = String::from("cli");

    let mut index = 0;
    while index < argv.len() {
        let argument = argv[index].as_str();
        let mut take_value = |name: &str| -> std::result::Result<String, String> {
            index += 1;
            argv.get(index)
                .cloned()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match argument {
            "--input" => input = Some(PathBuf::from(take_value("--input")?)),
            "--output" => output = Some(PathBuf::from(take_value("--output")?)),
            "--preset" => preset = take_value("--preset")?,
            "--attempt-id" => attempt_id = take_value("--attempt-id")?,
            other => return Err(format!("unknown argument: {other}")),
        }
        index += 1;
    }

    let input = input.ok_or("--input is required")?;
    let output = output.ok_or("--output is required")?;
    if input == output {
        return Err("--input and --output must differ".to_string());
    }
    Ok(EncodeArgs {
        input,
        output,
        preset,
        attempt_id,
    })
}

/// Run one encode. Returns the status to exit with.
pub fn run_encode(args: &EncodeArgs, encoder: &Encoder) -> Result<crate::encode::EncodedOutput> {
    let preset = lookup(&args.preset)?;
    encoder.encode_from_path(
        &args.input,
        Some(&args.output),
        preset,
        &args.attempt_id,
        CancelToken::new(),
    )
}

/// Print the machine-readable summary a job runner reads.
///
/// stdout carries the result document and nothing else, so
/// `starter-media encode … | jq -r .output_sha256` is a supported use and the
/// operator-facing detail stays on stderr.
pub fn print_success(encoded: &crate::encode::EncodedOutput) {
    let document = &encoded.success;
    println!(
        "{}",
        serde_json::to_string(document)
            .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_string())
    );
}

/// Print a failure the way a caller can act on it: the frozen code and the fixed
/// sentence on stdout-adjacent stderr, the operator detail only here.
pub fn print_failure(error: &ProcessorError) {
    eprintln!(
        "{} ({}): {}",
        error.code().public_message(),
        error.code().wire(),
        exit_code_for(error.code())
    );
    if let Some(detail) = error.detail() {
        eprintln!("detail: {detail}");
    }
}

/// Map a failure to the process's exit status.
pub fn status_for(error: &ProcessorError) -> ExitCode {
    ExitCode::from(exit_code_for(error.code()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typo_in_a_flag_is_refused_rather_than_encoded_with_defaults() {
        let argv = vec![
            "--input".to_string(),
            "/tmp/in.mp4".to_string(),
            "--output".to_string(),
            "/tmp/out.mp4".to_string(),
            "--presett".to_string(),
            "demo-180p-v1".to_string(),
        ];
        let error = parse_encode_args(&argv).unwrap_err();
        assert!(error.contains("unknown argument: --presett"), "{error}");
    }

    #[test]
    fn missing_arguments_are_usage_errors_not_silent_defaults() {
        assert!(parse_encode_args(&[]).unwrap_err().contains("--input"));
        assert!(
            parse_encode_args(&["--input".to_string(), "/tmp/a.mp4".to_string()])
                .unwrap_err()
                .contains("--output")
        );
        assert!(parse_encode_args(&["--input".to_string()])
            .unwrap_err()
            .contains("requires a value"));
    }

    #[test]
    fn input_and_output_must_differ() {
        let argv = vec![
            "--input".to_string(),
            "/tmp/same.mp4".to_string(),
            "--output".to_string(),
            "/tmp/same.mp4".to_string(),
        ];
        assert!(parse_encode_args(&argv)
            .unwrap_err()
            .contains("must differ"));
    }

    #[test]
    fn defaults_are_the_frozen_protocol_values() {
        let argv = vec![
            "--input".to_string(),
            "/tmp/in.mp4".to_string(),
            "--output".to_string(),
            "/tmp/out.mp4".to_string(),
        ];
        let parsed = parse_encode_args(&argv).expect("parsed");
        assert_eq!(parsed.preset, PRESET_ID);
        assert_eq!(parsed.attempt_id, "cli");
        assert!(lookup(&parsed.preset).is_ok());
    }

    #[test]
    fn terminal_and_transient_failures_have_different_statuses() {
        // A runner must be able to retry without parsing stderr: these four
        // numbers are the whole contract it needs.
        assert_eq!(exit_code_for(ErrorCode::InvalidMedia), 5);
        assert_eq!(exit_code_for(ErrorCode::InvalidOutput), 6);
        assert_eq!(exit_code_for(ErrorCode::UnsupportedPreset), 3);
        assert_ne!(
            exit_code_for(ErrorCode::DeadlineExceeded),
            exit_code_for(ErrorCode::InvalidMedia)
        );
        assert_ne!(
            exit_code_for(ErrorCode::Cancelled),
            exit_code_for(ErrorCode::InvalidMedia)
        );
    }
}
