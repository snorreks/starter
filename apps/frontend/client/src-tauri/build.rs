// apps/frontend/client/src-tauri/build.rs
//
// Tauri's build step. It embeds the frontend's build configuration and, in a
// release build, fails if the frontend was not built first — which is the failure
// someone hits when they run `cargo build --release` on a fresh clone and get a
// confusing "frontendDist does not exist" instead of "run bun run build".

fn main() {
    tauri_build::build()
}
