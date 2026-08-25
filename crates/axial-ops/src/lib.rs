//! Operator JSON catalog. Palette groups (NCBI, Ensembl, nf-core) live here.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use axial_ir::{Direction, ParamValue, Port, PortType};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json {path}: {src}")]
    Json {
        path: String,
        #[source]
        src: serde_json::Error,
    },
    #[error("unknown operator {0}")]
    Unknown(String),
    #[error("argv: {0}")]
    Argv(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CondaSpec {
    pub name: String,
    #[serde(default)]
    pub spec: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpec {
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub default: Option<ParamValue>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: PortType,
    #[serde(default)]
    pub union: Vec<PortType>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortsSpec {
    #[serde(default)]
    pub r#in: Vec<PortSpec>,
    #[serde(default)]
    pub out: Vec<PortSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputSpec {
    pub glob: String,
    #[serde(rename = "type")]
    pub ty: PortType,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    External,
    Inprocess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cost {
    Low,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operator {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub palette: Vec<String>,
    pub kind: OpKind,
    #[serde(default = "high")]
    pub cost: Cost,
    #[serde(default)]
    pub bin: Option<String>,
    #[serde(default)]
    pub conda: Option<CondaSpec>,
    #[serde(default)]
    pub params: BTreeMap<String, ParamSpec>,
    #[serde(default)]
    pub ports: PortsSpec,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub outputs: BTreeMap<String, OutputSpec>,
}

fn high() -> Cost {
    Cost::High
}

impl Operator {
    pub fn ir_ports(&self) -> Vec<Port> {
        let mut p = Vec::new();
        for i in &self.ports.r#in {
            p.push(Port {
                name: i.name.clone(),
                dir: Direction::In,
                ty: i.ty,
                union: i.union.clone(),
                optional: i.optional,
            });
        }
        for o in &self.ports.out {
            p.push(Port {
                name: o.name.clone(),
                dir: Direction::Out,
                ty: o.ty,
                union: o.union.clone(),
                optional: o.optional,
            });
        }
        p
    }
}

#[derive(Debug, Default, Clone)]
pub struct Catalog {
    pub ops: BTreeMap<String, Operator>,
}

impl Catalog {
    pub fn load_dir(dir: &Path) -> Result<Self, OpsError> {
        let mut c = Catalog::default();
        if !dir.is_dir() {
            return Ok(c);
        }
        for ent in fs::read_dir(dir)? {
            let ent = ent?;
            let p = ent.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&p)?;
            let op: Operator = serde_json::from_str(&raw).map_err(|src| OpsError::Json {
                path: p.display().to_string(),
                src,
            })?;
            c.ops.insert(op.id.clone(), op);
        }
        Ok(c)
    }

    pub fn get(&self, id: &str) -> Result<&Operator, OpsError> {
        self.ops.get(id).ok_or_else(|| OpsError::Unknown(id.into()))
    }

    /// Palette tree: group path (joined palette vec) → operators.
    pub fn groups(&self) -> BTreeMap<String, Vec<&Operator>> {
        let mut m: BTreeMap<String, Vec<&Operator>> = BTreeMap::new();
        for op in self.ops.values() {
            let key = if op.palette.is_empty() {
                "Other".into()
            } else {
                op.palette.join("/")
            };
            m.entry(key).or_default().push(op);
        }
        m
    }
}

pub struct Bindings<'a> {
    pub params: &'a BTreeMap<String, ParamValue>,
    pub inputs: &'a BTreeMap<String, PathBuf>,
    pub work_out: &'a Path,
    pub work_tmp: &'a Path,
    pub work: &'a Path,
}

pub fn render_argv(op: &Operator, b: &Bindings<'_>) -> Result<Vec<String>, OpsError> {
    let mut out = Vec::new();
    for tok in &op.argv {
        if let Some(name) = tok.strip_prefix("{flag.").and_then(|s| s.strip_suffix("}")) {
            match b.params.get(name) {
                Some(ParamValue::Bool(true)) => out.push(format!("--{name}").replace('_', "-")),
                Some(ParamValue::Bool(false)) | None => {}
                _ => out.push(subst(tok, b)?),
            }
            continue;
        }
        if let Some(name) = tok
            .strip_prefix("{input.")
            .and_then(|value| value.strip_suffix('}'))
            .filter(|name| !name.contains(['{', '}', '/']))
        {
            if let Some(p) = b.inputs.get(name) {
                out.push(p.display().to_string());
            } else if op.ports.r#in.iter().any(|p| p.name == name && p.optional) {
                if out.last().map(|s| s.starts_with('-')).unwrap_or(false) {
                    out.pop();
                }
            } else {
                return Err(OpsError::Argv(format!("missing input {name}")));
            }
            continue;
        }
        out.push(subst(tok, b)?);
    }
    Ok(out)
}

fn subst(tok: &str, b: &Bindings<'_>) -> Result<String, OpsError> {
    let mut s = tok.to_string();
    s = s.replace("{work}/out", &b.work_out.display().to_string());
    s = s.replace("{work}/tmp", &b.work_tmp.display().to_string());
    s = s.replace("{work}", &b.work.display().to_string());
    while let Some(i) = s.find("{param.") {
        let rest = &s[i + 7..];
        let j = rest
            .find('}')
            .ok_or_else(|| OpsError::Argv(format!("bad token {tok}")))?;
        let name = &rest[..j];
        let val = match b.params.get(name) {
            Some(ParamValue::String(x)) => x.clone(),
            Some(ParamValue::Int(x)) => x.to_string(),
            Some(ParamValue::Float(x)) => x.to_string(),
            Some(ParamValue::Bool(x)) => x.to_string(),
            None => {
                return Err(OpsError::Argv(format!("missing param {name}")));
            }
        };
        s.replace_range(i..i + 7 + j + 1, &val);
    }
    while let Some(i) = s.find("{input.") {
        let rest = &s[i + 7..];
        let j = rest
            .find('}')
            .ok_or_else(|| OpsError::Argv(format!("bad token {tok}")))?;
        let name = &rest[..j];
        let p = b
            .inputs
            .get(name)
            .ok_or_else(|| OpsError::Argv(format!("missing input {name}")))?;
        s.replace_range(i..i + 7 + j + 1, &p.display().to_string());
    }
    if s.contains('{') {
        return Err(OpsError::Argv(format!("unresolved {s}")));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subst_mixed() {
        let mut params = BTreeMap::new();
        params.insert("accession".into(), ParamValue::String("SRR1".into()));
        let inputs = BTreeMap::new();
        let work = PathBuf::from("/w");
        let out = work.join("out");
        let tmp = work.join("tmp");
        let b = Bindings {
            params: &params,
            inputs: &inputs,
            work_out: &out,
            work_tmp: &tmp,
            work: &work,
        };
        let op = Operator {
            id: "t".into(),
            title: "t".into(),
            palette: vec![],
            kind: OpKind::External,
            cost: Cost::High,
            bin: Some("prefetch".into()),
            conda: None,
            params: BTreeMap::new(),
            ports: PortsSpec::default(),
            argv: vec!["-O".into(), "{work}/out/{param.accession}".into()],
            outputs: BTreeMap::new(),
        };
        let a = render_argv(&op, &b).unwrap();
        assert_eq!(a, vec!["-O", "/w/out/SRR1"]);
    }

    #[test]
    fn optional_input_drops_flag() {
        let params = BTreeMap::new();
        let inputs = BTreeMap::new();
        let work = PathBuf::from("/w");
        let out = work.join("out");
        let tmp = work.join("tmp");
        let b = Bindings {
            params: &params,
            inputs: &inputs,
            work_out: &out,
            work_tmp: &tmp,
            work: &work,
        };
        let op = Operator {
            id: "t".into(),
            title: "t".into(),
            palette: vec![],
            kind: OpKind::External,
            cost: Cost::High,
            bin: Some("nextflow".into()),
            conda: None,
            params: BTreeMap::new(),
            ports: PortsSpec {
                r#in: vec![PortSpec {
                    name: "sheet".into(),
                    ty: PortType::Table,
                    union: vec![],
                    optional: true,
                }],
                out: vec![],
            },
            argv: vec![
                "nextflow".into(),
                "--input".into(),
                "{input.sheet}".into(),
                "--outdir".into(),
                "{work}/out".into(),
            ],
            outputs: BTreeMap::new(),
        };
        let a = render_argv(&op, &b).unwrap();
        assert_eq!(a, vec!["nextflow", "--outdir", "/w/out"]);
    }

    #[test]
    fn snakemake_workflow_renders_native_cli_arguments() {
        let catalog = Catalog::load_dir(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"),
        )
        .unwrap();
        let operator = catalog.get("smk.workflow").unwrap();
        let params = BTreeMap::from([
            (
                "snakefile".into(),
                ParamValue::String("workflow/Snakefile".into()),
            ),
            ("cores".into(), ParamValue::Int(8)),
            ("use_conda".into(), ParamValue::Bool(true)),
            ("dry_run".into(), ParamValue::Bool(false)),
            ("keep_going".into(), ParamValue::Bool(true)),
            ("printshellcmds".into(), ParamValue::Bool(true)),
        ]);
        let inputs = BTreeMap::from([(
            "workflow".into(),
            PathBuf::from("/w/in/workflow/project"),
        )]);
        let work = PathBuf::from("/w");
        let out = work.join("out");
        let tmp = work.join("tmp");
        let bindings = Bindings {
            params: &params,
            inputs: &inputs,
            work_out: &out,
            work_tmp: &tmp,
            work: &work,
        };

        assert_eq!(
            render_argv(operator, &bindings).unwrap(),
            vec![
                "snakemake",
                "--snakefile",
                "/w/in/workflow/project/workflow/Snakefile",
                "--directory",
                "/w/in/workflow/project",
                "--cores",
                "8",
                "--use-conda",
                "--keep-going",
                "--printshellcmds",
            ]
        );
    }
}
