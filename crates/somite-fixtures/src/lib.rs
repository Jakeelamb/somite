//! Bind representative, content-addressed biological fixtures to a pinned Graph.
//!
//! This Module intentionally starts with one fixture family: tiny single- or
//! paired-end FASTQ. Unsupported source operators fail closed instead of
//! reaching a network during validation.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use somite_ir::{Graph, ParamValue};
use somite_linker::semantic_graph_revision;
use thiserror::Error;

const READ_ONE: &[u8] = include_bytes!("../../../fixtures/fastq/v1/reads_R1.fastq");
const READ_TWO: &[u8] = include_bytes!("../../../fixtures/fastq/v1/reads_R2.fastq");
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum FixtureError {
    #[error("invalid graph: {0}")]
    Graph(#[from] somite_ir::IrError),
    #[error("fixture graph identity: {0}")]
    Identity(#[from] somite_linker::LinkError),
    #[error("fixture store: {0}")]
    Io(#[from] std::io::Error),
    #[error("source node {node} uses unsupported validation source {operator}")]
    UnsupportedSource { node: String, operator: String },
    #[error("source node {node} is missing parameter {parameter}")]
    MissingParameter { node: String, parameter: String },
    #[error("fixture object {digest} does not match its content address")]
    CorruptObject { digest: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureBinding {
    pub fixture_pack: String,
    pub configuration_digest: String,
    pub fixture_digests: Vec<String>,
    pub bindings: BTreeMap<String, String>,
    pub graph: Graph,
}

/// Materialize and bind the representative FASTQ pack to every source Node.
pub fn bind_representative_fastq(
    graph: &Graph,
    store: &Path,
) -> Result<FixtureBinding, FixtureError> {
    graph.validate()?;
    let mut runnable = graph.clone();
    let mut normalized = graph.clone();
    let mut fixture_digests = BTreeSet::new();
    let mut bindings = BTreeMap::new();

    for node in &graph.nodes {
        let has_inbound = graph.edges.iter().any(|edge| edge.to_node == node.id);
        let has_input_port = node
            .ports
            .iter()
            .any(|port| port.dir == somite_ir::Direction::In);
        if has_inbound || has_input_port {
            continue;
        }
        let parameters: &[(&str, &[u8])] = match node.operator.as_str() {
            "files.import" => &[("path", READ_ONE)],
            "files.import_paired" => &[("r1", READ_ONE), ("r2", READ_TWO)],
            operator => {
                return Err(FixtureError::UnsupportedSource {
                    node: node.id.clone(),
                    operator: operator.to_owned(),
                })
            }
        };
        for (parameter, contents) in parameters {
            let digest = content_digest(contents);
            let path = materialize(store, &digest, contents)?;
            set_parameter(
                &mut runnable,
                &node.id,
                parameter,
                path.display().to_string(),
            )?;
            set_parameter(
                &mut normalized,
                &node.id,
                parameter,
                format!("fixture:{digest}"),
            )?;
            fixture_digests.insert(digest.clone());
            bindings.insert(format!("{}.{}", node.id, parameter), digest);
        }
    }

    Ok(FixtureBinding {
        fixture_pack: "somite.fastq.paired.v1".to_owned(),
        configuration_digest: semantic_graph_revision(&normalized)?,
        fixture_digests: fixture_digests.into_iter().collect(),
        bindings,
        graph: runnable,
    })
}

pub fn content_digest(contents: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(contents).to_hex())
}

fn materialize(store: &Path, digest: &str, contents: &[u8]) -> Result<PathBuf, FixtureError> {
    let object = store.join("objects").join(
        digest
            .strip_prefix("blake3:")
            .expect("fixture digests use the blake3 prefix"),
    );
    let payload = object.join("payload.fastq");
    if payload.is_file() {
        let existing = fs::read(&payload)?;
        if content_digest(&existing) != digest {
            return Err(FixtureError::CorruptObject {
                digest: digest.to_owned(),
            });
        }
        return Ok(payload);
    }
    fs::create_dir_all(&object)?;
    let temporary = object.join(format!(
        ".payload-{}-{}.tmp",
        std::process::id(),
        TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, contents)?;
    fs::rename(temporary, &payload)?;
    Ok(payload)
}

fn set_parameter(
    graph: &mut Graph,
    node_id: &str,
    parameter: &str,
    value: String,
) -> Result<(), FixtureError> {
    let node = graph
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id)
        .expect("validated graph retains source node");
    match node.params.get_mut(parameter) {
        Some(slot @ ParamValue::String(_)) => *slot = ParamValue::String(value),
        _ => {
            return Err(FixtureError::MissingParameter {
                node: node_id.to_owned(),
                parameter: parameter.to_owned(),
            })
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use somite_ir::{Direction, Layout, Node, Port, PortType, SCHEMA_VERSION};

    use super::*;

    fn paired(path_one: &str, path_two: &str) -> Graph {
        Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![Node {
                id: "reads1".into(),
                operator: "files.import_paired".into(),
                operator_revision: "blake3:test".into(),
                ports: vec![
                    Port {
                        name: "r1".into(),
                        dir: Direction::Out,
                        ty: PortType::Fastq,
                        union: Vec::new(),
                        optional: false,
                    },
                    Port {
                        name: "r2".into(),
                        dir: Direction::Out,
                        ty: PortType::Fastq,
                        union: Vec::new(),
                        optional: false,
                    },
                ],
                params: BTreeMap::from([
                    ("r1".into(), ParamValue::String(path_one.into())),
                    ("r2".into(), ParamValue::String(path_two.into())),
                ]),
                layout: Layout { x: 0.0, y: 0.0 },
                note: None,
                color: None,
            }],
            edges: Vec::new(),
            annotations: Vec::new(),
        }
    }

    #[test]
    fn fixture_configuration_is_stable_and_objects_are_reused() {
        let temporary = tempfile::tempdir().expect("fixture store");
        let first = bind_representative_fastq(
            &paired("real/sample_R1.fastq", "real/sample_R2.fastq"),
            temporary.path(),
        )
        .expect("first binding");
        let second = bind_representative_fastq(
            &paired("other/R1.fastq", "other/R2.fastq"),
            temporary.path(),
        )
        .expect("second binding");

        assert_eq!(first.configuration_digest, second.configuration_digest);
        assert_eq!(first.fixture_digests, second.fixture_digests);
        assert_eq!(first.fixture_digests.len(), 2);
        assert_eq!(
            fs::read_dir(temporary.path().join("objects"))
                .expect("objects")
                .count(),
            2
        );
        assert_ne!(
            first.graph.nodes[0].params,
            paired("x", "y").nodes[0].params
        );
    }

    #[test]
    fn unsupported_sources_fail_closed() {
        let mut graph = paired("r1", "r2");
        graph.nodes[0].operator = "sra.prefetch".into();
        let error =
            bind_representative_fastq(&graph, Path::new("unused")).expect_err("unsupported source");
        assert!(matches!(error, FixtureError::UnsupportedSource { .. }));
    }
}
