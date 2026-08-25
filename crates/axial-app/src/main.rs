//! TouchDesigner-shaped Axial: palette | network | parameter pages.
//!
//! Nodes are viewers. Names sit under the body. Ports snap. Tab / double-click
//! opens OP Create. Palette drags onto the grid.

mod canvas;
mod nfcore_catalog;
mod palette;
mod sources;

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
use axial_ir::{compatible, Direction, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION};
use axial_ops::{Catalog, Cost, Operator};
use axial_paper::{extract_from_path, reconstruct, text_from_path, ExtractVia, Reconstruction};
use canvas::{
    connect, rename_node, zoom_about, Connection, EditHistory, Selection, SelectionMode, WireStart,
};
use eframe::egui::{
    self, Color32, CornerRadius, CursorIcon, FontData, FontDefinitions, FontFamily, FontId, Frame,
    Id, Margin, Pos2, Rect, Sense, Stroke, Vec2,
};
use nfcore_catalog::Pipeline as NfcorePipeline;
use palette::Mode as PaletteMode;
use sources::AccessionKind;

const BG: Color32 = Color32::from_rgb(27, 28, 33);
const GRID: Color32 = Color32::from_rgb(40, 41, 48);
const GRID_MAJ: Color32 = Color32::from_rgb(51, 52, 61);
const PANEL: Color32 = Color32::from_rgb(32, 33, 40);
const PANEL2: Color32 = Color32::from_rgb(44, 45, 54);
const BAR: Color32 = Color32::from_rgb(23, 24, 30);
const NODE: Color32 = Color32::from_rgb(25, 26, 32);
const SELECT: Color32 = Color32::from_rgb(80, 210, 140);
const TEXT: Color32 = Color32::from_rgb(235, 233, 229);
const MUTED: Color32 = Color32::from_rgb(157, 155, 163);
const ACCENT: Color32 = Color32::from_rgb(184, 151, 218);
const HEADER_FG: Color32 = Color32::from_rgb(42, 28, 50);

const NODE_W: f32 = 148.0;
const NODE_H: f32 = 92.0;
const NODE_H_FLAT: f32 = 22.0;
const STRIP: f32 = 7.0;
const NAME_GAP: f32 = 4.0;

#[derive(Clone, Copy)]
struct Marquee {
    start: Pos2,
    current: Pos2,
    mode: SelectionMode,
}

impl Marquee {
    fn rect(self) -> Rect {
        Rect::from_two_pos(self.start, self.current)
    }
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
        if painter.layout_no_wrap(t.clone(), font.clone(), TEXT).size().x <= max_w {
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
    painter.with_clip_rect(clip).text(pos, anchor, s, font, color);
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
    } else if op_id.starts_with("class.")
        || op_id.starts_with("var.")
        || op_id.starts_with("nf.")
    {
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
    op_create: bool,
    op_create_screen: Pos2,
    op_create_q: String,
    op_create_i: usize,
    viewer_off: BTreeSet<String>,
    sizes: BTreeMap<String, Vec2>,
    fq: BTreeMap<String, FqPreview>,
    dragging: Option<String>,
    resizing: Option<String>,
    marquee: Option<Marquee>,
    info: Option<String>,
    cook_rx: Option<Receiver<Result<CookReport, String>>>,
    cook_started: Option<Instant>,
    hover_port: Option<(String, String, PortType, bool)>,
    last_arts: BTreeMap<String, BTreeMap<String, ArtifactMeta>>,
    paper_rx: Option<Receiver<Result<Reconstruction, String>>>,
    paper_name: String,
    paper_ui: bool,
    auto_fit: bool,
    history: EditHistory,
    rename_target: Option<String>,
    rename_buffer: String,
    graph_path: Option<PathBuf>,
    autosave_due: Option<Instant>,
    nfcore: BTreeMap<String, NfcorePipeline>,
    nfcore_rx: Option<Receiver<nfcore_catalog::FetchResult>>,
    accession: String,
    palette_mode: PaletteMode,
    recent_ops: Vec<String>,
    favorite_ops: BTreeSet<String>,
    focus_accession: bool,
}

impl App {
    fn new() -> Self {
        let catalog = Catalog::load_dir(&operators_dir()).unwrap_or_default();
        let graph_path = project_root().join("testdata/fastq_to_fastqc.axial.json");
        let default_graph: Graph = fs::read_to_string(&graph_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Graph {
                schema_version: SCHEMA_VERSION,
                nodes: vec![],
                edges: vec![],
            });
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
            op_create: false,
            op_create_screen: Pos2::new(420.0, 260.0),
            op_create_q: String::new(),
            op_create_i: 0,
            viewer_off: BTreeSet::new(),
            sizes: BTreeMap::new(),
            fq: BTreeMap::new(),
            dragging: None,
            resizing: None,
            marquee: None,
            info: None,
            cook_rx: None,
            cook_started: None,
            hover_port: None,
            last_arts: BTreeMap::new(),
            paper_rx: None,
            paper_name: String::new(),
            paper_ui: false,
            auto_fit: false,
            history: EditHistory::default(),
            rename_target: None,
            rename_buffer: String::new(),
            graph_path: None,
            autosave_due: None,
            nfcore: BTreeMap::new(),
            nfcore_rx: None,
            accession: String::new(),
            palette_mode: PaletteMode::Build,
            recent_ops: Vec::new(),
            favorite_ops: BTreeSet::new(),
            focus_accession: false,
        };
        app.load_nfcore_cache();
        app.refresh_nfcore_catalog();
        if let Ok(p) = env::var("AXIAL_OPEN") {
            if let Ok(text) = text_from_path(Path::new(&p)) {
                let r = reconstruct(&app.catalog, &text);
                let n = r.graph.nodes.len();
                app.graph = r.graph;
                app.graph_path = None;
                app.autosave_due = Some(Instant::now());
                app.selection.clear();
                if let Some(node) = app.graph.nodes.first() {
                    app.selection
                        .select_node(&node.id, SelectionMode::Replace);
                }
                app.paper_name = Path::new(&p)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("paper")
                    .to_string();
                app.request_fit();
                app.status = format!("rebuilt {n} nodes from {} ({:?})", app.paper_name, r.assay);
            } else {
                app.open_paper(PathBuf::from(p));
            }
        }
        app
    }

    fn open_paper(&mut self, path: PathBuf) {
        self.ingest_path(path, self.last_graph_pos);
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
        self.op_create = true;
        self.op_create_q.clear();
        self.op_create_i = 0;
        self.pending_insert = wire;
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
        let current: BTreeSet<String> = pipelines
            .iter()
            .map(NfcorePipeline::operator_id)
            .collect();
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
        self.recent_ops.retain(|id| id != &op.id);
        self.recent_ops.insert(0, op.id.clone());
        self.recent_ops.truncate(8);
        self.history.remember(&before);
        self.selection
            .select_node(&id, SelectionMode::Replace);
        self.param_page.clear();
        self.invalidate_cook();
        self.status = format!("dropped {id}");
        if let Some(wire) = pending {
            let connection = self.graph.node(&id).and_then(|node| {
                node.ports
                    .iter()
                    .find_map(|port| wire.connection_to(&self.graph, &id, port))
            });
            if let Some(connection) = connection {
                if connect(&mut self.graph, &connection).is_ok() {
                    self.status = format!("inserted {id} and snapped");
                }
            }
        }
        self.op_create = false;
        self.op_create_q.clear();
    }

    fn insert_accession(&mut self) {
        let (kind, accession) = match sources::classify(&self.accession) {
            Ok(value) => value,
            Err(error) => {
                self.status = error;
                return;
            }
        };
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
                if let Some(node) = self.graph.nodes.iter_mut().find(|node| node.id == prefetch_id) {
                    node.params
                        .insert("accession".into(), ParamValue::String(accession.clone()));
                }
                self.drop_op(&fasterq, pos + Vec2::new(210.0, 0.0));
                let Some(fasterq_id) = self.selection.primary().map(str::to_owned) else {
                    return;
                };
                self.try_wire(Connection::new(
                    &prefetch_id,
                    "sra",
                    &fasterq_id,
                    "sra",
                ));
                self.selection.select_many(
                    vec![prefetch_id, fasterq_id],
                    SelectionMode::Replace,
                );
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
                self.selection.select_many(
                    vec![download_id, unzip_id],
                    SelectionMode::Replace,
                );
                self.status =
                    format!("{accession} ready · Cook downloads and unpacks the NCBI package");
            }
        }
        self.accession.clear();
        self.invalidate_cook();
    }

    fn insert_snakemake_project(&mut self, path: PathBuf) {
        let has_snakefile = path.join("Snakefile").is_file()
            || path.join("workflow").join("Snakefile").is_file();
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
        if let Some(node) = self.graph.nodes.iter_mut().find(|node| node.id == import_id) {
            node.params
                .insert("path".into(), ParamValue::String(path.display().to_string()));
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
                node.params.insert(
                    "snakefile".into(),
                    ParamValue::String("Snakefile".into()),
                );
            }
        }
        self.try_wire(Connection::new(
            &import_id,
            "directory",
            &snakemake_id,
            "workflow",
        ));
        self.selection.select_many(
            vec![import_id, snakemake_id],
            SelectionMode::Replace,
        );
        self.invalidate_cook();
        self.status = format!(
            "{} ready · Cook runs Snakemake in an isolated copy",
            path.file_name().and_then(|name| name.to_str()).unwrap_or("workflow")
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
                self.history.remember(&before);
                self.invalidate_cook();
                self.status = format!(
                    "snapped {}.{} → {}.{}",
                    connection.from_node,
                    connection.from_port,
                    connection.to_node,
                    connection.to_port
                );
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
        let mut existing: Vec<String> = self.graph.nodes.iter().map(|node| node.id.clone()).collect();
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
        let copy_ids = copies.iter().map(|node| node.id.clone()).collect::<Vec<_>>();
        self.graph.nodes.extend(copies);
        self.graph.edges.extend(copied_edges);
        self.history.remember(&before);
        self.selection
            .select_many(copy_ids, SelectionMode::Replace);
        self.invalidate_cook();
        self.status = format!("duplicated {count} node{}", if count == 1 { "" } else { "s" });
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
        self.graph
            .edges
            .retain(|edge| !selected.contains(&edge.from_node) && !selected.contains(&edge.to_node));
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
                self.selection
                    .select_node(&next, SelectionMode::Replace);
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
            if path.join("Snakefile").is_file()
                || path.join("workflow").join("Snakefile").is_file()
            {
                self.last_graph_pos = pos;
                self.insert_snakemake_project(path);
            } else if let Ok(operator) = self.catalog.get("files.import_directory").cloned() {
                self.drop_op(&operator, pos);
                if let Some(node) = self.graph.nodes.last_mut() {
                    node.params
                        .insert("path".into(), ParamValue::String(path.display().to_string()));
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
                        rec.warnings.insert(
                            0,
                            "OCR via tesseract (same flags as omarchy capture text)".into(),
                        );
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
            match fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Graph>(&s).ok()) {
                Some(g) if g.validate().is_ok() => {
                    self.graph = g;
                    self.graph_path = Some(path.clone());
                    self.autosave_due = Some(Instant::now());
                    self.history = EditHistory::default();
                    self.selection.clear();
                    if let Some(node) = self.graph.nodes.first() {
                        self.selection
                            .select_node(&node.id, SelectionMode::Replace);
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
        if matches!(ext.as_str(), "fastq" | "fq" | "gz" | "fasta" | "fa" | "bam" | "vcf" | "gtf") {
            if let Ok(op) = self.catalog.get("files.import").cloned() {
                self.drop_op(&op, pos);
                if let Some(n) = self.graph.nodes.last_mut() {
                    n.params
                        .insert("path".into(), ParamValue::String(path.display().to_string()));
                }
                self.status = format!("import {name}");
            }
            return;
        }
        self.status = format!("drop an Axial graph, data file, or methods paper—not {name}");
    }

    fn poll_paper(&mut self, ctx: &egui::Context) {
        let Some(rx) = &self.paper_rx else {
            return;
        };
        match rx.try_recv() {
            Ok(Ok(r)) => {
                let n = r.graph.nodes.len();
                let assay = r.assay;
                let warns = r.warnings.clone();
                self.graph = r.graph;
                self.graph_path = None;
                self.autosave_due = Some(Instant::now());
                self.history = EditHistory::default();
                self.selection.clear();
                if let Some(node) = self.graph.nodes.first() {
                    self.selection
                        .select_node(&node.id, SelectionMode::Replace);
                }
                self.param_page.clear();
                self.last_states.clear();
                self.last_arts.clear();
                self.viewer_off.clear();
                self.sizes.clear();
                self.pan = Vec2::new(20.0, 28.0);
                self.zoom = 1.0;
                self.request_fit();
                self.paper_ui = false;
                let mut s = format!(
                    "rebuilt {n} nodes from {}  ({assay:?})",
                    self.paper_name
                );
                if !warns.is_empty() {
                    s.push_str("  ·  ");
                    s.push_str(&warns.join("  ·  "));
                }
                self.status = s;
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
                    Err(error) => format!(
                        "saved {} · recovery copy failed: {error}",
                        path.display()
                    ),
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
            if n.operator != "files.import" {
                continue;
            }
            let Some(ParamValue::String(path)) = n.params.get("path") else {
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
            u * u * u * a.x + 3.0 * u * u * tt * c1.x + 3.0 * u * tt * tt * c2.x + tt * tt * tt * b.x,
            u * u * u * a.y + 3.0 * u * u * tt * c1.y + 3.0 * u * tt * tt * c2.y + tt * tt * tt * b.y,
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
    if minor >= 6.0 {
        let ox = rect.min.x + pan.x.rem_euclid(minor);
        let oy = rect.min.y + pan.y.rem_euclid(minor);
        let mut x = ox;
        while x < rect.max.x {
            painter.line_segment(
                [Pos2::new(x, rect.min.y), Pos2::new(x, rect.max.y)],
                Stroke::new(1.0, GRID),
            );
            x += minor;
        }
        let mut y = oy;
        while y < rect.max.y {
            painter.line_segment(
                [Pos2::new(rect.min.x, y), Pos2::new(rect.max.x, y)],
                Stroke::new(1.0, GRID),
            );
            y += minor;
        }
    }
    if major >= 8.0 {
        let ox = rect.min.x + pan.x.rem_euclid(major);
        let oy = rect.min.y + pan.y.rem_euclid(major);
        let mut x = ox;
        while x < rect.max.x {
            painter.line_segment(
                [Pos2::new(x, rect.min.y), Pos2::new(x, rect.max.y)],
                Stroke::new(1.0, GRID_MAJ),
            );
            x += major;
        }
        let mut y = oy;
        while y < rect.max.y {
            painter.line_segment(
                [Pos2::new(rect.min.x, y), Pos2::new(rect.max.x, y)],
                Stroke::new(1.0, GRID_MAJ),
            );
            y += major;
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
                [Pos2::new(r.max.x, r.center().y), Pos2::new(r.max.x + 6.0, r.center().y)],
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
    min.x = min.x.clamp(canvas.min.x + 8.0, (canvas.max.x - size.x - 8.0).max(canvas.min.x + 8.0));
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

fn draw_viewer(painter: &egui::Painter, body: Rect, n: &Node, fq: Option<&FqPreview>, st: Option<&NodeState>, z: f32) {
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
            let name = Path::new(p).file_name().and_then(|s| s.to_str()).unwrap_or(p);
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
            type_name(n.ports.iter().find(|p| p.dir == Direction::Out).map(|p| p.ty).unwrap_or(PortType::Text)),
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
                Rect::from_min_size(Pos2::new(x, band.top() + 10.0), Vec2::new(band.width() / 18.0 - 1.0, band.height() - 20.0)),
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
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(ui.available_width(), 44.0),
        Sense::click(),
    );
    if response.hovered() {
        ui.painter()
            .rect_filled(rect, 6, Color32::from_rgb(46, 47, 57));
    }
    let icon = Rect::from_min_size(rect.min + Vec2::new(7.0, 8.0), Vec2::splat(27.0));
    ui.painter()
        .rect_filled(icon, 6, color.gamma_multiply(0.2));
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
        ui.painter()
            .rect_filled(rect, 6, Color32::from_rgb(46, 47, 57));
    }

    let icon = Rect::from_min_size(rect.min + Vec2::new(7.0, 8.0), Vec2::splat(27.0));
    ui.painter()
        .rect_filled(icon, 6, color.gamma_multiply(0.2));
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
    v.extreme_bg_color = Color32::from_rgb(28, 28, 32);
    v.faint_bg_color = Color32::from_rgb(38, 38, 42);
    v.override_text_color = Some(TEXT);
    v.widgets.inactive.bg_fill = PANEL2;
    v.widgets.inactive.weak_bg_fill = PANEL2;
    v.widgets.hovered.bg_fill = Color32::from_rgb(62, 62, 70);
    v.widgets.active.bg_fill = Color32::from_rgb(70, 70, 80);
    v.selection.bg_fill = ACCENT.gamma_multiply(0.4);
    v.widgets.inactive.corner_radius = CornerRadius::same(2);
    v.widgets.hovered.corner_radius = CornerRadius::same(2);
    v.window_corner_radius = CornerRadius::same(2);
    v.window_stroke = Stroke::new(1.0, Color32::from_rgb(70, 70, 78));
    ctx.set_visuals(v);
    ctx.style_mut(|s| {
        s.spacing.item_spacing = Vec2::new(4.0, 3.0);
        s.spacing.button_padding = Vec2::new(6.0, 3.0);
        s.spacing.interact_size.y = 18.0;
    });
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        apply_visuals(ctx);
        {
            let r = ctx.screen_rect();
            ctx.layer_painter(egui::LayerId::background())
                .rect_filled(r, 0, BG);
        }
        self.poll_cook(ctx);
        self.poll_paper(ctx);
        self.poll_autosave(ctx);
        self.poll_nfcore_catalog(ctx);
        self.refresh_fq();
        let dropped: Vec<PathBuf> = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .filter_map(|f| f.path.clone())
                .collect()
        });
        for p in dropped {
            self.ingest_path(p, self.last_graph_pos);
        }
        let cooking = self.cook_rx.is_some();
        let t = ctx.input(|i| i.time);

        let typing = ctx.wants_keyboard_input();
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            self.op_create = false;
            self.paper_ui = false;
            self.info = None;
            self.wire = None;
            self.pending_insert = None;
            self.marquee = None;
        }
        if self.op_create && ctx.input(|i| i.key_pressed(egui::Key::Tab)) {
            self.op_create = false;
            self.pending_insert = None;
        }
        if !typing {
            ctx.input(|i| {
                if i.key_pressed(egui::Key::Delete) || i.key_pressed(egui::Key::Backspace) {
                    return true;
                }
                false
            })
            .then(|| self.delete_selected());
            if ctx.input(|i| i.key_pressed(egui::Key::Tab)) && !self.op_create {
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
            if ctx.input(|i| i.key_pressed(egui::Key::F5) || (i.modifiers.ctrl && i.key_pressed(egui::Key::Enter)))
            {
                self.cook();
            }
            if ctx.input(|i| i.key_pressed(egui::Key::P)) {
                self.paper_ui = !self.paper_ui;
            }
        }

        egui::TopBottomPanel::top("bar")
            .exact_height(34.0)
            .frame(Frame::new().fill(BAR).inner_margin(Margin::symmetric(14, 5)))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Axial").color(ACCENT).strong().size(14.0));
                    ui.add_space(10.0);
                    ui.label(egui::RichText::new("/").color(MUTED).size(12.0));
                    ui.label(egui::RichText::new("project1").color(TEXT).size(12.0));
                    if !self.paper_name.is_empty() {
                        ui.label(egui::RichText::new("/").color(MUTED).size(12.0));
                        ui.label(egui::RichText::new(&self.paper_name).color(ACCENT).size(12.0));
                    }
                    ui.label(egui::RichText::new("  >>").color(MUTED).size(12.0));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let cook_l = if cooking { "  cooking…  " } else { "  Cook  " };
                        let fill = if cooking {
                            Color32::from_rgb(200, 170, 70)
                        } else {
                            SELECT
                        };
                        if ui
                            .add(
                                egui::Button::new(egui::RichText::new(cook_l).color(Color32::BLACK).strong())
                                    .fill(fill),
                            )
                            .clicked()
                        {
                            self.cook();
                        }
                        if ui
                            .add(
                                egui::Button::new(egui::RichText::new("  Fit  ").color(TEXT))
                                    .fill(PANEL2),
                            )
                            .clicked()
                        {
                            self.request_fit();
                        }
                        if ui
                            .add(
                                egui::Button::new(egui::RichText::new("  Save  ").color(TEXT))
                                    .fill(PANEL2),
                            )
                            .clicked()
                        {
                            self.save_graph();
                        }
                    });
                });
            });

        egui::TopBottomPanel::bottom("hint")
            .exact_height(20.0)
            .frame(Frame::new().fill(BAR).inner_margin(Margin::symmetric(14, 1)))
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
                        ui.label(
                            egui::RichText::new(format!("{:.0}%", self.zoom * 100.0))
                                .size(11.0)
                                .color(MUTED),
                        );
                    });
                });
            });

        let mut pick_snakemake = false;
        egui::SidePanel::left("palette")
            .default_width(272.0)
            .min_width(238.0)
            .max_width(380.0)
            .resizable(true)
            .frame(Frame::new().fill(PANEL).inner_margin(Margin::ZERO))
            .show(ctx, |ui| {
                let header = Rect::from_min_size(
                    ui.max_rect().min,
                    Vec2::new(ui.available_width(), 38.0),
                );
                ui.painter().rect_filled(header, 0, BAR);
                ui.add_space(9.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    ui.label(
                        egui::RichText::new("Library")
                            .strong()
                            .size(13.0)
                            .color(TEXT),
                    );
                    ui.with_layout(
                        egui::Layout::right_to_left(egui::Align::Center),
                        |ui| {
                            ui.add_space(10.0);
                            ui.label(
                                egui::RichText::new(format!("{} tools", self.catalog.ops.len()))
                                    .size(10.0)
                                    .color(MUTED),
                            );
                        },
                    );
                });
                ui.add_space(11.0);

                ui.horizontal(|ui| {
                    ui.add_space(10.0);
                    Frame::new()
                        .fill(Color32::from_rgb(42, 43, 51))
                        .stroke(Stroke::new(1.0, Color32::from_rgb(64, 65, 76)))
                        .inner_margin(Margin::symmetric(8, 5))
                        .corner_radius(6)
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.search)
                                    .id(Id::new("palette_search"))
                                    .hint_text("Search tools, sources, pipelines…")
                                    .desired_width((ui.available_width() - 12.0).max(100.0))
                                    .frame(false)
                                    .font(FontId::proportional(12.0)),
                            );
                        });
                });
                ui.add_space(7.0);

                ui.horizontal(|ui| {
                    ui.add_space(10.0);
                    let width = ((ui.available_width() - 12.0) / 3.0).max(58.0);
                    for mode in PaletteMode::ALL {
                        let selected = self.palette_mode == mode;
                        let response = ui.add_sized(
                            Vec2::new(width, 26.0),
                            egui::Button::new(
                                egui::RichText::new(mode.label())
                                    .size(11.0)
                                    .color(if selected { TEXT } else { MUTED }),
                            )
                            .fill(if selected {
                                Color32::from_rgb(48, 46, 57)
                            } else {
                                Color32::TRANSPARENT
                            })
                            .corner_radius(5),
                        );
                        if response.clicked() {
                            self.palette_mode = mode;
                            self.search.clear();
                        }
                    }
                });
                ui.add_space(6.0);
                ui.separator();

                let mut quick_drop: Option<Operator> = None;
                if self.search.is_empty() && self.palette_mode == PaletteMode::Build {
                    ui.add_space(5.0);
                    ui.horizontal(|ui| {
                        ui.add_space(12.0);
                        ui.label(
                            egui::RichText::new("QUICK ADD")
                                .size(9.5)
                                .color(MUTED),
                        );
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
                                "SRA run or NCBI assembly",
                                SELECT,
                            )
                            .clicked()
                            {
                                self.palette_mode = PaletteMode::Sources;
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
                                self.palette_mode = PaletteMode::Pipelines;
                                ui.memory_mut(|memory| {
                                    memory.request_focus(Id::new("palette_search"));
                                });
                            }
                        });
                    });
                    ui.add_space(2.0);
                }

                let mut add_accession = false;
                if self.search.is_empty() && self.palette_mode == PaletteMode::Sources {
                    ui.add_space(7.0);
                    ui.horizontal(|ui| {
                        ui.add_space(12.0);
                        ui.label(
                            egui::RichText::new("PASTE AN ACCESSION")
                                .size(9.5)
                                .color(MUTED),
                        );
                    });
                    ui.add_space(2.0);
                    ui.horizontal(|ui| {
                        ui.add_space(10.0);
                        Frame::new()
                            .fill(Color32::from_rgb(37, 48, 44))
                            .stroke(Stroke::new(1.0, SELECT.gamma_multiply(0.45)))
                            .inner_margin(Margin::symmetric(8, 5))
                            .corner_radius(6)
                            .show(ui, |ui| {
                                let response = ui.add(
                                    egui::TextEdit::singleline(&mut self.accession)
                                        .id(Id::new("accession_entry"))
                                        .hint_text("SRR…  ERR…  GCA…  GCF…")
                                        .desired_width((ui.available_width() - 52.0).max(80.0))
                                        .frame(false)
                                        .font(FontId::proportional(12.0)),
                                );
                                if self.focus_accession {
                                    response.request_focus();
                                    self.focus_accession = false;
                                }
                                if response.has_focus()
                                    && ui.input(|input| input.key_pressed(egui::Key::Enter))
                                {
                                    add_accession = true;
                                }
                            });
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("Add").size(11.0).color(TEXT),
                                )
                                .fill(PANEL2)
                                .corner_radius(5),
                            )
                            .clicked()
                        {
                            add_accession = true;
                        }
                    });
                    ui.add_space(5.0);
                }

                if self.search.is_empty() && self.palette_mode == PaletteMode::Pipelines {
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
                    self.palette_mode,
                    &self.catalog.ops,
                    &self.nfcore,
                    &self.search,
                    &self.recent_ops,
                    &self.favorite_ops,
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
                                    let favorite = self.favorite_ops.contains(&item.operator.id);
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
                    if !self.favorite_ops.remove(&id) {
                        self.favorite_ops.insert(id);
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
                    ui.label(
                        egui::RichText::new(format!("★ {} favorites", self.favorite_ops.len()))
                            .size(10.0)
                            .color(MUTED),
                    );
                    ui.with_layout(
                        egui::Layout::right_to_left(egui::Align::Center),
                        |ui| {
                            ui.add_space(10.0);
                            ui.label(
                                egui::RichText::new(format!(
                                    "✓ {} installed",
                                    self.catalog.ops.len()
                                ))
                                .size(10.0)
                                .color(MUTED),
                            );
                        },
                    );
                });
                ui.add_space(6.0);
            });

        if pick_snakemake {
            if let Some(path) = Self::pick_snakemake_directory() {
                self.insert_snakemake_project(path);
            }
        }

        let selected_id = self.selection.primary().map(str::to_owned);
        if self.rename_target != selected_id {
            self.rename_target = selected_id.clone();
            self.rename_buffer = selected_id.clone().unwrap_or_default();
        }
        let mut rename_request: Option<(String, String)> = None;
        egui::SidePanel::right("params")
            .default_width(268.0)
            .resizable(true)
            .frame(Frame::new().fill(PANEL).inner_margin(Margin::ZERO))
            .show(ctx, |ui| {
                if let Some(id) = &selected_id {
                    if let Some(nidx) = self.graph.nodes.iter().position(|n| n.id == *id) {
                        let op_id = self.graph.nodes[nidx].operator.clone();
                        let node_name = self.graph.nodes[nidx].id.clone();
                        let title = self
                            .catalog
                            .get(&op_id)
                            .map(|o| o.title.clone())
                            .unwrap_or_else(|_| op_id.clone());
                        let hdr = Rect::from_min_size(ui.max_rect().min, Vec2::new(ui.available_width(), 40.0));
                        ui.painter().rect_filled(hdr, 0, ACCENT);
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.add_space(10.0);
                            ui.vertical(|ui| {
                                ui.label(egui::RichText::new(&title).size(11.0).color(HEADER_FG));
                                let rename = ui.add(
                                    egui::TextEdit::singleline(&mut self.rename_buffer)
                                        .desired_width(150.0)
                                        .font(FontId::proportional(15.0))
                                        .text_color(Color32::WHITE)
                                        .frame(false)
                                        .margin(Margin::ZERO),
                                );
                                if (rename.lost_focus()
                                    || (rename.has_focus()
                                        && ui.input(|input| input.key_pressed(egui::Key::Enter))))
                                    && self.rename_buffer != node_name
                                {
                                    rename_request =
                                        Some((node_name.clone(), self.rename_buffer.clone()));
                                }
                            });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                ui.add_space(8.0);
                                if ui
                                    .add(
                                        egui::Button::new(egui::RichText::new("Cook").size(11.0).color(HEADER_FG))
                                            .fill(Color32::from_rgba_unmultiplied(255, 255, 255, 40)),
                                    )
                                    .clicked()
                                {
                                    self.cook();
                                }
                            });
                        });
                        ui.add_space(8.0);
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
                                        egui::RichText::new(p).size(12.0).color(TEXT)
                                    } else {
                                        egui::RichText::new(p).size(12.0).color(MUTED)
                                    };
                                    let r = ui.add(egui::Button::new(t).fill(Color32::TRANSPARENT));
                                    if on {
                                        let u = r.rect;
                                        ui.painter().line_segment(
                                            [Pos2::new(u.min.x, u.max.y - 1.0), Pos2::new(u.max.x, u.max.y - 1.0)],
                                            Stroke::new(1.5, TEXT),
                                        );
                                    }
                                    if r.clicked() {
                                        self.param_page = p.clone();
                                    }
                                }
                            });
                            ui.add_space(2.0);
                            ui.separator();
                            egui::ScrollArea::vertical().show(ui, |ui| {
                                ui.add_space(8.0);
                                if self.param_page == "Common" {
                                    common_page(ui, &op, !self.viewer_off.contains(id));
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
                                    if ui
                                        .add(egui::Button::new("toggle viewer").fill(PANEL2))
                                        .clicked()
                                        && !self.viewer_off.remove(id)
                                    {
                                        self.viewer_off.insert(id.clone());
                                    }
                                } else {
                                    let keys: Vec<String> = op
                                        .params
                                        .iter()
                                        .filter(|(_, s)| {
                                            s.page.clone().unwrap_or_else(|| title.clone()) == self.param_page
                                        })
                                        .map(|(k, _)| k.clone())
                                        .collect();
                                    if keys.is_empty() {
                                        ui.horizontal(|ui| {
                                            ui.add_space(10.0);
                                            ui.label(
                                                egui::RichText::new("No parameters on this page.")
                                                    .color(MUTED)
                                                    .italics()
                                                    .size(11.0),
                                            );
                                        });
                                    }
                                    for k in keys {
                                        let spec = &op.params[&k];
                                        let label = spec.label.clone().unwrap_or(k.clone());
                                        let (edit, previous) = {
                                            let node = &mut self.graph.nodes[nidx];
                                            let entry = node.params.entry(k.clone()).or_insert_with(|| {
                                                spec.default
                                                    .clone()
                                                    .unwrap_or(ParamValue::String(String::new()))
                                            });
                                            let previous = entry.clone();
                                            let edit = param_row(ui, &label, entry, spec.min, spec.max);
                                            (edit, previous)
                                        };
                                        if edit.began {
                                            let mut before = self.graph.clone();
                                            before.nodes[nidx].params.insert(k.clone(), previous);
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
                    ui.add_space(16.0);
                    ui.horizontal(|ui| {
                        ui.add_space(12.0);
                        ui.label(egui::RichText::new("select a node").color(MUTED).size(12.0));
                    });
                }
            });
        if let Some((old, requested)) = rename_request {
            self.commit_rename(&old, &requested);
        }

        egui::CentralPanel::default()
            .frame(Frame::new().fill(BG))
            .show(ctx, |ui| {
                let (resp, painter) = ui.allocate_painter(ui.available_size(), Sense::click_and_drag());
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
                    let Some(a) = self.graph.node(&e.from_node) else { continue };
                    let Some(b) = self.graph.node(&e.to_node) else { continue };
                    let Some(ap) = a.port(&e.from_port, Direction::Out) else { continue };
                    let Some(bp) = b.port(&e.to_port, Direction::In) else { continue };
                    let p0 = self.port_pos(origin, a, ap);
                    let p1 = self.port_pos(origin, b, bp);
                    if !bezier_bounds(p0, p1).expand(16.0).intersects(resp.rect) {
                        continue;
                    }
                    let failed = matches!(self.last_states.get(&e.from_node), Some(NodeState::Failed));
                    let col = if failed {
                        Color32::from_rgb(220, 80, 80)
                    } else {
                        port_color(ap.ty)
                    };
                    let emphasized = self.selection.edge() == Some(e.id.as_str())
                        || hovered_edge.as_deref() == Some(e.id.as_str());
                    bezier(&painter, p0, p1, col, cooking, emphasized, t);
                }

                self.hover_port = None;
                let mut hit_port: Option<WireStart> = None;
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
                        r.translate(Vec2::new(0.0, 3.0 * z)),
                        CornerRadius::same(6),
                        Color32::from_rgba_unmultiplied(0, 0, 0, 72),
                    );
                    painter.rect_filled(r, CornerRadius::same(6), NODE);
                    painter.rect_filled(
                        Rect::from_min_max(r.min, Pos2::new(r.min.x + STRIP * z, r.max.y)),
                        0,
                        family_color(&n.operator),
                    );

                    let viewer_on = !self.viewer_off.contains(&n.id);
                    if viewer_on {
                        let body = Rect::from_min_max(
                            r.min + Vec2::new((STRIP + 2.0) * z, 3.0 * z),
                            r.max - Vec2::new(4.0 * z, 4.0 * z),
                        );
                        painter.rect_filled(body, 1, Color32::from_rgb(16, 16, 18));
                        let fq = self.fq_for(&n.id);
                        let clip = painter.with_clip_rect(body);
                        draw_viewer(&clip, body, n, fq, self.last_states.get(&n.id), z);
                    } else {
                        let inner = r.shrink2(Vec2::new((STRIP + 6.0) * z, 3.0 * z));
                        draw_label(
                            &painter,
                            r.min + Vec2::new((STRIP + 8.0) * z, 4.0 * z),
                            egui::Align2::LEFT_TOP,
                            &n.id,
                            font_px(11.0, z, 8.0, 12.0),
                            TEXT,
                            inner,
                        );
                    }

                    // cook LED
                    let led = match self.last_states.get(&n.id) {
                        Some(NodeState::Done) => Color32::from_rgb(70, 210, 110),
                        Some(NodeState::Cached) => Color32::from_rgb(80, 160, 230),
                        Some(NodeState::Failed) => Color32::from_rgb(220, 70, 70),
                        Some(NodeState::Skipped) => Color32::from_rgb(140, 140, 90),
                        _ if cooking => Color32::from_rgb(220, 180, 70),
                        _ => Color32::from_rgb(50, 50, 54),
                    };
                    painter.circle_filled(r.max - Vec2::new(7.0 * z, 7.0 * z), 3.0 * z, led);

                    let stroke = if sel {
                        Stroke::new(1.8, SELECT)
                    } else if hovered {
                        Stroke::new(1.0, Color32::from_rgb(110, 110, 118))
                    } else {
                        Stroke::new(1.0, Color32::from_rgb(62, 62, 68))
                    };
                    painter.rect_stroke(r, 6, stroke, egui::StrokeKind::Outside);

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
                            Color32::from_rgb(70, 140, 90)
                        } else {
                            Color32::from_rgb(40, 40, 44)
                        },
                    );
                    painter.rect_stroke(flag, 0, Stroke::new(1.0, Color32::from_rgb(20, 20, 22)), egui::StrokeKind::Inside);

                    // resize handle
                    if viewer_on && sel {
                        let hz = Rect::from_min_size(r.max - Vec2::new(10.0 * z, 10.0 * z), Vec2::splat(10.0 * z));
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
                            } else if p.dir != if *is_out { Direction::Out } else { Direction::In } {
                                ring = Some(Color32::from_rgb(160, 50, 50));
                            }
                        }
                        painter.circle_filled(c, rad, col);
                        painter.circle_stroke(c, rad, Stroke::new(1.0, Color32::from_rgb(16, 16, 18)));
                        if let Some(rc) = ring {
                            painter.circle_stroke(c, rad + 2.5 * z, Stroke::new(1.6, rc));
                        }
                        let hit_r = Rect::from_center_size(c, Vec2::splat(16.0 * z));
                        if let Some(pos) = resp.hover_pos().or_else(|| resp.interact_pointer_pos()) {
                            if hit_r.contains(pos) {
                                painter.circle_stroke(c, rad + 2.0, Stroke::new(1.4, SELECT));
                                self.hover_port = Some((n.id.clone(), p.name.clone(), p.ty, p.dir == Direction::Out));
                                if resp.drag_started() && ui.input(|i| i.pointer.primary_down()) {
                                    hit_port = Some(WireStart::new(&n.id, &p.name, p.dir));
                                }
                            }
                        }
                    }

                    if resp.clicked() {
                        if let Some(pos) = resp.interact_pointer_pos() {
                            let name_r = Rect::from_center_size(
                                Pos2::new(r.center().x, r.max.y + 9.0 * z),
                                Vec2::new(r.width(), 16.0 * z),
                            );
                            if (r.contains(pos) || name_r.contains(pos)) && hit_port.is_none() && hit_flag.is_none() {
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
                        let hit = nodes.iter().rev().find(|n| self.node_rect(origin, n).contains(pos));
                        if let Some(n) = hit {
                            if hit_flag.is_none() {
                                let mode = ui.input(|input| selection_mode(input.modifiers));
                                if mode != SelectionMode::Replace || !self.selection.contains(&n.id) {
                                    self.selection.select_node(&n.id, mode);
                                }
                                self.history.remember(&self.graph);
                                self.dragging = self
                                    .selection
                                    .contains(&n.id)
                                    .then(|| n.id.clone());
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
                        let sz = self.sizes.entry(id.clone()).or_insert(Vec2::new(NODE_W, NODE_H));
                        sz.x = (sz.x + d.x).clamp(90.0, 360.0);
                        sz.y = (sz.y + d.y).clamp(56.0, 280.0);
                    } else if self.dragging.is_some() {
                        for node in &mut self.graph.nodes {
                            if self.selection.contains(&node.id) {
                                node.layout.x += d.x;
                                node.layout.y += d.y;
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
                                        let distance = self.port_pos(origin, node, port).distance(pos);
                                        let connection = wire.connection_to(&self.graph, &node.id, port)?;
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
                        self.status = format!("selected {} node{}", self.selection.len(), if self.selection.len() == 1 { "" } else { "s" });
                    }
                    self.wire = None;
                    self.dragging = None;
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
                if resp.clicked() && hit_node.is_none() && hit_port.is_none() && hit_flag.is_none() {
                    if let Some(pos) = resp.interact_pointer_pos() {
                        let on_node = nodes.iter().any(|n| self.node_rect(origin, n).contains(pos));
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
                        let on_node = nodes.iter().any(|n| self.node_rect(origin, n).contains(pos));
                        if !on_node {
                            self.open_op_create(self.to_graph(origin, pos), pos, None);
                        }
                    }
                }
            });

        if self.paper_ui {
            let mut load_example = false;
            let mut pick = false;
            egui::Window::new("paper")
                .title_bar(false)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, -30.0])
                .frame(
                    Frame::new()
                        .fill(Color32::from_rgb(30, 30, 34))
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
                                egui::RichText::new("  Example: RNA-seq methods  ").color(Color32::BLACK),
                            )
                            .fill(SELECT)
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
                    ui.label(egui::RichText::new("P to toggle  ·  esc to close").size(10.0).color(MUTED));
                });
            if load_example {
                self.ingest_path(Self::example_paper(), self.last_graph_pos);
            }
            if pick {
                if let Some(p) = Self::pick_paper_file() {
                    self.ingest_path(p, self.last_graph_pos);
                }
            }
        }

        if self.op_create {
            let ops = self.filtered_ops(&self.op_create_q);
            let inserting = self.pending_insert.is_some();
            if self.op_create_i >= ops.len() && !ops.is_empty() {
                self.op_create_i = ops.len() - 1;
            }
            egui::Window::new("opcreate")
                .title_bar(false)
                .resizable(false)
                .collapsible(false)
                .fixed_pos(self.op_create_screen)
                .frame(
                    Frame::new()
                        .fill(Color32::from_rgb(30, 30, 34))
                        .stroke(Stroke::new(1.0, ACCENT.gamma_multiply(0.6)))
                        .inner_margin(Margin::same(10))
                        .corner_radius(4),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(320.0);
                    ui.label(
                        egui::RichText::new(if inserting {
                            "Insert compatible operator"
                        } else {
                            "Add operator"
                        })
                        .size(11.0)
                        .color(MUTED),
                    );
                    let te = ui.add(
                        egui::TextEdit::singleline(&mut self.op_create_q)
                            .hint_text("type to filter  ·  enter to drop")
                            .desired_width(300.0)
                            .font(FontId::proportional(14.0)),
                    );
                    te.request_focus();
                    if ui.input(|i| i.key_pressed(egui::Key::ArrowDown)) {
                        self.op_create_i = (self.op_create_i + 1).min(ops.len().saturating_sub(1));
                    }
                    if ui.input(|i| i.key_pressed(egui::Key::ArrowUp)) {
                        self.op_create_i = self.op_create_i.saturating_sub(1);
                    }
                    ui.add_space(4.0);
                    let mut chosen: Option<Operator> = None;
                    egui::ScrollArea::vertical().max_height(260.0).show(ui, |ui| {
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
                                Color32::from_rgb(70, 60, 90)
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
                            let strip = Rect::from_min_size(r.rect.min, Vec2::new(3.0, r.rect.height()));
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
        }

        if let Some(id) = self.info.clone() {
            if let Some(n) = self.graph.node(&id).cloned() {
                egui::Window::new("nodeinfo")
                    .title_bar(false)
                    .resizable(false)
                    .anchor(egui::Align2::CENTER_TOP, [0.0, 48.0])
                    .frame(
                        Frame::new()
                            .fill(Color32::from_rgb(26, 26, 30))
                            .stroke(Stroke::new(1.0, Color32::from_rgb(80, 80, 88)))
                            .inner_margin(Margin::same(10))
                            .corner_radius(3),
                    )
                    .show(ctx, |ui| {
                        ui.set_min_width(240.0);
                        ui.label(egui::RichText::new(&n.id).strong().size(14.0));
                        ui.label(egui::RichText::new(&n.operator).size(11.0).color(MUTED).monospace());
                        let st = match self.last_states.get(&n.id) {
                            Some(NodeState::Done) => "done",
                            Some(NodeState::Cached) => "cached",
                            Some(NodeState::Failed) => "failed",
                            Some(NodeState::Skipped) => "skipped",
                            None => "idle",
                        };
                        ui.label(egui::RichText::new(format!("cook  {st}")).size(11.0).color(MUTED));
                        if let Some(note) = &n.note {
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new(note).size(11.0).color(ACCENT).italics());
                        }
                        ui.separator();
                        for p in &n.ports {
                            let d = if p.dir == Direction::In { "in " } else { "out" };
                            ui.label(
                                egui::RichText::new(format!("{d}  {}  {}", p.name, type_name(p.ty)))
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
}

fn param_row(
    ui: &mut egui::Ui,
    label: &str,
    entry: &mut ParamValue,
    min: Option<i64>,
    max: Option<i64>,
) -> ParamEdit {
    let edit = ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.add_sized(
            Vec2::new(72.0, 18.0),
            egui::Label::new(egui::RichText::new(label).color(MUTED).size(11.0)).halign(egui::Align::RIGHT),
        );
        ui.add_space(6.0);
        let response = match entry {
            ParamValue::String(s) => {
                ui.add(
                    egui::TextEdit::singleline(s)
                        .desired_width(ui.available_width() - 8.0)
                        .font(FontId::proportional(12.0)),
                )
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
        }
    });
    ui.add_space(3.0);
    edit.inner
}

fn common_page(ui: &mut egui::Ui, op: &Operator, viewer_on: bool) {
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.add_sized(
            Vec2::new(72.0, 18.0),
            egui::Label::new(egui::RichText::new("operator").color(MUTED).size(11.0)).halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        ui.label(egui::RichText::new(&op.id).size(12.0).monospace());
    });
    ui.add_space(3.0);
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.add_sized(
            Vec2::new(72.0, 18.0),
            egui::Label::new(egui::RichText::new("cost").color(MUTED).size(11.0)).halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        ui.label(egui::RichText::new(match op.cost {
            Cost::Low => "low",
            Cost::High => "high",
        }).size(12.0));
    });
    ui.add_space(3.0);
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.add_sized(
            Vec2::new(72.0, 18.0),
            egui::Label::new(egui::RichText::new("viewer").color(MUTED).size(11.0)).halign(egui::Align::RIGHT),
        );
        ui.add_space(8.0);
        ui.label(egui::RichText::new(if viewer_on { "on" } else { "off" }).size(12.0));
    });
    if let Some(c) = &op.conda {
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            ui.label(egui::RichText::new(format!("conda  {}  {}", c.name, c.spec.join(" "))).size(10.0).color(MUTED));
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
}
