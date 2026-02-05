use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Default model used when settings.selected_model is empty
pub const DEFAULT_MODEL: &str = "ministral-3:3b-instruct-2512-q4_K_M";

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    max_tokens: Option<i32>,
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: DeltaContent,
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct DeltaContent {
    content: Option<String>,
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    url: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let client = Client::new();

    let request = ChatRequest {
        model,
        messages,
        stream: true,
        max_tokens: Some(2048),
        temperature: Some(0.7),
        stop: None,
    };

    let response = client
        .post(format!("{}/chat/completions", url))
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("API error: {}", response.status()));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];

                if data == "[DONE]" {
                    app.emit("llm-done", ())
                        .map_err(|e| format!("Emit error: {}", e))?;
                    return Ok(());
                }

                if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                    if let Some(choice) = chunk.choices.first() {
                        if let Some(content) = &choice.delta.content {
                            app.emit("llm-token", content.clone())
                                .map_err(|e| format!("Emit error: {}", e))?;
                        }
                    }
                }
            }
        }
    }

    app.emit("llm-done", ())
        .map_err(|e| format!("Emit error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn check_ollama_connection(url: String) -> Result<bool, String> {
    let client = Client::new();
    let models_url = format!("{}/models", url);

    match client.get(&models_url).send().await {
        Ok(response) => Ok(response.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn ensure_ollama_running() -> Result<bool, String> {
    let client = Client::new();

    // 1. Ping Ollama
    if let Ok(resp) = client.get("http://localhost:11434/v1/models").send().await {
        if resp.status().is_success() {
            eprintln!("Ollama: Already running");
            return Ok(true);
        }
    }

    // 2. Ollama not running — try to start it
    eprintln!("Ollama: Not running, attempting to start...");

    let ollama_path = format!(
        "{}\\Programs\\Ollama\\ollama.exe",
        std::env::var("LOCALAPPDATA").unwrap_or_default()
    );

    if !std::path::Path::new(&ollama_path).exists() {
        return Err("Ollama not found. Install from https://ollama.com".to_string());
    }

    // Launch "ollama serve" in background (detached)
    std::process::Command::new(&ollama_path)
        .arg("serve")
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;

    // 3. Wait for it to be ready (poll every 500ms, max 15s)
    for i in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(resp) = client.get("http://localhost:11434/v1/models").send().await {
            if resp.status().is_success() {
                eprintln!("Ollama: Started successfully (took ~{}ms)", (i + 1) * 500);
                return Ok(true);
            }
        }
    }

    Err("Ollama started but not responding after 15s".to_string())
}

/// Pre-load model into VRAM/RAM at startup via native Ollama API
#[tauri::command]
pub async fn preload_model(model: String) -> Result<(), String> {
    let model_name = if model.is_empty() { DEFAULT_MODEL.to_string() } else { model };
    let client = Client::new();
    eprintln!("Ollama: Pre-loading model {}...", model_name);

    let resp = client
        .post("http://localhost:11434/api/generate")
        .json(&serde_json::json!({
            "model": model_name,
            "keep_alive": -1,
            "prompt": ""
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to preload model: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to preload: HTTP {}", resp.status()));
    }

    // Consume the streaming response body (Ollama sends {"done":true})
    let _ = resp.text().await;
    eprintln!("Ollama: Model {} pre-loaded into memory", model_name);
    Ok(())
}

/// Unload model from memory on app close
#[tauri::command]
pub async fn unload_model(model: String) -> Result<(), String> {
    let model_name = if model.is_empty() { DEFAULT_MODEL.to_string() } else { model };
    let client = Client::new();
    eprintln!("Ollama: Unloading model {}...", model_name);

    let resp = client
        .post("http://localhost:11434/api/generate")
        .json(&serde_json::json!({
            "model": model_name,
            "keep_alive": 0,
            "prompt": ""
        }))
        .send()
        .await;

    if let Ok(r) = resp {
        let _ = r.text().await; // consume body
    }
    eprintln!("Ollama: Model {} unloaded", model_name);
    Ok(())
}

#[tauri::command]
pub async fn list_ollama_models(url: String) -> Result<Vec<String>, String> {
    let client = Client::new();
    let resp = client
        .get(format!("{}/models", url))
        .send()
        .await
        .map_err(|e| format!("Failed to list models: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse models: {}", e))?;

    let models = body["data"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(models)
}
