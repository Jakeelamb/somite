//! Link immutable operator bindings into a target-specific execution closure.
//!
//! Materialization and Pixi solving stay outside this pure Module. Callers link
//! first, resolve the emitted manifest, then freeze with the exact lock bytes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use somite_ir::{Edge, Graph, ParamValue, Port};
use somite_ops::{Catalog, Operator};
use thiserror::Error;

pub const CLOSURE_SCHEMA_VERSION: u32 = 1;
pub const EVIDENCE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum LinkError {
    #[error("operator catalog: {0}")]
    Catalog(#[from] somite_ops::OpsError),
    #[error("invalid graph: {0}")]
    Graph(#[from] somite_ir::IrError),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("target platform must not be empty")]
    EmptyTarget,
    #[error("Pixi lock is empty")]
    EmptyLock,
    #[error("evidence field {0} must not be empty")]
    EmptyEvidenceField(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkOptions {
    pub target_platform: String,
    pub compiler_identity: String,
    pub nextflow_identity: String,
    pub openjdk_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorRevisionManifest {
    pub schema_version: u32,
    pub operator_id: String,
    pub revision: String,
    pub operator: Operator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorPin {
    pub operator_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentIdentity {
    pub manifest_digest: String,
    pub lock_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunClosureDraft {
    pub schema_version: u32,
    pub graph_revision: String,
    pub target_platform: String,
    pub operators: Vec<OperatorPin>,
    pub environment_manifest_digest: String,
    pub compiler_identity: String,
    pub nextflow_identity: String,
    pub openjdk_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunClosure {
    pub schema_version: u32,
    pub closure_digest: String,
    pub graph_revision: String,
    pub target_platform: String,
    pub operators: Vec<OperatorPin>,
    pub environment: EnvironmentIdentity,
    pub compiler_identity: String,
    pub nextflow_identity: String,
    pub openjdk_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkPlan {
    pub draft: RunClosureDraft,
    pub operator_manifests: Vec<OperatorRevisionManifest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceResult {
    Passed,
    Failed,
    Inconclusive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceReceipt {
    pub receipt_digest: String,
    #[serde(default)]
    pub recorded_at_unix_ms: u64,
    pub subject_digest: String,
    #[serde(default)]
    pub observed_closure_digest: Option<String>,
    pub kind: String,
    pub scope: String,
    #[serde(default)]
    pub configuration_digest: String,
    pub fixture_digests: Vec<String>,
    pub verifier: String,
    pub result: EvidenceResult,
    #[serde(default)]
    pub node_results: BTreeMap<String, EvidenceResult>,
    #[serde(default)]
    pub edge_results: BTreeMap<String, EvidenceResult>,
    pub artifact_digests: Vec<String>,
    pub log_digests: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceDraft {
    pub recorded_at_unix_ms: u64,
    pub subject_digest: String,
    pub observed_closure_digest: Option<String>,
    pub kind: String,
    pub scope: String,
    pub configuration_digest: String,
    pub fixture_digests: Vec<String>,
    pub verifier: String,
    pub result: EvidenceResult,
    pub node_results: BTreeMap<String, EvidenceResult>,
    pub edge_results: BTreeMap<String, EvidenceResult>,
    pub artifact_digests: Vec<String>,
    pub log_digests: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceIndex {
    pub schema_version: u32,
    pub receipts: Vec<EvidenceReceipt>,
}

impl Default for EvidenceIndex {
    fn default() -> Self {
        Self {
            schema_version: EVIDENCE_SCHEMA_VERSION,
            receipts: Vec::new(),
        }
    }
}

impl EvidenceIndex {
    pub fn insert(&mut self, receipt: EvidenceReceipt) -> bool {
        if self
            .receipts
            .iter()
            .any(|existing| existing.receipt_digest == receipt.receipt_digest)
        {
            return false;
        }
        self.receipts.push(receipt);
        self.receipts.sort_by(|left, right| {
            left.recorded_at_unix_ms
                .cmp(&right.recorded_at_unix_ms)
                .then_with(|| left.receipt_digest.cmp(&right.receipt_digest))
        });
        true
    }
}

/// Finalize immutable evidence without folding it into executable identity.
pub fn evidence_receipt(mut draft: EvidenceDraft) -> Result<EvidenceReceipt, LinkError> {
    for (field, value) in [
        ("subject_digest", draft.subject_digest.as_str()),
        ("kind", draft.kind.as_str()),
        ("scope", draft.scope.as_str()),
        ("configuration_digest", draft.configuration_digest.as_str()),
        ("verifier", draft.verifier.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(LinkError::EmptyEvidenceField(field));
        }
    }
    draft.fixture_digests.sort();
    draft.fixture_digests.dedup();
    draft.artifact_digests.sort();
    draft.artifact_digests.dedup();
    draft.log_digests.sort();
    draft.log_digests.dedup();
    let receipt_digest = digest(&serde_json::to_vec(&EvidenceMaterial::from(&draft))?);
    Ok(EvidenceReceipt {
        receipt_digest,
        recorded_at_unix_ms: draft.recorded_at_unix_ms,
        subject_digest: draft.subject_digest,
        observed_closure_digest: draft.observed_closure_digest,
        kind: draft.kind,
        scope: draft.scope,
        configuration_digest: draft.configuration_digest,
        fixture_digests: draft.fixture_digests,
        verifier: draft.verifier,
        result: draft.result,
        node_results: draft.node_results,
        edge_results: draft.edge_results,
        artifact_digests: draft.artifact_digests,
        log_digests: draft.log_digests,
    })
}

#[derive(Serialize)]
struct EvidenceMaterial<'a> {
    recorded_at_unix_ms: u64,
    subject_digest: &'a str,
    observed_closure_digest: &'a Option<String>,
    kind: &'a str,
    scope: &'a str,
    configuration_digest: &'a str,
    fixture_digests: &'a [String],
    verifier: &'a str,
    result: EvidenceResult,
    node_results: &'a BTreeMap<String, EvidenceResult>,
    edge_results: &'a BTreeMap<String, EvidenceResult>,
    artifact_digests: &'a [String],
    log_digests: &'a [String],
}

impl<'a> From<&'a EvidenceDraft> for EvidenceMaterial<'a> {
    fn from(draft: &'a EvidenceDraft) -> Self {
        Self {
            recorded_at_unix_ms: draft.recorded_at_unix_ms,
            subject_digest: &draft.subject_digest,
            observed_closure_digest: &draft.observed_closure_digest,
            kind: &draft.kind,
            scope: &draft.scope,
            configuration_digest: &draft.configuration_digest,
            fixture_digests: &draft.fixture_digests,
            verifier: &draft.verifier,
            result: draft.result,
            node_results: &draft.node_results,
            edge_results: &draft.edge_results,
            artifact_digests: &draft.artifact_digests,
            log_digests: &draft.log_digests,
        }
    }
}

/// Resolve a pinned graph and exact catalog snapshot into a target link plan.
pub fn link(
    graph: &Graph,
    catalog: &Catalog,
    pixi_manifest: &[u8],
    options: &LinkOptions,
) -> Result<LinkPlan, LinkError> {
    if options.target_platform.trim().is_empty() {
        return Err(LinkError::EmptyTarget);
    }
    graph.validate()?;
    catalog.verify_graph(graph)?;

    let mut operator_ids = graph
        .nodes
        .iter()
        .map(|node| node.operator.clone())
        .collect::<Vec<_>>();
    operator_ids.sort();
    operator_ids.dedup();

    let mut operator_manifests = Vec::with_capacity(operator_ids.len());
    let mut operators = Vec::with_capacity(operator_ids.len());
    for operator_id in operator_ids {
        let operator = catalog.get(&operator_id)?;
        let revision = operator.revision()?;
        operators.push(OperatorPin {
            operator_id: operator_id.clone(),
            revision: revision.clone(),
        });
        operator_manifests.push(OperatorRevisionManifest {
            schema_version: 1,
            operator_id,
            revision,
            operator: operator.clone(),
        });
    }

    Ok(LinkPlan {
        draft: RunClosureDraft {
            schema_version: CLOSURE_SCHEMA_VERSION,
            graph_revision: semantic_graph_revision(graph)?,
            target_platform: options.target_platform.clone(),
            operators,
            environment_manifest_digest: digest(pixi_manifest),
            compiler_identity: options.compiler_identity.clone(),
            nextflow_identity: options.nextflow_identity.clone(),
            openjdk_identity: options.openjdk_identity.clone(),
        },
        operator_manifests,
    })
}

/// Freeze a link plan after Pixi has resolved the exact target lock.
pub fn freeze(draft: &RunClosureDraft, pixi_lock: &[u8]) -> Result<RunClosure, LinkError> {
    if pixi_lock.is_empty() {
        return Err(LinkError::EmptyLock);
    }
    #[derive(Serialize)]
    struct ClosureMaterial<'a> {
        draft: &'a RunClosureDraft,
        lock_digest: &'a str,
    }

    let lock_digest = digest(pixi_lock);
    let closure_digest = digest(&serde_json::to_vec(&ClosureMaterial {
        draft,
        lock_digest: &lock_digest,
    })?);
    Ok(RunClosure {
        schema_version: draft.schema_version,
        closure_digest,
        graph_revision: draft.graph_revision.clone(),
        target_platform: draft.target_platform.clone(),
        operators: draft.operators.clone(),
        environment: EnvironmentIdentity {
            manifest_digest: draft.environment_manifest_digest.clone(),
            lock_digest,
        },
        compiler_identity: draft.compiler_identity.clone(),
        nextflow_identity: draft.nextflow_identity.clone(),
        openjdk_identity: draft.openjdk_identity.clone(),
    })
}

pub fn semantic_graph_revision(graph: &Graph) -> Result<String, LinkError> {
    #[derive(Serialize)]
    struct SemanticNode<'a> {
        id: &'a str,
        operator: &'a str,
        operator_revision: &'a str,
        ports: &'a [Port],
        params: &'a BTreeMap<String, ParamValue>,
    }

    #[derive(Serialize)]
    struct SemanticGraph<'a> {
        schema_version: u32,
        nodes: Vec<SemanticNode<'a>>,
        edges: Vec<&'a Edge>,
    }

    let mut nodes = graph
        .nodes
        .iter()
        .map(|node| SemanticNode {
            id: &node.id,
            operator: &node.operator,
            operator_revision: &node.operator_revision,
            ports: &node.ports,
            params: &node.params,
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| left.id.cmp(right.id));
    let mut edges = graph.edges.iter().collect::<Vec<_>>();
    edges.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(digest(&serde_json::to_vec(&SemanticGraph {
        schema_version: graph.schema_version,
        nodes,
        edges,
    })?))
}

/// Hash the complete editable graph document for compare-and-swap writes.
/// Unlike executable identity, this deliberately includes layout and notes.
pub fn graph_state_revision(graph: &Graph) -> Result<String, LinkError> {
    graph.validate()?;
    Ok(digest(&serde_json::to_vec(graph)?))
}

fn digest(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;
    use somite_ir::{CanvasAnnotation, CanvasColor, Layout, Node, SCHEMA_VERSION};

    fn fixture() -> (Graph, Catalog) {
        let operator: Operator = serde_json::from_str(
            r#"{"id":"test.echo","title":"Echo","palette":[],"kind":"external","bin":"echo","pixi":[],"ports":{}}"#,
        )
        .expect("operator");
        let revision = operator.revision().expect("revision");
        let mut catalog = Catalog::default();
        catalog.ops.insert(operator.id.clone(), operator);
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![Node {
                id: "echo1".into(),
                operator: "test.echo".into(),
                operator_revision: revision,
                ports: Vec::new(),
                params: BTreeMap::new(),
                layout: Layout { x: 0.0, y: 0.0 },
                note: None,
                color: None,
            }],
            edges: Vec::new(),
            annotations: Vec::new(),
        };
        (graph, catalog)
    }

    fn options() -> LinkOptions {
        LinkOptions {
            target_platform: "linux-64".into(),
            compiler_identity: "somite-nextflow@0.1.0".into(),
            nextflow_identity: "nextflow@26.04.6".into(),
            openjdk_identity: "openjdk@25.0.2".into(),
        }
    }

    #[test]
    fn presentation_edits_do_not_change_the_semantic_graph_revision() {
        let (graph, _) = fixture();
        let mut moved = graph.clone();
        moved.name = Some("Renamed workflow".into());
        moved.nodes[0].layout = Layout { x: 800.0, y: -40.0 };
        moved.nodes[0].note = Some("presentation only".into());
        moved.nodes[0].color = Some(CanvasColor::Violet);
        moved.annotations.push(CanvasAnnotation::Box {
            id: "box-1".into(),
            text: "Analysis".into(),
            color: CanvasColor::Violet,
            layout: Layout { x: 700.0, y: -80.0 },
            width: 360.0,
            height: 220.0,
        });
        assert_eq!(
            semantic_graph_revision(&graph).unwrap(),
            semantic_graph_revision(&moved).unwrap()
        );
        assert_ne!(
            graph_state_revision(&graph).unwrap(),
            graph_state_revision(&moved).unwrap()
        );
    }

    #[test]
    fn parameters_change_the_semantic_graph_revision() {
        let (graph, _) = fixture();
        let mut changed = graph.clone();
        changed.nodes[0]
            .params
            .insert("message".into(), ParamValue::String("hello".into()));
        assert_ne!(
            semantic_graph_revision(&graph).unwrap(),
            semantic_graph_revision(&changed).unwrap()
        );
    }

    #[test]
    fn lock_bytes_finalize_a_deterministic_closure() {
        let (graph, catalog) = fixture();
        let plan = link(&graph, &catalog, b"[workspace]\n", &options()).unwrap();
        let first = freeze(&plan.draft, b"version: 6\n").unwrap();
        let second = freeze(&plan.draft, b"version: 6\n").unwrap();
        assert_eq!(first, second);
        assert_ne!(
            first.closure_digest,
            freeze(&plan.draft, b"version: 7\n").unwrap().closure_digest
        );
    }

    #[test]
    fn stale_operator_pin_is_rejected() {
        let (mut graph, catalog) = fixture();
        graph.nodes[0].operator_revision = "blake3:stale".into();
        assert!(link(&graph, &catalog, b"[workspace]\n", &options()).is_err());
    }

    #[test]
    fn evidence_is_deterministic_append_only_and_separate_from_the_closure() {
        let (graph, catalog) = fixture();
        let closure = freeze(
            &link(&graph, &catalog, b"[workspace]\n", &options())
                .unwrap()
                .draft,
            b"version: 6\n",
        )
        .unwrap();
        let draft = EvidenceDraft {
            recorded_at_unix_ms: 1_787_718_000_000,
            subject_digest: closure.graph_revision.clone(),
            observed_closure_digest: Some(closure.closure_digest.clone()),
            kind: "configuration_validation".into(),
            scope: "graph_e2e".into(),
            configuration_digest: "blake3:fixture-config".into(),
            fixture_digests: vec!["blake3:b".into(), "blake3:a".into()],
            verifier: "somite-nextflow@0.1.0".into(),
            result: EvidenceResult::Passed,
            node_results: BTreeMap::from([("echo1".into(), EvidenceResult::Passed)]),
            edge_results: BTreeMap::new(),
            artifact_digests: vec!["blake3:output".into()],
            log_digests: vec!["blake3:log".into()],
        };
        let first = evidence_receipt(draft.clone()).unwrap();
        let second = evidence_receipt(draft).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.fixture_digests, ["blake3:a", "blake3:b"]);

        let mut index = EvidenceIndex::default();
        assert!(index.insert(first));
        assert!(!index.insert(second));
        assert_eq!(index.receipts.len(), 1);
        assert_eq!(
            closure.closure_digest,
            freeze(
                &link(&graph, &catalog, b"[workspace]\n", &options())
                    .unwrap()
                    .draft,
                b"version: 6\n"
            )
            .unwrap()
            .closure_digest
        );
    }
}
