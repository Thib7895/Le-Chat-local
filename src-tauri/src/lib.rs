mod commands;
mod web;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

use commands::{
    check_ollama_connection, create_conversation, db_init, delete_conversation,
    ensure_ollama_running, generate_conversation_title, generate_image,
    get_conversation_messages, get_settings, list_conversations, list_ollama_models,
    preload_model, save_message, save_settings, send_message, stt_transcribe,
    synthesize_speech, unload_model, update_conversation_title, update_message_content,
    DatabaseState, Settings, SttState, TtsState,
};
use web::{cancel_search, search_web, search_web_v2, start_searxng, stop_searxng};

/// State for managing search cancellation tokens
/// Each search session has a unique ID and associated CancellationToken
pub struct SearchCancellationState {
    pub tokens: Mutex<HashMap<String, CancellationToken>>,
}

impl SearchCancellationState {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a new cancellation token for a search session
    pub fn create_token(&self, session_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.tokens
            .lock()
            .unwrap()
            .insert(session_id.to_string(), token.clone());
        token
    }

    /// Cancel a search session by its ID
    pub fn cancel(&self, session_id: &str) -> bool {
        if let Some(token) = self.tokens.lock().unwrap().remove(session_id) {
            token.cancel();
            eprintln!("SearchCancellation: Cancelled session {}", session_id);
            true
        } else {
            false
        }
    }

    /// Clean up a completed search session
    pub fn cleanup(&self, session_id: &str) {
        self.tokens.lock().unwrap().remove(session_id);
    }
}

impl Default for SearchCancellationState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .manage(TtsState::default())
        .manage(SttState::default())
        .manage(SearchCancellationState::new())
        .manage(DatabaseState::default())
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

            // Ensure Ollama is running, then pre-load model from settings
            let ollama_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Load settings to get the selected model
                let settings = get_settings(ollama_handle)
                    .await
                    .unwrap_or_else(|_| Settings::default());

                match ensure_ollama_running().await {
                    Ok(true) => {
                        eprintln!("Ollama: Ready");
                        // Pre-load the model from settings into memory
                        let model = settings.selected_model;
                        match preload_model(model.clone()).await {
                            Ok(()) => eprintln!("Ollama: Model ready"),
                            Err(e) => eprintln!("Ollama: Failed to preload model: {}", e),
                        }
                    }
                    Ok(false) => eprintln!("Ollama: Not available"),
                    Err(e) => eprintln!("Ollama: {}", e),
                }
            });

            // Start SearXNG Docker container for web search
            tauri::async_runtime::spawn(async move {
                match start_searxng().await {
                    Ok(()) => eprintln!("SearXNG: Ready"),
                    Err(e) => eprintln!("SearXNG: Failed to start: {}", e),
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
            search_web,
            search_web_v2,
            cancel_search,
            // Database commands
            db_init,
            list_conversations,
            get_conversation_messages,
            create_conversation,
            save_message,
            update_message_content,
            update_conversation_title,
            delete_conversation,
            generate_conversation_title
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            eprintln!("App: Shutting down...");
            let handle = app_handle.clone();
            tauri::async_runtime::block_on(async {
                // Unload Ollama model from memory
                let model = get_settings(handle)
                    .await
                    .map(|s| s.selected_model)
                    .unwrap_or_default();
                let _ = unload_model(model).await;

                // Stop SearXNG Docker container
                let _ = stop_searxng().await;
            });
        }
    });
}
