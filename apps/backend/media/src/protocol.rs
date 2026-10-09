//! Versioned encode result and hard bounds for the finite processor.

use serde::{Deserialize, Serialize};

/// Result protocol emitted by the CLI and checked by the Cloud Run runner.
pub const PROTOCOL_ID: &str = "sample-v1";
/// The only preset this build accepts.
pub const PRESET_ID: &str = "demo-180p-v1";
/// Upper bound on input bytes.
pub const MAX_INPUT_BYTES: u64 = 5 * 1024 * 1024;
/// Upper bound on encoded output bytes.
pub const MAX_OUTPUT_BYTES: u64 = 10 * 1024 * 1024;
/// Wall-clock budget for one FFmpeg invocation.
pub const ENCODE_DEADLINE_MS: u64 = 120_000;
/// Wall-clock budget for FFprobe validation.
pub const PROBE_DEADLINE_MS: u64 = 20_000;
/// Maximum FFmpeg threads.
pub const MAX_ENCODE_THREADS: u32 = 2;
/// Maximum stderr bytes retained for diagnostics.
pub const STDERR_KEEP_BYTES: usize = 8 * 1024;
/// Maximum FFprobe JSON bytes parsed for one file.
pub const MAX_PROBE_JSON_BYTES: usize = 1024 * 1024;

/// The finite CLI's successful result document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncodeSuccessDocument {
    pub protocol: String,
    pub preset: String,
    pub attempt_id: String,
    pub output_bytes: u64,
    pub output_sha256: String,
    pub probe: ProbeSummary,
}

/// Measured FFprobe values for the produced file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeSummary {
    pub container_format: String,
    pub video_codec: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub video_streams: u32,
    pub audio_streams: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processor_protocol_is_versioned_and_resource_bounds_are_explicit() {
        assert_eq!(PROTOCOL_ID, "sample-v1");
        assert_eq!(PRESET_ID, "demo-180p-v1");
        assert!(MAX_INPUT_BYTES > 0 && MAX_OUTPUT_BYTES > MAX_INPUT_BYTES);
        assert!(ENCODE_DEADLINE_MS > PROBE_DEADLINE_MS);
        assert!(MAX_ENCODE_THREADS > 0);
        assert!(STDERR_KEEP_BYTES > 0 && MAX_PROBE_JSON_BYTES > STDERR_KEEP_BYTES);
    }
}
