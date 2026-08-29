use somite_ir::{Graph, Node, SourceWorkflowVariantOrigin};

use crate::model::SourceWorkflowError;

/// Cross one selected source invocation into Somite's ordinary native Graph.
///
/// This is the promotion Module's Interface. It either returns a complete
/// provenance-retaining native variant or leaves the source Graph untouched.
pub fn promote_invocation(
    source_graph: &Graph,
    base_workflow_revision: &str,
    invocation_id: &str,
    promoted_node: Node,
) -> Result<Graph, SourceWorkflowError> {
    source_graph
        .validate()
        .map_err(|error| SourceWorkflowError::InvalidWorkflow(error.to_string()))?;
    if source_graph.variant_origin.is_some()
        || source_graph.nodes.len() != 1
        || !source_graph.edges.is_empty()
    {
        return Err(SourceWorkflowError::InvalidWorkflow(
            "invocation promotion requires one source-backed Node and no Edges".to_owned(),
        ));
    }
    let source_node = &source_graph.nodes[0];
    let workflow = source_node.source_workflow.as_ref().ok_or_else(|| {
        SourceWorkflowError::InvalidWorkflow(
            "invocation promotion requires a source-backed workflow".to_owned(),
        )
    })?;
    if workflow.workflow_revision != base_workflow_revision {
        return Err(SourceWorkflowError::StaleRevision {
            expected: workflow.workflow_revision.clone(),
            actual: base_workflow_revision.to_owned(),
        });
    }
    if !workflow
        .invocations
        .iter()
        .any(|invocation| invocation.id == invocation_id)
    {
        return Err(SourceWorkflowError::UnknownInvocation(
            invocation_id.to_owned(),
        ));
    }
    let replacement = workflow
        .replacements
        .iter()
        .find(|replacement| replacement.invocation_id == invocation_id)
        .ok_or_else(|| {
            SourceWorkflowError::InvalidWorkflow(format!(
                "source invocation {invocation_id} has no selected replacement to promote"
            ))
        })?;
    if promoted_node.source_workflow.is_some()
        || promoted_node.operator != replacement.operator
        || promoted_node.operator_revision != replacement.operator_revision
        || promoted_node.params != replacement.params
    {
        return Err(SourceWorkflowError::InvalidWorkflow(format!(
            "promoted Node {} does not match the selected replacement for {invocation_id}",
            promoted_node.id
        )));
    }

    let promoted_node_id = promoted_node.id.clone();
    let native = Graph {
        schema_version: source_graph.schema_version,
        name: source_graph.name.clone(),
        nodes: vec![promoted_node],
        edges: Vec::new(),
        annotations: source_graph.annotations.clone(),
        variant_origin: Some(SourceWorkflowVariantOrigin {
            source_node: source_node.clone(),
            promoted_invocations: std::collections::BTreeMap::from([(
                invocation_id.to_owned(),
                promoted_node_id,
            )]),
        }),
    };
    native
        .validate()
        .map_err(|error| SourceWorkflowError::InvalidWorkflow(error.to_string()))?;
    Ok(native)
}

/// Return from a Native workflow variant to its exact retained source view.
/// Native edits are discarded by this explicit operation; annotations remain.
pub fn restore_source_workflow(variant: &Graph) -> Result<Graph, SourceWorkflowError> {
    variant
        .validate()
        .map_err(|error| SourceWorkflowError::InvalidWorkflow(error.to_string()))?;
    let origin = variant.variant_origin.as_ref().ok_or_else(|| {
        SourceWorkflowError::InvalidWorkflow(
            "the Graph is not a promoted Native workflow variant".to_owned(),
        )
    })?;
    let restored = Graph {
        schema_version: variant.schema_version,
        name: variant.name.clone(),
        nodes: vec![origin.source_node.clone()],
        edges: Vec::new(),
        annotations: variant.annotations.clone(),
        variant_origin: None,
    };
    restored
        .validate()
        .map_err(|error| SourceWorkflowError::InvalidWorkflow(error.to_string()))?;
    Ok(restored)
}
