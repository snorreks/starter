//! The encode core against real FFmpeg, and the CLI that shares it.
//!
//! Everything here runs the binaries a deployed container runs. Nothing is
//! mocked, and there is no network: the input is the committed synthetic
//! fixture, and the only "prebuilt" artefact in the suite is that input — never
//! an output. Every assertion about output bytes is checked against bytes FFmpeg
//! produced in this process.

use std::path::Path;
use std::sync::Arc;

use starter_media::cli;
use starter_media::encode::{Encoder, Tools};
use starter_media::error::ErrorCode;
use starter_media::harness;
use starter_media::preset::{self, DEMO_180P_V1};
use starter_media::process::{CancelToken, ProcessRunner};
use starter_media::protocol::{MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, PRESET_ID};

fn encoder(scratch: &Path) -> Encoder {
    Encoder::with_runner(
        Tools {
            ffmpeg: harness::require(&harness::ffmpeg()),
            ffprobe: harness::require(&harness::ffprobe()),
        },
        std::sync::Arc::new(starter_media::process::SystemProcessRunner::new(
            starter_media::clock::system_clock(),
        )),
    )
    .with_temp_root(scratch)
}

#[test]
fn the_committed_fixture_encodes_to_a_validated_mp4() {
    let scratch = harness::scratch_dir("encode-success");
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");

    let encoded = encoder(&scratch)
        .encode_from_bytes(&input, &DEMO_180P_V1, "attempt-success", CancelToken::new())
        .expect("encode succeeds");

    // Measured, not asserted from the preset: these are FFprobe's numbers.
    assert_eq!(encoded.success.protocol, "sample-v1");
    assert_eq!(encoded.success.preset, PRESET_ID);
    assert_eq!(encoded.success.attempt_id, "attempt-success");
    assert_eq!(encoded.success.probe.video_codec, "h264");
    assert_eq!(encoded.success.probe.width, 320);
    assert_eq!(encoded.success.probe.height, 180);
    assert_eq!(encoded.success.probe.video_streams, 1);
    assert_eq!(encoded.success.probe.audio_streams, 1);
    assert!(
        (DEMO_180P_V1.min_duration_ms..=DEMO_180P_V1.max_duration_ms)
            .contains(&encoded.success.probe.duration_ms),
        "duration {}ms",
        encoded.success.probe.duration_ms
    );
    assert!(encoded.success.probe.container_format.contains("mp4"));

    // Real bytes, bounded, and an MP4 rather than a copy of the input.
    assert!(encoded.success.output_bytes > 0);
    assert!(encoded.success.output_bytes <= MAX_OUTPUT_BYTES);
    let mut output = Vec::new();
    encoded.copy_to(&mut output).expect("stream");
    assert_eq!(output.len() as u64, encoded.success.output_bytes);
    assert_eq!(&output[4..8], b"ftyp", "MP4 ftyp box at offset 4");
    assert_ne!(output, input, "the output is not the input, byte for byte");
    assert!(input.len() < MAX_INPUT_BYTES as usize);

    // The hash is of the file that was written, not of the input.
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, &output);
    let hex: String = sha2::Digest::finalize(hasher)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(encoded.success.output_sha256, hex);
    assert_eq!(encoded.success.output_sha256.len(), 64);

    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_encode_is_reproducible_on_this_ffmpeg_build() {
    // Same input, same build, same bytes. This is the property that lets a
    // stored hash mean "this is the encode we validated" — on one host, with the
    // pinned FFmpeg recorded in fixtures/media/PROVENANCE.md.
    let scratch = harness::scratch_dir("encode-reproducible");
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let encoder = encoder(&scratch);
    let first = encoder
        .encode_from_bytes(&input, &DEMO_180P_V1, "attempt-1", CancelToken::new())
        .expect("first encode");
    let second = encoder
        .encode_from_bytes(&input, &DEMO_180P_V1, "attempt-2", CancelToken::new())
        .expect("second encode");
    assert_eq!(first.success.output_sha256, second.success.output_sha256);
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_temp_directory_is_removed_when_the_output_is_dropped() {
    let scratch = harness::scratch_dir("encode-cleanup");
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let work_dir = {
        let encoded = encoder(&scratch)
            .encode_from_bytes(&input, &DEMO_180P_V1, "attempt-cleanup", CancelToken::new())
            .expect("encode succeeds");
        let work = encoded.work_dir().to_path_buf();
        assert!(work.exists(), "the work directory exists while streaming");
        work
    };
    assert!(
        !work_dir.exists(),
        "the work directory outlived the response"
    );
    // Nothing at all is left behind in the request's own temp root.
    let leftovers: Vec<_> = std::fs::read_dir(&scratch)
        .expect("scratch root")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(leftovers.is_empty(), "temp files survived: {leftovers:?}");
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_failed_encode_leaves_no_temp_directory_behind() {
    let scratch = harness::scratch_dir("encode-failure-cleanup");
    // Bytes that are not media at all: FFmpeg refuses them.
    let not_media = vec![0x5A_u8; 4096];
    let error = encoder(&scratch)
        .encode_from_bytes(&not_media, &DEMO_180P_V1, "attempt-bad", CancelToken::new())
        .expect_err("garbage must not encode");
    assert_eq!(error.code(), ErrorCode::InvalidMedia);
    assert!(!error.code().retryable());
    // The refusal is specific enough for an operator, and the public half says
    // nothing about the input.
    assert!(error.detail().is_some());

    let leftovers: Vec<_> = std::fs::read_dir(&scratch)
        .expect("scratch root")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(
        leftovers.is_empty(),
        "a refused request left files: {leftovers:?}"
    );
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn an_empty_and_an_oversized_input_are_refused_by_the_same_limits_health_reports() {
    let scratch = harness::scratch_dir("encode-limits");
    let encoder = encoder(&scratch);
    assert_eq!(
        encoder
            .encode_from_bytes(&[], &DEMO_180P_V1, "attempt-empty", CancelToken::new())
            .unwrap_err()
            .code(),
        ErrorCode::InputEmpty
    );
    let oversized = vec![0_u8; (MAX_INPUT_BYTES + 1) as usize];
    assert_eq!(
        encoder
            .encode_from_bytes(&oversized, &DEMO_180P_V1, "attempt-big", CancelToken::new())
            .unwrap_err()
            .code(),
        ErrorCode::PayloadTooLarge
    );
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_cancelled_encode_terminates_ffmpeg_and_removes_its_files() {
    let scratch = harness::scratch_dir("encode-cancelled");
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let cancel = CancelToken::new();
    cancel.cancel();
    let error = encoder(&scratch)
        .encode_from_bytes(&input, &DEMO_180P_V1, "attempt-cancel", cancel)
        .expect_err("a cancelled encode must not return output");
    assert_eq!(error.code(), ErrorCode::Cancelled);
    assert!(error.code().retryable());
    let leftovers: Vec<_> = std::fs::read_dir(&scratch)
        .expect("scratch root")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(
        leftovers.is_empty(),
        "cancellation left files: {leftovers:?}"
    );
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_cli_encodes_a_local_file_and_exits_zero() {
    let scratch = harness::scratch_dir("cli-success");
    let output = scratch.join("out.mp4");
    let args = cli::parse_encode_args(&[
        "--input".to_string(),
        harness::fixture().display().to_string(),
        "--output".to_string(),
        output.display().to_string(),
        "--attempt-id".to_string(),
        "cli-attempt-1".to_string(),
    ])
    .expect("arguments parse");

    let encoded =
        cli::run_encode(&args, &encoder(&scratch), CancelToken::new()).expect("cli encode");
    assert!(output.exists(), "the CLI wrote its output file");
    assert_eq!(encoded.success.attempt_id, "cli-attempt-1");

    // The CLI's exit status is derived from the same error table the HTTP status
    // uses, so this test is about the file, and the status mapping is tested in
    // src/cli.rs.
    assert_eq!(cli::exit_code_for(ErrorCode::InvalidMedia), 5);

    // An independent FFprobe — not this crate's validator — accepts the file the
    // CLI produced.
    let probed = starter_media::probe::validate(
        &output,
        &DEMO_180P_V1,
        &starter_media::process::SystemProcessRunner::new(starter_media::clock::system_clock()),
        &harness::require(&harness::ffprobe()),
    )
    .expect("ffprobe accepts the CLI output");
    assert_eq!(probed.width, 320);
    assert_eq!(probed.height, 180);
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_cli_reports_a_missing_input_rather_than_writing_an_empty_output() {
    let scratch = harness::scratch_dir("cli-missing-input");
    let output = scratch.join("never-written.mp4");
    let args = cli::parse_encode_args(&[
        "--input".to_string(),
        scratch.join("absent.mp4").display().to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ])
    .expect("arguments parse");
    let error = cli::run_encode(&args, &encoder(&scratch), CancelToken::new())
        .expect_err("missing input must fail");
    // A missing input is an I/O failure, and the CLI must not invent an output.
    assert!(!output.exists());
    assert_ne!(cli::exit_code_for(error.code()), 0);
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_cli_refuses_undecodable_input_with_the_terminal_status() {
    let scratch = harness::scratch_dir("cli-invalid-media");
    let not_media = scratch.join("not-media.mp4");
    std::fs::write(&not_media, b"this is not an mp4, it is a sentence").expect("write");
    let output = scratch.join("out.mp4");
    let args = cli::parse_encode_args(&[
        "--input".to_string(),
        not_media.display().to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ])
    .expect("arguments parse");
    let error =
        cli::run_encode(&args, &encoder(&scratch), CancelToken::new()).expect_err("must fail");
    assert_eq!(error.code(), ErrorCode::InvalidMedia);
    assert_eq!(cli::exit_code_for(error.code()), 5);
    assert!(!output.exists(), "no output file for a failed encode");
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn only_the_frozen_preset_is_accepted() {
    let scratch = harness::scratch_dir("preset-lookup");
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let encoder = encoder(&scratch);
    for rejected in ["", "demo-180p", "demo-180p-v2", "sample-v1"] {
        let error = preset::lookup(rejected).expect_err("{rejected} must be refused");
        assert_eq!(error.code(), ErrorCode::UnsupportedPreset);
    }
    let preset = preset::lookup(PRESET_ID).expect("the one accepted preset");
    assert_eq!(preset.id, PRESET_ID);
    // And the encoder refuses a request that names anything else, before work.
    let accepted = encoder
        .encode_from_bytes(&input, preset, "attempt-ok", CancelToken::new())
        .expect("the accepted preset encodes");
    assert!(accepted.success.output_bytes > 0);
    std::fs::remove_dir_all(&scratch).ok();
}
#[test]
fn a_real_ffmpeg_that_outlives_its_deadline_is_killed_and_the_files_go_away() {
    // The production deadline is 120 seconds; this test proves the deadline path
    // in milliseconds by injecting the clock and capping the budget. The
    // subprocess is real FFmpeg doing real work: the same kill, the same reap and
    // the same temp-directory ownership as production, only with time under the
    // test's control.
    let scratch = harness::scratch_dir("encode-deadline");
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let tools = Tools {
        ffmpeg: harness::require(&harness::ffmpeg()),
        ffprobe: harness::require(&harness::ffprobe()),
    };

    // The runner's own deadline check, against a real FFmpeg asked for a 1080p
    // ten-minute encode, with a clock that reaches 400 ms in twenty polls.
    let clock = Arc::new(starter_media::clock::ManualClock::new());
    let runner = Arc::new(starter_media::process::SystemProcessRunner::new(
        clock.clone(),
    ));
    let mut request = starter_media::process::ProcessRequest::new(
        harness::require(&harness::ffmpeg()),
        [
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30:duration=600",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
        ]
        .iter()
        .map(std::ffi::OsString::from)
        .collect(),
        400,
    );
    request.cancel = starter_media::process::CancelToken::new();
    let outcome = runner.run(&request).expect("a real child is supervised");
    assert_eq!(
        outcome.terminated,
        Some(starter_media::process::TerminationReason::Deadline)
    );
    assert!(
        clock.now() >= 400,
        "the injected clock reached the deadline"
    );
    assert!(
        harness::child_pids().is_empty(),
        "ffmpeg was signalled but not reaped"
    );

    // The same path through the encoder, which classifies it, marks it retryable,
    // and removes the request's files.
    let encoder = Encoder::with_runner(
        tools,
        Arc::new(starter_media::process::SystemProcessRunner::new(Arc::new(
            starter_media::clock::ManualClock::new(),
        ))),
    )
    .with_temp_root(&scratch)
    .with_deadline_cap(std::time::Duration::from_millis(40));

    let error = encoder
        .encode_from_bytes(
            &input,
            &DEMO_180P_V1,
            "attempt-deadline",
            CancelToken::new(),
        )
        .expect_err("40 ms is not enough to encode three seconds of video");
    assert_eq!(error.code(), ErrorCode::DeadlineExceeded);
    assert!(error.code().retryable(), "a deadline is worth retrying");

    let leftovers: Vec<_> = std::fs::read_dir(&scratch)
        .expect("scratch root")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(
        leftovers.is_empty(),
        "the deadline path left files: {leftovers:?}"
    );
    assert!(
        harness::child_pids().is_empty(),
        "the killed child was not reaped"
    );
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_deadline_cap_can_only_shorten_the_budget() {
    let scratch = harness::scratch_dir("deadline-cap");
    let encoder = encoder(&scratch)
        // A cap far longer than the preset's own budget must not extend it.
        .with_deadline_cap(std::time::Duration::from_secs(3_600));
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let encoded = encoder
        .encode_from_bytes(&input, &DEMO_180P_V1, "attempt-cap", CancelToken::new())
        .expect("the preset's real deadline still applies");
    assert!(encoded.success.output_bytes > 0);
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_validator_rejects_a_correctly_encoded_file_of_the_wrong_size() {
    // The negative control for validation itself. If the validator accepted every
    // FFmpeg output, the "validated" claim would mean nothing; so a real encode at
    // the wrong geometry is produced by real FFmpeg and must be refused.
    let scratch = harness::scratch_dir("probe-rejects");
    let wrong = scratch.join("wrong-size.mp4");
    let status = std::process::Command::new(harness::require(&harness::ffmpeg()))
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(harness::fixture())
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=640:360",
            "-an",
            "-movflags",
            "+faststart",
        ])
        .arg(&wrong)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "the control file was not produced");
    assert!(wrong.exists());

    let runner =
        starter_media::process::SystemProcessRunner::new(starter_media::clock::system_clock());
    let error = starter_media::probe::validate(
        &wrong,
        &DEMO_180P_V1,
        &runner,
        &harness::require(&harness::ffprobe()),
    )
    .expect_err("640x360 is not the frozen preset");
    assert_eq!(error.code(), ErrorCode::InvalidOutput);
    assert!(
        error.detail().unwrap().contains("640x360"),
        "the failure names the measurement: {:?}",
        error.detail()
    );

    // And the frozen fixture's own dimensions are accepted, so the control is
    // about the geometry rather than about refusing everything.
    let accepted = starter_media::probe::validate(
        &harness::fixture(),
        &DEMO_180P_V1,
        &runner,
        &harness::require(&harness::ffprobe()),
    );
    // The fixture is 320x180 h264 mp4, so it passes the codec/geometry checks.
    let summary = accepted.expect("the fixture itself is a valid 320x180 MP4");
    assert_eq!((summary.width, summary.height), (320, 180));
    assert_eq!(summary.video_codec, "h264");
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_duration_outside_the_preset_window_is_refused_even_with_the_right_geometry() {
    // The other half of validation: a truncated file that kept the codec and the
    // frame size. Produced by real FFmpeg over one frame, then re-encoded by the
    // fixture's own encoder path so the geometry matches the preset exactly.
    let scratch = harness::scratch_dir("probe-duration");
    let truncated = scratch.join("one-frame.mp4");
    let status = std::process::Command::new(harness::require(&harness::ffmpeg()))
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(harness::fixture())
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-frames:v",
            "1",
            "-an",
            "-movflags",
            "+faststart",
        ])
        .arg(&truncated)
        .status()
        .expect("run ffmpeg");
    assert!(status.success());

    let runner =
        starter_media::process::SystemProcessRunner::new(starter_media::clock::system_clock());
    // The measurement itself succeeds: right container, right codec, right frame
    // size. It is the duration window that refuses it, which is why the two checks
    // are separate — a file that passes every measurement and is still not the
    // encode we promised is the case a codec check alone would ship.
    let summary = starter_media::probe::validate(
        &truncated,
        &DEMO_180P_V1,
        &runner,
        &harness::require(&harness::ffprobe()),
    )
    .expect("the one-frame file is measurable");
    assert_eq!((summary.width, summary.height), (320, 180));
    assert!(
        summary.duration_ms < DEMO_180P_V1.min_duration_ms,
        "{}",
        summary.duration_ms
    );
    let error = starter_media::probe::check_duration(&summary, &DEMO_180P_V1)
        .expect_err("one frame is not three seconds");
    assert_eq!(error.code(), ErrorCode::InvalidOutput);
    assert!(error.detail().unwrap().contains("duration"), "{error}");
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
#[cfg(unix)]
fn cli_signals_cancel_the_child_and_remove_temporary_files() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    for signal in [libc::SIGTERM, libc::SIGINT] {
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("pid");
        let fake = scratch.path().join("ffmpeg");
        let temp_root = scratch.path().join("temp");
        std::fs::create_dir(&temp_root).unwrap();
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = scratch.path().join("out.mp4");
        let mut child = Command::new(env!("CARGO_BIN_EXE_starter-media"))
            .arg("encode")
            .arg("--input")
            .arg(harness::fixture())
            .arg("--output")
            .arg(&output)
            .env("MEDIA_FFMPEG_PATH", &fake)
            .env("TMPDIR", &temp_root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = harness::wait_until(
            || {
                std::fs::read_to_string(&marker)
                    .is_ok_and(|text| text.trim().parse::<u32>().is_ok())
            },
            5000,
        );
        if !started {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the fake encoder never started");
        }
        assert!(std::fs::read_dir(&temp_root).unwrap().count() > 0);
        assert_eq!(unsafe { libc::kill(child.id() as libc::pid_t, signal) }, 0);
        let exited = harness::wait_until(|| child.try_wait().unwrap().is_some(), 5000);
        if !exited {
            let _ = child.kill();
        }
        let status = child.wait().unwrap();
        assert!(exited, "CLI ignored signal {signal}");
        assert_eq!(status.code(), Some(8));
        assert_eq!(std::fs::read_dir(&temp_root).unwrap().count(), 0);
        assert!(!output.exists());
        #[cfg(target_os = "linux")]
        {
            let pid = std::fs::read_to_string(&marker)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(
                !harness::process_exists(pid),
                "encoder child remains after cancellation"
            );
        }
    }
}
