//! Pure palette organization. Drawing and drag recognition stay in the app.

use std::collections::{BTreeMap, BTreeSet};

use axial_ops::Operator;
use serde::{Deserialize, Serialize};

use crate::nfcore_catalog::Pipeline;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    #[default]
    Build,
    Sources,
    Pipelines,
}

impl Mode {
    pub(crate) const ALL: [Self; 3] = [Self::Build, Self::Sources, Self::Pipelines];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Build => "Build",
            Self::Sources => "Sources",
            Self::Pipelines => "Pipelines",
        }
    }
}

#[derive(Clone)]
pub(crate) struct Item {
    pub(crate) operator: Operator,
    pub(crate) subtitle: String,
    pub(crate) icon: &'static str,
}

#[derive(Clone)]
pub(crate) struct Section {
    pub(crate) title: String,
    pub(crate) items: Vec<Item>,
    pub(crate) open: bool,
}

pub(crate) fn inventory_counts(operators: &BTreeMap<String, Operator>) -> (usize, usize) {
    let discovered = operators
        .values()
        .filter(|operator| is_generated_pipeline(operator))
        .count();
    (operators.len().saturating_sub(discovered), discovered)
}

pub(crate) fn sections(
    mode: Mode,
    operators: &BTreeMap<String, Operator>,
    nfcore: &BTreeMap<String, Pipeline>,
    query: &str,
    recent: &[String],
    favorites: &BTreeSet<String>,
) -> Vec<Section> {
    let query = query.trim().to_lowercase();
    if !query.is_empty() {
        let items = operators
            .values()
            .filter(|operator| matches(operator, nfcore.get(&operator.id), &query))
            .map(|operator| item(operator, nfcore.get(&operator.id)))
            .collect();
        return vec![Section {
            title: "Search results".into(),
            items,
            open: true,
        }];
    }

    match mode {
        Mode::Build => build_sections(operators, nfcore, recent, favorites),
        Mode::Sources => source_sections(operators, nfcore, favorites),
        Mode::Pipelines => pipeline_sections(operators, nfcore, favorites),
    }
}

fn build_sections(
    operators: &BTreeMap<String, Operator>,
    nfcore: &BTreeMap<String, Pipeline>,
    recent: &[String],
    favorites: &BTreeSet<String>,
) -> Vec<Section> {
    let mut sections = Vec::new();
    push_named(
        &mut sections,
        "Favorites",
        favorites.iter(),
        operators,
        nfcore,
        true,
    );
    push_named(
        &mut sections,
        "Recent",
        recent.iter().take(5),
        operators,
        nfcore,
        true,
    );

    for (title, prefix) in [
        ("Quality", "qc."),
        ("Align & map", "align."),
        ("Quantify", "quant."),
        ("Assemble", "asm."),
    ] {
        push_filtered(&mut sections, title, operators, nfcore, false, |operator| {
            operator.id.starts_with(prefix)
        });
    }
    push_filtered(
        &mut sections,
        "Analyze",
        operators,
        nfcore,
        false,
        |operator| {
            ["diff.", "var.", "class."]
                .iter()
                .any(|prefix| operator.id.starts_with(prefix))
        },
    );
    push_filtered(
        &mut sections,
        "Utilities",
        operators,
        nfcore,
        false,
        |operator| operator.id.starts_with("gap."),
    );
    sections
}

fn source_sections(
    operators: &BTreeMap<String, Operator>,
    nfcore: &BTreeMap<String, Pipeline>,
    favorites: &BTreeSet<String>,
) -> Vec<Section> {
    let mut sections = Vec::new();
    let favorite_sources = favorites
        .iter()
        .filter(|id| operators.get(*id).is_some_and(is_source));
    push_named(
        &mut sections,
        "Favorite sources",
        favorite_sources,
        operators,
        nfcore,
        true,
    );
    push_filtered(
        &mut sections,
        "NCBI & SRA",
        operators,
        nfcore,
        true,
        |operator| operator.id.starts_with("ncbi.") || operator.id.starts_with("sra."),
    );
    push_filtered(
        &mut sections,
        "Ensembl accessions",
        operators,
        nfcore,
        true,
        |operator| operator.id == "ensembl.sequence",
    );
    push_filtered(
        &mut sections,
        "Local files",
        operators,
        nfcore,
        true,
        |operator| {
            ["files.", "sheet.", "archive."]
                .iter()
                .any(|prefix| operator.id.starts_with(prefix))
        },
    );
    sections
}

fn pipeline_sections(
    operators: &BTreeMap<String, Operator>,
    nfcore: &BTreeMap<String, Pipeline>,
    favorites: &BTreeSet<String>,
) -> Vec<Section> {
    let mut sections = Vec::new();
    let favorite_pipelines = favorites
        .iter()
        .filter(|id| operators.get(*id).is_some_and(is_pipeline));
    push_named(
        &mut sections,
        "Favorite pipelines",
        favorite_pipelines,
        operators,
        nfcore,
        true,
    );
    push_filtered(
        &mut sections,
        "Snakemake",
        operators,
        nfcore,
        true,
        |operator| operator.id.starts_with("smk."),
    );
    push_filtered(
        &mut sections,
        "Curated for Axial",
        operators,
        nfcore,
        true,
        |operator| operator.id.starts_with("nf.") && !is_generated_pipeline(operator),
    );
    push_filtered(
        &mut sections,
        "Official nf-core catalog",
        operators,
        nfcore,
        true,
        is_generated_pipeline,
    );
    sections
}

fn push_named<'a>(
    sections: &mut Vec<Section>,
    title: &str,
    ids: impl IntoIterator<Item = &'a String>,
    operators: &BTreeMap<String, Operator>,
    nfcore: &BTreeMap<String, Pipeline>,
    open: bool,
) {
    let items = ids
        .into_iter()
        .filter_map(|id| operators.get(id))
        .map(|operator| item(operator, nfcore.get(&operator.id)))
        .collect::<Vec<_>>();
    if !items.is_empty() {
        sections.push(Section {
            title: title.into(),
            items,
            open,
        });
    }
}

fn push_filtered(
    sections: &mut Vec<Section>,
    title: &str,
    operators: &BTreeMap<String, Operator>,
    nfcore: &BTreeMap<String, Pipeline>,
    open: bool,
    predicate: impl Fn(&Operator) -> bool,
) {
    let items = operators
        .values()
        .filter(|operator| predicate(operator))
        .map(|operator| item(operator, nfcore.get(&operator.id)))
        .collect::<Vec<_>>();
    if !items.is_empty() {
        sections.push(Section {
            title: title.into(),
            items,
            open,
        });
    }
}

fn item(operator: &Operator, pipeline: Option<&Pipeline>) -> Item {
    Item {
        operator: operator.clone(),
        subtitle: pipeline
            .map(|pipeline| pipeline.description.clone())
            .filter(|description| !description.is_empty())
            .unwrap_or_else(|| family_subtitle(&operator.id).into()),
        icon: family_icon(&operator.id),
    }
}

fn matches(operator: &Operator, pipeline: Option<&Pipeline>, query: &str) -> bool {
    operator.title.to_lowercase().contains(query)
        || operator.id.to_lowercase().contains(query)
        || operator
            .palette
            .iter()
            .any(|group| group.to_lowercase().contains(query))
        || family_subtitle(&operator.id).to_lowercase().contains(query)
        || pipeline.is_some_and(|pipeline| {
            pipeline.description.to_lowercase().contains(query)
                || pipeline
                    .topics
                    .iter()
                    .any(|topic| topic.to_lowercase().contains(query))
        })
}

fn is_source(operator: &Operator) -> bool {
    ["ncbi.", "sra.", "ensembl.", "files.", "sheet.", "archive."]
        .iter()
        .any(|prefix| operator.id.starts_with(prefix))
}

fn is_pipeline(operator: &Operator) -> bool {
    operator.id.starts_with("nf.") || operator.id.starts_with("smk.")
}

fn is_generated_pipeline(operator: &Operator) -> bool {
    operator.palette.as_slice() == ["nf-core", "Catalog"]
}

fn family_icon(id: &str) -> &'static str {
    match id.split('.').next().unwrap_or_default() {
        "qc" => "QC",
        "align" => "A",
        "quant" => "Q",
        "asm" => "AS",
        "diff" | "var" | "class" => "AN",
        "nf" => "nf",
        "smk" => "SM",
        "sra" => "S",
        "ncbi" => "N",
        "ensembl" => "E",
        "files" | "sheet" | "archive" => "F",
        _ => "+",
    }
}

fn family_subtitle(id: &str) -> &'static str {
    if id == "ensembl.sequence" {
        return "FASTA from an Ensembl stable ID";
    }
    if id == "ncbi.datasets_assembly" {
        return "Genome package from GCA / GCF";
    }
    if id == "sra.prefetch" {
        return "Public run from SRR / ERR / DRR";
    }
    match id.split('.').next().unwrap_or_default() {
        "qc" => "Quality control",
        "align" => "Align and map reads",
        "quant" => "Quantify expression",
        "asm" => "Genome assembly",
        "diff" => "Differential analysis",
        "var" => "Variant analysis",
        "class" => "Classification",
        "nf" => "nf-core pipeline",
        "smk" => "Run a local Snakemake project",
        "sra" => "SRA data source",
        "ncbi" => "NCBI data source",
        "ensembl" => "Ensembl data source",
        "files" | "sheet" | "archive" => "Local data",
        _ => "Operator",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axial_ops::{Cost, OpKind, PortsSpec};

    fn operator(id: &str, palette: &[&str]) -> Operator {
        Operator {
            id: id.into(),
            title: id.into(),
            palette: palette.iter().map(|value| (*value).into()).collect(),
            kind: OpKind::External,
            cost: Cost::Low,
            bin: None,
            conda: None,
            params: BTreeMap::new(),
            ports: PortsSpec::default(),
            argv: Vec::new(),
            outputs: BTreeMap::new(),
        }
    }

    #[test]
    fn organizes_build_sources_and_pipelines_by_intent() {
        let operators = [
            operator("qc.fastqc", &["QC"]),
            operator("sra.prefetch", &["NCBI", "SRA"]),
            operator("nf.rnaseq", &["nf-core", "RNA"]),
            operator("nf.demo", &["nf-core", "Catalog"]),
            operator("smk.workflow", &["Snakemake", "Workflow"]),
        ]
        .into_iter()
        .map(|operator| (operator.id.clone(), operator))
        .collect();
        let nfcore = BTreeMap::new();

        let build = sections(Mode::Build, &operators, &nfcore, "", &[], &BTreeSet::new());
        assert_eq!(build[0].title, "Quality");

        let sources = sections(
            Mode::Sources,
            &operators,
            &nfcore,
            "",
            &[],
            &BTreeSet::new(),
        );
        assert_eq!(sources[0].title, "NCBI & SRA");

        let pipelines = sections(
            Mode::Pipelines,
            &operators,
            &nfcore,
            "",
            &[],
            &BTreeSet::new(),
        );
        assert_eq!(pipelines[0].title, "Snakemake");
        assert_eq!(pipelines[1].title, "Curated for Axial");
        assert_eq!(pipelines[2].title, "Official nf-core catalog");
        assert_eq!(pipelines[0].items[0].operator.id, "smk.workflow");
        assert_eq!(pipelines[1].items[0].operator.id, "nf.rnaseq");
        assert_eq!(inventory_counts(&operators), (4, 1));
    }

    #[test]
    fn search_crosses_mode_boundaries() {
        let operator = operator("nf.rnaseq", &["nf-core", "RNA"]);
        let operators = [(operator.id.clone(), operator)].into_iter().collect();
        let results = sections(
            Mode::Sources,
            &operators,
            &BTreeMap::new(),
            "rna",
            &[],
            &BTreeSet::new(),
        );
        assert_eq!(results[0].items[0].operator.id, "nf.rnaseq");
    }
}
