// apps/frontend/native/src-tauri/build.rs
//
// Tauri's build step. It embeds the frontend's build configuration and, in a
// release build, fails if the frontend was not built first — which is the failure
// someone hits when they run `cargo build --release` on a fresh clone and get a
// confusing "frontendDist does not exist" instead of "run bun run native:build".
//
// `tauri_build::build()` also validates `tauri.conf.json` against the pinned
// schema and `capabilities/default.json` against the plugins registered in
// `src/lib.rs`. That is why `cargo check` is a real check of the capability set
// and not only of the Rust.

fn main() {
    tauri_build::build()
}
