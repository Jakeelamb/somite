use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;
use serde::{Deserialize, Serialize};
use somite_ir::{
    ParamValue, SourceInvocationReplacement, SourceWorkflowInstance, WorkflowBinding,
    WorkflowParameterField, WorkflowParameterType, MAX_EXACT_JSON_INTEGER_BOUND,
    MAX_SOURCE_LABEL_BYTES, MAX_SOURCE_PROFILES, MAX_SOURCE_PROFILE_BYTES,
    MAX_SOURCE_PROFILE_TOTAL_BYTES, MIN_EXACT_JSON_INTEGER_BOUND,
};

use crate::model::{canonical_git_object_id, digest, safe_relative_path, SourceWorkflowError};
use crate::schema::{compatible_pattern_input, compile_compatible_pattern, value_valid};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditTransaction {
    pub base_workflow_revision: String,
    pub edits: Vec<SemanticEdit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SemanticEdit {
    SetParameter {
        name: String,
        binding: WorkflowBinding,
    },
    ResetParameter {
        name: String,
    },
    ReplaceInvocation {
        invocation_id: String,
        operator: String,
        operator_revision: String,
        #[serde(default)]
        params: BTreeMap<String, ParamValue>,
    },
    ResetInvocation {
        invocation_id: String,
    },
}

/// Apply a parameter-only transaction to a clone and return either the whole
/// new persisted instance or no change.
pub fn apply(
    base: &SourceWorkflowInstance,
    transaction: &EditTransaction,
) -> Result<SourceWorkflowInstance, SourceWorkflowError> {
    let mut patterns = PatternCache::new(&base.parameters);
    verify_workflow_revision_with_patterns(base, &mut patterns)?;
    if transaction.base_workflow_revision != base.workflow_revision {
        return Err(SourceWorkflowError::StaleRevision {
            expected: base.workflow_revision.clone(),
            actual: transaction.base_workflow_revision.clone(),
        });
    }
    if transaction.edits.iter().any(|edit| {
        matches!(
            edit,
            SemanticEdit::SetParameter { .. } | SemanticEdit::ResetParameter { .. }
        )
    }) && !base.capabilities.parameter_edits
    {
        return Err(SourceWorkflowError::ParameterEditsUnsupported);
    }

    let mut edited = base.clone();
    for edit in &transaction.edits {
        match edit {
            SemanticEdit::SetParameter { name, binding } => {
                let parameter = edited
                    .parameters
                    .iter()
                    .find(|parameter| parameter.name == *name)
                    .ok_or_else(|| SourceWorkflowError::UnknownParameter(name.clone()))?;
                let binding = canonical_binding(name, binding)?;
                validate_binding(parameter, &binding, &mut patterns)?;
                edited.bindings.insert(name.clone(), binding);
            }
            SemanticEdit::ResetParameter { name } => {
                if !edited
                    .parameters
                    .iter()
                    .any(|parameter| parameter.name == *name)
                {
                    return Err(SourceWorkflowError::UnknownParameter(name.clone()));
                }
                edited.bindings.remove(name);
            }
            SemanticEdit::ReplaceInvocation {
                invocation_id,
                operator,
                operator_revision,
                params,
            } => {
                if !edited
                    .invocations
                    .iter()
                    .any(|invocation| invocation.id == *invocation_id)
                {
                    return Err(SourceWorkflowError::UnknownInvocation(
                        invocation_id.clone(),
                    ));
                }
                let replacement = SourceInvocationReplacement {
                    invocation_id: invocation_id.clone(),
                    operator: operator.clone(),
                    operator_revision: operator_revision.clone(),
                    params: params.clone(),
                };
                if let Some(existing) = edited
                    .replacements
                    .iter_mut()
                    .find(|existing| existing.invocation_id == *invocation_id)
                {
                    *existing = replacement;
                } else {
                    edited.replacements.push(replacement);
                    edited
                        .replacements
                        .sort_by(|left, right| left.invocation_id.cmp(&right.invocation_id));
                }
            }
            SemanticEdit::ResetInvocation { invocation_id } => {
                if !edited
                    .invocations
                    .iter()
                    .any(|invocation| invocation.id == *invocation_id)
                {
                    return Err(SourceWorkflowError::UnknownInvocation(
                        invocation_id.clone(),
                    ));
                }
                edited
                    .replacements
                    .retain(|replacement| replacement.invocation_id != *invocation_id);
            }
        }
    }
    edited.workflow_revision = workflow_revision_with_patterns(&edited, &mut patterns)?;
    Ok(edited)
}

pub(crate) fn verify_workflow_revision(
    workflow: &SourceWorkflowInstance,
) -> Result<(), SourceWorkflowError> {
    let mut patterns = PatternCache::new(&workflow.parameters);
    verify_workflow_revision_with_patterns(workflow, &mut patterns)
}

fn verify_workflow_revision_with_patterns(
    workflow: &SourceWorkflowInstance,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    let expected = workflow_revision_with_patterns(workflow, patterns)?;
    if expected == workflow.workflow_revision {
        Ok(())
    } else {
        Err(SourceWorkflowError::InvalidWorkflowRevision {
            expected,
            actual: workflow.workflow_revision.clone(),
        })
    }
}

/// Compute the canonical execution-semantic revision for a persisted source
/// workflow. Outline, diagnostics, derived unsupported-schema records, and
/// display capabilities are deliberately excluded because the immutable source
/// digest already commits to their source bytes and they do not alter execution.
pub fn workflow_revision(workflow: &SourceWorkflowInstance) -> Result<String, SourceWorkflowError> {
    let mut patterns = PatternCache::new(&workflow.parameters);
    workflow_revision_with_patterns(workflow, &mut patterns)
}

fn workflow_revision_with_patterns(
    workflow: &SourceWorkflowInstance,
    patterns: &mut PatternCache,
) -> Result<String, SourceWorkflowError> {
    validate_workflow_semantics(workflow, patterns)?;
    let mut replacements = workflow.replacements.clone();
    replacements.sort_by(|left, right| left.invocation_id.cmp(&right.invocation_id));

    #[derive(Serialize)]
    struct RevisionParameter<'a> {
        name: &'a str,
        ty: WorkflowParameterType,
        required: bool,
        managed: bool,
        format: Option<&'a str>,
        pattern: Option<&'a str>,
        default: &'a Option<ParamValue>,
        choices: &'a [ParamValue],
        minimum: Option<f64>,
        maximum: Option<f64>,
    }

    #[derive(Serialize)]
    struct RevisionMaterial<'a> {
        schema_version: u32,
        source: &'a somite_ir::WorkflowSourcePin,
        profiles: &'a [String],
        parameters: Vec<RevisionParameter<'a>>,
        bindings: &'a BTreeMap<String, WorkflowBinding>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        replacements: &'a Vec<SourceInvocationReplacement>,
    }

    let mut parameters = workflow
        .parameters
        .iter()
        .map(|parameter| RevisionParameter {
            name: &parameter.name,
            ty: parameter.ty,
            required: parameter.required,
            managed: parameter.managed,
            format: parameter.format.as_deref(),
            pattern: parameter.pattern.as_deref(),
            default: &parameter.default,
            choices: &parameter.choices,
            minimum: parameter.minimum,
            maximum: parameter.maximum,
        })
        .collect::<Vec<_>>();
    parameters.sort_by(|left, right| left.name.cmp(right.name));

    let bytes = serde_json::to_vec(&RevisionMaterial {
        schema_version: workflow.schema_version,
        source: &workflow.source,
        profiles: &workflow.profiles,
        parameters,
        bindings: &workflow.bindings,
        replacements: &replacements,
    })
    .map_err(SourceWorkflowError::Serialization)?;
    Ok(digest(&bytes))
}

fn validate_workflow_semantics(
    workflow: &SourceWorkflowInstance,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    if workflow.schema_version != 1 {
        return Err(SourceWorkflowError::InvalidWorkflow(format!(
            "schema_version {} != 1",
            workflow.schema_version
        )));
    }
    if !valid_digest(&workflow.source.source_digest) {
        return Err(SourceWorkflowError::InvalidWorkflow(
            "source digest must be a full blake3 digest".to_owned(),
        ));
    }
    for (field, value) in [
        ("repository", workflow.source.repository.as_str()),
        (
            "requested_revision",
            workflow.source.requested_revision.as_str(),
        ),
        (
            "resolved_revision",
            workflow.source.resolved_revision.as_str(),
        ),
    ] {
        if value.trim().is_empty()
            || value.chars().any(char::is_control)
            || value.len() > MAX_SOURCE_LABEL_BYTES
        {
            return Err(SourceWorkflowError::InvalidWorkflow(format!(
                "{field} must be bounded, non-empty, and contain no control characters"
            )));
        }
    }
    if !canonical_git_object_id(&workflow.source.resolved_revision) {
        return Err(SourceWorkflowError::InvalidWorkflow(
            "resolved revision must be a canonical lowercase full Git object ID".to_owned(),
        ));
    }
    if !safe_relative_path(&workflow.source.entrypoint) {
        return Err(SourceWorkflowError::InvalidWorkflow(
            "entrypoint must be a safe relative path".to_owned(),
        ));
    }
    if workflow.source.file_count == 0 || workflow.source.source_bytes == 0 {
        return Err(SourceWorkflowError::InvalidWorkflow(
            "source manifest must contain at least one non-empty file".to_owned(),
        ));
    }
    let profile_bytes = workflow
        .profiles
        .iter()
        .map(String::len)
        .try_fold(0_usize, usize::checked_add);
    if workflow.profiles.len() > MAX_SOURCE_PROFILES
        || profile_bytes.is_none_or(|bytes| bytes > MAX_SOURCE_PROFILE_TOTAL_BYTES)
        || workflow.profiles.iter().any(|profile| {
            profile.trim().is_empty()
                || profile.chars().any(char::is_control)
                || profile.len() > MAX_SOURCE_PROFILE_BYTES
        })
    {
        return Err(SourceWorkflowError::InvalidWorkflow(
            "profiles must be bounded, non-empty, and contain no control characters".to_owned(),
        ));
    }

    let mut names = BTreeSet::new();
    for parameter in &workflow.parameters {
        if parameter.name.trim().is_empty()
            || parameter.name.chars().any(char::is_control)
            || !names.insert(parameter.name.as_str())
        {
            return Err(SourceWorkflowError::InvalidWorkflow(
                "parameter names must be unique, non-empty, and printable".to_owned(),
            ));
        }
        if parameter
            .minimum
            .is_some_and(|value| !value.is_finite() || is_negative_zero(value))
            || parameter
                .maximum
                .is_some_and(|value| !value.is_finite() || is_negative_zero(value))
            || matches!(
                (parameter.minimum, parameter.maximum),
                (Some(minimum), Some(maximum)) if minimum > maximum
            )
            || [parameter.minimum, parameter.maximum]
                .into_iter()
                .flatten()
                .any(|bound| {
                    bound < MIN_EXACT_JSON_INTEGER_BOUND as f64
                        || bound > MAX_EXACT_JSON_INTEGER_BOUND as f64
                })
        {
            return Err(SourceWorkflowError::InvalidParameter {
                parameter: parameter.name.clone(),
                detail: "numeric bounds must be finite, ordered, and inside the persisted JSON-safe domain"
                    .to_owned(),
            });
        }
        if parameter.ty == WorkflowParameterType::Integer
            && [parameter.minimum, parameter.maximum]
                .into_iter()
                .flatten()
                .any(|bound| {
                    bound.fract() != 0.0
                        || bound < MIN_EXACT_JSON_INTEGER_BOUND as f64
                        || bound > MAX_EXACT_JSON_INTEGER_BOUND as f64
                })
        {
            return Err(SourceWorkflowError::InvalidParameter {
                parameter: parameter.name.clone(),
                detail: "integer bounds must be exact persisted JSON-safe integers".to_owned(),
            });
        }
        if let Some(default) = &parameter.default {
            if matches!(
                parameter.format.as_deref(),
                Some("file-path" | "directory-path" | "path")
            ) && !matches!(default, ParamValue::String(path) if safe_relative_path(path))
            {
                return Err(SourceWorkflowError::InvalidParameter {
                    parameter: parameter.name.clone(),
                    detail: "path defaults must be safe relative project paths".to_owned(),
                });
            }
            validate_contract_value(parameter, default, patterns)?;
        }
        for choice in &parameter.choices {
            if matches!(
                parameter.format.as_deref(),
                Some("file-path" | "directory-path" | "path")
            ) && !matches!(choice, ParamValue::String(path) if safe_relative_path(path))
            {
                return Err(SourceWorkflowError::InvalidParameter {
                    parameter: parameter.name.clone(),
                    detail: "path choices must be safe relative project paths".to_owned(),
                });
            }
            validate_contract_value(parameter, choice, patterns)?;
        }
    }
    let mut unsupported_names = BTreeSet::new();
    for parameter in &workflow.unsupported_required_parameters {
        if parameter.name.trim().is_empty()
            || parameter.name.chars().any(char::is_control)
            || parameter.label.trim().is_empty()
            || parameter.label.chars().any(char::is_control)
            || parameter.group.trim().is_empty()
            || parameter.group.chars().any(char::is_control)
            || parameter.reason.trim().is_empty()
            || parameter.reason.chars().any(char::is_control)
            || !unsupported_names.insert(parameter.name.as_str())
            || names.contains(parameter.name.as_str())
        {
            return Err(SourceWorkflowError::InvalidWorkflow(
                "unsupported required parameter contracts must be unique, non-empty, printable, and distinct from editable parameters"
                    .to_owned(),
            ));
        }
    }
    for (name, binding) in &workflow.bindings {
        let parameter = workflow
            .parameters
            .iter()
            .find(|parameter| parameter.name == *name)
            .ok_or_else(|| SourceWorkflowError::UnknownParameter(name.clone()))?;
        validate_binding(parameter, binding, patterns)?;
    }
    let invocation_ids = workflow
        .invocations
        .iter()
        .map(|invocation| invocation.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut replaced = BTreeSet::new();
    for replacement in &workflow.replacements {
        if !invocation_ids.contains(replacement.invocation_id.as_str()) {
            return Err(SourceWorkflowError::UnknownInvocation(
                replacement.invocation_id.clone(),
            ));
        }
        if !replaced.insert(replacement.invocation_id.as_str())
            || replacement.operator.trim().is_empty()
            || replacement.operator.chars().any(char::is_control)
            || replacement.operator.len() > MAX_SOURCE_LABEL_BYTES
            || !valid_digest(&replacement.operator_revision)
            || replacement.params.iter().any(|(name, value)| {
                name.trim().is_empty()
                    || name.chars().any(char::is_control)
                    || !value.is_json_transport_stable()
            })
        {
            return Err(SourceWorkflowError::InvalidWorkflow(format!(
                "replacement for {} has an invalid operator contract",
                replacement.invocation_id
            )));
        }
    }
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn validate_binding(
    parameter: &WorkflowParameterField,
    binding: &WorkflowBinding,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    match binding {
        WorkflowBinding::Literal { value } => validate_literal(parameter, value, patterns),
        WorkflowBinding::ProjectFile { path } => {
            validate_project_path(parameter, path, &["file-path", "path"], "file", patterns)
        }
        WorkflowBinding::ProjectDirectory { path } => validate_project_path(
            parameter,
            path,
            &["directory-path", "path"],
            "directory",
            patterns,
        ),
    }
}

fn canonical_binding(
    parameter: &str,
    binding: &WorkflowBinding,
) -> Result<WorkflowBinding, SourceWorkflowError> {
    match binding {
        WorkflowBinding::Literal { value } => value
            .clone()
            .canonicalized()
            .map(|value| WorkflowBinding::Literal { value })
            .ok_or_else(|| SourceWorkflowError::InvalidParameter {
                parameter: parameter.to_owned(),
                detail: "numeric value cannot round-trip exactly through browser JSON".to_owned(),
            }),
        WorkflowBinding::ProjectFile { path } => {
            Ok(WorkflowBinding::ProjectFile { path: path.clone() })
        }
        WorkflowBinding::ProjectDirectory { path } => {
            Ok(WorkflowBinding::ProjectDirectory { path: path.clone() })
        }
    }
}

fn validate_literal(
    parameter: &WorkflowParameterField,
    value: &ParamValue,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    if matches!(
        parameter.format.as_deref(),
        Some("file-path" | "directory-path" | "path")
    ) {
        return Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: "path parameters require a project file or directory binding".to_owned(),
        });
    }
    if value_valid(
        parameter.ty,
        value,
        parameter.minimum,
        parameter.maximum,
        &parameter.choices,
    ) {
        validate_value_pattern(parameter, value, true, patterns)
    } else {
        Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: "value does not match its type, range, or allowed choices".to_owned(),
        })
    }
}

fn validate_project_path(
    parameter: &WorkflowParameterField,
    path: &str,
    accepted_formats: &[&str],
    kind: &str,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    if parameter.ty != WorkflowParameterType::String
        || !parameter
            .format
            .as_deref()
            .is_some_and(|format| accepted_formats.contains(&format))
    {
        return Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: format!("schema does not declare a project {kind} path"),
        });
    }
    if !safe_relative_path(path) {
        return Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: format!("project {kind} path must be safe and relative"),
        });
    }
    if !value_valid(
        parameter.ty,
        &ParamValue::String(path.to_owned()),
        parameter.minimum,
        parameter.maximum,
        &parameter.choices,
    ) {
        return Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: format!("project {kind} path is not an allowed schema choice"),
        });
    }
    validate_string_pattern(parameter, path, true, patterns)
}

fn validate_contract_value(
    parameter: &WorkflowParameterField,
    value: &ParamValue,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    if !value_valid(
        parameter.ty,
        value,
        parameter.minimum,
        parameter.maximum,
        &parameter.choices,
    ) {
        return Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: "default or choice does not match its type, range, or allowed choices"
                .to_owned(),
        });
    }
    // An unsupported source regex is retained in the contract and disables
    // the editing capability at import. It only becomes an edit error when a
    // caller attempts to bind that field.
    validate_value_pattern(parameter, value, false, patterns)
}

fn validate_value_pattern(
    parameter: &WorkflowParameterField,
    value: &ParamValue,
    reject_unsupported: bool,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    let ParamValue::String(value) = value else {
        return Ok(());
    };
    validate_string_pattern(parameter, value, reject_unsupported, patterns)
}

fn validate_string_pattern(
    parameter: &WorkflowParameterField,
    value: &str,
    reject_unsupported: bool,
    patterns: &mut PatternCache,
) -> Result<(), SourceWorkflowError> {
    let Some(pattern) = parameter.pattern.as_deref() else {
        return Ok(());
    };
    if !compatible_pattern_input(value) {
        return Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: "patterned values must be printable ASCII so validation is identical under ECMA-262 and Rust regex semantics"
                .to_owned(),
        });
    }
    let compiled = match patterns.get_or_compile(pattern) {
        Ok(compiled) => compiled,
        Err(detail) if reject_unsupported => {
            return Err(SourceWorkflowError::UnsupportedParameterPattern {
                parameter: parameter.name.clone(),
                pattern: pattern.to_owned(),
                detail: detail.clone(),
            });
        }
        Err(_) => return Ok(()),
    };
    if compiled.is_match(value) {
        Ok(())
    } else {
        Err(SourceWorkflowError::InvalidParameter {
            parameter: parameter.name.clone(),
            detail: format!("value does not match schema pattern {pattern:?}"),
        })
    }
}

struct PatternCache {
    entries: Vec<CompiledPattern>,
}

struct CompiledPattern {
    source: String,
    compiled: Result<Regex, String>,
}

impl PatternCache {
    fn new(parameters: &[WorkflowParameterField]) -> Self {
        Self {
            entries: Vec::with_capacity(
                parameters
                    .iter()
                    .filter(|parameter| parameter.pattern.is_some())
                    .count(),
            ),
        }
    }

    fn get_or_compile(&mut self, pattern: &str) -> &Result<Regex, String> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.source == pattern)
            .unwrap_or_else(|| {
                self.entries.push(CompiledPattern {
                    source: pattern.to_owned(),
                    compiled: compile_compatible_pattern(pattern),
                });
                self.entries.len() - 1
            });
        &self.entries[index].compiled
    }
}

fn is_negative_zero(value: f64) -> bool {
    value == 0.0 && value.is_sign_negative()
}

#[cfg(test)]
mod tests {
    use super::PatternCache;

    #[test]
    fn pattern_cache_compiles_each_distinct_source_once() {
        let mut cache = PatternCache::new(&[]);
        assert!(cache.get_or_compile(r"^\S+\.fa$").is_ok());
        assert!(cache.get_or_compile(r"^\S+\.fa$").is_ok());
        assert_eq!(cache.entries.len(), 1);

        assert!(cache.get_or_compile(r"^(?=genome).+\.fa$").is_err());
        assert!(cache.get_or_compile(r"^(?=genome).+\.fa$").is_err());
        assert_eq!(cache.entries.len(), 2);
    }
}
