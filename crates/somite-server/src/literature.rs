use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use thiserror::Error;

const EUROPE_PMC: &str = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const MAX_SEARCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARTICLE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum LiteratureError {
    #[error("invalid bioRxiv search query")]
    InvalidQuery,
    #[error("invalid bioRxiv paper identifier")]
    InvalidPaperId,
    #[error("full text is not available for this bioRxiv paper; upload its PDF instead")]
    FullTextUnavailable,
    #[error("the selected record is not a bioRxiv paper")]
    NotBiorxiv,
    #[error("literature service: {0}")]
    Upstream(String),
    #[error("paper cache: {0}")]
    Cache(#[from] std::io::Error),
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperSearchResult {
    pub id: String,
    pub doi: String,
    pub title: String,
    pub authors: String,
    pub date: String,
    pub abstract_text: String,
    pub url: String,
    pub full_text_available: bool,
}

#[derive(Debug, Serialize)]
pub struct PaperSearchResponse {
    pub query: String,
    pub results: Vec<PaperSearchResult>,
}

#[derive(Debug, Deserialize)]
struct EuropePmcResponse {
    #[serde(rename = "resultList")]
    result_list: EuropePmcResultList,
}

#[derive(Debug, Deserialize)]
struct EuropePmcResultList {
    #[serde(default)]
    result: Vec<EuropePmcRecord>,
}

#[derive(Debug, Deserialize)]
struct EuropePmcRecord {
    id: String,
    #[serde(default)]
    doi: String,
    #[serde(default)]
    title: String,
    #[serde(default, rename = "authorString")]
    author_string: String,
    #[serde(default, rename = "firstPublicationDate")]
    first_publication_date: String,
    #[serde(default, rename = "pubYear")]
    pub_year: String,
    #[serde(default, rename = "abstractText")]
    abstract_text: String,
    #[serde(default, rename = "inEPMC")]
    in_epmc: String,
    #[serde(default, rename = "fullTextIdList")]
    full_text_ids: Option<EuropePmcFullTextIds>,
}

#[derive(Debug, Deserialize)]
struct EuropePmcFullTextIds {
    #[serde(default, rename = "fullTextId")]
    full_text_id: Vec<String>,
}

pub fn search_biorxiv(query: &str) -> Result<Vec<PaperSearchResult>, LiteratureError> {
    validate_query(query)?;
    let url = search_url(query);
    let raw = curl(&url, 10, MAX_SEARCH_BYTES)?;
    parse_search_response(&raw)
}

pub fn fetch_biorxiv_text(
    cache_directory: &Path,
    paper_id: &str,
) -> Result<String, LiteratureError> {
    validate_paper_id(paper_id)?;
    let cache_path = cache_path(cache_directory, paper_id);
    if let Ok(raw) = std::fs::read_to_string(&cache_path) {
        if let Ok(text) = validated_jats_text(&raw) {
            return Ok(text);
        }
    }

    let url = format!("{EUROPE_PMC}/{paper_id}/fullTextXML");
    let raw = match curl(&url, 18, MAX_ARTICLE_BYTES) {
        Ok(raw) => raw,
        Err(LiteratureError::Upstream(detail))
            if detail.contains("404") || detail.contains("400") =>
        {
            return Err(LiteratureError::FullTextUnavailable)
        }
        Err(error) => return Err(error),
    };
    let text = validated_jats_text(&raw)?;
    std::fs::create_dir_all(cache_directory)?;
    let temporary = cache_directory.join(format!(".{paper_id}.xml.tmp-{}", std::process::id()));
    std::fs::write(&temporary, raw)?;
    std::fs::rename(temporary, cache_path)?;
    Ok(text)
}

fn validate_query(query: &str) -> Result<(), LiteratureError> {
    let query = query.trim();
    if (2..=160).contains(&query.len())
        && query.chars().any(char::is_alphanumeric)
        && !query.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err(LiteratureError::InvalidQuery)
    }
}

fn validate_paper_id(paper_id: &str) -> Result<(), LiteratureError> {
    if paper_id.strip_prefix("PPR").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
    }) {
        Ok(())
    } else {
        Err(LiteratureError::InvalidPaperId)
    }
}

fn search_url(query: &str) -> String {
    let query = query.trim();
    let subject = if looks_like_doi(query) {
        format!("DOI:\"{}\"", escape_query_value(query))
    } else {
        let terms = query
            .chars()
            .map(|character| {
                if character.is_alphanumeric()
                    || character.is_whitespace()
                    || matches!(character, '-' | '_' | '.')
                {
                    character
                } else {
                    ' '
                }
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        format!("({terms})")
    };
    let locked = format!("{subject} AND SRC:PPR AND PUBLISHER:\"bioRxiv\"");
    format!(
        "{EUROPE_PMC}/search?format=json&resultType=core&pageSize=12&query={}",
        percent_encode(&locked)
    )
}

fn looks_like_doi(query: &str) -> bool {
    query
        .trim()
        .trim_start_matches("https://doi.org/")
        .starts_with("10.")
}

fn escape_query_value(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://doi.org/")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn parse_search_response(raw: &str) -> Result<Vec<PaperSearchResult>, LiteratureError> {
    let response: EuropePmcResponse = serde_json::from_str(raw)
        .map_err(|error| LiteratureError::Upstream(format!("invalid search response: {error}")))?;
    Ok(response
        .result_list
        .result
        .into_iter()
        .filter(|record| validate_paper_id(&record.id).is_ok() && !record.doi.is_empty())
        .map(|record| {
            let full_text_available = record.in_epmc.eq_ignore_ascii_case("Y")
                || record
                    .full_text_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.full_text_id.is_empty());
            let doi = record.doi;
            PaperSearchResult {
                id: record.id,
                url: format!("https://www.biorxiv.org/content/{doi}"),
                doi,
                title: clean_inline(&record.title),
                authors: clean_inline(&record.author_string),
                date: if record.first_publication_date.is_empty() {
                    record.pub_year
                } else {
                    record.first_publication_date
                },
                abstract_text: clean_inline(&record.abstract_text),
                full_text_available,
            }
        })
        .collect())
}

fn validated_jats_text(raw: &str) -> Result<String, LiteratureError> {
    let lower = raw.to_ascii_lowercase();
    if !lower.contains("<article") {
        return Err(LiteratureError::FullTextUnavailable);
    }
    let biorxiv_journal = lower.contains(">biorxiv</journal-id>")
        || lower.contains(">biorxiv : the preprint server for biology</journal-title>");
    if !biorxiv_journal {
        return Err(LiteratureError::NotBiorxiv);
    }
    let text = markup_to_text(raw, true);
    if text.len() < 200 {
        return Err(LiteratureError::FullTextUnavailable);
    }
    Ok(text)
}

fn cache_path(cache_directory: &Path, paper_id: &str) -> PathBuf {
    cache_directory.join(format!("{paper_id}.xml"))
}

fn curl(url: &str, timeout_seconds: u64, max_bytes: usize) -> Result<String, LiteratureError> {
    let output = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--connect-timeout",
            "4",
            "--max-time",
            &timeout_seconds.to_string(),
            "--max-filesize",
            &max_bytes.to_string(),
            "--user-agent",
            "Somite/0.1 (paper reconstruction)",
            url,
        ])
        .output()
        .map_err(|error| LiteratureError::Upstream(error.to_string()))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(LiteratureError::Upstream(if detail.is_empty() {
            format!("request failed with {}", output.status)
        } else {
            detail
        }));
    }
    if output.stdout.len() > max_bytes {
        return Err(LiteratureError::Upstream(
            "response exceeded the size limit".to_owned(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| LiteratureError::Upstream(format!("response was not UTF-8: {error}")))
}

fn clean_inline(raw: &str) -> String {
    markup_to_text(raw, false)
}

fn markup_to_text(raw: &str, preserve_blocks: bool) -> String {
    let mut plain = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('<') {
        plain.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            plain.push_str(&rest[start..]);
            rest = "";
            break;
        };
        if preserve_blocks && block_tag(&rest[start + 1..start + end]) {
            plain.push('\n');
        }
        rest = &rest[start + end + 1..];
    }
    plain.push_str(rest);
    let decoded = decode_entities(&plain);
    if preserve_blocks {
        decoded
            .lines()
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        decoded.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

fn block_tag(tag: &str) -> bool {
    let name = tag
        .trim()
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    matches!(
        name,
        "abstract"
            | "article-title"
            | "body"
            | "caption"
            | "list-item"
            | "p"
            | "sec"
            | "subtitle"
            | "title"
    )
}

fn decode_entities(raw: &str) -> String {
    let mut decoded = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let Some(relative_end) = rest[start + 1..].find(';') else {
            decoded.push_str(&rest[start..]);
            return decoded;
        };
        let end = start + 1 + relative_end;
        let entity = &rest[start + 1..end];
        let replacement = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            value if value.starts_with("#x") => u32::from_str_radix(&value[2..], 16)
                .ok()
                .and_then(char::from_u32),
            value if value.starts_with('#') => {
                value[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = replacement {
            decoded.push(character);
        } else {
            decoded.push_str(&rest[start..=end]);
        }
        rest = &rest[end + 1..];
    }
    decoded.push_str(rest);
    decoded
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_search_results_and_cleans_markup() {
        let raw = r#"{
          "resultList": {"result": [{
            "id": "PPR12345",
            "doi": "10.1101/2026.01.02.123456",
            "title": "Single-cell <i>RNA</i> atlas",
            "authorString": "Ada A; Turing B",
            "firstPublicationDate": "2026-01-02",
            "abstractText": "We used <b>STAR</b> &amp; FastQC.",
            "inEPMC": "Y"
          }]}
        }"#;
        let results = parse_search_response(raw).expect("search response");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Single-cell RNA atlas");
        assert_eq!(results[0].abstract_text, "We used STAR & FastQC.");
        assert!(results[0].full_text_available);
        assert_eq!(results[0].id, "PPR12345");
    }

    #[test]
    fn search_query_is_locked_to_biorxiv_preprints() {
        let url = search_url("single cell");
        assert!(url.contains("SRC%3APPR"));
        assert!(url.contains("PUBLISHER%3A%22bioRxiv%22"));
        assert!(!url.to_ascii_lowercase().contains("medrxiv"));
    }

    #[test]
    fn rejects_invalid_ids_and_non_biorxiv_jats() {
        assert!(matches!(
            validate_paper_id("PMC123"),
            Err(LiteratureError::InvalidPaperId)
        ));
        let medrxiv = "<article><journal-meta><journal-id>medRxiv</journal-id></journal-meta><body><p>Long enough paper text for reconstruction.</p></body></article>";
        assert!(matches!(
            validated_jats_text(medrxiv),
            Err(LiteratureError::NotBiorxiv)
        ));
    }

    #[test]
    fn jats_text_preserves_methods_and_decodes_entities() {
        let prose = "RNA-seq reads were checked with FastQC &amp; aligned using STAR. ".repeat(5);
        let raw = format!("<article><journal-meta><journal-id>bioRxiv</journal-id></journal-meta><body><sec><title>Methods</title><p>{prose}</p></sec></body></article>");
        let text = validated_jats_text(&raw).expect("bioRxiv JATS");
        assert!(text.contains("Methods"));
        assert!(text.contains("FastQC & aligned using STAR"));
        assert!(!text.contains("<title>"));
    }
}
