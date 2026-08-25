//! TouchDesigner-shaped Axial: palette | network | parameter pages.
//!
//! Nodes are viewers. Names sit under the body. Ports snap. Tab / double-click
//! opens OP Create. Palette drags onto the grid.

mod canvas;
mod library_state;
mod nfcore_catalog;
mod overlay;
mod palette;
mod sources;
mod system_profile;
mod theme;

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use axial_cook::{cook_graph, ArtifactMeta, CookReport, NodeState, Project};
use axial_ir::{
    compatible, Direction, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION,
};
use axial_ops::{Catalog, Cost, Operator};
use axial_paper::{
    extract_from_path, reconstruct, text_from_path, CandidateGraph, CandidateRole, EvidenceStatus,
    EvidenceTarget, ExtractVia, Reconstruction,
};
use canvas::{
    advance_drag_delta, connect, paired_companion, rename_node, snap_drag, snap_point_to_grid,
    zoom_about, Connection, EditHistory, Selection, SelectionMode, SnapGuides, SnapSource,
    WireStart,
};
use eframe::egui::{
    self, Color32, CornerRadius, CursorIcon, FontData, FontDefinitions, FontFamily, FontId, Frame,
    Id, Margin, Pos2, Rect, Sense, Stroke, Vec2,
};
use library_state::LibraryState;
use nfcore_catalog::Pipeline as NfcorePipeline;
use overlay::{OverlayState, Surface};
use palette::Mode as PaletteMode;
use sources::AccessionKind;
use system_profile::SystemProfile;
use theme::GRAPHITE;

const BG: Color32 = GRAPHITE.canvas;
const GRID: Color32 = GRAPHITE.grid;
const GRID_MAJ: Color32 = GRAPHITE.grid_strong;
const PANEL: Color32 = GRAPHITE.surface;
const PANEL2: Color32 = GRAPHITE.surface_raised;
const NODE: Color32 = GRAPHITE.node;
const SELECT: Color32 = GRAPHITE.accent;
const TEXT: Color32 = GRAPHITE.text;
const MUTED: Color32 = GRAPHITE.text_muted;
const ACCENT: Color32 = GRAPHITE.accent;

const NODE_W: f32 = 176.0;
const NODE_H: f32 = 112.0;
const NODE_H_FLAT: f32 = 58.0;
const NAME_GAP: f32 = 5.0;

#[derive(Clone, Copy)]
struct Marquee {
    start: Pos2,
    current: Pos2,
    mode: SelectionMode,
}

#[derive(Clone)]
struct NodeDrag {
    anchor: String,
    start: BTreeMap<String, Pos2>,
    accumulated: Vec2,
}

#[derive(Clone)]
struct PaperReview {
    name: String,
    candidates: Vec<CandidateGraph>,
    active: usize,
}

impl Marquee {
    fn rect(self) -> Rect {
        Rect::from_two_pos(self.start, self.current)
    }
}

fn paired_fastq_key(path: &Path) -> Option<(String, u8)> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if !(name.ends_with(".fastq")
        || name.ends_with(".fq")
        || name.ends_with(".fastq.gz")
        || name.ends_with(".fq.gz"))
    {
        return None;
    }
    for (marker, mate) in [
        ("_r1_", 1),
        ("_r2_", 2),
        ("_r1.", 1),
        ("_r2.", 2),
        (".r1.", 1),
        (".r2.", 2),
        ("_1.", 1),
        ("_2.", 2),
    ] {
        if let Some(index) = name.find(marker) {
            let key = format!("{}__{}", &name[..index], &name[index + marker.len()..]);
            return Some((key, mate));
        }
    }
    None
}

fn pair_dropped_fastqs(paths: Vec<PathBuf>) -> Vec<(PathBuf, PathBuf)> {
    let mut candidates: BTreeMap<(PathBuf, String), [Option<PathBuf>; 2]> = BTreeMap::new();
    for path in paths {
        let Some((key, mate)) = paired_fastq_key(&path) else {
            continue;
        };
        let directory = path.parent().unwrap_or(Path::new("")).to_path_buf();
        candidates.entry((directory, key)).or_default()[usize::from(mate - 1)] = Some(path);
    }
    candidates
        .into_values()
        .filter_map(|[r1, r2]| r1.zip(r2))
        .collect()
}

fn selection_mode(modifiers: egui::Modifiers) -> SelectionMode {
    if modifiers.command {
        SelectionMode::Toggle
    } else if modifiers.shift {
        SelectionMode::Add
    } else {
        SelectionMode::Replace
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ViewerAction {
    Show,
    Hide,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PathPicker {
    File,
    Directory,
}

fn path_picker_for(operator: &str, param: &str) -> Option<PathPicker> {
    match (operator, param) {
        ("files.import", "path")
        | ("files.import_paired", "r1")
        | ("files.import_paired", "r2") => Some(PathPicker::File),
        ("files.import_directory", "path") => Some(PathPicker::Directory),
        _ => None,
    }
}

fn viewer_action<'a>(
    viewer_off: &BTreeSet<String>,
    nodes: impl IntoIterator<Item = &'a str>,
) -> Option<ViewerAction> {
    let nodes = nodes.into_iter().collect::<Vec<_>>();
    if nodes.is_empty() {
        None
    } else if nodes.iter().all(|node| viewer_off.contains(*node)) {
        Some(ViewerAction::Show)
    } else {
        Some(ViewerAction::Hide)
    }
}

fn apply_viewer_action<'a>(
    viewer_off: &mut BTreeSet<String>,
    nodes: impl IntoIterator<Item = &'a str>,
    action: ViewerAction,
) {
    for node in nodes {
        match action {
            ViewerAction::Show => {
                viewer_off.remove(node);
            }
            ViewerAction::Hide => {
                viewer_off.insert(node.to_owned());
            }
        }
    }
}

fn font_px(base: f32, z: f32, min: f32, max: f32) -> FontId {
    FontId::proportional((base * z).clamp(min, max))
}

fn fit_label(painter: &egui::Painter, text: &str, font: FontId, max_w: f32) -> String {
    if max_w <= 8.0 || text.is_empty() {
        return String::new();
    }
    let g = painter.layout_no_wrap(text.to_owned(), font.clone(), TEXT);
    if g.size().x <= max_w {
        return text.to_owned();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while !chars.is_empty() {
        chars.pop();
        let t: String = chars.iter().chain(['…'].iter()).collect();
        if painter
            .layout_no_wrap(t.clone(), font.clone(), TEXT)
            .size()
            .x
            <= max_w
        {
            return t;
        }
    }
    String::new()
}

fn draw_label(
    painter: &egui::Painter,
    pos: Pos2,
    anchor: egui::Align2,
    text: &str,
    font: FontId,
    color: Color32,
    clip: Rect,
) {
    let max_w = (clip.width() - 6.0).max(0.0);
    let mut font = font;
    let min = 7.0;
    while font.size > min {
        let g = painter.layout_no_wrap(text.to_owned(), font.clone(), color);
        if g.size().x <= max_w {
            break;
        }
        font.size = (font.size - 0.4).max(min);
    }
    let s = fit_label(painter, text, font.clone(), max_w);
    if s.is_empty() {
        return;
    }
    painter
        .with_clip_rect(clip)
        .text(pos, anchor, s, font, color);
}

fn short_op(op: &str) -> &str {
    op.rsplit('.').next().unwrap_or(op)
}

fn operators_dir() -> PathBuf {
    if let Ok(p) = env::var("AXIAL_OPERATORS") {
        return PathBuf::from(p);
    }
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let a = cwd.join("operators");
    if a.is_dir() {
        return a;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators")
}

fn project_root() -> PathBuf {
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn family_color(op_id: &str) -> Color32 {
    if op_id.starts_with("sra.") || op_id.starts_with("ncbi.") {
        Color32::from_rgb(56, 168, 196)
    } else if op_id.starts_with("ensembl.") {
        Color32::from_rgb(72, 176, 138)
    } else if op_id.starts_with("asm.") || op_id.starts_with("align.") {
        Color32::from_rgb(90, 140, 210)
    } else if op_id.starts_with("quant.") || op_id.starts_with("diff.") {
        Color32::from_rgb(196, 176, 72)
    } else if op_id.starts_with("class.") || op_id.starts_with("var.") || op_id.starts_with("nf.") {
        Color32::from_rgb(214, 132, 62)
    } else if op_id.starts_with("qc.") {
        Color32::from_rgb(78, 186, 110)
    } else if op_id.starts_with("files.") {
        Color32::from_rgb(128, 128, 148)
    } else if op_id.starts_with("sheet.") {
        Color32::from_rgb(196, 176, 72)
    } else if op_id.starts_with("gap.") {
        Color32::from_rgb(196, 90, 80)
    } else {
        Color32::from_rgb(140, 140, 150)
    }
}

fn is_workflow_operator(op_id: &str) -> bool {
    op_id.starts_with("nfcore.")
        || op_id.contains("nextflow")
        || op_id.contains("snakemake")
        || op_id.contains("workflow")
}

fn port_color(ty: PortType) -> Color32 {
    match ty {
        PortType::Fastq | PortType::FastqGz => Color32::from_rgb(80, 196, 230),
        PortType::Fasta | PortType::FastaGz => Color32::from_rgb(90, 200, 140),
        PortType::Bam | PortType::Bai => Color32::from_rgb(230, 150, 70),
        PortType::Vcf | PortType::VcfGz => Color32::from_rgb(210, 110, 200),
        PortType::Gtf | PortType::GtfGz => Color32::from_rgb(120, 180, 90),
        PortType::Html | PortType::Preview | PortType::Image => Color32::from_rgb(230, 210, 120),
        PortType::Sra => Color32::from_rgb(70, 190, 200),
        PortType::Zip | PortType::Directory => Color32::from_rgb(230, 180, 80),
        PortType::Table | PortType::Json | PortType::Text => Color32::from_rgb(180, 180, 200),
    }
}

fn type_name(ty: PortType) -> &'static str {
    match ty {
        PortType::Sra => "SRA",
        PortType::Fastq => "FASTQ",
        PortType::FastqGz => "FASTQ.GZ",
        PortType::Fasta => "FASTA",
        PortType::FastaGz => "FASTA.GZ",
        PortType::Gtf => "GTF",
        PortType::GtfGz => "GTF.GZ",
        PortType::Bam => "BAM",
        PortType::Bai => "BAI",
        PortType::Vcf => "VCF",
        PortType::VcfGz => "VCF.GZ",
        PortType::Table => "TABLE",
        PortType::Json => "JSON",
        PortType::Html => "HTML",
        PortType::Image => "IMAGE",
        PortType::Zip => "ZIP",
        PortType::Directory => "DIR",
        PortType::Text => "TEXT",
        PortType::Preview => "PREVIEW",
    }
}

fn base_color(b: u8) -> Color32 {
    match b {
        b'A' | b'a' => Color32::from_rgb(70, 190, 110),
        b'C' | b'c' => Color32::from_rgb(70, 150, 220),
        b'G' | b'g' => Color32::from_rgb(220, 180, 60),
        b'T' | b't' | b'U' | b'u' => Color32::from_rgb(220, 80, 80),
        _ => Color32::from_rgb(90, 90, 96),
    }
}

fn next_op_name(existing: &[String], op: &str) -> String {
    let leaf = op.rsplit('.').next().unwrap_or(op);
    let mut i = 1u32;
    loop {
        let cand = format!("{leaf}{i}");
        if !existing.iter().any(|id| id == &cand) {
            return cand;
        }
        i += 1;
    }
}

#[derive(Clone, Debug, PartialEq)]
struct FqPreview {
    n_reads: usize,
    len: usize,
    seq: Vec<u8>,
    qual: Vec<u8>,
}

fn parse_fastq(s: &str) -> Option<FqPreview> {
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() < 4 {
        return None;
    }
    let mut n = 0usize;
    let mut seq = Vec::new();
    let mut qual = Vec::new();
    let mut i = 0;
    while i + 3 < lines.len() {
        n += 1;
        if n == 1 {
            seq = lines[i + 1].as_bytes().to_vec();
            qual = lines[i + 3].as_bytes().to_vec();
        }
        i += 4;
    }
    if n == 0 {
        return None;
    }
    Some(FqPreview {
        n_reads: n,
        len: seq.len(),
        seq,
        qual,
    })
}

fn install_fonts(ctx: &egui::Context) {
    let path = "/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf";
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let mut fonts = FontDefinitions::default();
    fonts
        .font_data
        .insert("adwaita".to_owned(), Arc::new(FontData::from_owned(bytes)));
    fonts
        .families
        .entry(FontFamily::Proportional)
        .or_default()
        .insert(0, "adwaita".to_owned());
    ctx.set_fonts(fonts);
}

struct App {
    catalog: Catalog,
    graph: Graph,
    selection: Selection,
    pan: Vec2,
    zoom: f32,
    status: String,
    last_states: BTreeMap<String, NodeState>,
    search: String,
    param_page: String,
    wire: Option<WireStart>,
    pending_insert: Option<WireStart>,
    cursor: Pos2,
    last_graph_pos: Pos2,
    overlays: OverlayState,
    op_create_screen: Pos2,
    op_create_q: String,
    op_create_i: usize,
    focus_op_create: bool,
    viewer_off: BTreeSet<String>,
    sizes: BTreeMap<String, Vec2>,
    fq: BTreeMap<String, FqPreview>,
    dragging: Option<NodeDrag>,
    snap_guides: SnapGuides,
    resizing: Option<String>,
    marquee: Option<Marquee>,
    info: Option<String>,
    cook_rx: Option<Receiver<Result<CookReport, String>>>,
    cook_started: Option<Instant>,
    hover_port: Option<(String, String, PortType, bool)>,
    last_arts: BTreeMap<String, BTreeMap<String, ArtifactMeta>>,
    paper_rx: Option<Receiver<Result<Reconstruction, String>>>,
    paper_name: String,
    paper_review: Option<PaperReview>,
    auto_fit: bool,
    history: EditHistory,
    rename_target: Option<String>,
    rename_buffer: String,
    graph_path: Option<PathBuf>,
    autosave_due: Option<Instant>,
    nfcore: BTreeMap<String, NfcorePipeline>,
    nfcore_rx: Option<Receiver<nfcore_catalog::FetchResult>>,
    accession: String,
    source_tools: sources::ToolReadiness,
    system_profile: Option<SystemProfile>,
    system_profile_rx: Option<Receiver<SystemProfile>>,
    library: LibraryState,
    focus_accession: bool,
    focus_library_search: bool,
}

impl App {
    fn new() -> Self {
        let catalog = Catalog::load_dir(&operators_dir()).unwrap_or_default();
        let default_graph = Graph {
            schema_version: SCHEMA_VERSION,
            nodes: vec![],
            edges: vec![],
        };
        let recovery_path = project_root().join(".axial/autosave.axial.json");
        let recovered = fs::read_to_string(&recovery_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Graph>(&text).ok())
            .filter(|graph| graph.validate().is_ok());
        let did_recover = recovered.is_some();
        let graph = recovered.unwrap_or(default_graph);
        let mut selection = Selection::default();
        if let Some(node) = graph.nodes.first() {
            selection.select_node(&node.id, SelectionMode::Replace);
        }
        let mut app = Self {
            catalog,
            graph,
            selection,
            pan: Vec2::new(20.0, 28.0),
            zoom: 1.0,
            status: if did_recover {
                "recovered the last autosave".into()
            } else {
                "Tab add  ·  drag ports to wire  ·  space-drag pan  ·  F fit".into()
            },
            last_states: BTreeMap::new(),
            search: String::new(),
            param_page: String::new(),
            wire: None,
            pending_insert: None,
            cursor: Pos2::ZERO,
            last_graph_pos: Pos2::new(160.0, 180.0),
            overlays: OverlayState::default(),
            op_create_screen: Pos2::new(420.0, 260.0),
            op_create_q: String::new(),
            op_create_i: 0,
            focus_op_create: false,
            viewer_off: BTreeSet::new(),
            sizes: BTreeMap::new(),
            fq: BTreeMap::new(),
            dragging: None,
            snap_guides: SnapGuides::default(),
            resizing: None,
            marquee: None,
            info: None,
            cook_rx: None,
            cook_started: None,
            hover_port: None,
            last_arts: BTreeMap::new(),
            paper_rx: None,
            paper_name: String::new(),
            paper_review: None,
            auto_fit: false,
            history: EditHistory::default(),
            rename_target: None,
            rename_buffer: String::new(),
            graph_path: None,
            autosave_due: None,
            nfcore: BTreeMap::new(),
            nfcore_rx: None,
            accession: String::new(),
            source_tools: sources::ToolReadiness::detect(),
            system_profile: None,
            system_profile_rx: Some(system_profile::detect_async()),
            library: LibraryState::load(project_root().join(".axial/library-state.json")),
            focus_accession: false,
            focus_library_search: false,
        };
        app.load_nfcore_cache();
        app.refresh_nfcore_catalog();
        if let Ok(p) = env::var("AXIAL_OPEN") {
            if let Ok(text) = text_from_path(Path::new(&p)) {
                let r = reconstruct(&app.catalog, &text);
                let name = Path::new(&p)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("paper")
                    .to_string();
                app.install_paper_reconstruction(name, r);
            } else {
                app.open_paper(PathBuf::from(p));
            }
        }
        app
    }

    fn open_paper(&mut self, path: PathBuf) {
        self.ingest_path(path, self.last_graph_pos);
    }

    fn install_paper_reconstruction(&mut self, name: String, reconstruction: Reconstruction) {
        let active = reconstruction.active_index();
        let candidates = reconstruction.candidates;
        let Some(candidate) = candidates.get(active) else {
            self.status = format!("{name} did not produce a Candidate Graph");
            return;
        };
        let graph = candidate.graph.clone();
        let assay = candidate.assay;
        let warnings = candidate.warnings.clone();
        let candidate_count = candidates.len();
        let node_count = graph.nodes.len();
        self.paper_name = name.clone();
        self.paper_review = Some(PaperReview {
            name,
            candidates,
            active,
        });
        self.activate_paper_graph(graph);
        self.open_surface(Surface::PaperReview);
        let mut status = format!(
            "rebuilt {node_count} nodes from {} ({assay:?})",
            self.paper_name
        );
        if candidate_count > 1 {
            status.push_str(&format!(" · {candidate_count} Candidate Graphs"));
        }
        if !warnings.is_empty() {
            status.push_str(" · ");
            status.push_str(&warnings.join(" · "));
        }
        self.status = status;
    }

    fn activate_paper_graph(&mut self, graph: Graph) {
        self.graph = graph;
        self.graph_path = None;
        self.autosave_due = Some(Instant::now());
        self.history = EditHistory::default();
        self.selection.clear();
        if let Some(node) = self.graph.nodes.first() {
            self.selection.select_node(&node.id, SelectionMode::Replace);
        }
        self.param_page.clear();
        self.last_states.clear();
        self.last_arts.clear();
        self.viewer_off.clear();
        self.sizes.clear();
        self.pan = Vec2::new(20.0, 28.0);
        self.zoom = 1.0;
        self.request_fit();
    }

    fn switch_paper_candidate(&mut self, index: usize) {
        let Some(review) = &mut self.paper_review else {
            return;
        };
        if index == review.active || index >= review.candidates.len() {
            return;
        }
        if let Some(current) = review.candidates.get_mut(review.active) {
            current.graph = self.graph.clone();
        }
        let Some(candidate) = review.candidates.get(index) else {
            return;
        };
        let graph = candidate.graph.clone();
        let name = candidate.name.clone();
        review.active = index;
        self.activate_paper_graph(graph);
        self.status = format!("showing Candidate Graph: {name}");
    }

    fn node_size(&self, n: &Node) -> Vec2 {
        if self.viewer_off.contains(&n.id) {
            Vec2::new(
                self.sizes.get(&n.id).map(|s| s.x).unwrap_or(NODE_W),
                NODE_H_FLAT,
            )
        } else {
            self.sizes
                .get(&n.id)
                .copied()
                .unwrap_or(Vec2::new(NODE_W, NODE_H))
        }
    }

    fn to_screen(&self, origin: Pos2, p: Pos2) -> Pos2 {
        origin + Vec2::new(p.x, p.y) * self.zoom + self.pan
    }

    fn to_graph(&self, origin: Pos2, p: Pos2) -> Pos2 {
        let v = (p - origin - self.pan) / self.zoom;
        Pos2::new(v.x, v.y)
    }

    fn node_rect(&self, origin: Pos2, n: &Node) -> Rect {
        let p = self.to_screen(origin, Pos2::new(n.layout.x, n.layout.y));
        Rect::from_min_size(p, self.node_size(n) * self.zoom)
    }

    fn port_pos(&self, origin: Pos2, n: &Node, p: &Port) -> Pos2 {
        let sz = self.node_size(n);
        let ins: Vec<_> = n.ports.iter().filter(|x| x.dir == Direction::In).collect();
        let outs: Vec<_> = n.ports.iter().filter(|x| x.dir == Direction::Out).collect();
        let list = if p.dir == Direction::In { &ins } else { &outs };
        let i = list.iter().position(|x| x.name == p.name).unwrap_or(0);
        let nports = list.len().max(1) as f32;
        let y = n.layout.y + sz.y * ((i as f32 + 0.5) / nports);
        let x = if p.dir == Direction::In {
            n.layout.x
        } else {
            n.layout.x + sz.x
        };
        self.to_screen(origin, Pos2::new(x, y))
    }

    fn open_op_create(&mut self, graph_pos: Pos2, screen_pos: Pos2, wire: Option<WireStart>) {
        self.last_graph_pos = graph_pos;
        self.op_create_screen = screen_pos + Vec2::new(12.0, 12.0);
        self.open_surface(Surface::OpCreate);
        self.op_create_q.clear();
        self.op_create_i = 0;
        self.focus_op_create = true;
        self.pending_insert = wire;
    }

    fn open_surface(&mut self, surface: Surface) {
        if self.overlays.is_open(Surface::OpCreate) && surface != Surface::OpCreate {
            self.pending_insert = None;
        }
        self.overlays.open(surface);
    }

    fn toggle_surface(&mut self, surface: Surface) {
        if self.overlays.is_open(Surface::OpCreate) {
            self.pending_insert = None;
        }
        self.overlays.toggle(surface);
    }

    fn close_surface(&mut self) {
        if self.overlays.is_open(Surface::OpCreate) {
            self.pending_insert = None;
        }
        self.overlays.close();
    }

    fn close_surface_if(&mut self, surface: Surface) {
        if self.overlays.is_open(surface) {
            self.close_surface();
        }
    }

    fn invalidate_cook(&mut self) {
        self.last_states.clear();
        self.last_arts.clear();
        self.autosave_due = Some(Instant::now());
    }

    fn nfcore_cache_path() -> PathBuf {
        project_root().join(".axial/catalog/nfcore-pipelines.json")
    }

    fn install_nfcore_catalog(&mut self, pipelines: Vec<NfcorePipeline>) {
        let current: BTreeSet<String> = pipelines.iter().map(NfcorePipeline::operator_id).collect();
        self.catalog.ops.retain(|id, operator| {
            operator.palette.as_slice() != ["nf-core", "Catalog"] || current.contains(id)
        });
        self.nfcore.clear();
        for pipeline in pipelines {
            let id = pipeline.operator_id();
            let replace_generated = self
                .catalog
                .ops
                .get(&id)
                .is_none_or(|operator| operator.palette.as_slice() == ["nf-core", "Catalog"]);
            if replace_generated {
                self.catalog.ops.insert(id.clone(), pipeline.operator());
            }
            self.nfcore.insert(id, pipeline);
        }
    }

    fn load_nfcore_cache(&mut self) {
        let Ok(text) = fs::read_to_string(Self::nfcore_cache_path()) else {
            return;
        };
        if let Ok(pipelines) = nfcore_catalog::parse(&text) {
            self.install_nfcore_catalog(pipelines);
        }
    }

    fn refresh_nfcore_catalog(&mut self) {
        if self.nfcore_rx.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(nfcore_catalog::fetch());
        });
        self.nfcore_rx = Some(rx);
    }

    fn refresh_system_profile(&mut self) {
        self.system_profile = None;
        self.system_profile_rx = Some(system_profile::detect_async());
    }

    fn poll_system_profile(&mut self, ctx: &egui::Context) {
        let Some(receiver) = &self.system_profile_rx else {
            return;
        };
        match receiver.try_recv() {
            Ok(profile) => {
                self.system_profile = Some(profile);
                self.system_profile_rx = None;
            }
            Err(mpsc::TryRecvError::Empty) => {
                ctx.request_repaint_after(Duration::from_millis(50));
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                self.system_profile_rx = None;
            }
        }
    }

    fn poll_nfcore_catalog(&mut self, ctx: &egui::Context) {
        let Some(rx) = &self.nfcore_rx else {
            return;
        };
        match rx.try_recv() {
            Ok(Ok((text, pipelines))) => {
                let count = pipelines.len();
                let path = Self::nfcore_cache_path();
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(path, text);
                self.install_nfcore_catalog(pipelines);
                self.nfcore_rx = None;
                self.status = format!("nf-core catalog ready · {count} pipelines");
            }
            Ok(Err(error)) => {
                self.nfcore_rx = None;
                if self.nfcore.is_empty() {
                    self.status = format!("nf-core catalog unavailable: {error}");
                }
            }
            Err(mpsc::TryRecvError::Empty) => ctx.request_repaint_after(Duration::from_millis(50)),
            Err(mpsc::TryRecvError::Disconnected) => {
                self.nfcore_rx = None;
            }
        }
    }

    fn restore_history(&mut self, redo: bool) {
        let changed = if redo {
            self.history.redo(&mut self.graph)
        } else {
            self.history.undo(&mut self.graph)
        };
        if !changed {
            self.status = if redo {
                "nothing to redo".into()
            } else {
                "nothing to undo".into()
            };
            return;
        }
        self.selection.retain_graph(&self.graph);
        self.invalidate_cook();
        self.status = if redo { "redid edit" } else { "undid edit" }.into();
    }

    fn drop_op(&mut self, op: &Operator, pos: Pos2) {
        let before = self.graph.clone();
        let pending = self.pending_insert.take();
        let pos = snap_point_to_grid(pos);
        let existing: Vec<String> = self.graph.nodes.iter().map(|n| n.id.clone()).collect();
        let id = next_op_name(&existing, &op.id);
        let mut params = BTreeMap::new();
        for (k, spec) in &op.params {
            if let Some(d) = &spec.default {
                params.insert(k.clone(), d.clone());
            }
        }
        self.graph.nodes.push(Node {
            id: id.clone(),
            operator: op.id.clone(),
            ports: op.ir_ports(),
            params,
            layout: Layout { x: pos.x, y: pos.y },
            note: None,
        });
        if is_workflow_operator(&op.id) || op.palette.as_slice() == ["nf-core", "Catalog"] {
            self.viewer_off.insert(id.clone());
        }
        let library_error = self.library.record(&op.id).err();
        self.history.remember(&before);
        self.selection.select_node(&id, SelectionMode::Replace);
        self.param_page.clear();
        self.invalidate_cook();
        self.status = if op.palette.as_slice() == ["nf-core", "Catalog"] {
            let revision = self
                .nfcore
                .get(&op.id)
                .map(|pipeline| pipeline.revision.as_str())
                .unwrap_or("latest");
            format!(
                "added {} {revision} · configure inputs, then Cook",
                op.title
            )
        } else {
            format!("dropped {id}")
        };
        if let Some(wire) = pending {
            let connection = self
                .graph
                .node(&id)
                .and_then(|node| wire.best_connection_to(&self.graph, &id, &node.ports));
            if let Some(connection) = connection {
                if connect(&mut self.graph, &connection).is_ok() {
                    let paired = paired_companion(&self.graph, &connection)
                        .is_some_and(|mate| connect(&mut self.graph, &mate).unwrap_or(false));
                    self.status = if paired {
                        format!("inserted {id} · snapped R1 + R2")
                    } else {
                        format!("inserted {id} and snapped")
                    };
                }
            }
        }
        self.close_surface_if(Surface::OpCreate);
        self.op_create_q.clear();
        if let Some(error) = library_error {
            self.status
                .push_str(&format!(" · Library state was not saved: {error}"));
        }
    }

    fn insert_accession(&mut self) {
        let request = match sources::classify(&self.accession) {
            Ok(value) => value,
            Err(error) => {
                self.status = error;
                return;
            }
        };
        let kind = request.kind;
        let accession = request.value.clone();
        self.pending_insert = None;
        let pos = self.last_graph_pos;
        match kind {
            AccessionKind::SraRun => {
                let Ok(prefetch) = self.catalog.get("sra.prefetch").cloned() else {
                    self.status = "SRA prefetch operator is missing".into();
                    return;
                };
                let Ok(fasterq) = self.catalog.get("sra.fasterq_dump").cloned() else {
                    self.status = "fasterq-dump operator is missing".into();
                    return;
                };
                self.drop_op(&prefetch, pos);
                let Some(prefetch_id) = self.selection.primary().map(str::to_owned) else {
                    return;
                };
                if let Some(node) = self
                    .graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == prefetch_id)
                {
                    node.params
                        .insert("accession".into(), ParamValue::String(accession.clone()));
                }
                self.drop_op(&fasterq, pos + Vec2::new(210.0, 0.0));
                let Some(fasterq_id) = self.selection.primary().map(str::to_owned) else {
                    return;
                };
                self.try_wire(Connection::new(&prefetch_id, "sra", &fasterq_id, "sra"));
                self.selection
                    .select_many(vec![prefetch_id, fasterq_id], SelectionMode::Replace);
                self.status = format!("{accession} ready · Cook downloads and converts to FASTQ");
            }
            AccessionKind::Assembly => {
                let Ok(operator) = self.catalog.get("ncbi.datasets_assembly").cloned() else {
                    self.status = "NCBI assembly operator is missing".into();
                    return;
                };
                let Ok(unzip) = self.catalog.get("archive.unzip").cloned() else {
                    self.status = "archive unzip operator is missing".into();
                    return;
                };
                self.drop_op(&operator, pos);
                let Some(download_id) = self.selection.primary().map(str::to_owned) else {
                    return;
                };
                if let Some(node) = self
                    .graph
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == download_id)
                {
                    node.params
                        .insert("accession".into(), ParamValue::String(accession.clone()));
                }
                self.drop_op(&unzip, pos + Vec2::new(210.0, 0.0));
                let Some(unzip_id) = self.selection.primary().map(str::to_owned) else {
                    return;
                };
                self.try_wire(Connection::new(
                    &download_id,
                    "package",
                    &unzip_id,
                    "archive",
                ));
                self.selection
                    .select_many(vec![download_id, unzip_id], SelectionMode::Replace);
                self.status =
                    format!("{accession} ready · Cook downloads and unpacks the NCBI package");
            }
            AccessionKind::EnsemblGene
            | AccessionKind::EnsemblTranscript
            | AccessionKind::EnsemblProtein => {
                let Ok(operator) = self.catalog.get("ensembl.sequence").cloned() else {
                    self.status = "Ensembl stable-ID operator is missing".into();
                    return;
                };
                self.drop_op(&operator, pos);
                let Some(node_id) = self.selection.primary().map(str::to_owned) else {
                    return;
                };
                if let Some(node) = self.graph.nodes.iter_mut().find(|node| node.id == node_id) {
                    node.params
                        .insert("accession".into(), ParamValue::String(accession.clone()));
                    node.params.insert(
                        "sequence_type".into(),
                        ParamValue::String(request.sequence_type().unwrap_or("genomic").to_owned()),
                    );
                }
                self.status = format!(
                    "{accession} ready · Cook retrieves {} from Ensembl",
                    request.result().to_ascii_lowercase()
                );
            }
        }
        self.accession.clear();
        self.invalidate_cook();
    }

    fn insert_snakemake_project(&mut self, path: PathBuf) {
        let has_snakefile =
            path.join("Snakefile").is_file() || path.join("workflow").join("Snakefile").is_file();
        if !path.is_dir() || !has_snakefile {
            self.status = format!(
                "{} is not a Snakemake project (expected Snakefile or workflow/Snakefile)",
                path.display()
            );
            return;
        }
        let Ok(import) = self.catalog.get("files.import_directory").cloned() else {
            self.status = "directory import operator is missing".into();
            return;
        };
        let Ok(snakemake) = self.catalog.get("smk.workflow").cloned() else {
            self.status = "Snakemake workflow operator is missing".into();
            return;
        };

        self.pending_insert = None;
        let pos = self.last_graph_pos;
        self.drop_op(&import, pos);
        let Some(import_id) = self.selection.primary().map(str::to_owned) else {
            return;
        };
        if let Some(node) = self
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == import_id)
        {
            node.params.insert(
                "path".into(),
                ParamValue::String(path.display().to_string()),
            );
        }
        self.drop_op(&snakemake, pos + Vec2::new(220.0, 0.0));
        let Some(snakemake_id) = self.selection.primary().map(str::to_owned) else {
            return;
        };
        if path.join("Snakefile").is_file() {
            if let Some(node) = self
                .graph
                .nodes
                .iter_mut()
                .find(|node| node.id == snakemake_id)
            {
                node.params
                    .insert("snakefile".into(), ParamValue::String("Snakefile".into()));
            }
        }
        self.try_wire(Connection::new(
            &import_id,
            "directory",
            &snakemake_id,
            "workflow",
        ));
        self.selection
            .select_many(vec![import_id, snakemake_id], SelectionMode::Replace);
        self.invalidate_cook();
        self.status = format!(
            "{} ready · Cook runs Snakemake in an isolated copy",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("workflow")
        );
    }

    fn cook(&mut self) {
        if self.cook_rx.is_some() {
            return;
        }
        if let Err(e) = self.graph.validate() {
            self.status = format!("{e}");
            return;
        }
        let graph = self.graph.clone();
        let catalog = self.catalog.clone();
        let root = project_root();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let r = Project::open(&root)
                .map_err(|e| e.to_string())
                .and_then(|p| cook_graph(&p, &catalog, &graph).map_err(|e| e.to_string()));
            let _ = tx.send(r);
        });
        self.cook_rx = Some(rx);
        self.cook_started = Some(Instant::now());
        self.status = "cooking…".into();
    }

    fn poll_cook(&mut self, ctx: &egui::Context) {
        let Some(rx) = &self.cook_rx else {
            return;
        };
        match rx.try_recv() {
            Ok(Ok(rep)) => {
                self.last_states = rep.states;
                self.last_arts = rep.artifacts;
                let ms = self
                    .cook_started
                    .map(|t| t.elapsed().as_millis())
                    .unwrap_or(0);
                let skipped = self
                    .last_states
                    .values()
                    .filter(|s| matches!(s, NodeState::Skipped))
                    .count();
                self.status = if let Some((id, e)) = rep.errors.iter().next() {
                    format!("{id}: {e}")
                } else if skipped > 0 {
                    format!("cooked  {ms} ms  ·  {skipped} skipped (unbound inputs)")
                } else {
                    format!("cooked  {ms} ms")
                };
                self.cook_rx = None;
                self.cook_started = None;
            }
            Ok(Err(e)) => {
                self.status = e;
                self.cook_rx = None;
                self.cook_started = None;
            }
            Err(mpsc::TryRecvError::Empty) => {
                ctx.request_repaint();
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                self.status = "cook thread died".into();
                self.cook_rx = None;
            }
        }
    }

    fn try_wire(&mut self, connection: Connection) {
        let before = self.graph.clone();
        match connect(&mut self.graph, &connection) {
            Ok(true) => {
                let paired = paired_companion(&self.graph, &connection)
                    .is_some_and(|mate| connect(&mut self.graph, &mate).unwrap_or(false));
                self.history.remember(&before);
                self.invalidate_cook();
                self.status = if paired {
                    format!(
                        "snapped {} → {} · R1 + R2",
                        connection.from_node, connection.to_node
                    )
                } else {
                    format!(
                        "snapped {}.{} → {}.{}",
                        connection.from_node,
                        connection.from_port,
                        connection.to_node,
                        connection.to_port
                    )
                };
            }
            Ok(false) => self.status = "already snapped".into(),
            Err(err) => self.status = format!("no snap: {err}"),
        }
    }

    fn duplicate_selected(&mut self) {
        let selected: BTreeSet<String> = self.selection.nodes().map(str::to_owned).collect();
        if selected.is_empty() {
            return;
        }
        let before = self.graph.clone();
        let mut existing: Vec<String> = self
            .graph
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect();
        let mut renamed = BTreeMap::new();
        let copies: Vec<Node> = self
            .graph
            .nodes
            .iter()
            .filter(|node| selected.contains(&node.id))
            .cloned()
            .map(|mut node| {
                let old = node.id.clone();
                node.id = next_op_name(&existing, &node.operator);
                existing.push(node.id.clone());
                renamed.insert(old, node.id.clone());
                node.layout.x += 28.0;
                node.layout.y += 28.0;
                node
            })
            .collect();
        let copied_edges = self
            .graph
            .edges
            .iter()
            .filter(|edge| selected.contains(&edge.from_node) && selected.contains(&edge.to_node))
            .cloned()
            .map(|mut edge| {
                edge.from_node = renamed[&edge.from_node].clone();
                edge.to_node = renamed[&edge.to_node].clone();
                edge.id = format!(
                    "e_{}_{}_{}_{}",
                    edge.from_node, edge.from_port, edge.to_node, edge.to_port
                );
                edge
            })
            .collect::<Vec<_>>();
        let count = copies.len();
        let copy_ids = copies
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        self.graph.nodes.extend(copies);
        self.graph.edges.extend(copied_edges);
        self.history.remember(&before);
        self.selection.select_many(copy_ids, SelectionMode::Replace);
        self.invalidate_cook();
        self.status = format!(
            "duplicated {count} node{}",
            if count == 1 { "" } else { "s" }
        );
    }

    fn delete_selected(&mut self) {
        if let Some(edge_id) = self.selection.edge().map(str::to_owned) {
            let before = self.graph.clone();
            self.graph.edges.retain(|edge| edge.id != edge_id);
            if self.graph == before {
                self.selection.clear();
                return;
            }
            self.history.remember(&before);
            self.selection.clear();
            self.invalidate_cook();
            self.status = "deleted wire".into();
            return;
        }
        let selected: BTreeSet<String> = self.selection.nodes().map(str::to_owned).collect();
        if selected.is_empty() {
            return;
        }
        let before = self.graph.clone();
        self.graph.nodes.retain(|node| !selected.contains(&node.id));
        self.graph.edges.retain(|edge| {
            !selected.contains(&edge.from_node) && !selected.contains(&edge.to_node)
        });
        self.history.remember(&before);
        for id in &selected {
            self.last_states.remove(id);
            self.last_arts.remove(id);
            self.viewer_off.remove(id);
            self.sizes.remove(id);
        }
        let count = selected.len();
        self.selection.clear();
        self.info = None;
        self.invalidate_cook();
        self.status = format!("deleted {count} node{}", if count == 1 { "" } else { "s" });
    }

    fn commit_rename(&mut self, old: &str, requested: &str) {
        let next = requested.trim().to_owned();
        let before = self.graph.clone();
        match rename_node(&mut self.graph, old, &next) {
            Ok(true) => {
                self.history.remember(&before);
                self.selection.select_node(&next, SelectionMode::Replace);
                if self.viewer_off.remove(old) {
                    self.viewer_off.insert(next.clone());
                }
                if let Some(value) = self.sizes.remove(old) {
                    self.sizes.insert(next.clone(), value);
                }
                if let Some(value) = self.last_states.remove(old) {
                    self.last_states.insert(next.clone(), value);
                }
                if let Some(value) = self.last_arts.remove(old) {
                    self.last_arts.insert(next.clone(), value);
                }
                if self.info.as_deref() == Some(old) {
                    self.info = Some(next.clone());
                }
                self.rename_target = Some(next.clone());
                self.rename_buffer = next.clone();
                self.invalidate_cook();
                self.status = format!("renamed {old} → {next}");
            }
            Ok(false) => {}
            Err(error) => {
                self.rename_buffer = old.to_owned();
                self.status = error;
            }
        }
    }

    fn ingest_path(&mut self, path: PathBuf, pos: Pos2) {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        if path.is_dir() {
            if path.join("Snakefile").is_file() || path.join("workflow").join("Snakefile").is_file()
            {
                self.last_graph_pos = pos;
                self.insert_snakemake_project(path);
            } else if let Ok(operator) = self.catalog.get("files.import_directory").cloned() {
                self.drop_op(&operator, pos);
                if let Some(node) = self.graph.nodes.last_mut() {
                    node.params.insert(
                        "path".into(),
                        ParamValue::String(path.display().to_string()),
                    );
                }
                self.status = format!("import directory {name}");
            }
            return;
        }
        if ext == "pdf" || ext == "txt" || ext == "md" {
            if self.paper_rx.is_some() {
                return;
            }
            let cat = self.catalog.clone();
            let (tx, rx) = mpsc::channel();
            let p = path.clone();
            thread::spawn(move || {
                let r = extract_from_path(&p).map_err(|e| e.to_string()).map(|e| {
                    let mut rec = reconstruct(&cat, &e.text);
                    if e.via == ExtractVia::Tesseract {
                        rec.warn_all("OCR via tesseract (same flags as omarchy capture text)");
                    }
                    rec
                });
                let _ = tx.send(r);
            });
            self.paper_rx = Some(rx);
            self.paper_name = name.clone();
            self.status = format!("reading {name}…");
            return;
        }
        if ext == "json" || name.ends_with(".axial.json") {
            match fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str::<Graph>(&s).ok())
            {
                Some(g) if g.validate().is_ok() => {
                    self.graph = g;
                    self.graph_path = Some(path.clone());
                    self.autosave_due = Some(Instant::now());
                    self.history = EditHistory::default();
                    self.selection.clear();
                    if let Some(node) = self.graph.nodes.first() {
                        self.selection.select_node(&node.id, SelectionMode::Replace);
                    }
                    self.last_states.clear();
                    self.last_arts.clear();
                    self.request_fit();
                    self.status = format!("loaded {name}");
                }
                _ => self.status = format!("not a graph: {name}"),
            }
            return;
        }
        if matches!(
            ext.as_str(),
            "fastq" | "fq" | "gz" | "fasta" | "fa" | "bam" | "vcf" | "gtf"
        ) {
            if let Ok(op) = self.catalog.get("files.import").cloned() {
                self.drop_op(&op, pos);
                if let Some(n) = self.graph.nodes.last_mut() {
                    n.params.insert(
                        "path".into(),
                        ParamValue::String(path.display().to_string()),
                    );
                }
                self.status = format!("import {name}");
            }
            return;
        }
        self.status = format!("drop an Axial graph, data file, or methods paper—not {name}");
    }

    fn ingest_paired_paths(&mut self, r1: PathBuf, r2: PathBuf, pos: Pos2) {
        let Ok(operator) = self.catalog.get("files.import_paired").cloned() else {
            self.ingest_path(r1, pos);
            self.ingest_path(r2, pos + Vec2::new(0.0, 140.0));
            return;
        };
        self.pending_insert = None;
        self.drop_op(&operator, pos);
        let Some(id) = self.selection.primary().map(str::to_owned) else {
            return;
        };
        if let Some(node) = self.graph.nodes.iter_mut().find(|node| node.id == id) {
            node.params
                .insert("r1".into(), ParamValue::String(r1.display().to_string()));
            node.params
                .insert("r2".into(), ParamValue::String(r2.display().to_string()));
        }
        self.invalidate_cook();
        self.status = "paired reads ready · R1 + R2 stay separate".into();
    }

    fn poll_paper(&mut self, ctx: &egui::Context) {
        let Some(rx) = &self.paper_rx else {
            return;
        };
        match rx.try_recv() {
            Ok(Ok(r)) => {
                self.install_paper_reconstruction(self.paper_name.clone(), r);
                self.paper_rx = None;
            }
            Ok(Err(e)) => {
                self.status = e;
                self.paper_rx = None;
            }
            Err(mpsc::TryRecvError::Empty) => ctx.request_repaint(),
            Err(mpsc::TryRecvError::Disconnected) => {
                self.status = "paper thread died".into();
                self.paper_rx = None;
            }
        }
    }

    fn fit_view(&mut self, canvas: Rect) {
        if self.graph.nodes.is_empty() {
            return;
        }
        let mut min = Vec2::splat(f32::MAX);
        let mut max = Vec2::splat(f32::MIN);
        for n in &self.graph.nodes {
            let sz = self.node_size(n);
            min.x = min.x.min(n.layout.x);
            min.y = min.y.min(n.layout.y);
            max.x = max.x.max(n.layout.x + sz.x);
            max.y = max.y.max(n.layout.y + sz.y + 22.0);
        }
        let size = (max - min).max(Vec2::splat(40.0));
        let pad = 56.0;
        let avail = (canvas.size() - Vec2::splat(pad * 2.0)).max(Vec2::splat(80.0));
        let z = (avail.x / size.x).min(avail.y / size.y).clamp(0.32, 1.35);
        self.zoom = z;
        let world_c = (min + max) * 0.5;
        self.pan = canvas.size() * 0.5 - world_c * z;
    }

    fn request_fit(&mut self) {
        self.auto_fit = true;
    }

    fn example_paper() -> PathBuf {
        project_root().join("testdata/papers/rnaseq_methods.txt")
    }

    fn pick_paper_file() -> Option<PathBuf> {
        let out = Command::new("zenity")
            .args([
                "--file-selection",
                "--title=Axial — paper",
                "--file-filter=Papers | *.pdf *.txt *.md",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if p.is_empty() {
            None
        } else {
            Some(PathBuf::from(p))
        }
    }

    fn pick_source_path(kind: PathPicker, current: &str) -> Option<PathBuf> {
        let mut command = Command::new("zenity");
        command.args(["--file-selection", "--title=Axial — choose source"]);
        if kind == PathPicker::Directory {
            command.arg("--directory");
        }
        if !current.trim().is_empty() {
            command.arg(format!("--filename={}", current.trim()));
        }
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }

    fn pick_snakemake_directory() -> Option<PathBuf> {
        let out = Command::new("zenity")
            .args([
                "--file-selection",
                "--directory",
                "--title=Axial — open Snakemake project",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }

    fn pick_graph_file() -> Option<PathBuf> {
        let suggested = project_root().join("project1.axial.json");
        let out = Command::new("zenity")
            .args([
                "--file-selection",
                "--save",
                "--confirm-overwrite",
                "--title=Axial — save graph",
                "--file-filter=Axial graphs | *.axial.json *.json",
            ])
            .arg(format!("--filename={}", suggested.display()))
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }

    fn write_graph(&self, path: &Path) -> Result<(), String> {
        self.graph.validate().map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(&self.graph).map_err(|error| error.to_string())?;
        let parent = path
            .parent()
            .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "graph filename is not valid UTF-8".to_owned())?;
        let staged = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
        fs::write(&staged, bytes).map_err(|error| error.to_string())?;
        fs::rename(&staged, path).map_err(|error| error.to_string())
    }

    fn save_graph(&mut self) {
        let Some(path) = self.graph_path.clone().or_else(Self::pick_graph_file) else {
            return;
        };
        match self.write_graph(&path) {
            Ok(()) => {
                self.graph_path = Some(path.clone());
                self.autosave_due = None;
                let recovery = project_root().join(".axial/autosave.axial.json");
                self.status = match self.write_graph(&recovery) {
                    Ok(()) => format!("saved {}", path.display()),
                    Err(error) => {
                        format!("saved {} · recovery copy failed: {error}", path.display())
                    }
                };
            }
            Err(error) => self.status = format!("save failed: {error}"),
        }
    }

    fn poll_autosave(&mut self, ctx: &egui::Context) {
        let Some(due) = self.autosave_due else {
            return;
        };
        if due.elapsed() < Duration::from_millis(700) {
            ctx.request_repaint_after(Duration::from_millis(700) - due.elapsed());
            return;
        }
        self.autosave_due = None;
        let path = project_root().join(".axial/autosave.axial.json");
        if let Err(error) = self.write_graph(&path) {
            self.status = format!("autosave failed: {error}");
        }
    }

    fn refresh_fq(&mut self) {
        for n in &self.graph.nodes {
            let param = match n.operator.as_str() {
                "files.import" => "path",
                "files.import_paired" => "r1",
                _ => continue,
            };
            let Some(ParamValue::String(path)) = n.params.get(param) else {
                continue;
            };
            if self.fq.contains_key(path) {
                continue;
            }
            let p = Path::new(path);
            let full = if p.is_absolute() {
                p.to_path_buf()
            } else {
                project_root().join(p)
            };
            if let Ok(s) = fs::read_to_string(&full) {
                if let Some(fq) = parse_fastq(&s) {
                    self.fq.insert(path.clone(), fq);
                }
            }
        }
    }

    fn fq_for(&self, id: &str) -> Option<&FqPreview> {
        let n = self.graph.node(id)?;
        if n.operator == "files.import" {
            if let Some(ParamValue::String(path)) = n.params.get("path") {
                return self.fq.get(path);
            }
        } else if n.operator == "files.import_paired" {
            if let Some(ParamValue::String(path)) = n.params.get("r1") {
                return self.fq.get(path);
            }
        }
        for e in &self.graph.edges {
            if e.to_node == id {
                if let Some(fq) = self.fq_for(&e.from_node) {
                    return Some(fq);
                }
            }
        }
        None
    }

    fn filtered_ops(&self, q: &str) -> Vec<Operator> {
        let q = q.to_lowercase();
        let mut out = Vec::new();
        for op in self.catalog.ops.values() {
            let search_match = q.is_empty()
                || op.title.to_lowercase().contains(&q)
                || op.id.to_lowercase().contains(&q)
                || op.palette.iter().any(|p| p.to_lowercase().contains(&q));
            let wire_match = self.pending_insert.as_ref().is_none_or(|wire| {
                op.ir_ports()
                    .iter()
                    .any(|port| wire.accepts(&self.graph, port))
            });
            if search_match && wire_match {
                out.push(op.clone());
            }
        }
        out.sort_by(|a, b| a.title.cmp(&b.title));
        out
    }
}

fn bezier_points(a: Pos2, b: Pos2) -> Vec<Pos2> {
    let dx = (b.x - a.x).abs().max(48.0) * 0.5;
    let c1 = a + Vec2::new(dx, 0.0);
    let c2 = b - Vec2::new(dx, 0.0);
    let n = 28;
    let mut pts = Vec::with_capacity(n + 1);
    pts.push(a);
    for i in 1..=n {
        let tt = i as f32 / n as f32;
        let u = 1.0 - tt;
        pts.push(Pos2::new(
            u * u * u * a.x
                + 3.0 * u * u * tt * c1.x
                + 3.0 * u * tt * tt * c2.x
                + tt * tt * tt * b.x,
            u * u * u * a.y
                + 3.0 * u * u * tt * c1.y
                + 3.0 * u * tt * tt * c2.y
                + tt * tt * tt * b.y,
        ));
    }
    pts
}

fn segment_distance(point: Pos2, a: Pos2, b: Pos2) -> f32 {
    let segment = b - a;
    let length_sq = segment.length_sq();
    if length_sq <= f32::EPSILON {
        return point.distance(a);
    }
    let t = ((point - a).dot(segment) / length_sq).clamp(0.0, 1.0);
    point.distance(a + segment * t)
}

fn bezier_distance(a: Pos2, b: Pos2, point: Pos2) -> f32 {
    bezier_points(a, b)
        .windows(2)
        .map(|window| segment_distance(point, window[0], window[1]))
        .fold(f32::MAX, f32::min)
}

fn bezier(
    painter: &egui::Painter,
    a: Pos2,
    b: Pos2,
    color: Color32,
    cooking: bool,
    emphasized: bool,
    t: f64,
) {
    let pts = bezier_points(a, b);
    let glow = color.gamma_multiply(0.28);
    for w in pts.windows(2) {
        painter.line_segment(
            [w[0], w[1]],
            Stroke::new(if emphasized { 8.0 } else { 5.5 }, glow),
        );
    }
    let pulse = if cooking {
        0.55 + 0.45 * ((t * 6.0).sin() as f32)
    } else {
        1.0
    };
    let col = color.gamma_multiply(pulse);
    for w in pts.windows(2) {
        let width = if emphasized {
            3.2
        } else if cooking {
            2.4
        } else {
            1.7
        };
        painter.line_segment([w[0], w[1]], Stroke::new(width, col));
    }
}

fn bezier_bounds(a: Pos2, b: Pos2) -> Rect {
    let dx = (b.x - a.x).abs().max(48.0) * 0.5;
    let c1 = a + Vec2::new(dx, 0.0);
    let c2 = b - Vec2::new(dx, 0.0);
    Rect::from_min_max(
        Pos2::new(
            a.x.min(b.x).min(c1.x).min(c2.x),
            a.y.min(b.y).min(c1.y).min(c2.y),
        ),
        Pos2::new(
            a.x.max(b.x).max(c1.x).max(c2.x),
            a.y.max(b.y).max(c1.y).max(c2.y),
        ),
    )
}

fn draw_grid(painter: &egui::Painter, rect: Rect, pan: Vec2, zoom: f32) {
    let minor = 20.0 * zoom;
    let major = 100.0 * zoom;
    if minor >= 9.0 {
        let ox = rect.min.x + pan.x.rem_euclid(minor);
        let oy = rect.min.y + pan.y.rem_euclid(minor);
        let mut x = ox;
        while x < rect.max.x {
            let mut y = oy;
            while y < rect.max.y {
                painter.circle_filled(
                    Pos2::new(x, y),
                    (0.82 * zoom.sqrt()).clamp(0.72, 1.15),
                    GRID,
                );
                y += minor;
            }
            x += minor;
        }
    }
    if major >= 8.0 {
        let ox = rect.min.x + pan.x.rem_euclid(major);
        let oy = rect.min.y + pan.y.rem_euclid(major);
        let mut x = ox;
        while x < rect.max.x {
            let mut y = oy;
            while y < rect.max.y {
                painter.circle_filled(
                    Pos2::new(x, y),
                    (1.32 * zoom.sqrt()).clamp(1.05, 1.8),
                    GRID_MAJ,
                );
                y += major;
            }
            x += major;
        }
    }
}

fn draw_snap_guides(
    painter: &egui::Painter,
    rect: Rect,
    origin: Pos2,
    pan: Vec2,
    zoom: f32,
    guides: SnapGuides,
) {
    let stroke = |source| match source {
        SnapSource::Node => Stroke::new(1.15, SELECT.gamma_multiply(0.82)),
        SnapSource::Grid => Stroke::new(1.0, SELECT.gamma_multiply(0.38)),
    };
    if let Some(guide) = guides.x {
        let x = origin.x + guide.coordinate * zoom + pan.x;
        if rect.left() <= x && x <= rect.right() {
            painter.line_segment(
                [Pos2::new(x, rect.top()), Pos2::new(x, rect.bottom())],
                stroke(guide.source),
            );
        }
    }
    if let Some(guide) = guides.y {
        let y = origin.y + guide.coordinate * zoom + pan.y;
        if rect.top() <= y && y <= rect.bottom() {
            painter.line_segment(
                [Pos2::new(rect.left(), y), Pos2::new(rect.right(), y)],
                stroke(guide.source),
            );
        }
    }
}

fn draw_fastq_seq(painter: &egui::Painter, body: Rect, fq: &FqPreview, z: f32) {
    let cap_h = (13.0 * z).clamp(11.0, 16.0);
    let cap = Rect::from_min_max(Pos2::new(body.min.x, body.max.y - cap_h), body.max);
    let vis = Rect::from_min_max(body.min, Pos2::new(body.max.x, cap.min.y));
    let n = fq.seq.len().max(1);
    let bw = (vis.width() / n as f32).max(1.0);
    let top = vis.shrink2(Vec2::new(2.0, 2.0));
    let seq_h = top.height() * 0.62;
    for (i, &b) in fq.seq.iter().enumerate() {
        let x = top.left() + i as f32 * bw;
        let r = Rect::from_min_size(Pos2::new(x, top.top()), Vec2::new(bw.max(1.0) - 0.5, seq_h));
        painter.rect_filled(r, 0, base_color(b));
    }
    let qh = top.height() * 0.28;
    let qtop = top.top() + seq_h + 1.5 * z;
    for (i, &qch) in fq.qual.iter().enumerate() {
        let q = (qch.saturating_sub(33) as f32 / 40.0).clamp(0.08, 1.0);
        let x = top.left() + i as f32 * bw;
        let h = qh * q;
        let r = Rect::from_min_max(
            Pos2::new(x, qtop + qh - h),
            Pos2::new(x + bw.max(1.0) - 0.5, qtop + qh),
        );
        painter.rect_filled(r, 0, Color32::from_rgb(90, 200, 120).gamma_multiply(0.9));
    }
    painter.rect_filled(cap, 0, Color32::from_rgb(18, 18, 20));
    draw_label(
        painter,
        cap.left_center() + Vec2::new(5.0, 0.0),
        egui::Align2::LEFT_CENTER,
        &format!("{} reads · {} bp", fq.n_reads, fq.len),
        font_px(10.0, z, 7.5, 12.0),
        Color32::from_rgb(200, 200, 204),
        cap,
    );
}

fn draw_qc_plot(painter: &egui::Painter, body: Rect, fq: Option<&FqPreview>, lit: bool) {
    let inner = body.shrink(2.0);
    let h = inner.height();
    let red = Rect::from_min_max(inner.min + Vec2::new(0.0, h * 0.55), inner.max);
    let yel = Rect::from_min_max(
        inner.min + Vec2::new(0.0, h * 0.30),
        Pos2::new(inner.max.x, inner.min.y + h * 0.55),
    );
    let grn = Rect::from_min_max(inner.min, Pos2::new(inner.max.x, inner.min.y + h * 0.30));
    let a = if lit { 1.0 } else { 0.45 };
    painter.rect_filled(grn, 0, Color32::from_rgb(32, 58, 38).gamma_multiply(a));
    painter.rect_filled(yel, 0, Color32::from_rgb(58, 52, 28).gamma_multiply(a));
    painter.rect_filled(red, 0, Color32::from_rgb(58, 28, 28).gamma_multiply(a));
    if let Some(fq) = fq {
        let n = fq.qual.len().max(1);
        let mut prev = None;
        let line = if lit {
            Color32::from_rgb(210, 230, 90)
        } else {
            Color32::from_rgb(140, 150, 80)
        };
        for (i, &qch) in fq.qual.iter().enumerate() {
            let q = (qch.saturating_sub(33) as f32).clamp(0.0, 40.0);
            let x = inner.left() + (i as f32 + 0.5) / n as f32 * inner.width();
            let y = inner.bottom() - (q / 40.0) * inner.height();
            let p = Pos2::new(x, y);
            if let Some(pr) = prev {
                painter.line_segment([pr, p], Stroke::new(1.4, line));
            }
            prev = Some(p);
        }
    } else {
        painter.text(
            inner.center(),
            egui::Align2::CENTER_CENTER,
            "per-base quality",
            FontId::proportional(10.0),
            MUTED,
        );
    }
}

fn draw_pipeline(painter: &egui::Painter, body: Rect, title: &str, ver: &str, z: f32) {
    let inner = body.shrink2(Vec2::new(6.0, 8.0));
    draw_label(
        painter,
        inner.min,
        egui::Align2::LEFT_TOP,
        title,
        font_px(10.0, z, 7.5, 11.0),
        TEXT,
        inner,
    );
    draw_label(
        painter,
        inner.min + Vec2::new(0.0, 12.0 * z.max(0.7)),
        egui::Align2::LEFT_TOP,
        ver,
        font_px(9.0, z, 7.0, 10.0),
        MUTED,
        inner,
    );
    let y = inner.max.y - 14.0;
    let w = inner.width();
    for i in 0..4 {
        let x = inner.min.x + i as f32 * (w / 4.0);
        let r = Rect::from_min_size(Pos2::new(x + 2.0, y), Vec2::new(w / 4.0 - 8.0, 10.0));
        painter.rect_filled(r, 1, Color32::from_rgb(70, 70, 78));
        if i < 3 {
            painter.line_segment(
                [
                    Pos2::new(r.max.x, r.center().y),
                    Pos2::new(r.max.x + 6.0, r.center().y),
                ],
                Stroke::new(1.0, MUTED),
            );
        }
    }
}

fn draw_quote_tip(painter: &egui::Painter, at: Pos2, note: &str, canvas: Rect) {
    let font = FontId::proportional(11.0);
    let wrap_w = 240.0;
    let galley = painter.layout(
        note.to_owned(),
        font,
        Color32::from_rgb(210, 198, 230),
        wrap_w,
    );
    let pad = Vec2::new(9.0, 7.0);
    let size = galley.size() + pad * 2.0;
    let mut min = at;
    if min.x + size.x > canvas.max.x - 8.0 {
        min.x = (at.x - size.x - 16.0).max(canvas.min.x + 8.0);
    }
    min.x = min.x.clamp(
        canvas.min.x + 8.0,
        (canvas.max.x - size.x - 8.0).max(canvas.min.x + 8.0),
    );
    if min.y + size.y > canvas.max.y - 8.0 {
        min.y = (canvas.max.y - size.y - 8.0).max(canvas.min.y + 8.0);
    }
    let r = Rect::from_min_size(min, size);
    painter.rect_filled(r, 3, Color32::from_rgb(26, 22, 34));
    painter.rect_stroke(
        r,
        3,
        Stroke::new(1.0, ACCENT.gamma_multiply(0.55)),
        egui::StrokeKind::Outside,
    );
    painter.galley(min + pad, galley, TEXT);
}

fn draw_accession(painter: &egui::Painter, body: Rect, acc: &str, kind: &str, z: f32) {
    let inner = body.shrink2(Vec2::new(6.0, 4.0));
    draw_label(
        painter,
        body.center() + Vec2::new(0.0, -7.0 * z.max(0.7)),
        egui::Align2::CENTER_CENTER,
        acc,
        font_px(13.0, z, 8.0, 14.0),
        TEXT,
        inner,
    );
    draw_label(
        painter,
        body.center() + Vec2::new(0.0, 10.0 * z.max(0.7)),
        egui::Align2::CENTER_CENTER,
        kind,
        font_px(9.0, z, 7.0, 10.0),
        MUTED,
        inner,
    );
}

fn draw_viewer(
    painter: &egui::Painter,
    body: Rect,
    n: &Node,
    fq: Option<&FqPreview>,
    st: Option<&NodeState>,
    z: f32,
) {
    let lit = matches!(st, Some(NodeState::Done) | Some(NodeState::Cached) | None);
    let inner = body.shrink2(Vec2::new(6.0, 4.0));
    if n.operator == "gap.missing" {
        let tool = match n.params.get("tool") {
            Some(ParamValue::String(s)) => s.as_str(),
            _ => "tool",
        };
        draw_label(
            painter,
            body.center(),
            egui::Align2::CENTER_CENTER,
            tool,
            font_px(13.0, z, 7.0, 14.0),
            Color32::from_rgb(230, 150, 140),
            inner,
        );
        return;
    }
    if n.operator == "files.import" {
        if let Some(fq) = fq {
            draw_fastq_seq(painter, body, fq, z);
        } else if let Some(ParamValue::String(p)) = n.params.get("path") {
            let name = Path::new(p)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(p);
            draw_label(
                painter,
                body.center() + Vec2::new(0.0, -6.0 * z.max(0.7)),
                egui::Align2::CENTER_CENTER,
                name,
                font_px(11.0, z, 8.0, 12.0),
                TEXT,
                inner,
            );
            draw_label(
                painter,
                body.center() + Vec2::new(0.0, 10.0 * z.max(0.7)),
                egui::Align2::CENTER_CENTER,
                "file",
                font_px(9.0, z, 7.0, 10.0),
                MUTED,
                inner,
            );
        } else {
            draw_label(
                painter,
                body.center(),
                egui::Align2::CENTER_CENTER,
                "file",
                font_px(12.0, z, 8.0, 13.0),
                TEXT,
                inner,
            );
        }
        return;
    }
    if n.operator == "files.import_paired" {
        if let Some(fq) = fq {
            draw_fastq_seq(painter, body, fq, z);
        }
        draw_label(
            painter,
            body.min + Vec2::new(6.0, 4.0),
            egui::Align2::LEFT_TOP,
            "R1 + R2",
            font_px(9.0, z, 7.0, 10.0),
            MUTED,
            inner,
        );
        return;
    }
    if n.operator == "qc.fastqc" || n.operator == "qc.fastp" {
        draw_qc_plot(painter, body, fq, lit);
        if n.operator == "qc.fastp" {
            draw_label(
                painter,
                body.min + Vec2::new(6.0, 4.0),
                egui::Align2::LEFT_TOP,
                "fastp",
                font_px(9.0, z, 7.0, 10.0),
                MUTED,
                inner,
            );
        }
        return;
    }
    if n.operator.starts_with("nf.") {
        let title = n.operator.trim_start_matches("nf.");
        let ver = match n.params.get("revision") {
            Some(ParamValue::String(s)) => s.as_str(),
            _ => "",
        };
        draw_pipeline(painter, body, &format!("nf-core/{title}"), ver, z);
        return;
    }
    if n.operator == "sheet.rnaseq" {
        let sample = match n.params.get("sample") {
            Some(ParamValue::String(s)) => s.as_str(),
            _ => "sample1",
        };
        let strand = match n.params.get("strandedness") {
            Some(ParamValue::String(s)) => s.as_str(),
            _ => "auto",
        };
        draw_label(
            painter,
            inner.min,
            egui::Align2::LEFT_TOP,
            "sample  r1  r2  strand",
            font_px(9.0, z, 7.0, 10.0),
            MUTED,
            inner,
        );
        draw_label(
            painter,
            inner.min + Vec2::new(0.0, 14.0 * z.max(0.7)),
            egui::Align2::LEFT_TOP,
            &format!("{sample}  ·  {strand}"),
            font_px(11.0, z, 8.0, 12.0),
            TEXT,
            inner,
        );
        return;
    }
    if n.operator == "sra.fasterq_dump" {
        draw_accession(painter, body, "FASTQ", "from SRA", z);
        return;
    }
    if n.operator.starts_with("sra.") || n.operator.starts_with("ncbi.") {
        let acc = match n.params.get("accession").or_else(|| n.params.get("taxon")) {
            Some(ParamValue::String(s)) if !s.is_empty() => s.as_str(),
            _ => n.operator.rsplit('.').next().unwrap_or("ncbi"),
        };
        draw_accession(
            painter,
            body,
            acc,
            type_name(
                n.ports
                    .iter()
                    .find(|p| p.dir == Direction::Out)
                    .map(|p| p.ty)
                    .unwrap_or(PortType::Text),
            ),
            z,
        );
        return;
    }
    if n.operator.starts_with("ensembl.") {
        let band = body.shrink(6.0);
        for i in 0..18 {
            let x = band.left() + i as f32 * (band.width() / 18.0);
            let col = if i % 2 == 0 {
                Color32::from_rgb(70, 170, 140)
            } else {
                Color32::from_rgb(50, 90, 120)
            };
            painter.rect_filled(
                Rect::from_min_size(
                    Pos2::new(x, band.top() + 10.0),
                    Vec2::new(band.width() / 18.0 - 1.0, band.height() - 20.0),
                ),
                0,
                col,
            );
        }
        let sp = match n.params.get("species").or_else(|| n.params.get("id")) {
            Some(ParamValue::String(s)) => s.as_str(),
            _ => "ensembl",
        };
        draw_label(
            painter,
            inner.min,
            egui::Align2::LEFT_TOP,
            sp,
            font_px(9.0, z, 7.0, 10.0),
            TEXT,
            inner,
        );
        return;
    }
    draw_label(
        painter,
        body.center(),
        egui::Align2::CENTER_CENTER,
        short_op(&n.operator),
        font_px(12.0, z, 8.0, 13.0),
        TEXT,
        inner,
    );
}

#[derive(Clone, Copy, Default)]
struct PaletteRowHit {
    clicked: bool,
    favorite_clicked: bool,
}

fn draw_palette_action(
    ui: &mut egui::Ui,
    icon_text: &str,
    title: &str,
    subtitle: &str,
    color: Color32,
) -> egui::Response {
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, 6, GRAPHITE.surface_hover);
    }
    let icon = Rect::from_min_size(rect.min + Vec2::new(7.0, 8.0), Vec2::splat(27.0));
    ui.painter().rect_filled(icon, 6, color.gamma_multiply(0.2));
    ui.painter().text(
        icon.center(),
        egui::Align2::CENTER_CENTER,
        icon_text,
        FontId::proportional(if icon_text.len() > 1 { 9.5 } else { 13.0 }),
        color,
    );
    let clip = Rect::from_min_max(
        rect.min + Vec2::new(43.0, 4.0),
        rect.max - Vec2::new(5.0, 3.0),
    );
    draw_label(
        ui.painter(),
        clip.min,
        egui::Align2::LEFT_TOP,
        title,
        FontId::proportional(12.0),
        TEXT,
        clip,
    );
    draw_label(
        ui.painter(),
        clip.min + Vec2::new(0.0, 19.0),
        egui::Align2::LEFT_TOP,
        subtitle,
        FontId::proportional(10.0),
        MUTED,
        clip,
    );
    response
}

fn draw_palette_row(ui: &mut egui::Ui, item: &palette::Item, favorite: bool) -> PaletteRowHit {
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(ui.available_width(), 44.0),
        Sense::click_and_drag(),
    );
    let color = family_color(&item.operator.id);
    if response.hovered() {
        ui.painter().rect_filled(rect, 6, GRAPHITE.surface_hover);
    }

    let icon = Rect::from_min_size(rect.min + Vec2::new(7.0, 8.0), Vec2::splat(27.0));
    ui.painter().rect_filled(icon, 6, color.gamma_multiply(0.2));
    ui.painter().text(
        icon.center(),
        egui::Align2::CENTER_CENTER,
        item.icon,
        FontId::proportional(if item.icon.len() > 1 { 9.5 } else { 12.0 }),
        color,
    );

    let star = Rect::from_center_size(
        Pos2::new(rect.max.x - 14.0, rect.center().y),
        Vec2::splat(24.0),
    );
    let text_right = star.min.x - 4.0;
    let title_clip = Rect::from_min_max(
        Pos2::new(rect.min.x + 43.0, rect.min.y + 5.0),
        Pos2::new(text_right, rect.min.y + 22.0),
    );
    draw_label(
        ui.painter(),
        title_clip.min,
        egui::Align2::LEFT_TOP,
        &item.operator.title,
        FontId::proportional(12.0),
        TEXT,
        title_clip,
    );
    let subtitle_clip = Rect::from_min_max(
        Pos2::new(rect.min.x + 43.0, rect.min.y + 23.0),
        Pos2::new(text_right, rect.max.y - 3.0),
    );
    draw_label(
        ui.painter(),
        subtitle_clip.min,
        egui::Align2::LEFT_TOP,
        &item.subtitle,
        FontId::proportional(10.0),
        MUTED,
        subtitle_clip,
    );
    ui.painter().text(
        star.center(),
        egui::Align2::CENTER_CENTER,
        if favorite { "★" } else { "☆" },
        FontId::proportional(13.0),
        if favorite { ACCENT } else { MUTED },
    );

    let favorite_clicked = response.clicked()
        && response
            .interact_pointer_pos()
            .is_some_and(|pointer| star.contains(pointer));
    PaletteRowHit {
        clicked: response.clicked() && !favorite_clicked,
        favorite_clicked,
    }
}

fn palette_tooltip(ui: &mut egui::Ui, item: &palette::Item, pipeline: Option<&NfcorePipeline>) {
    ui.set_max_width(300.0);
    ui.label(
        egui::RichText::new(&item.operator.title)
            .size(13.0)
            .strong()
            .color(TEXT),
    );
    ui.label(
        egui::RichText::new(&item.operator.id)
            .size(10.0)
            .monospace()
            .color(MUTED),
    );
    ui.add_space(3.0);
    ui.label(
        egui::RichText::new(
            pipeline
                .map(|pipeline| pipeline.description.as_str())
                .filter(|description| !description.is_empty())
                .unwrap_or(&item.subtitle),
        )
        .size(11.0)
        .color(TEXT),
    );
    if let Some(pipeline) = pipeline {
        let provenance = if item.operator.palette.as_slice() == ["nf-core", "Catalog"] {
            "discovered catalog definition"
        } else {
            "curated Axial definition"
        };
        ui.label(
            egui::RichText::new(format!("release {} · {provenance}", pipeline.revision))
                .size(9.5)
                .color(MUTED),
        );
    }
    ui.add_space(4.0);
    ui.horizontal_wrapped(|ui| {
        for port in &item.operator.ports.r#in {
            ui.label(
                egui::RichText::new(format!("◀ {}", port.name))
                    .size(10.0)
                    .color(port_color(port.ty)),
            );
        }
        for port in &item.operator.ports.out {
            ui.label(
                egui::RichText::new(format!("{} ▶", port.name))
                    .size(10.0)
                    .color(port_color(port.ty)),
            );
        }
    });
    if let Some(pipeline) = pipeline.filter(|pipeline| !pipeline.topics.is_empty()) {
        ui.label(
            egui::RichText::new(pipeline.topics.join(" · "))
                .size(9.5)
                .color(ACCENT),
        );
    }
}

fn apply_visuals(ctx: &egui::Context) {
    let mut v = egui::Visuals::dark();
    v.panel_fill = PANEL;
    v.window_fill = PANEL2;
    v.extreme_bg_color = GRAPHITE.control;
    v.faint_bg_color = GRAPHITE.surface_hover;
    v.text_edit_bg_color = Some(GRAPHITE.control);
    v.hyperlink_color = GRAPHITE.accent;
    v.warn_fg_color = GRAPHITE.warning;
    v.error_fg_color = GRAPHITE.danger;
    v.override_text_color = Some(TEXT);
    v.widgets.inactive.bg_fill = GRAPHITE.control;
    v.widgets.inactive.weak_bg_fill = GRAPHITE.surface_raised;
    v.widgets.inactive.bg_stroke = Stroke::new(1.0, GRAPHITE.border);
    v.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.hovered.bg_fill = GRAPHITE.surface_hover;
    v.widgets.hovered.bg_stroke = Stroke::new(1.0, GRAPHITE.border_strong);
    v.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.active.bg_fill = GRAPHITE.surface_active;
    v.widgets.active.bg_stroke = Stroke::new(1.0, ACCENT);
    v.widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    v.selection.bg_fill = GRAPHITE.accent_strong;
    v.selection.stroke = Stroke::new(1.0, GRAPHITE.on_accent);
    v.widgets.inactive.corner_radius = CornerRadius::same(8);
    v.widgets.hovered.corner_radius = CornerRadius::same(8);
    v.widgets.active.corner_radius = CornerRadius::same(8);
    v.window_corner_radius = CornerRadius::same(14);
    v.window_stroke = Stroke::new(1.0, GRAPHITE.border);
    ctx.set_visuals(v);
    ctx.style_mut(|s| {
        s.spacing.item_spacing = Vec2::new(6.0, 5.0);
        s.spacing.button_padding = Vec2::new(8.0, 5.0);
        s.spacing.interact_size.y = 24.0;
    });
}

fn machine_profile_row(ui: &mut egui::Ui, label: &str, value: &str) {
    ui.horizontal_top(|ui| {
        ui.add_sized(
            Vec2::new(68.0, 18.0),
            egui::Label::new(egui::RichText::new(label).size(8.5).color(MUTED)),
        );
        ui.vertical(|ui| {
            ui.set_width(222.0);
            ui.add(egui::Label::new(egui::RichText::new(value).size(10.5).color(TEXT)).wrap());
        });
    });
    ui.add_space(3.0);
}

fn evidence_status_style(status: EvidenceStatus) -> (&'static str, Color32) {
    match status {
        EvidenceStatus::Explicit => ("PAPER", GRAPHITE.success),
        EvidenceStatus::Inferred => ("INFERRED", GRAPHITE.warning),
        EvidenceStatus::MissingImplementation => ("MISSING", GRAPHITE.danger),
    }
}

fn candidate_role_label(role: CandidateRole) -> &'static str {
    match role {
        CandidateRole::Primary => "PRIMARY",
        CandidateRole::Parallel => "PARALLEL",
        CandidateRole::Alternative => "ALTERNATIVE",
    }
}

fn evidence_count_chip(ui: &mut egui::Ui, count: usize, label: &str, color: Color32) {
    Frame::new()
        .fill(color.gamma_multiply(0.10))
        .stroke(Stroke::new(1.0, color.gamma_multiply(0.45)))
        .inner_margin(Margin::symmetric(7, 3))
        .corner_radius(8)
        .show(ui, |ui| {
            ui.label(
                egui::RichText::new(format!("{count} {label}"))
                    .size(9.0)
                    .color(color),
            );
        });
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        apply_visuals(ctx);
        let surface_at_frame_start = self.overlays.active();
        let mut surface_activator_clicked = false;
        {
            let r = ctx.screen_rect();
            ctx.layer_painter(egui::LayerId::background())
                .rect_filled(r, 0, BG);
        }
        self.poll_cook(ctx);
        self.poll_paper(ctx);
        self.poll_autosave(ctx);
        self.poll_nfcore_catalog(ctx);
        self.poll_system_profile(ctx);
        self.refresh_fq();
        let dropped: Vec<PathBuf> = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .filter_map(|f| f.path.clone())
                .collect()
        });
        let pairs = pair_dropped_fastqs(dropped.clone());
        let paired_paths: BTreeSet<PathBuf> = pairs
            .iter()
            .flat_map(|(r1, r2)| [r1.clone(), r2.clone()])
            .collect();
        for (index, (r1, r2)) in pairs.into_iter().enumerate() {
            self.ingest_paired_paths(
                r1,
                r2,
                self.last_graph_pos + Vec2::new(0.0, index as f32 * 140.0),
            );
        }
        for p in dropped {
            if !paired_paths.contains(&p) {
                self.ingest_path(p, self.last_graph_pos);
            }
        }
        let cooking = self.cook_rx.is_some();
        let t = ctx.input(|i| i.time);
        let all_node_ids = self
            .graph
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        let all_viewer_action =
            viewer_action(&self.viewer_off, all_node_ids.iter().map(String::as_str));

        let typing = ctx.wants_keyboard_input();
        if ctx.input(|input| input.modifiers.command && input.key_pressed(egui::Key::K)) {
            self.open_surface(Surface::Library);
            self.focus_library_search = true;
        }
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            self.close_surface();
            self.info = None;
            self.wire = None;
            self.marquee = None;
        }
        if self.overlays.is_open(Surface::OpCreate) && ctx.input(|i| i.key_pressed(egui::Key::Tab))
        {
            self.close_surface();
        }
        if !typing {
            ctx.input(|i| {
                if i.key_pressed(egui::Key::Delete) || i.key_pressed(egui::Key::Backspace) {
                    return true;
                }
                false
            })
            .then(|| self.delete_selected());
            if ctx.input(|i| i.key_pressed(egui::Key::Tab))
                && !self.overlays.is_open(Surface::OpCreate)
            {
                let screen = ctx.pointer_latest_pos().unwrap_or(self.cursor);
                self.open_op_create(self.last_graph_pos, screen, None);
            }
            if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::D)) {
                self.duplicate_selected();
            }
            if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::S)) {
                self.save_graph();
            }
            if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Z)) {
                let redo = ctx.input(|i| i.modifiers.shift);
                self.restore_history(redo);
            } else if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Y)) {
                self.restore_history(true);
            }
            if ctx.input(|i| i.key_pressed(egui::Key::F)) {
                self.request_fit();
            }
            if ctx.input(|i| {
                i.key_pressed(egui::Key::F5)
                    || (i.modifiers.ctrl && i.key_pressed(egui::Key::Enter))
            }) {
                self.cook();
            }
            if ctx.input(|i| i.key_pressed(egui::Key::P)) {
                self.toggle_surface(Surface::Paper);
            }
        }

        egui::TopBottomPanel::top("bar")
            .exact_height(50.0)
            .frame(Frame::new().fill(BG).inner_margin(Margin::symmetric(16, 9)))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    let (logo, _) = ui.allocate_exact_size(Vec2::splat(17.0), Sense::hover());
                    for offset in [
                        Vec2::new(4.5, 4.5),
                        Vec2::new(12.5, 4.5),
                        Vec2::new(4.5, 12.5),
                        Vec2::new(12.5, 12.5),
                    ] {
                        ui.painter().circle_filled(logo.min + offset, 2.6, ACCENT);
                    }
                    ui.add_space(5.0);
                    ui.add_sized(
                        Vec2::new(48.0, 22.0),
                        egui::Label::new(
                            egui::RichText::new("AXIAL").color(TEXT).strong().size(12.5),
                        ),
                    );
                    ui.add_space(12.0);
                    ui.label(egui::RichText::new("project1").color(MUTED).size(11.5));
                    if !self.paper_name.is_empty() {
                        ui.label(egui::RichText::new("/").color(MUTED).size(12.0));
                        let paper_name = ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new(&self.paper_name).color(TEXT).size(11.5),
                                )
                                .fill(Color32::TRANSPARENT)
                                .stroke(Stroke::NONE)
                                .frame(false),
                            )
                            .on_hover_text("Open the paper evidence report");
                        if paper_name.clicked() && self.paper_review.is_some() {
                            surface_activator_clicked = true;
                            self.toggle_surface(Surface::PaperReview);
                        }
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let cook_l = if cooking {
                            "  Cooking…  "
                        } else {
                            "  Cook  "
                        };
                        let fill = if cooking {
                            GRAPHITE.warning
                        } else {
                            GRAPHITE.accent_strong
                        };
                        let foreground = if cooking {
                            GRAPHITE.chrome
                        } else {
                            GRAPHITE.on_accent
                        };
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new(cook_l).color(foreground).strong(),
                                )
                                .fill(fill)
                                .stroke(Stroke::NONE)
                                .corner_radius(16),
                            )
                            .clicked()
                        {
                            self.cook();
                        }
                        if ui
                            .add(
                                egui::Button::new(egui::RichText::new("  Fit  ").color(TEXT))
                                    .fill(GRAPHITE.surface)
                                    .corner_radius(16),
                            )
                            .clicked()
                        {
                            self.request_fit();
                        }
                        let (viewer_label, viewer_tip) = match all_viewer_action {
                            Some(ViewerAction::Show) => {
                                ("  Show viewers  ", "Show previews on every node")
                            }
                            Some(ViewerAction::Hide) => {
                                ("  Hide viewers  ", "Hide previews on every node")
                            }
                            None => ("  Viewers  ", "Add a node to control its preview"),
                        };
                        if ui
                            .add_enabled(
                                all_viewer_action.is_some(),
                                egui::Button::new(egui::RichText::new(viewer_label).color(TEXT))
                                    .fill(GRAPHITE.surface)
                                    .corner_radius(16),
                            )
                            .on_hover_text(viewer_tip)
                            .clicked()
                        {
                            if let Some(action) = all_viewer_action {
                                apply_viewer_action(
                                    &mut self.viewer_off,
                                    all_node_ids.iter().map(String::as_str),
                                    action,
                                );
                                self.status = match action {
                                    ViewerAction::Show => {
                                        format!("showing all {} node viewers", all_node_ids.len())
                                    }
                                    ViewerAction::Hide => {
                                        format!("hid all {} node viewers", all_node_ids.len())
                                    }
                                };
                            }
                        }
                        if ui
                            .add(
                                egui::Button::new(egui::RichText::new("  Save  ").color(TEXT))
                                    .fill(GRAPHITE.surface)
                                    .corner_radius(16),
                            )
                            .clicked()
                        {
                            self.save_graph();
                        }
                    });
                });
            });

        let mut zoom_step = None;
        egui::TopBottomPanel::bottom("hint")
            .exact_height(24.0)
            .frame(Frame::new().fill(BG).inner_margin(Margin::symmetric(16, 3)))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new(if self.paper_rx.is_some() {
                            "reading paper…"
                        } else {
                            self.status.as_str()
                        })
                        .size(11.0)
                        .color(MUTED),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let zoom_button = |label: &str| {
                            egui::Button::new(egui::RichText::new(label).size(13.0).color(TEXT))
                                .fill(Color32::TRANSPARENT)
                                .stroke(Stroke::NONE)
                                .corner_radius(4)
                        };
                        if ui
                            .add_sized(Vec2::new(24.0, 18.0), zoom_button("+"))
                            .on_hover_text("Zoom in")
                            .clicked()
                        {
                            zoom_step = Some(1.15);
                        }
                        if ui
                            .add_sized(
                                Vec2::new(48.0, 18.0),
                                egui::Button::new(
                                    egui::RichText::new(format!("{:.0}%", self.zoom * 100.0))
                                        .size(10.5)
                                        .color(MUTED),
                                )
                                .fill(Color32::TRANSPARENT)
                                .stroke(Stroke::NONE),
                            )
                            .on_hover_text("Reset zoom to 100%")
                            .clicked()
                        {
                            zoom_step = Some(1.0 / self.zoom);
                        }
                        if ui
                            .add_sized(Vec2::new(24.0, 18.0), zoom_button("−"))
                            .on_hover_text("Zoom out")
                            .clicked()
                        {
                            zoom_step = Some(1.0 / 1.15);
                        }
                        if ui
                            .add_sized(
                                Vec2::new(76.0, 18.0),
                                egui::Button::new(egui::RichText::new("Machine").size(10.5).color(
                                    if self.overlays.is_open(Surface::Machine) {
                                        GRAPHITE.on_accent
                                    } else {
                                        MUTED
                                    },
                                ))
                                .fill(if self.overlays.is_open(Surface::Machine) {
                                    GRAPHITE.accent
                                } else {
                                    Color32::TRANSPARENT
                                })
                                .stroke(Stroke::NONE)
                                .corner_radius(4),
                            )
                            .on_hover_text("Show detected CPU, GPU, cores, threads, and memory")
                            .clicked()
                        {
                            surface_activator_clicked = true;
                            self.toggle_surface(Surface::Machine);
                        }
                    });
                });
            });

        if let Some(factor) = zoom_step {
            let canvas = ctx.available_rect();
            self.auto_fit = false;
            (self.pan, self.zoom) =
                zoom_about(self.pan, self.zoom, canvas.min, canvas.center(), factor);
        }

        egui::Area::new(Id::new("tool_rail"))
            .anchor(egui::Align2::LEFT_TOP, [14.0, 66.0])
            .show(ctx, |ui| {
                Frame::new()
                    .fill(GRAPHITE.surface)
                    .stroke(Stroke::new(1.0, GRAPHITE.border))
                    .inner_margin(Margin::same(5))
                    .corner_radius(22)
                    .show(ui, |ui| {
                        ui.vertical_centered(|ui| {
                            let add = ui
                                .add_sized(
                                    Vec2::splat(38.0),
                                    egui::Button::new(egui::RichText::new("+").size(22.0).color(
                                        if self.overlays.is_open(Surface::Library) {
                                            GRAPHITE.on_accent
                                        } else {
                                            TEXT
                                        },
                                    ))
                                    .fill(if self.overlays.is_open(Surface::Library) {
                                        GRAPHITE.accent
                                    } else {
                                        GRAPHITE.surface_raised
                                    })
                                    .stroke(Stroke::NONE)
                                    .corner_radius(19),
                                )
                                .on_hover_text("Open Library");
                            if add.clicked() {
                                surface_activator_clicked = true;
                                self.toggle_surface(Surface::Library);
                                if self.overlays.is_open(Surface::Library) {
                                    self.focus_library_search = true;
                                }
                            }
                            for (label, mode, tip) in [
                                ("/", PaletteMode::Build, "Search tools"),
                                ("ID", PaletteMode::Sources, "Add data source"),
                                ("nf", PaletteMode::Pipelines, "Find a workflow"),
                            ] {
                                let active = self.overlays.is_open(Surface::Library)
                                    && self.library.mode() == mode;
                                let response = ui
                                    .add_sized(
                                        Vec2::splat(38.0),
                                        egui::Button::new(
                                            egui::RichText::new(label)
                                                .size(if label.len() > 1 { 10.0 } else { 16.0 })
                                                .color(if active { ACCENT } else { MUTED }),
                                        )
                                        .fill(Color32::TRANSPARENT)
                                        .stroke(Stroke::NONE)
                                        .corner_radius(19),
                                    )
                                    .on_hover_text(tip);
                                if response.clicked() {
                                    surface_activator_clicked = true;
                                    self.open_surface(Surface::Library);
                                    if let Err(error) = self.library.set_mode(mode) {
                                        self.status =
                                            format!("Library state was not saved: {error}");
                                    }
                                    if mode == PaletteMode::Build {
                                        self.focus_library_search = true;
                                    } else if mode == PaletteMode::Sources {
                                        self.focus_accession = true;
                                    }
                                }
                            }
                            if ui
                                .add_sized(
                                    Vec2::splat(38.0),
                                    egui::Button::new(
                                        egui::RichText::new("P").size(11.0).color(MUTED),
                                    )
                                    .fill(Color32::TRANSPARENT)
                                    .stroke(Stroke::NONE)
                                    .corner_radius(19),
                                )
                                .on_hover_text("Rebuild from a paper")
                                .clicked()
                            {
                                surface_activator_clicked = true;
                                self.toggle_surface(Surface::Paper);
                            }
                        });
                    });
            });

        let mut pick_snakemake = false;
        if self.overlays.is_open(Surface::Library) {
            let library_response = egui::Window::new("library")
                .title_bar(false)
                .anchor(egui::Align2::LEFT_TOP, [68.0, 66.0])
                .default_width(332.0)
                .default_height(700.0)
                .resizable(true)
                .collapsible(false)
                .frame(
                    Frame::new()
                        .fill(PANEL)
                        .stroke(Stroke::new(1.0, GRAPHITE.border))
                        .inner_margin(Margin::ZERO)
                        .corner_radius(14),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(300.0);
                    let header = Rect::from_min_size(
                        ui.max_rect().min,
                        Vec2::new(ui.available_width(), 38.0),
                    );
                    ui.painter().rect_filled(
                        header,
                        CornerRadius::same(14),
                        GRAPHITE.surface_raised,
                    );
                    ui.add_space(9.0);
                    ui.horizontal(|ui| {
                        ui.add_space(12.0);
                        ui.label(
                            egui::RichText::new("Library")
                                .strong()
                                .size(13.0)
                                .color(TEXT),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.add_space(10.0);
                            if ui
                                .add(
                                    egui::Button::new(
                                        egui::RichText::new("×").size(15.0).color(MUTED),
                                    )
                                    .fill(Color32::TRANSPARENT)
                                    .stroke(Stroke::NONE),
                                )
                                .on_hover_text("Close Library")
                                .clicked()
                            {
                                self.close_surface();
                            }
                            ui.label(
                                egui::RichText::new(format!("{} tools", self.catalog.ops.len()))
                                    .size(10.0)
                                    .color(MUTED),
                            );
                        });
                    });
                    ui.add_space(11.0);

                    ui.horizontal(|ui| {
                        ui.add_space(10.0);
                        Frame::new()
                            .fill(GRAPHITE.control)
                            .stroke(Stroke::new(1.0, GRAPHITE.border))
                            .inner_margin(Margin::symmetric(8, 5))
                            .corner_radius(6)
                            .show(ui, |ui| {
                                let search_response = ui.add(
                                    egui::TextEdit::singleline(&mut self.search)
                                        .id(Id::new("palette_search"))
                                        .hint_text("Search everything…   Ctrl K")
                                        .desired_width((ui.available_width() - 12.0).max(100.0))
                                        .frame(false)
                                        .font(FontId::proportional(12.0)),
                                );
                                if self.focus_library_search {
                                    search_response.request_focus();
                                    self.focus_library_search = false;
                                }
                            });
                    });
                    ui.add_space(7.0);

                    ui.horizontal(|ui| {
                        ui.add_space(10.0);
                        let width = ((ui.available_width() - 12.0) / 3.0).max(58.0);
                        for mode in PaletteMode::ALL {
                            let selected = self.library.mode() == mode;
                            let response = ui.add_sized(
                                Vec2::new(width, 26.0),
                                egui::Button::new(
                                    egui::RichText::new(mode.label())
                                        .size(11.0)
                                        .color(if selected { TEXT } else { MUTED }),
                                )
                                .fill(if selected {
                                    GRAPHITE.surface_active
                                } else {
                                    Color32::TRANSPARENT
                                })
                                .corner_radius(5),
                            );
                            if response.clicked() {
                                if let Err(error) = self.library.set_mode(mode) {
                                    self.status = format!("Library state was not saved: {error}");
                                }
                                self.search.clear();
                            }
                        }
                    });
                    ui.add_space(6.0);
                    ui.separator();

                    let mut quick_drop: Option<Operator> = None;
                    if self.search.is_empty() && self.library.mode() == PaletteMode::Build {
                        ui.add_space(5.0);
                        ui.horizontal(|ui| {
                            ui.add_space(12.0);
                            ui.label(egui::RichText::new("QUICK ADD").size(9.5).color(MUTED));
                        });
                        ui.horizontal(|ui| {
                            ui.add_space(6.0);
                            ui.vertical(|ui| {
                                if draw_palette_action(
                                    ui,
                                    "+",
                                    "Import reads",
                                    "FASTQ, BAM, VCF or GTF",
                                    SELECT,
                                )
                                .clicked()
                                {
                                    quick_drop = self.catalog.get("files.import").ok().cloned();
                                }
                                if draw_palette_action(
                                    ui,
                                    "ID",
                                    "Add accession",
                                    "NCBI or Ensembl stable ID",
                                    SELECT,
                                )
                                .clicked()
                                {
                                    if let Err(error) = self.library.set_mode(PaletteMode::Sources)
                                    {
                                        self.status =
                                            format!("Library state was not saved: {error}");
                                    }
                                    self.focus_accession = true;
                                }
                                if draw_palette_action(
                                    ui,
                                    "nf",
                                    "Find a pipeline",
                                    &format!("{} released nf-core workflows", self.nfcore.len()),
                                    Color32::from_rgb(91, 174, 220),
                                )
                                .clicked()
                                {
                                    if let Err(error) =
                                        self.library.set_mode(PaletteMode::Pipelines)
                                    {
                                        self.status =
                                            format!("Library state was not saved: {error}");
                                    }
                                    ui.memory_mut(|memory| {
                                        memory.request_focus(Id::new("palette_search"));
                                    });
                                }
                            });
                        });
                        ui.add_space(2.0);
                    }

                    let mut add_accession = false;
                    if self.search.is_empty() && self.library.mode() == PaletteMode::Sources {
                        ui.add_space(7.0);
                        ui.horizontal(|ui| {
                            ui.add_space(12.0);
                            ui.label(egui::RichText::new("PUBLIC DATA").size(9.5).color(MUTED));
                        });
                        ui.add_space(2.0);
                        ui.horizontal_wrapped(|ui| {
                            ui.add_space(10.0);
                            for (label, ready, help) in [
                                (
                                    "SRA",
                                    self.source_tools.sra,
                                    "prefetch + fasterq-dump · axial-ncbi",
                                ),
                                (
                                    "Datasets",
                                    self.source_tools.datasets,
                                    "NCBI datasets CLI · axial-ncbi",
                                ),
                                (
                                    "Ensembl",
                                    self.source_tools.ensembl,
                                    "Ensembl REST through curl",
                                ),
                            ] {
                                ui.label(
                                    egui::RichText::new(format!(
                                        "{} {label}",
                                        if ready { "●" } else { "○" }
                                    ))
                                    .size(9.5)
                                    .color(if ready {
                                        SELECT
                                    } else {
                                        GRAPHITE.warning
                                    }),
                                )
                                .on_hover_text(if ready {
                                    format!("Ready · {help}")
                                } else {
                                    format!("Setup needed · {help}")
                                });
                            }
                        });
                        ui.add_space(3.0);
                        ui.horizontal(|ui| {
                            ui.add_space(10.0);
                            Frame::new()
                                .fill(GRAPHITE.control)
                                .stroke(Stroke::new(1.0, SELECT.gamma_multiply(0.45)))
                                .inner_margin(Margin::symmetric(9, 8))
                                .corner_radius(7)
                                .show(ui, |ui| {
                                    ui.set_width((ui.available_width() - 2.0).max(120.0));
                                    ui.label(
                                        egui::RichText::new("PASTE AN ACCESSION OR RECORD URL")
                                            .size(8.8)
                                            .color(MUTED),
                                    );
                                    let response = ui.add(
                                        egui::TextEdit::singleline(&mut self.accession)
                                            .id(Id::new("accession_entry"))
                                            .hint_text("SRR… · GCA_/GCF_… · ENSG/ENST/ENSP…")
                                            .desired_width(ui.available_width())
                                            .frame(false)
                                            .font(FontId::monospace(12.0)),
                                    );
                                    if self.focus_accession {
                                        response.request_focus();
                                        self.focus_accession = false;
                                    }
                                    let parsed = sources::classify(&self.accession);
                                    let valid = parsed.is_ok();
                                    if response.has_focus()
                                        && valid
                                        && ui.input(|input| input.key_pressed(egui::Key::Enter))
                                    {
                                        add_accession = true;
                                    }
                                    ui.add_space(3.0);
                                    match &parsed {
                                        Ok(request) => {
                                            ui.horizontal(|ui| {
                                                ui.label(
                                                    egui::RichText::new(request.provider())
                                                        .size(9.5)
                                                        .color(SELECT),
                                                );
                                                ui.label(
                                                    egui::RichText::new(&request.value)
                                                        .size(10.0)
                                                        .monospace()
                                                        .color(TEXT),
                                                );
                                            });
                                            ui.label(
                                                egui::RichText::new(request.result())
                                                    .size(9.5)
                                                    .color(MUTED),
                                            );
                                        }
                                        Err(error) if !self.accession.trim().is_empty() => {
                                            ui.label(
                                                egui::RichText::new(error)
                                                    .size(9.5)
                                                    .color(GRAPHITE.warning),
                                            );
                                        }
                                        Err(_) => {
                                            ui.label(
                                                egui::RichText::new(
                                                    "NCBI runs and assemblies · Ensembl stable IDs",
                                                )
                                                .size(9.5)
                                                .color(MUTED),
                                            );
                                        }
                                    }
                                    ui.add_space(4.0);
                                    let action = parsed
                                        .as_ref()
                                        .map(|request| request.action())
                                        .unwrap_or("Add source");
                                    if ui
                                        .add_enabled(
                                            valid,
                                            egui::Button::new(
                                                egui::RichText::new(action).size(11.0),
                                            )
                                            .fill(GRAPHITE.surface_active)
                                            .corner_radius(5)
                                            .min_size(Vec2::new(ui.available_width(), 26.0)),
                                        )
                                        .clicked()
                                    {
                                        add_accession = true;
                                    }
                                });
                        });
                        ui.add_space(5.0);
                    }

                    if self.search.is_empty() && self.library.mode() == PaletteMode::Pipelines {
                        ui.add_space(5.0);
                        ui.horizontal(|ui| {
                            ui.add_space(12.0);
                            ui.label(
                                egui::RichText::new("WORKFLOW ENGINES")
                                    .size(9.5)
                                    .color(MUTED),
                            );
                        });
                        ui.horizontal(|ui| {
                            ui.add_space(6.0);
                            if draw_palette_action(
                                ui,
                                "SM",
                                "Open Snakemake project",
                                "Snakefile → typed runnable graph",
                                Color32::from_rgb(84, 168, 111),
                            )
                            .clicked()
                            {
                                pick_snakemake = true;
                            }
                        });
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.add_space(12.0);
                            ui.label(
                                egui::RichText::new(format!(
                                    "NF-CORE CATALOG · {}",
                                    self.nfcore.len()
                                ))
                                .size(9.5)
                                .color(MUTED),
                            );
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.add_space(8.0);
                                    if ui
                                        .small_button("↻")
                                        .on_hover_text("Refresh the official nf-core catalog")
                                        .clicked()
                                    {
                                        self.refresh_nfcore_catalog();
                                    }
                                },
                            );
                        });
                    }

                    let sections = palette::sections(
                        self.library.mode(),
                        &self.catalog.ops,
                        &self.nfcore,
                        &self.search,
                        self.library.recent(),
                        self.library.favorites(),
                    );
                    let mut drop_click: Option<Operator> = None;
                    let mut toggle_favorite: Option<String> = None;
                    egui::ScrollArea::vertical()
                        .id_salt("palette_scroll")
                        .auto_shrink([false, false])
                        .max_height((ui.available_height() - 28.0).max(100.0))
                        .show(ui, |ui| {
                            ui.add_space(4.0);
                            for section in &sections {
                                egui::CollapsingHeader::new(
                                    egui::RichText::new(format!(
                                        "{}   {}",
                                        section.title.to_uppercase(),
                                        section.items.len()
                                    ))
                                    .size(9.5)
                                    .color(MUTED),
                                )
                                .default_open(section.open)
                                .show(ui, |ui| {
                                    for item in &section.items {
                                        let favorite = self.library.is_favorite(&item.operator.id);
                                        let drag = ui.dnd_drag_source(
                                            Id::new(("palette", item.operator.id.as_str())),
                                            item.operator.id.clone(),
                                            |ui| draw_palette_row(ui, item, favorite),
                                        );
                                        drag.response.clone().on_hover_ui(|ui| {
                                            palette_tooltip(
                                                ui,
                                                item,
                                                self.nfcore.get(&item.operator.id),
                                            );
                                        });
                                        if drag.inner.favorite_clicked {
                                            toggle_favorite = Some(item.operator.id.clone());
                                        } else if drag.inner.clicked {
                                            drop_click = Some(item.operator.clone());
                                        }
                                    }
                                });
                            }
                            if sections.iter().all(|section| section.items.is_empty()) {
                                ui.add_space(12.0);
                                ui.horizontal(|ui| {
                                    ui.add_space(12.0);
                                    ui.label(
                                        egui::RichText::new("No matching tools")
                                            .size(11.0)
                                            .color(MUTED)
                                            .italics(),
                                    );
                                });
                            }
                        });

                    if let Some(id) = toggle_favorite {
                        if let Err(error) = self.library.toggle_favorite(&id) {
                            self.status = format!("Library state was not saved: {error}");
                        }
                    }
                    if let Some(operator) = quick_drop.or(drop_click) {
                        self.drop_op(&operator, self.last_graph_pos);
                    }
                    if add_accession {
                        self.insert_accession();
                    }

                    ui.separator();
                    ui.horizontal(|ui| {
                        ui.add_space(12.0);
                        let favorite_count = self
                            .library
                            .favorites()
                            .iter()
                            .filter(|id| self.catalog.ops.contains_key(*id))
                            .count();
                        ui.label(
                            egui::RichText::new(format!("★ {favorite_count} favorites"))
                                .size(10.0)
                                .color(MUTED),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.add_space(10.0);
                            let (local, discovered) = palette::inventory_counts(&self.catalog.ops);
                            ui.label(
                                egui::RichText::new(format!("{local} local · {discovered} found"))
                                    .size(10.0)
                                    .color(MUTED),
                            );
                        });
                    });
                    ui.add_space(6.0);
                });
            let clicked_away =
                library_response.is_some_and(|response| response.response.clicked_elsewhere());
            self.overlays.dismiss_on_click_away(
                Surface::Library,
                surface_at_frame_start,
                clicked_away,
                surface_activator_clicked,
            );
        }

        if pick_snakemake {
            if let Some(path) = Self::pick_snakemake_directory() {
                self.insert_snakemake_project(path);
            }
        }

        let selected_id = self.selection.primary().map(str::to_owned);
        let selected_nodes = self
            .selection
            .nodes()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let selected_viewer_action =
            viewer_action(&self.viewer_off, selected_nodes.iter().map(String::as_str));
        let selected_viewer_state = {
            let hidden = selected_nodes
                .iter()
                .filter(|node| self.viewer_off.contains(node.as_str()))
                .count();
            if hidden == 0 {
                "on"
            } else if hidden == selected_nodes.len() {
                "off"
            } else {
                "mixed"
            }
        };
        if self.rename_target != selected_id {
            self.rename_target = selected_id.clone();
            self.rename_buffer = selected_id.clone().unwrap_or_default();
        }
        let mut rename_request: Option<(String, String)> = None;
        if selected_id.is_some() {
            egui::Window::new("params")
                .title_bar(false)
                .anchor(egui::Align2::RIGHT_TOP, [-16.0, 66.0])
                .default_width(326.0)
                .default_height(560.0)
                .resizable(true)
                .collapsible(false)
                .frame(
                    Frame::new()
                        .fill(GRAPHITE.surface)
                        .stroke(Stroke::new(1.0, GRAPHITE.border))
                        .inner_margin(Margin::ZERO)
                        .corner_radius(14),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(300.0);
                    if let Some(id) = &selected_id {
                        if let Some(nidx) = self.graph.nodes.iter().position(|n| n.id == *id) {
                            let op_id = self.graph.nodes[nidx].operator.clone();
                            let node_name = self.graph.nodes[nidx].id.clone();
                            let title = self
                                .catalog
                                .get(&op_id)
                                .map(|o| o.title.clone())
                                .unwrap_or_else(|_| op_id.clone());
                            Frame::new()
                                .fill(GRAPHITE.surface_raised)
                                .stroke(Stroke::new(1.0, GRAPHITE.border))
                                .inner_margin(Margin::symmetric(12, 10))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        let family = family_color(&op_id);
                                        let (mark, _) = ui.allocate_exact_size(
                                            Vec2::new(4.0, 20.0),
                                            Sense::hover(),
                                        );
                                        ui.painter().rect_filled(mark, 2, family);
                                        ui.vertical(|ui| {
                                            ui.label(
                                                egui::RichText::new(&title)
                                                    .size(12.0)
                                                    .strong()
                                                    .color(TEXT),
                                            );
                                            ui.label(
                                                egui::RichText::new(&op_id)
                                                    .size(9.5)
                                                    .monospace()
                                                    .color(MUTED),
                                            );
                                            if selected_nodes.len() > 1 {
                                                ui.label(
                                                    egui::RichText::new(format!(
                                                        "{} nodes selected",
                                                        selected_nodes.len()
                                                    ))
                                                    .size(9.5)
                                                    .color(ACCENT),
                                                );
                                            }
                                        });
                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                if ui
                                                    .add(
                                                        egui::Button::new(
                                                            egui::RichText::new("Cook")
                                                                .size(11.0)
                                                                .strong()
                                                                .color(GRAPHITE.on_accent),
                                                        )
                                                        .fill(GRAPHITE.accent_strong)
                                                        .stroke(Stroke::NONE)
                                                        .corner_radius(5),
                                                    )
                                                    .on_hover_text(
                                                        "Cook the graph with current parameters",
                                                    )
                                                    .clicked()
                                                {
                                                    self.cook();
                                                }
                                            },
                                        );
                                    });
                                    ui.add_space(7.0);
                                    ui.label(
                                        egui::RichText::new("NODE NAME").size(8.5).color(MUTED),
                                    );
                                    Frame::new()
                                        .fill(GRAPHITE.surface_sunken)
                                        .stroke(Stroke::new(1.0, GRAPHITE.border))
                                        .inner_margin(Margin::symmetric(8, 4))
                                        .corner_radius(5)
                                        .show(ui, |ui| {
                                            let rename = ui.add(
                                                egui::TextEdit::singleline(&mut self.rename_buffer)
                                                    .desired_width(ui.available_width())
                                                    .font(FontId::proportional(13.0))
                                                    .text_color(TEXT)
                                                    .frame(false)
                                                    .margin(Margin::ZERO),
                                            );
                                            if (rename.lost_focus()
                                                || (rename.has_focus()
                                                    && ui.input(|input| {
                                                        input.key_pressed(egui::Key::Enter)
                                                    })))
                                                && self.rename_buffer != node_name
                                            {
                                                rename_request = Some((
                                                    node_name.clone(),
                                                    self.rename_buffer.clone(),
                                                ));
                                            }
                                        });
                                });
                            ui.add_space(4.0);
                            if let Ok(op) = self.catalog.get(&op_id).cloned() {
                                let mut pages: Vec<String> = Vec::new();
                                for spec in op.params.values() {
                                    let p = spec.page.clone().unwrap_or_else(|| title.clone());
                                    if !pages.contains(&p) {
                                        pages.push(p);
                                    }
                                }
                                if !pages.iter().any(|p| p == "Common") {
                                    pages.push("Common".into());
                                }
                                if self.param_page.is_empty() || !pages.contains(&self.param_page) {
                                    self.param_page = pages[0].clone();
                                }
                                ui.horizontal(|ui| {
                                    ui.add_space(8.0);
                                    for p in &pages {
                                        let on = self.param_page == *p;
                                        let t = if on {
                                            egui::RichText::new(p).size(11.0).strong().color(ACCENT)
                                        } else {
                                            egui::RichText::new(p).size(11.0).color(MUTED)
                                        };
                                        let r = ui.add(
                                            egui::Button::new(t)
                                                .fill(Color32::TRANSPARENT)
                                                .stroke(Stroke::NONE)
                                                .frame(false),
                                        );
                                        if on {
                                            let u = r.rect;
                                            ui.painter().line_segment(
                                                [
                                                    Pos2::new(u.min.x, u.max.y - 1.0),
                                                    Pos2::new(u.max.x, u.max.y - 1.0),
                                                ],
                                                Stroke::new(2.0, ACCENT),
                                            );
                                        }
                                        if r.clicked() {
                                            self.param_page = p.clone();
                                        }
                                    }
                                });
                                ui.add_space(4.0);
                                ui.separator();
                                egui::ScrollArea::vertical().show(ui, |ui| {
                                    ui.add_space(10.0);
                                    if self.param_page == "Common" {
                                        common_page(ui, &op, selected_viewer_state);
                                        if let Some(note) = self.graph.nodes[nidx].note.clone() {
                                            ui.add_space(10.0);
                                            Frame::new()
                                                .inner_margin(Margin::symmetric(10, 4))
                                                .show(ui, |ui| {
                                                    ui.label(
                                                        egui::RichText::new(note)
                                                            .size(11.0)
                                                            .color(ACCENT)
                                                            .italics(),
                                                    );
                                                });
                                        }
                                        let viewer_label =
                                            match (selected_viewer_action, selected_nodes.len()) {
                                                (Some(ViewerAction::Show), 1) => {
                                                    "Show viewer".into()
                                                }
                                                (Some(ViewerAction::Hide), 1) => {
                                                    "Hide viewer".into()
                                                }
                                                (Some(ViewerAction::Show), count) => {
                                                    format!("Show {count} selected viewers")
                                                }
                                                (Some(ViewerAction::Hide), count) => {
                                                    format!("Hide {count} selected viewers")
                                                }
                                                (None, _) => "Viewer".into(),
                                            };
                                        if ui
                                            .add_enabled(
                                                selected_viewer_action.is_some(),
                                                egui::Button::new(viewer_label)
                                                    .fill(PANEL2)
                                                    .min_size(Vec2::new(180.0, 26.0)),
                                            )
                                            .clicked()
                                        {
                                            if let Some(action) = selected_viewer_action {
                                                apply_viewer_action(
                                                    &mut self.viewer_off,
                                                    selected_nodes.iter().map(String::as_str),
                                                    action,
                                                );
                                                self.status = match action {
                                                    ViewerAction::Show => format!(
                                                        "showing {} selected node viewer{}",
                                                        selected_nodes.len(),
                                                        if selected_nodes.len() == 1 {
                                                            ""
                                                        } else {
                                                            "s"
                                                        }
                                                    ),
                                                    ViewerAction::Hide => format!(
                                                        "hid {} selected node viewer{}",
                                                        selected_nodes.len(),
                                                        if selected_nodes.len() == 1 {
                                                            ""
                                                        } else {
                                                            "s"
                                                        }
                                                    ),
                                                };
                                            }
                                        }
                                    } else {
                                        let keys: Vec<String> = op
                                            .params
                                            .iter()
                                            .filter(|(_, s)| {
                                                s.page.clone().unwrap_or_else(|| title.clone())
                                                    == self.param_page
                                            })
                                            .map(|(k, _)| k.clone())
                                            .collect();
                                        if keys.is_empty() {
                                            ui.horizontal(|ui| {
                                                ui.add_space(10.0);
                                                ui.label(
                                                    egui::RichText::new(
                                                        "No parameters on this page.",
                                                    )
                                                    .color(MUTED)
                                                    .italics()
                                                    .size(11.0),
                                                );
                                            });
                                        }
                                        for k in keys {
                                            let spec = &op.params[&k];
                                            let label = spec.label.clone().unwrap_or(k.clone());
                                            let picker = path_picker_for(&op_id, &k);
                                            let (edit, previous) = {
                                                let node = &mut self.graph.nodes[nidx];
                                                let entry = node
                                                    .params
                                                    .entry(k.clone())
                                                    .or_insert_with(|| {
                                                        spec.default.clone().unwrap_or(
                                                            ParamValue::String(String::new()),
                                                        )
                                                    });
                                                let previous = entry.clone();
                                                let mut edit = param_row(
                                                    ui, &label, entry, spec.min, spec.max, picker,
                                                );
                                                if edit.browse_clicked {
                                                    let current = match entry {
                                                        ParamValue::String(path) => path.as_str(),
                                                        _ => "",
                                                    };
                                                    if let Some(path) = picker.and_then(|kind| {
                                                        Self::pick_source_path(kind, current)
                                                    }) {
                                                        *entry = ParamValue::String(
                                                            path.display().to_string(),
                                                        );
                                                        edit.began = true;
                                                        edit.changed = true;
                                                    }
                                                }
                                                (edit, previous)
                                            };
                                            if edit.began {
                                                let mut before = self.graph.clone();
                                                before.nodes[nidx]
                                                    .params
                                                    .insert(k.clone(), previous);
                                                self.history.remember(&before);
                                            }
                                            if edit.changed {
                                                self.invalidate_cook();
                                                self.status = format!("changed {node_name}.{k}");
                                            }
                                        }
                                    }
                                });
                            }
                        }
                    } else {
                        ui.add_space(12.0);
                        Frame::new()
                            .fill(GRAPHITE.surface_raised)
                            .stroke(Stroke::new(1.0, GRAPHITE.border))
                            .inner_margin(Margin::same(14))
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new("Parameters")
                                        .size(13.0)
                                        .strong()
                                        .color(TEXT),
                                );
                                ui.add_space(4.0);
                                ui.label(
                                egui::RichText::new(
                                    "Select a node to edit its tool settings and common controls.",
                                )
                                .size(11.0)
                                .color(MUTED),
                            );
                            });
                    }
                });
        }
        if let Some((old, requested)) = rename_request {
            self.commit_rename(&old, &requested);
        }

        egui::CentralPanel::default()
            .frame(Frame::new().fill(BG))
            .show(ctx, |ui| {
                let (resp, painter) =
                    ui.allocate_painter(ui.available_size(), Sense::click_and_drag());
                if self.auto_fit {
                    self.fit_view(resp.rect);
                }
                let origin = resp.rect.min;

                if let Some(payload) = resp.dnd_hover_payload::<String>() {
                    ui.ctx().set_cursor_icon(CursorIcon::Copy);
                    let _ = payload;
                }
                if let Some(op_id) = resp.dnd_release_payload::<String>() {
                    if let Ok(op) = self.catalog.get(op_id.as_str()).cloned() {
                        let gp = resp
                            .interact_pointer_pos()
                            .or_else(|| ctx.pointer_latest_pos())
                            .map(|p| self.to_graph(origin, p))
                            .unwrap_or(self.last_graph_pos);
                        self.drop_op(&op, gp);
                    }
                }

                let space_down = ui.input(|i| i.key_down(egui::Key::Space));
                if resp.hovered() {
                    let (zoom_delta, pan_delta) =
                        ui.input(|i| (i.zoom_delta(), i.smooth_scroll_delta));
                    if (zoom_delta - 1.0).abs() > f32::EPSILON {
                        self.auto_fit = false;
                        if let Some(ptr) = resp.hover_pos() {
                            (self.pan, self.zoom) =
                                zoom_about(self.pan, self.zoom, origin, ptr, zoom_delta);
                        }
                    }
                    if pan_delta != Vec2::ZERO {
                        self.auto_fit = false;
                        self.pan += pan_delta;
                    }
                    let panning = resp.dragged_by(egui::PointerButton::Middle)
                        || resp.dragged_by(egui::PointerButton::Secondary)
                        || (space_down && resp.dragged_by(egui::PointerButton::Primary));
                    ui.ctx().set_cursor_icon(if self.wire.is_some() {
                        CursorIcon::Crosshair
                    } else if panning {
                        CursorIcon::Grabbing
                    } else if space_down {
                        CursorIcon::Grab
                    } else {
                        CursorIcon::Default
                    });
                }
                let panning = resp.dragged_by(egui::PointerButton::Middle)
                    || resp.dragged_by(egui::PointerButton::Secondary)
                    || (space_down && resp.dragged_by(egui::PointerButton::Primary));
                if panning {
                    self.auto_fit = false;
                    self.pan += resp.drag_delta();
                }

                draw_grid(&painter, resp.rect, self.pan, self.zoom);
                draw_snap_guides(
                    &painter,
                    resp.rect,
                    origin,
                    self.pan,
                    self.zoom,
                    self.snap_guides,
                );

                if let Some(pos) = ctx.pointer_latest_pos() {
                    self.cursor = pos;
                    if resp.rect.contains(pos) {
                        self.last_graph_pos = self.to_graph(origin, pos);
                    }
                }

                let hovered_edge = resp.hover_pos().and_then(|pointer| {
                    self.graph
                        .edges
                        .iter()
                        .filter_map(|edge| {
                            let from = self.graph.node(&edge.from_node)?;
                            let to = self.graph.node(&edge.to_node)?;
                            let output = from.port(&edge.from_port, Direction::Out)?;
                            let input = to.port(&edge.to_port, Direction::In)?;
                            let distance = bezier_distance(
                                self.port_pos(origin, from, output),
                                self.port_pos(origin, to, input),
                                pointer,
                            );
                            (distance <= 9.0).then_some((distance, edge.id.clone()))
                        })
                        .min_by(|left, right| left.0.total_cmp(&right.0))
                        .map(|(_, id)| id)
                });

                for e in &self.graph.edges {
                    let Some(a) = self.graph.node(&e.from_node) else {
                        continue;
                    };
                    let Some(b) = self.graph.node(&e.to_node) else {
                        continue;
                    };
                    let Some(ap) = a.port(&e.from_port, Direction::Out) else {
                        continue;
                    };
                    let Some(bp) = b.port(&e.to_port, Direction::In) else {
                        continue;
                    };
                    let p0 = self.port_pos(origin, a, ap);
                    let p1 = self.port_pos(origin, b, bp);
                    if !bezier_bounds(p0, p1).expand(16.0).intersects(resp.rect) {
                        continue;
                    }
                    let failed =
                        matches!(self.last_states.get(&e.from_node), Some(NodeState::Failed));
                    let col = if failed {
                        GRAPHITE.danger
                    } else {
                        port_color(ap.ty)
                    };
                    let emphasized = self.selection.edge() == Some(e.id.as_str())
                        || hovered_edge.as_deref() == Some(e.id.as_str());
                    bezier(&painter, p0, p1, col, cooking, emphasized, t);
                }

                self.hover_port = None;
                let mut hit_port: Option<WireStart> = None;
                let mut hit_continue: Option<(WireStart, Pos2)> = None;
                let mut hit_node: Option<String> = None;
                let mut hit_flag: Option<String> = None;
                let mut hit_resize: Option<String> = None;
                let mut info_hit: Option<String> = None;
                let mut snap_cursor = self.cursor;

                let src_ty: Option<(PortType, Vec<PortType>, bool)> =
                    self.wire.as_ref().and_then(|wire| {
                        let n = self.graph.node(&wire.node)?;
                        let p = n.port(&wire.port, wire.dir)?;
                        Some((p.ty, p.union.clone(), wire.dir == Direction::Out))
                    });

                let visible = resp.rect.expand(48.0);
                let nodes: Vec<Node> = self
                    .graph
                    .nodes
                    .iter()
                    .filter(|node| self.node_rect(origin, node).intersects(visible))
                    .cloned()
                    .collect();
                let mut quote_tip: Option<(Pos2, String)> = None;
                for n in &nodes {
                    let r = self.node_rect(origin, n);
                    let sel = self.selection.contains(&n.id);
                    let z = self.zoom;
                    let hovered = resp.hover_pos().map(|p| r.contains(p)).unwrap_or(false);

                    painter.rect_filled(
                        r.translate(Vec2::new(0.0, 5.0 * z)),
                        CornerRadius::same(12),
                        Color32::from_rgba_unmultiplied(0, 0, 0, 96),
                    );
                    painter.rect_filled(r, CornerRadius::same(12), NODE);

                    let operator_title = self
                        .catalog
                        .get(&n.operator)
                        .map(|operator| operator.title.as_str())
                        .unwrap_or(n.operator.as_str());
                    let title_at = Pos2::new(r.min.x, r.min.y - 19.0 * z);
                    painter.circle_filled(
                        title_at + Vec2::new(4.0 * z, 7.0 * z),
                        2.5 * z,
                        family_color(&n.operator),
                    );
                    draw_label(
                        &painter,
                        title_at + Vec2::new(11.0 * z, 0.0),
                        egui::Align2::LEFT_TOP,
                        operator_title,
                        font_px(11.0, z, 8.0, 12.0),
                        if sel { TEXT } else { MUTED },
                        Rect::from_min_size(
                            title_at + Vec2::new(11.0 * z, 0.0),
                            Vec2::new((r.width() - 11.0 * z).max(20.0), 16.0 * z),
                        ),
                    );

                    let viewer_on = !self.viewer_off.contains(&n.id);
                    if viewer_on {
                        let body = r.shrink(4.0 * z);
                        painter.rect_filled(body, 9, GRAPHITE.surface_sunken);
                        let fq = self.fq_for(&n.id);
                        let clip = painter.with_clip_rect(body);
                        draw_viewer(&clip, body, n, fq, self.last_states.get(&n.id), z);
                    } else {
                        let inner = r.shrink2(Vec2::new(12.0 * z, 9.0 * z));
                        let inputs = n
                            .ports
                            .iter()
                            .filter(|port| port.dir == Direction::In)
                            .count();
                        let outputs = n.ports.len().saturating_sub(inputs);
                        draw_label(
                            &painter,
                            inner.min,
                            egui::Align2::LEFT_TOP,
                            if is_workflow_operator(&n.operator) {
                                "Required inputs"
                            } else {
                                operator_title
                            },
                            font_px(10.5, z, 8.0, 11.0),
                            TEXT,
                            inner,
                        );
                        draw_label(
                            &painter,
                            inner.min + Vec2::new(0.0, 21.0 * z),
                            egui::Align2::LEFT_TOP,
                            &format!("{inputs} inputs  ·  {outputs} outputs"),
                            font_px(9.0, z, 7.0, 10.0),
                            MUTED,
                            inner,
                        );
                    }

                    // cook LED
                    let led = match self.last_states.get(&n.id) {
                        Some(NodeState::Done) => GRAPHITE.success,
                        Some(NodeState::Cached) => GRAPHITE.accent,
                        Some(NodeState::Failed) => GRAPHITE.danger,
                        Some(NodeState::Skipped) => GRAPHITE.text_muted,
                        _ if cooking => GRAPHITE.warning,
                        _ => GRAPHITE.border,
                    };
                    painter.circle_filled(r.max - Vec2::new(7.0 * z, 7.0 * z), 3.0 * z, led);

                    let stroke = if sel {
                        Stroke::new(1.8, SELECT)
                    } else if hovered {
                        Stroke::new(1.0, GRAPHITE.border_strong)
                    } else {
                        Stroke::new(1.0, GRAPHITE.border)
                    };
                    painter.rect_stroke(r, 12, stroke, egui::StrokeKind::Outside);

                    // name under — clipped to node width so it never rides into a neighbor
                    if viewer_on {
                        let name_h = (14.0 * z).clamp(12.0, 18.0);
                        let name_r = Rect::from_min_size(
                            Pos2::new(r.min.x, r.max.y + NAME_GAP * z),
                            Vec2::new(r.width(), name_h),
                        );
                        let name_col = if sel { SELECT } else { TEXT };
                        draw_label(
                            &painter,
                            Pos2::new(r.center().x, name_r.min.y),
                            egui::Align2::CENTER_TOP,
                            &n.id,
                            font_px(11.0, z, 8.0, 12.0),
                            name_col,
                            name_r,
                        );
                    }

                    if hovered {
                        if let Some(note) = n.note.as_deref().filter(|s| !s.is_empty()) {
                            quote_tip = Some((Pos2::new(r.max.x + 8.0, r.min.y), note.to_string()));
                        }
                    }

                    // viewer flag (bottom-left)
                    let flag = Rect::from_min_size(
                        Pos2::new(r.min.x + 1.0 * z, r.max.y - 9.0 * z),
                        Vec2::splat(8.0 * z),
                    );
                    painter.rect_filled(
                        flag,
                        0,
                        if viewer_on {
                            GRAPHITE.success
                        } else {
                            GRAPHITE.border
                        },
                    );
                    painter.rect_stroke(
                        flag,
                        0,
                        Stroke::new(1.0, GRAPHITE.chrome),
                        egui::StrokeKind::Inside,
                    );

                    // resize handle
                    if viewer_on && sel {
                        let hz = Rect::from_min_size(
                            r.max - Vec2::new(10.0 * z, 10.0 * z),
                            Vec2::splat(10.0 * z),
                        );
                        painter.line_segment(
                            [Pos2::new(hz.min.x, hz.max.y), hz.max],
                            Stroke::new(1.0, MUTED),
                        );
                        if let Some(pos) = resp.hover_pos() {
                            if hz.contains(pos) {
                                hit_resize = Some(n.id.clone());
                                ui.ctx().set_cursor_icon(CursorIcon::ResizeNwSe);
                            }
                        }
                    }

                    if let Some(pos) = resp.interact_pointer_pos().or_else(|| resp.hover_pos()) {
                        if flag.contains(pos) {
                            hit_flag = Some(n.id.clone());
                        }
                    }

                    for p in &n.ports {
                        let c = self.port_pos(origin, n, p);
                        let rad = 4.6 * z;
                        let col = port_color(p.ty);
                        let mut ring = None;
                        if let Some((ty, union, is_out)) = &src_ty {
                            let ok = if *is_out && p.dir == Direction::In {
                                compatible(*ty, p.ty, &p.union)
                            } else if !*is_out && p.dir == Direction::Out {
                                compatible(p.ty, *ty, union)
                            } else {
                                false
                            };
                            if ok {
                                ring = Some(SELECT);
                                if c.distance(self.cursor) < 18.0 * z {
                                    snap_cursor = c;
                                }
                            } else if p.dir
                                != if *is_out {
                                    Direction::Out
                                } else {
                                    Direction::In
                                }
                            {
                                ring = Some(Color32::from_rgb(160, 50, 50));
                            }
                        }
                        painter.circle_filled(c, rad, col);
                        painter.circle_stroke(
                            c,
                            rad,
                            Stroke::new(1.0, Color32::from_rgb(16, 16, 18)),
                        );
                        if let Some(rc) = ring {
                            painter.circle_stroke(c, rad + 2.5 * z, Stroke::new(1.6, rc));
                        }
                        let hit_r = Rect::from_center_size(c, Vec2::splat(16.0 * z));
                        if let Some(pos) = resp.hover_pos().or_else(|| resp.interact_pointer_pos())
                        {
                            if hit_r.contains(pos) {
                                painter.circle_stroke(c, rad + 2.0, Stroke::new(1.4, SELECT));
                                self.hover_port = Some((
                                    n.id.clone(),
                                    p.name.clone(),
                                    p.ty,
                                    p.dir == Direction::Out,
                                ));
                                if resp.drag_started() && ui.input(|i| i.pointer.primary_down()) {
                                    hit_port = Some(WireStart::new(&n.id, &p.name, p.dir));
                                }
                            }
                        }
                        if p.dir == Direction::Out {
                            let continue_at = c + Vec2::new(17.0 * z, 0.0);
                            let continue_rect = Rect::from_center_size(
                                continue_at,
                                Vec2::splat((16.0 * z).max(12.0)),
                            );
                            let continue_hovered = resp
                                .hover_pos()
                                .or_else(|| resp.interact_pointer_pos())
                                .is_some_and(|pos| continue_rect.contains(pos));
                            if hovered || sel || continue_hovered {
                                painter.circle_filled(
                                    continue_at,
                                    7.0 * z,
                                    if continue_hovered {
                                        GRAPHITE.accent
                                    } else {
                                        GRAPHITE.surface_raised
                                    },
                                );
                                painter.circle_stroke(
                                    continue_at,
                                    7.0 * z,
                                    Stroke::new(1.0, GRAPHITE.border_strong),
                                );
                                painter.text(
                                    continue_at,
                                    egui::Align2::CENTER_CENTER,
                                    "+",
                                    font_px(11.0, z, 8.0, 12.0),
                                    if continue_hovered {
                                        GRAPHITE.on_accent
                                    } else {
                                        TEXT
                                    },
                                );
                            }
                            if continue_hovered {
                                hit_continue = Some((
                                    WireStart::new(&n.id, &p.name, Direction::Out),
                                    continue_at,
                                ));
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                        }
                    }

                    if resp.clicked() {
                        if let Some(pos) = resp.interact_pointer_pos() {
                            let name_r = Rect::from_center_size(
                                Pos2::new(r.center().x, r.max.y + 9.0 * z),
                                Vec2::new(r.width(), 16.0 * z),
                            );
                            if (r.contains(pos) || name_r.contains(pos))
                                && hit_port.is_none()
                                && hit_continue.is_none()
                                && hit_flag.is_none()
                            {
                                hit_node = Some(n.id.clone());
                            }
                        }
                    }
                    if resp.middle_clicked() {
                        if let Some(pos) = resp.interact_pointer_pos() {
                            if r.contains(pos) {
                                info_hit = Some(n.id.clone());
                            }
                        }
                    }
                }

                if resp.clicked() {
                    if let Some((wire, screen_pos)) = hit_continue.clone() {
                        let graph_pos =
                            self.to_graph(origin, screen_pos + Vec2::new(86.0 * self.zoom, 0.0));
                        self.open_op_create(graph_pos, screen_pos, Some(wire));
                    }
                }

                if let Some(wire) = &self.wire {
                    if let Some(n) = self.graph.node(&wire.node) {
                        if let Some(p) = n.port(&wire.port, wire.dir) {
                            let p0 = self.port_pos(origin, n, p);
                            bezier(&painter, p0, snap_cursor, SELECT, true, true, t);
                        }
                    }
                }

                if let Some((nid, pname, ty, is_out)) = &self.hover_port {
                    let dir = if *is_out { "out" } else { "in" };
                    let label = format!("{nid}.{pname}  {dir}  {}", type_name(*ty));
                    let pos = self.cursor + Vec2::new(12.0, 8.0);
                    let galley = painter.layout_no_wrap(label, FontId::proportional(11.0), TEXT);
                    let rr = Rect::from_min_size(pos, galley.size() + Vec2::new(8.0, 4.0));
                    painter.rect_filled(rr, 2, Color32::from_rgb(20, 20, 24));
                    painter.galley(pos + Vec2::new(4.0, 2.0), galley, TEXT);
                } else if let Some((at, note)) = quote_tip {
                    draw_quote_tip(&painter, at, &note, resp.rect);
                }

                if resp.drag_started() && ui.input(|i| i.pointer.primary_down()) && !space_down {
                    if let Some(hp) = hit_port.clone() {
                        self.wire = Some(hp);
                        self.dragging = None;
                        self.marquee = None;
                    } else if let Some(id) = &hit_resize {
                        self.history.remember(&self.graph);
                        self.resizing = Some(id.clone());
                        self.marquee = None;
                    } else if let Some(pos) = resp.interact_pointer_pos() {
                        let hit = nodes
                            .iter()
                            .rev()
                            .find(|n| self.node_rect(origin, n).contains(pos));
                        if let Some(n) = hit {
                            if hit_flag.is_none() {
                                let mode = ui.input(|input| selection_mode(input.modifiers));
                                if mode != SelectionMode::Replace || !self.selection.contains(&n.id)
                                {
                                    self.selection.select_node(&n.id, mode);
                                }
                                self.history.remember(&self.graph);
                                self.dragging = self.selection.contains(&n.id).then(|| NodeDrag {
                                    anchor: n.id.clone(),
                                    start: self
                                        .graph
                                        .nodes
                                        .iter()
                                        .filter(|node| self.selection.contains(&node.id))
                                        .map(|node| {
                                            (
                                                node.id.clone(),
                                                Pos2::new(node.layout.x, node.layout.y),
                                            )
                                        })
                                        .collect(),
                                    accumulated: Vec2::ZERO,
                                });
                                self.snap_guides = SnapGuides::default();
                                self.marquee = None;
                                self.param_page.clear();
                            }
                        } else {
                            self.marquee = Some(Marquee {
                                start: pos,
                                current: pos,
                                mode: ui.input(|input| selection_mode(input.modifiers)),
                            });
                        }
                    }
                }
                if resp.dragged()
                    && ui.input(|i| i.pointer.primary_down())
                    && !space_down
                    && self.wire.is_none()
                {
                    let d = ui.input(|input| input.pointer.delta()) / self.zoom;
                    if let Some(id) = &self.resizing.clone() {
                        let sz = self
                            .sizes
                            .entry(id.clone())
                            .or_insert(Vec2::new(NODE_W, NODE_H));
                        sz.x = (sz.x + d.x).clamp(90.0, 360.0);
                        sz.y = (sz.y + d.y).clamp(56.0, 280.0);
                    } else if let Some(mut drag) = self.dragging.clone() {
                        drag.accumulated =
                            advance_drag_delta(drag.accumulated, resp.drag_delta() / self.zoom);
                        let raw_delta = drag.accumulated;
                        self.dragging = Some(drag.clone());
                        let snapping_disabled = ui.input(|input| input.modifiers.alt);
                        let snapped = if snapping_disabled {
                            None
                        } else {
                            let anchor = self.graph.node(&drag.anchor).and_then(|node| {
                                let start = drag.start.get(&drag.anchor)?;
                                Some(Rect::from_min_size(*start, self.node_size(node)))
                            });
                            anchor.map(|anchor| {
                                let stationary = self
                                    .graph
                                    .nodes
                                    .iter()
                                    .filter(|node| !drag.start.contains_key(&node.id))
                                    .map(|node| {
                                        Rect::from_min_size(
                                            Pos2::new(node.layout.x, node.layout.y),
                                            self.node_size(node),
                                        )
                                    })
                                    .collect::<Vec<_>>();
                                snap_drag(
                                    anchor,
                                    raw_delta,
                                    &stationary,
                                    9.0 / self.zoom,
                                    6.0 / self.zoom,
                                )
                            })
                        };
                        let delta = snapped.map_or(raw_delta, |snap| snap.delta);
                        self.snap_guides =
                            snapped.map_or_else(SnapGuides::default, |snap| snap.guides);
                        for node in &mut self.graph.nodes {
                            if let Some(start) = drag.start.get(&node.id) {
                                node.layout.x = start.x + delta.x;
                                node.layout.y = start.y + delta.y;
                            }
                        }
                    } else if let Some(marquee) = &mut self.marquee {
                        if let Some(pos) = resp.interact_pointer_pos() {
                            marquee.current = pos;
                        }
                    }
                }
                if let Some(marquee) = self.marquee {
                    let rect = marquee.rect().intersect(resp.rect);
                    painter.rect_filled(rect, 0, SELECT.gamma_multiply(0.08));
                    painter.rect_stroke(
                        rect,
                        0,
                        Stroke::new(1.0, SELECT.gamma_multiply(0.85)),
                        egui::StrokeKind::Inside,
                    );
                }
                if resp.drag_stopped() {
                    let moved_nodes = self.dragging.is_some();
                    if let Some(wire) = self.wire.clone() {
                        if let Some(pos) = ctx.pointer_latest_pos() {
                            let target = nodes
                                .iter()
                                .flat_map(|node| {
                                    node.ports.iter().filter_map(|port| {
                                        let distance =
                                            self.port_pos(origin, node, port).distance(pos);
                                        let connection =
                                            wire.connection_to(&self.graph, &node.id, port)?;
                                        (distance < 18.0 * self.zoom)
                                            .then_some((distance, connection))
                                    })
                                })
                                .min_by(|a, b| a.0.total_cmp(&b.0));
                            if let Some((_, connection)) = target {
                                self.try_wire(connection);
                            } else if resp.rect.contains(pos) {
                                let graph_pos = self.to_graph(origin, pos);
                                self.open_op_create(graph_pos, pos, Some(wire));
                            }
                        }
                    }
                    if let Some(marquee) = self.marquee.take() {
                        let rect = marquee.rect();
                        let ids = self
                            .graph
                            .nodes
                            .iter()
                            .filter(|node| self.node_rect(origin, node).intersects(rect))
                            .map(|node| node.id.clone())
                            .collect::<Vec<_>>();
                        self.selection.select_many(ids, marquee.mode);
                        self.param_page.clear();
                        self.status = format!(
                            "selected {} node{}",
                            self.selection.len(),
                            if self.selection.len() == 1 { "" } else { "s" }
                        );
                    }
                    self.wire = None;
                    self.dragging = None;
                    self.snap_guides = SnapGuides::default();
                    self.resizing = None;
                    if moved_nodes {
                        self.autosave_due = Some(Instant::now());
                    }
                }
                if let Some(id) = hit_node.clone() {
                    let mode = ui.input(|input| selection_mode(input.modifiers));
                    self.selection.select_node(id, mode);
                    self.param_page.clear();
                }
                if resp.clicked()
                    && hit_node.is_none()
                    && hit_port.is_none()
                    && hit_continue.is_none()
                    && hit_flag.is_none()
                {
                    if let Some(pos) = resp.interact_pointer_pos() {
                        let on_node = nodes
                            .iter()
                            .any(|n| self.node_rect(origin, n).contains(pos));
                        if !on_node {
                            if let Some(edge) = hovered_edge.clone() {
                                self.selection.select_edge(edge);
                                self.status = "selected wire  ·  Delete removes it".into();
                            } else if selection_mode(ui.input(|input| input.modifiers))
                                == SelectionMode::Replace
                            {
                                self.selection.clear();
                            }
                            self.last_graph_pos = self.to_graph(origin, pos);
                        }
                    }
                }
                if let Some(id) = hit_flag {
                    if resp.clicked() && !self.viewer_off.remove(&id) {
                        self.viewer_off.insert(id);
                    }
                }
                if let Some(id) = info_hit {
                    self.info = Some(id);
                }
                if resp.double_clicked() {
                    if let Some(pos) = resp.interact_pointer_pos() {
                        let on_node = nodes
                            .iter()
                            .any(|n| self.node_rect(origin, n).contains(pos));
                        if !on_node {
                            self.open_op_create(self.to_graph(origin, pos), pos, None);
                        }
                    }
                }
            });

        if self.graph.nodes.is_empty() && !self.overlays.is_open(Surface::OpCreate) {
            egui::Area::new(Id::new("empty_canvas_actions"))
                .anchor(egui::Align2::CENTER_CENTER, [0.0, -18.0])
                .show(ctx, |ui| {
                    ui.vertical_centered(|ui| {
                        ui.label(
                            egui::RichText::new("Build a biological workflow")
                                .size(18.0)
                                .strong()
                                .color(TEXT),
                        );
                        ui.add_space(5.0);
                        ui.label(
                            egui::RichText::new(
                                "Start with data, continue from any output, and keep the canvas visible.",
                            )
                            .size(11.5)
                            .color(MUTED),
                        );
                        ui.add_space(12.0);
                        ui.horizontal(|ui| {
                            let action = |label: &str| {
                                egui::Button::new(
                                    egui::RichText::new(label).size(11.0).color(TEXT),
                                )
                                .fill(GRAPHITE.surface)
                                .stroke(Stroke::new(1.0, GRAPHITE.border))
                                .corner_radius(16)
                            };
                            if ui.add(action("  Import reads  ")).clicked() {
                                if let Ok(operator) = self.catalog.get("files.import").cloned() {
                                    self.drop_op(&operator, self.last_graph_pos);
                                }
                            }
                            if ui.add(action("  Add accession  ")).clicked() {
                                self.open_surface(Surface::Library);
                                if let Err(error) = self.library.set_mode(PaletteMode::Sources) {
                                    self.status = format!("Library state was not saved: {error}");
                                }
                                self.focus_accession = true;
                            }
                            if ui.add(action("  Find pipeline  ")).clicked() {
                                self.open_surface(Surface::Library);
                                if let Err(error) = self.library.set_mode(PaletteMode::Pipelines) {
                                    self.status = format!("Library state was not saved: {error}");
                                }
                            }
                            if ui.add(action("  Open Snakemake  ")).clicked() {
                                if let Some(path) = Self::pick_snakemake_directory() {
                                    self.insert_snakemake_project(path);
                                }
                            }
                        });
                        ui.add_space(10.0);
                        ui.label(
                            egui::RichText::new("Double-click anywhere or press Tab to add a node")
                                .size(10.0)
                                .color(MUTED),
                        );
                    });
                });
        }

        if self.overlays.is_open(Surface::Machine) {
            let mut refresh_profile = false;
            let machine_response = egui::Window::new("machine_profile")
                .title_bar(false)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::RIGHT_BOTTOM, [-16.0, -36.0])
                .frame(
                    Frame::new()
                        .fill(GRAPHITE.surface_raised)
                        .stroke(Stroke::new(1.0, GRAPHITE.border_strong))
                        .inner_margin(Margin::same(14))
                        .corner_radius(10),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(310.0);
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new("This machine")
                                    .size(13.0)
                                    .strong()
                                    .color(TEXT),
                            );
                            ui.label(
                                egui::RichText::new("Auto-detected · used to guide local runs")
                                    .size(9.5)
                                    .color(MUTED),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui
                                .add(
                                    egui::Button::new(
                                        egui::RichText::new("Refresh").size(10.0).color(MUTED),
                                    )
                                    .fill(Color32::TRANSPARENT)
                                    .stroke(Stroke::NONE),
                                )
                                .clicked()
                            {
                                refresh_profile = true;
                            }
                        });
                    });
                    ui.add_space(8.0);
                    ui.separator();
                    ui.add_space(6.0);
                    if let Some(profile) = &self.system_profile {
                        machine_profile_row(ui, "CPU", &profile.cpu);
                        machine_profile_row(
                            ui,
                            "TOPOLOGY",
                            &format!(
                                "{} physical cores · {} logical threads",
                                profile.physical_cores, profile.logical_threads
                            ),
                        );
                        machine_profile_row(
                            ui,
                            "MEMORY",
                            &system_profile::format_memory(profile.memory_bytes),
                        );
                        machine_profile_row(
                            ui,
                            "GPU",
                            &if profile.gpus.is_empty() {
                                "No display adapter reported".into()
                            } else {
                                profile.gpus.join("\n")
                            },
                        );
                        machine_profile_row(ui, "SYSTEM", &profile.os);
                    } else if self.system_profile_rx.is_some() {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label(
                                egui::RichText::new("Detecting hardware…")
                                    .size(11.0)
                                    .color(MUTED),
                            );
                        });
                    } else {
                        ui.label(
                            egui::RichText::new("Hardware detection was unavailable.")
                                .size(11.0)
                                .color(MUTED),
                        );
                    }
                });
            let clicked_away =
                machine_response.is_some_and(|response| response.response.clicked_elsewhere());
            self.overlays.dismiss_on_click_away(
                Surface::Machine,
                surface_at_frame_start,
                clicked_away,
                surface_activator_clicked,
            );
            if refresh_profile {
                self.refresh_system_profile();
            }
        }

        if self.overlays.is_open(Surface::PaperReview) {
            let mut close_review = false;
            let mut selected_evidence: Option<EvidenceTarget> = None;
            let mut switch_candidate = None;
            if let Some(review) = self.paper_review.clone() {
                let Some(candidate) = review.candidates.get(review.active) else {
                    self.close_surface_if(Surface::PaperReview);
                    return;
                };
                let explicit = candidate
                    .evidence
                    .iter()
                    .filter(|record| record.status == EvidenceStatus::Explicit)
                    .count();
                let inferred = candidate
                    .evidence
                    .iter()
                    .filter(|record| record.status == EvidenceStatus::Inferred)
                    .count();
                let missing = candidate
                    .evidence
                    .iter()
                    .filter(|record| record.status == EvidenceStatus::MissingImplementation)
                    .count();
                let review_response = egui::Window::new("paper_review")
                    .title_bar(false)
                    .anchor(egui::Align2::LEFT_TOP, [68.0, 66.0])
                    .default_width(350.0)
                    .default_height(560.0)
                    .resizable(true)
                    .collapsible(false)
                    .frame(
                        Frame::new()
                            .fill(GRAPHITE.surface)
                            .stroke(Stroke::new(1.0, GRAPHITE.border_strong))
                            .inner_margin(Margin::same(12))
                            .corner_radius(12),
                    )
                    .show(ctx, |ui| {
                        ui.set_min_width(320.0);
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.label(
                                    egui::RichText::new("Paper reconstruction")
                                        .size(13.0)
                                        .strong()
                                        .color(TEXT),
                                );
                                ui.label(
                                    egui::RichText::new(format!(
                                        "{} · {:?}",
                                        review.name, candidate.assay
                                    ))
                                    .size(9.5)
                                    .color(MUTED),
                                );
                            });
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                egui::RichText::new("×").size(15.0).color(MUTED),
                                            )
                                            .fill(Color32::TRANSPARENT)
                                            .stroke(Stroke::NONE),
                                        )
                                        .clicked()
                                    {
                                        close_review = true;
                                    }
                                },
                            );
                        });
                        ui.add_space(7.0);
                        if review.candidates.len() > 1 {
                            ui.horizontal(|ui| {
                                ui.label(
                                    egui::RichText::new("CANDIDATE GRAPH")
                                        .size(8.5)
                                        .color(MUTED),
                                );
                                egui::ComboBox::from_id_salt("paper_candidate_graph")
                                    .selected_text(
                                        egui::RichText::new(&candidate.name)
                                            .size(10.0)
                                            .color(TEXT),
                                    )
                                    .width(205.0)
                                    .show_ui(ui, |ui| {
                                        for (index, option) in
                                            review.candidates.iter().enumerate()
                                        {
                                            let label = format!(
                                                "{} · {}",
                                                candidate_role_label(option.role),
                                                option.name
                                            );
                                            if ui
                                                .selectable_label(index == review.active, label)
                                                .clicked()
                                            {
                                                switch_candidate = Some(index);
                                            }
                                        }
                                    });
                            });
                            ui.add_space(4.0);
                            ui.add(
                                egui::Label::new(
                                    egui::RichText::new(match candidate.role {
                                        CandidateRole::Parallel => {
                                            "A separately reported method track; it is not wired into its siblings."
                                        }
                                        CandidateRole::Alternative => {
                                            "A mutually exclusive or compared method; only this Candidate Graph is on the canvas."
                                        }
                                        CandidateRole::Primary => {
                                            "The primary interpretation selected for this paper."
                                        }
                                    })
                                    .size(9.0)
                                    .color(MUTED),
                                )
                                .wrap(),
                            );
                            ui.add_space(5.0);
                        }
                        ui.horizontal_wrapped(|ui| {
                            evidence_count_chip(ui, explicit, "paper", GRAPHITE.success);
                            evidence_count_chip(ui, inferred, "inferred", GRAPHITE.warning);
                            evidence_count_chip(ui, missing, "missing", GRAPHITE.danger);
                        });
                        if !candidate.warnings.is_empty() {
                            ui.add_space(7.0);
                            Frame::new()
                                .fill(GRAPHITE.warning.gamma_multiply(0.10))
                                .stroke(Stroke::new(1.0, GRAPHITE.warning.gamma_multiply(0.45)))
                                .inner_margin(Margin::symmetric(9, 7))
                                .corner_radius(6)
                                .show(ui, |ui| {
                                    for warning in &candidate.warnings {
                                        ui.add(
                                            egui::Label::new(
                                                egui::RichText::new(warning)
                                                    .size(10.0)
                                                    .color(GRAPHITE.warning),
                                            )
                                            .wrap(),
                                        );
                                    }
                                });
                        }
                        ui.add_space(7.0);
                        ui.separator();
                        egui::ScrollArea::vertical()
                            .id_salt("paper_evidence_scroll")
                            .max_height((ui.available_height() - 10.0).max(180.0))
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new("CANVAS NODES").size(8.5).color(MUTED),
                                );
                                ui.add_space(4.0);
                                for record in candidate.evidence.iter().filter(|record| {
                                    matches!(record.target, EvidenceTarget::Node(_))
                                }) {
                                    let id = record.target.id();
                                    let title = self
                                        .graph
                                        .node(id)
                                        .and_then(|node| self.catalog.get(&node.operator).ok())
                                        .map(|operator| operator.title.as_str())
                                        .unwrap_or(id);
                                    let (status, color) = evidence_status_style(record.status);
                                    Frame::new()
                                        .fill(GRAPHITE.surface_raised)
                                        .stroke(Stroke::new(1.0, GRAPHITE.border))
                                        .inner_margin(Margin::symmetric(9, 7))
                                        .corner_radius(6)
                                        .show(ui, |ui| {
                                            ui.horizontal(|ui| {
                                                if ui
                                                    .add(
                                                        egui::Button::new(
                                                            egui::RichText::new(title)
                                                                .size(10.5)
                                                                .strong()
                                                                .color(TEXT),
                                                        )
                                                        .fill(Color32::TRANSPARENT)
                                                        .stroke(Stroke::NONE)
                                                        .frame(false),
                                                    )
                                                    .on_hover_text("Select this node on the canvas")
                                                    .clicked()
                                                {
                                                    selected_evidence = Some(record.target.clone());
                                                }
                                                ui.with_layout(
                                                    egui::Layout::right_to_left(
                                                        egui::Align::Center,
                                                    ),
                                                    |ui| {
                                                        ui.label(
                                                            egui::RichText::new(status)
                                                                .size(8.5)
                                                                .color(color),
                                                        );
                                                    },
                                                );
                                            });
                                            ui.add(
                                                egui::Label::new(
                                                    egui::RichText::new(&record.detail)
                                                        .size(9.5)
                                                        .color(MUTED),
                                                )
                                                .wrap(),
                                            );
                                        });
                                    ui.add_space(4.0);
                                }
                                let edge_records = candidate
                                    .evidence
                                    .iter()
                                    .filter(|record| {
                                        matches!(record.target, EvidenceTarget::Edge(_))
                                    })
                                    .collect::<Vec<_>>();
                                if !edge_records.is_empty() {
                                    egui::CollapsingHeader::new(
                                        egui::RichText::new(format!(
                                            "INFERRED CONNECTIONS   {}",
                                            edge_records.len()
                                        ))
                                        .size(8.5)
                                        .color(GRAPHITE.warning),
                                    )
                                    .default_open(false)
                                    .show(ui, |ui| {
                                        for record in edge_records {
                                            if ui
                                                .add(
                                                    egui::Button::new(
                                                        egui::RichText::new(&record.detail)
                                                            .size(9.0)
                                                            .color(MUTED),
                                                    )
                                                    .fill(Color32::TRANSPARENT)
                                                    .stroke(Stroke::NONE)
                                                    .wrap(),
                                                )
                                                .on_hover_text("Select this inferred connection")
                                                .clicked()
                                            {
                                                selected_evidence = Some(record.target.clone());
                                            }
                                        }
                                    });
                                }
                            });
                    });
                let clicked_away =
                    review_response.is_some_and(|response| response.response.clicked_elsewhere());
                self.overlays.dismiss_on_click_away(
                    Surface::PaperReview,
                    surface_at_frame_start,
                    clicked_away,
                    surface_activator_clicked,
                );
            }
            if close_review {
                self.close_surface_if(Surface::PaperReview);
            }
            if let Some(target) = selected_evidence {
                match target {
                    EvidenceTarget::Node(id) => {
                        self.selection.select_node(id, SelectionMode::Replace);
                        self.param_page.clear();
                    }
                    EvidenceTarget::Edge(id) => self.selection.select_edge(id),
                }
            }
            if let Some(index) = switch_candidate {
                self.switch_paper_candidate(index);
            }
        }

        if self.overlays.is_open(Surface::Paper) {
            let mut load_example = false;
            let mut pick = false;
            let paper_response = egui::Window::new("paper")
                .title_bar(false)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, -30.0])
                .frame(
                    Frame::new()
                        .fill(GRAPHITE.surface_raised)
                        .stroke(Stroke::new(1.0, ACCENT.gamma_multiply(0.7)))
                        .inner_margin(Margin::same(14))
                        .corner_radius(4),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(360.0);
                    ui.label(egui::RichText::new("Rebuild from a paper").size(14.0).strong());
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("Drop a PDF or methods .txt on the canvas, or pick one. Axial maps tools it has and leaves honest gaps for the rest.")
                            .size(11.0)
                            .color(MUTED),
                    );
                    ui.add_space(10.0);
                    if ui
                        .add(
                            egui::Button::new(
                                egui::RichText::new("  Example: RNA-seq methods  ")
                                    .color(GRAPHITE.on_accent),
                            )
                            .fill(GRAPHITE.accent_strong)
                            .min_size(Vec2::new(340.0, 28.0)),
                        )
                        .clicked()
                    {
                        load_example = true;
                    }
                    ui.add_space(6.0);
                    if ui
                        .add(
                            egui::Button::new("  Choose PDF / .txt…  ")
                                .fill(PANEL2)
                                .min_size(Vec2::new(340.0, 26.0)),
                        )
                        .clicked()
                    {
                        pick = true;
                    }
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new("Click outside, P, or esc to close")
                            .size(10.0)
                            .color(MUTED),
                    );
                });
            let clicked_away =
                paper_response.is_some_and(|response| response.response.clicked_elsewhere());
            self.overlays.dismiss_on_click_away(
                Surface::Paper,
                surface_at_frame_start,
                clicked_away,
                surface_activator_clicked,
            );
            if load_example {
                self.ingest_path(Self::example_paper(), self.last_graph_pos);
            }
            if pick {
                if let Some(p) = Self::pick_paper_file() {
                    self.ingest_path(p, self.last_graph_pos);
                }
            }
        }

        if self.overlays.is_open(Surface::OpCreate) {
            let ops = self.filtered_ops(&self.op_create_q);
            let inserting = self.pending_insert.is_some();
            if self.op_create_i >= ops.len() && !ops.is_empty() {
                self.op_create_i = ops.len() - 1;
            }
            let op_create_response = egui::Window::new("opcreate")
                .title_bar(false)
                .resizable(false)
                .collapsible(false)
                .fixed_pos(self.op_create_screen)
                .frame(
                    Frame::new()
                        .fill(GRAPHITE.surface_raised)
                        .stroke(Stroke::new(1.0, ACCENT.gamma_multiply(0.6)))
                        .inner_margin(Margin::same(10))
                        .corner_radius(4),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(320.0);
                    ui.label(
                        egui::RichText::new(if inserting {
                            "Continue with"
                        } else {
                            "Add a node"
                        })
                        .size(11.0)
                        .color(MUTED),
                    );
                    let te = ui.add(
                        egui::TextEdit::singleline(&mut self.op_create_q)
                            .hint_text(if inserting {
                                "Search compatible next steps"
                            } else {
                                "Search nodes and workflows"
                            })
                            .desired_width(300.0)
                            .font(FontId::proportional(14.0)),
                    );
                    if self.focus_op_create {
                        te.request_focus();
                        self.focus_op_create = false;
                    }
                    if ui.input(|i| i.key_pressed(egui::Key::ArrowDown)) {
                        self.op_create_i = (self.op_create_i + 1).min(ops.len().saturating_sub(1));
                    }
                    if ui.input(|i| i.key_pressed(egui::Key::ArrowUp)) {
                        self.op_create_i = self.op_create_i.saturating_sub(1);
                    }
                    ui.add_space(4.0);
                    let mut chosen: Option<Operator> = None;
                    egui::ScrollArea::vertical()
                        .max_height(260.0)
                        .show(ui, |ui| {
                            if ops.is_empty() {
                                ui.label(
                                    egui::RichText::new(if inserting {
                                        "No compatible operators match."
                                    } else {
                                        "No operators match."
                                    })
                                    .size(12.0)
                                    .color(MUTED)
                                    .italics(),
                                );
                            }
                            for (i, op) in ops.iter().enumerate() {
                                let on = i == self.op_create_i;
                                let fill = if on {
                                    GRAPHITE.surface_active
                                } else {
                                    Color32::TRANSPARENT
                                };
                                let r = ui.add(
                                    egui::Button::new(
                                        egui::RichText::new(format!(
                                            "  {}    {}",
                                            op.title,
                                            op.palette.join(" / ")
                                        ))
                                        .color(if on { TEXT } else { MUTED })
                                        .size(13.0),
                                    )
                                    .fill(fill)
                                    .min_size(Vec2::new(300.0, 22.0)),
                                );
                                let strip = Rect::from_min_size(
                                    r.rect.min,
                                    Vec2::new(3.0, r.rect.height()),
                                );
                                ui.painter().rect_filled(strip, 0, family_color(&op.id));
                                if r.clicked() {
                                    chosen = Some(op.clone());
                                }
                            }
                        });
                    if ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                        if let Some(op) = ops.get(self.op_create_i) {
                            chosen = Some(op.clone());
                        }
                    }
                    if let Some(op) = chosen {
                        let pos = self.last_graph_pos;
                        self.drop_op(&op, pos);
                    }
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("enter to place  ·  esc/tab to close")
                            .size(10.0)
                            .color(MUTED),
                    );
                });
            let clicked_away =
                op_create_response.is_some_and(|response| response.response.clicked_elsewhere());
            if self.overlays.dismiss_on_click_away(
                Surface::OpCreate,
                surface_at_frame_start,
                clicked_away,
                false,
            ) {
                self.pending_insert = None;
            }
        }

        if let Some(id) = self.info.clone() {
            if let Some(n) = self.graph.node(&id).cloned() {
                egui::Window::new("nodeinfo")
                    .title_bar(false)
                    .resizable(false)
                    .anchor(egui::Align2::CENTER_TOP, [0.0, 48.0])
                    .frame(
                        Frame::new()
                            .fill(GRAPHITE.surface_raised)
                            .stroke(Stroke::new(1.0, GRAPHITE.border_strong))
                            .inner_margin(Margin::same(10))
                            .corner_radius(3),
                    )
                    .show(ctx, |ui| {
                        ui.set_min_width(240.0);
                        ui.label(egui::RichText::new(&n.id).strong().size(14.0));
                        ui.label(
                            egui::RichText::new(&n.operator)
                                .size(11.0)
                                .color(MUTED)
                                .monospace(),
                        );
                        let st = match self.last_states.get(&n.id) {
                            Some(NodeState::Done) => "done",
                            Some(NodeState::Cached) => "cached",
                            Some(NodeState::Failed) => "failed",
                            Some(NodeState::Skipped) => "skipped",
                            None => "idle",
                        };
                        ui.label(
                            egui::RichText::new(format!("cook  {st}"))
                                .size(11.0)
                                .color(MUTED),
                        );
                        if let Some(note) = &n.note {
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new(note).size(11.0).color(ACCENT).italics());
                        }
                        ui.separator();
                        for p in &n.ports {
                            let d = if p.dir == Direction::In { "in " } else { "out" };
                            ui.label(
                                egui::RichText::new(format!(
                                    "{d}  {}  {}",
                                    p.name,
                                    type_name(p.ty)
                                ))
                                .size(11.0)
                                .color(port_color(p.ty)),
                            );
                        }
                        if ui.button("close").clicked() {
                            self.info = None;
                        }
                    });
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct ParamEdit {
    began: bool,
    changed: bool,
    browse_clicked: bool,
}

fn param_row(
    ui: &mut egui::Ui,
    label: &str,
    entry: &mut ParamValue,
    min: Option<i64>,
    max: Option<i64>,
    picker: Option<PathPicker>,
) -> ParamEdit {
    let edit = ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.add_sized(
            Vec2::new(84.0, 24.0),
            egui::Label::new(egui::RichText::new(label).color(MUTED).size(11.0))
                .halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        let mut browse_clicked = false;
        let response = match entry {
            ParamValue::String(s) => {
                let response = ui.add(
                    egui::TextEdit::singleline(s)
                        .desired_width(
                            ui.available_width() - if picker.is_some() { 76.0 } else { 8.0 },
                        )
                        .font(FontId::proportional(12.0))
                        .text_color(TEXT)
                        .background_color(GRAPHITE.control),
                );
                if picker.is_some()
                    && ui
                        .add(
                            egui::Button::new(
                                egui::RichText::new("Browse…").size(10.0).color(TEXT),
                            )
                            .fill(GRAPHITE.surface_raised)
                            .stroke(Stroke::new(1.0, GRAPHITE.border))
                            .corner_radius(5),
                        )
                        .clicked()
                {
                    browse_clicked = true;
                }
                response
            }
            ParamValue::Int(i) => {
                let mut dv = egui::DragValue::new(i).speed(1.0);
                if let Some(a) = min {
                    dv = dv.range(a..=max.unwrap_or(i64::MAX));
                }
                ui.add(dv)
            }
            ParamValue::Float(f) => ui.add(egui::DragValue::new(f).speed(0.01)),
            ParamValue::Bool(b) => ui.checkbox(b, ""),
        };
        ParamEdit {
            began: response.gained_focus() || response.drag_started() || response.clicked(),
            changed: response.changed(),
            browse_clicked,
        }
    });
    ui.add_space(5.0);
    edit.inner
}

fn common_page(ui: &mut egui::Ui, op: &Operator, viewer_state: &str) {
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.add_sized(
            Vec2::new(84.0, 24.0),
            egui::Label::new(egui::RichText::new("operator").color(MUTED).size(11.0))
                .halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new(&op.id)
                .size(11.0)
                .monospace()
                .color(TEXT),
        );
    });
    ui.add_space(5.0);
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.add_sized(
            Vec2::new(84.0, 24.0),
            egui::Label::new(egui::RichText::new("cost").color(MUTED).size(11.0))
                .halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        let (cost, color) = match op.cost {
            Cost::Low => ("low", GRAPHITE.success),
            Cost::High => ("high · explicit Cook", GRAPHITE.warning),
        };
        ui.label(egui::RichText::new(cost).size(11.0).color(color));
    });
    ui.add_space(5.0);
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.add_sized(
            Vec2::new(84.0, 24.0),
            egui::Label::new(egui::RichText::new("viewer").color(MUTED).size(11.0))
                .halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new(viewer_state)
                .size(11.0)
                .color(match viewer_state {
                    "on" => GRAPHITE.success,
                    "mixed" => GRAPHITE.warning,
                    _ => MUTED,
                }),
        );
    });
    if let Some(c) = &op.conda {
        ui.add_space(10.0);
        Frame::new()
            .fill(GRAPHITE.surface_raised)
            .stroke(Stroke::new(1.0, GRAPHITE.border))
            .inner_margin(Margin::symmetric(10, 7))
            .corner_radius(5)
            .show(ui, |ui| {
                ui.label(egui::RichText::new("ENVIRONMENT").size(8.5).color(MUTED));
                ui.label(
                    egui::RichText::new(&c.name)
                        .size(11.0)
                        .monospace()
                        .color(TEXT),
                );
                ui.label(egui::RichText::new(c.spec.join(" ")).size(9.5).color(MUTED));
            });
    }
}

fn main() -> eframe::Result<()> {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([900.0, 560.0])
            .with_title("Axial")
            .with_app_id("axial")
            .with_transparent(false)
            .with_drag_and_drop(true),
        ..Default::default()
    };
    eframe::run_native(
        "Axial",
        opts,
        Box::new(|cc| {
            install_fonts(&cc.egui_ctx);
            Ok(Box::new(App::new()))
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_increment() {
        assert_eq!(next_op_name(&[], "qc.fastqc"), "fastqc1");
        assert_eq!(
            next_op_name(&["fastqc1".into(), "fastqc2".into()], "qc.fastqc"),
            "fastqc3"
        );
        assert_eq!(next_op_name(&["import1".into()], "files.import"), "import2");
    }

    #[test]
    fn dropped_fastq_mates_are_recognized_as_a_pair() {
        let r1 = PathBuf::from("/reads/sample_S1_L001_R1_001.fastq.gz");
        let r2 = PathBuf::from("/reads/sample_S1_L001_R2_001.fastq.gz");

        assert_eq!(
            paired_fastq_key(&r1),
            Some(("sample_s1_l001__001.fastq.gz".into(), 1))
        );
        assert_eq!(
            paired_fastq_key(&r2),
            Some(("sample_s1_l001__001.fastq.gz".into(), 2))
        );
        assert_eq!(
            pair_dropped_fastqs(vec![r2.clone(), r1.clone()]),
            vec![(r1, r2)]
        );
    }

    #[test]
    fn source_path_pickers_match_import_parameters() {
        assert_eq!(
            path_picker_for("files.import", "path"),
            Some(PathPicker::File)
        );
        assert_eq!(
            path_picker_for("files.import_paired", "r1"),
            Some(PathPicker::File)
        );
        assert_eq!(
            path_picker_for("files.import_paired", "r2"),
            Some(PathPicker::File)
        );
        assert_eq!(
            path_picker_for("files.import_directory", "path"),
            Some(PathPicker::Directory)
        );
        assert_eq!(path_picker_for("align.star", "genome"), None);
    }

    #[test]
    fn workflow_operators_use_compact_cards() {
        assert!(is_workflow_operator("nfcore.rnaseq"));
        assert!(is_workflow_operator("workflow.snakemake"));
        assert!(is_workflow_operator("runner.nextflow"));
        assert!(!is_workflow_operator("qc.fastqc"));
    }

    #[test]
    fn parse_tiny_fastq() {
        let s = "@s\nACGT\n+\nIIII\n@t\nGGGG\n+\nHHHH\n";
        let fq = parse_fastq(s).unwrap();
        assert_eq!(fq.n_reads, 2);
        assert_eq!(fq.len, 4);
        assert_eq!(fq.seq, b"ACGT");
        assert_eq!(fq.qual, b"IIII");
    }

    #[test]
    fn parse_empty() {
        assert!(parse_fastq("nope").is_none());
    }

    #[test]
    fn wire_hit_testing_follows_the_curve() {
        let from = Pos2::new(0.0, 0.0);
        let to = Pos2::new(160.0, 80.0);
        let on_curve = bezier_points(from, to)[14];

        assert!(bezier_distance(from, to, on_curve) < 0.01);
        assert!(bezier_distance(from, to, Pos2::new(80.0, 180.0)) > 40.0);
    }

    #[test]
    fn mixed_viewer_selection_resolves_to_hide_every_selected_viewer() {
        let mut viewer_off = BTreeSet::from(["b".to_owned()]);
        let selected = ["a", "b"];

        let action = viewer_action(&viewer_off, selected).unwrap();
        assert_eq!(action, ViewerAction::Hide);
        apply_viewer_action(&mut viewer_off, selected, action);

        assert!(selected.iter().all(|node| viewer_off.contains(*node)));
    }

    #[test]
    fn an_all_hidden_selection_toggles_back_on_together() {
        let mut viewer_off = BTreeSet::from(["a".to_owned(), "b".to_owned()]);
        let selected = ["a", "b"];

        let action = viewer_action(&viewer_off, selected).unwrap();
        assert_eq!(action, ViewerAction::Show);
        apply_viewer_action(&mut viewer_off, selected, action);

        assert!(selected.iter().all(|node| !viewer_off.contains(*node)));
    }
}
