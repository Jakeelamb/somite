//! One deterministic assessment of a Somite graph.
//!
//! Paper review, readiness, export, and agent handoff consume this same result
//! instead of independently interpreting operator contracts.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use somite_ir::{Graph, ParamValue};
use somite_linker::semantic_graph_revision;
use somite_ops::{
    Catalog, OpKind, Operator, OperatorResolutionKind, OperatorResolutionRecipeKind, ParamSpec,
    ResourceResolutionKind,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AssessmentError {
    #[error("invalid graph: {0}")]
    Graph(#[from] somite_ir::IrError),
    #[error("catalog: {0}")]
    Catalog(#[from] somite_ops::OpsError),
    #[error("graph identity: {0}")]
    Identity(#[from] somite_linker::LinkError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssessmentState {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequirementInputMode {
    Connection,
    File,
    Text,
    Choice,
    Guide,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportKind {
    InputRequired,
    ManagedTool,
    BuiltIn,
    SystemTool,
    ManualCheckpoint,
    MethodDetails,
    LegacySource,
    Adapter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecipeKind {
    ExternalCheckpoint,
    Environment,
    MethodSelection,
    ArtifactPreparation,
    AdapterContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResolutionRecipe {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub version: String,
    pub kind: RecipeKind,
    pub steps: Vec<String>,
    pub parameters: Vec<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RequirementField {
    pub name: String,
    pub label: String,
    pub input_mode: RequirementInputMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssessmentResolution {
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
pub struct AssessmentItem {
    pub id: String,
    pub node_id: String,
    pub operator_id: String,
    /// Primary field retained for compact callers and canvas focus.
    pub field: String,
    /// Every field covered by this one action group.
    pub fields: Vec<RequirementField>,
    pub title: String,
    pub detail: String,
    pub kind: RequirementKind,
    pub priority: u8,
    pub escalatable: bool,
    pub resource_profile: Option<String>,
    pub resolutions: Vec<AssessmentResolution>,
    pub recipes: Vec<ResolutionRecipe>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeAssessment {
    pub node_id: String,
    pub operator_id: String,
    pub title: String,
    pub kind: SupportKind,
    pub label: String,
    pub detail: String,
    pub requires_action: bool,
    pub recipes: Vec<ResolutionRecipe>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowAssessment {
    pub graph_revision: String,
    pub state: AssessmentState,
    pub required_count: usize,
    pub items: Vec<AssessmentItem>,
    pub nodes: Vec<NodeAssessment>,
}

impl WorkflowAssessment {
    pub fn is_ready(&self) -> bool {
        self.state == AssessmentState::Ready
    }

    pub fn node(&self, id: &str) -> Option<&NodeAssessment> {
        self.nodes.iter().find(|node| node.node_id == id)
    }
}

/// Assess the exact pinned graph once for every Somite surface.
pub fn assess(graph: &Graph, catalog: &Catalog) -> Result<WorkflowAssessment, AssessmentError> {
    graph.validate()?;
    catalog.verify_graph(graph)?;

    let bound_inputs = graph
        .edges
        .iter()
        .map(|edge| (edge.to_node.as_str(), edge.to_port.as_str()))
        .collect::<BTreeSet<_>>();
    let mut items = Vec::new();
    let mut nodes = Vec::new();

    for (node_index, node) in graph.nodes.iter().enumerate() {
        let operator = catalog.get(&node.operator)?;
        let missing_resolution_parameters = operator
            .resolution
            .as_ref()
            .map(|resolution| {
                resolution
                    .parameters
                    .iter()
                    .filter(|parameter| {
                        !parameter_value(node, operator, parameter)
                            .is_some_and(configured_parameter)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let resolution_unresolved = operator.resolution.as_ref().is_some_and(|resolution| {
            resolution.parameters.is_empty() || !missing_resolution_parameters.is_empty()
        });
        let support = assess_node(node, operator, resolution_unresolved);
        nodes.push(support);

        if let Some(resolution) = &operator.resolution {
            if resolution_unresolved {
                let (kind, resolution_kind, id, priority, escalatable, fallback_mode) =
                    match resolution.kind {
                        OperatorResolutionKind::ManualCheckpoint => (
                            RequirementKind::ManualCheckpoint,
                            ResolutionKind::Attach,
                            "attach",
                            40,
                            false,
                            RequirementInputMode::File,
                        ),
                        OperatorResolutionKind::MethodDetails => (
                            RequirementKind::MethodDetails,
                            ResolutionKind::Review,
                            "review",
                            50,
                            true,
                            RequirementInputMode::Agent,
                        ),
                        OperatorResolutionKind::LegacySource => (
                            RequirementKind::LegacyTool,
                            ResolutionKind::Setup,
                            "setup",
                            60,
                            true,
                            RequirementInputMode::Guide,
                        ),
                        OperatorResolutionKind::Adapter => (
                            RequirementKind::Adapter,
                            ResolutionKind::AddAdapter,
                            "adapter",
                            70,
                            true,
                            RequirementInputMode::Agent,
                        ),
                    };
                let fields = missing_resolution_parameters
                    .iter()
                    .map(|parameter| requirement_field(operator, parameter, fallback_mode))
                    .collect::<Vec<_>>();
                let primary_field = fields
                    .first()
                    .map(|field| field.name.clone())
                    .unwrap_or_else(|| "operator".to_owned());
                items.push(AssessmentItem {
                    id: format!("resolution:{}:{id}", node.id),
                    node_id: node.id.clone(),
                    operator_id: node.operator.clone(),
                    field: primary_field,
                    fields,
                    title: resolution.title.clone(),
                    detail: resolution.detail.clone(),
                    kind,
                    priority: priority + node_priority(node_index),
                    escalatable,
                    resource_profile: None,
                    resolutions: vec![AssessmentResolution {
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
                    recipes: resolution.recipes.iter().map(recipe).collect(),
                });
            }
        } else if operator.kind == OpKind::Reference || operator.id == "gap.missing" {
            items.push(AssessmentItem {
                id: format!("resolution:{}:adapter", node.id),
                node_id: node.id.clone(),
                operator_id: node.operator.clone(),
                field: "operator".to_owned(),
                fields: Vec::new(),
                title: "Add a reviewed tool contract".to_owned(),
                detail: "This imported workflow reference has no executable Somite contract yet."
                    .to_owned(),
                kind: RequirementKind::Adapter,
                priority: 70 + node_priority(node_index),
                escalatable: true,
                resource_profile: None,
                resolutions: vec![AssessmentResolution {
                    id: "adapter".to_owned(),
                    label: "Ask Agent to draft a contract".to_owned(),
                    detail: "Use the retained source and typed ports to draft a reviewed operator contract."
                        .to_owned(),
                    kind: ResolutionKind::AddAdapter,
                    recommended: true,
                    download_bytes: None,
                    stored_bytes: None,
                    scientific_effect: None,
                    source_url: None,
                }],
                recipes: vec![ResolutionRecipe {
                    id: "reviewed-adapter-v1".to_owned(),
                    title: "Reviewed operator contract".to_owned(),
                    summary: "Promote this structural reference without guessing its execution semantics."
                        .to_owned(),
                    version: "1".to_owned(),
                    kind: RecipeKind::AdapterContract,
                    steps: vec![
                        "Locate the authoritative tool or workflow source.".to_owned(),
                        "Record typed inputs, arguments, outputs, and a representative fixture."
                            .to_owned(),
                        "Replace the reference only after the contract validates.".to_owned(),
                    ],
                    parameters: Vec::new(),
                    source_url: None,
                }],
            });
        }

        for port in &operator.ports.r#in {
            if port.optional || bound_inputs.contains(&(node.id.as_str(), port.name.as_str())) {
                continue;
            }
            let (kind, title, detail, resource_profile, resolutions, priority, escalatable, mode) =
                match &port.resource {
                    Some(resource) => (
                        RequirementKind::ManagedResource,
                        resource.title.clone(),
                        resource.detail.clone(),
                        Some(resource.profile.clone()),
                        resource
                            .resolutions
                            .iter()
                            .map(|resolution| AssessmentResolution {
                                id: resolution.id.clone(),
                                label: resolution.label.clone(),
                                detail: resolution.detail.clone(),
                                kind: match resolution.kind {
                                    ResourceResolutionKind::UseExisting => {
                                        ResolutionKind::UseExisting
                                    }
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
                        30,
                        resource
                            .resolutions
                            .iter()
                            .filter_map(|resolution| resolution.scientific_effect.as_ref())
                            .next()
                            .is_some(),
                        RequirementInputMode::Choice,
                    ),
                    None => (
                        RequirementKind::Input,
                        format!("Connect {}", port.name),
                        format!(
                            "{}.{} needs one incoming {:?} connection.",
                            node.id, port.name, port.ty
                        ),
                        None,
                        vec![AssessmentResolution {
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
                        20,
                        false,
                        RequirementInputMode::Connection,
                    ),
                };
            items.push(AssessmentItem {
                id: format!("input:{}:{}", node.id, port.name),
                node_id: node.id.clone(),
                operator_id: node.operator.clone(),
                field: port.name.clone(),
                fields: vec![RequirementField {
                    name: port.name.clone(),
                    label: title.clone(),
                    input_mode: mode,
                }],
                title,
                detail,
                kind,
                priority: priority + node_priority(node_index),
                escalatable,
                resource_profile,
                resolutions,
                recipes: Vec::new(),
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
            if parameter_value(node, operator, name).is_some_and(configured_parameter) {
                continue;
            }
            let label = parameter.label.as_deref().unwrap_or(name);
            let input_mode = parameter_input_mode(name, parameter, RequirementInputMode::Text);
            items.push(AssessmentItem {
                id: format!("parameter:{}:{name}", node.id),
                node_id: node.id.clone(),
                operator_id: node.operator.clone(),
                field: name.clone(),
                fields: vec![RequirementField {
                    name: name.clone(),
                    label: label.to_owned(),
                    input_mode,
                }],
                title: format!("Set {label}"),
                detail: format!(
                    "{}.{} is required before this workflow can run.",
                    node.id, name
                ),
                kind: RequirementKind::Parameter,
                priority: 10 + node_priority(node_index),
                escalatable: false,
                resource_profile: None,
                resolutions: vec![AssessmentResolution {
                    id: "configure".to_owned(),
                    label: if input_mode == RequirementInputMode::File {
                        "Choose file".to_owned()
                    } else {
                        "Configure the node".to_owned()
                    },
                    detail: format!("Open {} and set {label}.", node.id),
                    kind: ResolutionKind::Configure,
                    recommended: true,
                    download_bytes: None,
                    stored_bytes: None,
                    scientific_effect: None,
                    source_url: None,
                }],
                recipes: Vec::new(),
            });
        }
    }

    items.sort_by(|left, right| {
        (&left.priority, &left.node_id, &left.field, &left.id).cmp(&(
            &right.priority,
            &right.node_id,
            &right.field,
            &right.id,
        ))
    });
    let nodes_requiring_action = items
        .iter()
        .map(|item| item.node_id.as_str())
        .collect::<BTreeSet<_>>();
    for node in &mut nodes {
        node.requires_action |= nodes_requiring_action.contains(node.node_id.as_str());
    }
    let state = if graph.nodes.is_empty() {
        AssessmentState::Empty
    } else if items.is_empty() {
        AssessmentState::Ready
    } else if items.iter().any(|item| {
        !matches!(
            item.kind,
            RequirementKind::Input | RequirementKind::Parameter
        )
    }) {
        AssessmentState::NeedsAction
    } else {
        AssessmentState::Building
    };
    Ok(WorkflowAssessment {
        graph_revision: semantic_graph_revision(graph)?,
        state,
        required_count: items.len(),
        items,
        nodes,
    })
}

fn assess_node(
    node: &somite_ir::Node,
    operator: &Operator,
    resolution_unresolved: bool,
) -> NodeAssessment {
    let recipes = operator
        .resolution
        .as_ref()
        .map(|resolution| resolution.recipes.iter().map(recipe).collect())
        .unwrap_or_default();
    let title = gap_title(node, operator);
    if let Some(resolution) = &operator.resolution {
        let (kind, completed_label) = match resolution.kind {
            OperatorResolutionKind::ManualCheckpoint => {
                (SupportKind::ManualCheckpoint, "Manual output attached")
            }
            OperatorResolutionKind::MethodDetails => {
                (SupportKind::MethodDetails, "Method details attached")
            }
            OperatorResolutionKind::LegacySource => {
                (SupportKind::LegacySource, "Legacy environment reviewed")
            }
            OperatorResolutionKind::Adapter => (SupportKind::Adapter, "Adapter reviewed"),
        };
        return NodeAssessment {
            node_id: node.id.clone(),
            operator_id: node.operator.clone(),
            title,
            kind,
            label: if resolution_unresolved {
                resolution.title.clone()
            } else {
                completed_label.to_owned()
            },
            detail: resolution.detail.clone(),
            requires_action: resolution_unresolved,
            recipes,
        };
    }
    if operator.id == "gap.missing" {
        return NodeAssessment {
            node_id: node.id.clone(),
            operator_id: node.operator.clone(),
            title,
            kind: SupportKind::Adapter,
            label: "Reviewed adapter required".to_owned(),
            detail: "Package discovery cannot infer typed ports, arguments, or outputs.".to_owned(),
            requires_action: true,
            recipes,
        };
    }
    if operator.id.starts_with("files.import") {
        let missing = operator.params.iter().any(|(name, parameter)| {
            parameter.required
                && !parameter_value(node, operator, name).is_some_and(configured_parameter)
        });
        return NodeAssessment {
            node_id: node.id.clone(),
            operator_id: node.operator.clone(),
            title,
            kind: SupportKind::InputRequired,
            label: if missing {
                "Choose input"
            } else {
                "Input attached"
            }
            .to_owned(),
            detail: "Use a local file or replace this node with a searchable online source."
                .to_owned(),
            requires_action: missing,
            recipes,
        };
    }
    let (kind, label, detail) = match operator.kind {
        OpKind::External if !operator.pixi.is_empty() => (
            SupportKind::ManagedTool,
            "Managed automatically".to_owned(),
            format!("Somite can resolve {} with Pixi.", operator.pixi.join(", ")),
        ),
        OpKind::External => (
            SupportKind::SystemTool,
            "System tool required".to_owned(),
            "This command must already be available on the machine.".to_owned(),
        ),
        OpKind::Inprocess => (
            SupportKind::BuiltIn,
            "Built into Somite".to_owned(),
            "No separate tool installation is needed.".to_owned(),
        ),
        OpKind::Reference => (
            SupportKind::Adapter,
            "Reviewed adapter required".to_owned(),
            "This structural reference is not executable yet.".to_owned(),
        ),
    };
    NodeAssessment {
        node_id: node.id.clone(),
        operator_id: node.operator.clone(),
        title,
        kind,
        label,
        detail,
        requires_action: operator.kind == OpKind::Reference,
        recipes,
    }
}

fn gap_title(node: &somite_ir::Node, operator: &Operator) -> String {
    if operator.id == "gap.missing" {
        if let Some(ParamValue::String(name)) = node.params.get("tool") {
            if !name.trim().is_empty() {
                return name.trim().to_owned();
            }
        }
    }
    operator.title.clone()
}

fn parameter_value<'a>(
    node: &'a somite_ir::Node,
    operator: &'a Operator,
    parameter: &str,
) -> Option<&'a ParamValue> {
    node.params.get(parameter).or_else(|| {
        operator
            .params
            .get(parameter)
            .and_then(|spec| spec.default.as_ref())
    })
}

fn configured_parameter(value: &ParamValue) -> bool {
    !matches!(value, ParamValue::String(text) if text.trim().is_empty())
}

fn requirement_field(
    operator: &Operator,
    parameter: &str,
    fallback: RequirementInputMode,
) -> RequirementField {
    let spec = operator.params.get(parameter);
    RequirementField {
        name: parameter.to_owned(),
        label: spec
            .and_then(|value| value.label.clone())
            .unwrap_or_else(|| parameter.to_owned()),
        input_mode: spec
            .map(|value| parameter_input_mode(parameter, value, fallback))
            .unwrap_or(fallback),
    }
}

fn parameter_input_mode(
    name: &str,
    parameter: &ParamSpec,
    fallback: RequirementInputMode,
) -> RequirementInputMode {
    let page = parameter
        .page
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if parameter.ty == "string"
        && (name == "path" || name.ends_with("_path") || page.contains("checkpoint"))
    {
        RequirementInputMode::File
    } else {
        fallback
    }
}

fn node_priority(index: usize) -> u8 {
    u8::try_from(index.min(9)).unwrap_or(9)
}

fn recipe(spec: &somite_ops::OperatorResolutionRecipeSpec) -> ResolutionRecipe {
    ResolutionRecipe {
        id: spec.id.clone(),
        title: spec.title.clone(),
        summary: spec.summary.clone(),
        version: spec.version.clone(),
        kind: match spec.kind {
            OperatorResolutionRecipeKind::ExternalCheckpoint => RecipeKind::ExternalCheckpoint,
            OperatorResolutionRecipeKind::Environment => RecipeKind::Environment,
            OperatorResolutionRecipeKind::MethodSelection => RecipeKind::MethodSelection,
            OperatorResolutionRecipeKind::ArtifactPreparation => RecipeKind::ArtifactPreparation,
            OperatorResolutionRecipeKind::AdapterContract => RecipeKind::AdapterContract,
        },
        steps: spec.steps.clone(),
        parameters: spec.parameters.clone(),
        source_url: spec.source_url.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use somite_ir::{Edge, Layout, Node, SCHEMA_VERSION};

    use super::*;

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
        let assessment = assess(
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
        .expect("assessment");

        assert_eq!(assessment.state, AssessmentState::Ready);
        assert!(assessment.items.is_empty());
        assert_eq!(assessment.nodes[0].label, "Input attached");
    }

    #[test]
    fn manual_checkpoint_groups_every_missing_file_under_one_recipe() {
        let catalog = catalog();
        let checkpoint = node(&catalog, "evidence", "manual.allmaps_evidence");
        let assessment =
            assess(&graph(vec![checkpoint], vec![]), &catalog).expect("manual assessment");

        let item = assessment
            .items
            .iter()
            .find(|item| item.kind == RequirementKind::MethodDetails)
            .expect("method detail item");
        assert_eq!(item.fields.len(), 2);
        assert!(item
            .fields
            .iter()
            .all(|field| field.input_mode == RequirementInputMode::File));
        assert_eq!(item.recipes.len(), 1);
        assert!(item.escalatable);
    }

    #[test]
    fn attached_manual_checkpoint_clears_without_changing_its_provenance_kind() {
        let catalog = catalog();
        let mut checkpoint = node(&catalog, "joinmap", "manual.joinmap");
        checkpoint.params.insert(
            "path".to_owned(),
            ParamValue::String("joinmap-export.csv".to_owned()),
        );
        let assessment = assess(&graph(vec![checkpoint], vec![]), &catalog)
            .expect("attached checkpoint assessment");

        assert!(assessment.is_ready());
        assert_eq!(assessment.nodes[0].kind, SupportKind::ManualCheckpoint);
        assert!(!assessment.nodes[0].requires_action);
    }

    #[test]
    fn managed_resource_choices_retain_sizes_and_scientific_effects() {
        let catalog = catalog();
        let mut input = node(&catalog, "reads", "files.import");
        input.params.insert(
            "path".to_owned(),
            ParamValue::String("reads.fastq".to_owned()),
        );
        let kraken = node(&catalog, "kraken", "class.kraken2");
        let assessment = assess(
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
        .expect("resource assessment");

        let resource = assessment
            .items
            .iter()
            .find(|item| item.kind == RequirementKind::ManagedResource)
            .expect("managed resource");
        assert_eq!(
            resource.resource_profile.as_deref(),
            Some("kraken2-database")
        );
        assert!(resource.escalatable);
        assert!(resource
            .resolutions
            .iter()
            .any(|resolution| resolution.download_bytes.is_some()));
        assert!(resource
            .resolutions
            .iter()
            .any(|resolution| resolution.scientific_effect.is_some()));
    }

    #[test]
    fn missing_parameter_marks_managed_node_as_requiring_action() {
        let catalog = catalog();
        let source = node(&catalog, "fasta", "ensembl.fasta");
        let assessment = assess(&graph(vec![source], vec![]), &catalog).expect("source assessment");

        assert_eq!(assessment.nodes[0].kind, SupportKind::ManagedTool);
        assert!(assessment.nodes[0].requires_action);
        assert!(assessment
            .items
            .iter()
            .any(|item| item.id == "parameter:fasta:url"));
    }

    #[test]
    fn deterministic_inputs_sort_before_scientific_escalations() {
        let catalog = catalog();
        let input = node(&catalog, "reads", "files.import_fasta");
        let ambiguous = node(&catalog, "gatk", "method.gatk3_unspecified");
        let assessment =
            assess(&graph(vec![ambiguous, input], vec![]), &catalog).expect("workflow assessment");

        assert_eq!(assessment.items[0].kind, RequirementKind::Parameter);
        assert!(assessment.items.last().is_some_and(|item| item.escalatable));
    }

    #[test]
    fn reference_without_resolution_fails_closed_as_adapter_work() {
        let catalog = catalog();
        let reference = node(&catalog, "workflow", "smk.workflow");
        let assessment =
            assess(&graph(vec![reference], vec![]), &catalog).expect("reference assessment");

        assert!(assessment
            .items
            .iter()
            .any(|item| item.kind == RequirementKind::Adapter));
        assert!(!assessment.is_ready());
    }

    #[test]
    fn empty_graph_is_not_ready() {
        let catalog = catalog();
        let assessment =
            assess(&graph(Vec::new(), Vec::new()), &catalog).expect("empty assessment");
        assert_eq!(assessment.state, AssessmentState::Empty);
        assert!(!assessment.is_ready());
    }
}
