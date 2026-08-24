//! TouchDesigner-shaped Axial: palette | network | parameter pages.
//!
//! Nodes are viewers. Names sit under the body. Ports snap. Tab / double-click
//! opens OP Create. Palette drags onto the grid.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use axial_cook::{cook_graph, ArtifactMeta, CookReport, NodeState, Project};
use axial_ir::{compatible, Direction, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION};
use axial_ops::{Catalog, Cost, Operator};
use axial_paper::{extract_from_path, reconstruct, text_from_path, ExtractVia, Reconstruction};
use eframe::egui::{
    self, Color32, CornerRadius, CursorIcon, FontData, FontDefinitions, FontFamily, FontId, Frame,
    Id, Margin, Pos2, Rect, Sense, Stroke, Vec2,
};

const BG: Color32 = Color32::from_rgb(34, 34, 36);
const GRID: Color32 = Color32::from_rgb(44, 44, 46);
const GRID_MAJ: Color32 = Color32::from_rgb(54, 54, 58);
const PANEL: Color32 = Color32::from_rgb(42, 42, 46);
const PANEL2: Color32 = Color32::from_rgb(50, 50, 56);
const BAR: Color32 = Color32::from_rgb(28, 28, 32);
const NODE: Color32 = Color32::from_rgb(24, 24, 26);
const SELECT: Color32 = Color32::from_rgb(48, 220, 110);
const TEXT: Color32 = Color32::from_rgb(226, 226, 228);
const MUTED: Color32 = Color32::from_rgb(132, 132, 140);
const ACCENT: Color32 = Color32::from_rgb(154, 130, 184);
const HEADER_FG: Color32 = Color32::from_rgb(36, 22, 48);

const NODE_W: f32 = 148.0;
const NODE_H: f32 = 92.0;
const NODE_H_FLAT: f32 = 22.0;
const STRIP: f32 = 7.0;
const NAME_GAP: f32 = 4.0;

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
    } else if op_id.starts_with("asm.") {
        Color32::from_rgb(90, 140, 210)
    } else if op_id.starts_with("nf.") {
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
        PortType::Directory => Color32::from_rgb(230, 180, 80),
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
    selected: Option<String>,
    pan: Vec2,
    zoom: f32,
    status: String,
    last_states: BTreeMap<String, NodeState>,
    search: String,
    param_page: String,
    wire: Option<(String, String, bool)>,
    cursor: Pos2,
    last_graph_pos: Pos2,
    op_create: bool,
    op_create_q: String,
    op_create_i: usize,
    viewer_off: BTreeSet<String>,
    sizes: BTreeMap<String, Vec2>,
    fq: BTreeMap<String, FqPreview>,
    dragging: Option<String>,
    resizing: Option<String>,
    info: Option<String>,
    pal_hover: Option<String>,
    cook_rx: Option<Receiver<Result<CookReport, String>>>,
    cook_started: Option<Instant>,
    hover_port: Option<(String, String, PortType, bool)>,
    last_arts: BTreeMap<String, BTreeMap<String, ArtifactMeta>>,
    paper_rx: Option<Receiver<Result<Reconstruction, String>>>,
    paper_name: String,
    paper_ui: bool,
    auto_fit: bool,
}

impl App {
    fn new() -> Self {
        let catalog = Catalog::load_dir(&operators_dir()).unwrap_or_default();
        let graph_path = project_root().join("testdata/fastq_to_fastqc.axial.json");
        let graph: Graph = fs::read_to_string(&graph_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Graph {
                schema_version: SCHEMA_VERSION,
                nodes: vec![],
                edges: vec![],
            });
        let selected = graph.nodes.first().map(|n| n.id.clone());
        let mut app = Self {
            catalog,
            graph,
            selected,
            pan: Vec2::new(20.0, 28.0),
            zoom: 1.0,
            status: "Drop a paper on the canvas to rebuild its pipeline".into(),
            last_states: BTreeMap::new(),
            search: String::new(),
            param_page: String::new(),
            wire: None,
            cursor: Pos2::ZERO,
            last_graph_pos: Pos2::new(160.0, 180.0),
            op_create: false,
            op_create_q: String::new(),
            op_create_i: 0,
            viewer_off: BTreeSet::new(),
            sizes: BTreeMap::new(),
            fq: BTreeMap::new(),
            dragging: None,
            resizing: None,
            info: None,
            pal_hover: None,
            cook_rx: None,
            cook_started: None,
            hover_port: None,
            last_arts: BTreeMap::new(),
            paper_rx: None,
            paper_name: String::new(),
            paper_ui: false,
            auto_fit: false,
        };
        if let Ok(p) = env::var("AXIAL_OPEN") {
            if let Ok(text) = text_from_path(Path::new(&p)) {
                let r = reconstruct(&app.catalog, &text);
                let n = r.graph.nodes.len();
                app.graph = r.graph;
                app.selected = app.graph.nodes.first().map(|n| n.id.clone());
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

    fn drop_op(&mut self, op: &Operator, pos: Pos2) {
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
        self.selected = Some(id.clone());
        self.param_page.clear();
        self.status = format!("dropped {id}");
        self.op_create = false;
        self.op_create_q.clear();
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

    fn try_wire(&mut self, from_n: &str, from_p: &str, to_n: &str, to_p: &str) {
        if from_n == to_n {
            self.status = "no snap: self-edge".into();
            return;
        }
        self.graph.edges.retain(|e| {
            !(e.to_node == to_n && e.to_port == to_p)
                && !(e.from_node == from_n && e.from_port == from_p && e.to_node == to_n && e.to_port == to_p)
        });
        let e = axial_ir::Edge {
            id: format!("e_{from_n}_{from_p}_{to_n}_{to_p}"),
            from_node: from_n.into(),
            from_port: from_p.into(),
            to_node: to_n.into(),
            to_port: to_p.into(),
        };
        self.graph.edges.push(e);
        if let Err(err) = self.graph.validate() {
            self.graph.edges.pop();
            self.status = format!("no snap: {err}");
        } else {
            self.status = "snapped".into();
        }
    }

    fn delete_selected(&mut self) {
        let Some(id) = self.selected.take() else {
            return;
        };
        self.graph.nodes.retain(|n| n.id != id);
        self.graph.edges.retain(|e| e.from_node != id && e.to_node != id);
        self.last_states.remove(&id);
        self.last_arts.remove(&id);
        self.viewer_off.remove(&id);
        self.sizes.remove(&id);
        self.info = None;
        self.status = format!("deleted {id}");
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
                    self.selected = self.graph.nodes.first().map(|n| n.id.clone());
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
        self.status = format!("drop a paper (.pdf/.txt) or a FASTQ, not {name}");
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
                self.selected = self.graph.nodes.first().map(|n| n.id.clone());
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
            if q.is_empty()
                || op.title.to_lowercase().contains(&q)
                || op.id.to_lowercase().contains(&q)
                || op.palette.iter().any(|p| p.to_lowercase().contains(&q))
            {
                out.push(op.clone());
            }
        }
        out.sort_by(|a, b| a.title.cmp(&b.title));
        out
    }
}

fn bezier(painter: &egui::Painter, a: Pos2, b: Pos2, color: Color32, cooking: bool, t: f64) {
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
    let glow = color.gamma_multiply(0.28);
    for w in pts.windows(2) {
        painter.line_segment([w[0], w[1]], Stroke::new(5.5, glow));
    }
    let pulse = if cooking {
        0.55 + 0.45 * ((t * 6.0).sin() as f32)
    } else {
        1.0
    };
    let col = color.gamma_multiply(pulse);
    for w in pts.windows(2) {
        painter.line_segment([w[0], w[1]], Stroke::new(if cooking { 2.4 } else { 1.7 }, col));
    }
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
                .rect_filled(r, 0, Color32::from_rgb(34, 34, 36));
        }
        self.poll_cook(ctx);
        self.poll_paper(ctx);
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
        if !typing {
            ctx.input(|i| {
                if i.key_pressed(egui::Key::Delete) || i.key_pressed(egui::Key::Backspace) {
                    return true;
                }
                false
            })
            .then(|| self.delete_selected());
            if ctx.input(|i| i.key_pressed(egui::Key::Tab)) {
                self.op_create = !self.op_create;
                self.op_create_q.clear();
                self.op_create_i = 0;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::F5) || (i.modifiers.ctrl && i.key_pressed(egui::Key::Enter)))
            {
                self.cook();
            }
            if ctx.input(|i| i.key_pressed(egui::Key::P)) {
                self.paper_ui = !self.paper_ui;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
                self.op_create = false;
                self.paper_ui = false;
                self.info = None;
                self.wire = None;
            }
        }

        egui::TopBottomPanel::top("bar")
            .exact_height(28.0)
            .frame(Frame::new().fill(BAR).inner_margin(Margin::symmetric(14, 4)))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Axial").color(ACCENT).strong().size(13.0));
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
                                egui::Button::new(egui::RichText::new("  Paper  ").color(Color32::WHITE))
                                    .fill(ACCENT),
                            )
                            .clicked()
                        {
                            self.paper_ui = true;
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

        egui::SidePanel::left("palette")
            .default_width(208.0)
            .resizable(true)
            .frame(Frame::new().fill(PANEL).inner_margin(Margin::same(0)))
            .show(ctx, |ui| {
                let hdr = Rect::from_min_size(ui.max_rect().min, Vec2::new(ui.available_width(), 22.0));
                ui.painter().rect_filled(hdr, 0, Color32::from_rgb(36, 36, 40));
                ui.add_space(3.0);
                ui.horizontal(|ui| {
                    ui.add_space(8.0);
                    ui.label(egui::RichText::new("Palette").strong().size(12.0).color(TEXT));
                });
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.add_space(6.0);
                    Frame::new()
                        .fill(Color32::from_rgb(56, 56, 62))
                        .stroke(Stroke::new(1.0, Color32::from_rgb(78, 78, 86)))
                        .inner_margin(Margin::symmetric(6, 3))
                        .corner_radius(2)
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.search)
                                    .hint_text("search")
                                    .desired_width(ui.available_width() - 18.0)
                                    .frame(false)
                                    .font(FontId::proportional(12.0)),
                            );
                        });
                });
                ui.add_space(4.0);
                let q = self.search.to_lowercase();
                let groups: Vec<(String, Vec<Operator>)> = self
                    .catalog
                    .groups()
                    .into_iter()
                    .map(|(g, ops)| {
                        let ops: Vec<Operator> = ops
                            .into_iter()
                            .filter(|o| {
                                q.is_empty()
                                    || o.title.to_lowercase().contains(&q)
                                    || o.id.to_lowercase().contains(&q)
                                    || g.to_lowercase().contains(&q)
                            })
                            .cloned()
                            .collect();
                        (g, ops)
                    })
                    .filter(|(_, ops)| !ops.is_empty())
                    .collect();
                let mut drop_click: Option<Operator> = None;
                egui::ScrollArea::vertical()
                    .id_salt("pal_scroll")
                    .max_height(ui.available_height() - 118.0)
                    .show(ui, |ui| {
                        for (group, ops) in &groups {
                            egui::CollapsingHeader::new(
                                egui::RichText::new(group).size(11.0).color(MUTED).strong(),
                            )
                            .default_open(true)
                            .show(ui, |ui| {
                                for op in ops {
                                    let col = family_color(&op.id);
                                    let ir = ui.dnd_drag_source(
                                        Id::new(("pal", op.id.as_str())),
                                        op.id.clone(),
                                        |ui| {
                                            let (r, resp) = ui.allocate_exact_size(
                                                Vec2::new(ui.available_width(), 20.0),
                                                Sense::click(),
                                            );
                                            let bg = if self.pal_hover.as_deref() == Some(op.id.as_str()) {
                                                Color32::from_rgb(58, 58, 68)
                                            } else {
                                                Color32::TRANSPARENT
                                            };
                                            ui.painter().rect_filled(r, 0, bg);
                                            ui.painter().rect_filled(
                                                Rect::from_min_size(r.min, Vec2::new(3.0, r.height())),
                                                0,
                                                col,
                                            );
                                            ui.painter().text(
                                                r.min + Vec2::new(10.0, 3.0),
                                                egui::Align2::LEFT_TOP,
                                                &op.title,
                                                FontId::proportional(12.0),
                                                TEXT,
                                            );
                                            resp
                                        },
                                    );
                                    if ir.response.hovered() {
                                        self.pal_hover = Some(op.id.clone());
                                    }
                                    if ir.inner.clicked() || ir.response.clicked() {
                                        drop_click = Some(op.clone());
                                    }
                                }
                            });
                        }
                    });
                if let Some(op) = drop_click {
                    self.drop_op(&op, self.last_graph_pos);
                }

                ui.separator();
                ui.horizontal(|ui| {
                    ui.add_space(6.0);
                    ui.label(egui::RichText::new("Info").size(11.0).color(MUTED).strong());
                });
                if let Some(id) = &self.pal_hover {
                    if let Ok(op) = self.catalog.get(id) {
                        ui.add_space(2.0);
                        ui.horizontal(|ui| {
                            ui.add_space(8.0);
                            ui.label(egui::RichText::new(&op.title).size(12.0).color(TEXT));
                        });
                        ui.horizontal(|ui| {
                            ui.add_space(8.0);
                            ui.label(egui::RichText::new(&op.id).size(10.0).color(MUTED).monospace());
                        });
                        ui.horizontal(|ui| {
                            ui.add_space(8.0);
                            for p in &op.ports.r#in {
                                let c = port_color(p.ty);
                                ui.label(egui::RichText::new(format!("▶ {}", p.name)).size(10.0).color(c));
                            }
                            for p in &op.ports.out {
                                let c = port_color(p.ty);
                                ui.label(egui::RichText::new(format!("{} ▶", p.name)).size(10.0).color(c));
                            }
                        });
                        if let Some(c) = &op.conda {
                            ui.horizontal(|ui| {
                                ui.add_space(8.0);
                                ui.label(
                                    egui::RichText::new(format!("conda  {}", c.name))
                                        .size(10.0)
                                        .color(MUTED),
                                );
                            });
                        }
                    }
                } else {
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        ui.add_space(8.0);
                        ui.label(egui::RichText::new("hover an operator").size(11.0).color(MUTED).italics());
                    });
                }
            });

        let selected_id = self.selected.clone();
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
                                ui.label(egui::RichText::new(&node_name).size(15.0).strong().color(Color32::WHITE));
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
                                    common_page(ui, &op, self.viewer_off.contains(id));
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
                                    {
                                        if !self.viewer_off.remove(id) {
                                            self.viewer_off.insert(id.clone());
                                        }
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
                                        let node = &mut self.graph.nodes[nidx];
                                        let entry = node.params.entry(k.clone()).or_insert_with(|| {
                                            spec.default.clone().unwrap_or(ParamValue::String(String::new()))
                                        });
                                        param_row(ui, &label, entry, spec.min, spec.max);
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

                if resp.hovered() {
                    let scroll = ui.input(|i| i.smooth_scroll_delta.y);
                    if scroll.abs() > 0.1 {
                        self.auto_fit = false;
                        let old = self.zoom;
                        self.zoom = (self.zoom * (1.0 + scroll * 0.0015)).clamp(0.3, 2.8);
                        if let Some(ptr) = resp.hover_pos() {
                            let f = self.zoom / old;
                            self.pan = (self.pan - (ptr - origin)) * f + (ptr - origin);
                        }
                    }
                    ui.ctx().set_cursor_icon(if self.wire.is_some() {
                        CursorIcon::Crosshair
                    } else {
                        CursorIcon::Default
                    });
                }
                if resp.dragged() && ui.input(|i| i.pointer.secondary_down() || i.pointer.middle_down()) {
                    self.auto_fit = false;
                    self.pan += resp.drag_delta();
                }

                draw_grid(&painter, resp.rect, self.pan, self.zoom);

                if let Some(pos) = ctx.pointer_latest_pos() {
                    self.cursor = pos;
                }

                let edges = self.graph.edges.clone();
                for e in &edges {
                    let Some(a) = self.graph.node(&e.from_node) else { continue };
                    let Some(b) = self.graph.node(&e.to_node) else { continue };
                    let Some(ap) = a.port(&e.from_port, Direction::Out) else { continue };
                    let Some(bp) = b.port(&e.to_port, Direction::In) else { continue };
                    let p0 = self.port_pos(origin, a, ap);
                    let p1 = self.port_pos(origin, b, bp);
                    let failed = matches!(self.last_states.get(&e.from_node), Some(NodeState::Failed));
                    let col = if failed {
                        Color32::from_rgb(220, 80, 80)
                    } else {
                        port_color(ap.ty)
                    };
                    bezier(&painter, p0, p1, col, cooking, t);
                }

                self.hover_port = None;
                let mut hit_port: Option<(String, String, bool)> = None;
                let mut hit_node: Option<String> = None;
                let mut hit_flag: Option<String> = None;
                let mut hit_resize: Option<String> = None;
                let mut info_hit: Option<String> = None;
                let mut snap_cursor = self.cursor;

                let src_ty: Option<(PortType, Vec<PortType>, bool)> = self.wire.as_ref().and_then(|(nid, pname, is_out)| {
                    let n = self.graph.node(nid)?;
                    let p = n.port(pname, if *is_out { Direction::Out } else { Direction::In })?;
                    Some((p.ty, p.union.clone(), *is_out))
                });

                let nodes: Vec<Node> = self.graph.nodes.clone();
                let mut quote_tip: Option<(Pos2, String)> = None;
                for n in &nodes {
                    let r = self.node_rect(origin, n);
                    let sel = self.selected.as_deref() == Some(n.id.as_str());
                    let z = self.zoom;
                    let hovered = resp.hover_pos().map(|p| r.contains(p)).unwrap_or(false);

                    painter.rect_filled(r, CornerRadius::same(2), NODE);
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
                    painter.rect_stroke(r, 2, stroke, egui::StrokeKind::Outside);

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
                                    hit_port = Some((n.id.clone(), p.name.clone(), p.dir == Direction::Out));
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

                if let Some((nid, pname, is_out)) = &self.wire.clone() {
                    if let Some(n) = self.graph.node(nid) {
                        if let Some(p) = n.port(pname, if *is_out { Direction::Out } else { Direction::In }) {
                            let p0 = self.port_pos(origin, n, p);
                            bezier(&painter, p0, snap_cursor, SELECT, true, t);
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

                if resp.drag_started() && ui.input(|i| i.pointer.primary_down()) {
                    if let Some(hp) = hit_port.clone() {
                        self.wire = Some(hp);
                        self.dragging = None;
                    } else if let Some(id) = &hit_resize {
                        self.resizing = Some(id.clone());
                    } else if let Some(pos) = resp.interact_pointer_pos() {
                        let hit = nodes.iter().rev().find(|n| self.node_rect(origin, n).contains(pos));
                        if let Some(n) = hit {
                            if hit_flag.is_none() {
                                self.dragging = Some(n.id.clone());
                                self.selected = Some(n.id.clone());
                                self.param_page.clear();
                            }
                        } else {
                            self.selected = None;
                        }
                    }
                }
                if resp.dragged() && ui.input(|i| i.pointer.primary_down()) && self.wire.is_none() {
                    let d = resp.drag_delta() / self.zoom;
                    if let Some(id) = &self.resizing.clone() {
                        let sz = self.sizes.entry(id.clone()).or_insert(Vec2::new(NODE_W, NODE_H));
                        sz.x = (sz.x + d.x).clamp(90.0, 360.0);
                        sz.y = (sz.y + d.y).clamp(56.0, 280.0);
                    } else if let Some(id) = &self.dragging {
                        if let Some(n) = self.graph.nodes.iter_mut().find(|n| n.id == *id) {
                            n.layout.x += d.x;
                            n.layout.y += d.y;
                        }
                    }
                }
                if resp.drag_stopped() {
                    if let Some((fnid, fp, is_out)) = self.wire.clone() {
                        if let Some(pos) = ctx.pointer_latest_pos() {
                            for n in &nodes {
                                for p in &n.ports {
                                    let c = self.port_pos(origin, n, p);
                                    if c.distance(pos) < 18.0 * self.zoom {
                                        if is_out && p.dir == Direction::In {
                                            self.try_wire(&fnid, &fp, &n.id, &p.name);
                                        } else if !is_out && p.dir == Direction::Out {
                                            self.try_wire(&n.id, &p.name, &fnid, &fp);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    self.wire = None;
                    self.dragging = None;
                    self.resizing = None;
                }
                if let Some(id) = hit_node.clone() {
                    self.selected = Some(id);
                    self.param_page.clear();
                }
                if resp.clicked() && hit_node.is_none() && hit_port.is_none() && hit_flag.is_none() {
                    if let Some(pos) = resp.interact_pointer_pos() {
                        let on_node = nodes.iter().any(|n| self.node_rect(origin, n).contains(pos));
                        if !on_node {
                            self.selected = None;
                            self.last_graph_pos = self.to_graph(origin, pos);
                        }
                    }
                }
                if let Some(id) = hit_flag {
                    if resp.clicked() {
                        if !self.viewer_off.remove(&id) {
                            self.viewer_off.insert(id);
                        }
                    }
                }
                if let Some(id) = info_hit {
                    self.info = Some(id);
                }
                if resp.double_clicked() {
                    if let Some(pos) = resp.interact_pointer_pos() {
                        let on_node = nodes.iter().any(|n| self.node_rect(origin, n).contains(pos));
                        if !on_node {
                            self.last_graph_pos = self.to_graph(origin, pos);
                            self.op_create = true;
                            self.op_create_q.clear();
                            self.op_create_i = 0;
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
            if self.op_create_i >= ops.len() && !ops.is_empty() {
                self.op_create_i = ops.len() - 1;
            }
            egui::Window::new("opcreate")
                .title_bar(false)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, -40.0])
                .frame(
                    Frame::new()
                        .fill(Color32::from_rgb(30, 30, 34))
                        .stroke(Stroke::new(1.0, ACCENT.gamma_multiply(0.6)))
                        .inner_margin(Margin::same(10))
                        .corner_radius(4),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(320.0);
                    ui.label(egui::RichText::new("Add Operator").size(11.0).color(MUTED));
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
                    ui.label(egui::RichText::new("esc to close  ·  tab toggles").size(10.0).color(MUTED));
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

fn param_row(ui: &mut egui::Ui, label: &str, entry: &mut ParamValue, min: Option<i64>, max: Option<i64>) {
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.add_sized(
            Vec2::new(72.0, 18.0),
            egui::Label::new(egui::RichText::new(label).color(MUTED).size(11.0)).halign(egui::Align::RIGHT),
        );
        ui.add_space(6.0);
        match entry {
            ParamValue::String(s) => {
                ui.add(
                    egui::TextEdit::singleline(s)
                        .desired_width(ui.available_width() - 8.0)
                        .font(FontId::proportional(12.0)),
                );
            }
            ParamValue::Int(i) => {
                let mut dv = egui::DragValue::new(i).speed(1.0);
                if let Some(a) = min {
                    dv = dv.range(a..=max.unwrap_or(i64::MAX));
                }
                ui.add(dv);
            }
            ParamValue::Float(f) => {
                ui.add(egui::DragValue::new(f).speed(0.01));
            }
            ParamValue::Bool(b) => {
                ui.checkbox(b, "");
            }
        }
    });
    ui.add_space(3.0);
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
}
