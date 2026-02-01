use std::sync::atomic::{AtomicU32, Ordering};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tauri::{command, AppHandle, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[derive(Deserialize)]
struct SttResponse {
    result: Option<SttResponseResult>,
    error: Option<RpcError>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SttResponseResult {
    text: String,
    language: String,
}

#[derive(Deserialize)]
struct RpcError {
    code: i32,
    message: String,
}

/// Holds the persistent Python STT process (child + event receiver)
struct SttProcess {
    child: CommandChild,
    rx: tokio::sync::mpsc::Receiver<CommandEvent>,
}

/// Managed state wrapping the optional persistent STT process.
/// Registered via `.manage(SttState::default())` in lib.rs.
pub struct SttState {
    process: Mutex<Option<SttProcess>>,
    request_id: AtomicU32,
}

impl Default for SttState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            request_id: AtomicU32::new(1),
        }
    }
}

impl SttState {
    /// Pre-spawn the Python STT process and pre-load the model at app startup.
    /// Errors are logged but not fatal — stt_transcribe will retry lazily.
    pub async fn ensure_started(&self, app: &AppHandle) {
        let mut guard = self.process.lock().await;
        if guard.is_none() {
            match spawn_python(app) {
                Ok(p) => {
                    *guard = Some(p);
                    eprintln!("STT: Python process spawned at app launch");
                }
                Err(e) => {
                    eprintln!("STT: Failed to pre-start Python: {}", e);
                    return;
                }
            }
        }

        // Pre-load the faster-whisper model so first transcription is fast
        if let Some(process) = guard.as_mut() {
            let load_request = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "load_model",
                "params": {}
            });
            let request_json = serde_json::to_string(&load_request).unwrap();

            if let Err(e) = process.child.write((request_json + "\n").as_bytes()) {
                eprintln!("STT: Failed to send load_model: {}", e);
                return;
            }

            // Wait for load_model response
            while let Some(event) = process.rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let response = String::from_utf8_lossy(&line);
                        eprintln!("STT: Model pre-loaded at app launch ({})",
                            if response.contains("\"success\":true") || response.contains("\"success\": true")
                            { "success" } else { "failed" });
                        break;
                    }
                    CommandEvent::Stderr(line) => {
                        eprintln!("STT Python stderr: {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Terminated(_) => {
                        eprintln!("STT: Python died during model load");
                        *guard = None;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Spawn a new Python STT sidecar process.
fn spawn_python(app: &AppHandle) -> Result<SttProcess, String> {
    let python_exe = "C:\\Users\\lemar\\anaconda3\\envs\\sst-env\\python.exe";
    let script_path = "D:\\Le Chat\\python-sidecar\\src\\stt_sidecar.py";

    // Force Python to use UTF-8 encoding on Windows
    #[allow(deprecated)]
    unsafe {
        std::env::set_var("PYTHONUTF8", "1");
    }

    let cmd = app
        .shell()
        .command(python_exe)
        .args([script_path]);

    let (rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn STT Python: {}", e))?;

    Ok(SttProcess { child, rx })
}

/// Send a JSON-RPC request to the persistent Python STT process and read the response.
async fn send_request(
    request_id: u32,
    process: &mut SttProcess,
    audio_base64: &str,
    lang: &Option<String>,
) -> Result<SttResponseResult, String> {
    // Build JSON-RPC request
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "transcribe",
        "params": {
            "audio_base64": audio_base64,
            "lang": lang,
        }
    });
    let request_json = serde_json::to_string(&request).map_err(|e| e.to_string())?;

    // Write to stdin
    process.child
        .write((request_json + "\n").as_bytes())
        .map_err(|e| format!("Failed to write to STT Python: {}", e))?;

    // Read response from stdout (skip stderr lines)
    while let Some(event) = process.rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let response_line = String::from_utf8_lossy(&line).to_string();

                let response: SttResponse = serde_json::from_str(&response_line)
                    .map_err(|e| format!("STT parse error: {} - Response: {}", e, response_line))?;

                if let Some(result) = response.result {
                    return Ok(result);
                }
                if let Some(error) = response.error {
                    return Err(format!("STT error ({}): {}", error.code, error.message));
                }
                return Err("Invalid STT response".to_string());
            }
            CommandEvent::Stderr(line) => {
                eprintln!("STT Python stderr: {}", String::from_utf8_lossy(&line));
            }
            CommandEvent::Error(err) => {
                return Err(format!("STT Python error: {}", err));
            }
            CommandEvent::Terminated(_) => {
                return Err("STT Python process terminated unexpectedly".to_string());
            }
            _ => {}
        }
    }

    Err("No response from STT Python".to_string())
}

#[command]
pub async fn stt_transcribe(
    app: AppHandle,
    state: State<'_, SttState>,
    audio_base64: String,
    lang: Option<String>,
) -> Result<SttResponseResult, String> {
    let mut guard = state.process.lock().await;

    // Spawn process if not running yet (lazy init)
    if guard.is_none() {
        *guard = Some(spawn_python(&app)?);
    }

    let id = state.request_id.fetch_add(1, Ordering::Relaxed);

    // Try to send request on the existing process
    let result = {
        let process = guard.as_mut().unwrap();
        send_request(id, process, &audio_base64, &lang).await
    };

    match result {
        Ok(text) => Ok(text),
        Err(e) => {
            eprintln!("STT request failed ({}), respawning process...", e);

            // Kill old process
            if let Some(old) = guard.take() {
                let _ = old.child.kill();
            }

            // Respawn
            *guard = Some(spawn_python(&app)?);

            // Retry once
            let id2 = state.request_id.fetch_add(1, Ordering::Relaxed);
            let process = guard.as_mut().unwrap();
            send_request(id2, process, &audio_base64, &lang).await
        }
    }
}
