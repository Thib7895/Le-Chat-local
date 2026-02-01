mod commands;

use tauri::Manager;
use commands::{
    check_ollama_connection, ensure_ollama_running, generate_image, get_settings,
    list_ollama_models, preload_model, save_settings, search_web, send_message,
    stt_transcribe, synthesize_speech, unload_model, SttState, TtsState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .manage(TtsState::default())
        .manage(SttState::default())
        .setup(|app| {
            // Logging is handled by env_logger in main.rs (with tao/wry filters)

            // Pre-spawn TTS Python process in background (non-blocking)
            let tts_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = tts_handle.state::<TtsState>();
                state.ensure_started(&tts_handle).await;
            });

            // Pre-spawn STT Python process in background (non-blocking)
            let stt_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = stt_handle.state::<SttState>();
                state.ensure_started(&stt_handle).await;
            });

            // Ensure Ollama is running, then pre-load model
            tauri::async_runtime::spawn(async move {
                match ensure_ollama_running().await {
                    Ok(true) => {
                        eprintln!("Ollama: Ready");
                        // Pre-load the model into memory
                        match preload_model().await {
                            Ok(()) => eprintln!("Ollama: Model ready"),
                            Err(e) => eprintln!("Ollama: Failed to preload model: {}", e),
                        }
                    }
                    Ok(false) => eprintln!("Ollama: Not available"),
                    Err(e) => eprintln!("Ollama: {}", e),
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            check_ollama_connection,
            ensure_ollama_running,
            list_ollama_models,
            preload_model,
            unload_model,
            get_settings,
            save_settings,
            synthesize_speech,
            stt_transcribe,
            generate_image,
            search_web
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Unload model from memory before exit (runtime still alive here)
            eprintln!("App: Shutting down, unloading Ollama model...");
            tauri::async_runtime::block_on(async {
                let _ = unload_model().await;
            });
        }
    });
}
