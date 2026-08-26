use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use somite_cook::{cook_graph, NodeState, Project};
use somite_ir::{Graph, ParamValue};
use somite_nextflow::{
    compile, CompileOptions, CompiledWorkflow, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION,
};
use somite_ops::{current_pixi_platform, Catalog};
use somite_paper::{extract_from_path, reconstruct};

fn operators_dir() -> PathBuf {
    if let Ok(p) = env::var("SOMITE_OPERATORS") {
        return PathBuf::from(p);
    }
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let a = cwd.join("operators");
    if a.is_dir() {
        return a;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators")
}

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "help".into());
    match cmd.as_str() {
        "cook" => {
            let graph_path = args.next().context("somite cook <graph.somite.json>")?;
            cook_cmd(Path::new(&graph_path))?;
        }
        "compile" => {
            let graph_path = args
                .next()
                .context("somite compile <graph.somite.json> <output-directory>")?;
            let output = args
                .next()
                .context("somite compile <graph.somite.json> <output-directory>")?;
            compile_cmd(Path::new(&graph_path), Path::new(&output))?;
        }
        "paper" => {
            let paper_path = args
                .next()
                .context("somite paper <methods.txt|paper.pdf>")?;
            paper_cmd(Path::new(&paper_path))?;
        }
        "palette" => {
            let cat = Catalog::load_dir(&operators_dir())?;
            for (g, ops) in cat.groups() {
                println!("{g}");
                for op in ops {
                    println!("  {}  {}", op.id, op.title);
                }
            }
        }
        "env" => {
            let cat = Catalog::load_dir(&operators_dir())?;
            let mut seen = std::collections::BTreeSet::new();
            for op in cat.ops.values() {
                for package in &op.pixi {
                    seen.insert(package);
                }
            }
            println!("# Pixi packages declared by the operator catalog");
            for package in seen {
                println!("{package}");
            }
        }
        "help" | "-h" | "--help" => {
            println!("somite cook <graph.json>          run the graph");
            println!("somite compile <graph> <dir>     build a Nextflow/Pixi run package");
            println!("somite paper <methods.txt|pdf>    rebuild graph from a paper");
            println!("somite palette                    list NCBI / Ensembl / nf-core / QC");
            println!("somite env                        list Pixi package requirements");
        }
        other => bail!("unknown command {other}"),
    }
    Ok(())
}

fn compile_cmd(graph_path: &Path, output: &Path) -> Result<()> {
    let raw = fs::read_to_string(graph_path)
        .with_context(|| format!("read graph {}", graph_path.display()))?;
    let source_graph: Graph = serde_json::from_str(&raw)
        .with_context(|| format!("parse graph {}", graph_path.display()))?;
    let mut runnable_graph = source_graph.clone();
    let cwd = env::current_dir()?;
    let graph_dir = graph_path.parent().unwrap_or(Path::new("."));
    let graph_base = if graph_dir.is_absolute() {
        graph_dir.to_path_buf()
    } else {
        cwd.join(graph_dir)
    };
    let project_base = if cwd.join("operators").is_dir() || cwd.join("testdata").is_dir() {
        cwd.clone()
    } else {
        graph_base.clone()
    };
    absolutize_import_paths(&mut runnable_graph, &project_base, &graph_base);

    let workflow_name = graph_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("somite-workflow")
        .to_owned();
    let options = CompileOptions {
        workflow_name,
        output_dir: "results".into(),
        platforms: vec![current_pixi_platform().into()],
        nextflow_version: PINNED_NEXTFLOW_VERSION.into(),
        openjdk_version: PINNED_OPENJDK_VERSION.into(),
    };
    let catalog = Catalog::load_dir(&operators_dir())?;
    let compiled = compile(&runnable_graph, &catalog, &options)?;
    write_run_package(output, &source_graph, &compiled)?;

    let display_output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        cwd.join(output)
    };
    println!(
        "compiled {} nodes and {} edges into {}",
        source_graph.nodes.len(),
        source_graph.edges.len(),
        display_output.display()
    );
    println!(
        "run: pixi run --manifest-path {} run",
        display_output.join("pixi.toml").display()
    );
    Ok(())
}

fn absolutize_import_paths(graph: &mut Graph, project_base: &Path, graph_base: &Path) {
    for node in &mut graph.nodes {
        let parameters: &[&str] = match node.operator.as_str() {
            "files.import" => &["path"],
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

fn write_run_package(output: &Path, graph: &Graph, compiled: &CompiledWorkflow) -> Result<()> {
    if output.exists() {
        bail!("output path already exists: {}", output.display());
    }
    let parent = output.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("create output parent {}", parent.display()))?;
    let file_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("somite-run");
    let staging = parent.join(format!(
        ".{file_name}.somite-compile-{}",
        std::process::id()
    ));
    if staging.exists() {
        bail!("staging path already exists: {}", staging.display());
    }
    fs::create_dir(&staging)
        .with_context(|| format!("create staging directory {}", staging.display()))?;

    let mut graph_json = serde_json::to_string_pretty(graph)?;
    graph_json.push('\n');
    let files = [
        ("main.nf", compiled.main_nf.as_str()),
        ("nextflow.config", compiled.nextflow_config.as_str()),
        ("params.json", compiled.params_json.as_str()),
        ("node-map.json", compiled.node_map_json.as_str()),
        ("pixi.toml", compiled.pixi_toml.as_str()),
        ("workflow.somite.json", graph_json.as_str()),
    ];
    let result = (|| -> Result<()> {
        for (name, contents) in files {
            fs::write(staging.join(name), contents)
                .with_context(|| format!("write generated {name}"))?;
        }
        fs::rename(&staging, output).with_context(|| {
            format!(
                "move completed run package from {} to {}",
                staging.display(),
                output.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn cook_cmd(graph_path: &Path) -> Result<()> {
    let raw = fs::read_to_string(graph_path)?;
    let g: Graph = serde_json::from_str(&raw)?;
    let cwd = env::current_dir()?;
    let project_root = if cwd.join("operators").is_dir() || cwd.join("testdata").is_dir() {
        cwd
    } else {
        graph_path.parent().unwrap_or(&cwd).to_path_buf()
    };
    let project = Project::open(&project_root)?;
    let cat = Catalog::load_dir(&operators_dir())?;
    let report = cook_graph(&project, &cat, &g)?;
    for (id, st) in &report.states {
        let tag = match st {
            NodeState::Cached => "cached",
            NodeState::Done => "done",
            NodeState::Failed => "failed",
            NodeState::Skipped => "skipped",
        };
        let arts = report
            .artifacts
            .get(id)
            .map(|m| {
                m.values()
                    .map(|a| format!("{}:{}", a.basename, a.size))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        println!("{id}\t{tag}\t{arts}");
    }
    for (id, e) in &report.errors {
        eprintln!("{id}\tERROR\t{e}");
    }
    if !report.errors.is_empty() {
        bail!("{} node(s) failed", report.errors.len());
    }
    Ok(())
}

fn paper_cmd(path: &Path) -> Result<()> {
    let cat = Catalog::load_dir(&operators_dir())?;
    let extracted = extract_from_path(path)?;
    eprintln!("# via={:?}", extracted.via);
    let r = reconstruct(&cat, &extracted.text);
    for w in &r.warnings {
        eprintln!("warning: {w}");
    }
    eprintln!(
        "# assay={:?} nodes={} edges={}",
        r.assay,
        r.graph.nodes.len(),
        r.graph.edges.len()
    );
    println!("{}", serde_json::to_string_pretty(&r.graph)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_graph() -> Graph {
        serde_json::from_str(include_str!(
            "../../../spikes/executor-identity/native/fastp-fastqc.somite.json"
        ))
        .expect("paired graph fixture")
    }

    fn compiled_fixture() -> CompiledWorkflow {
        CompiledWorkflow {
            main_nf: "nextflow.enable.dsl=2\n".into(),
            nextflow_config: "process.cache = 'deep'\n".into(),
            params_json: "{}\n".into(),
            node_map_json: "{}\n".into(),
            pixi_toml: "[workspace]\nname = \"test\"\n".into(),
        }
    }

    #[test]
    fn import_paths_follow_the_project_root_convention() {
        let mut graph = fixture_graph();
        absolutize_import_paths(
            &mut graph,
            Path::new("/project"),
            Path::new("/project/workflows"),
        );

        assert_eq!(
            graph.nodes[0].params.get("r1"),
            Some(&ParamValue::String(
                "/project/fixtures/paired_R1.fastq".into()
            ))
        );
        assert_eq!(
            graph.nodes[0].params.get("r2"),
            Some(&ParamValue::String(
                "/project/fixtures/paired_R2.fastq".into()
            ))
        );
    }

    #[test]
    fn graph_relative_imports_work_when_project_candidates_do_not_exist() {
        let root = tempfile::tempdir().expect("temporary directory");
        let project = root.path().join("project");
        let graph_dir = root.path().join("workflow");
        fs::create_dir_all(graph_dir.join("fixtures")).expect("fixture directory");
        fs::write(graph_dir.join("fixtures/paired_R1.fastq"), "r1").expect("r1");
        fs::write(graph_dir.join("fixtures/paired_R2.fastq"), "r2").expect("r2");
        let mut graph = fixture_graph();

        absolutize_import_paths(&mut graph, &project, &graph_dir);

        assert_eq!(
            graph.nodes[0].params.get("r1"),
            Some(&ParamValue::String(
                graph_dir
                    .join("fixtures/paired_R1.fastq")
                    .display()
                    .to_string()
            ))
        );
    }

    #[test]
    fn run_package_is_complete_and_never_overwrites() {
        let root = tempfile::tempdir().expect("temporary directory");
        let output = root.path().join("compiled");
        write_run_package(&output, &fixture_graph(), &compiled_fixture())
            .expect("write run package");

        for name in [
            "main.nf",
            "nextflow.config",
            "params.json",
            "node-map.json",
            "pixi.toml",
            "workflow.somite.json",
        ] {
            assert!(output.join(name).is_file(), "missing {name}");
        }
        assert!(write_run_package(&output, &fixture_graph(), &compiled_fixture()).is_err());
    }
}
