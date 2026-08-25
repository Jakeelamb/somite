//! Compact view of the official Snakemake Workflow Catalog.

use std::collections::BTreeMap;
use std::process::Command;

use somite_ir::ParamValue;
use serde::{Deserialize, Serialize};

use crate::{Cost, OpKind, Operator, ParamSpec, PortsSpec};

pub const CATALOG_URL: &str =
    "https://raw.githubusercontent.com/snakemake/snakemake-workflow-catalog/main/data.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workflow {
    pub full_name: String,
    pub description: String,
    pub topics: Vec<String>,
    pub revision: String,
    pub stars: u64,
    pub rulegraph: Option<String>,
}

impl Workflow {
    pub fn operator_id(&self) -> String {
        format!("smk.catalog.{}", safe_id(&self.full_name))
    }

    pub fn operator(&self) -> Operator {
        Operator {
            id: self.operator_id(),
            title: self.full_name.clone(),
            palette: vec!["Snakemake".into(), "Catalog".into()],
            kind: OpKind::Reference,
            cost: Cost::Low,
            bin: None,
            pixi: Vec::new(),
            params: BTreeMap::from([
                (
                    "repository".into(),
                    string_param("Repository", self.full_name.clone()),
                ),
                (
                    "revision".into(),
                    string_param("Release", self.revision.clone()),
                ),
            ]),
            ports: PortsSpec::default(),
            argv: Vec::new(),
            outputs: BTreeMap::new(),
        }
    }
}

fn string_param(label: &str, value: String) -> ParamSpec {
    ParamSpec {
        ty: "string".into(),
        label: Some(label.into()),
        page: Some("Workflow".into()),
        default: Some(ParamValue::String(value)),
        required: true,
        min: None,
        max: None,
    }
}

fn safe_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

pub fn parse(text: &str) -> Result<Vec<Workflow>, String> {
    let root: serde_json::Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let entries = root
        .as_array()
        .ok_or_else(|| "Snakemake catalog is not an array".to_owned())?;
    let mut workflows = entries
        .iter()
        .filter(|entry| {
            entry
                .get("standardized")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .filter_map(|entry| {
            let revision = entry.get("latest_release")?.as_str()?.to_owned();
            Some(Workflow {
                full_name: entry.get("full_name")?.as_str()?.to_owned(),
                description: entry
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                topics: entry
                    .get("topics")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                revision,
                stars: entry
                    .get("stargazers_count")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                rulegraph: entry
                    .get("rulegraph")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect::<Vec<_>>();
    workflows.sort_by(|left, right| {
        right
            .stars
            .cmp(&left.stars)
            .then_with(|| left.full_name.cmp(&right.full_name))
    });
    Ok(workflows)
}

pub fn parse_compact(text: &str) -> Result<Vec<Workflow>, String> {
    serde_json::from_str(text).map_err(|error| error.to_string())
}

pub fn fetch() -> Result<Vec<Workflow>, String> {
    let output = Command::new("curl")
        .args(["-fsSL", "--max-time", "30", CATALOG_URL])
        .output()
        .map_err(|error| format!("could not start curl: {error}"))?;
    if !output.status.success() {
        return Err(format!("Snakemake catalog returned {}", output.status));
    }
    let text = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_released_standardized_workflows_and_sorts_by_stars() {
        let text = r#"[
          {"full_name":"owner/low","description":"low","standardized":true,"latest_release":"v1","stargazers_count":3,"topics":["rna"],"rulegraph":null},
          {"full_name":"owner/high","description":"high","standardized":true,"latest_release":"v2","stargazers_count":30,"topics":[],"rulegraph":"digraph {}"},
          {"full_name":"owner/no-release","standardized":true,"latest_release":null,"stargazers_count":99},
          {"full_name":"owner/custom","standardized":false,"latest_release":"v1","stargazers_count":100}
        ]"#;
        let workflows = parse(text).expect("catalog");
        assert_eq!(workflows.len(), 2);
        assert_eq!(workflows[0].full_name, "owner/high");
        assert_eq!(workflows[0].operator().kind, OpKind::Reference);
    }
}
