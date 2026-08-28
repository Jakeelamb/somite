//! Official nf-core discovery behind one cache-friendly operator interface.

use std::collections::BTreeMap;
use std::process::Command;

use somite_ir::{ParamValue, PortType};

use crate::{Cost, OpKind, Operator, OutputSpec, ParamSpec, PortSpec, PortsSpec};

pub const CATALOG_URL: &str = "https://nf-co.re/pipelines.json";
pub type FetchResult = Result<(String, Vec<Pipeline>), String>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pipeline {
    pub name: String,
    pub description: String,
    pub topics: Vec<String>,
    pub revision: String,
}

impl Pipeline {
    pub fn operator_id(&self) -> String {
        format!("nf.{}", self.name)
    }

    pub fn operator(&self) -> Operator {
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
        let ports = PortsSpec {
            r#in: vec![PortSpec {
                name: "sheet".into(),
                ty: PortType::Table,
                union: Vec::new(),
                optional: true,
                resource: None,
                stage_as: None,
                import_param: None,
            }],
            out: vec![PortSpec {
                name: "results".into(),
                ty: PortType::Directory,
                union: Vec::new(),
                optional: true,
                resource: None,
                stage_as: None,
                import_param: None,
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
            pixi: vec!["bioconda::nextflow".into()],
            params,
            ports,
            argv: vec![
                "nextflow".into(),
                "run".into(),
                format!("nf-core/{}", self.name),
                "-r".into(),
                "{param.revision}".into(),
                "--input".into(),
                "{input.sheet}".into(),
                "--outdir".into(),
                "{work}/out".into(),
            ],
            outputs,
            stdout: None,
            resolution: None,
        }
    }
}

pub fn parse(text: &str) -> Result<Vec<Pipeline>, String> {
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
                .iter()
                .filter_map(|release| release.get("tag_name")?.as_str())
                .find(|tag| *tag != "dev")?
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

pub fn fetch() -> FetchResult {
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
            {"name":"dev-only","archived":false,"releases":[{"tag_name":"dev"}]},
            {"name":"new","archived":false,"releases":[]}
          ]
        }"#;

        let pipelines = parse(text).expect("valid catalog");
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].name, "rnaseq");
        assert_eq!(pipelines[0].revision, "3.26.0");
        assert_eq!(pipelines[0].operator().argv[2], "nf-core/rnaseq");
    }
}
