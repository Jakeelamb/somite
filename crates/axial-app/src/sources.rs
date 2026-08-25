//! Accession recognition for the palette's quick source entry.

use std::env;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessionKind {
    SraRun,
    Assembly,
    EnsemblGene,
    EnsemblTranscript,
    EnsemblProtein,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceRequest {
    pub(crate) kind: AccessionKind,
    pub(crate) value: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ToolReadiness {
    pub(crate) sra: bool,
    pub(crate) datasets: bool,
    pub(crate) ensembl: bool,
}

impl ToolReadiness {
    pub(crate) fn detect() -> Self {
        Self {
            sra: executable("prefetch", "axial-ncbi") && executable("fasterq-dump", "axial-ncbi"),
            datasets: executable("datasets", "axial-ncbi"),
            ensembl: executable("curl", "axial-ncbi"),
        }
    }
}

fn executable(bin: &str, conda_env: &str) -> bool {
    if env::var_os("PATH")
        .as_deref()
        .into_iter()
        .flat_map(env::split_paths)
        .any(|directory| directory.join(bin).is_file())
    {
        return true;
    }
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    ["miniconda3", "mambaforge", "miniforge3", "anaconda3"]
        .iter()
        .map(|root| {
            Path::new(&home)
                .join(root)
                .join("envs")
                .join(conda_env)
                .join("bin")
                .join(bin)
        })
        .any(|path| path.is_file())
}

impl SourceRequest {
    pub(crate) fn provider(&self) -> &'static str {
        match self.kind {
            AccessionKind::SraRun => "NCBI SRA",
            AccessionKind::Assembly => "NCBI Datasets",
            AccessionKind::EnsemblGene
            | AccessionKind::EnsemblTranscript
            | AccessionKind::EnsemblProtein => "Ensembl REST",
        }
    }

    pub(crate) fn result(&self) -> &'static str {
        match self.kind {
            AccessionKind::SraRun => "SRA download → separate R1 / R2 FASTQ streams",
            AccessionKind::Assembly => "Genome, annotations, proteins and metadata package",
            AccessionKind::EnsemblGene => "Genomic FASTA sequence",
            AccessionKind::EnsemblTranscript => "Transcript cDNA FASTA sequence",
            AccessionKind::EnsemblProtein => "Protein FASTA sequence",
        }
    }

    pub(crate) fn action(&self) -> &'static str {
        match self.kind {
            AccessionKind::SraRun => "Add reads",
            AccessionKind::Assembly => "Add assembly",
            AccessionKind::EnsemblGene
            | AccessionKind::EnsemblTranscript
            | AccessionKind::EnsemblProtein => "Add sequence",
        }
    }

    pub(crate) fn sequence_type(&self) -> Option<&'static str> {
        match self.kind {
            AccessionKind::EnsemblGene => Some("genomic"),
            AccessionKind::EnsemblTranscript => Some("cdna"),
            AccessionKind::EnsemblProtein => Some("protein"),
            AccessionKind::SraRun | AccessionKind::Assembly => None,
        }
    }
}

fn candidate(value: &str) -> Option<SourceRequest> {
    for prefix in ["SRR", "ERR", "DRR"] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit()) {
                return Some(SourceRequest {
                    kind: AccessionKind::SraRun,
                    value: value.into(),
                });
            }
        }
    }

    for prefix in ["GCA_", "GCF_"] {
        if let Some(suffix) = value.strip_prefix(prefix) {
            if suffix.matches('.').count() <= 1
                && suffix
                    .split('.')
                    .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
            {
                return Some(SourceRequest {
                    kind: AccessionKind::Assembly,
                    value: value.into(),
                });
            }
        }
    }

    let (base, version) = value
        .split_once('.')
        .map_or((value, None), |(base, version)| (base, Some(version)));
    if version
        .is_some_and(|version| version.is_empty() || !version.chars().all(|ch| ch.is_ascii_digit()))
        || base.matches('.').count() > 0
        || !base.starts_with("ENS")
        || !base.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        return None;
    }
    let digit_start = base
        .char_indices()
        .rev()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, _)| index)
        .last()?;
    if digit_start == base.len() || base.len() - digit_start < 6 {
        return None;
    }
    let kind = match base[..digit_start].chars().last()? {
        'G' => AccessionKind::EnsemblGene,
        'T' => AccessionKind::EnsemblTranscript,
        'P' => AccessionKind::EnsemblProtein,
        _ => return None,
    };
    Some(SourceRequest {
        kind,
        value: value.into(),
    })
}

pub(crate) fn classify(input: &str) -> Result<SourceRequest, String> {
    let normalized = input.trim().to_ascii_uppercase();
    let mut found = normalized
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.')))
        .filter_map(candidate)
        .collect::<Vec<_>>();
    found.dedup_by(|left, right| left.value == right.value);
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err("Paste an SRR/ERR/DRR run, GCA_/GCF_ assembly, or Ensembl stable ID".into()),
        _ => Err("Paste one accession at a time so each source stays explicit".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_accessions() {
        assert_eq!(classify(" srr123456 ").unwrap().kind, AccessionKind::SraRun);
        assert_eq!(
            classify("GCA_902167145.1").unwrap().value,
            "GCA_902167145.1"
        );
        assert!(classify("SRP123").is_err());
    }

    #[test]
    fn extracts_accessions_copied_from_record_urls() {
        let request = classify("https://www.ncbi.nlm.nih.gov/sra/?term=SRR123456").unwrap();
        assert_eq!(request.kind, AccessionKind::SraRun);
        assert_eq!(request.value, "SRR123456");

        let request =
            classify("https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/").unwrap();
        assert_eq!(request.kind, AccessionKind::Assembly);
        assert_eq!(request.value, "GCF_000001405.40");
    }

    #[test]
    fn recognizes_ensembl_gene_transcript_and_protein_ids() {
        for (input, kind, sequence_type) in [
            ("ENSG00000157764", AccessionKind::EnsemblGene, "genomic"),
            (
                "ENSMUST00000033845.15",
                AccessionKind::EnsemblTranscript,
                "cdna",
            ),
            ("ENSP00000288602", AccessionKind::EnsemblProtein, "protein"),
        ] {
            let request = classify(input).unwrap();
            assert_eq!(request.kind, kind);
            assert_eq!(request.sequence_type(), Some(sequence_type));
            assert_eq!(request.provider(), "Ensembl REST");
        }
    }

    #[test]
    fn rejects_ambiguous_multi_accession_pastes() {
        let error = classify("SRR123456 SRR654321").unwrap_err();
        assert!(error.contains("one accession"), "{error}");
    }
}
