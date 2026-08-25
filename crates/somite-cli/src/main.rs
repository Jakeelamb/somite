use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use somite_cook::{cook_graph, NodeState, Project};
use somite_ir::Graph;
use somite_ops::Catalog;
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
        "paper" => {
            let paper_path = args.next().context("somite paper <methods.txt|paper.pdf>")?;
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
            println!("somite paper <methods.txt|pdf>    rebuild graph from a paper");
            println!("somite palette                    list NCBI / Ensembl / nf-core / QC");
            println!("somite env                        list Pixi package requirements");
        }
        other => bail!("unknown command {other}"),
    }
    Ok(())
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
