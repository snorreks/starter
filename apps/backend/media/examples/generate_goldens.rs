// Writes the golden protocol fixtures. Run deliberately:
//   cargo run --example generate_goldens
use starter_media::preset::DEMO_180P_V1;
use starter_media::protocol::{EncodeSuccessDocument, ProbeSummary};
fn main() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/protocol");
    std::fs::create_dir_all(&dir).unwrap();
    let success = EncodeSuccessDocument {
        protocol: "sample-v1".into(),
        preset: "demo-180p-v1".into(),
        attempt_id: "attempt-1".into(),
        output_bytes: 12345,
        output_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        probe: ProbeSummary {
            container_format: "mov,mp4,m4a,3gp,3g2,mj2".into(),
            video_codec: "h264".into(),
            width: 320,
            height: 180,
            duration_ms: 3000,
            video_streams: 1,
            audio_streams: 1,
        },
    };
    std::fs::write(
        dir.join("encode-success.v1.json"),
        serde_json::to_string_pretty(&success).unwrap() + "\n",
    )
    .unwrap();
}
