//! Rebuild a graph from a paper's methods. Catalog is the snap; gaps are honest.
//!
//! PDF text uses what Omarchy already ships: poppler (`pdftotext` / `pdftoppm`)
//! then Tesseract with the same flags as `omarchy capture text`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use axial_ir::{
    compatible, Direction, Edge, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION,
};
use axial_ops::Catalog;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PaperError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("pdftotext: {0}")]
    Pdf(String),
    #[error("tesseract: {0}")]
    Ocr(String),
    #[error("{0}")]
    Msg(String),
}

/// How the bytes became text. Same tools Omarchy installs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractVia {
    Utf8,
    Poppler,
    Tesseract,
}

#[derive(Debug, Clone)]
pub struct Extracted {
    pub text: String,
    pub via: ExtractVia,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Assay {
    Assembly,
    RnaSeq,
    Variants,
    Metagenome,
    SingleCell,
    Mixed,
    Qc,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateRole {
    Primary,
    Parallel,
    Alternative,
}

#[derive(Debug, Clone)]
pub struct CandidateGraph {
    pub name: String,
    pub role: CandidateRole,
    pub graph: Graph,
    pub assay: Assay,
    pub warnings: Vec<String>,
    pub evidence: Vec<EvidenceRecord>,
}

#[derive(Debug, Clone)]
pub struct Reconstruction {
    pub candidates: Vec<CandidateGraph>,
    active: usize,
}

impl Reconstruction {
    fn new(candidates: Vec<CandidateGraph>) -> Self {
        debug_assert!(!candidates.is_empty());
        Self {
            candidates,
            active: 0,
        }
    }

    pub fn active_index(&self) -> usize {
        self.active
    }

    pub fn activate(&mut self, index: usize) -> bool {
        if index < self.candidates.len() {
            self.active = index;
            true
        } else {
            false
        }
    }

    pub fn warn_all(&mut self, warning: impl Into<String>) {
        let warning = warning.into();
        for candidate in &mut self.candidates {
            candidate.warnings.insert(0, warning.clone());
        }
    }
}

impl std::ops::Deref for Reconstruction {
    type Target = CandidateGraph;

    fn deref(&self) -> &Self::Target {
        &self.candidates[self.active]
    }
}

impl std::ops::DerefMut for Reconstruction {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.candidates[self.active]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceStatus {
    Explicit,
    Inferred,
    MissingImplementation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvidenceTarget {
    Node(String),
    Edge(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceRecord {
    pub target: EvidenceTarget,
    pub status: EvidenceStatus,
    pub detail: String,
}

impl EvidenceTarget {
    pub fn id(&self) -> &str {
        match self {
            Self::Node(id) | Self::Edge(id) => id,
        }
    }
}

const RNA_COMPOUND_COVERS: &[&str] = &[
    "align.star",
    "align.hisat2",
    "quant.salmon",
    "quant.featurecounts",
    "quant.stringtie",
];
const VAR_COMPOUND_COVERS: &[&str] = &["align.bwa", "var.haplotypecaller"];
const MAG_COMPOUND_COVERS: &[&str] = &["class.kraken2"];

/// Catalog bricks the methods section can name. nf-core compounds only if named.
const BRICKS: &[(&str, &[&str])] = &[
    ("qc.fastqc", &["fastqc"]),
    (
        "qc.fastp",
        &[
            "fastp",
            "cutadapt",
            "trimmomatic",
            "trim galore",
            "trimgalore",
        ],
    ),
    ("align.star", &["star"]),
    ("align.hisat2", &["hisat2", "hisat"]),
    ("align.bwa", &["bwa-mem", "bwa mem", "bwa"]),
    ("align.minimap2", &["minimap2", "minimap"]),
    (
        "quant.featurecounts",
        &["featurecounts", "feature counts", "rsubread"],
    ),
    ("quant.salmon", &["salmon"]),
    ("quant.stringtie", &["stringtie"]),
    ("diff.deseq2", &["deseq2", "deseq"]),
    ("class.kraken2", &["kraken2", "kraken"]),
    ("var.haplotypecaller", &["haplotypecaller", "gatk"]),
    ("asm.hifiasm", &["hifiasm"]),
    ("asm.yahs", &["yahs"]),
    ("qc.busco", &["busco"]),
    ("nf.rnaseq", &["nf-core/rnaseq", "nf-core rnaseq"]),
    ("nf.sarek", &["nf-core/sarek", "sarek"]),
    ("nf.mag", &["nf-core/mag"]),
    ("nf.taxprofiler", &["nf-core/taxprofiler"]),
];

const GAPS: &[(&str, &[&str])] = &[
    ("Ballgown", &["ballgown"]),
    ("Kallisto", &["kallisto"]),
    ("MultiQC", &["multiqc"]),
    ("Picard", &["picard", "markduplicates"]),
    ("Mutect2", &["mutect"]),
    ("MetaBAT", &["metabat"]),
    ("SPAdes", &["spades"]),
    ("Cell Ranger", &["cellranger", "cell ranger"]),
    ("SoupX", &["soupx"]),
    ("Seurat", &["seurat"]),
    ("DoubletFinder", &["doubletfinder", "doublet finder"]),
];

#[derive(Clone, Copy)]
struct AssemblyMethod {
    key: &'static str,
    name: &'static str,
    needles: &'static [&'static str],
}

const ASSEMBLY_METHODS: &[AssemblyMethod] = &[
    AssemblyMethod {
        key: "hifiasm",
        name: "hifiasm",
        needles: &["hifiasm"],
    },
    AssemblyMethod {
        key: "falcon",
        name: "FALCON",
        needles: &["falcon-unzip", "falcon unzip", "falcon"],
    },
    AssemblyMethod {
        key: "flye",
        name: "Flye",
        needles: &["flye"],
    },
    AssemblyMethod {
        key: "hicanu",
        name: "HiCanu",
        needles: &["hicanu"],
    },
    AssemblyMethod {
        key: "canu",
        name: "Canu",
        needles: &["canu"],
    },
    AssemblyMethod {
        key: "peregrine",
        name: "Peregrine",
        needles: &["peregrine"],
    },
    AssemblyMethod {
        key: "shasta",
        name: "Shasta",
        needles: &["shasta"],
    },
    AssemblyMethod {
        key: "masurca",
        name: "MaSuRCA",
        needles: &["masurca", "maSuRCA"],
    },
];

pub fn text_from_path(path: &Path) -> Result<String, PaperError> {
    Ok(extract_from_path(path)?.text)
}

pub fn extract_from_path(path: &Path) -> Result<Extracted, PaperError> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "pdf" {
        return Ok(Extracted {
            text: fs::read_to_string(path)?,
            via: ExtractVia::Utf8,
        });
    }
    let layer = pdftotext(path)?;
    if text_layer_ok(&layer) {
        return Ok(Extracted {
            text: layer,
            via: ExtractVia::Poppler,
        });
    }
    let ocr = pdf_ocr(path)?;
    Ok(Extracted {
        text: ocr,
        via: ExtractVia::Tesseract,
    })
}

fn text_layer_ok(s: &str) -> bool {
    let letters = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    letters >= 400
}

fn pdftotext(path: &Path) -> Result<String, PaperError> {
    let out = Command::new("pdftotext")
        .args(["-layout", "-q"])
        .arg(path)
        .arg("-")
        .output()
        .map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                PaperError::Pdf("pdftotext not on PATH (poppler)".into())
            } else {
                PaperError::Io(e)
            }
        })?;
    if !out.status.success() {
        return Err(PaperError::Pdf(
            String::from_utf8_lossy(&out.stderr).trim().into(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Same Tesseract flags as `/usr/share/omarchy/bin/omarchy-capture-text`.
fn pdf_ocr(path: &Path) -> Result<String, PaperError> {
    let dir = std::env::temp_dir().join(format!(
        "axial-ocr-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir)?;
    let prefix = dir.join("p");
    let raster = Command::new("pdftoppm")
        .args(["-png", "-r", "300", "-l", "30"])
        .arg(path)
        .arg(&prefix)
        .output()
        .map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                PaperError::Pdf("pdftoppm not on PATH (poppler)".into())
            } else {
                PaperError::Io(e)
            }
        });
    let raster = match raster {
        Ok(o) => o,
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    if !raster.status.success() {
        let _ = fs::remove_dir_all(&dir);
        return Err(PaperError::Pdf(
            String::from_utf8_lossy(&raster.stderr).trim().into(),
        ));
    }
    let langs = std::env::var("OMARCHY_OCR_LANGS").unwrap_or_else(|_| "eng".into());
    let mut pages: Vec<PathBuf> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("png"))
        .collect();
    pages.sort();
    let mut text = String::new();
    for p in &pages {
        let out = Command::new("tesseract")
            .arg(p)
            .arg("stdout")
            .args([
                "--oem",
                "1",
                "--psm",
                "6",
                "-l",
                &langs,
                "--dpi",
                "300",
                "-c",
                "preserve_interword_spaces=1",
            ])
            .output()
            .map_err(|e| {
                if e.kind() == io::ErrorKind::NotFound {
                    PaperError::Ocr("tesseract not on PATH".into())
                } else {
                    PaperError::Io(e)
                }
            });
        match out {
            Ok(o) if o.status.success() => {
                text.push_str(&String::from_utf8_lossy(&o.stdout));
                text.push('\n');
            }
            Ok(o) => {
                let _ = fs::remove_dir_all(&dir);
                return Err(PaperError::Ocr(
                    String::from_utf8_lossy(&o.stderr).trim().into(),
                ));
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
        }
    }
    let _ = fs::remove_dir_all(&dir);
    if text.chars().filter(|c| c.is_ascii_alphabetic()).count() < 40 {
        return Err(PaperError::Ocr("tesseract produced almost no text".into()));
    }
    Ok(text)
}

pub fn reconstruct(catalog: &Catalog, text: &str) -> Reconstruction {
    let focus = methods_window(text);
    let mut scan = if focus.len() >= 200 { focus } else { text };
    let mut low = scan.to_ascii_lowercase();
    let assay = classify(&low);
    // Some two-column single-cell PDFs isolate a late statistics subsection as
    // "Methods" while the actual workflow is described earlier. Recover the
    // named pipeline tools from the body once the assay itself is unambiguous.
    if assay == Assay::SingleCell
        && !mentions(
            &low,
            &[
                "cellranger",
                "cell ranger",
                "seurat",
                "soupx",
                "doubletfinder",
            ],
        )
    {
        scan = text;
        low = text.to_ascii_lowercase();
    }
    let tracks = detected_assays(&low);
    if tracks.len() > 1 {
        let candidates = tracks
            .into_iter()
            .flat_map(|track| {
                if track == Assay::Assembly {
                    build_assembly_candidates(catalog, scan, &low, CandidateRole::Parallel)
                } else {
                    let mut candidate = build_bricks(catalog, text, scan, &low, track);
                    candidate.role = CandidateRole::Parallel;
                    vec![candidate]
                }
            })
            .collect();
        return Reconstruction::new(candidates);
    }
    if assay == Assay::Assembly {
        return Reconstruction::new(build_assembly_candidates(
            catalog,
            scan,
            &low,
            CandidateRole::Primary,
        ));
    }
    Reconstruction::new(vec![build_bricks(catalog, text, scan, &low, assay)])
}

fn build_bricks(
    catalog: &Catalog,
    full: &str,
    scan: &str,
    low: &str,
    assay: Assay,
) -> CandidateGraph {
    let acc = accessions(full);
    let genome = genome_token(low);
    let mut warnings = Vec::new();
    let mut g = Graph {
        schema_version: SCHEMA_VERSION,
        nodes: vec![],
        edges: vec![],
    };

    let add = |g: &mut Graph, op: &str, params: Vec<(&str, ParamValue)>, note: Option<String>| {
        let Ok(oper) = catalog.get(op) else {
            return None;
        };
        let existing: Vec<String> = g.nodes.iter().map(|n| n.id.clone()).collect();
        let id = next_name(&existing, op, &params);
        let mut pmap = std::collections::BTreeMap::new();
        for (k, spec) in &oper.params {
            if let Some(d) = &spec.default {
                pmap.insert(k.clone(), d.clone());
            }
        }
        for (k, v) in params {
            pmap.insert(k.into(), v);
        }
        g.nodes.push(Node {
            id: id.clone(),
            operator: op.into(),
            ports: oper.ir_ports(),
            params: pmap,
            layout: Layout { x: 0.0, y: 0.0 },
            note,
        });
        Some(id)
    };

    let prefetch = if let Some(a) = acc.first() {
        add(
            &mut g,
            "sra.prefetch",
            vec![("accession", ParamValue::String(a.clone()))],
            Some(format!("accession {a} in the paper")),
        )
    } else {
        None
    };
    let fasterq = if prefetch.is_some() {
        add(
            &mut g,
            "sra.fasterq_dump",
            vec![],
            Some("SRA → FASTQ".into()),
        )
    } else {
        None
    };

    let named_nf_rnaseq = mentions(low, &["nf-core/rnaseq", "nf-core rnaseq"]);
    let named_nf_sarek = mentions(low, &["nf-core/sarek", "sarek"]);
    let named_nf_tax = mentions(low, &["nf-core/taxprofiler"]);
    let named_nf_mag = mentions(low, &["nf-core/mag"]);

    for (op, needles) in BRICKS {
        if !mentions(low, needles) {
            continue;
        }
        // A full protocol often names comparison tools from other assays. A
        // domain-incompatible mention is evidence, not a runnable step.
        if matches!(
            (*op, assay),
            (
                "align.star"
                    | "align.hisat2"
                    | "quant.featurecounts"
                    | "quant.salmon"
                    | "quant.stringtie"
                    | "diff.deseq2"
                    | "nf.rnaseq",
                Assay::Variants | Assay::Metagenome
            ) | (
                "align.bwa" | "var.haplotypecaller" | "nf.sarek",
                Assay::RnaSeq | Assay::Metagenome
            ) | (
                "class.kraken2" | "nf.mag" | "nf.taxprofiler",
                Assay::RnaSeq | Assay::Variants
            )
        ) {
            continue;
        }
        if *op == "nf.rnaseq" && !named_nf_rnaseq {
            continue;
        }
        if *op == "nf.sarek" && !named_nf_sarek {
            continue;
        }
        if *op == "nf.taxprofiler" && !named_nf_tax {
            continue;
        }
        if *op == "nf.mag" && !named_nf_mag {
            continue;
        }
        if named_nf_rnaseq && RNA_COMPOUND_COVERS.contains(op) {
            continue;
        }
        if named_nf_sarek && VAR_COMPOUND_COVERS.contains(op) {
            continue;
        }
        if (named_nf_tax || named_nf_mag) && MAG_COMPOUND_COVERS.contains(op) {
            continue;
        }
        if *op == "diff.deseq2"
            && !mentions(
                low,
                &[
                    "featurecounts",
                    "feature counts",
                    "rsubread",
                    "salmon",
                    "htseq",
                ],
            )
        {
            continue;
        }
        let q = needles.iter().find_map(|n| snippet(scan, n));
        add(&mut g, op, vec![], q);
    }

    for (tool, needles) in GAPS {
        if !mentions(low, needles) {
            continue;
        }
        if named_nf_rnaseq && ["Kallisto", "MultiQC"].contains(tool) {
            continue;
        }
        if named_nf_sarek && ["Picard", "Mutect2"].contains(tool) {
            continue;
        }
        let q = needles.iter().find_map(|n| snippet(scan, n));
        if let Some(id) = add(
            &mut g,
            "gap.missing",
            vec![
                ("tool", ParamValue::String((*tool).into())),
                ("quote", ParamValue::String(q.clone().unwrap_or_default())),
            ],
            q.or_else(|| Some(format!("paper used {tool}; not a brick yet — wrap it"))),
        ) {
            if let Some(n) = g.nodes.iter_mut().find(|n| n.id == id) {
                n.ports = match *tool {
                    "Ballgown" => vec![
                        p_in("in", PortType::Gtf, vec![PortType::Gtf]),
                        p_out("out", PortType::Table),
                    ],
                    "Picard" => vec![
                        p_in("in", PortType::Bam, vec![PortType::Bam]),
                        p_out("out", PortType::Bam),
                    ],
                    "Cell Ranger" => vec![
                        p_in(
                            "in",
                            PortType::Fastq,
                            vec![PortType::Fastq, PortType::FastqGz],
                        ),
                        p_out("out", PortType::Directory),
                    ],
                    "SoupX" | "Seurat" | "DoubletFinder" => vec![
                        p_in(
                            "in",
                            PortType::Directory,
                            vec![PortType::Directory, PortType::Table],
                        ),
                        p_out("out", PortType::Directory),
                    ],
                    "Kallisto" => vec![
                        p_in(
                            "in",
                            PortType::Fastq,
                            vec![PortType::Fastq, PortType::FastqGz],
                        ),
                        p_out("out", PortType::Table),
                    ],
                    _ => n.ports.clone(),
                };
            }
        }
    }

    if prefetch.is_none()
        && g.nodes
            .iter()
            .any(|n| n.operator != "gap.missing" || matches!(assay, Assay::Qc | Assay::SingleCell))
        && !g
            .nodes
            .iter()
            .any(|n| matches!(n.operator.as_str(), "files.import" | "files.import_paired"))
        && (assay == Assay::SingleCell
            || g.nodes.iter().any(|n| {
                matches!(
                    n.operator.as_str(),
                    "qc.fastqc"
                        | "qc.fastp"
                        | "align.star"
                        | "align.hisat2"
                        | "align.bwa"
                        | "quant.salmon"
                        | "class.kraken2"
                        | "nf.rnaseq"
                        | "nf.sarek"
                        | "nf.mag"
                        | "nf.taxprofiler"
                )
            }))
    {
        let source = if mentioned(low, &["paired-end", "paired end", "paired reads"]) {
            "files.import_paired"
        } else {
            "files.import"
        };
        add(
            &mut g,
            source,
            vec![],
            Some(if source == "files.import_paired" {
                "no SRA accession — drop the R1 and R2 FASTQs together".into()
            } else {
                "no SRA accession — drop a FASTQ on this node".into()
            }),
        );
    }

    let needs_fasta = g.nodes.iter().any(|n| {
        matches!(
            n.operator.as_str(),
            "align.star" | "align.hisat2" | "align.bwa" | "quant.salmon" | "nf.rnaseq"
        )
    });
    let fasta = if needs_fasta {
        genome.as_ref().and_then(|genome| {
            add(
                &mut g,
                "ensembl.fasta",
                vec![],
                Some(format!("reference {genome}")),
            )
        })
    } else {
        None
    };
    let gtf = if genome.is_some()
        && g.nodes.iter().any(|n| {
            matches!(
                n.operator.as_str(),
                "quant.featurecounts" | "quant.stringtie" | "nf.rnaseq"
            )
        }) {
        add(&mut g, "ensembl.gtf", vec![], Some("gene models".into()))
    } else {
        None
    };

    let sheet = if g.nodes.iter().any(|n| n.operator == "nf.rnaseq") {
        add(
            &mut g,
            "sheet.rnaseq",
            vec![],
            Some("nf-core samplesheet from the reads".into()),
        )
    } else {
        None
    };

    if g.nodes.is_empty() {
        warnings.push(
            "no tools or assay I could map. drop a methods section, not a cover page.".into(),
        );
    }
    if assay == Assay::Mixed {
        warnings.push(
            "multiple assay workflows detected; typed branches are shown together until named subworkflows land"
                .into(),
        );
    }

    if let (Some(a), Some(b)) = (&prefetch, &fasterq) {
        wire(&mut g, a, b);
    }
    let reads = fasterq.clone().or_else(|| {
        g.nodes
            .iter()
            .find(|n| matches!(n.operator.as_str(), "files.import" | "files.import_paired"))
            .map(|n| n.id.clone())
    });

    if let Some(src) = &reads {
        for n in g.nodes.clone() {
            if matches!(
                n.operator.as_str(),
                "qc.fastqc"
                    | "qc.fastp"
                    | "quant.salmon"
                    | "class.kraken2"
                    | "nf.sarek"
                    | "nf.mag"
                    | "nf.taxprofiler"
            ) {
                wire_reads(&mut g, src, &n.id);
            }
        }
    }
    let trimmed = g
        .nodes
        .iter()
        .find(|n| n.operator == "qc.fastp")
        .map(|n| n.id.clone())
        .or(reads.clone());
    if let Some(src) = &trimmed {
        for n in g.nodes.clone() {
            if matches!(
                n.operator.as_str(),
                "align.star" | "align.hisat2" | "align.bwa"
            ) {
                wire_reads(&mut g, src, &n.id);
            }
        }
    }
    if let Some(fa) = &fasta {
        for n in g.nodes.clone() {
            if matches!(
                n.operator.as_str(),
                "align.star"
                    | "align.hisat2"
                    | "align.bwa"
                    | "quant.salmon"
                    | "var.haplotypecaller"
            ) {
                wire(&mut g, fa, &n.id);
            }
        }
    }
    for aligner in g.nodes.clone() {
        let downstream: &[&str] = match aligner.operator.as_str() {
            "align.star" | "align.hisat2" => &["quant.featurecounts", "quant.stringtie"],
            "align.bwa" => &["var.haplotypecaller"],
            _ => continue,
        };
        for n in g.nodes.clone() {
            if downstream.contains(&n.operator.as_str()) {
                wire(&mut g, &aligner.id, &n.id);
            }
        }
    }
    if let Some(gt) = &gtf {
        for n in g.nodes.clone() {
            if matches!(
                n.operator.as_str(),
                "quant.featurecounts" | "quant.stringtie"
            ) {
                wire(&mut g, gt, &n.id);
            }
        }
    }
    let counts = g
        .nodes
        .iter()
        .find(|n| n.operator == "quant.featurecounts" || n.operator == "quant.salmon")
        .map(|n| n.id.clone());
    if let (Some(c), Some(de)) = (
        &counts,
        g.nodes
            .iter()
            .find(|n| n.operator == "diff.deseq2")
            .map(|n| n.id.clone()),
    ) {
        wire(&mut g, c, &de);
    }
    if let Some(st) = g
        .nodes
        .iter()
        .find(|n| n.operator == "quant.stringtie")
        .map(|n| n.id.clone())
    {
        if let Some(bg) = g
            .nodes
            .iter()
            .find(|n| n.params.get("tool") == Some(&ParamValue::String("Ballgown".into())))
            .map(|n| n.id.clone())
        {
            wire(&mut g, &st, &bg);
        }
    }
    if let Some(bw) = g
        .nodes
        .iter()
        .find(|n| n.operator == "align.bwa")
        .map(|n| n.id.clone())
    {
        if let Some(pic) = g
            .nodes
            .iter()
            .find(|n| n.params.get("tool") == Some(&ParamValue::String("Picard".into())))
            .map(|n| n.id.clone())
        {
            wire(&mut g, &bw, &pic);
            if let Some(hc) = g
                .nodes
                .iter()
                .find(|n| n.operator == "var.haplotypecaller")
                .map(|n| n.id.clone())
            {
                wire(&mut g, &pic, &hc);
            }
        }
    }
    if let (Some(src), Some(sh)) = (trimmed.as_ref().or(reads.as_ref()), &sheet) {
        wire_reads(&mut g, src, sh);
    }
    if let Some(nf) = g
        .nodes
        .iter()
        .find(|n| n.operator == "nf.rnaseq")
        .map(|n| n.id.clone())
    {
        if let Some(sh) = &sheet {
            wire(&mut g, sh, &nf);
        }
        if let Some(fa) = &fasta {
            wire(&mut g, fa, &nf);
        }
        if let Some(gt) = &gtf {
            wire(&mut g, gt, &nf);
        }
    }

    // leftover gaps: snap to the nearest typed neighbour so nothing sits isolated
    let mut prev: Option<String> = reads.clone();
    for n in g.nodes.clone() {
        if n.operator == "gap.missing" {
            if let Some(p) = &prev {
                wire(&mut g, p, &n.id);
            }
            prev = Some(n.id);
        }
    }

    layout(&mut g);
    if let Err(e) = g.validate() {
        warnings.push(format!("graph did not validate: {e}"));
    }
    CandidateGraph {
        name: candidate_name(assay).into(),
        role: CandidateRole::Primary,
        evidence: evidence_ledger(&g),
        graph: g,
        assay,
        warnings,
    }
}

fn classify(low: &str) -> Assay {
    let mut ranked = assay_scores(low);
    ranked.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    let (assay, score) = ranked[0];
    if score >= 6 && ranked[1].1 >= 6 {
        return Assay::Mixed;
    }
    if score > 0 {
        assay
    } else if low.contains("fastqc") {
        Assay::Qc
    } else {
        Assay::Unknown
    }
}

fn detected_assays(low: &str) -> Vec<Assay> {
    let mut tracks = assay_scores(low)
        .into_iter()
        .filter(|(_, score)| *score >= 6)
        .collect::<Vec<_>>();
    tracks.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    tracks.into_iter().map(|(assay, _)| assay).collect()
}

fn assay_scores(low: &str) -> [(Assay, u16); 5] {
    [
        (
            Assay::Assembly,
            evidence_score(
                low,
                &[
                    ("hifiasm", 5),
                    ("yahs", 4),
                    ("genomescope", 3),
                    ("mitohifi", 4),
                    ("blobtools", 3),
                    ("chromosome-scale assembl", 4),
                    ("chromosome scale assembl", 4),
                    ("haplotype assembl", 4),
                    ("pacbio hifi", 2),
                    ("falcon", 4),
                    ("purge_dups", 4),
                    ("purge haplotigs", 4),
                    ("iterative assembly pipeline", 5),
                    ("vertebrate genome project", 5),
                ],
            ),
        ),
        (
            Assay::RnaSeq,
            evidence_score(
                low,
                &[
                    ("nf-core/rnaseq", 6),
                    ("hisat2", 4),
                    ("stringtie", 4),
                    ("rna-seq", 2),
                    ("rna seq", 2),
                    ("rnaseq", 2),
                    ("pseudoalign", 3),
                    ("differential expression", 3),
                ],
            ),
        ),
        (
            Assay::Variants,
            evidence_score(
                low,
                &[
                    ("gatk best practices", 6),
                    ("haplotypecaller", 5),
                    ("gatk haplot", 5),
                    ("variant call", 4),
                    ("mutect", 4),
                    ("sarek", 5),
                    ("somatic", 3),
                    ("germline", 3),
                    ("whole genome sequenc", 2),
                ],
            ),
        ),
        (
            Assay::Metagenome,
            evidence_score(
                low,
                &[
                    ("kraken 2", 6),
                    ("kraken2", 6),
                    ("nf-core/mag", 6),
                    ("nf-core/taxprofiler", 6),
                    ("metagenom", 4),
                    ("metabat", 4),
                ],
            ),
        ),
        (
            Assay::SingleCell,
            evidence_score(
                low,
                &[
                    ("single-cell rna", 6),
                    ("single cell rna", 6),
                    ("scrna", 5),
                    ("cellranger", 5),
                    ("cell ranger", 5),
                    ("seurat", 4),
                    ("doubletfinder", 4),
                    ("soupx", 4),
                ],
            ),
        ),
    ]
}

fn candidate_name(assay: Assay) -> &'static str {
    match assay {
        Assay::Assembly => "Assembly methods",
        Assay::RnaSeq => "RNA-seq methods",
        Assay::Variants => "Variant methods",
        Assay::Metagenome => "Metagenome methods",
        Assay::SingleCell => "Single-cell methods",
        Assay::Mixed => "Mixed methods",
        Assay::Qc => "Quality-control methods",
        Assay::Unknown => "Unresolved methods",
    }
}

fn evidence_score(low: &str, cues: &[(&str, u8)]) -> u16 {
    cues.iter()
        .filter(|(cue, _)| contains_positive(low, cue))
        .map(|(_, weight)| u16::from(*weight))
        .sum()
}

fn build_assembly_candidates(
    catalog: &Catalog,
    text: &str,
    low: &str,
    single_role: CandidateRole,
) -> Vec<CandidateGraph> {
    let methods = detected_assembly_methods(low);
    if methods.len() > 1 {
        methods
            .into_iter()
            .map(|method| {
                build_assembly(catalog, text, low, Some(method), CandidateRole::Alternative)
            })
            .collect()
    } else {
        vec![build_assembly(
            catalog,
            text,
            low,
            methods.first().copied(),
            single_role,
        )]
    }
}

fn detected_assembly_methods(low: &str) -> Vec<&'static AssemblyMethod> {
    let mut methods = ASSEMBLY_METHODS
        .iter()
        .filter_map(|method| {
            method
                .needles
                .iter()
                .filter_map(|needle| {
                    first_term_position(low, needle).map(|position| (position, method))
                })
                .min_by_key(|(position, _)| *position)
        })
        .collect::<Vec<_>>();
    methods.sort_by_key(|(position, _)| *position);
    methods.into_iter().map(|(_, method)| method).collect()
}

fn first_term_position(low: &str, needle: &str) -> Option<usize> {
    low.match_indices(needle).find_map(|(position, _)| {
        let before = low[..position].chars().next_back();
        let after = low[position + needle.len()..].chars().next();
        let bounded = before.is_none_or(|ch| !ch.is_ascii_alphanumeric())
            && after.is_none_or(|ch| !ch.is_ascii_alphanumeric());
        (bounded && contains_positive(low, needle)).then_some(position)
    })
}

fn build_assembly(
    catalog: &Catalog,
    text: &str,
    low: &str,
    method: Option<&AssemblyMethod>,
    role: CandidateRole,
) -> CandidateGraph {
    let mut warnings = Vec::new();
    let mut g = Graph {
        schema_version: SCHEMA_VERSION,
        nodes: vec![],
        edges: vec![],
    };
    let add = |g: &mut Graph, op: &str, params: Vec<(&str, ParamValue)>, note: Option<String>| {
        let Ok(oper) = catalog.get(op) else {
            return None;
        };
        let existing: Vec<String> = g.nodes.iter().map(|n| n.id.clone()).collect();
        let id = next_name(&existing, op, &params);
        let mut pmap = std::collections::BTreeMap::new();
        for (k, spec) in &oper.params {
            if let Some(d) = &spec.default {
                pmap.insert(k.clone(), d.clone());
            }
        }
        for (k, v) in params {
            pmap.insert(k.into(), v);
        }
        g.nodes.push(Node {
            id: id.clone(),
            operator: op.into(),
            ports: oper.ir_ports(),
            params: pmap,
            layout: Layout { x: 0.0, y: 0.0 },
            note,
        });
        Some(id)
    };
    let gap = |g: &mut Graph, tool: &str, note: Option<String>, ports: Vec<Port>| {
        let id = add(
            g,
            "gap.missing",
            vec![
                ("tool", ParamValue::String(tool.into())),
                (
                    "quote",
                    ParamValue::String(note.clone().unwrap_or_default()),
                ),
            ],
            note,
        );
        if let Some(id) = &id {
            if let Some(n) = g.nodes.iter_mut().find(|n| n.id == *id) {
                n.ports = ports;
            }
        }
        id
    };

    let hifi = add(
        &mut g,
        "files.import",
        vec![],
        Some("drop PacBio HiFi reads here".into()),
    );
    let hic = if mentioned(low, &["hi-c", "hic"]) {
        gap(
            &mut g,
            "Hi-C",
            snippet(text, "Hi-C").or_else(|| snippet(text, "HiC")),
            gap_reads(),
        )
    } else {
        None
    };
    let gs = if mentioned(low, &["genomescope"]) {
        gap(
            &mut g,
            "Genomescope",
            snippet(text, "Genomescope"),
            gap_from_reads(),
        )
    } else {
        None
    };
    let mut lineage = "arthropoda_odb10".to_string();
    for lin in [
        "arthropoda_odb10",
        "eukaryota_odb10",
        "bacteria_odb10",
        "fungi_odb10",
    ] {
        if low.contains(lin) {
            lineage = lin.into();
            break;
        }
    }
    let asm = match method.map(|method| method.key) {
        Some("hifiasm") => add(
            &mut g,
            "asm.hifiasm",
            vec![],
            snippet(text, "hifiasm").or_else(|| Some("hifiasm (HiFi ± Hi-C phasing)".into())),
        ),
        Some(key) => {
            let method = ASSEMBLY_METHODS
                .iter()
                .find(|method| method.key == key)
                .copied();
            method.and_then(|method| {
                let note = method
                    .needles
                    .iter()
                    .find_map(|needle| snippet(text, needle));
                gap(&mut g, method.name, note, gap_from_reads())
            })
        }
        None => add(
            &mut g,
            "asm.hifiasm",
            vec![],
            Some("assembler not named — hifiasm is the default HiFi brick".into()),
        ),
    };
    let purge = if mentioned(low, &["purge_dups", "purge haplotigs", "purge_haplotigs"]) {
        gap(
            &mut g,
            "Purge_Dups",
            snippet(text, "Purge_Dups").or_else(|| snippet(text, "Purge_Haplotigs")),
            gap_from_asm(),
        )
    } else {
        None
    };
    let yahs = if mentioned(low, &["yahs"]) {
        add(&mut g, "asm.yahs", vec![], snippet(text, "YaHS"))
    } else if mentioned(low, &["salsa"]) {
        gap(&mut g, "Salsa", snippet(text, "Salsa"), gap_from_asm())
    } else {
        None
    };
    let blob = if mentioned(low, &["blobtools", "blobtoolkit"]) {
        gap(
            &mut g,
            "Blobtools",
            snippet(text, "Blobtools"),
            gap_from_asm(),
        )
    } else {
        None
    };
    let busco = if mentioned(low, &["busco"]) {
        let mut n = snippet(text, "BUSCO").unwrap_or_else(|| "BUSCO completeness".into());
        n.push_str(&format!("  lineage {lineage}"));
        add(
            &mut g,
            "qc.busco",
            vec![("lineage", ParamValue::String(lineage.clone()))],
            Some(n),
        )
    } else {
        None
    };
    let merqury = if mentioned(low, &["merqury"]) {
        gap(&mut g, "Merqury", snippet(text, "Merqury"), gap_from_asm())
    } else {
        None
    };
    let mito = if mentioned(low, &["mitohifi"]) {
        gap(
            &mut g,
            "MitoHiFi",
            snippet(text, "MitoHiFi"),
            gap_from_reads(),
        )
    } else {
        None
    };
    let bakta = if mentioned(low, &["bakta"]) {
        gap(&mut g, "Bakta", snippet(text, "bakta"), gap_from_asm())
    } else {
        None
    };
    let iso = if mentioned(low, &["iso-seq", "isoseq", "iso seq"]) {
        gap(
            &mut g,
            "Iso-Seq",
            snippet(text, "Iso-Seq").or_else(|| snippet(text, "Iso-seq")),
            gap_transcripts(),
        )
    } else {
        None
    };
    let mm = if mentioned(low, &["minimap"]) {
        add(&mut g, "align.minimap2", vec![], snippet(text, "minimap2"))
    } else {
        None
    };
    let aug = if mentioned(low, &["augustus"]) {
        gap(
            &mut g,
            "Augustus",
            snippet(text, "Augustus"),
            gap_from_asm(),
        )
    } else {
        None
    };

    if let (Some(a), Some(b)) = (&hifi, &asm) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&hic, &asm) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&hifi, &gs) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&hifi, &mito) {
        wire(&mut g, a, b);
    }
    let mut prev = asm.clone();
    for nxt in [&purge, &yahs, &blob] {
        if let (Some(a), Some(b)) = (&prev, nxt) {
            wire(&mut g, a, b);
            prev = Some(b.clone());
        } else if nxt.is_some() {
            prev = nxt.clone();
        }
    }
    if let (Some(a), Some(b)) = (&prev, &busco) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&busco, &merqury) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&hic, &yahs) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&blob, &bakta) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&iso, &mm) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (&asm, &mm) {
        wire(&mut g, a, b);
    }
    if let (Some(a), Some(b)) = (mm.as_ref().or(iso.as_ref()), aug.as_ref()) {
        wire(&mut g, a, b);
    }

    place(&mut g, hic.as_deref(), 1, 0);
    place(&mut g, hifi.as_deref(), 0, 1);
    place(&mut g, asm.as_deref(), 1, 1);
    place(&mut g, purge.as_deref(), 2, 1);
    place(&mut g, yahs.as_deref(), 3, 1);
    place(&mut g, blob.as_deref(), 4, 1);
    place(&mut g, busco.as_deref(), 5, 1);
    place(&mut g, merqury.as_deref(), 6, 1);
    place(&mut g, gs.as_deref(), 0, 2);
    place(&mut g, mito.as_deref(), 1, 2);
    place(&mut g, bakta.as_deref(), 4, 2);
    place(&mut g, iso.as_deref(), 0, 3);
    place(&mut g, mm.as_deref(), 1, 3);
    place(&mut g, aug.as_deref(), 2, 3);
    if let Err(e) = g.validate() {
        warnings.push(format!("graph did not validate: {e}"));
    }
    CandidateGraph {
        name: method
            .map(|method| format!("{} assembly", method.name))
            .unwrap_or_else(|| "Assembly methods".into()),
        role,
        evidence: evidence_ledger(&g),
        graph: g,
        assay: Assay::Assembly,
        warnings,
    }
}

fn evidence_ledger(graph: &Graph) -> Vec<EvidenceRecord> {
    let mut ledger = graph
        .nodes
        .iter()
        .map(|node| {
            let status = if node.operator == "gap.missing" {
                EvidenceStatus::MissingImplementation
            } else if node.note.as_deref().is_some_and(is_inferred_note) {
                EvidenceStatus::Inferred
            } else if node.note.is_some() {
                EvidenceStatus::Explicit
            } else {
                EvidenceStatus::Inferred
            };
            let detail = node.note.clone().unwrap_or_else(|| {
                format!(
                    "{} was inferred from typed workflow compatibility; no direct evidence span was retained",
                    node.operator
                )
            });
            EvidenceRecord {
                target: EvidenceTarget::Node(node.id.clone()),
                status,
                detail,
            }
        })
        .collect::<Vec<_>>();
    ledger.extend(graph.edges.iter().map(|edge| EvidenceRecord {
        target: EvidenceTarget::Edge(edge.id.clone()),
        status: EvidenceStatus::Inferred,
        detail: format!(
            "{}:{} → {}:{} was inferred from typed compatibility and canonical method order",
            edge.from_node, edge.from_port, edge.to_node, edge.to_port
        ),
    }));
    ledger
}

fn is_inferred_note(note: &str) -> bool {
    let note = note.to_ascii_lowercase();
    [
        "no sra accession",
        "drop pacbio",
        "drop a fastq",
        "drop the r1",
        "not named",
        " is the default ",
        "sra → fastq",
        "gene models",
        "samplesheet from the reads",
    ]
    .iter()
    .any(|marker| note.contains(marker))
        || note.starts_with("reference ")
}

fn contains_any(s: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| contains_positive(s, n))
}

fn contains_positive(s: &str, needle: &str) -> bool {
    let mut i = 0;
    while let Some(j) = s[i..].find(needle) {
        let at = i + j;
        let before = s[..at].trim_end_matches(|c: char| !c.is_ascii_alphabetic());
        let denied = before.ends_with(" no")
            || before.ends_with(" not")
            || before.ends_with(" without")
            || before == "no"
            || before == "not";
        if !denied {
            return true;
        }
        i = at + needle.len();
    }
    false
}

fn mentioned(low: &str, needles: &[&str]) -> bool {
    contains_any(low, needles)
}

fn has_word(low: &str, word: &str) -> bool {
    let w = word.as_bytes();
    let b = low.as_bytes();
    if w.is_empty() || b.len() < w.len() {
        return false;
    }
    let mut i = 0;
    while i + w.len() <= b.len() {
        if &b[i..i + w.len()] == w {
            let before = i == 0 || !b[i - 1].is_ascii_alphanumeric();
            let after = i + w.len() == b.len() || !b[i + w.len()].is_ascii_alphanumeric();
            if before && after {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn mentions(low: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| {
        if n.len() <= 4 {
            has_word(low, n)
        } else {
            low.contains(n)
        }
    })
}

/// Prefer the actual methods section so references and comparison prose do not
/// spawn tools. `pdftotext -layout` can put a two-column heading at either the
/// start or the far right of a line, and Nature PDFs commonly attach it to a
/// form-feed. Match those layouts rather than arbitrary occurrences of the word.
pub fn methods_window(text: &str) -> &str {
    const STARTS: &[&str] = &[
        "materials and methods",
        "materials & methods",
        "online methods",
        "experimental procedures",
        "methods",
        "method",
    ];
    const ENDS: &[&str] = &[
        "results",
        "discussion",
        "data availability",
        "code availability",
        "acknowledgements",
        "acknowledgments",
        "author contributions",
        "competing interests",
        "references",
        "bibliography",
    ];

    let front: String = text
        .chars()
        .take(2048)
        .collect::<String>()
        .to_ascii_lowercase();
    if front.contains("type methods")
        || (front.contains("subjects:") && front.contains("bioinformatics, methods"))
    {
        let end = find_heading(text, &["references", "bibliography"], 0).unwrap_or(text.len());
        let body = &text[..end];
        if body.len() >= 200 {
            return body;
        }
    }

    if let Some(start) = find_heading(text, STARTS, 0) {
        // A lone reporting-checklist heading at the very end is not the paper's
        // Methods section. In that case the body fallback below is safer.
        if start.saturating_mul(10) < text.len().saturating_mul(9) {
            let search_from = next_line(text, start);
            let end = find_heading(text, ENDS, search_from).unwrap_or(text.len());
            let slice = &text[start..end];
            if slice.len() >= 200 {
                return slice;
            }
        }
    }

    // Tutorials and protocol papers sometimes have no literal Methods heading.
    // Keep their body, but exclude a real references/bibliography heading.
    let end = find_heading(text, &["references", "bibliography"], 0).unwrap_or(text.len());
    let body = &text[..end];
    if body.len() >= 200 {
        body
    } else {
        text
    }
}

fn next_line(text: &str, at: usize) -> usize {
    text[at..]
        .find('\n')
        .map(|n| at + n + 1)
        .unwrap_or(text.len())
}

fn find_heading(text: &str, headings: &[&str], from: usize) -> Option<usize> {
    let mut offset = from;
    for line in text[from..].split_inclusive('\n') {
        if let Some(in_line) = heading_in_line(line, headings) {
            return Some(offset + in_line);
        }
        offset += line.len();
    }
    None
}

fn heading_in_line(line: &str, headings: &[&str]) -> Option<usize> {
    let low = line.to_ascii_lowercase();
    let content_end = low.trim_end_matches(char::is_whitespace).len();
    let content = &low[..content_end];
    let first = content
        .char_indices()
        .find(|(_, c)| !c.is_whitespace() && *c != '\u{c}')
        .map(|(i, _)| i)?;

    for heading in headings {
        if content[first..].starts_with(heading) {
            let rest = &content[first + heading.len()..];
            let gutter = rest.chars().take_while(|c| c.is_whitespace()).count();
            if rest.is_empty()
                || rest
                    .chars()
                    .next()
                    .is_some_and(|c| matches!(c, ':' | '.' | '\u{c}'))
                || (gutter >= 4 && gutter < rest.chars().count())
            {
                return Some(first);
            }
        }

        // In two-column layout the left column can end on the same line where
        // the right column begins with a heading. Require a wide gutter so
        // prose such as "see the Methods" is never accepted as a heading.
        if content.ends_with(heading) {
            let at = content.len() - heading.len();
            let gutter = content[..at]
                .chars()
                .rev()
                .take_while(|c| c.is_whitespace())
                .count();
            if gutter >= 4 {
                return Some(at);
            }
        }
    }
    None
}

fn accessions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for w in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        let u = w.to_ascii_uppercase();
        if u.len() < 6 {
            continue;
        }
        let prefix_ok = u.starts_with("SRR")
            || u.starts_with("ERR")
            || u.starts_with("DRR")
            || u.starts_with("SRS")
            || u.starts_with("ERS");
        if prefix_ok && u.chars().skip(3).all(|c| c.is_ascii_digit()) && !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

fn genome_token(low: &str) -> Option<&'static str> {
    for (n, v) in [
        ("grch38", "GRCh38"),
        ("hg38", "GRCh38"),
        ("grch37", "GRCh37"),
        ("hg19", "GRCh37"),
        ("grcm39", "GRCm39"),
        ("mm39", "GRCm39"),
        ("mm10", "GRCm38"),
        ("t2t", "T2T-CHM13"),
    ] {
        if low.contains(n) {
            return Some(v);
        }
    }
    None
}

fn snippet(text: &str, needle: &str) -> Option<String> {
    let low = text.to_ascii_lowercase();
    let n = needle.to_ascii_lowercase();
    let i = low.find(&n)?;
    let start = i.saturating_sub(48);
    let end = (i + n.len() + 48).min(text.len());
    let s = text[start..end].trim();
    if s.is_empty() {
        return None;
    }
    Some(s.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn short_leaf(op: &str, params: &[(&str, ParamValue)]) -> String {
    if op == "gap.missing" {
        if let Some((_, ParamValue::String(t))) = params.iter().find(|(k, _)| *k == "tool") {
            let s: String = t
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .flat_map(|c| c.to_lowercase())
                .collect();
            if !s.is_empty() {
                return s;
            }
        }
    }
    match op {
        "sra.prefetch" => "prefetch".into(),
        "sra.fasterq_dump" => "fasterq".into(),
        "qc.fastqc" => "fastqc".into(),
        "qc.fastp" => "fastp".into(),
        "nf.rnaseq" => "rnaseq".into(),
        "nf.sarek" => "sarek".into(),
        "nf.mag" => "mag".into(),
        "nf.taxprofiler" => "taxprofiler".into(),
        "asm.hifiasm" => "hifiasm".into(),
        "asm.yahs" => "yahs".into(),
        "qc.busco" => "busco".into(),
        "files.import" => "import".into(),
        "files.import_paired" => "reads".into(),
        "sheet.rnaseq" => "sheet".into(),
        "ensembl.fasta" => "fasta".into(),
        "ensembl.gtf" => "gtf".into(),
        "align.star" => "star".into(),
        "align.hisat2" => "hisat2".into(),
        "align.bwa" => "bwa".into(),
        "align.minimap2" => "minimap2".into(),
        "quant.featurecounts" => "featurecounts".into(),
        "quant.salmon" => "salmon".into(),
        "quant.stringtie" => "stringtie".into(),
        "diff.deseq2" => "deseq2".into(),
        "class.kraken2" => "kraken2".into(),
        "var.haplotypecaller" => "gatk".into(),
        _ => op.rsplit('.').next().unwrap_or(op).to_string(),
    }
}

fn next_name(existing: &[String], op: &str, params: &[(&str, ParamValue)]) -> String {
    let leaf = short_leaf(op, params);
    if !existing.iter().any(|id| id == &leaf) {
        return leaf;
    }
    let mut i = 2u32;
    loop {
        let cand = format!("{leaf}{i}");
        if !existing.iter().any(|id| id == &cand) {
            return cand;
        }
        i += 1;
    }
}

fn wire(g: &mut Graph, from: &str, to: &str) {
    let Some(a) = g.node(from).cloned() else {
        return;
    };
    let Some(b) = g.node(to).cloned() else { return };
    for ap in a.ports.iter().filter(|p| p.dir == Direction::Out) {
        for bp in b.ports.iter().filter(|p| p.dir == Direction::In) {
            if !compatible(ap.ty, bp.ty, &bp.union) {
                continue;
            }
            if g.edges
                .iter()
                .any(|e| e.to_node == to && e.to_port == bp.name)
            {
                continue;
            }
            g.edges.push(Edge {
                id: format!("e_{from}_{}_{to}_{}", ap.name, bp.name),
                from_node: from.into(),
                from_port: ap.name.clone(),
                to_node: to.into(),
                to_port: bp.name.clone(),
            });
            return;
        }
    }
}

/// Keep paired reads as two named streams whenever both operators expose the
/// paired contract. Operators without r1/r2 ports retain the normal typed snap.
fn wire_reads(g: &mut Graph, from: &str, to: &str) {
    let Some(source) = g.node(from).cloned() else {
        return;
    };
    let Some(target) = g.node(to).cloned() else {
        return;
    };
    let mut connected = false;
    for mate in ["r1", "r2"] {
        let Some(output) = source.port(mate, Direction::Out) else {
            continue;
        };
        let Some(input) = target.port(mate, Direction::In) else {
            continue;
        };
        if !compatible(output.ty, input.ty, &input.union)
            || g.edges
                .iter()
                .any(|edge| edge.to_node == to && edge.to_port == mate)
        {
            continue;
        }
        g.edges.push(Edge {
            id: format!("e_{from}_{mate}_{to}_{mate}"),
            from_node: from.into(),
            from_port: mate.into(),
            to_node: to.into(),
            to_port: mate.into(),
        });
        connected = true;
    }
    if !connected {
        wire(g, from, to);
    }
}

fn p_out(name: &str, ty: PortType) -> Port {
    Port {
        name: name.into(),
        dir: Direction::Out,
        ty,
        union: vec![],
        optional: false,
    }
}

fn p_in(name: &str, ty: PortType, union: Vec<PortType>) -> Port {
    Port {
        name: name.into(),
        dir: Direction::In,
        ty,
        union,
        optional: false,
    }
}

fn p_in_opt(name: &str, ty: PortType, union: Vec<PortType>) -> Port {
    Port {
        name: name.into(),
        dir: Direction::In,
        ty,
        union,
        optional: true,
    }
}

fn gap_reads() -> Vec<Port> {
    vec![p_out("out", PortType::Fastq)]
}

fn gap_transcripts() -> Vec<Port> {
    vec![p_out("out", PortType::Fasta)]
}

fn gap_from_reads() -> Vec<Port> {
    vec![
        p_in(
            "in",
            PortType::Fastq,
            vec![
                PortType::Fastq,
                PortType::FastqGz,
                PortType::Fasta,
                PortType::FastaGz,
            ],
        ),
        p_out("out", PortType::Directory),
    ]
}

fn gap_from_asm() -> Vec<Port> {
    vec![
        p_in(
            "in",
            PortType::Directory,
            vec![
                PortType::Directory,
                PortType::Fasta,
                PortType::FastaGz,
                PortType::Bam,
            ],
        ),
        p_in_opt(
            "hic",
            PortType::Fastq,
            vec![PortType::Fastq, PortType::FastqGz],
        ),
        p_out("out", PortType::Directory),
    ]
}

fn place(g: &mut Graph, id: Option<&str>, col: i32, row: i32) {
    let Some(id) = id else { return };
    if let Some(n) = g.nodes.iter_mut().find(|n| n.id == id) {
        n.layout.x = 48.0 + col as f32 * 260.0;
        n.layout.y = 48.0 + row as f32 * 200.0;
    }
}

fn layout(g: &mut Graph) {
    let order = g.topo();
    let mut layer: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for id in &order {
        let mut l = 0usize;
        for e in &g.edges {
            if e.to_node == *id {
                l = l.max(layer.get(&e.from_node).copied().unwrap_or(0) + 1);
            }
        }
        layer.insert(id.clone(), l);
    }
    for n in &g.nodes {
        layer.entry(n.id.clone()).or_insert(0);
    }
    let max_l = layer.values().copied().max().unwrap_or(0);
    for n in &g.nodes {
        if n.operator.starts_with("nf.") {
            layer.insert(n.id.clone(), max_l + 1);
        }
    }
    let mut cols: std::collections::BTreeMap<usize, Vec<String>> =
        std::collections::BTreeMap::new();
    for n in &g.nodes {
        cols.entry(*layer.get(&n.id).unwrap_or(&0))
            .or_default()
            .push(n.id.clone());
    }
    for (col, ids) in &cols {
        for (row, id) in ids.iter().enumerate() {
            if let Some(n) = g.nodes.iter_mut().find(|n| n.id == *id) {
                n.layout.x = 48.0 + *col as f32 * 260.0;
                n.layout.y = 64.0 + row as f32 * 180.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cat() -> Catalog {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators");
        Catalog::load_dir(&p).unwrap()
    }

    const RNA: &str = r#"
RNA-seq was performed on Illumina NovaSeq. Raw reads (SRR12345678) were
quality-checked with FastQC v0.12 and trimmed with fastp. Reads were aligned
with STAR v2.7.10a to GRCh38. Gene counts used featureCounts. Differential
expression was computed with DESeq2.
"#;

    const QC: &str = "Libraries were inspected with FastQC before further analysis.";

    const VAR: &str = r#"
Whole genome sequencing libraries were aligned with BWA-MEM. Somatic variants
were called with GATK Mutect2 following the sarek workflow.
"#;

    fn ops(r: &Reconstruction) -> Vec<&str> {
        r.graph.nodes.iter().map(|n| n.operator.as_str()).collect()
    }

    fn assert_wired(r: &Reconstruction) {
        r.graph.validate().unwrap();
        for n in &r.graph.nodes {
            let deg = r
                .graph
                .edges
                .iter()
                .filter(|e| e.from_node == n.id || e.to_node == n.id)
                .count();
            assert!(deg > 0, "node {} ({}) has no edges", n.id, n.operator);
        }
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../testdata/papers")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn rnaseq_paper_builds_a_brick_dag() {
        let r = reconstruct(&cat(), RNA);
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(&r);
        assert!(ops.contains(&"sra.prefetch"), "{ops:?}");
        assert!(ops.contains(&"sra.fasterq_dump"));
        assert!(ops.contains(&"qc.fastqc"));
        assert!(ops.contains(&"qc.fastp"));
        assert!(
            ops.contains(&"align.star"),
            "STAR is a brick, not buried in nf-core"
        );
        assert!(ops.contains(&"quant.featurecounts"));
        assert!(ops.contains(&"diff.deseq2"));
        assert!(
            !ops.contains(&"nf.rnaseq"),
            "paper did not name nf-core/rnaseq"
        );
        let fasterq = r
            .graph
            .nodes
            .iter()
            .find(|n| n.operator == "sra.fasterq_dump")
            .unwrap();
        let fastp = r
            .graph
            .nodes
            .iter()
            .find(|n| n.operator == "qc.fastp")
            .unwrap();
        let star = r
            .graph
            .nodes
            .iter()
            .find(|n| n.operator == "align.star")
            .unwrap();
        for mate in ["r1", "r2"] {
            assert!(
                r.graph.edges.iter().any(|edge| {
                    edge.from_node == fasterq.id
                        && edge.from_port == mate
                        && edge.to_node == fastp.id
                        && edge.to_port == mate
                }),
                "fasterq {mate} should remain a separate fastp input"
            );
            assert!(
                r.graph.edges.iter().any(|edge| {
                    edge.from_node == fastp.id
                        && edge.from_port == mate
                        && edge.to_node == star.id
                        && edge.to_port == mate
                }),
                "trimmed {mate} should remain a separate STAR input"
            );
        }
        let pref = r
            .graph
            .nodes
            .iter()
            .find(|n| n.operator == "sra.prefetch")
            .unwrap();
        match pref.params.get("accession") {
            Some(ParamValue::String(s)) => assert_eq!(s, "SRR12345678"),
            _ => panic!("accession"),
        }
        assert!(
            r.graph.edges.iter().any(|e| {
                r.graph.node(&e.from_node).map(|n| n.operator.as_str()) == Some("align.star")
                    && r.graph.node(&e.to_node).map(|n| n.operator.as_str())
                        == Some("quant.featurecounts")
            }),
            "STAR should snap to featureCounts"
        );
        assert!(
            r.graph.edges.iter().any(|e| {
                r.graph.node(&e.from_node).map(|n| n.operator.as_str())
                    == Some("quant.featurecounts")
                    && r.graph.node(&e.to_node).map(|n| n.operator.as_str()) == Some("diff.deseq2")
            }),
            "counts should snap to DESeq2"
        );
        assert_wired(&r);
    }

    #[test]
    fn local_paired_reads_remain_separate_without_an_accession() {
        let r = reconstruct(
            &cat(),
            "Paired-end RNA-seq reads were trimmed with fastp and aligned to the genome with STAR.",
        );
        let source = r
            .graph
            .nodes
            .iter()
            .find(|node| node.operator == "files.import_paired")
            .unwrap();
        let fastp = r
            .graph
            .nodes
            .iter()
            .find(|node| node.operator == "qc.fastp")
            .unwrap();
        for mate in ["r1", "r2"] {
            assert!(r.graph.edges.iter().any(|edge| {
                edge.from_node == source.id
                    && edge.from_port == mate
                    && edge.to_node == fastp.id
                    && edge.to_port == mate
            }));
        }
        r.graph.validate().unwrap();
    }

    #[test]
    fn nfcore_named_hides_star_inside_the_compound() {
        let r = reconstruct(&cat(), &fixture("nfcore_rnaseq_methods.txt"));
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(&r);
        assert!(ops.contains(&"nf.rnaseq"), "{ops:?}");
        assert!(ops.contains(&"sheet.rnaseq"));
        assert!(ops.contains(&"qc.fastqc"));
        let fasterq = r
            .graph
            .nodes
            .iter()
            .find(|node| node.operator == "sra.fasterq_dump")
            .unwrap();
        let sheet = r
            .graph
            .nodes
            .iter()
            .find(|node| node.operator == "sheet.rnaseq")
            .unwrap();
        for mate in ["r1", "r2"] {
            assert!(r.graph.edges.iter().any(|edge| {
                edge.from_node == fasterq.id
                    && edge.from_port == mate
                    && edge.to_node == sheet.id
                    && edge.to_port == mate
            }));
        }
        assert!(
            !ops.contains(&"align.star"),
            "STAR lives inside nf-core/rnaseq"
        );
        assert_wired(&r);
    }

    #[test]
    fn fastqc_only() {
        let r = reconstruct(&cat(), QC);
        assert_eq!(r.assay, Assay::Qc);
        r.graph.validate().unwrap();
        assert!(r.graph.nodes.iter().any(|n| n.operator == "qc.fastqc"));
        assert!(r.graph.nodes.iter().any(|n| n.operator == "files.import"));
    }

    #[test]
    fn variants_without_sarek_are_bwa_then_gatk() {
        let r = reconstruct(&cat(), VAR);
        assert_eq!(r.assay, Assay::Variants);
        let ops = ops(&r);
        assert!(ops.contains(&"nf.sarek"), "fixture names sarek: {ops:?}");
        assert!(!ops.contains(&"align.bwa"), "BWA is inside sarek");
        assert_wired(&r);
    }

    #[test]
    fn empty_is_honest() {
        let r = reconstruct(&cat(), "This paper is about the history of algebra.");
        assert_eq!(r.assay, Assay::Unknown);
        assert!(r.graph.nodes.is_empty());
        assert!(!r.warnings.is_empty());
    }

    #[test]
    fn accessions_scan() {
        assert_eq!(accessions("see SRR1 and SRR123456"), vec!["SRR123456"]);
    }

    #[test]
    fn assembly_paper_is_not_rnaseq() {
        let raw = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../testdata/papers/aphis_assembly_methods.txt"),
        )
        .unwrap();
        let r = reconstruct(&cat(), &raw);
        assert_eq!(r.assay, Assay::Assembly);
        r.graph.validate().unwrap();
        let ops: Vec<_> = r.graph.nodes.iter().map(|n| n.operator.as_str()).collect();
        assert!(ops.contains(&"asm.hifiasm"), "{ops:?}");
        assert!(
            !ops.contains(&"nf.rnaseq"),
            "must not misread Iso-seq as bulk RNA-seq"
        );
        assert!(ops.contains(&"asm.yahs"), "YaHS is a brick: {ops:?}");
        assert!(r.graph.edges.len() >= 2, "assembly steps should wire");
        for n in &r.graph.nodes {
            let deg = r
                .graph
                .edges
                .iter()
                .filter(|e| e.from_node == n.id || e.to_node == n.id)
                .count();
            assert!(deg > 0, "node {} ({}) has no edges", n.id, n.operator);
        }
        let x = |op: &str| {
            r.graph
                .nodes
                .iter()
                .find(|n| {
                    n.operator == op || n.params.get("tool") == Some(&ParamValue::String(op.into()))
                })
                .map(|n| n.layout.x)
                .unwrap()
        };
        let y = |op: &str| {
            r.graph
                .nodes
                .iter()
                .find(|n| {
                    n.operator == op || n.params.get("tool") == Some(&ParamValue::String(op.into()))
                })
                .map(|n| n.layout.y)
                .unwrap()
        };
        assert!(x("asm.hifiasm") > x("files.import"));
        assert!(x("asm.yahs") > x("asm.hifiasm"));
        assert!(
            y("Iso-Seq") > y("files.import"),
            "annotation lane sits below assembly"
        );
        assert!(ops.contains(&"asm.yahs"), "YaHS is a brick");
        assert!(ops.contains(&"qc.busco"), "BUSCO is a brick");
        assert!(ops.contains(&"align.minimap2"));
    }

    #[test]
    fn love_deseq2_workflow_is_star_counts_deseq() {
        let r = reconstruct(&cat(), &fixture("love_rnaseq_methods.txt"));
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(&r);
        assert!(ops.contains(&"align.star"), "{ops:?}");
        assert!(ops.contains(&"quant.featurecounts"));
        assert!(ops.contains(&"diff.deseq2"));
        assert!(ops.contains(&"sra.prefetch"));
        assert!(!ops.contains(&"nf.rnaseq"));
        assert_wired(&r);
    }

    #[test]
    fn pertea_hisat_stringtie_ballgown() {
        let r = reconstruct(&cat(), &fixture("pertea_hisat_methods.txt"));
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(&r);
        assert!(ops.contains(&"align.hisat2"), "{ops:?}");
        assert!(ops.contains(&"quant.stringtie"));
        assert!(ops.contains(&"qc.fastqc"));
        let has_ballgown = r
            .graph
            .nodes
            .iter()
            .any(|n| n.params.get("tool") == Some(&ParamValue::String("Ballgown".into())));
        assert!(has_ballgown, "Ballgown is not a brick yet — gap");
        assert_wired(&r);
    }

    #[test]
    fn gatk_best_practices_is_bwa_then_haplotypecaller() {
        let r = reconstruct(&cat(), &fixture("gatk_methods.txt"));
        assert_eq!(r.assay, Assay::Variants);
        let ops = ops(&r);
        assert!(ops.contains(&"align.bwa"), "{ops:?}");
        assert!(ops.contains(&"var.haplotypecaller"));
        assert!(!ops.contains(&"nf.sarek"));
        assert_wired(&r);
    }

    #[test]
    fn vgp_is_falcon_purge_salsa_busco() {
        let r = reconstruct(&cat(), &fixture("vgp_assembly_methods.txt"));
        assert_eq!(r.assay, Assay::Assembly);
        let tools: Vec<_> = r
            .graph
            .nodes
            .iter()
            .filter(|n| n.operator == "gap.missing")
            .filter_map(|n| match n.params.get("tool") {
                Some(ParamValue::String(s)) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(tools.iter().any(|t| t.contains("FALCON")), "{tools:?}");
        assert!(
            tools
                .iter()
                .any(|t| t.contains("Purge") || t.contains("Salsa")),
            "{tools:?}"
        );
        assert!(ops(&r).contains(&"qc.busco"));
        assert!(!ops(&r).contains(&"nf.rnaseq"));
        assert_wired(&r);
    }

    #[test]
    fn kraken2_is_a_brick_not_taxprofiler() {
        let r = reconstruct(&cat(), &fixture("kraken2_methods.txt"));
        assert_eq!(r.assay, Assay::Metagenome);
        let ops = ops(&r);
        assert!(ops.contains(&"class.kraken2"), "{ops:?}");
        assert!(!ops.contains(&"nf.taxprofiler"));
        assert!(!ops.contains(&"nf.rnaseq"));
        assert_wired(&r);
    }

    #[test]
    fn star_is_not_a_substring_of_start() {
        let r = reconstruct(&cat(), "The experiment will start next week with FastQC.");
        assert!(!ops(&r).contains(&"align.star"));
        assert!(ops(&r).contains(&"qc.fastqc"));
    }

    #[test]
    fn methods_window_handles_two_column_pdf_headings() {
        let text = format!(
            "Abstract\ncomparison prose         Methods\nReads were aligned with BWA-MEM. {}\nData availability\nHISAT2 was archived here.\n",
            "protocol details ".repeat(20)
        );
        let window = methods_window(&text);
        assert!(window.starts_with("Methods"), "{window:?}");
        assert!(window.contains("BWA-MEM"));
        assert!(!window.contains("HISAT2"));

        let nature = format!(
            "front matter\n\u{c}Methods        other column\nFALCON was used. {}\nCode availability\nend",
            "assembly details ".repeat(20)
        );
        let window = methods_window(&nature);
        assert!(window.starts_with("Methods"), "{window:?}");
        assert!(window.contains("FALCON"));
        assert!(!window.contains("Code availability"));
    }

    #[test]
    fn methods_word_in_prose_is_not_a_heading() {
        let text = format!(
            "RNA-seq methods papers help reproducibility.\nReads were aligned with STAR. {}\nReferences\nBWA-MEM was described elsewhere.",
            "analysis details ".repeat(20)
        );
        let window = methods_window(&text);
        assert!(window.contains("STAR"));
        assert!(!window.contains("BWA-MEM"));
    }

    #[test]
    fn strong_variant_evidence_beats_an_rnaseq_caveat() {
        let text = "GATK Best Practices uses BWA-MEM and HaplotypeCaller for variant calling. RNA-seq requires a different aligner.";
        let r = reconstruct(&cat(), text);
        assert_eq!(r.assay, Assay::Variants);
        assert!(ops(&r).contains(&"align.bwa"));
        assert!(ops(&r).contains(&"var.haplotypecaller"));
        assert!(!ops(&r).contains(&"align.star"));
    }

    #[test]
    fn mixed_methods_become_separate_parallel_candidate_graphs() {
        let text = "Methods article with two workflows. RNA-seq uses HISAT2 and StringTie for differential expression. Germline variant calling uses BWA-MEM and HaplotypeCaller.";
        let r = reconstruct(&cat(), text);
        assert_eq!(r.candidates.len(), 2);
        assert!(r
            .candidates
            .iter()
            .all(|candidate| candidate.role == CandidateRole::Parallel));
        let rna = r
            .candidates
            .iter()
            .find(|candidate| candidate.assay == Assay::RnaSeq)
            .unwrap();
        let variants = r
            .candidates
            .iter()
            .find(|candidate| candidate.assay == Assay::Variants)
            .unwrap();
        assert!(rna
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "align.hisat2"));
        assert!(!rna
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "align.bwa"));
        assert!(variants
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "align.bwa"));
        assert!(!variants
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "align.hisat2"));
        rna.graph.validate().unwrap();
        variants.graph.validate().unwrap();
    }

    #[test]
    fn compared_assemblers_become_alternative_candidate_graphs() {
        let text = "Methods\nPacBio HiFi reads were assembled in separate comparisons using hifiasm, FALCON-Unzip, and Flye. BUSCO evaluated each assembly.";
        let reconstruction = reconstruct(&cat(), text);

        assert_eq!(reconstruction.candidates.len(), 3);
        assert!(reconstruction
            .candidates
            .iter()
            .all(|candidate| candidate.role == CandidateRole::Alternative));
        let names = reconstruction
            .candidates
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            ["hifiasm assembly", "FALCON assembly", "Flye assembly"]
        );
        for candidate in &reconstruction.candidates {
            candidate.graph.validate().unwrap();
            let assemblers = candidate
                .graph
                .nodes
                .iter()
                .filter(|node| {
                    node.operator == "asm.hifiasm"
                        || node.params.contains_key("tool")
                            && matches!(
                                node.params.get("tool"),
                                Some(ParamValue::String(tool))
                                    if ["FALCON", "Flye"].contains(&tool.as_str())
                            )
                })
                .count();
            assert_eq!(assemblers, 1, "{} flattened alternatives", candidate.name);
        }
    }

    #[test]
    fn single_cell_methods_keep_analysis_chain() {
        let text = "Single-cell RNA sequencing FASTQs were processed with Cell Ranger. SoupX correction was optional before Seurat analysis and DoubletFinder.";
        let r = reconstruct(&cat(), text);
        assert_eq!(r.assay, Assay::SingleCell);
        assert!(ops(&r).contains(&"files.import"));
        let gaps: Vec<_> = r
            .graph
            .nodes
            .iter()
            .filter_map(|n| match n.params.get("tool") {
                Some(ParamValue::String(tool)) => Some(tool.as_str()),
                _ => None,
            })
            .collect();
        for tool in ["Cell Ranger", "SoupX", "Seurat", "DoubletFinder"] {
            assert!(gaps.contains(&tool), "missing {tool}: {gaps:?}");
        }
        r.graph.validate().unwrap();
    }

    #[test]
    fn downloaded_real_paper_corpus_reconstructs() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/papers");
        let cases: &[(&str, Assay, &[&str], &[&str])] = &[
            (
                "pdf/love_f1000.pdf",
                Assay::RnaSeq,
                &["align.star", "quant.featurecounts", "diff.deseq2"],
                &["nf.rnaseq"],
            ),
            (
                "raw/pertea_hisat.txt",
                Assay::RnaSeq,
                &["align.hisat2", "quant.stringtie"],
                &["align.bwa", "nf.rnaseq"],
            ),
            (
                "raw/gatk_best_practices.txt",
                Assay::Variants,
                &["align.bwa", "var.haplotypecaller"],
                &["nf.sarek", "align.hisat2"],
            ),
            (
                "pdf/cheng_hifiasm.pdf",
                Assay::Assembly,
                &["asm.hifiasm"],
                &["nf.rnaseq"],
            ),
            (
                "pdf/rhie_vgp.pdf",
                Assay::Assembly,
                &["qc.busco"],
                &["nf.rnaseq"],
            ),
            (
                "pdf/wood_kraken2.pdf",
                Assay::Metagenome,
                &["class.kraken2"],
                &["align.minimap2", "nf.taxprofiler"],
            ),
            (
                "raw/cwl_workflows_pmc.txt",
                Assay::Mixed,
                &[
                    "align.hisat2",
                    "align.bwa",
                    "quant.stringtie",
                    "var.haplotypecaller",
                ],
                &["nf.rnaseq", "nf.sarek"],
            ),
            (
                "raw/sarek_pmc.txt",
                Assay::Variants,
                &["nf.sarek"],
                &["align.bwa", "var.haplotypecaller"],
            ),
            (
                "raw/minto_pmc.txt",
                Assay::Metagenome,
                &["qc.fastp"],
                &["nf.mag", "nf.taxprofiler"],
            ),
            (
                "raw/scrnabox_pmc.txt",
                Assay::SingleCell,
                &["files.import"],
                &["nf.rnaseq"],
            ),
        ];
        let mut checked = 0;
        for (relative, assay, required, forbidden) in cases {
            let path = root.join(relative);
            if !path.is_file() {
                continue;
            }
            checked += 1;
            let extracted = extract_from_path(&path).unwrap();
            let r = reconstruct(&cat(), &extracted.text);
            if *assay == Assay::Mixed {
                let assays: Vec<_> = r
                    .candidates
                    .iter()
                    .map(|candidate| candidate.assay)
                    .collect();
                assert!(
                    assays.contains(&Assay::RnaSeq),
                    "{}: {assays:?}",
                    path.display()
                );
                assert!(
                    assays.contains(&Assay::Variants),
                    "{}: {assays:?}",
                    path.display()
                );
                assert!(
                    r.candidates
                        .iter()
                        .all(|candidate| candidate.role == CandidateRole::Parallel),
                    "{} did not preserve separate parallel tracks",
                    path.display()
                );
                let actual: Vec<_> = r
                    .candidates
                    .iter()
                    .flat_map(|candidate| candidate.graph.nodes.iter())
                    .map(|node| node.operator.as_str())
                    .collect();
                for op in *required {
                    assert!(
                        actual.contains(op),
                        "{} missing {op}: {actual:?}",
                        path.display()
                    );
                }
                for op in *forbidden {
                    assert!(
                        !actual.contains(op),
                        "{} invented {op}: {actual:?}",
                        path.display()
                    );
                }
                for candidate in &r.candidates {
                    candidate.graph.validate().unwrap();
                }
                continue;
            }
            assert_eq!(&r.assay, assay, "{}", path.display());
            let actual = ops(&r);
            for op in *required {
                assert!(
                    actual.contains(op),
                    "{} missing {op}: {actual:?}",
                    path.display()
                );
            }
            for op in *forbidden {
                assert!(
                    !actual.contains(op),
                    "{} invented {op}: {actual:?}",
                    path.display()
                );
            }
            if relative.contains("scrnabox") {
                let gaps: Vec<_> = r
                    .graph
                    .nodes
                    .iter()
                    .filter_map(|n| match n.params.get("tool") {
                        Some(ParamValue::String(tool)) => Some(tool.as_str()),
                        _ => None,
                    })
                    .collect();
                for tool in ["Cell Ranger", "SoupX", "Seurat", "DoubletFinder"] {
                    assert!(
                        gaps.contains(&tool),
                        "{} missing {tool}: {gaps:?}",
                        path.display()
                    );
                }
            }
            r.graph.validate().unwrap();
        }
        if root.join("pdf").is_dir() {
            assert_eq!(checked, cases.len(), "downloaded corpus is incomplete");
        }
    }

    #[test]
    fn thin_pdf_text_layer_is_rejected() {
        assert!(!text_layer_ok(""));
        assert!(!text_layer_ok("   (cid:1) (cid:2)  "));
        assert!(text_layer_ok(&"methods ".repeat(80)));
    }

    #[test]
    fn extract_plain_methods_file() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/papers/rnaseq_methods.txt");
        let e = extract_from_path(&p).unwrap();
        assert_eq!(e.via, ExtractVia::Utf8);
        assert!(e.text.to_ascii_lowercase().contains("fastqc"));
    }

    #[test]
    fn paper_ids_are_short() {
        let r = reconstruct(&cat(), RNA);
        let ids: Vec<_> = r.graph.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"prefetch"), "{ids:?}");
        assert!(ids.contains(&"fasterq"));
        assert!(ids.contains(&"fastqc"));
        assert!(ids.contains(&"star"));
        assert!(ids.contains(&"deseq2"));
    }

    #[test]
    fn reconstruction_returns_evidence_for_every_canvas_node_and_edge() {
        let reconstruction = reconstruct(
            &cat(),
            "Methods\nPaired-end RNA-seq reads were checked with FastQC and aligned with STAR.",
        );

        let node_targets = reconstruction
            .evidence
            .iter()
            .filter(|record| matches!(record.target, EvidenceTarget::Node(_)))
            .count();
        let edge_targets = reconstruction
            .evidence
            .iter()
            .filter(|record| matches!(record.target, EvidenceTarget::Edge(_)))
            .count();
        assert_eq!(node_targets, reconstruction.graph.nodes.len());
        assert_eq!(edge_targets, reconstruction.graph.edges.len());
        assert!(reconstruction.evidence.iter().any(|record| {
            record.status == EvidenceStatus::Explicit
                && reconstruction
                    .graph
                    .nodes
                    .iter()
                    .any(|node| node.id == record.target.id() && node.operator == "qc.fastqc")
        }));
        assert!(reconstruction.evidence.iter().any(|record| {
            record.status == EvidenceStatus::Inferred
                && reconstruction.graph.nodes.iter().any(|node| {
                    node.id == record.target.id() && node.operator == "files.import_paired"
                })
        }));
    }

    #[test]
    fn missing_bricks_are_labeled_as_missing_implementation() {
        let reconstruction = reconstruct(
            &cat(),
            "Methods\nRNA-seq reads were aligned with HISAT2, assembled with StringTie, and analyzed with Ballgown.",
        );

        assert!(reconstruction.evidence.iter().any(|record| {
            record.status == EvidenceStatus::MissingImplementation
                && record.detail.to_ascii_lowercase().contains("ballgown")
        }));
    }

    #[test]
    fn tesseract_ocr_scan_pdf() {
        if Command::new("magick").arg("-version").output().is_err() {
            return;
        }
        if Command::new("tesseract").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("axial-ocr-fixture");
        let _ = fs::create_dir_all(&dir);
        let png = dir.join("p.png");
        let pdf = dir.join("scan.pdf");
        let ok = Command::new("magick")
            .args([
                "-size",
                "1600x480",
                "xc:white",
                "-pointsize",
                "32",
                "-fill",
                "black",
                "-annotate",
                "+48+160",
                "RNA-seq SRR12345678 quality-checked with FastQC and STAR GRCh38 DESeq2",
                png.to_str().unwrap(),
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return;
        }
        let ok = Command::new("magick")
            .args([png.to_str().unwrap(), pdf.to_str().unwrap()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return;
        }
        let e = extract_from_path(&pdf).expect("ocr extract");
        assert_eq!(
            e.via,
            ExtractVia::Tesseract,
            "expected scan path, got {:?}",
            e.via
        );
        let low = e.text.to_ascii_lowercase();
        assert!(
            low.contains("rna") && (low.contains("srr") || low.contains("deseq")),
            "tesseract missed the methods line: {:?}",
            e.text
        );
        let r = reconstruct(&cat(), &e.text);
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops: Vec<_> = r.graph.nodes.iter().map(|n| n.operator.as_str()).collect();
        assert!(
            ops.iter()
                .any(|o| matches!(*o, "qc.fastqc" | "align.star" | "diff.deseq2")),
            "ocr graph missed the RNA tools: {ops:?} text={:?}",
            e.text
        );
    }
}
