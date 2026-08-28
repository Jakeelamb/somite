//! Freeze and archive one target-specific Graph-to-Nextflow/Pixi run package.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use somite_ir::{Graph, ParamValue};
use somite_linker::{freeze, link, EvidenceIndex, LinkOptions, RunClosure};
use somite_nextflow::{compile, CompileOptions, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION};
use somite_ops::{Catalog, OpKind, Operator, OperatorResolutionKind};
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("graph: {0}")]
    Graph(#[from] somite_ir::IrError),
    #[error("operator catalog: {0}")]
    Catalog(#[from] somite_ops::OpsError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("zip io: {0}")]
    Io(#[from] std::io::Error),
    #[error("compile: {0}")]
    Compile(#[from] somite_nextflow::CompileError),
    #[error("link: {0}")]
    Link(#[from] somite_linker::LinkError),
    #[error("output path already exists: {0}")]
    DestinationExists(String),
    #[error("Pixi is required to freeze a run package")]
    PixiMissing,
    #[error("Pixi lock failed: {0}")]
    PixiLock(String),
}

#[derive(Debug, Clone)]
pub struct ExportTarget {
    pub archive_name: String,
    pub platform: String,
}

impl ExportTarget {
    pub fn new(archive_name: impl Into<String>, platform: impl Into<String>) -> Self {
        Self {
            archive_name: archive_name.into(),
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
    ManualCheckpoint,
    MethodDetails,
    LegacySource,
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
    pub manual_count: usize,
    pub details_count: usize,
    pub legacy_count: usize,
    pub adapter_count: usize,
}

#[derive(Debug, Clone)]
pub struct FrozenPackage {
    pub plan: BundlePlan,
    pub closure: RunClosure,
    pub directory: PathBuf,
}

/// Compile, link, resolve, and atomically publish one frozen production package.
pub fn create_frozen_package(
    graph: &Graph,
    catalog: &Catalog,
    target: &ExportTarget,
    destination: &Path,
    binary_available: impl Fn(&str) -> bool,
) -> Result<FrozenPackage, BundleError> {
    create_frozen_package_with_lock(
        graph,
        catalog,
        target,
        destination,
        binary_available,
        resolve_pixi_lock,
    )
}

/// Freeze with an explicitly selected Pixi executable.
///
/// Local runtimes use this to keep discovery, locking, and execution on the
/// same installed Pixi binary.
pub fn create_frozen_package_with_pixi(
    graph: &Graph,
    catalog: &Catalog,
    target: &ExportTarget,
    destination: &Path,
    binary_available: impl Fn(&str) -> bool,
    pixi: &Path,
) -> Result<FrozenPackage, BundleError> {
    create_frozen_package_with_lock(
        graph,
        catalog,
        target,
        destination,
        binary_available,
        |package| resolve_pixi_lock_at(package, pixi),
    )
}

fn create_frozen_package_with_lock(
    graph: &Graph,
    catalog: &Catalog,
    target: &ExportTarget,
    destination: &Path,
    binary_available: impl Fn(&str) -> bool,
    resolve_lock: impl FnOnce(&Path) -> Result<Vec<u8>, BundleError>,
) -> Result<FrozenPackage, BundleError> {
    graph.validate()?;
    catalog.verify_graph(graph)?;
    if destination.exists() {
        return Err(BundleError::DestinationExists(
            destination.display().to_string(),
        ));
    }
    let operators = used_operators(graph, catalog)?;
    let plan = build_plan(graph, &operators, target, binary_available);
    let options = CompileOptions {
        // This is stable execution metadata. The user-controlled Graph name is
        // deliberately restricted to the archive filename below.
        workflow_name: "somite-workflow".into(),
        output_dir: "results".into(),
        platforms: vec![target.platform.clone()],
        nextflow_version: PINNED_NEXTFLOW_VERSION.into(),
        openjdk_version: PINNED_OPENJDK_VERSION.into(),
    };
    let compiled = compile(graph, catalog, &options)?;
    let linked = link(
        graph,
        catalog,
        compiled.pixi_toml.as_bytes(),
        &LinkOptions {
            target_platform: target.platform.clone(),
            compiler_identity: format!("somite-nextflow@{}", env!("CARGO_PKG_VERSION")),
            nextflow_identity: format!("nextflow@{PINNED_NEXTFLOW_VERSION}"),
            openjdk_identity: format!("openjdk@{PINNED_OPENJDK_VERSION}"),
        },
    )?;

    let parent = destination.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("somite-run");
    let staging = parent.join(format!(
        ".{file_name}.somite-package-{}",
        std::process::id()
    ));
    if staging.exists() {
        return Err(BundleError::DestinationExists(
            staging.display().to_string(),
        ));
    }
    fs::create_dir(&staging)?;

    let result = (|| -> Result<RunClosure, BundleError> {
        write_text(&staging, "main.nf", &compiled.main_nf)?;
        write_text(&staging, "nextflow.config", &compiled.nextflow_config)?;
        write_text(&staging, "params.json", &compiled.params_json)?;
        write_text(&staging, "node-map.json", &compiled.node_map_json)?;
        write_text(&staging, "pixi.toml", &compiled.pixi_toml)?;
        write_json(&staging, "workflow.somite.json", graph)?;
        write_json(&staging, "toolchain/tools.json", &plan)?;
        write_json(&staging, "evidence/index.json", &EvidenceIndex::default())?;
        write_text(&staging, "README.md", &frozen_readme())?;
        for manifest in &linked.operator_manifests {
            write_json(
                &staging,
                &format!("operators/{}.json", manifest.operator_id),
                manifest,
            )?;
        }

        let lock = resolve_lock(&staging)?;
        if !staging.join("pixi.lock").is_file() {
            fs::write(staging.join("pixi.lock"), &lock)?;
        }
        let closure = freeze(&linked.draft, &lock)?;
        write_json(&staging, "run-closure.json", &closure)?;
        fs::rename(&staging, destination)?;
        Ok(closure)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    let closure = result?;
    Ok(FrozenPackage {
        plan,
        closure,
        directory: destination.to_path_buf(),
    })
}

/// Archive only the immutable files in a freshly frozen package.
pub fn archive_frozen_package(package: &FrozenPackage) -> Result<Vec<u8>, BundleError> {
    let mut files = BTreeMap::new();
    collect_files(&package.directory, &package.directory, &mut files)?;
    write_zip(files)
}

pub fn pixi_executable() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .as_deref()
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|directory| directory.join("pixi"))
        .find(|path| path.is_file())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".pixi/bin/pixi"))
                .filter(|path| path.is_file())
        })
}

/// Resolve project- or graph-relative import paths before freezing a package.
///
/// This is shared by every production entry point so the CLI and web runtime
/// compile identical input identities.
pub fn absolutize_import_paths(graph: &mut Graph, project_base: &Path, graph_base: &Path) {
    for node in &mut graph.nodes {
        let parameters: &[&str] = match node.operator.as_str() {
            "files.import" => &["path"],
            "files.import_fasta" | "manual.joinmap" => &["path"],
            "manual.allmaps_evidence" => &["map_path", "weights_path"],
            "files.import_paired" => &["r1", "r2"],
            _ => continue,
        };
        for parameter in parameters {
            let Some(ParamValue::String(value)) = node.params.get_mut(*parameter) else {
                continue;
            };
            let path = Path::new(value);
            if path.is_relative() {
                let project_candidate = project_base.join(path);
                let graph_candidate = graph_base.join(path);
                let resolved = if project_candidate.exists() || !graph_candidate.exists() {
                    project_candidate
                } else {
                    graph_candidate
                };
                *value = resolved.display().to_string();
            }
        }
    }
}

fn resolve_pixi_lock(package: &Path) -> Result<Vec<u8>, BundleError> {
    let pixi = pixi_executable().ok_or(BundleError::PixiMissing)?;
    resolve_pixi_lock_at(package, &pixi)
}

fn resolve_pixi_lock_at(package: &Path, pixi: &Path) -> Result<Vec<u8>, BundleError> {
    let output = Command::new(pixi)
        .args(["lock", "--no-install", "--no-progress", "--manifest-path"])
        .arg(package.join("pixi.toml"))
        .output()?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Pixi could not resolve the environment")
            .to_owned();
        return Err(BundleError::PixiLock(detail));
    }
    fs::read(package.join("pixi.lock")).map_err(BundleError::from)
}

fn write_text(root: &Path, relative: &str, contents: &str) -> Result<(), BundleError> {
    let destination = root.join(relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(destination, contents)?;
    Ok(())
}

fn write_json(root: &Path, relative: &str, value: &impl Serialize) -> Result<(), BundleError> {
    let mut encoded = serde_json::to_vec_pretty(value)?;
    encoded.push(b'\n');
    let destination = root.join(relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(destination, encoded)?;
    Ok(())
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), BundleError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("collected package path remains under root")
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(relative, fs::read(path)?);
        }
    }
    Ok(())
}

fn frozen_readme() -> String {
    "# Frozen Somite run\n\nThis package contains one pinned Somite Graph revision, exact Operator revisions, generated Nextflow DSL2, and a resolved Pixi lock. Run it with:\n\n```bash\npixi run --frozen run\n```\n\n`run-closure.json` identifies the target-specific executable closure. Validation evidence is stored separately under `evidence/`.\n".into()
}

/// Inspect the exact tools a frozen package will contain without resolving it.
pub fn plan_frozen_package(
    graph: &Graph,
    catalog: &Catalog,
    target: &ExportTarget,
    binary_available: impl Fn(&str) -> bool,
) -> Result<BundlePlan, BundleError> {
    graph.validate()?;
    catalog.verify_graph(graph)?;
    let operators = used_operators(graph, catalog)?;
    Ok(build_plan(graph, &operators, target, binary_available))
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
    let manual_count = tools
        .iter()
        .filter(|tool| tool.state == ToolState::ManualCheckpoint)
        .count();
    let details_count = tools
        .iter()
        .filter(|tool| tool.state == ToolState::MethodDetails)
        .count();
    let legacy_count = tools
        .iter()
        .filter(|tool| tool.state == ToolState::LegacySource)
        .count();
    BundlePlan {
        filename: format!("{}.somite-run.zip", safe_name(&target.archive_name)),
        platform: target.platform.clone(),
        channels: vec!["conda-forge".to_owned(), "bioconda".to_owned()],
        packages: packages.into_iter().collect(),
        tools,
        ready_count,
        installable_count,
        manual_count,
        details_count,
        legacy_count,
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
            detail: "Needs a reviewed Somite adapter: package discovery cannot infer typed ports, argv, or outputs.".to_owned(),
        };
    }
    if let Some(resolution) = &operator.resolution {
        let state = match resolution.kind {
            OperatorResolutionKind::ManualCheckpoint => ToolState::ManualCheckpoint,
            OperatorResolutionKind::MethodDetails => ToolState::MethodDetails,
            OperatorResolutionKind::LegacySource => ToolState::LegacySource,
            OperatorResolutionKind::Adapter => ToolState::AdapterNeeded,
        };
        return ToolRequirement {
            operator_id: operator.id.clone(),
            title: operator.title.clone(),
            binary: operator.bin.clone(),
            packages: operator.pixi.clone(),
            state,
            detail: resolution.detail.clone(),
        };
    }
    if operator.kind == OpKind::Reference {
        return ToolRequirement {
            operator_id: operator.id.clone(),
            title: operator.title.clone(),
            binary: None,
            packages: Vec::new(),
            state: ToolState::AdapterNeeded,
            detail: "Imported workflow structure; convert this component to a reviewed Somite operator before standalone execution.".to_owned(),
        };
    }
    if operator.kind == OpKind::Inprocess {
        return ToolRequirement {
            operator_id: operator.id.clone(),
            title: operator.title.clone(),
            binary: None,
            packages: Vec::new(),
            state: ToolState::BuiltIn,
            detail: "Included in the Somite runtime.".to_owned(),
        };
    }
    let binary = operator.bin.clone();
    let available = binary.as_deref().is_some_and(binary_available);
    let package_specs = operator.pixi.clone();
    let (state, detail) = if !package_specs.is_empty() {
        (
            ToolState::Installable,
            "Declared package will be resolved and locked by Pixi.".to_owned(),
        )
    } else if available {
        (ToolState::Ready, "Available on this machine.".to_owned())
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
        "somite-workflow".to_owned()
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
        archive.start_file(name, options)?;
        archive.write_all(&contents)?;
    }
    Ok(archive.finish()?.into_inner())
}

#[cfg(test)]
mod tests {
    use somite_ir::{Layout, Node, SCHEMA_VERSION};
    use somite_ops::Operator;
    use zip::ZipArchive;

    use super::*;

    fn operator(raw: &str) -> Operator {
        serde_json::from_str(raw).expect("operator fixture")
    }

    fn node(id: &str, op: &Operator) -> Node {
        Node {
            id: id.to_owned(),
            operator: op.id.clone(),
            operator_revision: op.revision().expect("operator revision"),
            ports: op.ir_ports(),
            params: BTreeMap::new(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
            color: None,
        }
    }

    #[test]
    fn frozen_package_and_archive_share_one_complete_nextflow_path() {
        let echo = operator(
            r#"{"id":"test.echo","title":"Echo","palette":[],"kind":"external","bin":"echo","pixi":["coreutils"],"ports":{},"argv":["hello"]}"#,
        );
        let mut catalog = Catalog::default();
        catalog.ops.insert(echo.id.clone(), echo.clone());
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![node("echo1", &echo)],
            edges: Vec::new(),
            annotations: Vec::new(),
        };
        let temporary = tempfile::tempdir().expect("temporary directory");
        let destination = temporary.path().join("frozen");
        let package = create_frozen_package_with_lock(
            &graph,
            &catalog,
            &ExportTarget::new("RNA seq", "linux-64"),
            &destination,
            |_| false,
            |_| Ok(b"version: 6\n".to_vec()),
        )
        .expect("frozen package");
        assert_eq!(package.plan.filename, "RNA-seq.somite-run.zip");
        assert_eq!(package.plan.installable_count, 1);
        assert!(package.closure.closure_digest.starts_with("blake3:"));
        let mut renamed_graph = graph.clone();
        renamed_graph.name = Some("Renamed workflow".into());
        let renamed = create_frozen_package_with_lock(
            &renamed_graph,
            &catalog,
            &ExportTarget::new("Renamed workflow", "linux-64"),
            &temporary.path().join("renamed"),
            |_| false,
            |_| Ok(b"version: 6\n".to_vec()),
        )
        .expect("renamed frozen package");
        assert_eq!(renamed.plan.filename, "Renamed-workflow.somite-run.zip");
        assert_eq!(renamed.closure, package.closure);
        for name in [
            "main.nf",
            "nextflow.config",
            "params.json",
            "node-map.json",
            "pixi.toml",
            "pixi.lock",
            "workflow.somite.json",
            "run-closure.json",
            "evidence/index.json",
            "operators/test.echo.json",
        ] {
            assert!(destination.join(name).is_file(), "missing {name}");
        }

        let bytes = archive_frozen_package(&package).expect("archive");
        let mut zip = ZipArchive::new(Cursor::new(bytes)).expect("zip");
        for name in [
            "main.nf",
            "pixi.lock",
            "run-closure.json",
            "workflow.somite.json",
            "operators/test.echo.json",
            "toolchain/tools.json",
        ] {
            assert!(zip.by_name(name).is_ok(), "missing {name}");
        }
        assert!(zip.by_name("run.sh").is_err());

        let duplicate = create_frozen_package_with_lock(
            &graph,
            &catalog,
            &ExportTarget::new("RNA seq", "linux-64"),
            &destination,
            |_| false,
            |_| Ok(b"version: 6\n".to_vec()),
        );
        assert!(matches!(duplicate, Err(BundleError::DestinationExists(_))));
    }

    #[test]
    fn paper_gap_is_an_adapter_requirement_not_an_install_claim() {
        let gap = operator(
            r#"{"id":"gap.missing","title":"Needs tool adapter","palette":[],"kind":"inprocess","ports":{"out":[{"name":"out","type":"Directory","optional":true}]},"params":{"tool":{"type":"string"}}}"#,
        );
        let mut catalog = Catalog::default();
        catalog.ops.insert(gap.id.clone(), gap.clone());
        let mut gap_node = node("gap1", &gap);
        gap_node.params.insert(
            "tool".to_owned(),
            ParamValue::String("Trimmomatic".to_owned()),
        );
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: vec![gap_node],
            edges: Vec::new(),
            annotations: Vec::new(),
        };
        let plan = plan_frozen_package(
            &graph,
            &catalog,
            &ExportTarget::new("paper", "linux-64"),
            |_| true,
        )
        .expect("plan");
        assert_eq!(plan.adapter_count, 1);
        assert_eq!(plan.tools[0].state, ToolState::AdapterNeeded);
        assert_eq!(plan.tools[0].title, "Trimmomatic");
    }
}
