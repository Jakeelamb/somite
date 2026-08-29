//! Rebuild a graph from a paper's methods. Catalog is the snap; gaps are honest.
//!
//! PDF text uses Poppler (`pdftotext` / `pdftoppm`) and falls back to
//! Tesseract for image-only pages.

use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use somite_ir::{
    compatible, Direction, Edge, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION,
};
use somite_ops::Catalog;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PaperError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("pdftotext: {0}")]
    Pdf(String),
    #[error("tesseract: {0}")]
    Ocr(String),
    #[error("paper extraction cancelled")]
    Cancelled,
    #[error("paper extraction limit: {0}")]
    Limit(String),
    #[error("{tool} exceeded its {seconds} second timeout")]
    Timeout { tool: String, seconds: u64 },
    #[error("{tool} is unavailable; searched the configured paper toolchain and PATH ({package})")]
    MissingTool { tool: String, package: String },
    #[error("{0}")]
    Msg(String),
}

/// How the source bytes became text.
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

#[derive(Debug, Clone, Copy)]
pub struct ExtractionLimits {
    pub max_pages: usize,
    pub max_text_bytes: usize,
    pub command_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct ExtractionToolchain {
    pub pdftotext: PathBuf,
    pub pdfinfo: PathBuf,
    pub pdftoppm: PathBuf,
    pub tesseract: PathBuf,
}

impl Default for ExtractionToolchain {
    fn default() -> Self {
        Self {
            pdftotext: PathBuf::from("pdftotext"),
            pdfinfo: PathBuf::from("pdfinfo"),
            pdftoppm: PathBuf::from("pdftoppm"),
            tesseract: PathBuf::from("tesseract"),
        }
    }
}

impl Default for ExtractionLimits {
    fn default() -> Self {
        Self {
            max_pages: 200,
            max_text_bytes: 64 * 1024 * 1024,
            command_timeout: Duration::from_secs(120),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractionProgress {
    NativeText,
    Rasterizing { page: usize, total: usize },
    Ocr { page: usize, total: usize },
    PageComplete { page: usize, total: usize },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconstructionOutcome {
    DraftsReady,
    RecognizedUnsupported,
    NoReconstructableMethods,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MethodSupport {
    Operator(String),
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodMention {
    pub display_name: String,
    pub normalized_name: String,
    pub operation_class: Option<String>,
    pub evidence: String,
    pub page: Option<usize>,
    pub support: MethodSupport,
}

#[derive(Debug, Clone)]
pub struct Reconstruction {
    pub outcome: ReconstructionOutcome,
    pub candidates: Vec<CandidateGraph>,
    pub mentions: Vec<MethodMention>,
    pub warnings: Vec<String>,
    active: Option<usize>,
}

impl Reconstruction {
    fn with_mentions(
        catalog: &Catalog,
        candidates: Vec<CandidateGraph>,
        mentions: Vec<MethodMention>,
    ) -> Self {
        let mut warnings = candidates
            .iter()
            .flat_map(|candidate| candidate.warnings.iter().cloned())
            .collect::<Vec<_>>();
        let mut accepted = Vec::new();
        for candidate in candidates {
            if candidate.graph.nodes.is_empty()
                || !candidate_has_reviewed_method(catalog, &candidate)
            {
                continue;
            }
            if let Err(error) = candidate
                .graph
                .validate()
                .map_err(|error| error.to_string())
                .and_then(|_| {
                    catalog
                        .verify_graph(&candidate.graph)
                        .map_err(|error| error.to_string())
                })
            {
                warnings.push(format!(
                    "discarded invalid candidate {}: {error}",
                    candidate.name
                ));
                continue;
            }
            accepted.push(candidate);
        }
        let candidates = accepted;
        let outcome = if candidates.is_empty() {
            if mentions.is_empty() {
                ReconstructionOutcome::NoReconstructableMethods
            } else {
                ReconstructionOutcome::RecognizedUnsupported
            }
        } else {
            ReconstructionOutcome::DraftsReady
        };
        if warnings.is_empty() {
            match outcome {
                ReconstructionOutcome::RecognizedUnsupported => warnings.push(
                    "Somite recognized these computational methods, but workflow support for them is not available yet."
                        .into(),
                ),
                ReconstructionOutcome::NoReconstructableMethods => warnings.push(
                    "Somite could not identify a computational workflow in the extracted text. Confirm that the paper includes readable methods or provide a clearer methods section."
                        .into(),
                ),
                ReconstructionOutcome::DraftsReady => {}
            }
        }
        let active = (!candidates.is_empty()).then_some(0);
        Self {
            outcome,
            candidates,
            mentions,
            warnings,
            active,
        }
    }

    pub fn active_index(&self) -> Option<usize> {
        self.active
    }

    pub fn active(&self) -> Option<&CandidateGraph> {
        self.active.and_then(|index| self.candidates.get(index))
    }

    pub fn active_mut(&mut self) -> Option<&mut CandidateGraph> {
        self.active.and_then(|index| self.candidates.get_mut(index))
    }

    pub fn activate(&mut self, index: usize) -> bool {
        if index < self.candidates.len() {
            self.active = Some(index);
            true
        } else {
            false
        }
    }

    pub fn warn_all(&mut self, warning: impl Into<String>) {
        let warning = warning.into();
        self.warnings.insert(0, warning.clone());
        for candidate in &mut self.candidates {
            candidate.warnings.insert(0, warning.clone());
        }
    }
}

fn candidate_has_reviewed_method(catalog: &Catalog, candidate: &CandidateGraph) -> bool {
    candidate.graph.nodes.iter().any(|node| {
        catalog
            .ops
            .get(&node.operator)
            .is_some_and(|operator| operator.paper.is_some())
    })
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceCitationKind {
    SraStudy,
    SraSample,
    SraExperiment,
    SraRun,
    BioProject,
    BioSample,
    Assembly,
    Ensembl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceRole {
    Reads,
    Reference,
    Annotation,
    SampleMetadata,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceCitation {
    pub accession: String,
    pub kind: ResourceCitationKind,
    pub role: ResourceRole,
    pub context: String,
    pub page: Option<usize>,
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

#[derive(Clone, Copy)]
struct UnsupportedMethodSpec {
    display_name: &'static str,
    normalized_name: &'static str,
    operation_class: &'static str,
    aliases: &'static [&'static str],
    input_shape: Option<PortType>,
    output_shape: Option<PortType>,
    may_be_gap: bool,
}

impl UnsupportedMethodSpec {
    const fn gap(
        display_name: &'static str,
        normalized_name: &'static str,
        operation_class: &'static str,
        aliases: &'static [&'static str],
        input_shape: PortType,
        output_shape: PortType,
    ) -> Self {
        Self {
            display_name,
            normalized_name,
            operation_class,
            aliases,
            input_shape: Some(input_shape),
            output_shape: Some(output_shape),
            may_be_gap: true,
        }
    }

    const fn mention_only(
        display_name: &'static str,
        normalized_name: &'static str,
        operation_class: &'static str,
        aliases: &'static [&'static str],
    ) -> Self {
        Self {
            display_name,
            normalized_name,
            operation_class,
            aliases,
            input_shape: None,
            output_shape: None,
            may_be_gap: false,
        }
    }
}

/// High-confidence computational methods that Somite can retain as paper
/// evidence but cannot yet represent as reviewed executable operators. Only
/// entries with reviewed input/output shapes and `may_be_gap` set can
/// become typed gap nodes. Mention-only entries remain evidence and never wire.
const UNSUPPORTED_METHODS: &[UnsupportedMethodSpec] = &[
    UnsupportedMethodSpec::gap(
        "Ballgown",
        "ballgown",
        "differential_expression",
        &["ballgown"],
        PortType::Gtf,
        PortType::Table,
    ),
    UnsupportedMethodSpec::gap(
        "Kallisto",
        "kallisto",
        "transcript_quantification",
        &["kallisto"],
        PortType::Fastq,
        PortType::Table,
    ),
    UnsupportedMethodSpec::gap(
        "MultiQC",
        "multiqc",
        "aggregate_qc",
        &["multiqc"],
        PortType::Directory,
        PortType::Html,
    ),
    UnsupportedMethodSpec::gap(
        "Picard",
        "picard",
        "bam_processing",
        &["picard", "markduplicates"],
        PortType::Bam,
        PortType::Bam,
    ),
    UnsupportedMethodSpec::gap(
        "Mutect2",
        "mutect2",
        "variant_calling",
        &["mutect2", "mutect"],
        PortType::Bam,
        PortType::Vcf,
    ),
    UnsupportedMethodSpec::gap(
        "MetaBAT",
        "metabat",
        "binning",
        &["metabat"],
        PortType::Bam,
        PortType::Directory,
    ),
    UnsupportedMethodSpec::gap(
        "SPAdes",
        "spades",
        "assemble",
        &["spades"],
        PortType::Fastq,
        PortType::Directory,
    ),
    UnsupportedMethodSpec::gap(
        "Cell Ranger",
        "cellranger",
        "single_cell_preprocessing",
        &["cellranger", "cell ranger"],
        PortType::Fastq,
        PortType::Directory,
    ),
    UnsupportedMethodSpec::gap(
        "SoupX",
        "soupx",
        "ambient_rna_correction",
        &["soupx"],
        PortType::Directory,
        PortType::Directory,
    ),
    UnsupportedMethodSpec::gap(
        "Seurat",
        "seurat",
        "single_cell_analysis",
        &["seurat"],
        PortType::Directory,
        PortType::Directory,
    ),
    UnsupportedMethodSpec::gap(
        "DoubletFinder",
        "doubletfinder",
        "doublet_detection",
        &["doubletfinder", "doublet finder"],
        PortType::Directory,
        PortType::Directory,
    ),
    UnsupportedMethodSpec::mention_only("Cutadapt", "cutadapt", "trim", &["cutadapt"]),
    UnsupportedMethodSpec::mention_only("Trimmomatic", "trimmomatic", "trim", &["trimmomatic"]),
    UnsupportedMethodSpec::mention_only(
        "Trim Galore",
        "trimgalore",
        "trim",
        &["trim galore", "trimgalore"],
    ),
    UnsupportedMethodSpec::mention_only("Porechop", "porechop", "trim", &["porechop"]),
    UnsupportedMethodSpec::mention_only(
        "dnaPipeTE",
        "dnapipete",
        "repeat_discovery",
        &["dnapipete", "dna pipe te"],
    ),
    UnsupportedMethodSpec::mention_only("PiRATE", "pirate", "repeat_annotation", &["pirate"]),
    UnsupportedMethodSpec::mention_only("dipSPAdes", "dipspades", "assemble", &["dipspades"]),
    UnsupportedMethodSpec::mention_only(
        "RepeatModeler",
        "repeatmodeler",
        "repeat_discovery",
        &["repeatmodeler"],
    ),
    UnsupportedMethodSpec::mention_only("Bowtie2", "bowtie2", "align", &["bowtie2"]),
    UnsupportedMethodSpec::mention_only("seqkit", "seqkit", "sequence_processing", &["seqkit"]),
    UnsupportedMethodSpec::mention_only(
        "parseRM.pl",
        "parsermpl",
        "repeat_summary",
        &["parserm.pl"],
    ),
    UnsupportedMethodSpec::mention_only("LTRpred", "ltrpred", "ltr_annotation", &["ltrpred"]),
    UnsupportedMethodSpec::mention_only(
        "Trinotate",
        "trinotate",
        "transcript_annotation",
        &["trinotate"],
    ),
    UnsupportedMethodSpec::mention_only(
        "CD-HIT-est",
        "cdhitest",
        "sequence_clustering",
        &["cd-hit-est"],
    ),
    UnsupportedMethodSpec::mention_only("Trinity", "trinity", "assemble", &["trinity"]),
    UnsupportedMethodSpec::mention_only(
        "FALCON",
        "falcon",
        "assemble",
        &["falcon-unzip", "falcon unzip", "falcon"],
    ),
    UnsupportedMethodSpec::mention_only("Flye", "flye", "assemble", &["flye"]),
    UnsupportedMethodSpec::mention_only(
        "Purge_Dups",
        "purgedups",
        "purge_haplotigs",
        &[
            "purge_dups",
            "purge dups",
            "purge_haplotigs",
            "purge haplotigs",
        ],
    ),
    UnsupportedMethodSpec::mention_only("Salsa", "salsa", "scaffold", &["salsa"]),
    UnsupportedMethodSpec::mention_only(
        "RepeatMasker",
        "repeatmasker",
        "repeat_annotation",
        &["repeatmasker", "repeat masker"],
    ),
    UnsupportedMethodSpec::mention_only(
        "phytools",
        "phytools",
        "phylogenetic_analysis",
        &["r package phytools", "phytools"],
    ),
    UnsupportedMethodSpec::mention_only("OUwie", "ouwie", "phylogenetic_modeling", &["ouwie"]),
    UnsupportedMethodSpec::mention_only(
        "R",
        "r",
        "statistical_analysis",
        &[
            "r statistical computing environment",
            "r statistical environment",
            "using r version",
        ],
    ),
    UnsupportedMethodSpec::mention_only(
        "Custom script",
        "custom-script",
        "custom_analysis",
        &[
            "custom perl script",
            "custom python script",
            "custom script",
        ],
    ),
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
    extract_from_path_with_control(path, ExtractionLimits::default(), || false, |_| {})
}

pub fn extract_from_path_with_control(
    path: &Path,
    limits: ExtractionLimits,
    cancelled: impl Fn() -> bool,
    progress: impl FnMut(ExtractionProgress),
) -> Result<Extracted, PaperError> {
    extract_from_path_with_toolchain(
        path,
        limits,
        &ExtractionToolchain::default(),
        cancelled,
        progress,
    )
}

pub fn extract_from_path_with_toolchain(
    path: &Path,
    limits: ExtractionLimits,
    tools: &ExtractionToolchain,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(ExtractionProgress),
) -> Result<Extracted, PaperError> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "pdf" {
        let size = fs::metadata(path)?.len();
        if size > limits.max_text_bytes as u64 {
            return Err(PaperError::Limit(format!(
                "text source is {size} bytes; limit is {} bytes",
                limits.max_text_bytes
            )));
        }
        if cancelled() {
            return Err(PaperError::Cancelled);
        }
        return Ok(Extracted {
            text: fs::read_to_string(path)?,
            via: ExtractVia::Utf8,
        });
    }
    progress(ExtractionProgress::NativeText);
    let layer = match pdftotext(path, &limits, tools, &cancelled) {
        Ok(layer) => layer,
        Err(PaperError::MissingTool { tool, .. }) if tool == "pdftotext" => String::new(),
        Err(error) => return Err(error),
    };
    if text_layer_ok(&layer) {
        return Ok(Extracted {
            text: layer,
            via: ExtractVia::Poppler,
        });
    }
    let ocr = pdf_ocr(path, &limits, tools, &cancelled, &mut progress)?;
    Ok(Extracted {
        text: ocr,
        via: ExtractVia::Tesseract,
    })
}

fn text_layer_ok(s: &str) -> bool {
    let letters = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    letters >= 400
}

fn pdftotext(
    path: &Path,
    limits: &ExtractionLimits,
    tools: &ExtractionToolchain,
    cancelled: &impl Fn() -> bool,
) -> Result<String, PaperError> {
    let mut command = Command::new(&tools.pdftotext);
    command.args(["-layout", "-q"]).arg(path).arg("-");
    let out = command_output(
        command,
        "pdftotext",
        ToolFamily::Pdf,
        limits.command_timeout,
        limits.max_text_bytes,
        cancelled,
    )?;
    if !out.status.success() {
        return Err(PaperError::Pdf(
            String::from_utf8_lossy(&out.stderr).trim().into(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

static OCR_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct OcrWorkspace(PathBuf);

impl Drop for OcrWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pdf_ocr(
    path: &Path,
    limits: &ExtractionLimits,
    tools: &ExtractionToolchain,
    cancelled: &impl Fn() -> bool,
    progress: &mut impl FnMut(ExtractionProgress),
) -> Result<String, PaperError> {
    let pages = pdf_page_count(path, limits, tools, cancelled)?;
    if pages == 0 {
        return Err(PaperError::Pdf("pdfinfo reported zero pages".into()));
    }
    if pages > limits.max_pages {
        return Err(PaperError::Limit(format!(
            "PDF contains {pages} pages; OCR limit is {} pages",
            limits.max_pages
        )));
    }
    let dir = std::env::temp_dir().join(format!(
        "somite-ocr-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        OCR_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    fs::create_dir_all(&dir)?;
    let workspace = OcrWorkspace(dir);
    let prefix = workspace.0.join("page");
    let page_image = workspace.0.join("page.png");
    let langs = std::env::var("SOMITE_OCR_LANGS")
        .or_else(|_| std::env::var("OMARCHY_OCR_LANGS"))
        .unwrap_or_else(|_| "eng".into());
    let mut text = String::new();
    for page in 1..=pages {
        if cancelled() {
            return Err(PaperError::Cancelled);
        }
        progress(ExtractionProgress::Rasterizing { page, total: pages });
        let mut raster = Command::new(&tools.pdftoppm);
        raster
            .args(["-png", "-r", "300", "-f"])
            .arg(page.to_string())
            .arg("-l")
            .arg(page.to_string())
            .arg("-singlefile")
            .arg(path)
            .arg(&prefix);
        let raster = command_output(
            raster,
            "pdftoppm",
            ToolFamily::Pdf,
            limits.command_timeout,
            1024 * 1024,
            cancelled,
        )?;
        if !raster.status.success() {
            return Err(PaperError::Pdf(
                String::from_utf8_lossy(&raster.stderr).trim().into(),
            ));
        }
        if !page_image.is_file() {
            return Err(PaperError::Pdf(format!(
                "pdftoppm did not render PDF page {page}"
            )));
        }
        progress(ExtractionProgress::Ocr { page, total: pages });
        let mut tesseract = Command::new(&tools.tesseract);
        tesseract.arg(&page_image).arg("stdout").args([
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
        ]);
        let remaining = limits.max_text_bytes.saturating_sub(text.len());
        if remaining == 0 {
            return Err(PaperError::Limit(format!(
                "OCR text exceeds {} bytes",
                limits.max_text_bytes
            )));
        }
        let out = command_output(
            tesseract,
            "tesseract",
            ToolFamily::Ocr,
            limits.command_timeout,
            remaining,
            cancelled,
        )?;
        if !out.status.success() {
            return Err(PaperError::Ocr(
                String::from_utf8_lossy(&out.stderr).trim().into(),
            ));
        }
        text.push_str(&String::from_utf8_lossy(&out.stdout));
        text.push('\u{000c}');
        if text.len() > limits.max_text_bytes {
            return Err(PaperError::Limit(format!(
                "OCR text exceeds {} bytes",
                limits.max_text_bytes
            )));
        }
        let _ = fs::remove_file(&page_image);
        progress(ExtractionProgress::PageComplete { page, total: pages });
    }
    if text.chars().filter(|c| c.is_ascii_alphabetic()).count() < 40 {
        return Err(PaperError::Ocr("tesseract produced almost no text".into()));
    }
    Ok(text)
}

fn pdf_page_count(
    path: &Path,
    limits: &ExtractionLimits,
    tools: &ExtractionToolchain,
    cancelled: &impl Fn() -> bool,
) -> Result<usize, PaperError> {
    let mut command = Command::new(&tools.pdfinfo);
    command.arg(path);
    let output = command_output(
        command,
        "pdfinfo",
        ToolFamily::Pdf,
        limits.command_timeout,
        1024 * 1024,
        cancelled,
    )?;
    if !output.status.success() {
        return Err(PaperError::Pdf(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    parse_pdf_page_count(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| PaperError::Pdf("pdfinfo did not report a page count".into()))
}

fn parse_pdf_page_count(output: &str) -> Option<usize> {
    output.lines().find_map(|line| {
        line.strip_prefix("Pages:")
            .and_then(|value| value.trim().parse().ok())
    })
}

#[derive(Clone, Copy)]
enum ToolFamily {
    Pdf,
    Ocr,
}

struct CapturedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn command_output(
    mut command: Command,
    tool: &str,
    family: ToolFamily,
    timeout: Duration,
    stdout_limit: usize,
    cancelled: &impl Fn() -> bool,
) -> Result<CapturedOutput, PaperError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            PaperError::MissingTool {
                tool: tool.to_owned(),
                package: match family {
                    ToolFamily::Pdf => "poppler",
                    ToolFamily::Ocr => "tesseract",
                }
                .to_owned(),
            }
        } else {
            PaperError::Io(error)
        }
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| PaperError::Msg(format!("could not capture {tool} stdout")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| PaperError::Msg(format!("could not capture {tool} stderr")))?;
    let stdout_reader = std::thread::spawn(move || read_limited(stdout, stdout_limit));
    let stderr_reader = std::thread::spawn(move || read_limited(stderr, 1024 * 1024));
    let started = Instant::now();
    let mut cancelled_result = false;
    let mut timed_out = false;
    let status = loop {
        if cancelled() {
            cancelled_result = true;
            let _ = child.kill();
            break child.wait()?;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stdout_exceeded) = stdout_reader
        .join()
        .map_err(|_| PaperError::Msg(format!("{tool} stdout reader stopped")))??;
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| PaperError::Msg(format!("{tool} stderr reader stopped")))??;
    if cancelled_result {
        return Err(PaperError::Cancelled);
    }
    if timed_out {
        return Err(PaperError::Timeout {
            tool: tool.to_owned(),
            seconds: timeout.as_secs().max(1),
        });
    }
    if stdout_exceeded {
        return Err(PaperError::Limit(format!(
            "{tool} output exceeds the {stdout_limit} byte limit"
        )));
    }
    Ok(CapturedOutput {
        status,
        stdout,
        stderr,
    })
}

fn read_limited(mut reader: impl Read, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut captured = Vec::new();
    let mut exceeded = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let retained = read.min(remaining);
        captured.extend_from_slice(&buffer[..retained]);
        exceeded |= retained < read;
    }
    Ok((captured, exceeded))
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
    // Mentions stay anchored to the exact Methods slice even when a very short
    // section makes graph reconstruction conservatively scan the full text.
    let mentions = method_mentions(catalog, text, focus);
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
        return Reconstruction::with_mentions(catalog, candidates, mentions);
    }
    if assay == Assay::Assembly {
        return Reconstruction::with_mentions(
            catalog,
            build_assembly_candidates(catalog, scan, &low, CandidateRole::Primary),
            mentions,
        );
    }
    Reconstruction::with_mentions(
        catalog,
        vec![build_bricks(catalog, text, scan, &low, assay)],
        mentions,
    )
}

fn method_mentions(catalog: &Catalog, full: &str, scan: &str) -> Vec<MethodMention> {
    let scan_offset = scan.as_ptr() as usize - full.as_ptr() as usize;
    let mut found = Vec::<(usize, MethodMention)>::new();

    for operator in catalog.ops.values() {
        let Some(recognition) = &operator.paper else {
            continue;
        };
        let Some((alias, range)) = recognition
            .aliases
            .iter()
            .filter_map(|alias| find_method_match(scan, alias).map(|range| (alias, range)))
            .min_by_key(|(_, range)| range.start)
        else {
            continue;
        };
        let offset = scan_offset + range.start;
        found.push((
            offset,
            MethodMention {
                display_name: method_display_name(scan, &range, alias),
                normalized_name: normalize_method_name(&operator.title),
                operation_class: recognition.operation_class.clone(),
                evidence: snippet_at(scan, &range),
                page: Some(page_for_offset(full, offset)),
                support: MethodSupport::Operator(operator.id.clone()),
            },
        ));
    }

    for spec in UNSUPPORTED_METHODS {
        debug_assert!(
            !spec.display_name.is_empty()
                && (!spec.may_be_gap
                    || (spec.input_shape.is_some() && spec.output_shape.is_some())),
            "unsupported methods require a canonical identity; gap-capable methods also require reviewed input and output shapes"
        );
        let Some((alias, range)) = spec
            .aliases
            .iter()
            .filter_map(|alias| find_method_match(scan, alias).map(|range| (*alias, range)))
            .min_by_key(|(_, range)| range.start)
        else {
            continue;
        };
        let offset = scan_offset + range.start;
        found.push((
            offset,
            MethodMention {
                display_name: method_display_name(scan, &range, alias),
                normalized_name: spec.normalized_name.into(),
                operation_class: Some(spec.operation_class.into()),
                evidence: snippet_at(scan, &range),
                page: Some(page_for_offset(full, offset)),
                support: MethodSupport::Unsupported,
            },
        ));
    }

    found.sort_by_key(|(offset, _)| *offset);
    let mut mentions = Vec::<MethodMention>::new();
    for (_, mention) in found {
        if !mentions
            .iter()
            .any(|existing| existing.normalized_name == mention.normalized_name)
        {
            mentions.push(mention);
        }
    }
    mentions
}

fn find_method_match(text: &str, alias: &str) -> Option<std::ops::Range<usize>> {
    let exact_case = ambiguous_acronym(alias);
    let source_alias = alias;
    let low = text.to_ascii_lowercase();
    let alias = alias.to_ascii_lowercase();
    let first = alias.chars().next()?;
    low.char_indices()
        .filter(|(_, character)| *character == first)
        .find_map(|(start, _)| {
            let alias_end = match_alias_at(&low, start, &alias)?;
            if exact_case && &text[start..alias_end] != source_alias {
                return None;
            }
            let before = start == 0 || !low.as_bytes()[start - 1].is_ascii_alphanumeric();
            let end = citation_suffix_end(&low, alias_end).unwrap_or(alias_end);
            let after = end == low.len() || !low.as_bytes()[end].is_ascii_alphanumeric();
            (before && after && !method_match_negated(&low, start)).then_some(start..end)
        })
}

fn method_display_name(text: &str, range: &std::ops::Range<usize>, alias: &str) -> String {
    let low = text.to_ascii_lowercase();
    let alias = alias.to_ascii_lowercase();
    let surface_end = match_alias_at(&low, range.start, &alias).unwrap_or(range.end);
    text[range.start..surface_end].to_owned()
}

fn ambiguous_acronym(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 4
        && alias
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() && byte.is_ascii_uppercase())
}

fn citation_suffix_end(text: &str, alias_end: usize) -> Option<usize> {
    let digit_count = text[alias_end..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if digit_count < 2 {
        return None;
    }
    let citation_end = alias_end + digit_count;
    (citation_end == text.len() || !text.as_bytes()[citation_end].is_ascii_alphanumeric())
        .then_some(citation_end)
}

fn match_alias_at(text: &str, start: usize, alias: &str) -> Option<usize> {
    let mut cursor = start;
    let mut alias_chars = alias.chars().peekable();
    while let Some(expected) = alias_chars.next() {
        if expected.is_whitespace() {
            while alias_chars
                .peek()
                .is_some_and(|character| character.is_whitespace())
            {
                alias_chars.next();
            }
            let before_whitespace = cursor;
            while let Some(character) = text[cursor..].chars().next() {
                if !character.is_whitespace() {
                    break;
                }
                cursor += character.len_utf8();
            }
            if cursor == before_whitespace {
                return None;
            }
            continue;
        }

        let actual = text[cursor..].chars().next()?;
        if actual != expected {
            return None;
        }
        cursor += actual.len_utf8();
    }
    Some(cursor)
}

fn method_match_negated(low: &str, start: usize) -> bool {
    let mut context_start = start.saturating_sub(64);
    while !low.is_char_boundary(context_start) {
        context_start -= 1;
    }
    let context = &low[context_start..start];
    let clause = context
        .rsplit(['.', ';', '\n'])
        .next()
        .unwrap_or(context)
        .trim_end();
    [
        "without",
        "did not use",
        "not using",
        "rather than",
        "instead of",
    ]
    .iter()
    .any(|negation| clause.ends_with(negation))
}

fn has_executable_method_match(text: &str, aliases: &[String]) -> bool {
    aliases.iter().any(|alias| {
        let mut offset = 0;
        while offset < text.len() {
            let Some(local) = find_method_match(&text[offset..], alias) else {
                return false;
            };
            let range = offset + local.start..offset + local.end;
            if !method_match_comparison_only(text, &range) {
                return true;
            }
            offset = range.end;
        }
        false
    })
}

fn method_match_comparison_only(text: &str, range: &std::ops::Range<usize>) -> bool {
    let low = text.to_ascii_lowercase();
    let clause_start = low[..range.start]
        .rfind(['.', ';', '\n'])
        .map_or(0, |position| position + 1);
    let before = low[clause_start..range.start].trim_end();
    let clause_end = low[range.end..]
        .find(['.', ';', '\n'])
        .map_or(low.len(), |position| range.end + position);
    let after = low[range.end..clause_end].trim_start();

    ["not used", "not selected", "not retained"]
        .iter()
        .any(|denial| after.contains(denial))
        || ["compared", "comparing", "benchmarked", "evaluated"]
            .iter()
            .any(|comparison| before.ends_with(comparison))
}

fn snippet_at(text: &str, range: &std::ops::Range<usize>) -> String {
    let mut start = range.start.saturating_sub(48);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (range.end + 48).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    text[start..end].trim().to_owned()
}

fn page_for_offset(text: &str, offset: usize) -> usize {
    text[..offset]
        .bytes()
        .filter(|byte| *byte == b'\x0c')
        .count()
        + 1
}

fn normalize_method_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn assay_recognition_label(assay: Assay) -> Option<&'static str> {
    match assay {
        Assay::Assembly => Some("assembly"),
        Assay::RnaSeq => Some("rna-seq"),
        Assay::Variants => Some("variants"),
        Assay::Metagenome => Some("metagenome"),
        Assay::SingleCell => Some("single-cell"),
        Assay::Qc => Some("qc"),
        Assay::Mixed | Assay::Unknown => None,
    }
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
        name: None,
        nodes: vec![],
        edges: vec![],
        annotations: vec![],
        variant_origin: None,
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
            operator_revision: oper.revision().ok()?,
            ports: oper.ir_ports(),
            params: pmap,
            source_workflow: None,
            layout: Layout { x: 0.0, y: 0.0 },
            note,
            color: None,
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

    let catalog_mentions = method_mentions(catalog, full, scan);
    let named_operator = |id: &str| {
        catalog_mentions.iter().any(
            |mention| matches!(&mention.support, MethodSupport::Operator(operator) if operator == id),
        )
    };
    let named_nf_rnaseq = named_operator("nf.rnaseq");
    let named_nf_sarek = named_operator("nf.sarek");
    let named_nf_tax = named_operator("nf.taxprofiler");
    let named_nf_mag = named_operator("nf.mag");

    for mention in &catalog_mentions {
        let MethodSupport::Operator(op) = &mention.support else {
            continue;
        };
        let Some(operator) = catalog.ops.get(op) else {
            continue;
        };
        let Some(recognition) = &operator.paper else {
            continue;
        };
        if !has_executable_method_match(scan, &recognition.aliases) {
            continue;
        }
        if let Some(assay) = assay_recognition_label(assay) {
            if !recognition.assays.is_empty()
                && !recognition
                    .assays
                    .iter()
                    .any(|candidate| candidate == assay)
            {
                continue;
            }
        }
        // A full protocol often names comparison tools from other assays. A
        // domain-incompatible mention is evidence, not a runnable step.
        if op == "nf.rnaseq" && !named_nf_rnaseq {
            continue;
        }
        if op == "nf.sarek" && !named_nf_sarek {
            continue;
        }
        if op == "nf.taxprofiler" && !named_nf_tax {
            continue;
        }
        if op == "nf.mag" && !named_nf_mag {
            continue;
        }
        if named_nf_rnaseq && RNA_COMPOUND_COVERS.contains(&op.as_str()) {
            continue;
        }
        if named_nf_sarek && VAR_COMPOUND_COVERS.contains(&op.as_str()) {
            continue;
        }
        if (named_nf_tax || named_nf_mag) && MAG_COMPOUND_COVERS.contains(&op.as_str()) {
            continue;
        }
        if op == "diff.deseq2"
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
        add(&mut g, op, vec![], Some(mention.evidence.clone()));
    }

    for spec in UNSUPPORTED_METHODS.iter().filter(|spec| spec.may_be_gap) {
        let (Some(input_shape), Some(output_shape)) = (spec.input_shape, spec.output_shape) else {
            debug_assert!(false, "gap-capable method lacks reviewed shapes");
            continue;
        };
        let Some(range) = spec
            .aliases
            .iter()
            .filter_map(|alias| find_method_match(scan, alias))
            .min_by_key(|range| range.start)
        else {
            continue;
        };
        if named_nf_rnaseq && ["kallisto", "multiqc"].contains(&spec.normalized_name) {
            continue;
        }
        if named_nf_sarek && ["picard", "mutect2"].contains(&spec.normalized_name) {
            continue;
        }
        let q = Some(snippet_at(scan, &range));
        if let Some(id) = add(
            &mut g,
            "gap.missing",
            vec![
                ("tool", ParamValue::String(spec.display_name.into())),
                ("quote", ParamValue::String(q.clone().unwrap_or_default())),
            ],
            q.or_else(|| {
                Some(format!(
                    "paper used {}; not a brick yet — wrap it",
                    spec.display_name
                ))
            }),
        ) {
            if let Some(n) = g.nodes.iter_mut().find(|n| n.id == id) {
                n.ports = reviewed_gap_ports(input_shape, output_shape);
            }
        }
    }

    let bwa_samtools = if g.nodes.iter().any(|node| node.operator == "align.bwa")
        && g.nodes.iter().any(|node| {
            node.operator == "var.haplotypecaller"
                || node.params.get("tool") == Some(&ParamValue::String("Picard".into()))
        }) {
        add(
            &mut g,
            "align.samtools_view",
            vec![("exclude_flags", ParamValue::Int(0))],
            Some("BWA-MEM emits SAM; convert it to BAM before BAM-based tools".into()),
        )
    } else {
        None
    };

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
            "align.bwa" => &[],
            _ => continue,
        };
        for n in g.nodes.clone() {
            if downstream.contains(&n.operator.as_str()) {
                wire(&mut g, &aligner.id, &n.id);
            }
        }
    }
    if let Some(converter) = &bwa_samtools {
        if let Some(bwa) = g
            .nodes
            .iter()
            .find(|node| node.operator == "align.bwa")
            .map(|node| node.id.clone())
        {
            wire(&mut g, &bwa, converter);
        }
        let picard = g
            .nodes
            .iter()
            .find(|node| node.params.get("tool") == Some(&ParamValue::String("Picard".into())))
            .map(|node| node.id.clone());
        let next = picard.or_else(|| {
            g.nodes
                .iter()
                .find(|node| node.operator == "var.haplotypecaller")
                .map(|node| node.id.clone())
        });
        if let Some(next) = next {
            wire(&mut g, converter, &next);
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
            if bwa_samtools.is_none() {
                wire(&mut g, &bw, &pic);
            }
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
            ) + linkage_scaffolding_score(low),
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
    if is_linkage_scaffolding(low) {
        return vec![build_linkage_scaffolding(catalog, text, low, single_role)];
    }
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

fn is_linkage_scaffolding(low: &str) -> bool {
    mentioned(low, &["allmaps", "rascaf", "agouti"])
        && mentioned(low, &["scaffold", "genome assembly"])
        && mentioned(
            low,
            &[
                "meiotic map",
                "linkage map",
                "ordering and orientation",
                "order and orient",
            ],
        )
}

fn linkage_scaffolding_score(low: &str) -> u16 {
    if is_linkage_scaffolding(low) {
        12
    } else {
        0
    }
}

fn build_linkage_scaffolding(
    catalog: &Catalog,
    text: &str,
    low: &str,
    role: CandidateRole,
) -> CandidateGraph {
    let mut warnings = vec![
        "FISH validation is wet-lab evidence and remains outside the executable graph.".into(),
    ];
    let mut graph = Graph {
        schema_version: SCHEMA_VERSION,
        name: None,
        nodes: vec![],
        edges: vec![],
        annotations: vec![],
        variant_origin: None,
    };
    let add =
        |graph: &mut Graph, op: &str, params: Vec<(&str, ParamValue)>, note: Option<String>| {
            let Ok(operator) = catalog.get(op) else {
                return None;
            };
            let existing = graph
                .nodes
                .iter()
                .map(|node| node.id.clone())
                .collect::<Vec<_>>();
            let id = next_name(&existing, op, &params);
            let mut parameter_map = std::collections::BTreeMap::new();
            for (key, spec) in &operator.params {
                if let Some(default) = &spec.default {
                    parameter_map.insert(key.clone(), default.clone());
                }
            }
            for (key, value) in params {
                parameter_map.insert(key.into(), value);
            }
            graph.nodes.push(Node {
                id: id.clone(),
                operator: op.into(),
                operator_revision: operator.revision().ok()?,
                ports: operator.ir_ports(),
                params: parameter_map,
                source_workflow: None,
                layout: Layout { x: 0.0, y: 0.0 },
                note,
                color: None,
            });
            Some(id)
        };
    let starting_assembly = add(
        &mut graph,
        "files.import_fasta",
        vec![],
        snippet(text, "genome assembly (ambMex3)").or_else(|| snippet(text, "genome assembly")),
    );
    let dna_reads = add(
        &mut graph,
        "files.import_paired",
        vec![],
        snippet(text, "paired-end reads")
            .or_else(|| Some("paired DNA reads for meiotic mapping".into())),
    );
    let dna_bwa = add(&mut graph, "align.bwa", vec![], snippet(text, "BWA-MEM"));
    let samtools = if mentioned(low, &["samtools"]) {
        add(
            &mut graph,
            "align.samtools_view",
            vec![("exclude_flags", ParamValue::Int(2308))],
            snippet(text, "samtools"),
        )
    } else {
        None
    };
    let gatk = if mentioned(low, &["gatk"]) {
        add(
            &mut graph,
            "method.gatk3_unspecified",
            vec![],
            snippet(text, "GATK"),
        )
    } else {
        None
    };
    let vcftools = if mentioned(low, &["vcf tools", "vcftools"]) {
        add(
            &mut graph,
            "var.vcftools_filter",
            vec![("minimum_spacing", ParamValue::Int(75))],
            snippet(text, "VCF tools").or_else(|| snippet(text, "VCFtools")),
        )
    } else {
        None
    };
    let joinmap = add(
        &mut graph,
        "manual.joinmap",
        vec![],
        snippet(text, "JoinMap"),
    );

    let rna_reads = add(
        &mut graph,
        "files.import_paired",
        vec![],
        snippet(text, "Paired-end RNA-Seq")
            .or_else(|| Some("paired RNA-seq reads for scaffold evidence".into())),
    );
    let rna_bwa = add(
        &mut graph,
        "align.bwa",
        vec![],
        snippet(text, "aligned to genomic scaffolds"),
    );
    let rna_view = add(
        &mut graph,
        "align.samtools_view",
        vec![("exclude_flags", ParamValue::Int(4))],
        Some("BWA-MEM output converted to BAM for RNA-guided scaffolding".into()),
    );
    let rna_sort = add(
        &mut graph,
        "align.samtools_sort",
        vec![],
        Some("Rascaf requires a coordinate-sorted BAM input".into()),
    );
    let rascaf = if mentioned(low, &["rascaf"]) {
        add(
            &mut graph,
            "asm.rascaf",
            vec![("minimum_support", ParamValue::Int(5))],
            snippet(text, "Rascaf"),
        )
    } else {
        None
    };
    let agouti = if mentioned(low, &["agouti"]) {
        add(
            &mut graph,
            "legacy.agouti",
            vec![
                ("minimum_support", ParamValue::Int(5)),
                ("minimum_mapping_quality", ParamValue::Int(20)),
            ],
            snippet(text, "AGOUTI"),
        )
    } else {
        None
    };
    let allmaps_evidence = add(
        &mut graph,
        "manual.allmaps_evidence",
        vec![],
        snippet(text, "ALLMAPS"),
    );
    let allmaps = add(&mut graph, "asm.allmaps", vec![], snippet(text, "ALLMAPS"));

    if let (Some(source), Some(target)) = (&starting_assembly, &dna_bwa) {
        wire(&mut graph, source, target);
    }
    if let (Some(source), Some(target)) = (&dna_reads, &dna_bwa) {
        wire_reads(&mut graph, source, target);
    }
    let mut dna_tail = dna_bwa.clone();
    for next in [&samtools, &gatk, &vcftools, &joinmap] {
        if let (Some(source), Some(target)) = (&dna_tail, next) {
            wire(&mut graph, source, target);
            dna_tail = Some(target.clone());
        }
    }
    if let (Some(source), Some(target)) = (&starting_assembly, &gatk) {
        wire(&mut graph, source, target);
    }
    if let (Some(source), Some(target)) = (&starting_assembly, &rna_bwa) {
        wire(&mut graph, source, target);
    }
    if let (Some(source), Some(target)) = (&rna_reads, &rna_bwa) {
        wire_reads(&mut graph, source, target);
    }
    if let (Some(source), Some(target)) = (&rna_bwa, &rna_view) {
        wire(&mut graph, source, target);
    }
    if let (Some(source), Some(target)) = (&rna_view, &rna_sort) {
        wire(&mut graph, source, target);
    }
    for target in [&rascaf, &agouti] {
        if let (Some(source), Some(target)) = (&rna_sort, target) {
            wire(&mut graph, source, target);
        }
        if let (Some(source), Some(target)) = (&starting_assembly, target) {
            wire(&mut graph, source, target);
        }
    }
    for source in [&joinmap, &rascaf, &agouti] {
        if let (Some(source), Some(target)) = (source, &allmaps_evidence) {
            wire(&mut graph, source, target);
        }
    }
    if let (Some(source), Some(target)) = (&allmaps_evidence, &allmaps) {
        wire_all(&mut graph, source, target);
    }
    if let (Some(source), Some(target)) = (&starting_assembly, &allmaps) {
        wire(&mut graph, source, target);
    }

    for (node, column, row) in [
        (starting_assembly.as_deref(), 0, 0),
        (dna_reads.as_deref(), 0, 1),
        (dna_bwa.as_deref(), 1, 1),
        (samtools.as_deref(), 2, 1),
        (gatk.as_deref(), 3, 1),
        (vcftools.as_deref(), 4, 1),
        (joinmap.as_deref(), 5, 1),
        (rna_reads.as_deref(), 0, 2),
        (rna_bwa.as_deref(), 1, 2),
        (rna_view.as_deref(), 2, 2),
        (rna_sort.as_deref(), 3, 2),
        (rascaf.as_deref(), 4, 2),
        (agouti.as_deref(), 4, 3),
        (allmaps_evidence.as_deref(), 5, 2),
        (allmaps.as_deref(), 6, 2),
    ] {
        place(&mut graph, node, column, row);
    }
    if let Err(error) = graph.validate() {
        warnings.push(format!("graph did not validate: {error}"));
    }
    CandidateGraph {
        name: "Linkage-guided scaffolding".into(),
        role,
        evidence: evidence_ledger(&graph),
        graph,
        assay: Assay::Assembly,
        warnings,
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
        name: None,
        nodes: vec![],
        edges: vec![],
        annotations: vec![],
        variant_origin: None,
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
            operator_revision: oper.revision().ok()?,
            ports: oper.ir_ports(),
            params: pmap,
            source_workflow: None,
            layout: Layout { x: 0.0, y: 0.0 },
            note,
            color: None,
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
        None => None,
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
            // `pdftotext -layout` can emit the right column before a left-column
            // Methods heading. Include only the pre-heading text from that same
            // PDF page, never an earlier page or the full front matter.
            let page_start = text[..start]
                .rfind('\u{000c}')
                .map(|separator| separator + 1)
                .unwrap_or(start);
            let slice = &text[page_start..end];
            // Preserve a real, compact Methods section as the evidence range.
            // Graph reconstruction independently decides whether it needs the
            // wider body for context.
            if slice.len() >= 40 {
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
    resource_citations(text)
        .into_iter()
        .filter(|citation| citation.kind == ResourceCitationKind::SraRun)
        .map(|citation| citation.accession)
        .collect()
}

/// Extract accession-shaped paper resources with enough surrounding evidence
/// for callers to resolve them without treating every citation as workflow input.
pub fn resource_citations(text: &str) -> Vec<ResourceCitation> {
    let mut citations = Vec::<ResourceCitation>::new();
    for (page_index, page) in text.split('\u{000c}').enumerate() {
        let lines = page.lines().collect::<Vec<_>>();
        for (line_index, line) in lines.iter().enumerate() {
            let context = [
                line_index.checked_sub(1).and_then(|index| lines.get(index)),
                Some(line),
                lines.get(line_index + 1),
            ]
            .into_iter()
            .flatten()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            for token in line.split(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '_' | '.'))
            }) {
                let accession = token
                    .trim_matches(|character: char| !character.is_ascii_alphanumeric())
                    .to_ascii_uppercase();
                let Some(kind) = resource_citation_kind(&accession) else {
                    continue;
                };
                let line_role = resource_role(kind, line);
                let role = if line_role == ResourceRole::Unknown {
                    resource_role(kind, &context)
                } else {
                    line_role
                };
                if let Some(existing) = citations
                    .iter_mut()
                    .find(|citation| citation.accession == accession)
                {
                    if resource_role_priority(role) > resource_role_priority(existing.role) {
                        existing.role = role;
                        existing.context = context.clone();
                        existing.page = Some(page_index + 1);
                    }
                    continue;
                }
                citations.push(ResourceCitation {
                    accession,
                    kind,
                    role,
                    context: context.clone(),
                    page: Some(page_index + 1),
                });
            }
        }
    }
    citations
}

fn resource_citation_kind(accession: &str) -> Option<ResourceCitationKind> {
    let digits_after = |prefix: &str| {
        accession.strip_prefix(prefix).is_some_and(|value| {
            value.len() >= 6 && value.chars().all(|character| character.is_ascii_digit())
        })
    };
    if ["SRR", "ERR", "DRR"]
        .iter()
        .any(|prefix| digits_after(prefix))
    {
        return Some(ResourceCitationKind::SraRun);
    }
    if ["SRP", "ERP", "DRP"]
        .iter()
        .any(|prefix| digits_after(prefix))
    {
        return Some(ResourceCitationKind::SraStudy);
    }
    if ["SRX", "ERX", "DRX"]
        .iter()
        .any(|prefix| digits_after(prefix))
    {
        return Some(ResourceCitationKind::SraExperiment);
    }
    if ["SRS", "ERS", "DRS"]
        .iter()
        .any(|prefix| digits_after(prefix))
    {
        return Some(ResourceCitationKind::SraSample);
    }
    if ["PRJNA", "PRJEB", "PRJDB"]
        .iter()
        .any(|prefix| digits_after(prefix))
    {
        return Some(ResourceCitationKind::BioProject);
    }
    if ["SAMN", "SAMEA", "SAMD"]
        .iter()
        .any(|prefix| digits_after(prefix))
    {
        return Some(ResourceCitationKind::BioSample);
    }
    if ["GCA_", "GCF_"].iter().any(|prefix| {
        accession.strip_prefix(prefix).is_some_and(|value| {
            let mut parts = value.split('.');
            parts.next().is_some_and(|digits| {
                !digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit())
            }) && parts.next().is_none_or(|version| {
                !version.is_empty() && version.chars().all(|character| character.is_ascii_digit())
            }) && parts.next().is_none()
        })
    }) {
        return Some(ResourceCitationKind::Assembly);
    }
    let ensembl = accession.strip_prefix("ENS")?;
    ensembl.char_indices().find_map(|(index, character)| {
        if !matches!(character, 'G' | 'T' | 'P')
            || !ensembl[..index]
                .chars()
                .all(|value| value.is_ascii_uppercase())
        {
            return None;
        }
        let mut parts = ensembl[index + 1..].split('.');
        let digits = parts.next()?;
        (!digits.is_empty()
            && digits.chars().all(|value| value.is_ascii_digit())
            && parts.next().is_none_or(|version| {
                !version.is_empty() && version.chars().all(|value| value.is_ascii_digit())
            })
            && parts.next().is_none())
        .then_some(ResourceCitationKind::Ensembl)
    })
}

fn resource_role(kind: ResourceCitationKind, context: &str) -> ResourceRole {
    let lower = context.to_ascii_lowercase();
    if kind == ResourceCitationKind::Assembly
        || ["genome assembly", "reference genome", "genomic reference"]
            .iter()
            .any(|needle| lower.contains(needle))
    {
        return ResourceRole::Reference;
    }
    if kind == ResourceCitationKind::Ensembl {
        return ResourceRole::Annotation;
    }
    if matches!(
        kind,
        ResourceCitationKind::SraStudy
            | ResourceCitationKind::SraSample
            | ResourceCitationKind::SraExperiment
            | ResourceCitationKind::SraRun
    ) || [
        "rna-seq",
        "dna-seq",
        "wgs",
        "paired-end",
        "sequence data",
        "sequencing reads",
        "sra accession",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return ResourceRole::Reads;
    }
    if ["annotation", "gene model", "gtf", "gff"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return ResourceRole::Annotation;
    }
    if matches!(kind, ResourceCitationKind::BioSample) {
        return ResourceRole::SampleMetadata;
    }
    ResourceRole::Unknown
}

fn resource_role_priority(role: ResourceRole) -> u8 {
    match role {
        ResourceRole::Unknown => 0,
        ResourceRole::SampleMetadata => 1,
        ResourceRole::Annotation => 2,
        ResourceRole::Reads => 3,
        ResourceRole::Reference => 4,
    }
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
    let mut start = i.saturating_sub(48);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (i + n.len() + 48).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
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

fn wire_all(g: &mut Graph, from: &str, to: &str) {
    loop {
        let before = g.edges.len();
        wire(g, from, to);
        if g.edges.len() == before {
            break;
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

fn reviewed_gap_ports(input: PortType, output: PortType) -> Vec<Port> {
    let union = match input {
        PortType::Fastq => vec![PortType::Fastq, PortType::FastqGz],
        PortType::Fasta => vec![PortType::Fasta, PortType::FastaGz],
        PortType::Gtf => vec![PortType::Gtf, PortType::GtfGz],
        PortType::Directory => vec![PortType::Directory, PortType::Table],
        _ => vec![input],
    };
    vec![p_in("in", input, union), p_out("out", output)]
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

    fn ops(r: &CandidateGraph) -> Vec<&str> {
        r.graph.nodes.iter().map(|n| n.operator.as_str()).collect()
    }

    fn assert_wired(r: &CandidateGraph) {
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

    #[derive(Debug)]
    struct GoldCase {
        line: usize,
        fixture: String,
        extract_via: ExtractVia,
        outcome: ReconstructionOutcome,
        tracks: Vec<String>,
        expected_entities: Vec<String>,
        forbidden_entities: Vec<String>,
        required_operators: Vec<String>,
        forbidden_operators: Vec<String>,
        required_unsupported: Vec<String>,
        expected_candidates: usize,
        required_paths: Vec<Vec<String>>,
        required_branches: Vec<GoldBranch>,
        separate_alternatives: Vec<Vec<String>>,
        parameters: Vec<GoldParameter>,
        minimum_evidence_records: usize,
        minimum_evidence_support_pct: usize,
        exact_runs: Vec<String>,
        forbid_collection_reads: bool,
    }

    #[derive(Debug)]
    struct GoldBranch {
        root: String,
        arms: Vec<String>,
    }

    #[derive(Debug)]
    struct GoldParameter {
        selector: String,
        name: String,
        value: String,
    }

    type FullPaperCase<'a> = (
        &'a str,
        ReconstructionOutcome,
        Option<Assay>,
        &'a [&'a str],
        &'a [&'a str],
        &'a [&'a str],
    );

    #[derive(Default)]
    struct MetricScore {
        passed: usize,
        checked: usize,
        failures: Vec<String>,
    }

    impl MetricScore {
        fn check(&mut self, condition: bool, failure: String) {
            self.checked += 1;
            if condition {
                self.passed += 1;
            } else {
                self.failures.push(failure);
            }
        }
    }

    fn gold_list(value: &str) -> Vec<String> {
        if value == "-" {
            Vec::new()
        } else {
            value.split(',').map(str::to_owned).collect()
        }
    }

    fn gold_assertions(value: &str) -> Vec<String> {
        if value == "-" {
            Vec::new()
        } else {
            value.split(';').map(str::to_owned).collect()
        }
    }

    fn gold_tracks(value: &str, line: usize) -> Vec<String> {
        let tracks = gold_list(value);
        for track in &tracks {
            assert!(
                matches!(
                    track.as_str(),
                    "assembly"
                        | "rna_seq"
                        | "variants"
                        | "metagenome"
                        | "single_cell"
                        | "qc"
                        | "mixed"
                        | "unknown"
                ),
                "gold.tsv line {line} has unknown track {track:?}"
            );
        }
        tracks
    }

    fn gold_paths(value: &str, line: usize) -> Vec<Vec<String>> {
        gold_assertions(value)
            .into_iter()
            .map(|path| {
                let selectors = path.split('>').map(str::to_owned).collect::<Vec<_>>();
                assert!(
                    selectors.len() >= 2 && selectors.iter().all(|selector| !selector.is_empty()),
                    "gold.tsv line {line} has invalid path {path:?}"
                );
                selectors
            })
            .collect()
    }

    fn gold_branches(value: &str, line: usize) -> Vec<GoldBranch> {
        gold_assertions(value)
            .into_iter()
            .map(|branch| {
                let (root, arms) = branch.split_once('>').unwrap_or_else(|| {
                    panic!("gold.tsv line {line} has invalid branch {branch:?}")
                });
                let arms = arms.split('|').map(str::to_owned).collect::<Vec<_>>();
                assert!(
                    !root.is_empty()
                        && arms.len() >= 2
                        && arms.iter().all(|selector| !selector.is_empty()),
                    "gold.tsv line {line} has invalid branch {branch:?}"
                );
                GoldBranch {
                    root: root.to_owned(),
                    arms,
                }
            })
            .collect()
    }

    fn gold_alternatives(value: &str, line: usize) -> Vec<Vec<String>> {
        gold_assertions(value)
            .into_iter()
            .map(|group| {
                let selectors = group.split('|').map(str::to_owned).collect::<Vec<_>>();
                assert!(
                    selectors.len() >= 2 && selectors.iter().all(|selector| !selector.is_empty()),
                    "gold.tsv line {line} has invalid alternatives {group:?}"
                );
                selectors
            })
            .collect()
    }

    fn gold_parameters(value: &str, line: usize) -> Vec<GoldParameter> {
        gold_assertions(value)
            .into_iter()
            .map(|expectation| {
                let (selector, parameter) = expectation.split_once(':').unwrap_or_else(|| {
                    panic!("gold.tsv line {line} has invalid parameter {expectation:?}")
                });
                let (name, value) = parameter.split_once('=').unwrap_or_else(|| {
                    panic!("gold.tsv line {line} has invalid parameter {expectation:?}")
                });
                assert!(
                    !selector.is_empty() && !name.is_empty() && !value.is_empty(),
                    "gold.tsv line {line} has invalid parameter {expectation:?}"
                );
                GoldParameter {
                    selector: selector.to_owned(),
                    name: name.to_owned(),
                    value: value.to_owned(),
                }
            })
            .collect()
    }

    fn gold_cases(root: &Path) -> Vec<GoldCase> {
        let manifest = std::fs::read_to_string(root.join("gold.tsv")).expect("paper gold manifest");
        assert!(
            manifest.starts_with("# schema_version=2\n"),
            "gold.tsv must declare schema_version=2"
        );
        manifest
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.starts_with('#') && !line.starts_with("fixture\t"))
            .map(|(index, line)| {
                let fields = line.split('\t').collect::<Vec<_>>();
                assert_eq!(
                    fields.len(),
                    18,
                    "gold.tsv line {} must contain 18 tab-separated fields: {line:?}",
                    index + 1
                );
                let extract_via = match fields[1] {
                    "utf8" => ExtractVia::Utf8,
                    "poppler" => ExtractVia::Poppler,
                    "tesseract" => ExtractVia::Tesseract,
                    value => panic!(
                        "gold.tsv line {} has unknown extraction path {value:?}",
                        index + 1
                    ),
                };
                let outcome = match fields[2] {
                    "drafts_ready" => ReconstructionOutcome::DraftsReady,
                    "recognized_unsupported" => ReconstructionOutcome::RecognizedUnsupported,
                    "no_reconstructable_methods" => ReconstructionOutcome::NoReconstructableMethods,
                    value => panic!("gold.tsv line {} has unknown outcome {value:?}", index + 1),
                };
                let minimum_evidence_support_pct = fields[15].parse().unwrap_or_else(|_| {
                    panic!(
                        "gold.tsv line {} has invalid evidence support percentage",
                        index + 1
                    )
                });
                assert!(
                    minimum_evidence_support_pct <= 100,
                    "gold.tsv line {} evidence support percentage exceeds 100",
                    index + 1
                );
                GoldCase {
                    line: index + 1,
                    fixture: fields[0].to_owned(),
                    extract_via,
                    outcome,
                    tracks: gold_tracks(fields[3], index + 1),
                    expected_entities: gold_list(fields[4]),
                    forbidden_entities: gold_list(fields[5]),
                    required_operators: gold_list(fields[6]),
                    forbidden_operators: gold_list(fields[7]),
                    required_unsupported: gold_list(fields[8]),
                    expected_candidates: fields[9].parse().unwrap_or_else(|_| {
                        panic!("gold.tsv line {} has invalid candidate count", index + 1)
                    }),
                    required_paths: gold_paths(fields[10], index + 1),
                    required_branches: gold_branches(fields[11], index + 1),
                    separate_alternatives: gold_alternatives(fields[12], index + 1),
                    parameters: gold_parameters(fields[13], index + 1),
                    minimum_evidence_records: fields[14].parse().unwrap_or_else(|_| {
                        panic!("gold.tsv line {} has invalid evidence count", index + 1)
                    }),
                    minimum_evidence_support_pct,
                    exact_runs: gold_list(fields[16]),
                    forbid_collection_reads: fields[17].parse().unwrap_or_else(|_| {
                        panic!("gold.tsv line {} has invalid resource boolean", index + 1)
                    }),
                }
            })
            .collect()
    }

    fn assay_gold_label(assay: Assay) -> &'static str {
        match assay {
            Assay::Assembly => "assembly",
            Assay::RnaSeq => "rna_seq",
            Assay::Variants => "variants",
            Assay::Metagenome => "metagenome",
            Assay::SingleCell => "single_cell",
            Assay::Qc => "qc",
            Assay::Mixed => "mixed",
            Assay::Unknown => "unknown",
        }
    }

    fn gold_node_selector(node: &Node) -> String {
        if node.operator == "gap.missing" {
            if let Some(ParamValue::String(tool)) = node.params.get("tool") {
                return format!("gap:{tool}");
            }
        }
        node.operator.clone()
    }

    fn candidate_contains_selector(candidate: &CandidateGraph, selector: &str) -> bool {
        candidate
            .graph
            .nodes
            .iter()
            .any(|node| gold_node_selector(node) == selector)
    }

    fn candidate_reaches(candidate: &CandidateGraph, from: &str, to: &str) -> bool {
        let targets = candidate
            .graph
            .nodes
            .iter()
            .filter(|node| gold_node_selector(node) == to)
            .map(|node| node.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let mut pending = candidate
            .graph
            .nodes
            .iter()
            .filter(|node| gold_node_selector(node) == from)
            .map(|node| node.id.clone())
            .collect::<std::collections::VecDeque<_>>();
        let mut visited = std::collections::BTreeSet::new();
        while let Some(node) = pending.pop_front() {
            if !visited.insert(node.clone()) {
                continue;
            }
            if targets.contains(node.as_str()) {
                return true;
            }
            for edge in candidate
                .graph
                .edges
                .iter()
                .filter(|edge| edge.from_node == node)
            {
                pending.push_back(edge.to_node.clone());
            }
        }
        false
    }

    fn candidate_contains_path(candidate: &CandidateGraph, path: &[String]) -> bool {
        path.windows(2)
            .all(|pair| candidate_reaches(candidate, &pair[0], &pair[1]))
    }

    fn parameter_text(value: &ParamValue) -> String {
        match value {
            ParamValue::Bool(value) => value.to_string(),
            ParamValue::Int(value) => value.to_string(),
            ParamValue::Float(value) => value.to_string(),
            ParamValue::String(value) => value.clone(),
        }
    }

    #[test]
    fn committed_gold_manifest_reconstructs_through_the_public_interface() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/papers");
        let catalog = cat();
        let cases = gold_cases(&root);
        let declared = cases
            .iter()
            .map(|case| case.fixture.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let committed = std::fs::read_dir(&root)
            .expect("paper fixtures directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter_map(|name| name.to_str().map(str::to_owned))
            .filter(|name| name.ends_with(".txt"))
            .collect::<std::collections::BTreeSet<_>>();
        let mut extraction = MetricScore::default();
        for fixture in committed
            .iter()
            .filter(|fixture| !declared.contains(fixture.as_str()))
        {
            extraction.check(
                false,
                format!("gold.tsv has no row for committed fixture {fixture}"),
            );
        }
        let mut classification = MetricScore::default();
        let mut entity_recall = MetricScore::default();
        let mut entity_precision = MetricScore::default();
        let mut operator_support = MetricScore::default();
        let mut candidates = MetricScore::default();
        let mut nodes = MetricScore::default();
        let mut typed_edges = MetricScore::default();
        let mut topology = MetricScore::default();
        let mut parameters = MetricScore::default();
        let mut evidence_spans = MetricScore::default();
        let mut resources = MetricScore::default();
        let mut skipped = 0usize;
        let mut draft_outcomes = 0usize;
        let mut unsupported_outcomes = 0usize;
        let mut empty_outcomes = 0usize;
        let mut empty_candidates = 0usize;
        let mut unsupported_mentions = 0usize;

        for case in &cases {
            let path = root.join(&case.fixture);
            let extracted = match extract_from_path(&path) {
                Ok(extracted) => extracted,
                Err(error) => {
                    extraction.check(
                        false,
                        format!(
                            "gold.tsv line {} fixture {} input unavailable: {error}",
                            case.line, case.fixture
                        ),
                    );
                    skipped += 1;
                    continue;
                }
            };
            let prefix = format!("gold.tsv line {} fixture {}", case.line, case.fixture);
            extraction.check(
                extracted.via == case.extract_via,
                format!(
                    "{prefix}: extraction {:?}, expected {:?}",
                    extracted.via, case.extract_via
                ),
            );
            let reconstruction = reconstruct(&catalog, &extracted.text);
            match reconstruction.outcome {
                ReconstructionOutcome::DraftsReady => draft_outcomes += 1,
                ReconstructionOutcome::RecognizedUnsupported => unsupported_outcomes += 1,
                ReconstructionOutcome::NoReconstructableMethods => empty_outcomes += 1,
            }
            unsupported_mentions += reconstruction
                .mentions
                .iter()
                .filter(|mention| mention.support == MethodSupport::Unsupported)
                .count();
            empty_candidates += reconstruction
                .candidates
                .iter()
                .filter(|candidate| candidate.graph.nodes.is_empty())
                .count();
            let prefix = format!("gold.tsv line {} fixture {}", case.line, case.fixture);
            classification.check(
                reconstruction.outcome == case.outcome,
                format!(
                    "{prefix}: outcome {:?}, expected {:?}",
                    reconstruction.outcome, case.outcome
                ),
            );
            let actual_tracks = reconstruction
                .candidates
                .iter()
                .map(|candidate| assay_gold_label(candidate.assay).to_owned())
                .collect::<std::collections::BTreeSet<_>>();
            let expected_tracks = case
                .tracks
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            classification.check(
                actual_tracks == expected_tracks,
                format!("{prefix}: assay tracks {actual_tracks:?}, expected {expected_tracks:?}"),
            );

            let actual_entities = reconstruction
                .mentions
                .iter()
                .map(|mention| mention.normalized_name.clone())
                .collect::<std::collections::BTreeSet<_>>();
            let expected_entities = case
                .expected_entities
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            for expected in &expected_entities {
                entity_recall.check(
                    actual_entities.contains(expected),
                    format!(
                        "{prefix}: missing method entity {expected}; observed {actual_entities:?}"
                    ),
                );
            }
            for actual in &actual_entities {
                entity_precision.check(
                    expected_entities.contains(actual),
                    format!(
                        "{prefix}: false-positive method entity {actual}; expected {expected_entities:?}"
                    ),
                );
            }
            for forbidden in &case.forbidden_entities {
                entity_precision.check(
                    !actual_entities.contains(forbidden),
                    format!(
                        "{prefix}: forbidden method entity {forbidden}; observed {actual_entities:?}"
                    ),
                );
            }

            let operators = reconstruction
                .candidates
                .iter()
                .flat_map(|candidate| candidate.graph.nodes.iter())
                .map(|node| node.operator.as_str())
                .collect::<Vec<_>>();
            for required in &case.required_operators {
                operator_support.check(
                    operators.contains(&required.as_str()),
                    format!(
                        "{prefix}: missing required operator {required}; reconstructed {operators:?}"
                    ),
                );
            }
            for forbidden in &case.forbidden_operators {
                operator_support.check(
                    !operators.contains(&forbidden.as_str()),
                    format!(
                        "{prefix}: invented forbidden operator {forbidden}; reconstructed {operators:?}"
                    ),
                );
            }
            let unsupported = reconstruction
                .mentions
                .iter()
                .filter(|mention| mention.support == MethodSupport::Unsupported)
                .map(|mention| mention.normalized_name.as_str())
                .collect::<std::collections::BTreeSet<_>>();
            for required in &case.required_unsupported {
                operator_support.check(
                    unsupported.contains(required.as_str()),
                    format!(
                        "{prefix}: missing unsupported method {required}; retained {unsupported:?}"
                    ),
                );
            }

            candidates.check(
                reconstruction.candidates.len() == case.expected_candidates,
                format!(
                    "{prefix}: candidates {}, expected {}",
                    reconstruction.candidates.len(),
                    case.expected_candidates
                ),
            );
            for (index, candidate) in reconstruction.candidates.iter().enumerate() {
                nodes.check(
                    !candidate.graph.nodes.is_empty(),
                    format!("{prefix}: candidate {index} exported zero nodes"),
                );
                let validity = candidate
                    .graph
                    .validate()
                    .map_err(|error| error.to_string())
                    .and_then(|_| {
                        catalog
                            .verify_graph(&candidate.graph)
                            .map_err(|error| error.to_string())
                    });
                typed_edges.check(
                    validity.is_ok(),
                    format!(
                        "{prefix}: candidate {index} has invalid nodes or typed edges: {:?}",
                        validity.err()
                    ),
                );
            }

            for path in &case.required_paths {
                topology.check(
                    reconstruction
                        .candidates
                        .iter()
                        .any(|candidate| candidate_contains_path(candidate, path)),
                    format!("{prefix}: missing ordered path {}", path.join(" > ")),
                );
            }
            for branch in &case.required_branches {
                topology.check(
                    reconstruction.candidates.iter().any(|candidate| {
                        branch
                            .arms
                            .iter()
                            .all(|arm| candidate_reaches(candidate, &branch.root, arm))
                    }),
                    format!(
                        "{prefix}: missing branch {} > {}",
                        branch.root,
                        branch.arms.join(" | ")
                    ),
                );
            }
            for alternatives in &case.separate_alternatives {
                let placements = alternatives
                    .iter()
                    .map(|selector| {
                        reconstruction
                            .candidates
                            .iter()
                            .enumerate()
                            .filter(|(_, candidate)| {
                                candidate_contains_selector(candidate, selector)
                            })
                            .map(|(index, _)| index)
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                let distinct = placements
                    .iter()
                    .flatten()
                    .copied()
                    .collect::<std::collections::BTreeSet<_>>();
                topology.check(
                    placements.iter().all(|indices| indices.len() == 1)
                        && distinct.len() == alternatives.len(),
                    format!(
                        "{prefix}: alternatives were not separate {} placements={placements:?}",
                        alternatives.join(" | ")
                    ),
                );
            }

            for expected in &case.parameters {
                let actual = reconstruction
                    .candidates
                    .iter()
                    .flat_map(|candidate| candidate.graph.nodes.iter())
                    .filter(|node| gold_node_selector(node) == expected.selector)
                    .filter_map(|node| node.params.get(&expected.name))
                    .map(parameter_text)
                    .collect::<Vec<_>>();
                parameters.check(
                    actual.contains(&expected.value),
                    format!(
                        "{prefix}: parameter {}:{} expected {:?}, observed {actual:?}",
                        expected.selector, expected.name, expected.value
                    ),
                );
            }

            let evidence_records = reconstruction.mentions.len()
                + reconstruction
                    .candidates
                    .iter()
                    .map(|candidate| candidate.evidence.len())
                    .sum::<usize>();
            evidence_spans.check(
                evidence_records >= case.minimum_evidence_records,
                format!(
                    "{prefix}: retained {evidence_records} evidence records, expected at least {}",
                    case.minimum_evidence_records
                ),
            );
            let mut supported_evidence = 0usize;
            let mut expected_evidence = 0usize;
            for mention in &reconstruction.mentions {
                expected_evidence += 1;
                let supported = !mention.evidence.trim().is_empty()
                    && mention.evidence.contains(&mention.display_name);
                supported_evidence += usize::from(supported);
                evidence_spans.check(
                    supported,
                    format!(
                        "{prefix}: method {} lacks an exact evidence span",
                        mention.normalized_name
                    ),
                );
            }
            for (index, candidate) in reconstruction.candidates.iter().enumerate() {
                for node in &candidate.graph.nodes {
                    expected_evidence += 1;
                    let supported = candidate.evidence.iter().any(|record| {
                        matches!(&record.target, EvidenceTarget::Node(id) if id == &node.id)
                            && !record.detail.trim().is_empty()
                    });
                    supported_evidence += usize::from(supported);
                    evidence_spans.check(
                        supported,
                        format!(
                            "{prefix}: candidate {index} node {} lacks evidence",
                            node.id
                        ),
                    );
                }
                for edge in &candidate.graph.edges {
                    expected_evidence += 1;
                    let supported = candidate.evidence.iter().any(|record| {
                        matches!(&record.target, EvidenceTarget::Edge(id) if id == &edge.id)
                            && !record.detail.trim().is_empty()
                    });
                    supported_evidence += usize::from(supported);
                    evidence_spans.check(
                        supported,
                        format!(
                            "{prefix}: candidate {index} edge {} lacks evidence",
                            edge.id
                        ),
                    );
                }
            }
            let support_pct = supported_evidence
                .saturating_mul(100)
                .checked_div(expected_evidence)
                .unwrap_or(100);
            evidence_spans.check(
                support_pct >= case.minimum_evidence_support_pct,
                format!(
                    "{prefix}: evidence-span support {support_pct}%, expected at least {}%",
                    case.minimum_evidence_support_pct
                ),
            );

            let citations = resource_citations(&extracted.text);
            let selected_runs = reconstruction
                .candidates
                .iter()
                .flat_map(|candidate| candidate.graph.nodes.iter())
                .filter(|node| node.operator == "sra.prefetch")
                .filter_map(|node| match node.params.get("accession") {
                    Some(ParamValue::String(accession)) => Some(accession.clone()),
                    _ => None,
                })
                .collect::<std::collections::BTreeSet<_>>();
            for run in &selected_runs {
                resources.check(
                    citations.iter().any(|citation| {
                        citation.kind == ResourceCitationKind::SraRun && citation.accession == *run
                    }),
                    format!("{prefix}: selected SRA run {run} lacks an exact run citation"),
                );
            }
            if !case.exact_runs.is_empty() {
                let expected_runs = case
                    .exact_runs
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>();
                resources.check(
                    selected_runs == expected_runs,
                    format!(
                        "{prefix}: selected runs {selected_runs:?}, expected {expected_runs:?}"
                    ),
                );
            }
            if case.forbid_collection_reads {
                let has_read_collection = citations.iter().any(|citation| {
                    citation.role == ResourceRole::Reads
                        && citation.kind != ResourceCitationKind::SraRun
                });
                resources.check(
                    has_read_collection && selected_runs.is_empty(),
                    format!(
                        "{prefix}: collection citation became selected reads {selected_runs:?}"
                    ),
                );
            }
        }

        let metrics = [
            ("extraction", &extraction),
            ("classification", &classification),
            ("entity_recall", &entity_recall),
            ("entity_precision", &entity_precision),
            ("operator_support", &operator_support),
            ("candidates", &candidates),
            ("nodes", &nodes),
            ("typed_edges", &typed_edges),
            ("topology", &topology),
            ("parameters", &parameters),
            ("evidence_spans", &evidence_spans),
            ("resources", &resources),
        ];
        let failures = metrics
            .iter()
            .flat_map(|(name, metric)| {
                metric
                    .failures
                    .iter()
                    .map(move |failure| format!("[{name}] {failure}"))
            })
            .collect::<Vec<_>>();
        eprintln!(
            "paper corpus summary: cases={} skipped={} outcomes={{drafts_ready:{draft_outcomes}, recognized_unsupported:{unsupported_outcomes}, no_reconstructable_methods:{empty_outcomes}}} empty_candidates={empty_candidates} unsupported_mentions={unsupported_mentions} metric_failures={}",
            cases.len(),
            skipped,
            failures.len()
        );
        eprintln!(
            "paper corpus metrics: {}",
            metrics
                .iter()
                .map(|(name, metric)| format!("{name}={}/{}", metric.passed, metric.checked))
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert!(
            failures.is_empty(),
            "paper gold regression failures:\n{}",
            failures.join("\n")
        );
    }

    #[test]
    fn rnaseq_paper_builds_a_brick_dag() {
        let r = reconstruct(&cat(), RNA);
        let r = r.active().expect("RNA-seq workflow draft");
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(r);
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
        assert_wired(r);
    }

    #[test]
    fn local_paired_reads_remain_separate_without_an_accession() {
        let r = reconstruct(
            &cat(),
            "Paired-end RNA-seq reads were trimmed with fastp and aligned to the genome with STAR.",
        );
        let r = r.active().expect("paired-read workflow draft");
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
        let r = r.active().expect("nf-core workflow draft");
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(r);
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
        assert_wired(r);
    }

    #[test]
    fn fastqc_only() {
        let r = reconstruct(&cat(), QC);
        let r = r.active().expect("FastQC workflow draft");
        assert_eq!(r.assay, Assay::Qc);
        r.graph.validate().unwrap();
        assert!(r.graph.nodes.iter().any(|n| n.operator == "qc.fastqc"));
        assert!(r.graph.nodes.iter().any(|n| n.operator == "files.import"));
    }

    #[test]
    fn variants_without_sarek_are_bwa_then_gatk() {
        let r = reconstruct(&cat(), VAR);
        let r = r.active().expect("variant workflow draft");
        assert_eq!(r.assay, Assay::Variants);
        let ops = ops(r);
        assert!(ops.contains(&"nf.sarek"), "fixture names sarek: {ops:?}");
        assert!(!ops.contains(&"align.bwa"), "BWA is inside sarek");
        assert_wired(r);
    }

    #[test]
    fn empty_is_honest() {
        let r = reconstruct(&cat(), "This paper is about the history of algebra.");
        assert_eq!(r.outcome, ReconstructionOutcome::NoReconstructableMethods);
        assert!(r.candidates.is_empty());
        assert!(r.mentions.is_empty());
        assert!(r.active().is_none());
        assert!(!r.warnings.is_empty());
    }

    #[test]
    fn unsupported_methods_are_retained_without_a_fake_candidate() {
        let r = reconstruct(
            &cat(),
            "Methods\nOxford Nanopore reads were trimmed with Porechop. Raw reads were run through dnaPipeTE, which used Trinity to assemble repeats. RepeatMasker annotated the resulting repeat library. A custom Perl script combined the tables.\nResults",
        );
        assert_eq!(r.outcome, ReconstructionOutcome::RecognizedUnsupported);
        assert!(r.candidates.is_empty());
        let names = r
            .mentions
            .iter()
            .map(|mention| mention.normalized_name.as_str())
            .collect::<Vec<_>>();
        for expected in [
            "porechop",
            "dnapipete",
            "trinity",
            "repeatmasker",
            "custom-script",
        ] {
            assert!(names.contains(&expected), "missing {expected}: {names:?}");
        }
        assert!(r
            .mentions
            .iter()
            .all(|mention| !mention.evidence.is_empty()));
    }

    #[test]
    fn exact_te_tool_identities_are_retained_without_collapsing_prefixes() {
        let reconstruction = reconstruct(
            &cat(),
            "Methods\nPiRATE combined repeat evidence from RepeatModeler and dipSPAdes 3.12.0. Bowtie2 and seqkit processed reads; parseRM.pl summarized RepeatMasker output. LTRpred and Trinotate annotated candidates before CD-HIT-est clustering.\nResults",
        );
        let names = reconstruction
            .mentions
            .iter()
            .map(|mention| mention.display_name.as_str())
            .collect::<Vec<_>>();

        for expected in [
            "PiRATE",
            "dipSPAdes",
            "RepeatModeler",
            "Bowtie2",
            "seqkit",
            "parseRM.pl",
            "LTRpred",
            "Trinotate",
            "CD-HIT-est",
        ] {
            assert!(names.contains(&expected), "missing {expected}: {names:?}");
        }
        assert!(!names.contains(&"SPAdes"), "dipSPAdes collapsed: {names:?}");
        assert!(!names.contains(&"Bowtie"), "Bowtie2 collapsed: {names:?}");
        assert_eq!(
            reconstruction.outcome,
            ReconstructionOutcome::RecognizedUnsupported
        );
        assert!(reconstruction.candidates.is_empty());
    }

    #[test]
    fn dipspades_does_not_add_an_spades_gap_to_a_supported_draft() {
        let reconstruction = reconstruct(
            &cat(),
            "Methods\nRNA-seq reads were checked with FastQC. A separate dipSPAdes 3.12.0 analysis assembled repeat-associated reads.\nResults",
        );
        let candidate = reconstruction.active().expect("FastQC workflow draft");

        assert!(reconstruction
            .mentions
            .iter()
            .any(|mention| mention.display_name == "dipSPAdes"));
        assert!(!candidate.graph.nodes.iter().any(|node| {
            node.operator == "gap.missing"
                && node.params.get("tool") == Some(&ParamValue::String("SPAdes".into()))
        }));
    }

    #[test]
    fn mention_only_methods_are_retained_without_guessed_gap_nodes() {
        let reconstruction = reconstruct(
            &cat(),
            "Methods\nRNA-seq reads were checked with FastQC. Porechop and dnaPipeTE77 were reported for a separate repeat analysis.\nResults",
        );
        for expected in ["porechop", "dnapipete"] {
            assert!(reconstruction
                .mentions
                .iter()
                .any(|mention| mention.normalized_name == expected));
        }
        let candidate = reconstruction.active().expect("FastQC workflow draft");
        assert!(ops(candidate).contains(&"qc.fastqc"));
        assert!(!candidate
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "gap.missing"));
    }

    #[test]
    fn source_and_gap_only_candidates_are_not_usable_drafts() {
        let reconstruction = reconstruct(
            &cat(),
            "Methods\nPaired-end RNA-seq reads were analyzed with Ballgown.\nResults",
        );

        assert_eq!(
            reconstruction.outcome,
            ReconstructionOutcome::RecognizedUnsupported
        );
        assert!(reconstruction.candidates.is_empty());
        assert!(reconstruction.active().is_none());
        assert!(reconstruction.mentions.iter().any(|mention| {
            mention.display_name == "Ballgown" && mention.support == MethodSupport::Unsupported
        }));
    }

    #[test]
    fn statistical_methods_are_not_misreported_as_a_cover_page() {
        let r = reconstruct(
            &cat(),
            "Methods\nPhylogeny subsampling was performed with the R package phytools. All models were fit in the R statistical computing environment.\nResults",
        );
        assert_eq!(r.outcome, ReconstructionOutcome::RecognizedUnsupported);
        let names = r
            .mentions
            .iter()
            .map(|mention| mention.normalized_name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"phytools"), "{names:?}");
        assert!(names.contains(&"r"), "{names:?}");
        assert!(r.warnings.iter().any(|warning| {
            warning
                == "Somite recognized these computational methods, but workflow support for them is not available yet."
        }));
        assert!(
            !r.warnings
                .iter()
                .any(|warning| warning.contains("cover page")
                    || warning.contains("no tools or assay"))
        );
    }

    #[test]
    fn catalog_method_mentions_use_the_exact_methods_occurrence() {
        let text = "The abstract compares our results with FastQC reports.\n\u{000c}Methods\nReads were assessed with FastQC before alignment.\nResults";
        assert!(
            methods_window(text).starts_with("Methods"),
            "unexpected methods window: {:?}",
            methods_window(text)
        );
        let r = reconstruct(&cat(), text);
        assert_eq!(r.outcome, ReconstructionOutcome::DraftsReady);
        let mention = r
            .mentions
            .iter()
            .find(|mention| mention.normalized_name == "fastqc")
            .expect("FastQC method mention");
        assert_eq!(mention.page, Some(2));
        assert_eq!(mention.support, MethodSupport::Operator("qc.fastqc".into()));
        assert!(mention.evidence.contains("assessed with FastQC"));
    }

    #[test]
    fn two_column_methods_keep_same_page_text_emitted_before_the_heading() {
        let text = "Abstract\nBackground only.\u{000c}Trimmomatic cleaned the reads before dnaPipeTE analysis and RepeatMasker annotation.\nMaterials and methods\nSamples were collected under permit.\nResults\nThe repeat landscape varied.";

        let reconstruction = reconstruct(&cat(), text);
        let mentions: Vec<_> = reconstruction
            .mentions
            .iter()
            .map(|mention| (mention.display_name.as_str(), mention.page))
            .collect::<Vec<_>>();

        for method in ["Trimmomatic", "dnaPipeTE", "RepeatMasker"] {
            assert!(
                mentions.contains(&(method, Some(2))),
                "same-page pre-heading method {method} was lost: {mentions:?}"
            );
        }
    }

    #[test]
    fn catalog_recognition_metadata_drives_supported_graph_nodes() {
        let mut catalog = cat();
        catalog
            .ops
            .get_mut("align.star")
            .expect("STAR operator")
            .paper
            .as_mut()
            .expect("STAR paper metadata")
            .aliases = vec!["SpliceRocket".into()];

        let reconstruction = reconstruct(
            &catalog,
            "Methods\nRNA-seq reads were aligned with SpliceRocket before quantification.\nResults",
        );
        let candidate = reconstruction
            .active()
            .expect("catalog-recognized RNA-seq draft");

        assert!(candidate
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "align.star"));
    }

    #[test]
    fn different_tools_and_negated_mentions_are_not_mapped_to_catalog_operators() {
        let r = reconstruct(
            &cat(),
            "Methods\nReads were processed without FastQC and trimmed with Cutadapt before downstream analysis.\nResults",
        );
        let operators = r
            .candidates
            .iter()
            .flat_map(|candidate| candidate.graph.nodes.iter())
            .map(|node| node.operator.as_str())
            .collect::<Vec<_>>();
        assert!(!operators.contains(&"qc.fastqc"), "{operators:?}");
        assert!(!operators.contains(&"qc.fastp"), "{operators:?}");
        assert!(!r
            .mentions
            .iter()
            .any(|mention| mention.normalized_name == "fastqc"));
        assert!(r
            .mentions
            .iter()
            .any(|mention| mention.normalized_name == "cutadapt"
                && mention.support == MethodSupport::Unsupported));
    }

    #[test]
    fn collapsed_citation_numbers_do_not_turn_numbered_tool_names_into_prefix_matches() {
        let mut catalog = cat();
        catalog
            .ops
            .get_mut("align.star")
            .expect("STAR operator")
            .paper
            .as_mut()
            .expect("STAR paper metadata")
            .aliases = vec!["HISAT".into(), "Kraken".into()];

        let reconstruction = reconstruct(
            &catalog,
            "Methods\nFaStP v0.23.4 trimmed reads and dnaPipeTE77 was used for repeat discovery. HISAT2 and Kraken2 were evaluated separately.\nResults",
        );

        let fastp = reconstruction
            .mentions
            .iter()
            .find(|mention| mention.normalized_name == "fastp")
            .expect("fastp mention");
        assert_eq!(fastp.display_name, "FaStP");
        assert!(fastp.evidence.contains("v0.23.4"));
        let dnapipete = reconstruction
            .mentions
            .iter()
            .find(|mention| mention.normalized_name == "dnapipete")
            .expect("dnaPipeTE mention");
        assert_eq!(dnapipete.display_name, "dnaPipeTE");
        assert!(dnapipete.evidence.contains("dnaPipeTE77"));
        assert!(!reconstruction
            .mentions
            .iter()
            .any(|mention| { mention.support == MethodSupport::Operator("align.star".into()) }));
    }

    #[test]
    fn hifi_input_does_not_invent_an_assembler() {
        let r = reconstruct(
            &cat(),
            "Methods\nPacBio HiFi reads were generated for de novo genome assembly, but the assembler was not reported.\nResults",
        );
        assert!(!r.candidates.iter().any(|candidate| candidate
            .graph
            .nodes
            .iter()
            .any(|node| node.operator == "asm.hifiasm")));
        assert_ne!(r.outcome, ReconstructionOutcome::DraftsReady);
        assert!(r.candidates.is_empty());
    }

    #[test]
    fn accessions_scan() {
        assert_eq!(
            accessions("see SRR1, SRS123456, and SRR123456"),
            vec!["SRR123456"]
        );
    }

    #[test]
    fn resource_citations_preserve_collections_roles_and_pages() {
        let citations = resource_citations(
            "Paired-end RNA-Seq datasets from NCBI BioProject PRJNA300706.\n\
             Samples SAMN123456 and SRS123456 and run SRR123456 were retained.\u{000c}\
             Sequence data are under SRP151479.\n\
             Genome Assembly: PRJNA482115 and GCA_009914755.4.\n\
             Annotation ENSAMXG00000012345.",
        );
        let citation = |accession: &str| {
            citations
                .iter()
                .find(|citation| citation.accession == accession)
                .unwrap_or_else(|| panic!("missing {accession}"))
        };
        assert_eq!(
            citation("PRJNA300706").kind,
            ResourceCitationKind::BioProject
        );
        assert_eq!(citation("PRJNA300706").role, ResourceRole::Reads);
        assert_eq!(citation("PRJNA300706").page, Some(1));
        assert_eq!(citation("SAMN123456").role, ResourceRole::SampleMetadata);
        assert_eq!(citation("SRS123456").role, ResourceRole::Reads);
        assert_eq!(citation("SRP151479").kind, ResourceCitationKind::SraStudy);
        assert_eq!(citation("SRP151479").page, Some(2));
        assert_eq!(citation("PRJNA482115").role, ResourceRole::Reference);
        assert_eq!(
            citation("GCA_009914755.4").kind,
            ResourceCitationKind::Assembly
        );
        assert_eq!(
            citation("ENSAMXG00000012345").kind,
            ResourceCitationKind::Ensembl
        );
    }

    #[test]
    fn assembly_paper_is_not_rnaseq() {
        let raw = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../testdata/papers/aphis_assembly_methods.txt"),
        )
        .unwrap();
        let r = reconstruct(&cat(), &raw);
        let r = r.active().expect("assembly workflow draft");
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
    fn linkage_scaffolding_paper_is_not_misread_as_rnaseq() {
        let text = "METHODS\nPaired DNA reads were aligned to a draft genome with BWA-MEM, filtered with samtools, and processed with GATK before VCFtools filtering. A meiotic linkage map was generated with JoinMap 4.1. Paired RNA-seq reads were aligned to the genomic scaffolds with BWA-MEM, then Rascaf and AGOUTI inferred supported linkages. The linkage and orientation evidence was combined with ALLMAPS to order and orient the scaffolds. FISH mapping provided physical validation.\nREFERENCES\nRNA-seq comparison paper.";
        let reconstruction = reconstruct(&cat(), text);
        let reconstruction = reconstruction
            .active()
            .expect("linkage-scaffolding workflow draft");

        assert_eq!(reconstruction.assay, Assay::Assembly);
        assert_eq!(reconstruction.name, "Linkage-guided scaffolding");
        let operators = ops(reconstruction);
        for expected in [
            "files.import_fasta",
            "align.samtools_view",
            "align.samtools_sort",
            "method.gatk3_unspecified",
            "var.vcftools_filter",
            "manual.joinmap",
            "asm.rascaf",
            "legacy.agouti",
            "manual.allmaps_evidence",
            "asm.allmaps",
        ] {
            assert!(
                operators.contains(&expected),
                "missing {expected}: {operators:?}"
            );
        }
        assert!(!operators.contains(&"gap.missing"));
        assert!(!operators.contains(&"asm.hifiasm"));
        reconstruction.graph.validate().unwrap();
        cat().verify_graph(&reconstruction.graph).unwrap();
        assert_wired(reconstruction);
    }

    #[test]
    fn love_deseq2_workflow_is_star_counts_deseq() {
        let r = reconstruct(&cat(), &fixture("love_rnaseq_methods.txt"));
        let r = r.active().expect("DESeq2 workflow draft");
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(r);
        assert!(ops.contains(&"align.star"), "{ops:?}");
        assert!(ops.contains(&"quant.featurecounts"));
        assert!(ops.contains(&"diff.deseq2"));
        assert!(ops.contains(&"sra.prefetch"));
        assert!(!ops.contains(&"nf.rnaseq"));
        assert_wired(r);
    }

    #[test]
    fn pertea_hisat_stringtie_ballgown() {
        let r = reconstruct(&cat(), &fixture("pertea_hisat_methods.txt"));
        let r = r.active().expect("HISAT2 workflow draft");
        assert_eq!(r.assay, Assay::RnaSeq);
        let ops = ops(r);
        assert!(ops.contains(&"align.hisat2"), "{ops:?}");
        assert!(ops.contains(&"quant.stringtie"));
        assert!(ops.contains(&"qc.fastqc"));
        let has_ballgown = r
            .graph
            .nodes
            .iter()
            .any(|n| n.params.get("tool") == Some(&ParamValue::String("Ballgown".into())));
        assert!(has_ballgown, "Ballgown is not a brick yet — gap");
        assert_wired(r);
    }

    #[test]
    fn gatk_best_practices_is_bwa_then_haplotypecaller() {
        let r = reconstruct(&cat(), &fixture("gatk_methods.txt"));
        let r = r.active().expect("GATK workflow draft");
        assert_eq!(r.assay, Assay::Variants);
        let ops = ops(r);
        assert!(ops.contains(&"align.bwa"), "{ops:?}");
        assert!(ops.contains(&"var.haplotypecaller"));
        assert!(!ops.contains(&"nf.sarek"));
        assert_wired(r);
    }

    #[test]
    fn vgp_is_falcon_purge_salsa_busco() {
        let r = reconstruct(&cat(), &fixture("vgp_assembly_methods.txt"));
        let r = r.active().expect("VGP workflow draft");
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
        assert!(ops(r).contains(&"qc.busco"));
        assert!(!ops(r).contains(&"nf.rnaseq"));
        assert_wired(r);
    }

    #[test]
    fn kraken2_is_a_brick_not_taxprofiler() {
        let r = reconstruct(&cat(), &fixture("kraken2_methods.txt"));
        let r = r.active().expect("Kraken2 workflow draft");
        assert_eq!(r.assay, Assay::Metagenome);
        let ops = ops(r);
        assert!(ops.contains(&"class.kraken2"), "{ops:?}");
        assert!(!ops.contains(&"nf.taxprofiler"));
        assert!(!ops.contains(&"nf.rnaseq"));
        assert_wired(r);
    }

    #[test]
    fn star_is_not_a_substring_of_start() {
        let r = reconstruct(
            &cat(),
            "The star-shaped experiment will start next week with FastQC.",
        );
        assert!(!r
            .mentions
            .iter()
            .any(|mention| mention.normalized_name == "star"));
        let r = r.active().expect("FastQC workflow draft");
        assert!(!ops(r).contains(&"align.star"));
        assert!(ops(r).contains(&"qc.fastqc"));
    }

    #[test]
    fn comparison_only_tools_remain_evidence_not_executable_stages() {
        let reconstruction = reconstruct(&cat(), &fixture("comparison_only_methods.txt"));
        assert!(reconstruction
            .mentions
            .iter()
            .any(|mention| mention.normalized_name == "star"));
        let candidate = reconstruction.active().expect("HISAT2 workflow draft");
        assert!(!ops(candidate).contains(&"align.star"));
        assert!(ops(candidate).contains(&"align.hisat2"));
    }

    #[test]
    fn evidence_snippets_do_not_slice_through_unicode() {
        let text = format!("{}′{}BUSCO was used.", "a".repeat(47), "b".repeat(46));
        let evidence = snippet(&text, "BUSCO").expect("BUSCO evidence");
        assert!(evidence.contains("BUSCO"), "{evidence:?}");
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
        let r = r.active().expect("variant workflow draft");
        assert_eq!(r.assay, Assay::Variants);
        assert!(ops(r).contains(&"align.bwa"));
        assert!(ops(r).contains(&"var.haplotypecaller"));
        assert!(!ops(r).contains(&"align.star"));
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
    fn single_cell_gap_methods_are_retained_without_a_fake_draft() {
        let text = "Single-cell RNA sequencing FASTQs were processed with Cell Ranger. SoupX correction was optional before Seurat analysis and DoubletFinder.";
        let reconstruction = reconstruct(&cat(), text);

        assert_eq!(
            reconstruction.outcome,
            ReconstructionOutcome::RecognizedUnsupported
        );
        assert!(reconstruction.candidates.is_empty());
        assert!(reconstruction.active().is_none());
        let mentions: Vec<_> = reconstruction
            .mentions
            .iter()
            .map(|mention| mention.display_name.as_str())
            .collect();
        for tool in ["Cell Ranger", "SoupX", "Seurat", "DoubletFinder"] {
            assert!(mentions.contains(&tool), "missing {tool}: {mentions:?}");
        }
    }

    #[test]
    fn downloaded_real_paper_corpus_reconstructs() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/papers");
        let cases: &[FullPaperCase<'_>] = &[
            (
                "pdf/love_f1000.pdf",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::RnaSeq),
                &["align.star", "quant.featurecounts", "diff.deseq2"],
                &["nf.rnaseq"],
                &[],
            ),
            (
                "raw/pertea_hisat.txt",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::RnaSeq),
                &["align.hisat2", "quant.stringtie"],
                &["align.bwa", "nf.rnaseq"],
                &["ballgown"],
            ),
            (
                "raw/gatk_best_practices.txt",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::Variants),
                &["align.bwa", "var.haplotypecaller"],
                &["nf.sarek", "align.hisat2"],
                &["picard"],
            ),
            (
                "pdf/cheng_hifiasm.pdf",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::Assembly),
                &["asm.hifiasm"],
                &["nf.rnaseq"],
                &[],
            ),
            (
                "pdf/rhie_vgp.pdf",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::Assembly),
                &["qc.busco"],
                &["nf.rnaseq"],
                &["falcon", "purgedups", "salsa"],
            ),
            (
                "pdf/wood_kraken2.pdf",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::Metagenome),
                &["class.kraken2"],
                &["align.minimap2", "nf.taxprofiler"],
                &[],
            ),
            (
                "raw/cwl_workflows_pmc.txt",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::Mixed),
                &[
                    "align.hisat2",
                    "align.bwa",
                    "quant.stringtie",
                    "var.haplotypecaller",
                ],
                &["nf.rnaseq", "nf.sarek"],
                &[],
            ),
            (
                "raw/sarek_pmc.txt",
                ReconstructionOutcome::DraftsReady,
                Some(Assay::Variants),
                &["nf.sarek"],
                &["align.bwa", "var.haplotypecaller"],
                &[],
            ),
            (
                "raw/minto_pmc.txt",
                ReconstructionOutcome::RecognizedUnsupported,
                None,
                &[],
                &["nf.mag", "nf.taxprofiler"],
                &["trimmomatic", "custom-script"],
            ),
            (
                "raw/scrnabox_pmc.txt",
                ReconstructionOutcome::RecognizedUnsupported,
                None,
                &[],
                &["nf.rnaseq"],
                &["cellranger", "soupx", "seurat", "doubletfinder"],
            ),
        ];
        let mut checked = 0;
        let mut missing = Vec::new();
        for (relative, outcome, assay, required, forbidden, required_unsupported) in cases {
            let path = root.join(relative);
            if !path.is_file() {
                missing.push(*relative);
                continue;
            }
            checked += 1;
            let extracted = extract_from_path(&path).unwrap();
            let r = reconstruct(&cat(), &extracted.text);
            assert_eq!(&r.outcome, outcome, "{}", path.display());
            let unsupported = r
                .mentions
                .iter()
                .filter(|mention| mention.support == MethodSupport::Unsupported)
                .map(|mention| mention.normalized_name.as_str())
                .collect::<Vec<_>>();
            for method in *required_unsupported {
                assert!(
                    unsupported.contains(method),
                    "{} missing unsupported {method}: {unsupported:?}",
                    path.display()
                );
            }
            let Some(assay) = assay else {
                assert!(
                    r.candidates.is_empty(),
                    "{} exported a fake draft",
                    path.display()
                );
                continue;
            };
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
            let candidate = r
                .active()
                .unwrap_or_else(|| panic!("{} produced no workflow draft", path.display()));
            assert_eq!(&candidate.assay, assay, "{}", path.display());
            let actual = ops(candidate);
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
            candidate.graph.validate().unwrap();
        }
        let corpus_required = std::env::var("SOMITE_PAPER_CORPUS").as_deref() == Ok("required");
        if corpus_required || root.join("pdf").is_dir() {
            assert!(
                missing.is_empty(),
                "full paper corpus is incomplete; missing:\n{}",
                missing.join("\n")
            );
            assert_eq!(checked, cases.len(), "full paper corpus count mismatch");
        }
    }

    #[test]
    fn pdfinfo_page_count_is_parsed_without_accepting_unrelated_numbers() {
        let output = "Title: example\nPages:          37\nFile size:      12345 bytes\n";
        assert_eq!(parse_pdf_page_count(output), Some(37));
        assert_eq!(parse_pdf_page_count("File size: 37 bytes\n"), None);
    }

    #[test]
    fn active_extraction_child_is_killed_when_cancelled() {
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let trigger = std::sync::Arc::clone(&cancelled);
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            trigger.store(true, std::sync::atomic::Ordering::Release);
        });
        let started = Instant::now();
        let mut command = Command::new("sleep");
        command.arg("30");
        let result = command_output(
            command,
            "sleep",
            ToolFamily::Pdf,
            Duration::from_secs(30),
            1024,
            &|| cancelled.load(std::sync::atomic::Ordering::Acquire),
        );
        setter.join().expect("cancellation trigger");
        assert!(matches!(result, Err(PaperError::Cancelled)));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancelled child lived for {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn active_extraction_child_is_killed_on_timeout() {
        let started = Instant::now();
        let mut command = Command::new("sleep");
        command.arg("30");
        let result = command_output(
            command,
            "sleep",
            ToolFamily::Pdf,
            Duration::from_millis(40),
            1024,
            &|| false,
        );
        assert!(matches!(result, Err(PaperError::Timeout { .. })));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timed-out child lived for {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn missing_native_text_tool_falls_back_to_ocr_preflight() {
        let directory = std::env::temp_dir().join(format!(
            "somite-paper-tool-test-{}-{}",
            std::process::id(),
            OCR_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("temporary paper directory");
        let workspace = OcrWorkspace(directory);
        let paper = workspace.0.join("scan.pdf");
        fs::write(&paper, b"%PDF-1.4\n%%EOF\n").expect("PDF fixture");
        let missing = workspace.0.join("not-installed");
        let result = extract_from_path_with_toolchain(
            &paper,
            ExtractionLimits {
                max_pages: 1,
                max_text_bytes: 1024,
                command_timeout: Duration::from_secs(1),
            },
            &ExtractionToolchain {
                pdftotext: missing.join("pdftotext"),
                pdfinfo: missing.join("pdfinfo"),
                pdftoppm: missing.join("pdftoppm"),
                tesseract: missing.join("tesseract"),
            },
            || false,
            |_| {},
        );
        assert!(matches!(
            result,
            Err(PaperError::MissingTool { ref tool, .. }) if tool == "pdfinfo"
        ));
    }

    #[test]
    fn text_extraction_enforces_the_configured_byte_limit() {
        let directory = std::env::temp_dir().join(format!(
            "somite-paper-limit-test-{}-{}",
            std::process::id(),
            OCR_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("temporary paper directory");
        let workspace = OcrWorkspace(directory);
        let paper = workspace.0.join("methods.txt");
        fs::write(&paper, "more than four bytes").expect("paper fixture");
        let result = extract_from_path_with_control(
            &paper,
            ExtractionLimits {
                max_pages: 1,
                max_text_bytes: 4,
                command_timeout: Duration::from_secs(1),
            },
            || false,
            |_| {},
        );
        assert!(matches!(result, Err(PaperError::Limit(_))));
        drop(workspace);
        assert!(!paper.exists());
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
        let r = r.active().expect("RNA-seq workflow draft");
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
        let reconstruction = reconstruction
            .active()
            .expect("workflow draft with evidence");

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
        let reconstruction = reconstruction
            .active()
            .expect("workflow draft with missing implementation");

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
        let dir = std::env::temp_dir().join("somite-ocr-fixture");
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
        let r = r.active().expect("OCR workflow draft");
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
