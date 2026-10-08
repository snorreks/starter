//! Golden test for the finite CLI result consumed by the Cloud Run runner.
use std::path::PathBuf;

use starter_media::protocol::{EncodeSuccessDocument, PRESET_ID, PROTOCOL_ID};

#[test]
fn the_cli_result_document_matches_its_golden() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("protocol")
        .join("encode-success.v1.json");
    let golden = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let value: serde_json::Value = serde_json::from_str(&golden).expect("valid golden JSON");
    let document: EncodeSuccessDocument = serde_json::from_value(value.clone()).expect("typed result");
    assert_eq!(serde_json::to_value(&document).expect("serializes"), value);
    assert_eq!(document.protocol, PROTOCOL_ID);
    assert_eq!(document.preset, PRESET_ID);
    assert_eq!(document.attempt_id, "attempt-1");
    assert_eq!(document.probe.video_codec, "h264");
    assert_eq!((document.probe.width, document.probe.height), (320, 180));
    assert_eq!(document.probe.duration_ms, 3_000);
    assert_eq!(document.output_sha256.len(), 64);
    assert!(document.output_sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
}
