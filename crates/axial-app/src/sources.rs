//! Accession recognition for the palette's quick source entry.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessionKind {
    SraRun,
    Assembly,
}

pub(crate) fn classify(input: &str) -> Result<(AccessionKind, String), String> {
    let accession = input.trim().to_ascii_uppercase();
    let split = accession
        .find(|ch: char| ch.is_ascii_digit())
        .ok_or_else(|| "enter an SRR/ERR/DRR run or GCA/GCF assembly accession".to_owned())?;
    let (prefix, suffix) = accession.split_at(split);
    let kind = match prefix {
        "SRR" | "ERR" | "DRR"
            if !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit()) =>
        {
            AccessionKind::SraRun
        }
        "GCA_" | "GCF_"
            if suffix
                .split('.')
                .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
                && suffix.matches('.').count() <= 1 =>
        {
            AccessionKind::Assembly
        }
        _ => {
            return Err("enter an SRR/ERR/DRR run or GCA/GCF assembly accession".into());
        }
    };
    Ok((kind, accession))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_accessions() {
        assert_eq!(
            classify(" srr123456 ").unwrap(),
            (AccessionKind::SraRun, "SRR123456".into())
        );
        assert_eq!(
            classify("GCA_902167145.1").unwrap(),
            (AccessionKind::Assembly, "GCA_902167145.1".into())
        );
        assert!(classify("SRP123").is_err());
    }
}
