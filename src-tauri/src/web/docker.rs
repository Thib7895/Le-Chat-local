//! Docker container lifecycle management for SearXNG

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const CONTAINER_NAME: &str = "lechat-searxng";
const SEARXNG_PORT: u16 = 8080;
const STARTUP_TIMEOUT_SECS: u64 = 30;

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

/// Start SearXNG container (idempotent)
pub async fn start_searxng() -> Result<(), String> {
    let compose_dir = get_compose_dir()?;

    eprintln!("SearXNG: Starting container from {:?}", compose_dir);

    // Run docker compose from the directory containing docker-compose.yml
    // This allows relative paths in volumes (./settings.yml) to work correctly
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
