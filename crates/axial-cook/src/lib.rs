//! Cook: hash inputs, skip if cached, else run (PATH or `conda run`).

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use axial_ir::{Direction, Graph, Node, ParamValue, PortType};
use axial_ops::{Catalog, Cost, OpKind, Operator, render_argv, Bindings};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CookError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Ops(#[from] axial_ops::OpsError),
    #[error(transparent)]
    Ir(#[from] axial_ir::IrError),
    #[error("{0}")]
    Msg(String),
    #[error("bin not found: {0}")]
    BinNotFound(String),
    #[error("{op} exit {code}")]
    Exit { op: String, code: i32 },
    #[error("glob {0}: {1}")]
    Glob(String, String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactMeta {
    pub basename: String,
    pub declared_type: PortType,
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeState {
    Cached,
    Done,
    Failed,
    Skipped,
}

pub struct Project {
    pub root: PathBuf,
    pub cache: PathBuf,
}

impl Project {
    pub fn open(root: &Path) -> io::Result<Self> {
        let cache = root.join(".axial").join("cache");
        fs::create_dir_all(cache.join("cas"))?;
        fs::create_dir_all(cache.join("meta"))?;
        fs::create_dir_all(cache.join("index"))?;
        Ok(Self {
            root: root.to_path_buf(),
            cache,
        })
    }

    pub fn put_file(&self, src: &Path, declared: PortType) -> io::Result<(String, ArtifactMeta)> {
        let mut f = fs::File::open(src)?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = [0u8; 1 << 16];
        let mut size = 0u64;
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
        let hash = hasher.finalize().to_hex().to_string();
        let cas = self.cas_path(&hash);
        if !cas.exists() {
            if let Some(p) = cas.parent() {
                fs::create_dir_all(p)?;
            }
            fs::copy(src, &cas)?;
        }
        let basename = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let meta = ArtifactMeta {
            basename,
            declared_type: declared,
            size,
            hash: hash.clone(),
        };
        fs::write(
            self.cache.join("meta").join(format!("{hash}.json")),
            serde_json::to_vec_pretty(&meta).unwrap_or_default(),
        )?;
        Ok((hash, meta))
    }

    pub fn put_dir(&self, src: &Path, declared: PortType) -> io::Result<(String, ArtifactMeta)> {
        let mut hasher = blake3::Hasher::new();
        let size = hash_tree(src, &mut hasher)?;
        let hash = hasher.finalize().to_hex().to_string();
        let cas = self.cas_path(&hash);
        if !cas.exists() {
            if let Some(p) = cas.parent() {
                fs::create_dir_all(p)?;
            }
            copy_tree(src, &cas)?;
        }
        let basename = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("dir")
            .to_string();
        let meta = ArtifactMeta {
            basename,
            declared_type: declared,
            size,
            hash: hash.clone(),
        };
        fs::write(
            self.cache.join("meta").join(format!("{hash}.json")),
            serde_json::to_vec_pretty(&meta).unwrap_or_default(),
        )?;
        Ok((hash, meta))
    }

    pub fn cas_path(&self, hash: &str) -> PathBuf {
        let (a, b) = hash.split_at(2.min(hash.len()));
        self.cache.join("cas").join(a).join(&b[0..2.min(b.len())]).join(hash)
    }

    pub fn stage(&self, meta: &ArtifactMeta, dest_dir: &Path) -> io::Result<PathBuf> {
        fs::create_dir_all(dest_dir)?;
        let dest = dest_dir.join(&meta.basename);
        let src = self.cas_path(&meta.hash);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&dest);
        if src.is_dir() {
            #[cfg(unix)]
            {
                if std::os::unix::fs::symlink(&src, &dest).is_err() {
                    copy_tree(&src, &dest)?;
                }
            }
            #[cfg(not(unix))]
            copy_tree(&src, &dest)?;
            return Ok(dest);
        }
        #[cfg(unix)]
        {
            if std::os::unix::fs::symlink(&src, &dest).is_err() {
                fs::copy(&src, &dest)?;
            }
        }
        #[cfg(not(unix))]
        fs::copy(&src, &dest)?;
        Ok(dest)
    }
}

fn hash_tree(src: &Path, h: &mut blake3::Hasher) -> io::Result<u64> {
    let mut size = 0u64;
    let mut ents: Vec<_> = fs::read_dir(src)?.collect::<Result<Vec<_>, _>>()?;
    ents.sort_by_key(|e| e.file_name());
    let mut buf = [0u8; 1 << 16];
    for ent in ents {
        let name = ent.file_name();
        h.update(name.to_string_lossy().as_bytes());
        let p = ent.path();
        if p.is_dir() {
            size += hash_tree(&p, h)?;
        } else {
            let mut f = fs::File::open(&p)?;
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
                size += n as u64;
            }
        }
    }
    Ok(size)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for ent in fs::read_dir(src)? {
        let ent = ent?;
        let to = dst.join(ent.file_name());
        let from = ent.path();
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn cook_key(
    op: &Operator,
    params: &BTreeMap<String, ParamValue>,
    inputs: &BTreeMap<String, String>,
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(op.id.as_bytes());
    if let Ok(s) = serde_json::to_vec(op) {
        h.update(&s);
    }
    if let Ok(s) = serde_json::to_vec(params) {
        h.update(&s);
    }
    if let Ok(s) = serde_json::to_vec(inputs) {
        h.update(&s);
    }
    h.finalize().to_hex().to_string()
}

fn glob_one(dir: &Path, pattern: &str, exclude: &[String]) -> Result<Option<PathBuf>, CookError> {
    let pat = Path::new(pattern);
    let parent = pat.parent().unwrap_or(dir);
    let file_pat = pat.file_name().and_then(|s| s.to_str()).unwrap_or("*");
    let search = if parent.is_absolute() { parent.to_path_buf() } else { dir.join(parent) };
    if !search.is_dir() {
        return Ok(None);
    }
    let mut hits = Vec::new();
    for ent in fs::read_dir(&search)? {
        let ent = ent?;
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if !wild(file_pat, &name) {
            continue;
        }
        if exclude.iter().any(|e| wild(e, &name)) {
            continue;
        }
        hits.push(ent.path());
    }
    match hits.len() {
        0 => Ok(None),
        1 => Ok(Some(hits.remove(0))),
        n => Err(CookError::Glob(
            file_pat.into(),
            format!("{n} matches"),
        )),
    }
}

fn wild(pat: &str, name: &str) -> bool {
    if pat == "*" {
        return true;
    }
    if let Some(suf) = pat.strip_prefix('*') {
        return name.ends_with(suf);
    }
    if let Some(pre) = pat.strip_suffix('*') {
        return name.starts_with(pre);
    }
    pat == name
}

fn which(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        return p.exists().then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    for d in std::env::split_paths(&path) {
        let p = d.join(bin);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn conda_env_bin(op: &Operator) -> Option<PathBuf> {
    let bin = op.bin.as_deref()?;
    let envn = op.conda.as_ref()?.name.as_str();
    let mut cands = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        for root in ["miniconda3", "mambaforge", "miniforge3", "anaconda3"] {
            cands.push(
                PathBuf::from(&home)
                    .join(root)
                    .join("envs")
                    .join(envn)
                    .join("bin")
                    .join(bin),
            );
        }
    }
    if let Ok(prefix) = std::env::var("CONDA_PREFIX") {
        if let Some(parent) = Path::new(&prefix).parent() {
            cands.push(parent.join("envs").join(envn).join("bin").join(bin));
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

fn conda_prefix(op: &Operator, rest: &[String]) -> Result<Command, CookError> {
    let bin = op.bin.as_deref().unwrap_or("");
    if let Some(exe) = which(bin).or_else(|| conda_env_bin(op)) {
        let mut c = Command::new(exe);
        c.args(rest);
        return Ok(c);
    }
    if let Some(conda) = &op.conda {
        if let Some(exe) = which("conda")
            .or_else(|| which("mamba"))
            .or_else(|| which("micromamba"))
        {
            let mut c = Command::new(exe);
            c.arg("run")
                .arg("-n")
                .arg(&conda.name)
                .arg("--no-capture-output");
            c.arg(bin);
            c.args(rest);
            return Ok(c);
        }
    }
    Err(CookError::BinNotFound(bin.into()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BindingsOut {
    pub artifacts: BTreeMap<String, ArtifactMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct CookReport {
    pub states: BTreeMap<String, NodeState>,
    pub artifacts: BTreeMap<String, BTreeMap<String, ArtifactMeta>>,
    pub errors: BTreeMap<String, String>,
}

pub fn cook_graph(
    project: &Project,
    catalog: &Catalog,
    graph: &Graph,
) -> Result<CookReport, CookError> {
    graph.validate()?;
    let mut report = CookReport::default();
    let mut produced: BTreeMap<(String, String), ArtifactMeta> = BTreeMap::new();
    for nid in graph.topo() {
        let node = graph
            .node(&nid)
            .ok_or_else(|| CookError::Msg(format!("missing {nid}")))?;
        let op = catalog.get(&node.operator)?;
        let mut params = BTreeMap::new();
        for (k, spec) in &op.params {
            if let Some(d) = &spec.default {
                params.insert(k.clone(), d.clone());
            }
        }
        params.extend(node.params.clone());
        let mut node = node.clone();
        node.params = params;
        match cook_node(project, catalog, graph, &node, op, &produced) {
            Ok((st, arts)) => {
                for (port, meta) in &arts {
                    produced.insert((nid.clone(), port.clone()), meta.clone());
                }
                report.artifacts.insert(nid.clone(), arts);
                report.states.insert(nid, st);
            }
            Err(e) => {
                report.states.insert(nid.clone(), NodeState::Failed);
                report.errors.insert(nid, e.to_string());
            }
        }
    }
    Ok(report)
}

fn cook_node(
    project: &Project,
    _catalog: &Catalog,
    graph: &Graph,
    node: &Node,
    op: &Operator,
    produced: &BTreeMap<(String, String), ArtifactMeta>,
) -> Result<(NodeState, BTreeMap<String, ArtifactMeta>), CookError> {
    let mut input_hashes = BTreeMap::new();
    let mut input_meta: BTreeMap<String, ArtifactMeta> = BTreeMap::new();
    for e in &graph.edges {
        if e.to_node != node.id {
            continue;
        }
        match produced.get(&(e.from_node.clone(), e.from_port.clone())) {
            Some(m) => {
                input_hashes.insert(e.to_port.clone(), m.hash.clone());
                input_meta.insert(e.to_port.clone(), m.clone());
            }
            None => {
                // upstream failed or skipped — required-port check below will Skip
            }
        }
    }
    let key = cook_key(op, &node.params, &input_hashes);
    let idx = project.cache.join("index").join(format!("{key}.json"));
    if idx.exists() {
        let b: BindingsOut = serde_json::from_slice(&fs::read(&idx)?)
            .map_err(|e| CookError::Msg(e.to_string()))?;
        return Ok((NodeState::Cached, b.artifacts));
    }

    for p in &op.ports.r#in {
        if !p.optional && !input_meta.contains_key(&p.name) {
            return Ok((NodeState::Skipped, BTreeMap::new()));
        }
    }

    if op.kind == OpKind::Inprocess && op.id == "gap.missing" {
        let out = BindingsOut::default();
        fs::write(&idx, serde_json::to_vec_pretty(&out).unwrap_or_default())?;
        return Ok((NodeState::Done, BTreeMap::new()));
    }

    if op.kind == OpKind::Inprocess && op.id == "sheet.rnaseq" {
        let r1 = input_meta
            .get("r1")
            .ok_or_else(|| CookError::Msg("sheet.rnaseq needs r1".into()))?;
        let named = project.cache.join("named");
        let p1 = project.stage(r1, &named.join(&r1.hash))?;
        let p2 = match input_meta.get("r2") {
            Some(m) => Some(project.stage(m, &named.join(&m.hash))?),
            None => None,
        };
        let sample = match node.params.get("sample") {
            Some(ParamValue::String(s)) if !s.is_empty() => s.clone(),
            _ => "sample1".into(),
        };
        let strand = match node.params.get("strandedness") {
            Some(ParamValue::String(s)) if !s.is_empty() => s.clone(),
            _ => "auto".into(),
        };
        let csv = format!(
            "sample,fastq_1,fastq_2,strandedness\n{},{},{},{}\n",
            csv_cell(&sample),
            csv_cell(&p1.display().to_string()),
            csv_cell(&p2.as_ref().map(|p| p.display().to_string()).unwrap_or_default()),
            csv_cell(&strand)
        );
        let tmp = project.cache.join("tmp");
        fs::create_dir_all(&tmp)?;
        let sheetp = tmp.join(format!("{}.samplesheet.csv", node.id));
        fs::write(&sheetp, csv.as_bytes())?;
        let (_h, meta) = project.put_file(&sheetp, PortType::Table)?;
        let mut arts = BTreeMap::new();
        arts.insert("sheet".into(), meta);
        let out = BindingsOut {
            artifacts: arts.clone(),
        };
        fs::write(&idx, serde_json::to_vec_pretty(&out).unwrap_or_default())?;
        return Ok((NodeState::Done, arts));
    }

    if op.kind == OpKind::Inprocess && op.id == "files.import" {
        let path = match node.params.get("path") {
            Some(ParamValue::String(s)) => {
                let p = PathBuf::from(s);
                if p.is_absolute() {
                    p
                } else {
                    project.root.join(p)
                }
            }
            _ => return Err(CookError::Msg("files.import needs param path".into())),
        };
        let ty = node
            .port("file", Direction::Out)
            .map(|p| p.ty)
            .unwrap_or(PortType::Fastq);
        let (_h, meta) = project.put_file(&path, ty)?;
        let mut arts = BTreeMap::new();
        arts.insert("file".into(), meta);
        let out = BindingsOut {
            artifacts: arts.clone(),
        };
        fs::write(&idx, serde_json::to_vec_pretty(&out).unwrap_or_default())?;
        return Ok((NodeState::Done, arts));
    }

    if op.kind != OpKind::External {
        return Err(CookError::Msg(format!("no in-process impl for {}", op.id)));
    }

    let work = project
        .root
        .join(".axial")
        .join("work")
        .join(&key)
        .join("1");
    let inn = work.join("in");
    let outd = work.join("out");
    let tmp = work.join("tmp");
    fs::create_dir_all(&outd)?;
    fs::create_dir_all(&tmp)?;

    let mut staged = BTreeMap::new();
    for (port, meta) in &input_meta {
        let p = project.stage(meta, &inn.join(port))?;
        staged.insert(port.clone(), p);
    }

    let b = Bindings {
        params: &node.params,
        inputs: &staged,
        work_out: &outd,
        work_tmp: &tmp,
        work: &work,
    };
    let argv = render_argv(op, &b)?;
    let rest = if argv.first().map(|s| s.as_str()) == op.bin.as_deref() {
        argv[1..].to_vec()
    } else {
        argv.clone()
    };

    let mut cmd = conda_prefix(op, &rest)?;
    cmd.current_dir(&work);
    let out = cmd.output().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            CookError::BinNotFound(op.bin.clone().unwrap_or_default())
        } else {
            CookError::Io(e)
        }
    })?;
    let log = work.join("stderr.log");
    let mut lf = fs::File::create(&log)?;
    lf.write_all(&out.stderr)?;
    lf.write_all(&out.stdout)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("EnvironmentLocationNotFound") || err.contains("Not a conda environment") {
            return Err(CookError::BinNotFound(format!(
                "{} — install on PATH or: conda create -n {} {}",
                op.bin.clone().unwrap_or_default(),
                op.conda.as_ref().map(|c| c.name.as_str()).unwrap_or("?"),
                op.conda
                    .as_ref()
                    .map(|c| c.spec.join(" "))
                    .unwrap_or_default()
            )));
        }
        return Err(CookError::Exit {
            op: op.id.clone(),
            code: out.status.code().unwrap_or(-1),
        });
    }

    let mut arts = BTreeMap::new();
    for (name, spec) in &op.outputs {
        let glob = subst_glob(&spec.glob, &b);
        match glob_one(Path::new("/"), &glob, &spec.exclude)? {
            Some(p) => {
                let (_h, meta) = if spec.ty == PortType::Directory || p.is_dir() {
                    project.put_dir(&p, spec.ty)?
                } else {
                    project.put_file(&p, spec.ty)?
                };
                arts.insert(name.clone(), meta);
            }
            None if spec.optional => {}
            None => {
                return Err(CookError::Glob(name.clone(), format!("no match {glob}")));
            }
        }
    }
    let bout = BindingsOut {
        artifacts: arts.clone(),
    };
    fs::write(&idx, serde_json::to_vec_pretty(&bout).unwrap_or_default())?;
    let _ = fs::remove_dir_all(&work);
    Ok((NodeState::Done, arts))
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn subst_glob(g: &str, b: &Bindings<'_>) -> String {
    axial_ops::render_argv(
        &Operator {
            id: String::new(),
            title: String::new(),
            palette: vec![],
            kind: OpKind::External,
            cost: Cost::High,
            bin: None,
            conda: None,
            params: BTreeMap::new(),
            ports: Default::default(),
            argv: vec![g.to_string()],
            outputs: BTreeMap::new(),
        },
        b,
    )
    .ok()
    .and_then(|v| v.into_iter().next())
    .unwrap_or_else(|| g.to_string())
}

#[cfg(test)]
mod tests;
