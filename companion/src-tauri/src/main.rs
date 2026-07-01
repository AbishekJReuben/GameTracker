// Prevents an extra console window on Windows in release; harmless on mobile.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gametracker_companion_lib::run()
}
