mod image_gen;
mod llm;
mod settings;
mod stt;
mod tts;
mod web_search;

pub use image_gen::generate_image;
pub use llm::{check_ollama_connection, ensure_ollama_running, list_ollama_models, preload_model, send_message, unload_model};
pub use settings::{get_settings, save_settings};
pub use stt::{stt_transcribe, SttState};
pub use tts::{synthesize_speech, TtsState};
pub use web_search::search_web;
