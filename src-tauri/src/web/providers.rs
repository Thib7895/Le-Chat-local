//! SearXNG search provider (self-hosted)

use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use super::evidence::{extract_domain, is_blocked_domain, RawSearchResult};

const SEARXNG_URL: &str = "http://localhost:8080/search";
const USER_AGENT: &str = "Le Chat Local/1.0";

/// SearXNG JSON response structure
#[derive(Debug, Deserialize)]
struct SearxngResponse {
    results: Vec<SearxngResult>,
}

#[derive(Debug, Deserialize)]
struct SearxngResult {
    title: String,
    url: String,
    content: Option<String>,
}

/// Search via local SearXNG instance
pub async fn search_searxng(
    client: &Client,
    query: &str,
    max_results: usize,
) -> Vec<RawSearchResult> {
    let url = format!(
        "{}?q={}&format=json&categories=general",
        SEARXNG_URL,
        urlencoding::encode(query)
    );

    eprintln!("SearXNG: Searching '{}'", query);

    let response = match client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("SearXNG: Request failed: {}", e);
            return vec![];
        }
    };

    if !response.status().is_success() {
        eprintln!("SearXNG: HTTP {}", response.status());
        return vec![];
    }

    let searxng_resp: SearxngResponse = match response.json().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("SearXNG: Failed to parse JSON: {}", e);
            return vec![];
        }
    };

    eprintln!("SearXNG: Got {} results", searxng_resp.results.len());

    searxng_resp
        .results
        .into_iter()
        .filter_map(|r| {
            let domain = extract_domain(&r.url);
            if is_blocked_domain(&domain) {
                return None;
            }
            Some(RawSearchResult {
                title: r.title,
                url: r.url,
                snippet: r.content.unwrap_or_default(),
                domain,
            })
        })
        .take(max_results)
        .collect()
}

/// Search multiple queries with deduplication and cancellation support
pub async fn search_multiple_queries(
    client: &Client,
    queries: &[String],
    max_per_query: usize,
    token: &CancellationToken,
) -> Result<Vec<RawSearchResult>, String> {
    let mut all_results = Vec::new();
    let mut seen_urls: HashSet<String> = HashSet::new();
    let mut domain_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

    for query in queries {
        // Check for cancellation before each query
        if token.is_cancelled() {
            eprintln!("SearXNG: Search cancelled");
            return Err("Search cancelled".to_string());
        }

        if query.trim().is_empty() {
            continue;
        }

        let results = search_searxng(client, query, max_per_query).await;

        for result in results {
            // Normalize URL for deduplication
            let normalized = normalize_url(&result.url);
            if seen_urls.contains(&normalized) {
                continue;
            }

            // Limit 2 results per domain for diversity
            let count = domain_counts.entry(result.domain.clone()).or_insert(0);
            if *count >= 2 {
                continue;
            }

            seen_urls.insert(normalized);
            *count += 1;
            all_results.push(result);
        }

        // Small delay between queries (also check cancellation)
        tokio::select! {
            _ = token.cancelled() => {
                eprintln!("SearXNG: Search cancelled during delay");
                return Err("Search cancelled".to_string());
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }

    eprintln!(
        "SearXNG: Total {} unique results from {} queries",
        all_results.len(),
        queries.len()
    );

    Ok(all_results)
}

/// Normalize URL for deduplication
fn normalize_url(url: &str) -> String {
    url.split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_url() {
        assert_eq!(
            normalize_url("https://example.com/page/"),
            "https://example.com/page"
        );
        assert_eq!(
            normalize_url("https://example.com/page#section"),
            "https://example.com/page"
        );
        assert_eq!(
            normalize_url("https://example.com/page?q=test"),
            "https://example.com/page"
        );
    }
}
