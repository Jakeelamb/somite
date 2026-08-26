//! Resolve a local Snakemake project through Snakemake's own rule graph.
//!
//! Somite does not interpret Python or reimplement Snakemake here. The adapter
//! finds the workflow entrypoint, invokes the project's declared toolchain, and
//! feeds the engine-authored DOT into the shared structural graph compiler.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use somite_ir::Graph;
use thiserror::Error;

use crate::workflow::{graph_from_dot, DotFlavor};

const MAX_TARGETS: usize = 64;
const MAX_GRAPH_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct LocalSnakemakeImport {
    pub project: PathBuf,
    pub snakefile: PathBuf,
    pub targets: Vec<String>,
    pub runner: String,
    pub revision: String,
    pub graph: Graph,
}

#[derive(Debug, Error)]
pub enum LocalSnakemakeError {
    #[error("local workflow path does not exist: {0}")]
    MissingProject(String),
    #[error("could not find Snakefile or workflow/Snakefile under {0}")]
    MissingSnakefile(String),
    #[error("invalid Snakemake target: {0}")]
    InvalidTarget(String),
    #[error("at most {MAX_TARGETS} Snakemake targets can be previewed at once")]
    TooManyTargets,
    #[error("this project needs Snakemake or Pixi before it can be visualized")]
    MissingRunner,
    #[error("could not inspect local workflow: {0}")]
    Io(#[from] std::io::Error),
    #[error("Snakemake could not build the rule graph: {0}")]
    Snakemake(String),
    #[error("Snakemake returned a rule graph larger than 5 MiB")]
    GraphTooLarge,
    #[error("Snakemake rule graph: {0}")]
    Graph(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Runner {
    Pixi(PathBuf),
    Snakemake(PathBuf),
}

/// Import a local Snakemake project without executing any workflow jobs.
pub fn import(
    supplied_path: &Path,
    targets: &[String],
    pixi: Option<&Path>,
    reference_operator_revision: &str,
) -> Result<LocalSnakemakeImport, LocalSnakemakeError> {
    let (project, snakefile) = resolve_project(supplied_path)?;
    let targets = normalize_targets(targets)?;
    let runner = resolve_runner(&project, pixi).ok_or(LocalSnakemakeError::MissingRunner)?;
    let output = run_rulegraph(&runner, &project, &snakefile, &targets)?;
    if output.stdout.len() > MAX_GRAPH_BYTES {
        return Err(LocalSnakemakeError::GraphTooLarge);
    }
    if !output.status.success() {
        return Err(LocalSnakemakeError::Snakemake(last_detail(&output.stderr)));
    }
    let dot = String::from_utf8(output.stdout)
        .map_err(|error| LocalSnakemakeError::Snakemake(error.to_string()))?;
    let revision = source_revision(&project);
    let workflow = project.display().to_string();
    let graph = graph_from_dot(
        DotFlavor::Snakemake,
        &workflow,
        &revision,
        reference_operator_revision,
        &dot,
    )
    .map_err(LocalSnakemakeError::Graph)?;
    Ok(LocalSnakemakeImport {
        project,
        snakefile,
        targets,
        runner: runner.label().to_owned(),
        revision,
        graph,
    })
}

fn resolve_project(path: &Path) -> Result<(PathBuf, PathBuf), LocalSnakemakeError> {
    let canonical = path
        .canonicalize()
        .map_err(|_| LocalSnakemakeError::MissingProject(path.display().to_string()))?;
    if canonical.is_file() {
        let file_name = canonical.file_name().and_then(|name| name.to_str());
        if file_name != Some("Snakefile")
            && canonical.extension().and_then(|ext| ext.to_str()) != Some("smk")
        {
            return Err(LocalSnakemakeError::MissingSnakefile(
                canonical.display().to_string(),
            ));
        }
        let parent = canonical.parent().ok_or_else(|| {
            LocalSnakemakeError::MissingSnakefile(canonical.display().to_string())
        })?;
        let project = if parent.file_name().and_then(|name| name.to_str()) == Some("workflow") {
            parent.parent().unwrap_or(parent)
        } else {
            parent
        };
        return Ok((project.to_path_buf(), canonical));
    }
    if !canonical.is_dir() {
        return Err(LocalSnakemakeError::MissingProject(
            canonical.display().to_string(),
        ));
    }
    for candidate in [
        canonical.join("workflow/Snakefile"),
        canonical.join("Snakefile"),
    ] {
        if candidate.is_file() {
            return Ok((canonical, candidate));
        }
    }
    Err(LocalSnakemakeError::MissingSnakefile(
        canonical.display().to_string(),
    ))
}

fn normalize_targets(targets: &[String]) -> Result<Vec<String>, LocalSnakemakeError> {
    if targets.len() > MAX_TARGETS {
        return Err(LocalSnakemakeError::TooManyTargets);
    }
    let mut unique = BTreeSet::new();
    for target in targets {
        let target = target.trim();
        if target.is_empty() {
            continue;
        }
        if target.len() > 128
            || !target
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
            || !target.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
            })
        {
            return Err(LocalSnakemakeError::InvalidTarget(target.to_owned()));
        }
        unique.insert(target.to_owned());
    }
    Ok(unique.into_iter().collect())
}

fn resolve_runner(project: &Path, pixi: Option<&Path>) -> Option<Runner> {
    let declares_pixi = project.join("pixi.toml").is_file()
        || project.join("pixi.lock").is_file()
        || project
            .join("pyproject.toml")
            .is_file()
            .then(|| std::fs::read_to_string(project.join("pyproject.toml")).ok())
            .flatten()
            .is_some_and(|text| text.contains("[tool.pixi.workspace]"));
    if declares_pixi {
        if let Some(pixi) = pixi.filter(|path| path.is_file()) {
            return Some(Runner::Pixi(pixi.to_path_buf()));
        }
        let local = project.join(".pixi/envs/default/bin/snakemake");
        if local.is_file() {
            return Some(Runner::Snakemake(local));
        }
    }
    executable_path("snakemake").map(Runner::Snakemake)
}

fn run_rulegraph(
    runner: &Runner,
    project: &Path,
    snakefile: &Path,
    targets: &[String],
) -> Result<std::process::Output, std::io::Error> {
    let mut command = Command::new("timeout");
    command.arg("45s");
    match runner {
        Runner::Pixi(path) => {
            command.arg(path).args(["run", "snakemake"]);
        }
        Runner::Snakemake(path) => {
            command.arg(path);
        }
    }
    command
        .arg("--snakefile")
        .arg(snakefile)
        .args(["--cores", "1"])
        .args(targets)
        .args(["--rulegraph", "dot", "--nocolor", "--nolock"])
        .current_dir(project)
        .output()
}

fn source_revision(project: &Path) -> String {
    let commit = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .current_dir(project)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let dirty = Command::new("git")
        .args([
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--",
            "workflow",
            "Snakefile",
            "config",
            "pixi.toml",
            "pixi.lock",
            "pyproject.toml",
        ])
        .current_dir(project)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| !output.stdout.is_empty());
    match (commit, dirty) {
        (Some(commit), true) => format!("git:{commit}+worktree"),
        (Some(commit), false) => format!("git:{commit}"),
        (None, _) => "local-worktree".to_owned(),
    }
}

fn executable_path(binary: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .as_deref()
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|directory| directory.join(binary))
        .find(|path| path.is_file())
}

fn last_detail(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Snakemake did not produce a rule graph")
        .trim()
        .to_owned()
}

impl Runner {
    fn label(&self) -> &'static str {
        match self {
            Self::Pixi(_) => "pixi",
            Self::Snakemake(_) => "snakemake",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn rejects_targets_that_could_become_command_options() {
        let error = normalize_targets(&["--delete-all-output".to_owned()])
            .expect_err("unsafe target must fail");
        assert!(matches!(error, LocalSnakemakeError::InvalidTarget(_)));
    }

    #[cfg(unix)]
    #[test]
    fn imports_engine_authored_rulegraph_through_pixi() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let project = temporary.path().join("project");
        fs::create_dir_all(project.join("workflow")).expect("workflow directory");
        fs::write(
            project.join("workflow/Snakefile"),
            "rule all:\n    input: 'done'\n",
        )
        .expect("Snakefile");
        fs::write(project.join("pixi.lock"), "test").expect("Pixi marker");
        let pixi = temporary.path().join("pixi");
        fs::write(
            &pixi,
            "#!/bin/sh\nprintf '%s\\n' 'digraph snakemake_dag {' '0[label = \"prepare\"];' '1[label = \"all\"];' '0 -> 1' '}'\n",
        )
        .expect("fake Pixi");
        let mut permissions = fs::metadata(&pixi).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&pixi, permissions).expect("executable Pixi");

        let imported = import(&project, &["all".to_owned()], Some(&pixi), "operator-rev")
            .expect("local import");

        assert_eq!(imported.runner, "pixi");
        assert_eq!(imported.targets, vec!["all"]);
        assert_eq!(imported.graph.nodes.len(), 2);
        assert_eq!(imported.graph.edges.len(), 1);
        assert_eq!(imported.graph.edges[0].from_node, "prepare");
        assert_eq!(imported.graph.edges[0].to_node, "all");
    }
}
