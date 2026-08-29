//! Exact local-source inspection and parameter-only editing for source-backed
//! Nextflow workflows.
//!
//! This Module deliberately does not infer channel contracts or translate
//! source workflows into Somite's native graph IR. The pinned source remains
//! executable truth; the outline is a source-anchored read model.

mod edit;
mod freeze;
mod index;
mod model;
mod promote;
mod schema;
mod source;

pub use edit::{apply, workflow_revision, EditTransaction, SemanticEdit};
pub use freeze::{freeze_local, FreezeManifest, FrozenSourceFile, FrozenSourcePlan};
pub use model::{
    LoadLocalRequest, LoadedSourceWorkflow, ReindexedSourceWorkflow, SourceFileManifest,
    SourceManifest, SourceWorkflowError,
};
pub use promote::{promote_invocation, restore_source_workflow};

use somite_ir::{SourceCapabilities, SourceDiagnostic, SourceWorkflowInstance, WorkflowSourcePin};

/// Version of the deterministic source-derived parameter and outline index.
/// Persisted source instances must be re-derived when this value changes.
pub const SOURCE_INDEXER_REVISION: &str = "source-indexer-v6";

/// Inspect the exact HEAD commit of one local Git worktree and construct its
/// persisted source-backed workflow instance plus the complete blob manifest.
/// Mutable worktree and index state do not participate in source identity.
pub fn load_local(request: &LoadLocalRequest) -> Result<LoadedSourceWorkflow, SourceWorkflowError> {
    request.validate()?;
    let source = source::read_pinned_source(request)?;
    let reindexed = reindex_tracked(&source.manifest, &source.files, &request.entrypoint)?;

    let mut workflow = SourceWorkflowInstance {
        schema_version: 1,
        workflow_revision: String::new(),
        source: WorkflowSourcePin {
            provider: request.provider,
            repository: request.repository.clone(),
            requested_revision: request.requested_revision.clone(),
            resolved_revision: source.resolved_revision,
            source_digest: source.manifest.source_digest.clone(),
            entrypoint: request.entrypoint.clone(),
            file_count: u32::try_from(source.manifest.files.len()).map_err(|_| {
                SourceWorkflowError::SourceTooLarge("tracked file count exceeds u32".to_owned())
            })?,
            source_bytes: source.manifest.source_bytes,
        },
        profiles: request.profiles.clone(),
        parameters: reindexed.parameters,
        unsupported_required_parameters: reindexed.unsupported_required_parameters,
        bindings: Default::default(),
        scopes: reindexed.scopes,
        invocations: reindexed.invocations,
        replacements: Vec::new(),
        capabilities: reindexed.capabilities,
        diagnostics: reindexed.diagnostics,
    };
    workflow.workflow_revision = edit::workflow_revision(&workflow)?;

    Ok(LoadedSourceWorkflow {
        workflow,
        source_manifest: source.manifest,
        parameter_schema_digest: reindexed.parameter_schema_digest,
    })
}

/// Reconstruct the source-derived workflow read model from already-frozen
/// bytes. The complete manifest is verified before any schema or Nextflow
/// indexing result is returned, so callers cannot accidentally trust a partial
/// or substituted CAS tree.
pub fn reindex_frozen(
    manifest: &SourceManifest,
    source_files: &[FrozenSourceFile],
    entrypoint: &str,
) -> Result<ReindexedSourceWorkflow, SourceWorkflowError> {
    let files = source::verify_frozen_source(manifest, source_files, entrypoint)?;
    reindex_tracked(manifest, &files, entrypoint)
}

fn reindex_tracked(
    manifest: &SourceManifest,
    files: &[source::TrackedSourceFile<'_>],
    entrypoint: &str,
) -> Result<ReindexedSourceWorkflow, SourceWorkflowError> {
    let mut projection_budget = model::DerivedProjectionBudget::new();
    let indexed = index::index_nextflow(
        files,
        entrypoint,
        &manifest.source_digest,
        &mut projection_budget,
    )?;
    let parsed_schema = schema::parse_parameter_schema(files, &mut projection_budget)?;
    let hierarchy_indexed = !indexed.scopes.is_empty();
    let parameter_edits = parsed_schema.edits_supported;

    let mut diagnostics = indexed.diagnostics;
    diagnostics.extend(parsed_schema.diagnostics);
    if indexed.scopes.is_empty() {
        diagnostics.push(SourceDiagnostic {
            code: "source_outline_empty".to_owned(),
            message: "No Nextflow workflow or process declarations were indexed.".to_owned(),
            span: None,
        });
    }
    diagnostics.sort_by(|left, right| {
        left.span
            .as_ref()
            .map(|span| (&span.path, span.start_line, span.end_line))
            .cmp(
                &right
                    .span
                    .as_ref()
                    .map(|span| (&span.path, span.start_line, span.end_line)),
            )
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
    });

    Ok(ReindexedSourceWorkflow {
        parameters: parsed_schema.fields,
        unsupported_required_parameters: parsed_schema.unsupported_required,
        scopes: indexed.scopes,
        invocations: indexed.invocations,
        capabilities: SourceCapabilities {
            // The first slice preserves exact source but does not freeze the
            // source-defined task environments. This is a readiness gate.
            exact_execution: false,
            parameter_edits,
            hierarchy_indexed,
            structural_edits: false,
            channel_contracts: false,
            source_edits: false,
        },
        diagnostics,
        parameter_schema_digest: parsed_schema.digest,
    })
}
