//! Data structures for the RAG web search pipeline.

use serde::{Deserialize, Serialize};

/// A raw search result from a provider (DuckDuckGo, etc.)
#[derive(Debug, Clone)]
pub struct RawSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub domain: String,
}

/// A fetched and cleaned web page
#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub url: String,
    pub title: String,
    pub content: String, // Main article text extracted via readability
    pub fetch_time_ms: u64,
}

/// A ranked web source with scoring breakdown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSource {
    pub id: u32,
    pub title: String,
    pub url: String,
    pub domain: String,
    pub snippet: String,
    pub content_preview: String, // First ~500 chars of main content
    pub score: f32,
    pub score_breakdown: ScoreBreakdown,
}

/// Detailed scoring breakdown for transparency
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreBreakdown {
    pub semantic_score: f32,  // Cosine similarity (0-1)
    pub lexical_score: f32,   // Keyword matching (0-1)
    pub freshness_bonus: f32, // Date recency bonus (0-0.1)
    pub trust_bonus: f32,     // Trusted domain bonus (0-0.1)
}

/// The final evidence pack returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchEvidencePack {
    pub sources: Vec<WebSource>,
    pub context_summary: String, // Formatted text for LLM grounding
    pub query_used: Vec<String>, // The queries that were searched
    pub total_results_found: usize,
    pub total_pages_fetched: usize,
    pub processing_time_ms: u64,
}

impl SearchEvidencePack {
    /// Build the context summary string for LLM grounding
    pub fn build_context_summary(sources: &[WebSource]) -> String {
        if sources.is_empty() {
            return "Aucune source fiable trouvée pour cette recherche.".to_string();
        }

        let mut summary = String::new();

        for source in sources {
            summary.push_str(&format!(
                "[{}] {} ({})\n{}\n\n",
                source.id,
                source.title,
                source.domain,
                if source.content_preview.is_empty() {
                    &source.snippet
                } else {
                    &source.content_preview
                }
            ));
        }

        summary
    }
}

/// Trusted domains that get a ranking bonus
pub const TRUSTED_DOMAINS: &[&str] = &[
    // News & Media (FR)
    "lemonde.fr",
    "lefigaro.fr",
    "liberation.fr",
    "france24.com",
    "rfi.fr",
    "francetvinfo.fr",
    "bfmtv.com",
    "leparisien.fr",
    "nouvelobs.com",
    "lexpress.fr",
    "lepoint.fr",
    "20minutes.fr",
    "ouest-france.fr",
    // News & Media (International)
    "bbc.com",
    "bbc.co.uk",
    "reuters.com",
    "apnews.com",
    "theguardian.com",
    "nytimes.com",
    "washingtonpost.com",
    // Reference & Knowledge
    "wikipedia.org",
    "britannica.com",
    "larousse.fr",
    // Government & Official
    "gouv.fr",
    "service-public.fr",
    "europa.eu",
    "who.int",
    "un.org",
    // Tech & Science
    "nature.com",
    "sciencedirect.com",
    "arxiv.org",
    "github.com",
    "stackoverflow.com",
    "developer.mozilla.org",
    "docs.rs",
    // Weather
    "meteofrance.com",
    "weather.com",
    "accuweather.com",
];

/// Domains to deprioritize or skip
pub const BLOCKED_DOMAINS: &[&str] = &[
    "pinterest.com",
    "pinterest.fr",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "linkedin.com",
    "quora.com",
    "reddit.com", // Often paywalled or low-quality for factual queries
];

/// Check if a domain is trusted (strict suffix matching)
/// Uses ends_with to prevent spoofing (e.g., evil-reuters.com won't match reuters.com)
pub fn is_trusted_domain(domain: &str) -> bool {
    let domain_lower = domain.to_lowercase();
    TRUSTED_DOMAINS.iter().any(|&trusted| {
        domain_lower == trusted || domain_lower.ends_with(&format!(".{}", trusted))
    })
}

/// Check if a domain should be blocked (strict suffix matching)
/// Uses ends_with to prevent spoofing
pub fn is_blocked_domain(domain: &str) -> bool {
    let domain_lower = domain.to_lowercase();
    BLOCKED_DOMAINS.iter().any(|&blocked| {
        domain_lower == blocked || domain_lower.ends_with(&format!(".{}", blocked))
    })
}

/// Extract domain from URL
pub fn extract_domain(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default()
}
