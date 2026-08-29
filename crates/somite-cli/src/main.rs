use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use somite_bundle::{
    absolutize_import_paths, create_frozen_package, pixi_executable, ExportTarget,
};
use somite_cook::{cook_graph, NodeState, Project};
use somite_ir::Graph;
use somite_ops::{current_pixi_platform, snakemake_local, Catalog};
use somite_paper::{extract_from_path, reconstruct, Reconstruction};

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
        "cook-oracle" => {
            let graph_path = args
                .next()
                .context("somite cook-oracle <graph.somite.json>")?;
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
        "import-snakemake" => {
            let project = args.next().context(
                "somite import-snakemake <project-or-Snakefile> <output.somite.json> [targets...]",
            )?;
            let output = args.next().context(
                "somite import-snakemake <project-or-Snakefile> <output.somite.json> [targets...]",
            )?;
            let targets = args.collect::<Vec<_>>();
            import_snakemake_cmd(Path::new(&project), Path::new(&output), &targets)?;
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
            println!("somite compile <graph> <dir>     build a Nextflow/Pixi run package");
            println!("somite cook-oracle <graph>       test the native reference oracle");
            println!("somite paper <methods.txt|pdf>    rebuild graph from a paper");
            println!(
                "somite import-snakemake <project> <graph> [targets...]  visualize local rules"
            );
            println!("somite palette                    list NCBI / Ensembl / nf-core / QC");
            println!("somite env                        list Pixi package requirements");
        }
        other => bail!("unknown command {other}"),
    }
    Ok(())
}

fn import_snakemake_cmd(project: &Path, output: &Path, targets: &[String]) -> Result<()> {
    let catalog = Catalog::load_dir(&operators_dir())?;
    let reference_revision = catalog.revision("workflow.reference")?;
    let pixi = pixi_executable();
    let imported = snakemake_local::import(project, targets, pixi.as_deref(), &reference_revision)?;
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("create output directory {}", parent.display()))?;
    }
    fs::write(output, serde_json::to_vec_pretty(&imported.graph)?)
        .with_context(|| format!("write graph {}", output.display()))?;
    println!(
        "imported {} rules and {} dependencies from {} via {} into {}",
        imported.graph.nodes.len(),
        imported.graph.edges.len(),
        imported.snakefile.display(),
        imported.runner,
        output.display()
    );
    Ok(())
}

fn compile_cmd(graph_path: &Path, output: &Path) -> Result<()> {
    let raw = fs::read_to_string(graph_path)
        .with_context(|| format!("read graph {}", graph_path.display()))?;
    let mut source_graph: Graph = serde_json::from_str(&raw)
        .with_context(|| format!("parse graph {}", graph_path.display()))?;
    let catalog = Catalog::load_dir(&operators_dir())?;
    catalog.pin_graph(&mut source_graph)?;
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

    let workflow_name = source_graph
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            graph_path
                .file_stem()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("somite-workflow")
                .to_owned()
        });
    let package = create_frozen_package(
        &runnable_graph,
        &catalog,
        &ExportTarget::new(workflow_name, current_pixi_platform()),
        output,
        |_| false,
    )?;

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
    println!("closure: {}", package.closure.closure_digest);
    Ok(())
}

fn cook_cmd(graph_path: &Path) -> Result<()> {
    let raw = fs::read_to_string(graph_path)?;
    let mut g: Graph = serde_json::from_str(&raw)?;
    let cwd = env::current_dir()?;
    let project_root = if cwd.join("operators").is_dir() || cwd.join("testdata").is_dir() {
        cwd
    } else {
        graph_path.parent().unwrap_or(&cwd).to_path_buf()
    };
    let project = Project::open(&project_root)?;
    let cat = Catalog::load_dir(&operators_dir())?;
    cat.pin_graph(&mut g)?;
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

    let Some(candidate) = r.active() else {
        for line in no_candidate_diagnostics(&r) {
            eprintln!("{line}");
        }
        return Ok(());
    };

    for w in &r.warnings {
        eprintln!("warning: {w}");
    }
    eprintln!(
        "# assay={:?} nodes={} edges={}",
        candidate.assay,
        candidate.graph.nodes.len(),
        candidate.graph.edges.len()
    );
    println!("{}", serde_json::to_string_pretty(&candidate.graph)?);
    Ok(())
}

fn no_candidate_diagnostics(reconstruction: &Reconstruction) -> Vec<String> {
    let mut lines = vec![format!("# outcome={:?}", reconstruction.outcome)];
    lines.extend(
        reconstruction
            .mentions
            .iter()
            .map(|mention| format!("method: {}", mention.display_name)),
    );
    lines.extend(
        reconstruction
            .warnings
            .iter()
            .map(|warning| format!("warning: {warning}")),
    );
    lines
}

#[cfg(test)]
mod tests {
    use somite_ir::ParamValue;

    use super::*;

    fn fixture_graph() -> Graph {
        serde_json::from_str(include_str!(
            "../../../spikes/executor-identity/native/fastp-fastqc.somite.json"
        ))
        .expect("paired graph fixture")
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
    fn paper_without_a_draft_reports_the_truthful_outcome_and_methods() {
        let catalog = Catalog::load_dir(&operators_dir()).expect("operator catalog");
        let reconstruction = reconstruct(
            &catalog,
            "Methods\nNanopore reads were trimmed with Porechop and analyzed with dnaPipeTE.",
        );
        assert!(reconstruction.active().is_none());

        let diagnostics = no_candidate_diagnostics(&reconstruction);
        assert!(diagnostics
            .iter()
            .any(|line| line == "# outcome=RecognizedUnsupported"));
        assert!(diagnostics.iter().any(|line| line == "method: Porechop"));
        assert!(diagnostics.iter().any(|line| line == "method: dnaPipeTE"));
        assert!(diagnostics.iter().any(|line| {
            line == "warning: Somite recognized these computational methods, but workflow support for them is not available yet."
        }));
        assert!(!diagnostics.iter().any(|line| line.contains("cover page")));
    }
}
