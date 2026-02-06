//! Docker container lifecycle management for SearXNG

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const CONTAINER_NAME: &str = "lechat-searxng";
const SEARXNG_PORT: u16 = 8080;
const STARTUP_TIMEOUT_SECS: u64 = 30;
const DOCKER_STARTUP_TIMEOUT_SECS: u64 = 60; // Docker Desktop peut être lent à démarrer

/// Get path to docker-compose directory (not canonicalized to avoid Windows UNC issues)
/// On Windows, canonicalize() produces paths like \\?\D:\... which contain colons
/// that Docker misinterprets as volume mount separators.
fn get_compose_dir() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .parent()
        .ok_or("No parent directory")?
        .to_path_buf();

    // In dev: project_root/services/searxng/
    // In prod: exe_dir/../services/searxng/ (or bundled)
    let candidates = [
        exe_dir.join("../services/searxng"),
        exe_dir.join("../../services/searxng"),
        exe_dir.join("../../../services/searxng"),
        exe_dir.join("../../../../services/searxng"),
        PathBuf::from("services/searxng"),
    ];

    for path in &candidates {
        let compose_file = path.join("docker-compose.yml");
        if compose_file.exists() {
            // Return the directory, NOT canonicalized (avoids \\?\ prefix on Windows)
            return Ok(path.clone());
        }
    }

    Err(format!(
        "docker-compose.yml not found. Searched: {:?}",
        candidates
    ))
}

/// Ensure Docker Desktop is running, start it if not
pub async fn ensure_docker_running() -> Result<(), String> {
    // 1. Check if Docker is already running
    #[cfg(target_os = "windows")]
    let check = Command::new("docker")
        .args(["info"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    #[cfg(not(target_os = "windows"))]
    let check = Command::new("docker")
        .args(["info"])
        .output();

    if let Ok(output) = check {
        if output.status.success() {
            eprintln!("Docker: Already running");
            return Ok(());
        }
    }

    // 2. Docker not running - try to start Docker Desktop
    eprintln!("Docker: Not running, attempting to start Docker Desktop...");

    #[cfg(target_os = "windows")]
    {
        // Docker Desktop path on Windows
        let docker_desktop = format!(
            "{}\\Docker\\Docker\\Docker Desktop.exe",
            std::env::var("PROGRAMFILES").unwrap_or_default()
        );

        if !std::path::Path::new(&docker_desktop).exists() {
            return Err("Docker Desktop not found".to_string());
        }

        // Start Docker Desktop (window will appear briefly - Docker Desktop limitation)
        Command::new(&docker_desktop)
            .spawn()
            .map_err(|e| format!("Failed to start Docker Desktop: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On macOS/Linux, try to open Docker Desktop
        Command::new("open")
            .args(["-a", "Docker"])
            .spawn()
            .map_err(|e| format!("Failed to start Docker: {}", e))?;
    }

    // 3. Wait for Docker to be ready
    let deadline = std::time::Instant::now() + Duration::from_secs(DOCKER_STARTUP_TIMEOUT_SECS);

    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(2)).await;

        #[cfg(target_os = "windows")]
        let check = Command::new("docker")
            .args(["info"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        #[cfg(not(target_os = "windows"))]
        let check = Command::new("docker")
            .args(["info"])
            .output();

        if let Ok(output) = check {
            if output.status.success() {
                eprintln!("Docker: Started successfully");
                return Ok(());
            }
        }
    }

    Err(format!("Docker: Not ready after {}s", DOCKER_STARTUP_TIMEOUT_SECS))
}

/// Start SearXNG container (idempotent)
pub async fn start_searxng() -> Result<(), String> {
    // Ensure Docker is running first
    ensure_docker_running().await?;

    let compose_dir = get_compose_dir()?;

    eprintln!("SearXNG: Starting container from {:?}", compose_dir);

    // Run docker compose from the directory containing docker-compose.yml
    // This allows relative paths in volumes (./settings.yml) to work correctly
    #[cfg(target_os = "windows")]
    let output = Command::new("docker")
        .args(["compose", "up", "-d"])
        .current_dir(&compose_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run docker compose: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("docker")
        .args(["compose", "up", "-d"])
        .current_dir(&compose_dir)
        .output()
        .map_err(|e| format!("Failed to run docker compose: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker compose up failed: {}", stderr));
    }

    eprintln!("SearXNG: Container started, waiting for ready state...");

    // Wait for container to be healthy
    wait_for_searxng().await
}

/// Stop SearXNG container
pub async fn stop_searxng() -> Result<(), String> {
    eprintln!("SearXNG: Stopping container...");

    #[cfg(target_os = "windows")]
    let output = Command::new("docker")
        .args(["stop", CONTAINER_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to stop container: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("docker")
        .args(["stop", CONTAINER_NAME])
        .output()
        .map_err(|e| format!("Failed to stop container: {}", e))?;

    if output.status.success() {
        eprintln!("SearXNG: Container stopped");
        Ok(())
    } else {
        // Container might not exist, which is fine
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("SearXNG: Stop warning: {}", stderr);
        Ok(())
    }
}

/// Wait for SearXNG to be ready (health check)
async fn wait_for_searxng() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    // SearXNG doesn't have /healthz by default, use the main page
    let url = format!("http://localhost:{}/", SEARXNG_PORT);
    let deadline = std::time::Instant::now() + Duration::from_secs(STARTUP_TIMEOUT_SECS);

    while std::time::Instant::now() < deadline {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                eprintln!("SearXNG: Container ready");
                return Ok(());
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    Err(format!(
        "SearXNG: Container not ready after {}s",
        STARTUP_TIMEOUT_SECS
    ))
}

/// Check if SearXNG is running
#[allow(dead_code)]
pub async fn is_searxng_running() -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();

    if let Some(client) = client {
        let url = format!("http://localhost:{}/", SEARXNG_PORT);
        client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    } else {
        false
    }
}
