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
    for configured in &op.argv {
        let tok = if let Some((name, token)) = configured
            .strip_prefix("?!")
            .and_then(|value| value.split_once(':'))
        {
            if !op.ports.r#in.iter().any(|port| port.name == name) {
                return Err(OpsError::Argv(format!("unknown conditional input {name}")));
            }
            if b.inputs.contains_key(name) {
                continue;
            }
            token
        } else if let Some((name, token)) = configured
            .strip_prefix('?')
            .and_then(|value| value.split_once(':'))
        {
            if !op.ports.r#in.iter().any(|port| port.name == name) {
                return Err(OpsError::Argv(format!("unknown conditional input {name}")));
            }
            if !b.inputs.contains_key(name) {
                continue;
            }
            token
        } else {
            configured.as_str()
        };
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
    fn fastp_preserves_both_mates_when_r2_is_bound() {
        let catalog =
            Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
                .unwrap();
        let operator = catalog.get("qc.fastp").unwrap();
        let params = BTreeMap::from([("threads".into(), ParamValue::Int(4))]);
        let inputs = BTreeMap::from([
            ("r1".into(), PathBuf::from("/reads/sample_R1.fastq.gz")),
            ("r2".into(), PathBuf::from("/reads/sample_R2.fastq.gz")),
        ]);
        let work = PathBuf::from("/w");
        let bindings = Bindings {
            params: &params,
            inputs: &inputs,
            work_out: &work.join("out"),
            work_tmp: &work.join("tmp"),
            work: &work,
        };

        assert_eq!(
            render_argv(operator, &bindings).unwrap(),
            vec![
                "fastp",
                "-i",
                "/reads/sample_R1.fastq.gz",
                "-o",
                "/w/out/clean_R1.fastq.gz",
                "-I",
                "/reads/sample_R2.fastq.gz",
                "-O",
                "/w/out/clean_R2.fastq.gz",
                "-w",
                "4",
            ]
        );
    }

    #[test]
    fn fastp_still_supports_single_end_reads() {
        let catalog =
            Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
                .unwrap();
        let operator = catalog.get("qc.fastp").unwrap();
        let params = BTreeMap::from([("threads".into(), ParamValue::Int(4))]);
        let inputs = BTreeMap::from([("r1".into(), PathBuf::from("/reads/sample.fastq.gz"))]);
        let work = PathBuf::from("/w");
        let bindings = Bindings {
            params: &params,
            inputs: &inputs,
            work_out: &work.join("out"),
            work_tmp: &work.join("tmp"),
            work: &work,
        };

        assert_eq!(
            render_argv(operator, &bindings).unwrap(),
            vec![
                "fastp",
                "-i",
                "/reads/sample.fastq.gz",
                "-o",
                "/w/out/clean_R1.fastq.gz",
                "-w",
                "4",
            ]
        );
    }

    #[test]
    fn paired_consumers_share_the_r1_r2_port_contract() {
        let catalog =
            Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
                .unwrap();
        for id in [
            "qc.fastp",
            "align.star",
            "align.hisat2",
            "align.bwa",
            "quant.salmon",
            "class.kraken2",
        ] {
            let operator = catalog.get(id).unwrap();
            assert!(operator.ports.r#in.iter().any(|port| port.name == "r1"));
            assert!(operator
                .ports
                .r#in
                .iter()
                .any(|port| port.name == "r2" && port.optional));
        }
    }

    #[test]
    fn conditional_tokens_select_hisat2_paired_or_single_form() {
        let catalog =
            Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
                .unwrap();
        let operator = catalog.get("align.hisat2").unwrap();
        let params = BTreeMap::from([("threads".into(), ParamValue::Int(8))]);
        let work = PathBuf::from("/w");
        let index = PathBuf::from("/ref/hisat2");
        let r1 = PathBuf::from("/reads/R1.fastq.gz");
        let r2 = PathBuf::from("/reads/R2.fastq.gz");
        let paired_inputs = BTreeMap::from([
            ("index".into(), index.clone()),
            ("r1".into(), r1.clone()),
            ("r2".into(), r2),
        ]);
        let single_inputs = BTreeMap::from([("index".into(), index), ("r1".into(), r1)]);
        let render = |inputs: &BTreeMap<String, PathBuf>| {
            render_argv(
                operator,
                &Bindings {
                    params: &params,
                    inputs,
                    work_out: &work.join("out"),
                    work_tmp: &work.join("tmp"),
                    work: &work,
                },
            )
            .unwrap()
        };

        let paired = render(&paired_inputs);
        assert!(paired
            .windows(2)
            .any(|args| args == ["-1", "/reads/R1.fastq.gz"]));
        assert!(paired
            .windows(2)
            .any(|args| args == ["-2", "/reads/R2.fastq.gz"]));
        assert!(!paired.iter().any(|arg| arg == "-U"));

        let single = render(&single_inputs);
        assert!(single
            .windows(2)
            .any(|args| args == ["-U", "/reads/R1.fastq.gz"]));
        assert!(!single.iter().any(|arg| arg == "-1" || arg == "-2"));
    }

    #[test]
    fn ensembl_stable_id_renders_a_direct_fasta_request() {
        let catalog =
            Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
                .unwrap();
        let operator = catalog.get("ensembl.sequence").unwrap();
        let params = BTreeMap::from([
            (
                "accession".into(),
                ParamValue::String("ENSP00000288602".into()),
            ),
            ("sequence_type".into(), ParamValue::String("protein".into())),
        ]);
        let inputs = BTreeMap::new();
        let work = PathBuf::from("/w");
        let argv = render_argv(
            operator,
            &Bindings {
                params: &params,
                inputs: &inputs,
                work_out: &work.join("out"),
                work_tmp: &work.join("tmp"),
                work: &work,
            },
        )
        .unwrap();

        assert!(argv.iter().any(|arg| {
            arg == "https://rest.ensembl.org/sequence/id/ENSP00000288602?type=protein"
        }));
        assert!(argv
            .windows(2)
            .any(|args| args == ["--output", "/w/out/sequence.fa"]));
    }

    #[test]
    fn snakemake_workflow_renders_native_cli_arguments() {
        let catalog =
            Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
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
        let inputs = BTreeMap::from([("workflow".into(), PathBuf::from("/w/in/workflow/project"))]);
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
