//! The wire contract, pinned by golden files.
//!
//! These fixtures are the shared contract with the TypeScript side (PR F/H):
//! `packages/shared/schemas` types its job DTOs and its encode call against
//! these exact documents, so a rename in Rust fails here instead of in a
//! Durable Object at runtime.
//!
//! Two directions are checked, because a fixture that only one side can produce
//! is a fixture that documents a bug:
//!
//! * the golden file deserializes into this crate's types with no unknown fields,
//!   and every value equals the constant the code enforces;
//! * this crate's own serialization of a value with those values is byte-equal to
//!   the golden file.
//!
//! Regenerate deliberately with `cargo run --example generate_goldens`, and read
//! the diff. A fixture that changed because a number changed is a protocol change
//! that both sides must make together.

use std::path::PathBuf;

use starter_media::error::{ErrorCode, ProcessorError};
use starter_media::preset::DEMO_180P_V1;
use starter_media::protocol::{
    EncodeSuccessDocument, ErrorDocument, HealthDocument, Limits, MAX_INPUT_BYTES,
    MAX_OUTPUT_BYTES, PRESET_ID, PROTOCOL_ID,
};

fn golden(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("protocol")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Deserialize with a check that no field is unknown — a TypeScript client that
/// sends an extra field, or a Rust field removed from the struct, both fail here.
fn parse_strict<T: serde::de::DeserializeOwned + serde::Serialize>(name: &str) -> T {
    let text = golden(name);
    let value: serde_json::Value = serde_json::from_str(&text).expect("golden is valid JSON");
    let document = serde_json::from_value::<T>(value.clone()).unwrap_or_else(|error| {
        panic!("{name} does not match this crate's types: {error}; document: {value}")
    });
    assert_eq!(
        serde_json::to_value(&document).expect("serialize document"),
        value,
        "{name} contains fields not preserved by this crate's types"
    );
    document
}

#[test]
fn the_health_document_matches_its_golden_and_the_code_that_enforces_those_limits() {
    let document: HealthDocument = parse_strict("health.v1.json");
    assert_eq!(document.protocol, PROTOCOL_ID);
    assert_eq!(document.fixture, "sample-v1");
    assert_eq!(document.presets.len(), 1);
    assert_eq!(document.presets[0].id, PRESET_ID);
    assert_eq!(document.presets[0].width, DEMO_180P_V1.width);
    assert_eq!(document.presets[0].height, DEMO_180P_V1.height);
    assert_eq!(document.limits.max_input_bytes, MAX_INPUT_BYTES);
    assert_eq!(document.limits.max_output_bytes, MAX_OUTPUT_BYTES);
    assert_eq!(document.limits.encode_deadline_ms, 120_000);
    assert_eq!(document.limits.max_encode_threads, 2);
    assert_eq!(document.limits.max_concurrent_encodes, 1);
    assert_eq!(document.limits, Limits::CURRENT);

    // And the other direction: what this build serves is what the golden says,
    // once the release identity — which is per build — is normalised.
    let mut served = starter_media::health_document("RELEASE", &DEMO_180P_V1);
    served.release = "RELEASE".to_string();
    let rendered = serde_json::to_string_pretty(&served).expect("serializes") + "\n";
    assert_eq!(rendered, golden("health.v1.json"));
}

#[test]
fn the_success_document_matches_its_golden() {
    let document: EncodeSuccessDocument = parse_strict("encode-success.v1.json");
    assert_eq!(document.protocol, PROTOCOL_ID);
    assert_eq!(document.preset, PRESET_ID);
    assert_eq!(document.attempt_id, "attempt-1");
    assert_eq!(document.probe.video_codec, "h264");
    assert_eq!((document.probe.width, document.probe.height), (320, 180));
    assert_eq!(document.probe.duration_ms, 3_000);
    // A SHA-256 is 64 lowercase hex characters; a client that trusts this field
    // for integrity needs it to be one or the other, never 63.
    assert_eq!(document.output_sha256.len(), 64);
    assert!(document
        .output_sha256
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

    let rendered = serde_json::to_string_pretty(&document).expect("serializes") + "\n";
    assert_eq!(rendered, golden("encode-success.v1.json"));
}

#[test]
fn every_error_body_matches_its_golden_and_carries_no_subprocess_output() {
    let cases: Vec<(&str, ErrorCode, bool)> = vec![
        (
            "error-unsupported-preset.v1.json",
            ErrorCode::UnsupportedPreset,
            false,
        ),
        (
            "error-payload-too-large.v1.json",
            ErrorCode::PayloadTooLarge,
            false,
        ),
        (
            "error-invalid-media.v1.json",
            ErrorCode::InvalidMedia,
            false,
        ),
        ("error-busy.v1.json", ErrorCode::Busy, true),
    ];
    for (name, code, retryable) in cases {
        let document: ErrorDocument = parse_strict(name);
        assert_eq!(document.error.code, code.wire(), "{name}");
        assert_eq!(document.error.retryable, retryable, "{name}");
        assert_eq!(document.error.message, code.public_message(), "{name}");

        // The same failure, carrying the operator-facing detail it really had.
        let with_detail = ProcessorError::new(code)
            .with_detail("ffmpeg: /tmp/encode-abc/input.bin - Invalid data found");
        let rendered = serde_json::to_string_pretty(&starter_media::error_document(&with_detail))
            .expect("serializes")
            + "\n";
        assert_eq!(
            rendered,
            golden(name),
            "{name} changed when a detail was attached"
        );
    }
}

#[test]
fn the_status_and_retry_table_is_the_one_the_goldens_imply() {
    // A client that only reads `code` and `retryable` must be able to decide
    // correctly, so the two fields and the HTTP status are asserted together.
    let expectations = [
        (ErrorCode::UnsupportedPreset, 400_u16, false),
        (ErrorCode::PayloadTooLarge, 400, false),
        (ErrorCode::InvalidMedia, 400, false),
        (ErrorCode::Busy, 429, true),
        (ErrorCode::DeadlineExceeded, 503, true),
        (ErrorCode::Cancelled, 503, true),
        (ErrorCode::NotFound, 404, false),
        (ErrorCode::Internal, 500, true),
    ];
    for (code, status, retryable) in expectations {
        assert_eq!(code.http_status(), status, "{}", code.wire());
        assert_eq!(code.retryable(), retryable, "{}", code.wire());
    }
}
