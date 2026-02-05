//! HTML fetching and content extraction

use reqwest::Client;
use scraper::{Html, Selector};
use std::net::{IpAddr, ToSocketAddrs};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::evidence::{FetchedPage, RawSearchResult};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Check if URL is safe (not targeting local/private networks)
/// Protects against SSRF attacks via malicious SERP results
fn is_safe_url(url_str: &str) -> bool {
    let url = match url::Url::parse(url_str) {
        Ok(u) => u,
        Err(_) => return false,
    };

    // Only allow http/https
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }

    let host = match url.host_str() {
        Some(h) => h,
        None => return false,
    };

    // Block localhost variants
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }

    // Try to resolve hostname and check IP
    let port = url.port().unwrap_or(if url.scheme() == "https" { 443 } else { 80 });
    let addr_str = format!("{}:{}", host, port);

    if let Ok(addrs) = addr_str.to_socket_addrs() {
        for addr in addrs {
            if !is_public_ip(addr.ip()) {
                return false;
            }
        }
    }

    true
}

/// Check if IP address is publicly routable
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            // Reject private/reserved ranges
            !ipv4.is_loopback()           // 127.0.0.0/8
                && !ipv4.is_private()     // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
                && !ipv4.is_link_local()  // 169.254.0.0/16
                && !ipv4.is_broadcast()
                && !ipv4.is_unspecified()
                // Also block 0.0.0.0/8
                && ipv4.octets()[0] != 0
        }
        IpAddr::V6(ipv6) => {
            !ipv6.is_loopback()           // ::1
                && !ipv6.is_unspecified() // ::
                // Link-local fe80::/10 (manual check since is_unicast_link_local is unstable)
                && !(ipv6.segments()[0] & 0xffc0 == 0xfe80)
        }
    }
}

/// Fetch a single page and extract its main content
pub async fn fetch_page(client: &Client, result: &RawSearchResult) -> Option<FetchedPage> {
    // SSRF protection: block local/private URLs
    if !is_safe_url(&result.url) {
        eprintln!("Fetch: Blocked unsafe URL (SSRF protection): {}", result.url);
        return None;
    }

    let start = Instant::now();

    let response = match client
        .get(&result.url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7")
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            eprintln!("Fetch: HTTP {} for {}", r.status(), result.url);
            return None;
        }
        Err(e) => {
            eprintln!("Fetch: Failed for {}: {}", result.url, e);
            return None;
        }
    };

    // Check content type
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") {
        eprintln!("Fetch: Skipping non-HTML content at {}", result.url);
        return None;
    }

    let html_text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Fetch: Failed to read body from {}: {}", result.url, e);
            return None;
        }
    };

    let fetch_time_ms = start.elapsed().as_millis() as u64;

    // Extract main content
    let (title, content) = extract_main_content(&html_text);

    // Use result title if extraction failed
    let title = if title.is_empty() {
        result.title.clone()
    } else {
        title
    };

    // Skip if content is too short (probably a paywall or error page)
    if content.len() < 200 {
        eprintln!(
            "Fetch: Content too short ({} chars) for {}",
            content.len(),
            result.url
        );
        return None;
    }

    Some(FetchedPage {
        url: result.url.clone(),
        title,
        content,
        fetch_time_ms,
    })
}

/// Fetch multiple pages with cancellation support
/// Uses tokio::select! to allow immediate cancellation during fetch
pub async fn fetch_pages(
    client: &Client,
    results: &[RawSearchResult],
    max_pages: usize,
    token: &CancellationToken,
) -> Vec<FetchedPage> {
    let to_fetch: Vec<_> = results.iter().take(max_pages).collect();
    let mut fetched = Vec::new();

    for result in to_fetch.iter() {
        // Use select to allow cancellation during fetch
        tokio::select! {
            _ = token.cancelled() => {
                eprintln!("Fetch: Cancelled");
                break;
            }
            page = fetch_page(client, result) => {
                if let Some(p) = page {
                    fetched.push(p);
                }
            }
        }
    }

    eprintln!(
        "Fetch: Successfully fetched {} of {} pages",
        fetched.len(),
        to_fetch.len()
    );

    fetched
}

/// Extract main content from HTML using simple heuristics
/// (Simplified version of readability algorithm)
fn extract_main_content(html: &str) -> (String, String) {
    let document = Html::parse_document(html);

    // Extract title
    let title = extract_title(&document);

    // Remove script and style tags content
    let content = extract_article_text(&document);

    (title, content)
}

/// Extract page title
fn extract_title(document: &Html) -> String {
    // Try og:title first
    if let Some(og_title) = document
        .select(&Selector::parse("meta[property='og:title']").unwrap())
        .next()
        .and_then(|el| el.value().attr("content"))
    {
        return og_title.trim().to_string();
    }

    // Fall back to <title>
    if let Some(title_el) = document
        .select(&Selector::parse("title").unwrap())
        .next()
    {
        return title_el.text().collect::<String>().trim().to_string();
    }

    String::new()
}

/// Extract main article text using common article selectors
fn extract_article_text(document: &Html) -> String {
    // Priority order for content extraction
    let content_selectors = [
        "article",
        "main",
        "[role='main']",
        ".article-content",
        ".post-content",
        ".entry-content",
        ".content",
        "#content",
        ".article-body",
        ".story-body",
    ];

    for selector_str in content_selectors {
        if let Ok(selector) = Selector::parse(selector_str) {
            if let Some(element) = document.select(&selector).next() {
                let text = extract_text_recursive(element);
                if text.len() > 500 {
                    return clean_text(&text);
                }
            }
        }
    }

    // Fallback: extract from body, excluding nav/header/footer
    if let Some(body) = document.select(&Selector::parse("body").unwrap()).next() {
        let text = extract_text_recursive(body);
        return clean_text(&text);
    }

    String::new()
}

/// Recursively extract text, skipping script/style/nav elements
fn extract_text_recursive(element: scraper::ElementRef) -> String {
    let mut text = String::new();

    for node in element.children() {
        if let Some(element_ref) = scraper::ElementRef::wrap(node) {
            let tag_name = element_ref.value().name();

            // Skip unwanted elements
            if matches!(
                tag_name,
                "script" | "style" | "nav" | "header" | "footer" | "aside" | "noscript" | "iframe"
            ) {
                continue;
            }

            // Skip elements with certain classes
            let class = element_ref.value().attr("class").unwrap_or("");
            if class.contains("nav")
                || class.contains("menu")
                || class.contains("sidebar")
                || class.contains("footer")
                || class.contains("header")
                || class.contains("ad")
                || class.contains("social")
                || class.contains("share")
                || class.contains("comment")
            {
                continue;
            }

            text.push_str(&extract_text_recursive(element_ref));

            // Add paragraph breaks after block elements
            if matches!(tag_name, "p" | "div" | "h1" | "h2" | "h3" | "h4" | "li" | "br") {
                text.push('\n');
            }
        } else if let Some(text_node) = node.value().as_text() {
            text.push_str(text_node.trim());
            text.push(' ');
        }
    }

    text
}

/// Clean extracted text
fn clean_text(text: &str) -> String {
    // Normalize whitespace
    let cleaned: String = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    // Remove excessive newlines
    let mut result = String::new();
    let mut prev_newline = false;

    for c in cleaned.chars() {
        if c == '\n' {
            if !prev_newline {
                result.push(c);
            }
            prev_newline = true;
        } else {
            result.push(c);
            prev_newline = false;
        }
    }

    // Truncate to reasonable length for LLM context (UTF-8 safe)
    if result.len() > 8000 {
        truncate_utf8_safe(&mut result, 8000);
        if let Some(last_period) = result.rfind('.') {
            result.truncate(last_period + 1);
        }
    }

    result
}

/// Truncate a string at a valid UTF-8 character boundary.
fn truncate_utf8_safe(s: &mut String, max_len: usize) {
    if s.len() <= max_len {
        return;
    }

    let mut new_len = max_len;
    while new_len > 0 && !s.is_char_boundary(new_len) {
        new_len -= 1;
    }
    s.truncate(new_len);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_text() {
        let dirty = "  Hello   \n\n\n  World  \n\n  Test  ";
        let clean = clean_text(dirty);
        assert!(!clean.contains("\n\n\n"));
    }
}
