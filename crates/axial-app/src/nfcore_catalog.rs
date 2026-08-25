//! nf-core discovery behind a small, cache-friendly interface.

use std::collections::BTreeMap;
use std::process::Command;

use axial_ir::{ParamValue, PortType};
use axial_ops::{CondaSpec, Cost, OpKind, Operator, OutputSpec, ParamSpec, PortSpec, PortsSpec};

pub(crate) const CATALOG_URL: &str = "https://nf-co.re/pipelines.json";
pub(crate) type FetchResult = Result<(String, Vec<Pipeline>), String>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pipeline {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) topics: Vec<String>,
    pub(crate) revision: String,
}

impl Pipeline {
    pub(crate) fn operator_id(&self) -> String {
        format!("nf.{}", self.name)
    }

    pub(crate) fn operator(&self) -> Operator {
        let mut params = BTreeMap::new();
        params.insert(
            "revision".into(),
            ParamSpec {
                ty: "string".into(),
                label: Some("Version".into()),
                page: Some("Pipeline".into()),
                default: Some(ParamValue::String(self.revision.clone())),
                required: true,
                min: None,
                max: None,
            },
        );
        params.insert(
            "profile".into(),
            ParamSpec {
                ty: "string".into(),
                label: Some("Profile".into()),
                page: Some("Pipeline".into()),
                default: Some(ParamValue::String("conda".into())),
                required: true,
                min: None,
                max: None,
            },
        );
        let ports = PortsSpec {
            r#in: vec![PortSpec {
                name: "sheet".into(),
                ty: PortType::Table,
                union: Vec::new(),
                optional: true,
            }],
            out: vec![PortSpec {
                name: "results".into(),
                ty: PortType::Directory,
                union: Vec::new(),
                optional: true,
            }],
        };
        let mut outputs = BTreeMap::new();
        outputs.insert(
            "results".into(),
            OutputSpec {
                glob: "{work}/out".into(),
                ty: PortType::Directory,
                optional: true,
                exclude: Vec::new(),
            },
        );
        Operator {
            id: self.operator_id(),
            title: format!("nf-core/{}", self.name),
            palette: vec!["nf-core".into(), "Catalog".into()],
            kind: OpKind::External,
            cost: Cost::High,
            bin: Some("nextflow".into()),
            conda: Some(CondaSpec {
                name: "axial-nf".into(),
                spec: vec!["bioconda::nextflow".into()],
            }),
            params,
            ports,
            argv: vec![
                "nextflow".into(),
                "run".into(),
                format!("nf-core/{}", self.name),
                "-r".into(),
                "{param.revision}".into(),
                "-profile".into(),
                "{param.profile}".into(),
                "--input".into(),
                "{input.sheet}".into(),
                "--outdir".into(),
                "{work}/out".into(),
            ],
            outputs,
        }
    }
}

pub(crate) fn parse(text: &str) -> Result<Vec<Pipeline>, String> {
    let root: serde_json::Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let workflows = root
        .get("remote_workflows")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "nf-core catalog has no remote_workflows array".to_owned())?;
    let mut pipelines = workflows
        .iter()
        .filter(|workflow| {
            !workflow
                .get("archived")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|workflow| {
            let name = workflow.get("name")?.as_str()?.to_owned();
            let revision = workflow
                .get("releases")?
                .as_array()?
                .first()?
                .get("tag_name")?
                .as_str()?
                .to_owned();
            let description = workflow
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let topics = workflow
                .get("topics")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect();
            Some(Pipeline {
                name,
                description,
                topics,
                revision,
            })
        })
        .collect::<Vec<_>>();
    pipelines.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(pipelines)
}

pub(crate) fn fetch() -> FetchResult {
    let output = Command::new("curl")
        .args(["-fsSL", "--max-time", "15", CATALOG_URL])
        .output()
        .map_err(|error| format!("could not start curl: {error}"))?;
    if !output.status.success() {
        return Err(format!("nf-core catalog returned {}", output.status));
    }
    let text = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    let pipelines = parse(&text)?;
    Ok((text, pipelines))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_shape_and_ignores_archived_or_unreleased_entries() {
        let text = r#"{
          "remote_workflows": [
            {"name":"rnaseq","description":"RNA analysis","topics":["rna"],"archived":false,
             "releases":[{"tag_name":"3.26.0"}]},
            {"name":"old","archived":true,"releases":[{"tag_name":"1.0.0"}]},
            {"name":"new","archived":false,"releases":[]}
          ]
        }"#;

        let pipelines = parse(text).unwrap();
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].name, "rnaseq");
        assert_eq!(pipelines[0].revision, "3.26.0");
        assert_eq!(pipelines[0].operator().argv[2], "nf-core/rnaseq".to_owned());
    }
}
