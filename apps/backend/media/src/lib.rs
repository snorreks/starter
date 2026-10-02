//! `starter-media`: a bounded FFmpeg encode processor.
//!
//! One encoding core ([`encode`]), two entrypoints that share it:
//!
//! * [`http`] — the internal HTTP server a Cloudflare Container runs.
//! * [`cli`] — a finite command that encodes local files and exits with a real
//!   status, for a batch runner (a Cloud Run Job, a cron container, an
//!   operator's laptop).
//!
//! Everything a limit exists for is a constant in [`protocol`] or a `const` in
//! [`preset`], and every limit is checked in code. The words "bounded" in this
//! crate's documentation are claims about code paths, not aspirations:
//!
//! | Bound | Enforced in |
//! |---|---|
//! | request head, 16 KiB | [`http::read_head`] |
//! | request body, 5 MiB | [`http::read_body`], before buffering |
//! | output, 10 MiB | [`encode`], before validation |
//! | FFmpeg deadline, 120 s | [`process`] poll loop, then kill and reap |
//! | FFprobe deadline, 20 s | [`process`] poll loop |
//! | stderr, 8 KiB kept | [`process`] reader thread |
//! | encoding threads, 2 | [`preset`] argv (`-threads 2`) |
//! | concurrent encodes, 1 | [`http`] encode slot |
//!
//! # Testing seams
//!
//! [`clock::Clock`], [`process::ProcessRunner`] and [`process::CancelToken`] are
//! the seams the deadline and cancellation tests use, against real child
//! processes. They are public because a seam a test cannot reach is not a seam.

pub mod cli;
pub mod clock;
pub mod encode;
pub mod error;
pub mod fixture;
pub mod harness;
pub mod http;
pub mod preset;
pub mod probe;
pub mod process;
pub mod protocol;

pub use error::{ErrorCode, ProcessorError, Result};

/// The release identity reported by `/health` and by `--version`.
///
/// `BUILD_GIT_REVISION` is stamped by the Docker build from the build context's
/// revision. A local `cargo build` has no such value, and claiming a revision the
/// binary does not know is the kind of small untruth that later gets copied into
/// a deployment record — so the local build says `unversioned` instead.
pub const RELEASE: &str = concat!(env!("CARGO_PKG_VERSION"), "+unversioned");

/// The release string when the build stamped a revision, else [`RELEASE`].
pub fn release_identity() -> String {
    match option_env!("BUILD_GIT_REVISION") {
        Some(revision) if !revision.is_empty() => {
            format!("{}+{revision}", env!("CARGO_PKG_VERSION"))
        }
        _ => RELEASE.to_string(),
    }
}

/// The `/health` document for this build.
pub fn health_document(release: &str, preset: &preset::Preset) -> protocol::HealthDocument {
    protocol::HealthDocument {
        release: release.to_string(),
        protocol: protocol::PROTOCOL_ID.to_string(),
        presets: vec![preset.summary()],
        fixture: protocol::FIXTURE_ID.to_string(),
        limits: protocol::Limits::CURRENT,
    }
}

/// The error body for a failure. Assembled from fixed fields only, so an
/// operator-facing detail cannot reach the wire.
pub fn error_document(error: &ProcessorError) -> protocol::ErrorDocument {
    let code = error.code();
    protocol::ErrorDocument {
        error: protocol::ErrorDetail {
            code: code.wire().to_string(),
            message: code.public_message().to_string(),
            retryable: code.retryable(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_is_a_real_value_not_an_empty_string() {
        let release = release_identity();
        assert!(release.starts_with(env!("CARGO_PKG_VERSION")), "{release}");
        assert!(release.contains('+'));
        assert!(!release.ends_with('+'), "{release}");
        // A local build has no stamped revision and must not imply one.
        assert_eq!(RELEASE, concat!(env!("CARGO_PKG_VERSION"), "+unversioned"));
    }

    #[test]
    fn health_and_error_documents_are_produced_from_the_typed_values() {
        let health = health_document("rev-test", &preset::DEMO_180P_V1);
        let json = serde_json::to_string(&health).expect("serializes");
        assert!(json.contains("\"protocol\":\"sample-v1\""), "{json}");
        assert!(json.contains("\"max_input_bytes\":5242880"), "{json}");
        assert!(json.contains("\"max_output_bytes\":10485760"), "{json}");

        let document = error_document(&ProcessorError::new(ErrorCode::Busy));
        assert_eq!(document.error.code, "busy");
        assert!(document.error.retryable);
    }
}
