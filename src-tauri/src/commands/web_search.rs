use reqwest::Client;
use scraper::{Html, Selector};
use std::time::Duration;

/// Search DuckDuckGo HTML-only endpoint and return the top 3 results as formatted text.
/// On any error (timeout, offline, parse failure), returns an empty string — never panics.
#[tauri::command]
pub async fn search_web(query: String) -> Result<String, String> {
    eprintln!("WebSearch: Searching for '{}'", query);

    let client = match Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("WebSearch: Failed to build HTTP client: {}", e);
            return Ok(String::new());
        }
    };

    let response = match client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", &query)])
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            eprintln!("WebSearch: HTTP error {}", r.status());
            return Ok(String::new());
        }
        Err(e) => {
            eprintln!("WebSearch: Request failed: {}", e);
            return Ok(String::new());
        }
    };

    let html_text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("WebSearch: Failed to read response body: {}", e);
            return Ok(String::new());
        }
    };

    let document = Html::parse_document(&html_text);

    // DuckDuckGo HTML-only page selectors
    let result_sel = Selector::parse(".result").unwrap();
    let title_sel = Selector::parse(".result__a").unwrap();
    let snippet_sel = Selector::parse(".result__snippet").unwrap();

    let mut output = String::new();
    let mut count = 0;

    for result in document.select(&result_sel) {
        if count >= 3 {
            break;
        }

        let title = result
            .select(&title_sel)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default();

        let snippet = result
            .select(&snippet_sel)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default();

        if !title.is_empty() {
            output.push_str(&format!(
                "{}. {}\n{}\n\n",
                count + 1,
                title.trim(),
                snippet.trim()
            ));
            count += 1;
        }
    }

    eprintln!("WebSearch: Found {} results", count);
    Ok(output)
}
