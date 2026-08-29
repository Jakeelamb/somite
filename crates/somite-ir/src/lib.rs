//! Typed graph IR. If `compatible(src, dst)` is false, the wire does not exist.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 3;
/// Largest integer that round-trips exactly through JSON and JavaScript's
/// IEEE-754 number representation.
pub const MAX_EXACT_JSON_INTEGER: i64 = 9_007_199_254_740_991;
pub const MIN_EXACT_JSON_INTEGER: i64 = -MAX_EXACT_JSON_INTEGER;
/// Largest integral `f64` bound that round-trips unchanged through the
/// persisted JSON representation used by [`WorkflowParameterField`].
///
/// Integer values use [`MAX_EXACT_JSON_INTEGER`]. Bounds are one unit narrower
/// because deserializing a decimal `f64` at the outer safe-integer boundary can
/// round it to the adjacent even integer.
pub const MAX_EXACT_JSON_INTEGER_BOUND: i64 = MAX_EXACT_JSON_INTEGER - 1;
pub const MIN_EXACT_JSON_INTEGER_BOUND: i64 = -MAX_EXACT_JSON_INTEGER_BOUND;
pub const LEGACY_SCHEMA_VERSION: u32 = 1;
pub const PINNED_SCHEMA_VERSION: u32 = 2;
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

impl ParamValue {
    /// Construct the one persisted representation that survives a
    /// JSON.parse/JSON.stringify round trip in a browser.
    ///
    /// Integral floats inside JavaScript's safe-integer domain become `Int`,
    /// including negative zero. Integral floats outside that domain and
    /// non-finite values have no lossless browser representation.
    pub fn from_f64(value: f64) -> Option<Self> {
        if !value.is_finite() {
            return None;
        }
        if value.fract() != 0.0 {
            return Some(Self::Float(value));
        }
        let integer = value as i64;
        (exact_json_integer(integer) && integer as f64 == value).then_some(Self::Int(integer))
    }

    /// Normalize a value before it enters persisted graph or source state.
    pub fn canonicalized(self) -> Option<Self> {
        match self {
            Self::Float(value) => Self::from_f64(value),
            Self::Int(value) if !exact_json_integer(value) => None,
            value => Some(value),
        }
    }

    /// Whether serialization through browser JSON preserves this variant and
    /// numeric value exactly.
    pub fn is_json_transport_stable(&self) -> bool {
        match self {
            Self::Float(value) => value.is_finite() && value.fract() != 0.0,
            Self::Int(value) => exact_json_integer(*value),
            Self::Bool(_) | Self::String(_) => true,
        }
    }

    /// JSON Schema compares numbers mathematically, not by the integer/float
    /// representation chosen while a JSON transport is deserialized.
    pub fn schema_equal(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Int(left), Self::Float(right)) => {
                (MIN_EXACT_JSON_INTEGER..=MAX_EXACT_JSON_INTEGER).contains(left)
                    && (*left as f64) == *right
            }
            (Self::Float(left), Self::Int(right)) => {
                (MIN_EXACT_JSON_INTEGER..=MAX_EXACT_JSON_INTEGER).contains(right)
                    && *left == (*right as f64)
            }
            _ => self == other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceProvider {
    NfCore,
    Local,
}

/// Shared transport and persistence bounds for source-backed workflow identity.
/// Importers and IR validation use the same values so a workflow accepted at
/// the source seam cannot become invalid after serialization and reload.
pub const MAX_SOURCE_PATH_BYTES: usize = 4 * 1024;
pub const MAX_SOURCE_LABEL_BYTES: usize = 4 * 1024;
pub const MAX_SOURCE_PROFILES: usize = 64;
pub const MAX_SOURCE_PROFILE_BYTES: usize = 256;
pub const MAX_SOURCE_PROFILE_TOTAL_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowSourcePin {
    pub provider: SourceProvider,
    pub repository: String,
    pub requested_revision: String,
    pub resolved_revision: String,
    pub source_digest: String,
    pub entrypoint: String,
    pub file_count: u32,
    pub source_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowParameterType {
    String,
    Integer,
    Number,
    Boolean,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowParameterField {
    pub name: String,
    pub label: String,
    pub group: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub help: String,
    #[serde(rename = "type")]
    pub ty: WorkflowParameterType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub managed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ParamValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<ParamValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
}

/// A required upstream parameter whose JSON Schema contract Somite cannot
/// faithfully express as a typed editable field.
///
/// Retaining this separately prevents an unsupported object, array, or schema
/// composition from disappearing from readiness simply because it cannot be
/// rendered by the first source-workflow editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsupportedRequiredWorkflowParameter {
    pub name: String,
    pub label: String,
    pub group: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub reason: String,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowBinding {
    ProjectFile { path: String },
    ProjectDirectory { path: String },
    Literal { value: ParamValue },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceScopeKind {
    EntryWorkflow,
    Workflow,
    Process,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceScope {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    pub kind: SourceScopeKind,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceInvocation {
    pub id: String,
    pub caller: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callee: Option<String>,
    pub span: SourceSpan,
}

/// A user-authored substitution anchored to one immutable source invocation.
/// Connection certainty is assessed separately; an incomplete contract never
/// prevents the creative edit from being retained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceInvocationReplacement {
    pub invocation_id: String,
    pub operator: String,
    pub operator_revision: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, ParamValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SourceCapabilities {
    pub exact_execution: bool,
    pub parameter_edits: bool,
    pub hierarchy_indexed: bool,
    pub structural_edits: bool,
    pub channel_contracts: bool,
    pub source_edits: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<SourceSpan>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceWorkflowInstance {
    pub schema_version: u32,
    pub workflow_revision: String,
    pub source: WorkflowSourcePin,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<WorkflowParameterField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unsupported_required_parameters: Vec<UnsupportedRequiredWorkflowParameter>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bindings: BTreeMap<String, WorkflowBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<SourceScope>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invocations: Vec<SourceInvocation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replacements: Vec<SourceInvocationReplacement>,
    #[serde(default)]
    pub capabilities: SourceCapabilities,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<SourceDiagnostic>,
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
    /// Exact source, configuration, and source-anchored outline for a
    /// source-backed workflow. The outer Node is only its collapsed canvas
    /// presentation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workflow: Option<SourceWorkflowInstance>,
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

/// Immutable source view retained after one or more invocations cross into a
/// native editable graph. The mapping is provenance only: the live Nodes and
/// Edges remain the sole executable truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceWorkflowVariantOrigin {
    pub source_node: Node,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub promoted_invocations: BTreeMap<String, String>,
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
    /// Exact imported source retained after promotion into a Native workflow
    /// variant. It is provenance, never a hidden executable layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_origin: Option<SourceWorkflowVariantOrigin>,
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
    #[error("node {node} has invalid source workflow: {detail}")]
    InvalidSourceWorkflow { node: String, detail: String },
    #[error("node {node} parameter {parameter} is not stable through browser JSON")]
    InvalidParameterValue { node: String, parameter: String },
    #[error("invalid native workflow variant origin: {0}")]
    InvalidVariantOrigin(String),
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
            if let Some((parameter, _)) = n
                .params
                .iter()
                .find(|(_, value)| !value.is_json_transport_stable())
            {
                return Err(IrError::InvalidParameterValue {
                    node: n.id.clone(),
                    parameter: parameter.clone(),
                });
            }
            if let Some(workflow) = &n.source_workflow {
                workflow
                    .validate()
                    .map_err(|detail| IrError::InvalidSourceWorkflow {
                        node: n.id.clone(),
                        detail,
                    })?;
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
        if let Some(origin) = &self.variant_origin {
            if self.nodes.iter().any(|node| node.source_workflow.is_some()) {
                return Err(IrError::InvalidVariantOrigin(
                    "a native variant cannot execute source-backed Nodes".to_owned(),
                ));
            }
            let workflow = origin.source_node.source_workflow.as_ref().ok_or_else(|| {
                IrError::InvalidVariantOrigin(
                    "the retained source Node has no source workflow".to_owned(),
                )
            })?;
            if origin.source_node.operator_revision.trim().is_empty() {
                return Err(IrError::InvalidVariantOrigin(
                    "the retained source Node has no pinned Operator revision".to_owned(),
                ));
            }
            workflow.validate().map_err(IrError::InvalidVariantOrigin)?;
            let mut promoted_nodes = BTreeSet::new();
            for (invocation_id, node_id) in &origin.promoted_invocations {
                if !workflow
                    .invocations
                    .iter()
                    .any(|invocation| invocation.id == *invocation_id)
                {
                    return Err(IrError::InvalidVariantOrigin(format!(
                        "unknown promoted source invocation {invocation_id}"
                    )));
                }
                if self.node(node_id).is_none() {
                    return Err(IrError::InvalidVariantOrigin(format!(
                        "promoted invocation {invocation_id} references missing Node {node_id}"
                    )));
                }
                if !promoted_nodes.insert(node_id) {
                    return Err(IrError::InvalidVariantOrigin(format!(
                        "multiple source invocations map to Node {node_id}"
                    )));
                }
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

impl SourceWorkflowInstance {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!("schema_version {} != 1", self.schema_version));
        }
        if !valid_digest(&self.workflow_revision) || !valid_digest(&self.source.source_digest) {
            return Err("workflow and source revisions must be full blake3 digests".to_owned());
        }
        for (field, value) in [
            ("repository", self.source.repository.as_str()),
            (
                "requested_revision",
                self.source.requested_revision.as_str(),
            ),
            ("resolved_revision", self.source.resolved_revision.as_str()),
        ] {
            if value.trim().is_empty()
                || value.chars().any(char::is_control)
                || value.len() > MAX_SOURCE_LABEL_BYTES
            {
                return Err(format!(
                    "{field} must be bounded, non-empty, and contain no control characters"
                ));
            }
        }
        if !canonical_git_object_id(&self.source.resolved_revision) {
            return Err(
                "resolved_revision must be a canonical lowercase full Git object ID".to_owned(),
            );
        }
        if !safe_relative_path(&self.source.entrypoint) {
            return Err("entrypoint must be a safe relative path".to_owned());
        }
        if self.source.file_count == 0 || self.source.source_bytes == 0 {
            return Err("source manifest must contain at least one non-empty file".to_owned());
        }
        let profile_bytes = self
            .profiles
            .iter()
            .map(String::len)
            .try_fold(0_usize, usize::checked_add);
        if self.profiles.len() > MAX_SOURCE_PROFILES
            || profile_bytes.is_none_or(|bytes| bytes > MAX_SOURCE_PROFILE_TOTAL_BYTES)
            || self.profiles.iter().any(|profile| {
                profile.trim().is_empty()
                    || profile.chars().any(char::is_control)
                    || profile.len() > MAX_SOURCE_PROFILE_BYTES
            })
        {
            return Err(
                "profiles must be bounded, non-empty, and contain no control characters".to_owned(),
            );
        }

        let mut parameter_names = BTreeSet::new();
        for parameter in &self.parameters {
            if parameter.name.trim().is_empty()
                || parameter.name.chars().any(char::is_control)
                || !parameter_names.insert(parameter.name.as_str())
            {
                return Err("parameter names must be unique, non-empty, and printable".to_owned());
            }
            if parameter
                .minimum
                .is_some_and(|value| !value.is_finite() || is_negative_zero(value))
                || parameter
                    .maximum
                    .is_some_and(|value| !value.is_finite() || is_negative_zero(value))
                || matches!((parameter.minimum, parameter.maximum), (Some(min), Some(max)) if min > max)
                || [parameter.minimum, parameter.maximum]
                    .into_iter()
                    .flatten()
                    .any(|bound| !exact_json_numeric_bound(bound))
            {
                return Err(format!(
                    "parameter {} has invalid numeric bounds",
                    parameter.name
                ));
            }
            if parameter.ty == WorkflowParameterType::Integer
                && [parameter.minimum, parameter.maximum]
                    .into_iter()
                    .flatten()
                    .any(|bound| !exact_json_integer_f64(bound))
            {
                return Err(format!(
                    "integer parameter {} has a bound outside the exact JSON integer domain",
                    parameter.name
                ));
            }
            if let Some(default) = &parameter.default {
                if matches!(
                    parameter.format.as_deref(),
                    Some("file-path" | "directory-path" | "path")
                ) && !matches!(default, ParamValue::String(path) if safe_relative_path(path))
                {
                    return Err(format!(
                        "parameter {} has an unsafe project path default",
                        parameter.name
                    ));
                }
                validate_parameter_value(parameter, default)?;
            }
            for choice in &parameter.choices {
                if matches!(
                    parameter.format.as_deref(),
                    Some("file-path" | "directory-path" | "path")
                ) && !matches!(choice, ParamValue::String(path) if safe_relative_path(path))
                {
                    return Err(format!(
                        "parameter {} has an unsafe project path choice",
                        parameter.name
                    ));
                }
                validate_parameter_value(parameter, choice)?;
            }
        }
        let mut unsupported_names = BTreeSet::new();
        for parameter in &self.unsupported_required_parameters {
            if parameter.name.trim().is_empty()
                || parameter.name.chars().any(char::is_control)
                || parameter.label.trim().is_empty()
                || parameter.label.chars().any(char::is_control)
                || parameter.group.trim().is_empty()
                || parameter.group.chars().any(char::is_control)
                || parameter.reason.trim().is_empty()
                || parameter.reason.chars().any(char::is_control)
                || !unsupported_names.insert(parameter.name.as_str())
                || parameter_names.contains(parameter.name.as_str())
            {
                return Err(
                    "unsupported required parameter contracts must be unique, non-empty, printable, and distinct from editable parameters"
                        .to_owned(),
                );
            }
        }
        for (name, binding) in &self.bindings {
            let parameter = self
                .parameters
                .iter()
                .find(|parameter| parameter.name == *name)
                .ok_or_else(|| format!("binding {name} has no parameter contract"))?;
            match binding {
                WorkflowBinding::ProjectFile { path } => {
                    if parameter.ty != WorkflowParameterType::String
                        || !matches!(parameter.format.as_deref(), Some("file-path" | "path"))
                    {
                        return Err(format!("binding {name} is not declared as a file path"));
                    }
                    if !safe_relative_path(path) {
                        return Err(format!("binding {name} has an invalid project file path"));
                    }
                    validate_path_choice(parameter, path)?;
                }
                WorkflowBinding::ProjectDirectory { path } => {
                    if parameter.ty != WorkflowParameterType::String
                        || !matches!(parameter.format.as_deref(), Some("directory-path" | "path"))
                    {
                        return Err(format!(
                            "binding {name} is not declared as a directory path"
                        ));
                    }
                    if !safe_relative_path(path) {
                        return Err(format!(
                            "binding {name} has an invalid project directory path"
                        ));
                    }
                    validate_path_choice(parameter, path)?;
                }
                WorkflowBinding::Literal { value } => {
                    if matches!(
                        parameter.format.as_deref(),
                        Some("file-path" | "directory-path" | "path")
                    ) {
                        return Err(format!(
                            "binding {name} requires an explicit project path binding"
                        ));
                    }
                    validate_parameter_value(parameter, value)?;
                }
            }
        }

        let mut scope_ids = BTreeSet::new();
        for scope in &self.scopes {
            if scope.id.trim().is_empty() || !scope_ids.insert(scope.id.as_str()) {
                return Err("scope ids must be unique and non-empty".to_owned());
            }
            validate_span(&scope.span)?;
        }
        let mut invocation_ids = BTreeSet::new();
        for invocation in &self.invocations {
            if invocation.id.trim().is_empty() || !invocation_ids.insert(invocation.id.as_str()) {
                return Err("invocation ids must be unique and non-empty".to_owned());
            }
            if !scope_ids.contains(invocation.caller.as_str()) {
                return Err(format!(
                    "invocation {} has an unknown caller",
                    invocation.id
                ));
            }
            if invocation
                .callee
                .as_deref()
                .is_some_and(|callee| !scope_ids.contains(callee))
            {
                return Err(format!(
                    "invocation {} has an unknown callee",
                    invocation.id
                ));
            }
            validate_span(&invocation.span)?;
        }
        let mut replacement_invocations = BTreeSet::new();
        for replacement in &self.replacements {
            if !invocation_ids.contains(replacement.invocation_id.as_str()) {
                return Err(format!(
                    "replacement has unknown invocation {}",
                    replacement.invocation_id
                ));
            }
            if !replacement_invocations.insert(replacement.invocation_id.as_str()) {
                return Err(format!(
                    "invocation {} has more than one replacement",
                    replacement.invocation_id
                ));
            }
            if replacement.operator.trim().is_empty()
                || replacement.operator.len() > MAX_SOURCE_LABEL_BYTES
                || replacement.operator.chars().any(char::is_control)
                || !valid_digest(&replacement.operator_revision)
                || replacement.params.iter().any(|(name, value)| {
                    name.trim().is_empty()
                        || name.chars().any(char::is_control)
                        || !value.is_json_transport_stable()
                })
            {
                return Err(format!(
                    "replacement for {} has an invalid operator contract",
                    replacement.invocation_id
                ));
            }
        }
        Ok(())
    }
}

impl WorkflowParameterField {
    pub fn validate_value(&self, value: &ParamValue) -> Result<(), String> {
        validate_parameter_value(self, value)
    }
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn canonical_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_path(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.trim().is_empty()
        && value.len() <= MAX_SOURCE_PATH_BYTES
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn validate_span(span: &SourceSpan) -> Result<(), String> {
    if !safe_relative_path(&span.path) || span.start_line == 0 || span.end_line < span.start_line {
        return Err("source spans require a safe path and ordered one-based lines".to_owned());
    }
    Ok(())
}

fn validate_parameter_value(
    parameter: &WorkflowParameterField,
    value: &ParamValue,
) -> Result<(), String> {
    if !value.is_json_transport_stable() {
        return Err(format!(
            "parameter {} is not stable through browser JSON",
            parameter.name
        ));
    }
    let valid_type = matches!(
        (parameter.ty, value),
        (WorkflowParameterType::String, ParamValue::String(_))
            | (WorkflowParameterType::Integer, ParamValue::Int(_))
            | (
                WorkflowParameterType::Number,
                ParamValue::Int(_) | ParamValue::Float(_)
            )
            | (WorkflowParameterType::Boolean, ParamValue::Bool(_))
    );
    if !valid_type {
        return Err(format!(
            "parameter {} has the wrong value type",
            parameter.name
        ));
    }
    if matches!(value, ParamValue::Int(value) if !exact_json_integer(*value)) {
        return Err(format!(
            "parameter {} is outside the exact JSON integer domain",
            parameter.name
        ));
    }
    if parameter.ty == WorkflowParameterType::Integer {
        let ParamValue::Int(value) = value else {
            return Err(format!(
                "parameter {} has the wrong value type",
                parameter.name
            ));
        };
        let minimum = parameter.minimum.map(|bound| bound as i64);
        let maximum = parameter.maximum.map(|bound| bound as i64);
        if minimum.is_some_and(|minimum| *value < minimum)
            || maximum.is_some_and(|maximum| *value > maximum)
        {
            return Err(format!(
                "parameter {} is outside its numeric bounds",
                parameter.name
            ));
        }
    }
    let numeric = match value {
        ParamValue::Int(value) if parameter.ty != WorkflowParameterType::Integer => {
            Some(*value as f64)
        }
        ParamValue::Float(value) => Some(*value),
        ParamValue::Int(_) | ParamValue::Bool(_) | ParamValue::String(_) => None,
    };
    if numeric.is_some_and(|value| {
        !value.is_finite()
            || parameter.minimum.is_some_and(|minimum| value < minimum)
            || parameter.maximum.is_some_and(|maximum| value > maximum)
    }) {
        return Err(format!(
            "parameter {} is outside its numeric bounds",
            parameter.name
        ));
    }
    if !parameter.choices.is_empty()
        && !parameter
            .choices
            .iter()
            .any(|choice| choice.schema_equal(value))
    {
        return Err(format!(
            "parameter {} is not an allowed choice",
            parameter.name
        ));
    }
    Ok(())
}

fn validate_path_choice(parameter: &WorkflowParameterField, path: &str) -> Result<(), String> {
    if !parameter.choices.is_empty()
        && !parameter
            .choices
            .iter()
            .any(|choice| matches!(choice, ParamValue::String(value) if value == path))
    {
        return Err(format!(
            "parameter {} is not an allowed path choice",
            parameter.name
        ));
    }
    Ok(())
}

fn exact_json_integer(value: i64) -> bool {
    (MIN_EXACT_JSON_INTEGER..=MAX_EXACT_JSON_INTEGER).contains(&value)
}

fn exact_json_integer_f64(value: f64) -> bool {
    value.fract() == 0.0 && exact_json_numeric_bound(value)
}

fn exact_json_numeric_bound(value: f64) -> bool {
    value.is_finite()
        && !is_negative_zero(value)
        && value >= MIN_EXACT_JSON_INTEGER_BOUND as f64
        && value <= MAX_EXACT_JSON_INTEGER_BOUND as f64
}

fn is_negative_zero(value: f64) -> bool {
    value == 0.0 && value.is_sign_negative()
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
            source_workflow: None,
            layout: Layout { x, y: 0.0 },
            note: None,
            color: None,
        }
    }

    fn source_workflow() -> SourceWorkflowInstance {
        SourceWorkflowInstance {
            schema_version: 1,
            workflow_revision: format!("blake3:{}", "a".repeat(64)),
            source: WorkflowSourcePin {
                provider: SourceProvider::NfCore,
                repository: "nf-core/pangenome".into(),
                requested_revision: "1.1.3".into(),
                resolved_revision: "3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337".into(),
                source_digest: format!("blake3:{}", "b".repeat(64)),
                entrypoint: "main.nf".into(),
                file_count: 170,
                source_bytes: 1_286_324,
            },
            profiles: Vec::new(),
            parameters: vec![WorkflowParameterField {
                name: "input".into(),
                label: "Input samplesheet".into(),
                group: "Input/output options".into(),
                description: String::new(),
                help: String::new(),
                ty: WorkflowParameterType::String,
                required: true,
                hidden: false,
                managed: false,
                format: Some("file-path".into()),
                pattern: None,
                default: None,
                choices: Vec::new(),
                minimum: None,
                maximum: None,
            }],
            unsupported_required_parameters: Vec::new(),
            bindings: BTreeMap::from([(
                "input".into(),
                WorkflowBinding::ProjectFile {
                    path: "data/samples.csv".into(),
                },
            )]),
            scopes: vec![SourceScope {
                id: "scope:main".into(),
                title: "Pangenome".into(),
                symbol: None,
                kind: SourceScopeKind::EntryWorkflow,
                span: SourceSpan {
                    path: "main.nf".into(),
                    start_line: 1,
                    end_line: 100,
                },
            }],
            invocations: Vec::new(),
            replacements: Vec::new(),
            capabilities: SourceCapabilities {
                exact_execution: false,
                parameter_edits: true,
                hierarchy_indexed: true,
                structural_edits: false,
                channel_contracts: false,
                source_edits: false,
            },
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn source_identity_paths_and_profiles_are_bounded_after_deserialization() {
        let mut workflow = source_workflow();
        workflow.source.repository = "r".repeat(MAX_SOURCE_LABEL_BYTES + 1);
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.source.entrypoint = "a".repeat(MAX_SOURCE_PATH_BYTES + 1);
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.profiles = vec!["test".to_owned(); MAX_SOURCE_PROFILES + 1];
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.profiles = vec!["p".repeat(MAX_SOURCE_PROFILE_BYTES + 1)];
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.source.resolved_revision = "A".repeat(40);
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.workflow_revision = format!("blake3:{}", "A".repeat(64));
        assert!(workflow.validate().is_err());
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
            variant_origin: None,
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
            variant_origin: None,
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
            variant_origin: None,
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
            variant_origin: None,
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
            variant_origin: None,
        };
        let s = serde_json::to_string(&g).unwrap();
        let h: Graph = serde_json::from_str(&s).unwrap();
        assert_eq!(g, h);
        h.validate().unwrap();
    }

    #[test]
    fn graph_name_is_optional_but_must_be_a_usable_document_title() {
        let unnamed: Graph = serde_json::from_value(serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "nodes": [],
            "edges": []
        }))
        .unwrap();
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
        let mut graph: Graph = serde_json::from_value(serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "nodes": [],
            "edges": [],
            "annotations": [{
                "id": "stroke-1",
                "kind": "stroke",
                "color": "teal",
                "points": [{"x": 0.0, "y": 0.0}, {"x": 12.0, "y": 8.0}]
            }]
        }))
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
            variant_origin: None,
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn source_workflow_roundtrips_and_validates_its_persisted_contract() {
        let mut node = n("pangenome", "workflow.source", Vec::new(), 0.0);
        let mut workflow = source_workflow();
        workflow.capabilities.parameter_edits = true;
        workflow
            .unsupported_required_parameters
            .push(UnsupportedRequiredWorkflowParameter {
                name: "sample_overrides".into(),
                label: "Sample overrides".into(),
                group: "Input/output options".into(),
                description: "Per-sample override records".into(),
                reason: "type is not a supported primitive".into(),
                hidden: false,
            });
        node.source_workflow = Some(workflow);
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            name: Some("Pangenome".into()),
            nodes: vec![node],
            edges: Vec::new(),
            annotations: Vec::new(),
            variant_origin: None,
        };
        graph.validate().unwrap();
        let encoded = serde_json::to_vec(&graph).unwrap();
        let decoded: Graph = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, graph);
        assert_eq!(
            decoded.nodes[0]
                .source_workflow
                .as_ref()
                .unwrap()
                .unsupported_required_parameters[0]
                .name,
            "sample_overrides"
        );
        decoded.validate().unwrap();
    }

    #[test]
    fn source_workflow_rejects_unsafe_source_and_invalid_bindings() {
        let mut workflow = source_workflow();
        workflow.source.entrypoint = "../main.nf".into();
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.source.entrypoint = "workflows\\main.nf".into();
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.source.entrypoint = "workflows/ma\nin.nf".into();
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.bindings.insert(
            "input".into(),
            WorkflowBinding::Literal {
                value: ParamValue::Bool(true),
            },
        );
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow.bindings.insert(
            "input".into(),
            WorkflowBinding::ProjectFile { path: "   ".into() },
        );
        assert!(workflow.validate().is_err());

        let mut workflow = source_workflow();
        workflow
            .unsupported_required_parameters
            .push(UnsupportedRequiredWorkflowParameter {
                name: "input".into(),
                label: "Input".into(),
                group: "Inputs".into(),
                description: String::new(),
                reason: "array schemas are not editable".into(),
                hidden: false,
            });
        assert!(workflow.validate().is_err());
    }

    #[test]
    fn source_workflow_rejects_project_paths_outside_schema_choices() {
        let mut workflow = source_workflow();
        workflow.parameters[0].choices = vec![
            ParamValue::String("data/allowed.fa".into()),
            ParamValue::String("data/other.fa".into()),
        ];
        workflow.bindings.insert(
            "input".into(),
            WorkflowBinding::ProjectFile {
                path: "data/not-allowed.fa".into(),
            },
        );
        assert!(workflow.validate().is_err());

        workflow.bindings.insert(
            "input".into(),
            WorkflowBinding::ProjectFile {
                path: "data/allowed.fa".into(),
            },
        );
        workflow.validate().expect("allowed project path choice");

        workflow.parameters[0].choices = vec![ParamValue::String("   ".into())];
        workflow.bindings.clear();
        assert!(workflow.validate().is_err());
    }

    #[test]
    fn source_integer_contracts_and_bindings_roundtrip_without_json_rounding() {
        let integer = WorkflowParameterField {
            name: "large_id".into(),
            label: "Large ID".into(),
            group: "Parameters".into(),
            description: String::new(),
            help: String::new(),
            ty: WorkflowParameterType::Integer,
            required: false,
            hidden: false,
            managed: false,
            format: None,
            pattern: None,
            default: Some(ParamValue::Int(MAX_EXACT_JSON_INTEGER)),
            choices: vec![
                ParamValue::Int(MIN_EXACT_JSON_INTEGER),
                ParamValue::Int(MAX_EXACT_JSON_INTEGER),
            ],
            minimum: None,
            maximum: None,
        };
        let bounded_integer = WorkflowParameterField {
            name: "bounded_count".into(),
            label: "Bounded count".into(),
            group: "Parameters".into(),
            description: String::new(),
            help: String::new(),
            ty: WorkflowParameterType::Integer,
            required: false,
            hidden: false,
            managed: false,
            format: None,
            pattern: None,
            default: Some(ParamValue::Int(0)),
            choices: Vec::new(),
            minimum: Some(MIN_EXACT_JSON_INTEGER_BOUND as f64),
            maximum: Some(MAX_EXACT_JSON_INTEGER_BOUND as f64),
        };
        let mut workflow = source_workflow();
        workflow.parameters = vec![integer, bounded_integer];
        workflow.bindings.clear();
        workflow.validate().expect("safe integer boundary contract");
        workflow.bindings.insert(
            "large_id".into(),
            WorkflowBinding::Literal {
                value: ParamValue::Int(MAX_EXACT_JSON_INTEGER),
            },
        );
        workflow.validate().expect("safe integer boundary binding");
        let encoded = serde_json::to_vec(&workflow).expect("serialize safe integer workflow");
        assert!(String::from_utf8_lossy(&encoded).contains("9007199254740991"));
        let decoded: SourceWorkflowInstance =
            serde_json::from_slice(&encoded).expect("deserialize safe integer workflow");
        assert_eq!(decoded, workflow);
        decoded
            .validate()
            .expect("round-tripped safe integer workflow");

        for unsafe_value in [
            MAX_EXACT_JSON_INTEGER + 1,
            MAX_EXACT_JSON_INTEGER + 2,
            MIN_EXACT_JSON_INTEGER - 1,
        ] {
            let mut invalid = workflow.clone();
            invalid.bindings.insert(
                "large_id".into(),
                WorkflowBinding::Literal {
                    value: ParamValue::Int(unsafe_value),
                },
            );
            assert!(invalid.validate().is_err());
        }

        let mut invalid_bound = workflow.clone();
        invalid_bound
            .parameters
            .iter_mut()
            .find(|parameter| parameter.name == "bounded_count")
            .expect("bounded integer parameter")
            .maximum = Some(MAX_EXACT_JSON_INTEGER as f64);
        assert!(invalid_bound.validate().is_err());
        let mut invalid_default = workflow.clone();
        invalid_default.parameters[0].default = Some(ParamValue::Int(MAX_EXACT_JSON_INTEGER + 1));
        assert!(invalid_default.validate().is_err());
        let mut invalid_choice = workflow;
        invalid_choice.parameters[0].default = None;
        invalid_choice.parameters[0].choices = vec![ParamValue::Int(MIN_EXACT_JSON_INTEGER - 1)];
        assert!(invalid_choice.validate().is_err());
    }

    #[test]
    fn number_enum_bindings_use_json_numeric_equality_across_transport_variants() {
        let number = WorkflowParameterField {
            name: "threshold".into(),
            label: "Threshold".into(),
            group: "Parameters".into(),
            description: String::new(),
            help: String::new(),
            ty: WorkflowParameterType::Number,
            required: true,
            hidden: false,
            managed: false,
            format: None,
            pattern: None,
            default: None,
            choices: vec![ParamValue::Int(1), ParamValue::Int(0)],
            minimum: None,
            maximum: None,
        };
        let mut workflow = source_workflow();
        workflow.parameters = vec![number];
        workflow.bindings.clear();

        for encoded in [
            r#"{"kind":"literal","value":1}"#,
            r#"{"kind":"literal","value":0}"#,
        ] {
            let binding: WorkflowBinding =
                serde_json::from_str(encoded).expect("browser-style numeric binding JSON");
            workflow.bindings.insert("threshold".into(), binding);
            workflow
                .validate()
                .expect("JSON-equivalent numeric enum binding");
        }
        workflow.bindings.insert(
            "threshold".into(),
            WorkflowBinding::Literal {
                value: ParamValue::Float(2.0),
            },
        );
        assert!(workflow.validate().is_err());
    }

    #[test]
    fn parameter_numbers_have_one_browser_stable_persisted_representation() {
        assert_eq!(ParamValue::from_f64(1.0), Some(ParamValue::Int(1)));
        assert_eq!(ParamValue::from_f64(-0.0), Some(ParamValue::Int(0)));
        assert_eq!(ParamValue::from_f64(0.25), Some(ParamValue::Float(0.25)));
        assert_eq!(
            ParamValue::from_f64(MAX_EXACT_JSON_INTEGER as f64),
            Some(ParamValue::Int(MAX_EXACT_JSON_INTEGER))
        );
        assert_eq!(
            ParamValue::from_f64((MAX_EXACT_JSON_INTEGER + 1) as f64),
            None
        );
        assert_eq!(ParamValue::from_f64(f64::INFINITY), None);

        let mut workflow = source_workflow();
        workflow.parameters = vec![WorkflowParameterField {
            name: "threshold".into(),
            label: "Threshold".into(),
            group: "Parameters".into(),
            description: String::new(),
            help: String::new(),
            ty: WorkflowParameterType::Number,
            required: false,
            hidden: false,
            managed: false,
            format: None,
            pattern: None,
            default: Some(ParamValue::Float(1.0)),
            choices: Vec::new(),
            minimum: None,
            maximum: None,
        }];
        workflow.bindings.clear();
        assert!(workflow.validate().is_err());

        workflow.parameters[0].default = Some(ParamValue::Int(1));
        workflow.parameters[0].minimum = Some(-0.0);
        assert!(workflow.validate().is_err());
        workflow.parameters[0].minimum = Some(0.0);
        workflow.validate().expect("canonical number contract");

        let mut graph = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![n("n", "test.number", Vec::new(), 0.0)],
            edges: Vec::new(),
            annotations: Vec::new(),
            variant_origin: None,
        };
        graph.nodes[0]
            .params
            .insert("threshold".into(), ParamValue::Float(-0.0));
        assert!(matches!(
            graph.validate(),
            Err(IrError::InvalidParameterValue { node, parameter })
                if node == "n" && parameter == "threshold"
        ));
        graph.nodes[0]
            .params
            .insert("threshold".into(), ParamValue::Int(0));
        graph.validate().expect("canonical native graph value");
    }

    #[test]
    fn dangling_edge() {
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![n("n_a", "x", vec![out("o", PortType::Text)], 0.0)],
            edges: vec![e("e1", "n_a", "o", "missing", "i")],
            annotations: vec![],
            variant_origin: None,
        };
        assert!(matches!(g.validate(), Err(IrError::UnknownNode(_))));
    }
}
