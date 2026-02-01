use reqwest::Client;
use serde::Deserialize;

use super::llm::{preload_model, unload_model};

#[derive(Deserialize)]
struct Txt2ImgResponse {
    images: Vec<String>, // base64-encoded PNG strings
}

/// Full VRAM-optimized image generation pipeline:
/// Step A: Unload LLM from VRAM (keep_alive: 0)
/// Step B: 500ms safety delay for VRAM release
/// Step C: POST to SD Forge txt2img API
/// Step D: Parse base64 image result
/// Step E: Unload SD Forge checkpoint to free VRAM
/// Step F: 2s safety delay for OS/driver VRAM release
/// Finally: Reload LLM (preload_model) -- guaranteed unconditionally
#[tauri::command]
pub async fn generate_image(prompt: String) -> Result<String, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 min timeout for slow generation on RTX 3050
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // Step A: Unload LLM to free VRAM
    eprintln!("ImageGen: Unloading LLM to free VRAM...");
    if let Err(e) = unload_model().await {
        eprintln!("ImageGen: Warning - failed to unload model: {}", e);
        // Continue anyway; SD might still work if model was already unloaded
    }

    // Step B: Safety delay for VRAM release
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Step C: Call SD Forge txt2img
    eprintln!("ImageGen: Generating image with prompt: {}", &prompt[..prompt.len().min(100)]);
    let sd_result = client
        .post("http://127.0.0.1:7860/sdapi/v1/txt2img")
        .json(&serde_json::json!({
            "prompt": prompt,
            "steps": 20,
            "width": 512,
            "height": 512,
            "sampler_name": "DPM++ 2M Karras",
            "cfg_scale": 5,
            "override_settings": {
                "sd_model_checkpoint": "cyberrealistic_v90.safetensors"
            }
        }))
        .send()
        .await;

    // Step D: Parse result
    let image_result = match sd_result {
        Ok(response) if response.status().is_success() => {
            match response.json::<Txt2ImgResponse>().await {
                Ok(data) => data
                    .images
                    .into_iter()
                    .next()
                    .ok_or_else(|| "SD returned no images".to_string()),
                Err(e) => Err(format!("Failed to parse SD response: {}", e)),
            }
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            Err(format!(
                "SD API error {}: {}",
                status,
                &body[..body.len().min(200)]
            ))
        }
        Err(e) => Err(format!("SD request failed: {}", e)),
    };

    // Step E: Unload SD Forge checkpoint to free VRAM before reloading LLM
    eprintln!("ImageGen: Unloading SD checkpoint to free VRAM...");
    match client
        .post("http://127.0.0.1:7860/sdapi/v1/unload-checkpoint")
        .send()
        .await
    {
        Ok(resp) => eprintln!("ImageGen: SD unload response: {}", resp.status()),
        Err(e) => eprintln!("ImageGen: Warning - failed to unload SD checkpoint: {}", e),
    }

    // Step F: Safety delay — let OS/driver actually release the VRAM handle
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // ALWAYS reload LLM -- this is the guarantee
    eprintln!("ImageGen: Reloading LLM...");
    if let Err(e) = preload_model().await {
        eprintln!("ImageGen: Warning - failed to reload model: {}", e);
    }

    match &image_result {
        Ok(_) => eprintln!("ImageGen: Success"),
        Err(e) => eprintln!("ImageGen: Failed - {}", e),
    }

    image_result
}
