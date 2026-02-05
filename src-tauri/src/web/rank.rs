//! CPU-based ranking engine using hybrid scoring.
//! Combines semantic similarity (via fastembed) + lexical matching + bonuses.

use chrono::Datelike;
use std::collections::HashSet;

use super::evidence::{
    is_trusted_domain, FetchedPage, RawSearchResult, ScoreBreakdown, WebSource,
};

/// Configuration for the ranking engine
pub struct RankConfig {
    pub semantic_weight: f32,  // Weight for semantic similarity (0-1)
    pub lexical_weight: f32,   // Weight for keyword matching (0-1)
    pub freshness_bonus: f32,  // Max bonus for recent content
    pub trust_bonus: f32,      // Bonus for trusted domains
    pub content_preview_len: usize, // Characters for content preview
}

impl Default for RankConfig {
    fn default() -> Self {
        Self {
            semantic_weight: 0.4,
            lexical_weight: 0.4,
            freshness_bonus: 0.1,
            trust_bonus: 0.1,
            content_preview_len: 500,
        }
    }
}

/// Simple CPU-based ranker (without fastembed for now)
/// Uses TF-IDF-like lexical scoring as the primary method
pub struct CpuRanker {
    config: RankConfig,
    query_terms: Vec<String>,
}

impl CpuRanker {
    /// Create a new ranker with the given query
    pub fn new(query: &str, config: RankConfig) -> Self {
        let query_terms = tokenize(query);
        Self {
            config,
            query_terms,
        }
    }

    /// Rank raw results (before fetching) for initial filtering
    pub fn rank_raw_results(&self, results: &[RawSearchResult]) -> Vec<(usize, f32)> {
        let mut scores: Vec<(usize, f32)> = results
            .iter()
            .enumerate()
            .map(|(idx, result)| {
                let text = format!("{} {}", result.title, result.snippet);
                let lexical = self.compute_lexical_score(&text);
                let trust = if is_trusted_domain(&result.domain) {
                    self.config.trust_bonus
                } else {
                    0.0
                };
                (idx, lexical + trust)
            })
            .collect();

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scores
    }

    /// Rank fetched pages with full content
    /// ONLY includes results that were successfully fetched (guarantees content_preview is non-empty)
    pub fn rank_pages(
        &self,
        results: &[RawSearchResult],
        pages: &[FetchedPage],
        top_k: usize,
    ) -> Vec<WebSource> {
        let mut scored: Vec<(RawSearchResult, &FetchedPage, f32, ScoreBreakdown)> = Vec::new();

        for result in results {
            // ONLY score results that were successfully fetched
            if let Some(page) = pages.iter().find(|p| p.url == result.url) {
                let (score, breakdown) = self.compute_full_score(result, Some(page));
                scored.push((result.clone(), page, score, breakdown));
            }
        }

        // Sort by score descending
        scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

        // Take top K and convert to WebSource
        scored
            .into_iter()
            .take(top_k)
            .enumerate()
            .map(|(idx, (result, page, score, breakdown))| {
                let content_preview = {
                    let preview: String = page
                        .content
                        .chars()
                        .take(self.config.content_preview_len)
                        .collect();
                    // Cut at sentence boundary if possible
                    if let Some(last_period) = preview.rfind('.') {
                        preview[..=last_period].to_string()
                    } else {
                        preview
                    }
                };

                WebSource {
                    id: (idx + 1) as u32,
                    title: result.title,
                    url: result.url,
                    domain: result.domain,
                    snippet: result.snippet,
                    content_preview,
                    score,
                    score_breakdown: breakdown,
                }
            })
            .collect()
    }

    /// Compute the full score for a result
    fn compute_full_score(
        &self,
        result: &RawSearchResult,
        page: Option<&FetchedPage>,
    ) -> (f32, ScoreBreakdown) {
        // Combine title + snippet + content for scoring
        let text = if let Some(p) = page {
            format!("{} {} {}", result.title, result.snippet, p.content)
        } else {
            format!("{} {}", result.title, result.snippet)
        };

        // Lexical score (keyword matching)
        let lexical_score = self.compute_lexical_score(&text);

        // Semantic score (simplified: use lexical as proxy for now)
        // In production, this would use fastembed embeddings
        let semantic_score = self.compute_semantic_proxy_score(&text);

        // Trust bonus
        let trust_bonus = if is_trusted_domain(&result.domain) {
            self.config.trust_bonus
        } else {
            0.0
        };

        // Freshness bonus (simplified: check for recent year mentions)
        let freshness_bonus = self.compute_freshness_bonus(&text);

        let breakdown = ScoreBreakdown {
            semantic_score,
            lexical_score,
            freshness_bonus,
            trust_bonus,
        };

        let total_score = semantic_score * self.config.semantic_weight
            + lexical_score * self.config.lexical_weight
            + freshness_bonus
            + trust_bonus;

        (total_score, breakdown)
    }

    /// Compute lexical (keyword) matching score
    fn compute_lexical_score(&self, text: &str) -> f32 {
        if self.query_terms.is_empty() {
            return 0.0;
        }

        let text_lower = text.to_lowercase();
        let text_terms: HashSet<String> = tokenize(&text_lower).into_iter().collect();

        let matches = self
            .query_terms
            .iter()
            .filter(|term| text_terms.contains(*term) || text_lower.contains(term.as_str()))
            .count();

        (matches as f32 / self.query_terms.len() as f32).min(1.0)
    }

    /// Proxy for semantic score (uses keyword overlap as approximation)
    /// In production, replace with actual embedding similarity
    fn compute_semantic_proxy_score(&self, text: &str) -> f32 {
        let text_terms = tokenize(text);

        if text_terms.is_empty() || self.query_terms.is_empty() {
            return 0.0;
        }

        // Jaccard similarity as a simple proxy
        let query_set: HashSet<&String> = self.query_terms.iter().collect();
        let text_set: HashSet<&String> = text_terms.iter().collect();

        let intersection = query_set.intersection(&text_set).count();
        let union = query_set.union(&text_set).count();

        if union == 0 {
            0.0
        } else {
            (intersection as f32 / union as f32).min(1.0)
        }
    }

    /// Compute freshness bonus based on recent year mentions
    fn compute_freshness_bonus(&self, text: &str) -> f32 {
        let current_year = chrono::Utc::now().year();

        // Check for current or recent year mentions
        for year_offset in 0..2 {
            let year = current_year - year_offset;
            if text.contains(&year.to_string()) {
                return self.config.freshness_bonus * (1.0 - year_offset as f32 * 0.5);
            }
        }

        0.0
    }
}

/// Simple tokenizer for text
fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
        .filter(|s| s.len() > 2) // Skip very short tokens
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize() {
        let tokens = tokenize("Hello, World! How are you?");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
    }

    #[test]
    fn test_lexical_score() {
        let ranker = CpuRanker::new("météo paris", RankConfig::default());
        let score = ranker.compute_lexical_score("La météo à Paris est ensoleillée");
        assert!(score > 0.5);
    }
}
