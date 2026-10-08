//! Typed failures for the processor.
//!
//! Two strings travel with every failure and only one of them leaves the process:
//!
//! * `public_message` is a fixed, hand-written sentence per [`ErrorCode`]. It is
//!   the only text that may appear in a CLI stderr line or a
//!   log record that a caller can read.
//! * `detail` is the internal context: an `io::Error`, an exit status, a bounded
//!   tail of FFmpeg's stderr. FFmpeg's stderr is attacker-influenced (it echoes
//!   container metadata and file names) and can be megabytes of banner text, so
//!   it is recorded for an operator and never returned to a caller.
//!
//! `retryable` marks transient process outcomes. Deterministic media and
//! configuration failures are terminal; deadlines and cancellation can be
//! retried by the owning job within its attempt budget.

use std::fmt;
use std::io;
use std::path::Path;

/// A failure classification. The wire string is frozen by the protocol version
/// and is asserted against a golden fixture in `tests/protocol_golden.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// Zero input bytes arrived.
    InputEmpty,
    /// Input exceeded `MAX_INPUT_BYTES`, refused before any work was done.
    PayloadTooLarge,
    /// `x-preset` named a preset this build does not implement.
    UnsupportedPreset,
    /// FFmpeg refused the input, or produced nothing. Terminal: the same bytes
    /// will fail the same way.
    InvalidMedia,
    /// The encode succeeded but exceeded `MAX_OUTPUT_BYTES`.
    OutputTooLarge,
    /// The encode produced bytes that FFprobe rejects, or that are not the
    /// preset's codec, dimensions and duration.
    InvalidOutput,
    /// The process deadline expired; the child was terminated and reaped.
    DeadlineExceeded,
    /// The caller disconnected, or the process was asked to shut down.
    Cancelled,
    /// A filesystem or subprocess error with no more specific classification.
    Internal,
}

impl ErrorCode {
    /// The frozen wire string.
    pub const fn wire(self) -> &'static str {
        match self {
            Self::InputEmpty => "input_empty",
            Self::PayloadTooLarge => "payload_too_large",
            Self::UnsupportedPreset => "unsupported_preset",
            Self::InvalidMedia => "invalid_media",
            Self::OutputTooLarge => "output_too_large",
            Self::InvalidOutput => "invalid_output",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::Cancelled => "cancelled",
            Self::Internal => "internal_error",
        }
    }

    /// The fixed sentence a caller may see. No bytes, paths, argv or stderr.
    pub const fn public_message(self) -> &'static str {
        match self {
            Self::InputEmpty => "input body was empty",
            Self::PayloadTooLarge => "input body exceeds the configured maximum",
            Self::UnsupportedPreset => "unsupported preset",
            Self::InvalidMedia => "input media could not be decoded",
            Self::OutputTooLarge => "encoded output exceeds the configured maximum",
            Self::InvalidOutput => "encoded output failed validation",
            Self::DeadlineExceeded => "encoding exceeded its deadline",
            Self::Cancelled => "encoding was cancelled",
            Self::Internal => "internal processor error",
        }
    }

    /// Whether a caller may try the same bytes again. See the module comment.
    pub const fn retryable(self) -> bool {
        matches!(
            self,
            Self::DeadlineExceeded | Self::Cancelled | Self::Internal
        )
    }
}

/// A classified failure.
#[derive(Debug)]
pub struct ProcessorError {
    code: ErrorCode,
    detail: Option<String>,
}

impl ProcessorError {
    /// Build a failure with only its public sentence.
    pub fn new(code: ErrorCode) -> Self {
        Self { code, detail: None }
    }

    /// Attach operator-facing context. Never serialized to a caller.
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Attach operator-facing context built from a path.
    pub fn with_path(self, path: &Path) -> Self {
        self.with_detail(format!("path: {}", path.display()))
    }

    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

impl fmt::Display for ProcessorError {
    /// Prints the public sentence plus the internal detail, for the process's
    /// own stderr. HTTP bodies are built from the fields, never from this.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.code.public_message(), self.code.wire())?;
        if let Some(detail) = &self.detail {
            write!(f, ": {detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ProcessorError {}

impl From<io::Error> for ProcessorError {
    fn from(error: io::Error) -> Self {
        let code = match error.kind() {
            io::ErrorKind::TimedOut => ErrorCode::DeadlineExceeded,
            _ => ErrorCode::Internal,
        };
        Self {
            code,
            detail: Some(error.to_string()),
        }
    }
}

/// Result alias used across the crate.
pub type Result<T> = std::result::Result<T, ProcessorError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_failures_are_not_retryable() {
        // The reason these four are terminal is a bounded retry budget upstream:
        // a retry of any of them repeats a deterministic failure and can spend
        // the whole attempt allowance on one undecodable file.
        for code in [
            ErrorCode::InvalidMedia,
            ErrorCode::InvalidOutput,
            ErrorCode::UnsupportedPreset,
        ] {
            assert!(!code.retryable(), "{} must be terminal", code.wire());
        }
    }

    #[test]
    fn public_message_never_contains_operator_detail() {
        let error = ProcessorError::new(ErrorCode::InvalidMedia)
            .with_detail("ffmpeg exited 1: moov atom not found (/tmp/secret-title.mp4)");
        let rendered = error.to_string();
        assert!(rendered.contains("input media could not be decoded"));
        assert!(rendered.contains("moov atom not found"));
        // The public half is what the wire uses; it is the fixed sentence alone.
        assert_eq!(
            error.code().public_message(),
            "input media could not be decoded"
        );
    }

    #[test]
    fn wire_strings_are_stable_and_snake_case() {
        for code in [
            ErrorCode::InputEmpty,
            ErrorCode::PayloadTooLarge,
            ErrorCode::UnsupportedPreset,
            ErrorCode::InvalidMedia,
            ErrorCode::OutputTooLarge,
            ErrorCode::InvalidOutput,
            ErrorCode::DeadlineExceeded,
            ErrorCode::Cancelled,
            ErrorCode::Internal,
        ] {
            let wire = code.wire();
            assert!(!wire.is_empty());
            assert!(
                wire.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{wire} is not a stable snake_case wire token"
            );
        }
    }
}
