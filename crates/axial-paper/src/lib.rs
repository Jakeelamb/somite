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
    Qc,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct Reconstruction {
    pub graph: Graph,
    pub assay: Assay,
    pub warnings: Vec<String>,
}

const RNA_COMPOUND_COVERS: &[&str] = &[
    "STAR", "HISAT2", "Salmon", "Kallisto", "featureCounts", "RSEM", "StringTie",
];
const VAR_COMPOUND_COVERS: &[&str] = &["GATK", "BWA", "Mutect2", "HaplotypeCaller", "Strelka"];
const MAG_COMPOUND_COVERS: &[&str] = &["SPAdes", "Kraken2", "MetaBAT"];

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
    let low = text.to_ascii_lowercase();
    let assay = classify(&low);
    if assay == Assay::Assembly {
        return build_assembly(catalog, text, &low);
    }
    let acc = accessions(text);
    let genome = genome_token(&low);
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
        add(&mut g, "sra.fasterq_dump", vec![], Some("SRA → FASTQ".into()))
    } else {
        None
    };
    if prefetch.is_none() && (assay == Assay::Qc || mentioned(&low, &["fastq", "illumina", "reads were"])) {
        add(
            &mut g,
            "files.import",
            vec![],
            Some("no SRA accession — drop a FASTQ on this node".into()),
        );
    }

    if mentioned(&low, &["fastqc"]) || matches!(assay, Assay::RnaSeq | Assay::Variants | Assay::Metagenome | Assay::Qc)
    {
        let q = snippet(text, "fastqc").or_else(|| snippet(text, "quality control"));
        add(&mut g, "qc.fastqc", vec![], q);
    }
    if mentioned(&low, &["fastp", "cutadapt", "trimmomatic", "trim galore", "trimgalore"]) {
        let q = snippet(text, "fastp")
            .or_else(|| snippet(text, "cutadapt"))
            .or_else(|| snippet(text, "trimmomatic"))
            .or_else(|| snippet(text, "trim"));
        add(&mut g, "qc.fastp", vec![], q);
    }

    let compound = match assay {
        Assay::RnaSeq => {
            let covers: Vec<&str> = RNA_COMPOUND_COVERS
                .iter()
                .copied()
                .filter(|t| low.contains(&t.to_ascii_lowercase()))
                .collect();
            let mut note = "nf-core/rnaseq is the compound for this methods section".to_string();
            if !covers.is_empty() {
                note.push_str(&format!(". paper used {} — pipeline wraps it", covers.join(", ")));
            }
            if let Some(gname) = genome {
                note.push_str(&format!(". reference {gname}"));
            }
            add(&mut g, "nf.rnaseq", vec![], Some(note));
            Some("nf.rnaseq")
        }
        Assay::Variants => {
            let covers: Vec<&str> = VAR_COMPOUND_COVERS
                .iter()
                .copied()
                .filter(|t| low.contains(&t.to_ascii_lowercase()))
                .collect();
            let mut note = "nf-core/sarek for the variant methods".to_string();
            if !covers.is_empty() {
                note.push_str(&format!(". paper used {}", covers.join(", ")));
            }
            add(&mut g, "nf.sarek", vec![], Some(note));
            Some("nf.sarek")
        }
        Assay::Metagenome => {
            let op = if mentioned(&low, &["kraken", "taxonom", "profil"]) {
                "nf.taxprofiler"
            } else {
                "nf.mag"
            };
            add(
                &mut g,
                op,
                vec![],
                Some("compound for the metagenomic methods".into()),
            );
            Some(op)
        }
        Assay::Qc | Assay::Unknown | Assay::Assembly => None,
    };

    let covered: &[&str] = match compound {
        Some("nf.rnaseq") => RNA_COMPOUND_COVERS,
        Some("nf.sarek") => VAR_COMPOUND_COVERS,
        Some("nf.mag") | Some("nf.taxprofiler") => MAG_COMPOUND_COVERS,
        _ => &[],
    };
    for (needle, tool) in [
        (" star", "STAR"),
        ("hisat", "HISAT2"),
        ("salmon", "Salmon"),
        ("kallisto", "Kallisto"),
        ("bwa ", "BWA"),
        ("gatk", "GATK"),
        ("mutect", "Mutect2"),
        ("spades", "SPAdes"),
        ("kraken", "Kraken2"),
        ("deseq", "DESeq2"),
        ("multiqc", "MultiQC"),
        ("cellranger", "Cell Ranger"),
        ("seurat", "Seurat"),
    ] {
        if !low.contains(needle.trim()) && !low.contains(&tool.to_ascii_lowercase()) {
            continue;
        }
        if covered.iter().any(|c| c.eq_ignore_ascii_case(tool)) {
            continue;
        }
        let q = snippet(text, tool).or_else(|| snippet(text, needle.trim()));
        add(
            &mut g,
            "gap.missing",
            vec![
                ("tool", ParamValue::String(tool.into())),
                (
                    "quote",
                    ParamValue::String(q.clone().unwrap_or_default()),
                ),
            ],
            q.or_else(|| Some(format!("paper used {tool}; not a brick yet — wrap it"))),
        );
    }

    if g.nodes.is_empty() {
        warnings.push("no tools or assay I could map. drop a methods section, not a cover page.".into());
    }

    let sheet = if compound == Some("nf.rnaseq") {
        add(
            &mut g,
            "sheet.rnaseq",
            vec![],
            Some("nf-core samplesheet from the reads".into()),
        )
    } else {
        None
    };

    if let (Some(a), Some(b)) = (&prefetch, &fasterq) {
        wire(&mut g, a, b);
    }
    let reads = fasterq
        .clone()
        .or_else(|| g.nodes.iter().find(|n| n.operator == "files.import").map(|n| n.id.clone()));
    if let Some(src) = &reads {
        for n in g.nodes.clone() {
            if n.operator == "qc.fastqc" || n.operator == "qc.fastp" {
                wire(&mut g, src, &n.id);
            }
        }
    }
    let trim = g
        .nodes
        .iter()
        .find(|n| n.operator == "qc.fastp")
        .map(|n| n.id.clone());
    let sheet_src = trim.or(reads);
    if let (Some(src), Some(sh)) = (&sheet_src, &sheet) {
        wire(&mut g, src, sh);
    }
    if let Some(sh) = &sheet {
        if let Some(nf) = g
            .nodes
            .iter()
            .find(|n| n.operator == "nf.rnaseq")
            .map(|n| n.id.clone())
        {
            wire(&mut g, sh, &nf);
        }
    }

    layout(&mut g);
    if let Err(e) = g.validate() {
        warnings.push(format!("graph did not validate: {e}"));
    }
    Reconstruction {
        graph: g,
        assay,
        warnings,
    }
}

fn classify(low: &str) -> Assay {
    if contains_any(
        low,
        &[
            "hifiasm",
            "yahs",
            "genomescope",
            "mitohifi",
            "blobtools",
            "chromosome-scale assembl",
            "chromosome scale assembl",
            "haplotype assembl",
            "pacbio hifi",
            "hifi and hi-c",
            "hi-c sequencing",
        ],
    ) {
        Assay::Assembly
    } else if contains_any(
        low,
        &[
            "rna-seq",
            "rna seq",
            "rnaseq",
            "nf-core/rnaseq",
            "pseudoalign",
            "differential expression",
        ],
    ) {
        Assay::RnaSeq
    } else if contains_any(
        low,
        &[
            "sarek",
            "somatic",
            "germline",
            "variant call",
            "mutect",
            "haplotypecaller",
            "whole genome sequenc",
            "wgs ",
            "wes ",
        ],
    ) {
        Assay::Variants
    } else if contains_any(low, &["metagenom", "taxonom", "kraken", "metabat", "mag "]) {
        Assay::Metagenome
    } else if low.contains("fastqc") {
        Assay::Qc
    } else {
        Assay::Unknown
    }
}

fn build_assembly(catalog: &Catalog, text: &str, low: &str) -> Reconstruction {
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
        gap(&mut g, "Genomescope", snippet(text, "Genomescope"), gap_from_reads())
    } else {
        None
    };
    let mut lineage = "arthropoda_odb10".to_string();
    for lin in ["arthropoda_odb10", "eukaryota_odb10", "bacteria_odb10", "fungi_odb10"] {
        if low.contains(lin) {
            lineage = lin.into();
            break;
        }
    }
    let asm = add(
        &mut g,
        "asm.hifiasm",
        vec![],
        snippet(text, "hifiasm").or_else(|| Some("hifiasm (HiFi ± Hi-C phasing)".into())),
    );
    let yahs = if mentioned(low, &["yahs"]) {
        gap(&mut g, "YaHS", snippet(text, "YaHS"), gap_from_asm())
    } else {
        None
    };
    let blob = if mentioned(low, &["blobtools", "blobtoolkit"]) {
        gap(&mut g, "Blobtools", snippet(text, "Blobtools"), gap_from_asm())
    } else {
        None
    };
    let busco = if mentioned(low, &["busco"]) {
        let mut n = snippet(text, "BUSCO").unwrap_or_else(|| "BUSCO completeness".into());
        n.push_str(&format!("  lineage {lineage}"));
        gap(&mut g, "BUSCO", Some(n), gap_from_asm())
    } else {
        None
    };
    let mito = if mentioned(low, &["mitohifi"]) {
        gap(&mut g, "MitoHiFi", snippet(text, "MitoHiFi"), gap_from_reads())
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
        gap(&mut g, "minimap2", snippet(text, "minimap2"), gap_minimap())
    } else {
        None
    };
    let aug = if mentioned(low, &["augustus"]) {
        gap(&mut g, "Augustus", snippet(text, "Augustus"), gap_from_asm())
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
    for nxt in [&yahs, &blob] {
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
    place(&mut g, yahs.as_deref(), 2, 1);
    place(&mut g, blob.as_deref(), 3, 1);
    place(&mut g, busco.as_deref(), 4, 1);
    place(&mut g, gs.as_deref(), 0, 2);
    place(&mut g, mito.as_deref(), 1, 2);
    place(&mut g, bakta.as_deref(), 3, 2);
    place(&mut g, iso.as_deref(), 0, 3);
    place(&mut g, mm.as_deref(), 1, 3);
    place(&mut g, aug.as_deref(), 2, 3);
    if let Err(e) = g.validate() {
        warnings.push(format!("graph did not validate: {e}"));
    }
    Reconstruction {
        graph: g,
        assay: Assay::Assembly,
        warnings,
    }
}

fn contains_any(s: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| s.contains(n))
}

fn mentioned(low: &str, needles: &[&str]) -> bool {
    contains_any(low, needles)
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
        "qc.busco" => "busco".into(),
        "files.import" => "import".into(),
        "sheet.rnaseq" => "sheet".into(),
        "ensembl.fasta" => "fasta".into(),
        "ensembl.gtf" => "gtf".into(),
        _ => op.rsplit('.').next().unwrap_or(op).to_string(),
    }
}

fn next_name(existing: &[String], op: &str, params: &[(&str, ParamValue)]) -> String {
    let leaf = short_leaf(op, params);
    if op == "gap.missing" && !existing.iter().any(|id| id == &leaf) {
        return leaf;
    }
    let mut i = 1u32;
    loop {
        let cand = format!("{leaf}{i}");
        if !existing.iter().any(|id| id == &cand) {
            return cand;
        }
        i += 1;
    }
}

fn wire(g: &mut Graph, from: &str, to: &str) {
    let Some(a) = g.node(from).cloned() else { return };
    let Some(b) = g.node(to).cloned() else { return };
    for ap in a.ports.iter().filter(|p| p.dir == Direction::Out) {
        for bp in b.ports.iter().filter(|p| p.dir == Direction::In) {
            if !compatible(ap.ty, bp.ty, &bp.union) {
                continue;
            }
            if g.edges.iter().any(|e| e.to_node == to && e.to_port == bp.name) {
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
            vec![PortType::Fastq, PortType::FastqGz, PortType::Fasta, PortType::FastaGz],
        ),
        p_out("out", PortType::Directory),
    ]
}

fn gap_from_asm() -> Vec<Port> {
    vec![
        p_in(
            "in",
            PortType::Directory,
            vec![PortType::Directory, PortType::Fasta, PortType::FastaGz],
        ),
        p_out("out", PortType::Directory),
    ]
}

fn gap_minimap() -> Vec<Port> {
    vec![
        p_in(
            "reads",
            PortType::Fasta,
            vec![PortType::Fasta, PortType::FastaGz, PortType::Fastq, PortType::FastqGz],
        ),
        p_in(
            "ref",
            PortType::Directory,
            vec![PortType::Directory, PortType::Fasta, PortType::FastaGz],
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
    let mut cols: std::collections::BTreeMap<usize, Vec<String>> = std::collections::BTreeMap::new();
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

    #[test]
    fn rnaseq_paper_builds_a_valid_graph() {
        let r = reconstruct(&cat(), RNA);
        assert_eq!(r.assay, Assay::RnaSeq);
        r.graph.validate().unwrap();
        let ops: Vec<_> = r.graph.nodes.iter().map(|n| n.operator.as_str()).collect();
        assert!(ops.contains(&"sra.prefetch"));
        assert!(ops.contains(&"sra.fasterq_dump"));
        assert!(ops.contains(&"qc.fastqc"));
        assert!(ops.contains(&"qc.fastp"));
        assert!(ops.contains(&"nf.rnaseq"));
        assert!(ops.contains(&"sheet.rnaseq"));
        assert!(ops.contains(&"gap.missing")); // DESeq2
        assert!(
            r.graph.edges.iter().any(|e| {
                r.graph.node(&e.to_node).map(|n| n.operator.as_str()) == Some("nf.rnaseq")
                    && e.to_port == "sheet"
            }),
            "sheet should snap to nf-core/rnaseq"
        );
        let pref = r.graph.nodes.iter().find(|n| n.operator == "sra.prefetch").unwrap();
        match pref.params.get("accession") {
            Some(ParamValue::String(s)) => assert_eq!(s, "SRR12345678"),
            _ => panic!("accession"),
        }
        let nf = r.graph.nodes.iter().find(|n| n.operator == "nf.rnaseq").unwrap();
        let note = nf.note.as_deref().unwrap_or("");
        assert!(note.contains("STAR"), "{note}");
        assert!(note.contains("GRCh38"), "{note}");
        assert!(r.graph.edges.iter().any(|e| e.from_port.len() > 0));
    }

    #[test]
    fn star_is_not_a_duplicate_brick_when_rnaseq_is_present() {
        let r = reconstruct(&cat(), RNA);
        let gaps: Vec<_> = r
            .graph
            .nodes
            .iter()
            .filter(|n| n.operator == "gap.missing")
            .filter_map(|n| n.params.get("tool"))
            .collect();
        let has_star = gaps.iter().any(|v| matches!(v, ParamValue::String(s) if s == "STAR"));
        assert!(!has_star, "STAR is inside nf-core/rnaseq, should be a note not a gap");
        let has_deseq = gaps.iter().any(|v| matches!(v, ParamValue::String(s) if s == "DESeq2"));
        assert!(has_deseq);
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
    fn variants_go_to_sarek() {
        let r = reconstruct(&cat(), VAR);
        assert_eq!(r.assay, Assay::Variants);
        r.graph.validate().unwrap();
        assert!(r.graph.nodes.iter().any(|n| n.operator == "nf.sarek"));
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
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/papers/aphis_assembly_methods.txt"),
        )
        .unwrap();
        let r = reconstruct(&cat(), &raw);
        assert_eq!(r.assay, Assay::Assembly);
        r.graph.validate().unwrap();
        let ops: Vec<_> = r.graph.nodes.iter().map(|n| n.operator.as_str()).collect();
        assert!(ops.contains(&"asm.hifiasm"), "{ops:?}");
        assert!(!ops.contains(&"nf.rnaseq"), "must not misread Iso-seq as bulk RNA-seq");
        let tools: Vec<_> = r
            .graph
            .nodes
            .iter()
            .filter(|n| n.operator == "gap.missing")
            .filter_map(|n| n.params.get("tool"))
            .collect();
        assert!(
            tools.iter().any(|v| matches!(v, ParamValue::String(s) if s == "YaHS")),
            "{tools:?}"
        );
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
                .find(|n| n.operator == op || n.params.get("tool") == Some(&ParamValue::String(op.into())))
                .map(|n| n.layout.x)
                .unwrap()
        };
        let y = |op: &str| {
            r.graph
                .nodes
                .iter()
                .find(|n| n.operator == op || n.params.get("tool") == Some(&ParamValue::String(op.into())))
                .map(|n| n.layout.y)
                .unwrap()
        };
        assert!(x("asm.hifiasm") > x("files.import"));
        assert!(x("YaHS") > x("asm.hifiasm"));
        assert!(y("Iso-Seq") > y("files.import"), "annotation lane sits below assembly");
    }

    #[test]
    fn thin_pdf_text_layer_is_rejected() {
        assert!(!text_layer_ok(""));
        assert!(!text_layer_ok("   (cid:1) (cid:2)  "));
        assert!(text_layer_ok(&"methods ".repeat(80)));
    }

    #[test]
    fn extract_plain_methods_file() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/papers/rnaseq_methods.txt");
        let e = extract_from_path(&p).unwrap();
        assert_eq!(e.via, ExtractVia::Utf8);
        assert!(e.text.to_ascii_lowercase().contains("fastqc"));
    }

    #[test]
    fn paper_ids_are_short() {
        let r = reconstruct(&cat(), RNA);
        let ids: Vec<_> = r.graph.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"prefetch1"), "{ids:?}");
        assert!(ids.contains(&"fasterq1"), "{ids:?}");
        assert!(ids.contains(&"fastqc1"), "{ids:?}");
        assert!(ids.contains(&"sheet1"), "{ids:?}");
        assert!(ids.contains(&"deseq2"), "{ids:?}");
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
        assert_eq!(e.via, ExtractVia::Tesseract, "expected scan path, got {:?}", e.via);
        let low = e.text.to_ascii_lowercase();
        assert!(
            low.contains("rna") && (low.contains("srr") || low.contains("deseq")),
            "tesseract missed the methods line: {:?}",
            e.text
        );
        let r = reconstruct(&cat(), &e.text);
        assert_eq!(r.assay, Assay::RnaSeq);
        assert!(r.graph.nodes.iter().any(|n| n.operator == "qc.fastqc"));
    }
}
