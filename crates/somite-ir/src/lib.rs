//! Typed graph IR. If `compatible(src, dst)` is false, the wire does not exist.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 2;
pub const LEGACY_SCHEMA_VERSION: u32 = 1;
pub const MAX_GRAPH_NAME_CHARS: usize = 100;
pub const MAX_ANNOTATION_TEXT_CHARS: usize = 5_000;
pub const MAX_STROKE_POINTS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum PortType {
    Sra,
    Fastq,
    FastqGz,
    Fasta,
    FastaGz,
    Gtf,
    GtfGz,
    Gff3,
    Sam,
    Bam,
    Bai,
    Vcf,
    VcfGz,
    Bed,
    Agp,
    Chain,
    Table,
    Json,
    Html,
    Image,
    Zip,
    Directory,
    Text,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    Out,
}

/// `dst` accepts `src`. Equal always. Union only on the *input*.
pub fn compatible(src: PortType, dst: PortType, dst_union: &[PortType]) -> bool {
    if src == dst {
        return true;
    }
    dst_union.contains(&src)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Port {
    pub name: String,
    pub dir: Direction,
    pub ty: PortType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub union: Vec<PortType>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasColor {
    Yellow,
    Orange,
    Rose,
    Violet,
    Blue,
    Teal,
    Green,
    Gray,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CanvasAnnotation {
    Sticky {
        id: String,
        text: String,
        color: CanvasColor,
        layout: Layout,
        width: f32,
        height: f32,
    },
    Box {
        id: String,
        text: String,
        color: CanvasColor,
        layout: Layout,
        width: f32,
        height: f32,
    },
    Stroke {
        id: String,
        color: CanvasColor,
        points: Vec<Layout>,
    },
}

impl CanvasAnnotation {
    pub fn id(&self) -> &str {
        match self {
            Self::Sticky { id, .. } | Self::Box { id, .. } | Self::Stroke { id, .. } => id,
        }
    }

    fn is_valid(&self) -> bool {
        let text_is_valid = |text: &str| {
            text.chars().count() <= MAX_ANNOTATION_TEXT_CHARS
                && !text.chars().any(|character| {
                    character.is_control() && character != '\n' && character != '\t'
                })
        };
        let point_is_valid = |point: &Layout| point.x.is_finite() && point.y.is_finite();
        match self {
            Self::Sticky {
                text,
                layout,
                width,
                height,
                ..
            }
            | Self::Box {
                text,
                layout,
                width,
                height,
                ..
            } => {
                text_is_valid(text)
                    && point_is_valid(layout)
                    && width.is_finite()
                    && height.is_finite()
                    && *width >= 80.0
                    && *height >= 60.0
                    && *width <= 4_000.0
                    && *height <= 4_000.0
            }
            Self::Stroke { points, .. } => {
                (2..=MAX_STROKE_POINTS).contains(&points.len()) && points.iter().all(point_is_valid)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub operator: String,
    /// Immutable execution-semantic revision of `operator`.
    ///
    /// Schema v1 graphs omit this field and must be migrated through the exact
    /// operator catalog before they are validated or persisted again.
    #[serde(default)]
    pub operator_revision: String,
    pub ports: Vec<Port>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, ParamValue>,
    pub layout: Layout,
    /// Paper quote, wrap hint, or other human note. Not in the cook key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Optional user-authored presentation color. Not in executable identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CanvasColor>,
}

impl Node {
    pub fn port(&self, name: &str, dir: Direction) -> Option<&Port> {
        self.ports.iter().find(|p| p.name == name && p.dir == dir)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub from_node: String,
    pub from_port: String,
    pub to_node: String,
    pub to_port: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    pub schema_version: u32,
    /// User-controlled document name. It travels with the graph but does not
    /// participate in executable identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    /// Human-authored canvas notes and marks. Not in executable identity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<CanvasAnnotation>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IrError {
    #[error("schema_version {0} != {SCHEMA_VERSION}")]
    Schema(u32),
    #[error("graph name must be 1 to {MAX_GRAPH_NAME_CHARS} characters and contain no control characters")]
    InvalidGraphName,
    #[error("node {node} does not pin an operator revision")]
    UnpinnedOperator { node: String },
    #[error("duplicate id {0}")]
    DuplicateId(String),
    #[error("unknown node {0}")]
    UnknownNode(String),
    #[error("unknown port {node}.{port}")]
    UnknownPort { node: String, port: String },
    #[error("edge {0} expects out→in")]
    Direction(String),
    #[error("type mismatch {from} → {to}")]
    Type { from: String, to: String },
    #[error("cycle")]
    Cycle,
    #[error("self-edge {0}")]
    SelfEdge(String),
    #[error("multiple edges target scalar input {node}.{port}")]
    MultipleInputs { node: String, port: String },
    #[error("invalid canvas annotation {0}")]
    InvalidAnnotation(String),
}

impl Graph {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn validate(&self) -> Result<(), IrError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(IrError::Schema(self.schema_version));
        }
        if self.name.as_ref().is_some_and(|name| {
            let trimmed = name.trim();
            trimmed.is_empty()
                || trimmed.chars().count() > MAX_GRAPH_NAME_CHARS
                || trimmed.chars().any(char::is_control)
        }) {
            return Err(IrError::InvalidGraphName);
        }
        let mut ids = BTreeSet::new();
        for n in &self.nodes {
            if n.operator_revision.trim().is_empty() {
                return Err(IrError::UnpinnedOperator { node: n.id.clone() });
            }
            if !ids.insert(n.id.clone()) {
                return Err(IrError::DuplicateId(n.id.clone()));
            }
        }
        let mut bound_inputs = BTreeSet::new();
        for e in &self.edges {
            if !ids.insert(e.id.clone()) {
                return Err(IrError::DuplicateId(e.id.clone()));
            }
            if e.from_node == e.to_node {
                return Err(IrError::SelfEdge(e.id.clone()));
            }
            let src_n = self
                .node(&e.from_node)
                .ok_or_else(|| IrError::UnknownNode(e.from_node.clone()))?;
            let dst_n = self
                .node(&e.to_node)
                .ok_or_else(|| IrError::UnknownNode(e.to_node.clone()))?;
            let src_p =
                src_n
                    .port(&e.from_port, Direction::Out)
                    .ok_or_else(|| IrError::UnknownPort {
                        node: e.from_node.clone(),
                        port: e.from_port.clone(),
                    })?;
            let dst_p =
                dst_n
                    .port(&e.to_port, Direction::In)
                    .ok_or_else(|| IrError::UnknownPort {
                        node: e.to_node.clone(),
                        port: e.to_port.clone(),
                    })?;
            if src_p.dir != Direction::Out || dst_p.dir != Direction::In {
                return Err(IrError::Direction(e.id.clone()));
            }
            if !compatible(src_p.ty, dst_p.ty, &dst_p.union) {
                return Err(IrError::Type {
                    from: format!("{}.{}:{:?}", e.from_node, e.from_port, src_p.ty),
                    to: format!("{}.{}:{:?}", e.to_node, e.to_port, dst_p.ty),
                });
            }
            if !bound_inputs.insert((e.to_node.as_str(), e.to_port.as_str())) {
                return Err(IrError::MultipleInputs {
                    node: e.to_node.clone(),
                    port: e.to_port.clone(),
                });
            }
        }
        for annotation in &self.annotations {
            if !ids.insert(annotation.id().to_owned()) {
                return Err(IrError::DuplicateId(annotation.id().to_owned()));
            }
            if !annotation.is_valid() {
                return Err(IrError::InvalidAnnotation(annotation.id().to_owned()));
            }
        }
        if has_cycle(self) {
            return Err(IrError::Cycle);
        }
        Ok(())
    }

    /// Kahn order. Empty if the graph is cyclic (call `validate` first).
    pub fn topo(&self) -> Vec<String> {
        let mut adj: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut indeg: BTreeMap<&str, usize> = BTreeMap::new();
        for n in &self.nodes {
            adj.entry(n.id.as_str()).or_default();
            indeg.entry(n.id.as_str()).or_insert(0);
        }
        for e in &self.edges {
            adj.entry(e.from_node.as_str())
                .or_default()
                .push(e.to_node.as_str());
            *indeg.entry(e.to_node.as_str()).or_insert(0) += 1;
        }
        let mut ready: Vec<&str> = indeg
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(k, _)| *k)
            .collect();
        ready.sort();
        let mut q: VecDeque<&str> = ready.into();
        let mut out = Vec::new();
        while let Some(u) = q.pop_front() {
            out.push(u.to_string());
            let mut nxt: Vec<&str> = adj.get(u).cloned().unwrap_or_default();
            nxt.sort();
            for v in nxt {
                if let Some(d) = indeg.get_mut(v) {
                    *d -= 1;
                    if *d == 0 {
                        q.push_back(v);
                    }
                }
            }
        }
        out
    }
}

fn has_cycle(g: &Graph) -> bool {
    let mut adj: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut indeg: BTreeMap<&str, usize> = BTreeMap::new();
    for n in &g.nodes {
        adj.entry(n.id.as_str()).or_default();
        indeg.entry(n.id.as_str()).or_insert(0);
    }
    for e in &g.edges {
        adj.entry(e.from_node.as_str())
            .or_default()
            .push(e.to_node.as_str());
        *indeg.entry(e.to_node.as_str()).or_insert(0) += 1;
    }
    let mut q: VecDeque<&str> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| *k)
        .collect();
    let mut seen = 0;
    while let Some(u) = q.pop_front() {
        seen += 1;
        for v in adj.get(u).into_iter().flatten() {
            if let Some(d) = indeg.get_mut(v) {
                *d -= 1;
                if *d == 0 {
                    q.push_back(v);
                }
            }
        }
    }
    seen != g.nodes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, op: &str, ports: Vec<Port>, x: f32) -> Node {
        Node {
            id: id.into(),
            operator: op.into(),
            operator_revision: "test-revision".into(),
            ports,
            params: BTreeMap::new(),
            layout: Layout { x, y: 0.0 },
            note: None,
            color: None,
        }
    }

    fn out(name: &str, ty: PortType) -> Port {
        Port {
            name: name.into(),
            dir: Direction::Out,
            ty,
            union: vec![],
            optional: false,
        }
    }

    fn inn(name: &str, ty: PortType) -> Port {
        Port {
            name: name.into(),
            dir: Direction::In,
            ty,
            union: vec![],
            optional: false,
        }
    }

    fn inn_union(name: &str, ty: PortType, union: Vec<PortType>) -> Port {
        Port {
            name: name.into(),
            dir: Direction::In,
            ty,
            union,
            optional: false,
        }
    }

    fn e(id: &str, a: &str, ap: &str, b: &str, bp: &str) -> Edge {
        Edge {
            id: id.into(),
            from_node: a.into(),
            from_port: ap.into(),
            to_node: b.into(),
            to_port: bp.into(),
        }
    }

    #[test]
    fn snap_fastq_to_fastqc() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![
                n(
                    "n_src",
                    "files.import",
                    vec![out("fastq", PortType::FastqGz)],
                    0.0,
                ),
                n(
                    "n_qc",
                    "qc.fastqc",
                    vec![
                        inn_union(
                            "fastq",
                            PortType::Fastq,
                            vec![PortType::Fastq, PortType::FastqGz],
                        ),
                        out("preview", PortType::Preview),
                    ],
                    200.0,
                ),
            ],
            edges: vec![e("e1", "n_src", "fastq", "n_qc", "fastq")],
            annotations: vec![],
        };
        g.validate().expect("should snap");
    }

    #[test]
    fn refuse_bam_into_fastqc() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![
                n("a", "align.star", vec![out("bam", PortType::Bam)], 0.0),
                n("b", "qc.fastqc", vec![inn("fastq", PortType::FastqGz)], 1.0),
            ],
            edges: vec![e("e1", "a", "bam", "b", "fastq")],
            annotations: vec![],
        };
        assert!(matches!(g.validate(), Err(IrError::Type { .. })));
    }

    #[test]
    fn scalar_input_rejects_multiple_edges() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![
                n(
                    "r1",
                    "files.import",
                    vec![out("fastq", PortType::Fastq)],
                    0.0,
                ),
                n(
                    "r2",
                    "files.import",
                    vec![out("fastq", PortType::Fastq)],
                    0.0,
                ),
                n("qc", "qc.fastqc", vec![inn("fastq", PortType::Fastq)], 1.0),
            ],
            edges: vec![
                e("e1", "r1", "fastq", "qc", "fastq"),
                e("e2", "r2", "fastq", "qc", "fastq"),
            ],
            annotations: vec![],
        };

        assert_eq!(
            g.validate(),
            Err(IrError::MultipleInputs {
                node: "qc".into(),
                port: "fastq".into(),
            })
        );
    }

    #[test]
    fn cycle_is_illegal() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![
                n(
                    "a",
                    "x",
                    vec![inn("i", PortType::Text), out("o", PortType::Text)],
                    0.0,
                ),
                n(
                    "b",
                    "y",
                    vec![inn("i", PortType::Text), out("o", PortType::Text)],
                    1.0,
                ),
            ],
            edges: vec![e("e1", "a", "o", "b", "i"), e("e2", "b", "o", "a", "i")],
            annotations: vec![],
        };
        assert_eq!(g.validate(), Err(IrError::Cycle));
    }

    #[test]
    fn json_roundtrip() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: Some("RNA-seq QC".into()),
            nodes: vec![n(
                "n_a",
                "files.import",
                vec![out("fastq", PortType::FastqGz)],
                0.0,
            )],
            edges: vec![],
            annotations: vec![CanvasAnnotation::Sticky {
                id: "note-1".into(),
                text: "Check adapters".into(),
                color: CanvasColor::Yellow,
                layout: Layout { x: 40.0, y: 80.0 },
                width: 220.0,
                height: 140.0,
            }],
        };
        let s = serde_json::to_string(&g).unwrap();
        let h: Graph = serde_json::from_str(&s).unwrap();
        assert_eq!(g, h);
        h.validate().unwrap();
    }

    #[test]
    fn graph_name_is_optional_but_must_be_a_usable_document_title() {
        let unnamed: Graph =
            serde_json::from_str(r#"{"schema_version":2,"nodes":[],"edges":[]}"#).unwrap();
        assert_eq!(unnamed.name, None);
        unnamed.validate().unwrap();

        let mut invalid = unnamed.clone();
        invalid.name = Some("   ".into());
        assert_eq!(invalid.validate(), Err(IrError::InvalidGraphName));
        invalid.name = Some("x".repeat(MAX_GRAPH_NAME_CHARS + 1));
        assert_eq!(invalid.validate(), Err(IrError::InvalidGraphName));
        invalid.name = Some("line\nbreak".into());
        assert_eq!(invalid.validate(), Err(IrError::InvalidGraphName));
    }

    #[test]
    fn canvas_annotations_are_validated_without_becoming_execution_nodes() {
        let mut graph: Graph = serde_json::from_str(
            r#"{"schema_version":2,"nodes":[],"edges":[],"annotations":[{"id":"stroke-1","kind":"stroke","color":"teal","points":[{"x":0.0,"y":0.0},{"x":12.0,"y":8.0}]}]}"#,
        )
        .unwrap();
        graph.validate().unwrap();
        graph.annotations.push(CanvasAnnotation::Sticky {
            id: "stroke-1".into(),
            text: String::new(),
            color: CanvasColor::Yellow,
            layout: Layout { x: 0.0, y: 0.0 },
            width: 220.0,
            height: 140.0,
        });
        assert_eq!(
            graph.validate(),
            Err(IrError::DuplicateId("stroke-1".into()))
        );
    }

    #[test]
    fn empty_ok() {
        Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![],
            edges: vec![],
            annotations: vec![],
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn dangling_edge() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![n("n_a", "x", vec![out("o", PortType::Text)], 0.0)],
            edges: vec![e("e1", "n_a", "o", "missing", "i")],
            annotations: vec![],
        };
        assert!(matches!(g.validate(), Err(IrError::UnknownNode(_))));
    }
}
