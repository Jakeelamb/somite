use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use somite_ir::{ParamValue, SourceWorkflowInstance, WorkflowBinding};

use crate::edit::verify_workflow_revision;
use crate::model::{digest, LoadLocalRequest, SourceManifest, SourceWorkflowError};
use crate::source::read_pinned_source;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreezeManifest {
    pub schema_version: u32,
    pub freeze_digest: String,
    pub workflow_revision: String,
    pub source: SourceManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_schema_digest: Option<String>,
    pub params_digest: String,
    pub entrypoint: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenSourceFile {
    pub path: String,
    pub mode: u32,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenSourcePlan {
    pub manifest: FreezeManifest,
    pub source_files: Vec<FrozenSourceFile>,
    pub params_json: Vec<u8>,
    pub workflow_json: Vec<u8>,
    pub source_manifest_json: Vec<u8>,
    pub freeze_manifest_json: Vec<u8>,
}

/// Re-verify and read the complete pinned commit tree, then return an in-memory
/// plan. A later package writer can publish these exact blobs without reopening
/// the repository and introducing a hash-then-copy race.
pub fn freeze_local(
    root: &Path,
    workflow: &SourceWorkflowInstance,
) -> Result<FrozenSourcePlan, SourceWorkflowError> {
    verify_workflow_revision(workflow)?;
    let request = LoadLocalRequest {
        root: root.to_path_buf(),
        provider: workflow.source.provider,
        repository: workflow.source.repository.clone(),
        requested_revision: workflow.source.requested_revision.clone(),
        expected_resolved_revision: workflow.source.resolved_revision.clone(),
        entrypoint: workflow.source.entrypoint.clone(),
        profiles: workflow.profiles.clone(),
    };
    request.validate()?;
    let source = read_pinned_source(&request)?;
    if source.manifest.source_digest != workflow.source.source_digest {
        return Err(SourceWorkflowError::SourceChanged {
            expected: workflow.source.source_digest.clone(),
            actual: source.manifest.source_digest,
        });
    }
    if source.manifest.files.len() != workflow.source.file_count as usize
        || source.manifest.source_bytes != workflow.source.source_bytes
    {
        return Err(SourceWorkflowError::SourceChanged {
            expected: format!(
                "{} files / {} bytes",
                workflow.source.file_count, workflow.source.source_bytes
            ),
            actual: format!(
                "{} files / {} bytes",
                source.manifest.files.len(),
                source.manifest.source_bytes
            ),
        });
    }

    let params = workflow
        .bindings
        .iter()
        .map(|(name, binding)| (name.clone(), binding_value(binding)))
        .collect::<BTreeMap<_, _>>();
    let params_json = pretty_json(&params)?;
    let workflow_json = pretty_json(workflow)?;
    let source_manifest_json = pretty_json(&source.manifest)?;
    let parameter_schema_digest = source
        .manifest
        .files
        .iter()
        .find(|file| file.path == "nextflow_schema.json")
        .map(|file| file.digest.clone());
    let params_digest = digest(&params_json);

    #[derive(Serialize)]
    struct FreezeMaterial<'a> {
        schema_version: u32,
        workflow_revision: &'a str,
        source_digest: &'a str,
        parameter_schema_digest: &'a Option<String>,
        params_digest: &'a str,
        entrypoint: &'a str,
        profiles: &'a [String],
    }
    let material = FreezeMaterial {
        schema_version: 1,
        workflow_revision: &workflow.workflow_revision,
        source_digest: &source.manifest.source_digest,
        parameter_schema_digest: &parameter_schema_digest,
        params_digest: &params_digest,
        entrypoint: &workflow.source.entrypoint,
        profiles: &workflow.profiles,
    };
    let material_bytes =
        serde_json::to_vec(&material).map_err(SourceWorkflowError::Serialization)?;
    let manifest = FreezeManifest {
        schema_version: 1,
        freeze_digest: digest(&material_bytes),
        workflow_revision: workflow.workflow_revision.clone(),
        source: source.manifest.clone(),
        parameter_schema_digest,
        params_digest,
        entrypoint: workflow.source.entrypoint.clone(),
        profiles: workflow.profiles.clone(),
    };
    let freeze_manifest_json = pretty_json(&manifest)?;
    let source_files = source
        .files
        .into_iter()
        .map(|file| FrozenSourceFile {
            path: file.manifest.path,
            mode: file.manifest.mode,
            bytes: file.bytes.into_owned(),
        })
        .collect();

    Ok(FrozenSourcePlan {
        manifest,
        source_files,
        params_json,
        workflow_json,
        source_manifest_json,
        freeze_manifest_json,
    })
}

fn binding_value(binding: &WorkflowBinding) -> ParamValue {
    match binding {
        WorkflowBinding::ProjectFile { path } | WorkflowBinding::ProjectDirectory { path } => {
            ParamValue::String(path.clone())
        }
        WorkflowBinding::Literal { value } => value.clone(),
    }
}

fn pretty_json(value: &impl Serialize) -> Result<Vec<u8>, SourceWorkflowError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(SourceWorkflowError::Serialization)?;
    bytes.push(b'\n');
    Ok(bytes)
}
