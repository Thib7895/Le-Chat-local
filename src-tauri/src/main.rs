// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Configure logging: suppress noisy tao/wry warnings, keep everything else at Info
    env_logger::Builder::from_default_env()
        .filter_module("tao", log::LevelFilter::Error)
        .filter_module("wry", log::LevelFilter::Error)
        .filter_level(log::LevelFilter::Info)
        .init();

    app_lib::run();
}
