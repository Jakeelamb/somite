use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const EUTILS: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const ENSEMBL: &str = "https://rest.ensembl.org";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceRequest {
    pub kind: String,
    pub value: String,
    pub provider: String,
    pub result: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence_type: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub key: String,
    pub title: String,
    pub accession: String,
    pub description: String,
    pub provider: String,
    pub data_kind: String,
    pub tags: Vec<String>,
    pub request: SourceRequest,
}

pub fn search_ncbi(query: &str) -> Vec<SearchResult> {
    // Anonymous E-utilities clients are limited to three requests per second.
    // Each result family needs ESearch + ESummary, so pace the four calls rather
    // than racing them and silently losing one provider branch to a 429.
    let mut results = search_sra(query);
    std::thread::sleep(Duration::from_millis(360));
    results.extend(search_assemblies(query));
    results
}

pub fn search_ensembl(query: &str) -> Vec<SearchResult> {
    if let Some((species, symbol)) = gene_query(query) {
        let url = format!(
            "{ENSEMBL}/lookup/symbol/{}/{}?content-type=application/json",
            percent_encode(&species),
            percent_encode(&symbol)
        );
        return curl_json(&url, 7)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|record| ensembl_feature_result(&record))
            .into_iter()
            .collect();
    }

    let url = format!(
        "{ENSEMBL}/info/genomes/taxonomy/{}?content-type=application/json",
        percent_encode(query)
    );
    let Ok(raw) = curl_json(&url, 7) else {
        return Vec::new();
    };
    let Ok(records) = serde_json::from_str::<Vec<Value>>(&raw) else {
        return Vec::new();
    };
    records
        .iter()
        .filter_map(ensembl_genome_result)
        .take(3)
        .collect()
}

fn search_sra(query: &str) -> Vec<SearchResult> {
    let term = ncbi_term(query);
    let ids = esearch("sra", &term, 4);
    let Some(summary) = esummary("sra", &ids) else {
        return Vec::new();
    };
    ordered_records(&summary, &ids)
        .filter_map(sra_result)
        .collect()
}

fn search_assemblies(query: &str) -> Vec<SearchResult> {
    let term = format!(
        "{} AND \"reference genome\"[RefSeq Category]",
        ncbi_term(query)
    );
    let ids = esearch("assembly", &term, 3);
    let Some(summary) = esummary("assembly", &ids) else {
        return Vec::new();
    };
    ordered_records(&summary, &ids)
        .filter_map(assembly_result)
        .collect()
}

fn esearch(database: &str, term: &str, limit: usize) -> Vec<String> {
    let url = format!(
        "{EUTILS}/esearch.fcgi?db={database}&retmode=json&retmax={limit}&tool=axial&term={}",
        percent_encode(term)
    );
    let result = curl_json(&url, 7)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|json| json.pointer("/esearchresult/idlist")?.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect();
    std::thread::sleep(Duration::from_millis(360));
    result
}

fn esummary(database: &str, ids: &[String]) -> Option<BTreeMap<String, Value>> {
    if ids.is_empty() {
        return None;
    }
    let url = format!(
        "{EUTILS}/esummary.fcgi?db={database}&retmode=json&tool=axial&id={}",
        ids.join(",")
    );
    let raw = curl_json(&url, 7).ok()?;
    let json = serde_json::from_str::<Value>(&raw).ok()?;
    serde_json::from_value(json.get("result")?.clone()).ok()
}

fn ordered_records<'a>(
    summary: &'a BTreeMap<String, Value>,
    ids: &'a [String],
) -> impl Iterator<Item = &'a Value> {
    ids.iter().filter_map(|id| summary.get(id))
}

fn sra_result(record: &Value) -> Option<SearchResult> {
    let run_xml = record.get("runs")?.as_str()?;
    let accession = attribute(run_xml, "acc")?;
    let experiment = record.get("expxml")?.as_str()?;
    let title = between(experiment, "<Title>", "</Title>")
        .unwrap_or_else(|| "Sequence Read Archive run".to_owned());
    let organism = attribute_after(experiment, "<Organism", "ScientificName")
        .unwrap_or_else(|| "Unknown organism".to_owned());
    let strategy = between(experiment, "<LIBRARY_STRATEGY>", "</LIBRARY_STRATEGY>")
        .unwrap_or_else(|| "Sequencing".to_owned());
    let paired = experiment.contains("<PAIRED");
    Some(SearchResult {
        key: format!("ncbi-sra-{accession}"),
        title,
        accession: accession.clone(),
        description: format!("{organism} · {strategy}"),
        provider: "NCBI SRA".to_owned(),
        data_kind: "Reads".to_owned(),
        tags: vec![strategy, if paired { "Paired" } else { "Single" }.to_owned()],
        request: SourceRequest {
            kind: "sra".to_owned(),
            value: accession,
            provider: "NCBI SRA".to_owned(),
            result: "SRA download → separate R1 / R2 FASTQ streams".to_owned(),
            action: "Add Reads".to_owned(),
            sequence_type: None,
        },
    })
}

fn assembly_result(record: &Value) -> Option<SearchResult> {
    let accession = string_field(record, "assemblyaccession")?;
    let assembly = string_field(record, "assemblyname").unwrap_or_else(|| accession.clone());
    let organism = string_field(record, "organism").unwrap_or_else(|| "Genome assembly".to_owned());
    let level = string_field(record, "assemblystatus").unwrap_or_else(|| "Assembly".to_owned());
    Some(SearchResult {
        key: format!("ncbi-assembly-{accession}"),
        title: format!("{organism} · {assembly}"),
        accession: accession.clone(),
        description: string_field(record, "assemblydescription").unwrap_or(level.clone()),
        provider: "NCBI Datasets".to_owned(),
        data_kind: "Reference".to_owned(),
        tags: vec!["Genome".to_owned(), level],
        request: assembly_request(accession, "NCBI Datasets"),
    })
}

fn ensembl_genome_result(record: &Value) -> Option<SearchResult> {
    let accession = string_field(record, "assembly_accession")?;
    let display = string_field(record, "display_name")
        .or_else(|| string_field(record, "scientific_name"))?;
    let assembly = string_field(record, "assembly_name").unwrap_or_else(|| accession.clone());
    let genebuild = string_field(record, "genebuild").unwrap_or_else(|| "Ensembl".to_owned());
    Some(SearchResult {
        key: format!("ensembl-genome-{accession}"),
        title: format!("{display} reference · {assembly}"),
        accession: accession.clone(),
        description: format!("Ensembl {genebuild} reference assembly"),
        provider: "Ensembl".to_owned(),
        data_kind: "Reference".to_owned(),
        tags: vec!["Genome".to_owned(), genebuild],
        request: assembly_request(accession, "Ensembl → NCBI Datasets"),
    })
}

fn ensembl_feature_result(record: &Value) -> Option<SearchResult> {
    let accession = string_field(record, "id")?;
    let object_type = string_field(record, "object_type").unwrap_or_else(|| "Gene".to_owned());
    let title = string_field(record, "display_name").unwrap_or_else(|| accession.clone());
    let description = string_field(record, "description")
        .unwrap_or_else(|| format!("Ensembl {object_type}"));
    let lower = object_type.to_ascii_lowercase();
    let (kind, sequence_type, data_kind) = if lower.contains("transcript") {
        ("ensembl-transcript", "cdna", "Transcript")
    } else if lower.contains("translation") || lower.contains("protein") {
        ("ensembl-protein", "protein", "Protein")
    } else {
        ("ensembl-gene", "genomic", "Gene")
    };
    Some(SearchResult {
        key: format!("ensembl-feature-{accession}"),
        title,
        accession: accession.clone(),
        description,
        provider: "Ensembl".to_owned(),
        data_kind: data_kind.to_owned(),
        tags: vec![object_type],
        request: SourceRequest {
            kind: kind.to_owned(),
            value: accession,
            provider: "Ensembl REST".to_owned(),
            result: format!("{data_kind} FASTA sequence"),
            action: "Add Sequence".to_owned(),
            sequence_type: Some(sequence_type.to_owned()),
        },
    })
}

fn assembly_request(accession: String, provider: &str) -> SourceRequest {
    SourceRequest {
        kind: "assembly".to_owned(),
        value: accession,
        provider: provider.to_owned(),
        result: "Genome, annotations, proteins & metadata package".to_owned(),
        action: "Add Assembly".to_owned(),
        sequence_type: None,
    }
}

fn ncbi_term(query: &str) -> String {
    let lower = query.to_ascii_lowercase();
    let assay_words = [
        "rna", "seq", "wgs", "liver", "cancer", "tumor", "illumina", "nanopore", "chip",
        "atac", "single cell",
    ];
    if query
        .chars()
        .all(|character| character.is_alphabetic() || character.is_whitespace() || character == '-')
        && !assay_words.iter().any(|word| lower.contains(word))
    {
        format!("{query}[Organism]")
    } else {
        query.to_owned()
    }
}

fn gene_query(query: &str) -> Option<(String, String)> {
    let parts = query.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [symbol]
            if symbol.chars().any(|character| character.is_ascii_uppercase())
                || symbol.chars().any(|character| character.is_ascii_digit()) =>
        {
            Some(("human".to_owned(), symbol.to_ascii_uppercase()))
        }
        [species @ .., symbol]
            if symbol.chars().any(|character| character.is_ascii_uppercase())
                || symbol.chars().any(|character| character.is_ascii_digit()) =>
        {
            Some((species.join("_"), symbol.to_ascii_uppercase()))
        }
        _ => None,
    }
}

fn string_field(record: &Value, field: &str) -> Option<String> {
    record.get(field)?.as_str().filter(|value| !value.is_empty()).map(str::to_owned)
}

fn curl_json(url: &str, timeout_seconds: u64) -> Result<String, String> {
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            &timeout_seconds.to_string(),
            "-H",
            "Accept: application/json",
            "-A",
            "Axial/0.1 source-search",
            url,
        ])
        .output()
        .map_err(|error| format!("could not start curl: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn attribute(text: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    let tail = text.split_once(&marker)?.1;
    Some(tail.split_once('"')?.0.to_owned())
}

fn attribute_after(text: &str, element: &str, name: &str) -> Option<String> {
    attribute(text.split_once(element)?.1, name)
}

fn between(text: &str, start: &str, end: &str) -> Option<String> {
    let tail = text.split_once(start)?.1;
    Some(tail.split_once(end)?.0.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sra_summary_into_a_paired_read_source() {
        let record = serde_json::json!({
            "runs": "<Run acc=\"SRR123456\"/>",
            "expxml": "<Summary><Title>RNA sequencing</Title></Summary><Organism ScientificName=\"Homo sapiens\"/><LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY><LIBRARY_LAYOUT><PAIRED/></LIBRARY_LAYOUT>"
        });
        let result = sra_result(&record).expect("SRA result");
        assert_eq!(result.accession, "SRR123456");
        assert_eq!(result.data_kind, "Reads");
        assert!(result.tags.contains(&"Paired".to_owned()));
    }

    #[test]
    fn parses_reference_assembly_and_ensembl_gene_results() {
        let assembly = assembly_result(&serde_json::json!({
            "assemblyaccession": "GCF_000001405.40",
            "assemblyname": "GRCh38.p14",
            "organism": "Homo sapiens",
            "assemblystatus": "Chromosome",
            "assemblydescription": "Human reference",
        }))
        .expect("assembly result");
        assert_eq!(assembly.request.kind, "assembly");
        assert_eq!(assembly.data_kind, "Reference");

        let gene = ensembl_feature_result(&serde_json::json!({
            "id": "ENSG00000139618",
            "display_name": "BRCA2",
            "object_type": "Gene",
            "description": "BRCA2 DNA repair associated",
        }))
        .expect("gene result");
        assert_eq!(gene.request.kind, "ensembl-gene");
        assert_eq!(gene.request.sequence_type.as_deref(), Some("genomic"));
    }
}
