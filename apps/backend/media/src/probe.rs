//! Output validation with a real FFprobe.
//!
//! The encoder does not decide that its output is correct. It runs FFprobe over
//! the bytes FFmpeg actually wrote and accepts them only if FFprobe reports the
//! preset's container, video codec and frame size, a duration inside the preset's
//! window, and at least one video stream. FFprobe exiting zero on a file it
//! cannot read is not possible, so its exit status is the first half of the
//! answer and the parsed document is the second.
//!
//! Nothing here trusts the request, the preset's own argument list, or a
//! previously produced file: the only input is a path this crate owns, inside a
//! temp directory that is removed when the request ends.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::{ErrorCode, ProcessorError, Result};
use crate::preset::Preset;
use crate::process::{ProcessRequest, ProcessRunner, TerminationReason};
use crate::protocol::{ProbeSummary, PROBE_DEADLINE_MS};

/// FFprobe's JSON, as far as this crate reads it.
///
/// Missing fields receive serde defaults. Validation rejects missing required
/// data and default values such as empty codec names and zero dimensions.
#[derive(Debug, serde::Deserialize)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: Option<ProbeFormat>,
}

#[derive(Debug, serde::Deserialize)]
struct ProbeStream {
    #[serde(default)]
    codec_type: String,
    #[serde(default)]
    codec_name: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ProbeFormat {
    #[serde(default)]
    format_name: String,
    #[serde(default)]
    duration: Option<String>,
}

/// Measure and validate one file against a preset.
pub fn validate(
    file: &Path,
    preset: &Preset,
    runner: &dyn ProcessRunner,
    ffprobe: &Path,
) -> Result<ProbeSummary> {
    let mut request = ProcessRequest::new(
        ffprobe.as_os_str().to_os_string(),
        Preset::ffprobe_args(file),
        PROBE_DEADLINE_MS,
    );
    // FFprobe's JSON for a ≤10 MiB file is tens of kilobytes; the bound is
    // explicit so a pathological file cannot make this allocation unbounded.
    request.capture_stdout = true;
    request.stdout_keep_bytes = crate::protocol::MAX_PROBE_JSON_BYTES;

    let outcome = runner.run(&request)?;
    match outcome.terminated {
        Some(TerminationReason::Deadline) => {
            return Err(ProcessorError::new(ErrorCode::DeadlineExceeded)
                .with_detail("ffprobe exceeded its deadline"));
        }
        Some(TerminationReason::Cancelled) => {
            return Err(ProcessorError::new(ErrorCode::Cancelled).with_detail("ffprobe cancelled"));
        }
        None => {}
    }

    if !outcome.succeeded() {
        // FFprobe's own message is the useful part, and it is bounded already.
        // It stays in the detail: an unreadable file's message can echo the
        // path, and the path is a temp path inside the container.
        return Err(
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail(format!(
                "ffprobe exit {:?}: {}",
                outcome.exit_code,
                outcome.stderr_tail.trim()
            )),
        );
    }
    if outcome.stdout_total_bytes > crate::protocol::MAX_PROBE_JSON_BYTES as u64 {
        return Err(
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail(format!(
                "ffprobe document exceeded {} bytes",
                crate::protocol::MAX_PROBE_JSON_BYTES
            )),
        );
    }

    let document: ProbeDocument = serde_json::from_str(&outcome.stdout).map_err(|error| {
        ProcessorError::new(ErrorCode::InvalidOutput)
            .with_detail(format!("unparseable ffprobe document: {error}"))
    })?;

    check_container(&document, preset)?;
    let video_streams: Vec<&ProbeStream> = document
        .streams
        .iter()
        .filter(|stream| stream.codec_type == "video")
        .collect();
    let audio_streams = document
        .streams
        .iter()
        .filter(|s| s.codec_type == "audio")
        .count() as u32;
    check_video(&video_streams, preset)?;
    let duration_ms = duration_of(&document)?;

    Ok(ProbeSummary {
        container_format: document
            .format
            .as_ref()
            .map(|format| format.format_name.clone())
            .unwrap_or_default(),
        video_codec: video_streams[0].codec_name.clone(),
        width: video_streams[0].width,
        height: video_streams[0].height,
        duration_ms,
        video_streams: video_streams.len() as u32,
        audio_streams,
    })
}

/// The container must be the preset's container and actually contain video.
fn check_container(document: &ProbeDocument, preset: &Preset) -> Result<()> {
    let format = document.format.as_ref().ok_or_else(|| {
        ProcessorError::new(ErrorCode::InvalidOutput).with_detail("ffprobe reported no format")
    })?;
    let names: Vec<&str> = format.format_name.split(',').collect();
    // FFprobe reports `mov,mp4,m4a,3gp,3g2,mj2` for MP4, so the check is
    // "does the reported list contain the preset's container", not equality.
    let acceptable = [preset.container];
    if !names.iter().any(|name| acceptable.contains(name)) {
        return Err(
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail(format!(
                "container {} is not {}",
                format.format_name, preset.container
            )),
        );
    }
    Ok(())
}

/// The video stream must be the preset's codec at the preset's frame size.
fn check_video(streams: &[&ProbeStream], preset: &Preset) -> Result<()> {
    let first = streams.first().ok_or_else(|| {
        ProcessorError::new(ErrorCode::InvalidOutput).with_detail("no video stream")
    })?;
    if first.codec_name != preset.video_codec {
        return Err(
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail(format!(
                "video codec {} != {}",
                first.codec_name, preset.video_codec
            )),
        );
    }
    if first.width != preset.width || first.height != preset.height {
        return Err(
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail(format!(
                "video is {}x{}, preset requires {}x{}",
                first.width, first.height, preset.width, preset.height
            )),
        );
    }
    Ok(())
}

/// Duration in whole milliseconds, from the container or from the video stream.
///
/// A container without a duration is rejected rather than treated as zero: an
/// unbounded duration is a stream this process cannot claim to have encoded
/// inside the preset's configured `min_duration_ms..=max_duration_ms` range.
fn duration_of(document: &ProbeDocument) -> Result<u64> {
    let raw = document
        .format
        .as_ref()
        .and_then(|format| format.duration.as_deref())
        .or_else(|| {
            document
                .streams
                .iter()
                .find(|stream| stream.codec_type == "video")
                .and_then(|stream| stream.duration.as_deref())
        })
        .ok_or_else(|| {
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail("no duration reported")
        })?;
    let seconds: f64 = raw.parse().map_err(|_| {
        ProcessorError::new(ErrorCode::InvalidOutput)
            .with_detail(format!("unparseable duration {raw}"))
    })?;
    if !(seconds.is_finite() && seconds > 0.0) {
        return Err(ProcessorError::new(ErrorCode::InvalidOutput)
            .with_detail(format!("non-positive duration {seconds}")));
    }
    Ok((seconds * 1000.0).round() as u64)
}

/// Check a measured duration against the preset's window.
pub fn check_duration(summary: &ProbeSummary, preset: &Preset) -> Result<()> {
    if summary.duration_ms < preset.min_duration_ms || summary.duration_ms > preset.max_duration_ms
    {
        return Err(
            ProcessorError::new(ErrorCode::InvalidOutput).with_detail(format!(
                "duration {}ms outside {}..={}ms",
                summary.duration_ms, preset.min_duration_ms, preset.max_duration_ms
            )),
        );
    }
    Ok(())
}

/// Header value map for a successful response, derived from one measured
/// outcome. Exposed so the HTTP layer and the CLI cannot drift in how they
/// describe the same file.
pub fn output_headers(
    success: &crate::protocol::EncodeSuccessDocument,
) -> BTreeMap<&'static str, String> {
    use crate::protocol::{
        HEADER_ATTEMPT, HEADER_OUTPUT_BYTES, HEADER_OUTPUT_CODEC, HEADER_OUTPUT_DIMENSIONS,
        HEADER_OUTPUT_DURATION_MS, HEADER_OUTPUT_SHA256, HEADER_PRESET, HEADER_PROTOCOL,
    };
    BTreeMap::from([
        (HEADER_PROTOCOL, success.protocol.clone()),
        (HEADER_PRESET, success.preset.clone()),
        (HEADER_ATTEMPT, success.attempt_id.clone()),
        (HEADER_OUTPUT_BYTES, success.output_bytes.to_string()),
        (HEADER_OUTPUT_SHA256, success.output_sha256.clone()),
        (
            HEADER_OUTPUT_DURATION_MS,
            success.probe.duration_ms.to_string(),
        ),
        (HEADER_OUTPUT_CODEC, success.probe.video_codec.clone()),
        (
            HEADER_OUTPUT_DIMENSIONS,
            format!("{}x{}", success.probe.width, success.probe.height),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset() -> Preset {
        crate::preset::DEMO_180P_V1
    }

    fn summary(duration_ms: u64) -> ProbeSummary {
        ProbeSummary {
            container_format: "mov,mp4,m4a,3gp,3g2,mj2".into(),
            video_codec: "h264".into(),
            width: 320,
            height: 180,
            duration_ms,
            video_streams: 1,
            audio_streams: 1,
        }
    }

    #[test]
    fn the_duration_window_accepts_a_real_clip_and_refuses_a_frame_or_a_loop() {
        // The demo fixture is three seconds, but the window is a sanity bound and
        // not a fingerprint of it: the CLI encodes local files with the same
        // preset, and a thirty-second input is a legitimate one.
        assert!(check_duration(&summary(3_000), &preset()).is_ok());
        assert!(check_duration(&summary(30_000), &preset()).is_ok());
        assert!(check_duration(&summary(60_000), &preset()).is_ok());

        // A 400 ms file is the classic "success" that encoded one frame: right
        // codec, right geometry, useless content.
        let truncated = check_duration(&summary(400), &preset()).unwrap_err();
        assert_eq!(truncated.code(), ErrorCode::InvalidOutput);
        // An input that looped for hours would otherwise be free to consume the
        // whole deadline inside a container billed by the second.
        let looped = check_duration(&summary(61_000), &preset()).unwrap_err();
        assert_eq!(looped.code(), ErrorCode::InvalidOutput);
    }

    #[test]
    fn container_and_video_checks_reject_a_substituted_file() {
        let document = ProbeDocument {
            streams: vec![ProbeStream {
                codec_type: "video".into(),
                codec_name: "vp9".into(),
                width: 320,
                height: 180,
                duration: Some("3.0".into()),
            }],
            format: Some(ProbeFormat {
                format_name: "matroska,webm".into(),
                duration: Some("3.0".into()),
            }),
        };
        assert_eq!(
            check_container(&document, &preset()).unwrap_err().code(),
            ErrorCode::InvalidOutput
        );
        let streams: Vec<&ProbeStream> = document.streams.iter().collect();
        assert_eq!(
            check_video(&streams, &preset()).unwrap_err().code(),
            ErrorCode::InvalidOutput
        );

        let wrong_size = ProbeDocument {
            streams: vec![ProbeStream {
                codec_type: "video".into(),
                codec_name: "h264".into(),
                width: 640,
                height: 360,
                duration: Some("3.0".into()),
            }],
            format: Some(ProbeFormat {
                format_name: "mov,mp4,m4a".into(),
                duration: Some("3.0".into()),
            }),
        };
        let streams: Vec<&ProbeStream> = wrong_size.streams.iter().collect();
        assert_eq!(
            check_video(&streams, &preset()).unwrap_err().code(),
            ErrorCode::InvalidOutput
        );
    }

    #[test]
    fn a_document_without_a_duration_is_rejected_rather_than_read_as_zero() {
        let document = ProbeDocument {
            streams: vec![ProbeStream {
                codec_type: "video".into(),
                codec_name: "h264".into(),
                width: 320,
                height: 180,
                duration: None,
            }],
            format: Some(ProbeFormat {
                format_name: "mov,mp4,m4a".into(),
                duration: None,
            }),
        };
        assert!(duration_of(&document).is_err());
    }

    #[test]
    fn missing_fields_are_named_rather_than_defaulted_to_zero() {
        // An empty document has no format block, so there is nothing to accept.
        let document = ProbeDocument {
            streams: vec![],
            format: None,
        };
        assert!(check_container(&document, &preset()).is_err());
        assert!(duration_of(&document).is_err());
        assert!(check_video(&[], &preset()).is_err());
    }

    #[test]
    fn response_headers_describe_the_measured_file() {
        let success = crate::protocol::EncodeSuccessDocument {
            protocol: crate::protocol::PROTOCOL_ID.into(),
            preset: crate::protocol::PRESET_ID.into(),
            attempt_id: "attempt-1".into(),
            output_bytes: 12_345,
            output_sha256: "ab".repeat(32),
            probe: summary(3_012),
        };
        let headers = output_headers(&success);
        assert_eq!(headers["x-output-bytes"], "12345");
        assert_eq!(headers["x-output-dimensions"], "320x180");
        assert_eq!(headers["x-output-duration-ms"], "3012");
        assert_eq!(headers["x-output-codec"], "h264");
    }
}
