use std::process::Child;
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, State};

const SD_FORGE_DIR: &str = r"D:\sd-webui-forge-classic";
const SD_FORGE_BAT: &str = "webui-user.bat";
const SD_FORGE_API_URL: &str = "http://127.0.0.1:7860";
const STARTUP_TIMEOUT_SECS: u64 = 120;
const POLL_INTERVAL_SECS: u64 = 3;

/// SD Forge process state management
pub struct SdForgeState {
    process: Mutex<Option<Child>>,
    is_ready: Mutex<bool>,
}

impl Default for SdForgeState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            is_ready: Mutex::new(false),
        }
    }
}

impl SdForgeState {
    /// Start SD Forge and wait for API to be ready
    /// Called AFTER Ollama model preload completes to avoid VRAM conflicts
    pub async fn start_and_wait(&self, app: &AppHandle) -> Result<(), String> {
        eprintln!("SD Forge: Starting from {}...", SD_FORGE_DIR);

        // Check if directory exists
        if !std::path::Path::new(SD_FORGE_DIR).exists() {
            let err = format!("SD Forge directory not found: {}", SD_FORGE_DIR);
            eprintln!("SD Forge: {}", err);
            app.emit("sd-forge-error", &err).ok();
            return Err(err);
        }

        // Spawn the webui-user.bat process in its directory
        // The bat file uses Conda, so we need to run it properly with cmd /C and call
        #[cfg(target_os = "windows")]
        let child = {
            use std::os::windows::process::CommandExt;
            use std::process::Stdio;

            // CREATE_NEW_PROCESS_GROUP so we can kill the tree later
            // CREATE_NO_WINDOW to hide the console
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

            // Use "call" to properly execute the batch file with its conda activation
            std::process::Command::new("cmd")
                .args(["/C", "call", SD_FORGE_BAT])
                .current_dir(SD_FORGE_DIR)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
                .spawn()
                .map_err(|e| format!("Failed to start SD Forge: {}", e))?
        };

        #[cfg(not(target_os = "windows"))]
        let child = {
            std::process::Command::new("bash")
                .arg(SD_FORGE_BAT)
                .current_dir(SD_FORGE_DIR)
                .spawn()
                .map_err(|e| format!("Failed to start SD Forge: {}", e))?
        };

        eprintln!("SD Forge: Process spawned (PID: {:?})", child.id());
        *self.process.lock().unwrap() = Some(child);

        // Wait for API to respond
        let client = reqwest::Client::new();
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(STARTUP_TIMEOUT_SECS);

        eprintln!("SD Forge: Waiting for API at {} (max {}s)...", SD_FORGE_API_URL, STARTUP_TIMEOUT_SECS);

        let mut attempt = 0;
        while start.elapsed() < timeout {
            attempt += 1;
            let url = format!("{}/sdapi/v1/sd-models", SD_FORGE_API_URL);

            match client
                .get(&url)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
            {
                Ok(resp) => {
                    if resp.status().is_success() {
                        *self.is_ready.lock().unwrap() = true;
                        app.emit("sd-forge-ready", ()).ok();
                        eprintln!("SD Forge: API ready (took {:.1}s, {} attempts)", start.elapsed().as_secs_f32(), attempt);
                        return Ok(());
                    } else {
                        eprintln!("SD Forge: API returned status {} (attempt {})", resp.status(), attempt);
                    }
                }
                Err(e) => {
                    if attempt % 5 == 1 {
                        // Log every 5 attempts to avoid spam
                        eprintln!("SD Forge: Waiting... ({:.0}s elapsed)", start.elapsed().as_secs_f32());
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }

        let err = format!("API not ready after {}s timeout", STARTUP_TIMEOUT_SECS);
        eprintln!("SD Forge: {}", err);
        app.emit("sd-forge-error", &err).ok();
        Err(err)
    }

    /// Check if SD Forge is ready
    pub fn is_ready(&self) -> bool {
        *self.is_ready.lock().unwrap()
    }

    /// Stop SD Forge process on app exit
    pub fn stop(&self) {
        if let Some(child) = self.process.lock().unwrap().take() {
            let pid = child.id();
            eprintln!("SD Forge: Stopping process tree (PID: {})...", pid);

            // On Windows, use taskkill to kill the entire process tree
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;

                let result = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();

                match result {
                    Ok(output) => {
                        if output.status.success() {
                            eprintln!("SD Forge: Process tree terminated");
                        } else {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            eprintln!("SD Forge: taskkill warning: {}", stderr.trim());
                        }
                    }
                    Err(e) => eprintln!("SD Forge: Failed to run taskkill: {}", e),
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                // On Unix, try to kill the process group
                let _ = std::process::Command::new("kill")
                    .args(["-9", &format!("-{}", pid)])
                    .output();
                eprintln!("SD Forge: Process terminated");
            }
        }
        *self.is_ready.lock().unwrap() = false;
    }
}

/// Tauri command to check if SD Forge is ready
#[command]
pub fn is_sd_forge_ready(state: State<SdForgeState>) -> bool {
    state.is_ready()
}
