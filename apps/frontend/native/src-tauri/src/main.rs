// apps/frontend/native/src-tauri/src/main.rs
//
// Desktop entry point. Kept to three lines on purpose: everything lives in the
// library so that the mobile targets, which link the library rather than a
// binary, run exactly the same code.
//
// `windows_subsystem = "windows"` only in release: a Windows debug build keeps its
// console, because that is where a panicking shell says why. A release build has
// no console. A startup failure in `lib.rs` panics via `expect`; the default
// panic hook writes to stderr, which may be invisible in a Windows release.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    starter_lib::run()
}
