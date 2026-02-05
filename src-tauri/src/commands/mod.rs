mod database;
mod image_gen;
mod llm;
mod settings;
mod stt;
mod tts;

pub use database::{
    create_conversation, db_init, delete_conversation, generate_conversation_title,
    get_conversation_messages, list_conversations, save_message, update_conversation_title,
    update_message_content, Conversation, DatabaseState, DbMessage,
};
pub use image_gen::generate_image;
pub use llm::{check_ollama_connection, ensure_ollama_running, list_ollama_models, preload_model, send_message, unload_model};
pub use settings::{get_settings, save_settings, Settings};
pub use stt::{stt_transcribe, SttState};
pub use tts::{synthesize_speech, TtsState};
