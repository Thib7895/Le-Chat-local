//! RAG Web Search Pipeline v2
//!
//! A hybrid Retrieve-Read-Rank pipeline for grounded web search:
//! 1. Retrieve: Search multiple queries via SearXNG (self-hosted)
//! 2. Read: Fetch and extract main content from top URLs
//! 3. Rank: Score results using lexical + semantic + bonuses

mod docker;
mod evidence;
mod fetch;
mod providers;
mod rank;

pub use docker::{start_searxng, stop_searxng};
pub use evidence::SearchEvidencePack;

use crate::SearchCancellationState;
use reqwest::Client;
use std::time::{Duration, Instant};

use evidence::RawSearchResult;
use fetch::fetch_pages;
use providers::search_multiple_queries;
use rank::{CpuRanker, RankConfig};

/// Configuration for the search pipeline
struct PipelineConfig {
    max_results_per_query: usize, // Max results from each search query
    max_urls_to_fetch: usize,     // Max URLs to actually fetch content from
    top_k_final: usize,           // Final number of sources to return
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            max_results_per_query: 20,
            max_urls_to_fetch: 10,
            top_k_final: 5,
        }
    }
}

/// Cancel an ongoing search by session ID
#[tauri::command]
pub async fn cancel_search(
    session_id: String,
    state: tauri::State<'_, SearchCancellationState>,
) -> Result<(), String> {
    state.cancel(&session_id);
    Ok(())
}

/// Main search command for the RAG pipeline
/// Takes multiple query variants and returns a structured evidence pack
#[tauri::command]
pub async fn search_web_v2(
    queries: Vec<String>,
    session_id: String,
    state: tauri::State<'_, SearchCancellationState>,
) -> Result<SearchEvidencePack, String> {
    let start = Instant::now();
    let config = PipelineConfig::default();
    let queries: Vec<String> = queries
        .into_iter()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .collect();

    // Create cancellation token for this search session
    let token = state.create_token(&session_id);

    eprintln!(
        "WebSearchV2: Starting session {} with {} queries",
        session_id,
        queries.len()
    );

    if queries.is_empty() {
        state.cleanup(&session_id);
        return Ok(SearchEvidencePack {
            sources: vec![],
            context_summary: "Aucune requête fournie.".to_string(),
            query_used: queries,
            total_results_found: 0,
            total_pages_fetched: 0,
            processing_time_ms: 0,
        });
    }

    // Build HTTP client
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| {
            state.cleanup(&session_id);
            format!("Failed to build HTTP client: {}", e)
        })?;

    // ========== PHASE 1: RETRIEVE ==========
    eprintln!("WebSearchV2: Phase 1 - Retrieve");
    let raw_results =
        match search_multiple_queries(&client, &queries, config.max_results_per_query, &token)
            .await
        {
            Ok(results) => results,
            Err(e) => {
                state.cleanup(&session_id);
                return Err(e);
            }
        };

    // Checkpoint 1: Check if cancelled after retrieve phase
    if token.is_cancelled() {
        state.cleanup(&session_id);
        return Err("Search cancelled".to_string());
    }

    if raw_results.is_empty() {
        state.cleanup(&session_id);
        return Ok(SearchEvidencePack {
            sources: vec![],
            context_summary: "Aucun résultat trouvé pour ces recherches.".to_string(),
            query_used: queries,
            total_results_found: 0,
            total_pages_fetched: 0,
            processing_time_ms: start.elapsed().as_millis() as u64,
        });
    }

    let total_results_found = raw_results.len();
    eprintln!("WebSearchV2: Found {} raw results", total_results_found);

    // ========== PHASE 2: PRE-FILTER & READ ==========
    eprintln!("WebSearchV2: Phase 2 - Pre-filter and Read");

    // Create ranker with combined query
    let combined_query = queries.join(" ");
    let ranker = CpuRanker::new(&combined_query, RankConfig::default());

    // Pre-rank to select best URLs for fetching
    let ranked_indices = ranker.rank_raw_results(&raw_results);
    let top_urls: Vec<&RawSearchResult> = ranked_indices
        .iter()
        .take(config.max_urls_to_fetch)
        .map(|(idx, _)| &raw_results[*idx])
        .collect();

    eprintln!(
        "WebSearchV2: Selected {} URLs for content fetch",
        top_urls.len()
    );

    // Fetch content from selected URLs (with cancellation support)
    let fetched_pages = fetch_pages(
        &client,
        &top_urls.iter().map(|r| (*r).clone()).collect::<Vec<_>>(),
        config.max_urls_to_fetch,
        &token,
    )
    .await;

    // Checkpoint 2: Check if cancelled after fetch phase
    if token.is_cancelled() {
        state.cleanup(&session_id);
        return Err("Search cancelled".to_string());
    }

    let total_pages_fetched = fetched_pages.len();
    eprintln!("WebSearchV2: Fetched {} pages", total_pages_fetched);

    // ========== PHASE 3: RANK ==========
    eprintln!("WebSearchV2: Phase 3 - Rank");

    // Final ranking with full content
    let sources = ranker.rank_pages(&raw_results, &fetched_pages, config.top_k_final);

    // Build context summary
    let context_summary = SearchEvidencePack::build_context_summary(&sources);

    let processing_time_ms = start.elapsed().as_millis() as u64;

    // Cleanup the cancellation token
    state.cleanup(&session_id);

    eprintln!(
        "WebSearchV2: Complete - {} sources in {}ms",
        sources.len(),
        processing_time_ms
    );

    Ok(SearchEvidencePack {
        sources,
        context_summary,
        query_used: queries,
        total_results_found,
        total_pages_fetched,
        processing_time_ms,
    })
}

/// Legacy search command - kept for backwards compatibility
#[tauri::command]
pub async fn search_web(
    query: String,
    state: tauri::State<'_, SearchCancellationState>,
) -> Result<String, String> {
    eprintln!("WebSearch: Legacy search for '{}'", query);

    // Use the new pipeline with a single query and a temporary session ID
    let session_id = format!("legacy-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let result = search_web_v2(vec![query], session_id, state).await?;

    // Format as the old string format for backwards compatibility
    if result.sources.is_empty() {
        return Ok(String::new());
    }

    let mut output = String::new();
    for source in &result.sources {
        output.push_str(&format!(
            "[{}] {} - {}\n{}\n\n",
            source.id, source.url, source.title, source.snippet
        ));
    }

    Ok(output)
}
