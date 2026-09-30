// apps/frontend/client/src-tauri/src/main.rs
//
// Desktop entry point. Kept to three lines on purpose: everything lives in the
// library so that the mobile targets, which link the library rather than a
// binary, run exactly the same code.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    starter_lib::run()
}
