//! Deterministic workflow readiness analysis shared by the UI and MCP bridge.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use somite_ir::{Graph, ParamValue};
use somite_linker::semantic_graph_revision;
use somite_ops::{Catalog, OperatorResolutionKind, ResourceResolutionKind};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReadinessError {
    #[error("invalid graph: {0}")]
    Graph(#[from] somite_ir::IrError),
    #[error("catalog: {0}")]
    Catalog(#[from] somite_ops::OpsError),
    #[error("graph identity: {0}")]
    Identity(#[from] somite_linker::LinkError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessState {
    Empty,
    Building,
    NeedsAction,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequirementKind {
    Input,
    Parameter,
    ManagedResource,
    ManualCheckpoint,
    MethodDetails,
    LegacyTool,
    Adapter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionKind {
    Connect,
    Configure,
    UseExisting,
    Download,
    Build,
    Attach,
    Review,
    Setup,
    AddAdapter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReadinessResolution {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub kind: ResolutionKind,
    pub recommended: bool,
    pub download_bytes: Option<u64>,
    pub stored_bytes: Option<u64>,
    pub scientific_effect: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReadinessItem {
    pub id: String,
    pub node_id: String,
    pub operator_id: String,
    pub field: String,
    pub title: String,
    pub detail: String,
    pub kind: RequirementKind,
    pub resource_profile: Option<String>,
    pub resolutions: Vec<ReadinessResolution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReadinessSnapshot {
    pub graph_revision: String,
    pub state: ReadinessState,
    pub required_count: usize,
    pub items: Vec<ReadinessItem>,
}

impl ReadinessSnapshot {
    pub fn is_ready(&self) -> bool {
        self.state == ReadinessState::Ready
    }
}

pub fn analyze(graph: &Graph, catalog: &Catalog) -> Result<ReadinessSnapshot, ReadinessError> {
    graph.validate()?;
    catalog.verify_graph(graph)?;

    let bound_inputs = graph
        .edges
        .iter()
        .map(|edge| (edge.to_node.as_str(), edge.to_port.as_str()))
        .collect::<BTreeSet<_>>();
    let mut items = Vec::new();

    for node in &graph.nodes {
        let operator = catalog.get(&node.operator)?;
        if let Some(resolution) = &operator.resolution {
            let missing_parameter = resolution.parameters.iter().find(|parameter| {
                !node
                    .params
                    .get(*parameter)
                    .or_else(|| {
                        operator
                            .params
                            .get(*parameter)
                            .and_then(|spec| spec.default.as_ref())
                    })
                    .is_some_and(configured_parameter)
            });
            let unresolved = resolution.parameters.is_empty() || missing_parameter.is_some();
            if unresolved {
                let (kind, resolution_kind, id) = match resolution.kind {
                    OperatorResolutionKind::ManualCheckpoint => (
                        RequirementKind::ManualCheckpoint,
                        ResolutionKind::Attach,
                        "attach",
                    ),
                    OperatorResolutionKind::MethodDetails => (
                        RequirementKind::MethodDetails,
                        ResolutionKind::Review,
                        "review",
                    ),
                    OperatorResolutionKind::LegacySource => {
                        (RequirementKind::LegacyTool, ResolutionKind::Setup, "setup")
                    }
                    OperatorResolutionKind::Adapter => (
                        RequirementKind::Adapter,
                        ResolutionKind::AddAdapter,
                        "adapter",
                    ),
                };
                let field = missing_parameter
                    .map(|parameter| (*parameter).clone())
                    .unwrap_or_else(|| "operator".to_owned());
                items.push(ReadinessItem {
                    id: format!("resolution:{}:{id}", node.id),
                    node_id: node.id.clone(),
                    operator_id: node.operator.clone(),
                    field,
                    title: resolution.title.clone(),
                    detail: resolution.detail.clone(),
                    kind,
                    resource_profile: None,
                    resolutions: vec![ReadinessResolution {
                        id: id.to_owned(),
                        label: resolution.action_label.clone(),
                        detail: resolution.detail.clone(),
                        kind: resolution_kind,
                        recommended: true,
                        download_bytes: None,
                        stored_bytes: None,
                        scientific_effect: None,
                        source_url: resolution.source_url.clone(),
                    }],
                });
            }
        }
        for port in &operator.ports.r#in {
            if port.optional || bound_inputs.contains(&(node.id.as_str(), port.name.as_str())) {
                continue;
            }
            let (kind, title, detail, resource_profile, resolutions) = match &port.resource {
                Some(resource) => (
                    RequirementKind::ManagedResource,
                    resource.title.clone(),
                    resource.detail.clone(),
                    Some(resource.profile.clone()),
                    resource
                        .resolutions
                        .iter()
                        .map(|resolution| ReadinessResolution {
                            id: resolution.id.clone(),
                            label: resolution.label.clone(),
                            detail: resolution.detail.clone(),
                            kind: match resolution.kind {
                                ResourceResolutionKind::UseExisting => ResolutionKind::UseExisting,
                                ResourceResolutionKind::Download => ResolutionKind::Download,
                                ResourceResolutionKind::Build => ResolutionKind::Build,
                            },
                            recommended: resolution.recommended,
                            download_bytes: resolution.download_bytes,
                            stored_bytes: resolution.stored_bytes,
                            scientific_effect: resolution.scientific_effect.clone(),
                            source_url: None,
                        })
                        .collect(),
                ),
                None => (
                    RequirementKind::Input,
                    format!("Connect {}", port.name),
                    format!(
                        "{}.{} needs one incoming {:?} connection.",
                        node.id, port.name, port.ty
                    ),
                    None,
                    vec![ReadinessResolution {
                        id: "connect".to_owned(),
                        label: "Connect an input".to_owned(),
                        detail: format!(
                            "Choose a compatible source for {}.{}.",
                            node.id, port.name
                        ),
                        kind: ResolutionKind::Connect,
                        recommended: true,
                        download_bytes: None,
                        stored_bytes: None,
                        scientific_effect: None,
                        source_url: None,
                    }],
                ),
            };
            items.push(ReadinessItem {
                id: format!("input:{}:{}", node.id, port.name),
                node_id: node.id.clone(),
                operator_id: node.operator.clone(),
                field: port.name.clone(),
                title,
                detail,
                kind,
                resource_profile,
                resolutions,
            });
        }

        for (name, parameter) in &operator.params {
            if !parameter.required {
                continue;
            }
            if operator
                .resolution
                .as_ref()
                .is_some_and(|resolution| resolution.parameters.contains(name))
            {
                continue;
            }
            let value = node.params.get(name).or(parameter.default.as_ref());
            if value.is_some_and(configured_parameter) {
                continue;
            }
            let label = parameter.label.as_deref().unwrap_or(name);
            items.push(ReadinessItem {
                id: format!("parameter:{}:{name}", node.id),
                node_id: node.id.clone(),
                operator_id: node.operator.clone(),
                field: name.clone(),
                title: format!("Set {label}"),
                detail: format!(
                    "{}.{} is required before this workflow can run.",
                    node.id, name
                ),
                kind: RequirementKind::Parameter,
                resource_profile: None,
                resolutions: vec![ReadinessResolution {
                    id: "configure".to_owned(),
                    label: "Configure the node".to_owned(),
                    detail: format!("Open {} and set {label}.", node.id),
                    kind: ResolutionKind::Configure,
                    recommended: true,
                    download_bytes: None,
                    stored_bytes: None,
                    scientific_effect: None,
                    source_url: None,
                }],
            });
        }
    }

    items.sort_by(|left, right| {
        (&left.node_id, &left.field, &left.id).cmp(&(&right.node_id, &right.field, &right.id))
    });
    let state = if graph.nodes.is_empty() {
        ReadinessState::Empty
    } else if items.is_empty() {
        ReadinessState::Ready
    } else if items.iter().any(|item| {
        !matches!(
            item.kind,
            RequirementKind::Input | RequirementKind::Parameter
        )
    }) {
        ReadinessState::NeedsAction
    } else {
        ReadinessState::Building
    };
    Ok(ReadinessSnapshot {
        graph_revision: semantic_graph_revision(graph)?,
        state,
        required_count: items.len(),
        items,
    })
}

fn configured_parameter(value: &ParamValue) -> bool {
    !matches!(value, ParamValue::String(text) if text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use somite_ir::{Edge, Graph, Layout, Node, SCHEMA_VERSION};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn catalog() -> Catalog {
        Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
            .expect("operator catalog")
    }

    fn node(catalog: &Catalog, id: &str, operator_id: &str) -> Node {
        let operator = catalog.get(operator_id).expect("operator");
        Node {
            id: id.to_owned(),
            operator: operator_id.to_owned(),
            operator_revision: operator.revision().expect("operator revision"),
            ports: operator.ir_ports(),
            params: operator
                .params
                .iter()
                .filter_map(|(name, spec)| spec.default.clone().map(|value| (name.clone(), value)))
                .collect::<BTreeMap<_, _>>(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
            color: None,
        }
    }

    fn graph(nodes: Vec<Node>, edges: Vec<Edge>) -> Graph {
        Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes,
            edges,
            annotations: Vec::new(),
        }
    }

    #[test]
    fn complete_graph_is_ready() {
        let catalog = catalog();
        let mut input = node(&catalog, "reads", "files.import");
        input.params.insert(
            "path".to_owned(),
            ParamValue::String("reads.fastq".to_owned()),
        );
        let qc = node(&catalog, "qc", "qc.fastqc");
        let snapshot = analyze(
            &graph(
                vec![input, qc],
                vec![Edge {
                    id: "reads-qc".to_owned(),
                    from_node: "reads".to_owned(),
                    from_port: "file".to_owned(),
                    to_node: "qc".to_owned(),
                    to_port: "fastq".to_owned(),
                }],
            ),
            &catalog,
        )
        .expect("readiness");

        assert_eq!(snapshot.state, ReadinessState::Ready);
        assert!(snapshot.items.is_empty());
    }

    #[test]
    fn ordinary_unbound_input_is_a_building_requirement() {
        let catalog = catalog();
        let snapshot = analyze(
            &graph(vec![node(&catalog, "qc", "qc.fastqc")], vec![]),
            &catalog,
        )
        .expect("readiness");

        assert_eq!(snapshot.state, ReadinessState::Building);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].kind, RequirementKind::Input);
        assert_eq!(
            snapshot.items[0].resolutions[0].kind,
            ResolutionKind::Connect
        );
    }

    #[test]
    fn manual_checkpoint_is_one_action_and_clears_when_an_export_is_attached() {
        let catalog = catalog();
        let checkpoint = node(&catalog, "joinmap", "manual.joinmap");
        let snapshot =
            analyze(&graph(vec![checkpoint.clone()], vec![]), &catalog).expect("manual readiness");

        assert_eq!(snapshot.state, ReadinessState::NeedsAction);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].kind, RequirementKind::ManualCheckpoint);
        assert_eq!(
            snapshot.items[0].resolutions[0].kind,
            ResolutionKind::Attach
        );
        assert!(snapshot.items[0].resolutions[0].source_url.is_some());

        let mut attached = checkpoint;
        attached.params.insert(
            "path".to_owned(),
            ParamValue::String("joinmap-export.csv".to_owned()),
        );
        let ready = analyze(&graph(vec![attached], vec![]), &catalog)
            .expect("attached checkpoint readiness");
        assert_eq!(ready.state, ReadinessState::Ready);
    }

    #[test]
    fn paper_method_ambiguity_is_not_reported_as_a_generic_adapter() {
        let catalog = catalog();
        let snapshot = analyze(
            &graph(
                vec![node(&catalog, "gatk", "method.gatk3_unspecified")],
                vec![],
            ),
            &catalog,
        )
        .expect("method readiness");

        assert!(snapshot
            .items
            .iter()
            .any(|item| item.kind == RequirementKind::MethodDetails));
        assert!(!snapshot
            .items
            .iter()
            .any(|item| item.kind == RequirementKind::Adapter));
    }

    #[test]
    fn kraken_database_has_deterministic_resource_choices() {
        let catalog = catalog();
        let mut input = node(&catalog, "reads", "files.import");
        input.params.insert(
            "path".to_owned(),
            ParamValue::String("reads.fastq".to_owned()),
        );
        let kraken = node(&catalog, "kraken", "class.kraken2");
        let snapshot = analyze(
            &graph(
                vec![input, kraken],
                vec![Edge {
                    id: "reads-kraken".to_owned(),
                    from_node: "reads".to_owned(),
                    from_port: "file".to_owned(),
                    to_node: "kraken".to_owned(),
                    to_port: "r1".to_owned(),
                }],
            ),
            &catalog,
        )
        .expect("readiness");

        assert_eq!(snapshot.state, ReadinessState::NeedsAction);
        assert_eq!(snapshot.items.len(), 1);
        let database = &snapshot.items[0];
        assert_eq!(database.kind, RequirementKind::ManagedResource);
        assert_eq!(
            database.resource_profile.as_deref(),
            Some("kraken2-database")
        );
        assert!(database
            .resolutions
            .iter()
            .any(|item| item.kind == ResolutionKind::UseExisting));
        assert!(database
            .resolutions
            .iter()
            .any(|item| item.kind == ResolutionKind::Download));
        assert!(database
            .resolutions
            .iter()
            .any(|item| item.kind == ResolutionKind::Build));
    }

    #[test]
    fn optional_inputs_are_not_requirements() {
        let catalog = catalog();
        let mut input = node(&catalog, "reads", "files.import");
        input.params.insert(
            "path".to_owned(),
            ParamValue::String("reads.fastq".to_owned()),
        );
        let fastp = node(&catalog, "fastp", "qc.fastp");
        let snapshot = analyze(
            &graph(
                vec![input, fastp],
                vec![Edge {
                    id: "reads-fastp".to_owned(),
                    from_node: "reads".to_owned(),
                    from_port: "file".to_owned(),
                    to_node: "fastp".to_owned(),
                    to_port: "r1".to_owned(),
                }],
            ),
            &catalog,
        )
        .expect("readiness");

        assert_eq!(snapshot.state, ReadinessState::Ready);
    }

    #[test]
    fn required_empty_string_parameter_is_visible() {
        let catalog = catalog();
        let mut input = node(&catalog, "reads", "files.import");
        input
            .params
            .insert("path".to_owned(), ParamValue::String("  ".to_owned()));
        let snapshot = analyze(&graph(vec![input], vec![]), &catalog).expect("readiness");

        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].kind, RequirementKind::Parameter);
        assert_eq!(snapshot.items[0].field, "path");
    }

    #[test]
    fn empty_graph_is_not_reported_as_ready() {
        let catalog = catalog();
        let snapshot = analyze(&graph(vec![], vec![]), &catalog).expect("readiness");

        assert_eq!(snapshot.state, ReadinessState::Empty);
        assert!(!snapshot.is_ready());
    }
}
