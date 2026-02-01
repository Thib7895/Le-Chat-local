use std::sync::atomic::{AtomicU32, Ordering};
use serde::Deserialize;
use tokio::sync::Mutex;
use tauri::{command, AppHandle, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[derive(Deserialize)]
struct SynthesizeResponse {
    result: Option<SynthesizeResult>,
    error: Option<RpcError>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct SynthesizeResult {
    audio: String,
    format: String,
    sample_rate: u32,
}

#[derive(Deserialize)]
struct RpcError {
    code: i32,
    message: String,
}

/// Holds the persistent Python TTS process (child + event receiver)
struct TtsProcess {
    child: CommandChild,
    rx: tokio::sync::mpsc::Receiver<CommandEvent>,
}

/// Managed state wrapping the optional persistent process.
/// Registered via `.manage(TtsState::default())` in lib.rs.
pub struct TtsState {
    process: Mutex<Option<TtsProcess>>,
    request_id: AtomicU32,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            request_id: AtomicU32::new(1),
        }
    }
}

impl TtsState {
    /// Pre-spawn the Python process and pre-load the ONNX model at app startup.
    /// Errors are logged but not fatal — synthesize_speech will retry lazily.
    pub async fn ensure_started(&self, app: &AppHandle) {
        let mut guard = self.process.lock().await;
        if guard.is_none() {
            match spawn_python(app) {
                Ok(p) => {
                    *guard = Some(p);
                    eprintln!("TTS: Python process spawned at app launch");
                }
                Err(e) => {
                    eprintln!("TTS: Failed to pre-start Python: {}", e);
                    return;
                }
            }
        }

        // Pre-load the ONNX model so first TTS call is instant
        if let Some(process) = guard.as_mut() {
            let load_request = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "load_model",
                "params": {}
            });
            let request_json = serde_json::to_string(&load_request).unwrap();

            if let Err(e) = process.child.write((request_json + "\n").as_bytes()) {
                eprintln!("TTS: Failed to send load_model: {}", e);
                return;
            }

            // Wait for load_model response (consumes it from the receiver)
            while let Some(event) = process.rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let response = String::from_utf8_lossy(&line);
                        eprintln!("TTS: Model pre-loaded at app launch ({})",
                            if response.contains("\"success\":true") || response.contains("\"success\": true")
                            { "success" } else { "failed" });
                        break;
                    }
                    CommandEvent::Stderr(line) => {
                        eprintln!("Python stderr: {}", String::from_utf8_lossy(&line));
                        // Don't break — continue waiting for stdout response
                    }
                    CommandEvent::Terminated(_) => {
                        eprintln!("TTS: Python died during model load");
                        *guard = None;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Spawn a new Python TTS sidecar process.
fn spawn_python(app: &AppHandle) -> Result<TtsProcess, String> {
    let python_exe = "C:\\Users\\lemar\\anaconda3\\python.exe";
    let script_path = "D:\\Le Chat\\python-sidecar\\src\\sidecar_standalone.py";
    let models_path = "D:\\Le Chat\\assets\\models";

    // Force Python to use UTF-8 encoding on Windows (prevents cp1252 mangling accents)
    #[allow(deprecated)]
    unsafe {
        std::env::set_var("PYTHONUTF8", "1");
    }

    let cmd = app
        .shell()
        .command(python_exe)
        .args([script_path, models_path]);

    let (rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Python: {}", e))?;

    Ok(TtsProcess { child, rx })
}

/// Send a JSON-RPC request to the persistent Python process and read the response.
async fn send_request(
    request_id: u32,
    process: &mut TtsProcess,
    text: &str,
    lang: &str,
) -> Result<String, String> {
    // Build JSON-RPC request
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "synthesize",
        "params": { "text": text, "lang": lang }
    });
    let request_json = serde_json::to_string(&request).map_err(|e| e.to_string())?;

    // Write to stdin
    process.child
        .write((request_json + "\n").as_bytes())
        .map_err(|e| format!("Failed to write to Python: {}", e))?;

    // Read response from stdout (skip stderr lines)
    while let Some(event) = process.rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let response_line = String::from_utf8_lossy(&line).to_string();

                let response: SynthesizeResponse = serde_json::from_str(&response_line)
                    .map_err(|e| format!("Parse error: {} - Response: {}", e, response_line))?;

                if let Some(result) = response.result {
                    return Ok(result.audio);
                }
                if let Some(error) = response.error {
                    return Err(format!("TTS error ({}): {}", error.code, error.message));
                }
                return Err("Invalid TTS response".to_string());
            }
            CommandEvent::Stderr(line) => {
                eprintln!("Python stderr: {}", String::from_utf8_lossy(&line));
            }
            CommandEvent::Error(err) => {
                return Err(format!("Python error: {}", err));
            }
            CommandEvent::Terminated(_) => {
                return Err("Python process terminated unexpectedly".to_string());
            }
            _ => {}
        }
    }

    Err("No response from Python TTS".to_string())
}

#[command]
pub async fn synthesize_speech(
    app: AppHandle,
    state: State<'_, TtsState>,
    text: String,
    lang: String,
    _models_path: String,
) -> Result<String, String> {
    let mut guard = state.process.lock().await;

    // Spawn process if not running yet (lazy init)
    if guard.is_none() {
        *guard = Some(spawn_python(&app)?);
    }

    let id = state.request_id.fetch_add(1, Ordering::Relaxed);

    // Try to send request on the existing process
    let result = {
        let process = guard.as_mut().unwrap();
        send_request(id, process, &text, &lang).await
    };

    match result {
        Ok(audio) => Ok(audio),
        Err(e) => {
            eprintln!("TTS request failed ({}), respawning process...", e);

            // Kill old process
            if let Some(old) = guard.take() {
                let _ = old.child.kill();
            }

            // Respawn
            *guard = Some(spawn_python(&app)?);

            // Retry once
            let id2 = state.request_id.fetch_add(1, Ordering::Relaxed);
            let process = guard.as_mut().unwrap();
            send_request(id2, process, &text, &lang).await
        }
    }
}
