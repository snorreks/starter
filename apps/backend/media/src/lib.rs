//! `starter-media`: a bounded FFmpeg encode processor.
//!
//! A finite CLI that encodes local files and exits with a real status for a batch runner.
//!
//! Limits are enforced in code rather than described in a comment:
//!
//! | Bound | Enforced in |
//! |---|---|
//! | input and output bytes | [`encode`] |
//! | FFmpeg deadline | [`process`] poll loop, then kill and reap |
//! | FFprobe deadline | [`process`] poll loop |
//! | stderr retained | [`process`] reader thread |
//! | encoding threads | [`preset`] argv (`-threads 2`) |
//!
//! [`clock::Clock`], [`process::ProcessRunner`] and [`process::CancelToken`] are
//! the seams deadline and cancellation tests exercise against real child processes.

pub mod cli;
pub mod clock;
pub mod encode;
pub mod error;
pub mod fixture;
pub mod harness;
pub mod preset;
pub mod probe;
pub mod process;
pub mod protocol;

pub use error::{ErrorCode, ProcessorError, Result};

/// The release identity reported by `--version`.
///
/// `BUILD_GIT_REVISION` is stamped by the runner image build from the build context's
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


}
