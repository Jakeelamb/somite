use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use somite_ir::{
    SourceCapabilities, SourceDiagnostic, SourceInvocation, SourceProvider, SourceScope,
    SourceWorkflowInstance, UnsupportedRequiredWorkflowParameter, WorkflowParameterField,
    MAX_SOURCE_LABEL_BYTES, MAX_SOURCE_PATH_BYTES, MAX_SOURCE_PROFILES, MAX_SOURCE_PROFILE_BYTES,
    MAX_SOURCE_PROFILE_TOTAL_BYTES,
};
use thiserror::Error;

const MAX_DERIVED_PROJECTION_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct DerivedProjectionBudget {
    used: usize,
}

impl DerivedProjectionBudget {
    pub(crate) fn new() -> Self {
        Self { used: 0 }
    }

    pub(crate) fn reserve(&mut self, bytes: usize, kind: &str) -> Result<(), SourceWorkflowError> {
        let next = self.used.checked_add(bytes).ok_or_else(|| {
            SourceWorkflowError::SourceTooLarge("derived projection byte count overflowed".into())
        })?;
        if next > MAX_DERIVED_PROJECTION_BYTES {
            return Err(SourceWorkflowError::SourceTooLarge(format!(
                "derived {kind} exceeds the {MAX_DERIVED_PROJECTION_BYTES}-byte projection budget"
            )));
        }
        self.used = next;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadLocalRequest {
    pub root: PathBuf,
    pub provider: SourceProvider,
    pub repository: String,
    pub requested_revision: String,
    pub expected_resolved_revision: String,
    pub entrypoint: String,
    pub profiles: Vec<String>,
}

impl LoadLocalRequest {
    pub fn validate(&self) -> Result<(), SourceWorkflowError> {
        for (field, value) in [
            ("repository", self.repository.as_str()),
            ("requested_revision", self.requested_revision.as_str()),
            (
                "expected_resolved_revision",
                self.expected_resolved_revision.as_str(),
            ),
            ("entrypoint", self.entrypoint.as_str()),
        ] {
            if value.trim().is_empty() || value.chars().any(char::is_control) {
                return Err(SourceWorkflowError::InvalidRequest {
                    field,
                    detail: "must be non-empty and contain no control characters".to_owned(),
                });
            }
            if value.len() > MAX_SOURCE_LABEL_BYTES {
                return Err(SourceWorkflowError::InvalidRequest {
                    field,
                    detail: "exceeds the source-label byte limit".to_owned(),
                });
            }
        }
        if !safe_relative_path(&self.entrypoint) {
            return Err(SourceWorkflowError::InvalidRequest {
                field: "entrypoint",
                detail: "must be a safe relative path".to_owned(),
            });
        }
        if !canonical_git_object_id(&self.expected_resolved_revision) {
            return Err(SourceWorkflowError::InvalidRequest {
                field: "expected_resolved_revision",
                detail: "must be a canonical lowercase full SHA-1 or SHA-256 object ID".to_owned(),
            });
        }
        if self.profiles.len() > MAX_SOURCE_PROFILES
            || self
                .profiles
                .iter()
                .map(String::len)
                .try_fold(0_usize, usize::checked_add)
                .is_none_or(|bytes| bytes > MAX_SOURCE_PROFILE_TOTAL_BYTES)
        {
            return Err(SourceWorkflowError::InvalidRequest {
                field: "profiles",
                detail: "profile count or total bytes exceed the source-profile limits".to_owned(),
            });
        }
        for profile in &self.profiles {
            if profile.trim().is_empty()
                || profile.chars().any(char::is_control)
                || profile.len() > MAX_SOURCE_PROFILE_BYTES
            {
                return Err(SourceWorkflowError::InvalidRequest {
                    field: "profiles",
                    detail:
                        "profiles must be non-empty, bounded, and contain no control characters"
                            .to_owned(),
                });
            }
        }
        Ok(())
    }
}

pub(crate) fn canonical_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceFileManifest {
    pub path: String,
    pub mode: u32,
    pub bytes: u64,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceManifest {
    pub schema_version: u32,
    pub source_digest: String,
    pub source_bytes: u64,
    pub files: Vec<SourceFileManifest>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSourceWorkflow {
    pub workflow: SourceWorkflowInstance,
    pub source_manifest: SourceManifest,
    pub parameter_schema_digest: Option<String>,
}

/// Source-derived read model reconstructed from a verified frozen source tree.
/// It intentionally excludes source provenance and user bindings, which are
/// instance state rather than facts re-derived from source bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct ReindexedSourceWorkflow {
    pub parameters: Vec<WorkflowParameterField>,
    pub unsupported_required_parameters: Vec<UnsupportedRequiredWorkflowParameter>,
    pub scopes: Vec<SourceScope>,
    pub invocations: Vec<SourceInvocation>,
    pub capabilities: SourceCapabilities,
    pub diagnostics: Vec<SourceDiagnostic>,
    pub parameter_schema_digest: Option<String>,
}

#[derive(Debug, Error)]
pub enum SourceWorkflowError {
    #[error("invalid source request field {field}: {detail}")]
    InvalidRequest { field: &'static str, detail: String },
    #[error("could not start Git: {0}")]
    GitUnavailable(#[source] std::io::Error),
    #[error("Git {operation} failed: {detail}")]
    GitFailed {
        operation: &'static str,
        detail: String,
    },
    #[error("source path is not the root of its Git worktree: {0}")]
    NotWorktreeRoot(String),
    #[error("source revision {actual} does not match expected revision {expected}")]
    RevisionMismatch { expected: String, actual: String },
    #[error("requested revision {requested} resolves to {actual}, not pinned commit {expected}")]
    RequestedRevisionMismatch {
        requested: String,
        expected: String,
        actual: String,
    },
    #[error("tracked path is not valid UTF-8")]
    NonUtf8Path,
    #[error("tracked path is unsafe: {0}")]
    UnsafePath(String),
    #[error("unsupported tracked {kind} at {path}")]
    UnsupportedTrackedEntry { path: String, kind: &'static str },
    #[error("tracked source entry is missing or changed: {0}")]
    MissingTrackedEntry(String),
    #[error("entrypoint is not a tracked regular file: {0}")]
    MissingEntrypoint(String),
    #[error("source is too large: {0}")]
    SourceTooLarge(String),
    #[error("could not read {path}: {source}")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid nextflow_schema.json: {0}")]
    ParameterSchema(#[from] serde_json::Error),
    #[error("could not serialize workflow identity: {0}")]
    Serialization(serde_json::Error),
    #[error("edit base {actual} does not match workflow revision {expected}")]
    StaleRevision { expected: String, actual: String },
    #[error("unknown workflow parameter {0}")]
    UnknownParameter(String),
    #[error("unknown source invocation {0}")]
    UnknownInvocation(String),
    #[error("parameter editing is disabled because the pinned source schema cannot be represented safely")]
    ParameterEditsUnsupported,
    #[error("workflow parameter {parameter}: {detail}")]
    InvalidParameter { parameter: String, detail: String },
    #[error("workflow parameter {parameter} uses an unsupported pattern {pattern:?}: {detail}")]
    UnsupportedParameterPattern {
        parameter: String,
        pattern: String,
        detail: String,
    },
    #[error("invalid source workflow: {0}")]
    InvalidWorkflow(String),
    #[error("workflow revision is invalid: expected {expected}, received {actual}")]
    InvalidWorkflowRevision { expected: String, actual: String },
    #[error("source changed since import: expected {expected}, received {actual}")]
    SourceChanged { expected: String, actual: String },
}

pub(crate) fn safe_relative_path(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.trim().is_empty()
        && value.len() <= MAX_SOURCE_PATH_BYTES
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use somite_ir::{
        SourceProvider, MAX_SOURCE_LABEL_BYTES, MAX_SOURCE_PATH_BYTES, MAX_SOURCE_PROFILES,
        MAX_SOURCE_PROFILE_BYTES,
    };

    use super::{
        canonical_git_object_id, safe_relative_path, DerivedProjectionBudget, LoadLocalRequest,
        SourceWorkflowError, MAX_DERIVED_PROJECTION_BYTES,
    };

    fn request() -> LoadLocalRequest {
        LoadLocalRequest {
            root: PathBuf::from("/tmp/example"),
            provider: SourceProvider::Local,
            repository: "example/workflow".to_owned(),
            requested_revision: "v1.0.0".to_owned(),
            expected_resolved_revision: "a".repeat(40),
            entrypoint: "main.nf".to_owned(),
            profiles: Vec::new(),
        }
    }

    #[test]
    fn canonical_git_object_ids_are_full_lowercase_sha1_or_sha256() {
        assert!(canonical_git_object_id(&"a".repeat(40)));
        assert!(canonical_git_object_id(&"0".repeat(64)));
        assert!(!canonical_git_object_id(&"a".repeat(39)));
        assert!(!canonical_git_object_id(&"a".repeat(41)));
        assert!(!canonical_git_object_id(&"a".repeat(63)));
        assert!(!canonical_git_object_id(&"a".repeat(65)));
        assert!(!canonical_git_object_id(&"A".repeat(40)));
        assert!(!canonical_git_object_id(&format!("{}g", "a".repeat(39))));
    }

    #[test]
    fn safe_relative_paths_are_meaningful_project_paths() {
        assert!(safe_relative_path("data/input file.fa"));
        for unsafe_path in ["", "   ", "/tmp/input.fa", "../input.fa", "data\\input.fa"] {
            assert!(!safe_relative_path(unsafe_path), "{unsafe_path:?}");
        }
        assert!(!safe_relative_path(&"a".repeat(MAX_SOURCE_PATH_BYTES + 1)));
    }

    #[test]
    fn source_identity_and_profiles_are_bounded_at_the_request_seam() {
        let mut overlong_repository = request();
        overlong_repository.repository = "r".repeat(MAX_SOURCE_LABEL_BYTES + 1);
        assert!(overlong_repository.validate().is_err());

        let mut too_many_profiles = request();
        too_many_profiles.profiles = vec!["test".to_owned(); MAX_SOURCE_PROFILES + 1];
        assert!(too_many_profiles.validate().is_err());

        let mut overlong_profile = request();
        overlong_profile.profiles = vec!["p".repeat(MAX_SOURCE_PROFILE_BYTES + 1)];
        assert!(overlong_profile.validate().is_err());
    }

    #[test]
    fn derived_projection_budget_is_shared_and_checked_for_overflow() {
        let mut budget = DerivedProjectionBudget::new();
        budget
            .reserve(MAX_DERIVED_PROJECTION_BYTES - 1, "outline")
            .expect("within shared budget");
        assert!(matches!(
            budget.reserve(2, "schema"),
            Err(SourceWorkflowError::SourceTooLarge(detail)) if detail.contains("schema")
        ));
        assert!(matches!(
            budget.reserve(usize::MAX, "overflow"),
            Err(SourceWorkflowError::SourceTooLarge(_))
        ));
    }
}
