use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    pub ollama_url: String,
    pub selected_voice: String,
    pub models_path: String,
    pub selected_model: String,
    pub selected_lang: String,
}

fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Create directory if it doesn't exist
    fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data.join("settings.json"))
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let path = get_settings_path(&app)?;

    if !path.exists() {
        // Return default settings
        return Ok(Settings {
            ollama_url: "http://localhost:11434/v1".to_string(),
            selected_voice: "af_heart".to_string(),
            models_path: String::new(),
            selected_model: String::new(),
            selected_lang: "en-us".to_string(),
        });
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    serde_json::from_str(&content).or_else(|_| {
        // Old settings format — return defaults
        Ok(Settings {
            ollama_url: "http://localhost:11434/v1".to_string(),
            selected_voice: "af_heart".to_string(),
            models_path: String::new(),
            selected_model: String::new(),
            selected_lang: "en-us".to_string(),
        })
    })
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = get_settings_path(&app)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}
