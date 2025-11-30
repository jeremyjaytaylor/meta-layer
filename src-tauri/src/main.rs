#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // CHANGE THIS LINE from meta_layer_lib::run() to:
    meta_layer::run();
}