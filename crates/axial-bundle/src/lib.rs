//! Build a portable graph bundle behind one export interface.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Write};

use axial_ir::{Graph, ParamValue};
use axial_ops::{pixi_manifest, Catalog, OpKind, Operator};
use serde::Serialize;
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("graph: {0}")]
    Graph(#[from] axial_ir::IrError),
    #[error("operator catalog: {0}")]
    Catalog(#[from] axial_ops::OpsError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("zip io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct ExportTarget {
    pub project_name: String,
    pub platform: String,
}

impl ExportTarget {
    pub fn new(project_name: impl Into<String>, platform: impl Into<String>) -> Self {
        Self {
            project_name: project_name.into(),
            platform: platform.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    BuiltIn,
    Ready,
    Installable,
    SystemRequired,
    AdapterNeeded,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolRequirement {
    pub operator_id: String,
    pub title: String,
    pub binary: Option<String>,
    pub packages: Vec<String>,
    pub state: ToolState,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BundlePlan {
    pub filename: String,
    pub platform: String,
    pub channels: Vec<String>,
    pub packages: Vec<String>,
    pub tools: Vec<ToolRequirement>,
    pub ready_count: usize,
    pub installable_count: usize,
    pub adapter_count: usize,
}

#[derive(Debug)]
pub struct ExportBundle {
    pub plan: BundlePlan,
    pub bytes: Vec<u8>,
}

/// Produce the complete portable bundle. The probe is the only machine-specific
/// input; all resolution and archive behaviour stays behind this interface.
pub fn build_bundle(
    graph: &Graph,
    catalog: &Catalog,
    target: &ExportTarget,
    binary_available: impl Fn(&str) -> bool,
) -> Result<ExportBundle, BundleError> {
    graph.validate()?;
    let operators = used_operators(graph, catalog)?;
    let plan = build_plan(graph, &operators, target, binary_available);
    let files = bundle_files(graph, &operators, &plan)?;
    let bytes = write_zip(files)?;
    Ok(ExportBundle { plan, bytes })
}

fn used_operators<'a>(
    graph: &Graph,
    catalog: &'a Catalog,
) -> Result<Vec<&'a Operator>, BundleError> {
    let ids = graph
        .nodes
        .iter()
        .map(|node| node.operator.as_str())
        .collect::<BTreeSet<_>>();
    ids.into_iter()
        .map(|id| catalog.get(id).map_err(BundleError::from))
        .collect()
}

fn build_plan(
    graph: &Graph,
    operators: &[&Operator],
    target: &ExportTarget,
    binary_available: impl Fn(&str) -> bool,
) -> BundlePlan {
    let mut packages = BTreeSet::new();
    let mut tools = Vec::new();
    for operator in operators {
        let requirement = tool_requirement(graph, operator, &binary_available);
        packages.extend(requirement.packages.iter().cloned());
        tools.push(requirement);
    }
    let ready_count = tools
        .iter()
        .filter(|tool| matches!(tool.state, ToolState::BuiltIn | ToolState::Ready))
        .count();
    let installable_count = tools
        .iter()
        .filter(|tool| tool.state == ToolState::Installable)
        .count();
    let adapter_count = tools
        .iter()
        .filter(|tool| tool.state == ToolState::AdapterNeeded)
        .count();
    BundlePlan {
        filename: format!("{}.axial.zip", safe_name(&target.project_name)),
        platform: target.platform.clone(),
        channels: vec!["conda-forge".to_owned(), "bioconda".to_owned()],
        packages: packages.into_iter().collect(),
        tools,
        ready_count,
        installable_count,
        adapter_count,
    }
}

fn tool_requirement(
    graph: &Graph,
    operator: &Operator,
    binary_available: &impl Fn(&str) -> bool,
) -> ToolRequirement {
    if operator.id == "gap.missing" {
        let names = graph
            .nodes
            .iter()
            .filter(|node| node.operator == operator.id)
            .filter_map(|node| match node.params.get("tool") {
                Some(ParamValue::String(name)) if !name.trim().is_empty() => {
                    Some(name.trim().to_owned())
                }
                _ => None,
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        return ToolRequirement {
            operator_id: operator.id.clone(),
            title: if names.is_empty() {
                "Unresolved paper tool".to_owned()
            } else {
                names.join(", ")
            },
            binary: None,
            packages: Vec::new(),
            state: ToolState::AdapterNeeded,
            detail: "Needs a reviewed Axial adapter: package discovery cannot infer typed ports, argv, or outputs.".to_owned(),
        };
    }
    if operator.kind == OpKind::Reference {
        return ToolRequirement {
            operator_id: operator.id.clone(),
            title: operator.title.clone(),
            binary: None,
            packages: Vec::new(),
            state: ToolState::AdapterNeeded,
            detail: "Imported workflow structure; convert this component to a native Axial tool before standalone execution.".to_owned(),
        };
    }
    if operator.kind == OpKind::Inprocess {
        return ToolRequirement {
            operator_id: operator.id.clone(),
            title: operator.title.clone(),
            binary: None,
            packages: Vec::new(),
            state: ToolState::BuiltIn,
            detail: "Included in the Axial runtime.".to_owned(),
        };
    }
    let binary = operator.bin.clone();
    let available = binary.as_deref().is_some_and(binary_available);
    let package_specs = operator.pixi.clone();
    let (state, detail) = if available {
        (ToolState::Ready, "Available on this machine.".to_owned())
    } else if !package_specs.is_empty() {
        (
            ToolState::Installable,
            "Declared package will be resolved and locked by Pixi.".to_owned(),
        )
    } else {
        (
            ToolState::SystemRequired,
            "External binary has no managed package declaration.".to_owned(),
        )
    };
    ToolRequirement {
        operator_id: operator.id.clone(),
        title: operator.title.clone(),
        binary,
        packages: package_specs,
        state,
        detail,
    }
}

fn bundle_files(
    graph: &Graph,
    operators: &[&Operator],
    plan: &BundlePlan,
) -> Result<BTreeMap<String, Vec<u8>>, BundleError> {
    let mut files = BTreeMap::new();
    files.insert(
        "workflow.axial.json".to_owned(),
        serde_json::to_vec_pretty(graph)?,
    );
    files.insert(
        "toolchain/tools.json".to_owned(),
        serde_json::to_vec_pretty(plan)?,
    );
    files.insert(
        "toolchain/pixi.toml".to_owned(),
        pixi_manifest("axial-workflow", &plan.platform, operators.iter().copied()).into_bytes(),
    );
    files.insert("README.md".to_owned(), bundle_readme(plan).into_bytes());
    files.insert("run.sh".to_owned(), run_script().as_bytes().to_vec());
    for operator in operators {
        files.insert(
            format!("operators/{}.json", operator.id),
            serde_json::to_vec_pretty(operator)?,
        );
    }
    Ok(files)
}

fn bundle_readme(plan: &BundlePlan) -> String {
    format!(
        "# Axial portable workflow\n\nThis bundle contains the graph, exact operator schemas, and one Pixi toolchain.\n\n1. Install Pixi once.\n2. Run `./run.sh` with the Axial CLI installed.\n3. Keep the generated `toolchain/pixi.lock` with this bundle to freeze exact builds.\n\n`pixi run` resolves, installs, locks, and activates every declared workflow tool automatically.\n\nReady/built-in tools: {}. Installable tools: {}. Tools needing an adapter: {}.\nSee `toolchain/tools.json` for every requirement.\n",
        plan.ready_count, plan.installable_count, plan.adapter_count
    )
}

fn run_script() -> &'static str {
    "#!/usr/bin/env bash\nset -euo pipefail\ncommand -v pixi >/dev/null || { echo 'Pixi is required: https://pixi.sh' >&2; exit 1; }\ncommand -v axial >/dev/null || { echo 'Axial CLI is required' >&2; exit 1; }\nexec axial cook workflow.axial.json\n"
}

fn safe_name(name: &str) -> String {
    let safe = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if safe.is_empty() {
        "axial-workflow".to_owned()
    } else {
        safe
    }
}

fn write_zip(files: BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, BundleError> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);
    for (name, contents) in files {
        let file_options = if name == "run.sh" {
            options.unix_permissions(0o755)
        } else {
            options
        };
        archive.start_file(name, file_options)?;
        archive.write_all(&contents)?;
    }
    Ok(archive.finish()?.into_inner())
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use axial_ir::{Direction, Layout, Node, Port, PortType, SCHEMA_VERSION};
    use axial_ops::Operator;
    use zip::ZipArchive;

    use super::*;

    fn operator(raw: &str) -> Operator {
        serde_json::from_str(raw).expect("operator fixture")
    }

    fn node(id: &str, op: &str) -> Node {
        Node {
            id: id.to_owned(),
            operator: op.to_owned(),
            ports: vec![Port {
                name: "out".to_owned(),
                dir: Direction::Out,
                ty: PortType::Directory,
                union: Vec::new(),
                optional: true,
            }],
            params: BTreeMap::new(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        }
    }

    #[test]
    fn bundle_contains_graph_operators_and_one_pixi_environment() {
        let fastqc = operator(
            r#"{"id":"qc.fastqc","title":"FastQC","palette":[],"kind":"external","bin":"fastqc","pixi":["bioconda::fastqc"],"ports":{"out":[{"name":"out","type":"Directory","optional":true}]}}"#,
        );
        let mut catalog = Catalog::default();
        catalog.ops.insert(fastqc.id.clone(), fastqc);
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            nodes: vec![node("fastqc1", "qc.fastqc")],
            edges: Vec::new(),
        };
        let bundle = build_bundle(
            &graph,
            &catalog,
            &ExportTarget::new("RNA seq", "linux-64"),
            |_| false,
        )
        .expect("bundle");
        assert_eq!(bundle.plan.filename, "RNA-seq.axial.zip");
        assert_eq!(bundle.plan.installable_count, 1);
        let mut zip = ZipArchive::new(Cursor::new(bundle.bytes)).expect("zip");
        for name in [
            "workflow.axial.json",
            "operators/qc.fastqc.json",
            "toolchain/pixi.toml",
            "toolchain/tools.json",
            "run.sh",
        ] {
            assert!(zip.by_name(name).is_ok(), "missing {name}");
        }
        let mut pixi = String::new();
        zip.by_name("toolchain/pixi.toml")
            .expect("pixi manifest")
            .read_to_string(&mut pixi)
            .expect("read pixi manifest");
        assert!(pixi.contains("\"fastqc\" = { version = \"*\", channel = \"bioconda\" }"));
        let mut launcher = String::new();
        zip.by_name("run.sh")
            .expect("launcher")
            .read_to_string(&mut launcher)
            .expect("read launcher");
        assert!(launcher.contains("exec axial cook workflow.axial.json"));
        assert!(!launcher.contains("pixi run"));
    }

    #[test]
    fn paper_gap_is_an_adapter_requirement_not_an_install_claim() {
        let gap = operator(
            r#"{"id":"gap.missing","title":"Needs tool adapter","palette":[],"kind":"inprocess","ports":{"out":[{"name":"out","type":"Directory","optional":true}]},"params":{"tool":{"type":"string"}}}"#,
        );
        let mut catalog = Catalog::default();
        catalog.ops.insert(gap.id.clone(), gap);
        let mut gap_node = node("gap1", "gap.missing");
        gap_node.params.insert(
            "tool".to_owned(),
            ParamValue::String("Trimmomatic".to_owned()),
        );
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            nodes: vec![gap_node],
            edges: Vec::new(),
        };
        let bundle = build_bundle(
            &graph,
            &catalog,
            &ExportTarget::new("paper", "linux-64"),
            |_| true,
        )
        .expect("bundle");
        assert_eq!(bundle.plan.adapter_count, 1);
        assert_eq!(bundle.plan.tools[0].state, ToolState::AdapterNeeded);
        assert_eq!(bundle.plan.tools[0].title, "Trimmomatic");
    }
}
