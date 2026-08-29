use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, Json, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use somite_assessment::WorkflowAssessment;

use crate::{source_search, GraphTransaction};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const SOURCE_WORKFLOW_RESOLVE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowOutput {
    /// Full canvas state identity. Pass this value as a transaction's `base_state_revision`.
    pub state_revision: String,
    /// Semantic workflow identity used to bind compile and evidence results.
    pub graph_revision: String,
    pub graph: GraphOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphOutput {
    pub schema_version: u32,
    pub nodes: Vec<NodeOutput>,
    pub edges: Vec<EdgeOutput>,
    /// Exact source provenance for a promoted native workflow variant. This is
    /// never a second executable graph.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_origin: Option<SourceWorkflowVariantOriginOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceWorkflowVariantOriginOutput {
    pub source_node: NodeOutput,
    #[serde(default)]
    pub promoted_invocations: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NodeOutput {
    pub id: String,
    pub operator: String,
    pub operator_revision: String,
    pub ports: Vec<PortOutput>,
    #[serde(default)]
    pub params: BTreeMap<String, ParamValueOutput>,
    /// Canonical source-backed workflow instance for a resolved collapsed workflow node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workflow: Option<Value>,
    pub layout: LayoutOutput,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortOutput {
    pub name: String,
    pub dir: DirectionOutput,
    pub ty: PortTypeOutput,
    #[serde(default)]
    pub union: Vec<PortTypeOutput>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DirectionOutput {
    In,
    Out,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "PascalCase")]
pub enum PortTypeOutput {
    Sra,
    Fastq,
    FastqGz,
    Fasta,
    FastaGz,
    Gtf,
    GtfGz,
    Gff3,
    Bam,
    Bai,
    Sam,
    Vcf,
    VcfGz,
    Bed,
    Agp,
    Chain,
    Table,
    Json,
    Html,
    Image,
    Zip,
    Directory,
    Text,
    Preview,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ParamValueOutput {
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LayoutOutput {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EdgeOutput {
    pub id: String,
    pub from_node: String,
    pub from_port: String,
    pub to_node: String,
    pub to_port: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogOperatorOutput {
    pub id: String,
    pub title: String,
    pub palette: Vec<String>,
    pub kind: String,
    pub cost: String,
    pub bin: Option<String>,
    pub pixi: Vec<String>,
    pub params: BTreeMap<String, ParamSpecOutput>,
    pub ports: PortsSpecOutput,
    pub argv: Vec<String>,
    pub outputs: BTreeMap<String, OutputSpecOutput>,
    pub revision: String,
    /// Deterministic relevance score for this catalog revision and query.
    pub score: u32,
    /// Query terms that matched this operator's contract, types, or aliases.
    pub matched_terms: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ParamSpecOutput {
    #[serde(rename = "type")]
    pub ty: String,
    pub label: Option<String>,
    pub page: Option<String>,
    pub default: Option<ParamValueOutput>,
    pub required: bool,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortSpecOutput {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: PortTypeOutput,
    #[serde(default)]
    pub union: Vec<PortTypeOutput>,
    #[serde(default)]
    pub optional: bool,
    pub resource: Option<ResourceSpecOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResourceSpecOutput {
    pub profile: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub resolutions: Vec<ResourceResolutionSpecOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResourceResolutionSpecOutput {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub kind: String,
    #[serde(default)]
    pub recommended: bool,
    pub download_bytes: Option<u64>,
    pub stored_bytes: Option<u64>,
    pub scientific_effect: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortsSpecOutput {
    #[serde(default)]
    pub r#in: Vec<PortSpecOutput>,
    #[serde(default)]
    pub out: Vec<PortSpecOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputSpecOutput {
    pub glob: String,
    #[serde(rename = "type")]
    pub ty: PortTypeOutput,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogOutput {
    pub query: String,
    pub catalog_revision: String,
    pub total_matches: usize,
    pub next_cursor: Option<String>,
    pub matches: Vec<CatalogOperatorOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TransactionOutput {
    pub transaction_id: String,
    pub previous_state_revision: String,
    /// Full canvas state identity to use as the next transaction precondition.
    pub state_revision: String,
    /// Semantic workflow identity used to bind compile and evidence results.
    pub graph_revision: String,
    pub summary: String,
    pub graph: GraphOutput,
    /// True when a repeated idempotency key returned the original result without another edit.
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CompileOutput {
    pub source_graph_revision: String,
    pub closure_digest: String,
    pub compiled_graph_revision: String,
    pub output_path: String,
    pub reused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunStartOutput {
    pub run_id: String,
    pub phase: String,
    /// True when an identical retry returned the already-started run.
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StartInput {
    /// Stable retry key. Reuse only when retrying the identical intended start.
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunStatusOutput {
    pub run_id: String,
    pub phase: String,
    pub states: BTreeMap<String, String>,
    pub closure_digest: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub evidence_receipt: Option<EvidenceReceiptOutput>,
    pub progress: RunProgressOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunProgressOutput {
    pub completed: usize,
    pub total: usize,
    pub unit: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EvidenceOutput {
    pub subject_digest: String,
    pub receipts: Vec<EvidenceReceiptOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EvidenceReceiptOutput {
    pub receipt_digest: String,
    pub recorded_at_unix_ms: u64,
    pub subject_digest: String,
    pub observed_closure_digest: Option<String>,
    pub kind: String,
    pub scope: String,
    pub configuration_digest: String,
    pub fixture_digests: Vec<String>,
    pub verifier: String,
    pub result: EvidenceResultOutput,
    pub node_results: BTreeMap<String, EvidenceResultOutput>,
    pub edge_results: BTreeMap<String, EvidenceResultOutput>,
    pub artifact_digests: Vec<String>,
    pub log_digests: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceResultOutput {
    Passed,
    Failed,
    Inconclusive,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ToolErrorOutput {
    pub error: ToolErrorDetail,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ToolErrorDetail {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplied_state_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_state_revision: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CatalogSearchInput {
    /// Case-insensitive words matched against operator id, title, palette, and package names.
    pub query: String,
    /// Maximum number of matches. Defaults to 12 and cannot exceed 50.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Opaque continuation cursor returned by a previous search with the same query.
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SourceProvider {
    Ncbi,
    Ensembl,
}

impl SourceProvider {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Ncbi => "ncbi",
            Self::Ensembl => "ensembl",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SourceSearchInput {
    /// Scientific entity, accession, organism, assembly, run, or gene to look up.
    pub query: String,
    /// Authoritative provider to search.
    pub provider: SourceProvider,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NfcoreSourceResolveInput {
    /// Exact nf-core repository name, for example `nf-core/rnaseq`.
    pub workflow: String,
    /// Exact release tag advertised by Somite's current cached nf-core catalog.
    pub revision: String,
    /// Full canvas state identity returned by `somite.workflow.get`.
    pub base_state_revision: String,
    /// Stable retry key. Reuse only when retrying this identical import.
    pub idempotency_key: String,
    /// Short human-readable transaction summary for activity and undo history.
    pub summary: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NfcoreSourceSearchInput {
    /// Pipeline name, topic, or short scientific purpose.
    pub query: String,
    /// Maximum matches, from 1 through 50. Defaults to 12.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NfcoreSourceSearchOutput {
    pub query: String,
    pub provenance: String,
    pub cached: bool,
    pub total_matches: usize,
    pub entries: Vec<NfcoreSourceSearchEntryOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NfcoreSourceSearchEntryOutput {
    pub repository: String,
    pub title: String,
    pub description: String,
    pub topics: Vec<String>,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceWorkflowEditInput {
    /// Full canvas state identity returned by `somite.workflow.get`.
    pub base_state_revision: String,
    /// Exact source workflow revision currently embedded in the collapsed node.
    pub workflow_revision: String,
    /// Stable retry key. Reuse only when retrying this identical edit.
    pub idempotency_key: String,
    /// Short human-readable transaction summary for activity and undo history.
    pub summary: String,
    /// One or more source-anchored semantic edits applied atomically.
    pub edits: Vec<SourceWorkflowSemanticEditInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceWorkflowPromotionInput {
    /// Full canvas state identity returned by `somite.workflow.get`.
    pub base_state_revision: String,
    /// Exact source workflow revision currently embedded in the collapsed node.
    pub workflow_revision: String,
    /// Exact source invocation id that already has a selected replacement.
    pub invocation_id: String,
    /// Stable retry key. Reuse only when retrying this identical promotion.
    pub idempotency_key: String,
    /// Short human-readable transaction summary for activity and undo history.
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceWorkflowSemanticEditInput {
    SetParameter {
        name: String,
        binding: SourceWorkflowBindingInput,
    },
    ResetParameter {
        name: String,
    },
    ReplaceInvocation {
        invocation_id: String,
        operator: String,
        operator_revision: String,
        #[serde(default)]
        params: BTreeMap<String, ParamValueOutput>,
    },
    ResetInvocation {
        invocation_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceWorkflowBindingInput {
    ProjectFile { path: String },
    ProjectDirectory { path: String },
    Literal { value: ParamValueOutput },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RunInput {
    /// Run identifier returned by a start tool.
    pub run_id: String,
    /// Optional long-poll duration in milliseconds. Maximum 25000; returns sooner at a terminal phase.
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EvidenceInput {
    /// Optional semantic graph revision. Omit to use the current workflow revision.
    #[serde(default)]
    pub subject_digest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SomiteMcp {
    server_url: String,
    runtime_capability: String,
    tool_router: ToolRouter<Self>,
}

impl SomiteMcp {
    pub fn new(server_url: String, runtime_capability: String) -> Result<Self, String> {
        HttpEndpoint::parse(&server_url)?;
        if runtime_capability.len() < 32
            || runtime_capability.len() > 256
            || !runtime_capability
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        {
            return Err("invalid Somite MCP runtime capability".to_owned());
        }
        Ok(Self {
            server_url,
            runtime_capability,
            tool_router: Self::tool_router(),
        })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        tool: Option<&'static str>,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> Result<Json<T>, CallToolResult> {
        let server_url = self.server_url.clone();
        let runtime_capability = self.runtime_capability.clone();
        let timeout = http_timeout_for_tool(tool);
        let result = tokio::task::spawn_blocking(move || {
            HttpEndpoint::parse(&server_url)?.json(
                &runtime_capability,
                tool,
                method,
                &path,
                body.as_ref(),
                timeout,
            )
        })
        .await
        .map_err(|error| {
            tool_error(
                "runtime_bridge_failed",
                format!("Somite runtime bridge failed: {error}"),
                true,
                Some("Retry after confirming the Somite web server is running.".to_owned()),
                None,
                None,
            )
        })?;
        let value = result.map_err(|error| http_tool_error(tool, error))?;
        serde_json::from_value(value).map(Json).map_err(|error| {
            tool_error(
                "invalid_runtime_response",
                format!("Somite runtime returned an unexpected response: {error}"),
                false,
                None,
                None,
                None,
            )
        })
    }

    async fn current_graph(&self) -> Result<WorkflowOutput, CallToolResult> {
        Ok(self
            .request::<WorkflowOutput>(None, "GET", "/api/agent/graph".to_owned(), None)
            .await?
            .0)
    }

    fn graph_body(graph: &GraphOutput) -> Result<Value, String> {
        serde_json::to_value(graph)
            .map_err(|error| format!("Could not encode the current graph: {error}"))
    }
}

fn http_timeout_for_tool(tool: Option<&str>) -> Duration {
    if tool == Some("somite.source_workflow.resolve_nfcore") {
        SOURCE_WORKFLOW_RESOLVE_TIMEOUT
    } else {
        HTTP_TIMEOUT
    }
}

#[tool_router]
impl SomiteMcp {
    /// Inspect the current typed workflow and its revisions. Call this before
    /// proposing edits and use the returned `state_revision` as
    /// `somite.graph.apply_transaction.base_state_revision`. The `graph_revision` is
    /// the semantic workflow identity used for evidence lookup; it is not a
    /// transaction base.
    #[tool(
        name = "somite.workflow.get",
        annotations(
            title = "Inspect Somite workflow",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_workflow(&self) -> Result<Json<WorkflowOutput>, CallToolResult> {
        self.request(
            Some("somite.workflow.get"),
            "GET",
            "/api/agent/graph".to_owned(),
            None,
        )
        .await
    }

    /// Inspect deterministic workflow readiness before compiling, running, or
    /// validating. The result names every missing input, parameter, or managed
    /// scientific resource and lists known resolutions without requiring AI.
    #[tool(
        name = "somite.readiness.get",
        annotations(
            title = "Inspect Somite readiness",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_readiness(&self) -> Result<Json<WorkflowAssessment>, CallToolResult> {
        let workflow = self.current_graph().await?;
        self.request(
            Some("somite.readiness.get"),
            "POST",
            "/api/readiness".to_owned(),
            Some(Self::graph_body(&workflow.graph).map_err(graph_serialization_error)?),
        )
        .await
    }

    /// Search Somite's local, revision-pinned operator catalog. Results include
    /// exact ports, parameter contracts, Pixi packages, and immutable revisions.
    #[tool(
        name = "somite.catalog.search",
        annotations(
            title = "Search Somite tools",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn search_catalog(
        &self,
        Parameters(input): Parameters<CatalogSearchInput>,
    ) -> Result<Json<CatalogOutput>, CallToolResult> {
        let query = input.query.trim();
        if query.is_empty() || query.len() > 120 || query.chars().any(char::is_control) {
            return Err(tool_error(
                "invalid_catalog_query",
                "Query must contain 1 to 120 printable bytes.".to_owned(),
                false,
                Some(
                    "Use a short operator, artifact, or task phrase such as `paired FASTQ`."
                        .to_owned(),
                ),
                None,
                None,
            ));
        }
        let limit = input.limit.unwrap_or(12).clamp(1, 50);
        let cursor = input
            .cursor
            .as_deref()
            .map(|cursor| format!("&cursor={}", percent_encode(cursor)))
            .unwrap_or_default();
        self.request(
            Some("somite.catalog.search"),
            "GET",
            format!(
                "/api/agent/catalog?q={}&limit={limit}{cursor}",
                percent_encode(query),
            ),
            None,
        )
        .await
    }

    /// Resolve one catalog-advertised nf-core release as a pinned, collapsed
    /// source workflow and atomically place it on an unchanged empty canvas.
    /// Somite fetches the exact Git tag without interpreting workflow code,
    /// resolves it to the full commit, verifies and stores every tracked source
    /// byte, and commits one `workflow.source` node with no fabricated ports or
    /// inner operators.
    #[tool(
        name = "somite.source_workflow.resolve_nfcore",
        annotations(
            title = "Resolve nf-core source workflow",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn resolve_nfcore_source_workflow(
        &self,
        Parameters(input): Parameters<NfcoreSourceResolveInput>,
    ) -> Result<Json<TransactionOutput>, CallToolResult> {
        let workflow = input.workflow.trim();
        let revision = input.revision.trim();
        if !workflow.starts_with("nf-core/")
            || workflow["nf-core/".len()..].is_empty()
            || workflow["nf-core/".len()..].chars().any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_')
            })
            || revision.is_empty()
            || revision.chars().any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '_')
            })
        {
            return Err(tool_error(
                "invalid_nfcore_source_request",
                "Use an exact nf-core repository and catalog-advertised release tag.".to_owned(),
                false,
                Some("Refresh the Somite nf-core catalog and choose its exact release.".to_owned()),
                None,
                None,
            ));
        }
        self.request(
            Some("somite.source_workflow.resolve_nfcore"),
            "POST",
            "/api/agent/source-workflows/nfcore/resolve".to_owned(),
            Some(serde_json::json!({
                "workflow": workflow,
                "revision": revision,
                "base_state_revision": input.base_state_revision,
                "idempotency_key": input.idempotency_key,
                "summary": input.summary,
            })),
        )
        .await
    }

    /// Search the current official nf-core pipeline catalog and return exact
    /// repository/release pairs suitable for the source workflow resolver.
    /// Results include catalog provenance and whether Somite used its local
    /// cache because the upstream catalog was unavailable.
    #[tool(
        name = "somite.source_workflow.search_nfcore",
        annotations(
            title = "Search nf-core source workflows",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn search_nfcore_source_workflows(
        &self,
        Parameters(input): Parameters<NfcoreSourceSearchInput>,
    ) -> Result<Json<NfcoreSourceSearchOutput>, CallToolResult> {
        let query = input.query.trim();
        if query.is_empty() || query.len() > 120 || query.chars().any(char::is_control) {
            return Err(tool_error(
                "invalid_nfcore_source_query",
                "Query must contain 1 to 120 printable bytes.".to_owned(),
                false,
                Some("Use a pipeline name, topic, or short scientific purpose.".to_owned()),
                None,
                None,
            ));
        }
        let limit = input.limit.unwrap_or(12).clamp(1, 50);
        self.request(
            Some("somite.source_workflow.search_nfcore"),
            "GET",
            format!(
                "/api/source-workflows/nfcore/search?q={}&limit={limit}",
                percent_encode(query)
            ),
            None,
        )
        .await
    }

    /// Apply parameter or invocation-replacement edits to a source-backed
    /// Workflow variant. Replacements must pin an exact catalog operator
    /// revision; incomplete channel knowledge is retained for readiness and
    /// validation instead of rejecting the creative edit.
    #[tool(
        name = "somite.source_workflow.edit",
        annotations(
            title = "Edit source workflow parameters",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn edit_source_workflow(
        &self,
        Parameters(input): Parameters<SourceWorkflowEditInput>,
    ) -> Result<Json<TransactionOutput>, CallToolResult> {
        if input.edits.is_empty() || input.edits.len() > 64 {
            return Err(tool_error(
                "invalid_source_workflow_edits",
                "Provide between 1 and 64 source workflow edits.".to_owned(),
                false,
                Some("Inspect the current source workflow and exact catalog operator contracts, then submit one coherent transaction.".to_owned()),
                None,
                None,
            ));
        }
        let body = serde_json::to_value(input).map_err(|error| {
            tool_error(
                "invalid_source_workflow_edits",
                format!("Could not encode source parameter edits: {error}"),
                false,
                None,
                None,
                None,
            )
        })?;
        self.request(
            Some("somite.source_workflow.edit"),
            "POST",
            "/api/agent/source-workflows/edit".to_owned(),
            Some(body),
        )
        .await
    }

    /// Promote one selected source invocation replacement into an ordinary
    /// native Somite node. The returned graph uses the normal typed ports,
    /// edges, readiness, Nextflow, and Pixi paths while retaining the exact
    /// pinned source workflow and invocation mapping as non-executable
    /// provenance.
    #[tool(
        name = "somite.source_workflow.promote",
        annotations(
            title = "Promote source call to editable canvas",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn promote_source_workflow_invocation(
        &self,
        Parameters(input): Parameters<SourceWorkflowPromotionInput>,
    ) -> Result<Json<TransactionOutput>, CallToolResult> {
        if input.invocation_id.trim().is_empty()
            || input.invocation_id.len() > 512
            || input.invocation_id.chars().any(char::is_control)
        {
            return Err(tool_error(
                "invalid_source_workflow_invocation",
                "Provide the exact printable invocation id from the current source workflow."
                    .to_owned(),
                false,
                Some("Inspect the workflow, select a replacement with somite.source_workflow.edit, then promote that invocation.".to_owned()),
                None,
                None,
            ));
        }
        let body = serde_json::to_value(input).map_err(|error| {
            tool_error(
                "invalid_source_workflow_promotion",
                format!("Could not encode source workflow promotion: {error}"),
                false,
                None,
                None,
                None,
            )
        })?;
        self.request(
            Some("somite.source_workflow.promote"),
            "POST",
            "/api/agent/source-workflows/promote".to_owned(),
            Some(body),
        )
        .await
    }

    /// Search current NCBI or Ensembl records without leaving Somite. Use this
    /// for reads, reference assemblies, organisms, accessions, and genes before
    /// generic web research. Results include provenance and a structured source
    /// request whose ordered `operator_ids` identify Somite's compatible native
    /// source recipe. Search those exact ids to obtain their immutable contracts.
    #[tool(
        name = "somite.source.search",
        annotations(
            title = "Search scientific sources",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn search_sources(
        &self,
        Parameters(input): Parameters<SourceSearchInput>,
    ) -> Result<Json<source_search::SearchResponse>, CallToolResult> {
        let query = input.query.trim();
        if !(2..=120).contains(&query.len()) || query.chars().any(char::is_control) {
            return Err(tool_error(
                "invalid_source_query",
                "Query must contain 2 to 120 printable bytes.".to_owned(),
                false,
                Some(
                    "Use a scientific entity, accession, organism, assembly, run, or gene."
                        .to_owned(),
                ),
                None,
                None,
            ));
        }
        self.request(
            Some("somite.source.search"),
            "GET",
            format!(
                "/api/sources/search?q={}&provider={}",
                percent_encode(query),
                input.provider.as_str(),
            ),
            None,
        )
        .await
    }

    /// Apply one atomic workflow edit. Every operation either succeeds together
    /// or none are persisted. The web canvas receives the result as one undoable
    /// transaction. Set `base_state_revision` to the latest `state_revision`
    /// returned by `somite.workflow.get`, and use a new `idempotency_key` for
    /// each intended edit. Reusing the key with the identical request safely
    /// returns the original result. A stale state is rejected rather than
    /// overwriting concurrent user work.
    #[tool(
        name = "somite.graph.apply_transaction",
        annotations(
            title = "Edit Somite workflow",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn apply_transaction(
        &self,
        Parameters(transaction): Parameters<GraphTransaction>,
    ) -> Result<Json<TransactionOutput>, CallToolResult> {
        let body = serde_json::to_value(transaction).map_err(|error| {
            tool_error(
                "invalid_transaction",
                format!("Could not encode the graph transaction: {error}"),
                false,
                None,
                None,
                None,
            )
        })?;
        self.request(
            Some("somite.graph.apply_transaction"),
            "POST",
            "/api/agent/transactions".to_owned(),
            Some(body),
        )
        .await
    }

    /// Compile the current graph through Somite's production Nextflow/Pixi
    /// freezer. The output is content-addressed under `.somite/compiled` and the
    /// response includes the exact graph and run-closure identities.
    #[tool(
        name = "somite.workflow.compile",
        annotations(
            title = "Compile Somite workflow",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn compile_workflow(&self) -> Result<Json<CompileOutput>, CallToolResult> {
        self.request(
            Some("somite.workflow.compile"),
            "POST",
            "/api/agent/compile".to_owned(),
            Some(Value::Object(Default::default())),
        )
        .await
    }

    /// Start a real Nextflow run for the current graph using the same Pixi-frozen
    /// runtime as the web Run button.
    #[tool(
        name = "somite.run.start",
        annotations(
            title = "Run Somite workflow",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn start_run(
        &self,
        Parameters(input): Parameters<StartInput>,
    ) -> Result<Json<RunStartOutput>, CallToolResult> {
        let workflow = self.current_graph().await?;
        self.request(
            Some("somite.run.start"),
            "POST",
            format!(
                "/api/runs?idempotency_key={}",
                percent_encode(&input.idempotency_key)
            ),
            Some(Self::graph_body(&workflow.graph).map_err(graph_serialization_error)?),
        )
        .await
    }

    /// Start configuration-scoped validation with Somite's representative
    /// fixture pack. Poll `somite.run.status` with the returned run id.
    #[tool(
        name = "somite.validation.start",
        annotations(
            title = "Validate Somite workflow",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn start_validation(
        &self,
        Parameters(input): Parameters<StartInput>,
    ) -> Result<Json<RunStartOutput>, CallToolResult> {
        let workflow = self.current_graph().await?;
        self.request(
            Some("somite.validation.start"),
            "POST",
            format!(
                "/api/validations?idempotency_key={}",
                percent_encode(&input.idempotency_key)
            ),
            Some(Self::graph_body(&workflow.graph).map_err(graph_serialization_error)?),
        )
        .await
    }

    /// Read the lifecycle, node states, closure identity, and evidence receipt for
    /// a run or validation.
    #[tool(
        name = "somite.run.status",
        annotations(
            title = "Inspect Somite run",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn run_status(
        &self,
        Parameters(input): Parameters<RunInput>,
    ) -> Result<Json<RunStatusOutput>, CallToolResult> {
        if !valid_run_id(&input.run_id) {
            return Err(invalid_run_id_error());
        }
        let wait_ms = input.wait_ms.unwrap_or_default().min(25_000);
        self.request(
            Some("somite.run.status"),
            "GET",
            format!(
                "/api/runs/{}?wait_ms={wait_ms}",
                percent_encode(&input.run_id)
            ),
            None,
        )
        .await
    }

    /// Cancel an active run or validation through Somite's shared run supervisor.
    #[tool(
        name = "somite.run.cancel",
        annotations(
            title = "Cancel Somite run",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn cancel_run(
        &self,
        Parameters(input): Parameters<RunInput>,
    ) -> Result<Json<RunStatusOutput>, CallToolResult> {
        if !valid_run_id(&input.run_id) {
            return Err(invalid_run_id_error());
        }
        self.request(
            Some("somite.run.cancel"),
            "POST",
            format!("/api/runs/{}/cancel", percent_encode(&input.run_id)),
            Some(Value::Object(Default::default())),
        )
        .await
    }

    /// Look up immutable validation evidence receipts for a semantic graph
    /// revision. Omit the digest to inspect evidence for the current workflow.
    #[tool(
        name = "somite.evidence.lookup",
        annotations(
            title = "Inspect Somite evidence",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn lookup_evidence(
        &self,
        Parameters(input): Parameters<EvidenceInput>,
    ) -> Result<Json<EvidenceOutput>, CallToolResult> {
        let path = match input.subject_digest {
            Some(subject) => {
                if subject.len() > 160 || subject.chars().any(char::is_control) {
                    return Err(tool_error(
                        "invalid_subject_digest",
                        "Evidence subject digest is invalid.".to_owned(),
                        false,
                        Some("Pass a `graph_revision` returned by `somite.workflow.get`, or omit the digest for the current workflow.".to_owned()),
                        None,
                        None,
                    ));
                }
                format!("/api/agent/evidence?subject={}", percent_encode(&subject))
            }
            None => "/api/agent/evidence".to_owned(),
        };
        self.request(Some("somite.evidence.lookup"), "GET", path, None)
            .await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SomiteMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("somite", env!("CARGO_PKG_VERSION")).with_title("Somite"),
            )
            .with_instructions(
                "Somite is a creative visual bioinformatics workflow compiler. Before each edit, call somite.workflow.get and pass its state_revision as base_state_revision. Search exact operator contracts; never invent operator ids, revisions, ports, or parameters. Discover exact nf-core repository/release pairs with somite.source_workflow.search_nfcore, then import them with somite.source_workflow.resolve_nfcore; never add a fabricated nf.* execution operator or the bare workflow.source infrastructure operator. Edit source-backed intent through somite.source_workflow.edit. To rewire a selected invocation replacement, promote it with somite.source_workflow.promote: promotion crosses into a normal native typed graph while retaining exact non-executable source provenance. Never treat the retained source as a hidden executable layer. Invocation replacements are allowed before every channel is known: preserve the edit, inspect readiness, and help resolve indexing, conversion, connection, parameter, and Pixi environment work instead of refusing creativity. Use somite.source.search for current NCBI or Ensembl reads, assemblies, genes, and references before generic web research. Give each intended edit, run, or validation a fresh idempotency_key; reuse it only to retry the identical call after a lost response. Apply one small coherent atomic transaction. If it is stale, inspect again, re-check intent, and retry once with a new key. Call somite.readiness.get after editing and resolve or report every required item before compile, run, or validation. After validation.start, call run.status with wait_ms up to 25000 until it reaches a terminal phase. Never claim a workflow is runnable unless validation completed successfully.".to_owned(),
            )
    }
}

pub async fn serve_stdio(server_url: String, runtime_capability: String) -> anyhow::Result<()> {
    let server = SomiteMcp::new(server_url, runtime_capability).map_err(anyhow::Error::msg)?;
    let service = server
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await?;
    service.waiting().await?;
    Ok(())
}

fn valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 128
        && run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn invalid_run_id_error() -> CallToolResult {
    tool_error(
        "invalid_run_id",
        "Run id is invalid.".to_owned(),
        false,
        Some("Use the exact run id returned by a Somite start tool.".to_owned()),
        None,
        None,
    )
}

fn graph_serialization_error(message: String) -> CallToolResult {
    tool_error(
        "graph_serialization_failed",
        message,
        false,
        None,
        None,
        None,
    )
}

fn tool_error(
    code: &str,
    message: String,
    retryable: bool,
    recovery: Option<String>,
    supplied_state_revision: Option<String>,
    current_state_revision: Option<String>,
) -> CallToolResult {
    let error = ToolErrorOutput {
        error: ToolErrorDetail {
            code: code.to_owned(),
            message,
            retryable,
            recovery,
            supplied_state_revision,
            current_state_revision,
        },
    };
    CallToolResult::structured_error(serde_json::to_value(error).unwrap_or_else(
        |serialization_error| {
            serde_json::json!({
                "error": {
                    "code": "error_serialization_failed",
                    "message": serialization_error.to_string(),
                    "retryable": false
                }
            })
        },
    ))
}

fn stale_revisions(message: &str) -> (Option<String>, Option<String>) {
    let supplied = message
        .split_once("transaction base ")
        .and_then(|(_, rest)| rest.split_once(" is stale"))
        .map(|(revision, _)| revision.to_owned());
    let current = message
        .split_once("current state revision is ")
        .map(|(_, revision)| revision.trim().to_owned());
    (supplied, current)
}

fn http_tool_error(tool: Option<&str>, message: String) -> CallToolResult {
    if message.contains("workflow is not ready") {
        return tool_error(
            "workflow_not_ready",
            message,
            false,
            Some("Call somite.readiness.get and resolve or report each required item before retrying.".to_owned()),
            None,
            None,
        );
    }
    if message.contains("idempotency key was already used") {
        return tool_error(
            "idempotency_conflict",
            message,
            false,
            Some("Use a fresh idempotency_key for a different intended edit.".to_owned()),
            None,
            None,
        );
    }
    if message.contains("idempotency key must contain") {
        return tool_error(
            "invalid_idempotency_key",
            message,
            false,
            Some("Use 8 to 128 ASCII letters, numbers, hyphens, or underscores.".to_owned()),
            None,
            None,
        );
    }
    if message.contains("transaction base") && message.contains("current state revision") {
        let (supplied, current) = stale_revisions(&message);
        return tool_error(
            "stale_state_revision",
            message,
            true,
            Some(
                "Call somite.workflow.get, re-check the intended edit, then retry once using its current state_revision as base_state_revision and a new idempotency_key."
                    .to_owned(),
            ),
            supplied,
            current,
        );
    }
    let status = message
        .strip_prefix("HTTP ")
        .and_then(|value| value.split_once(':'))
        .and_then(|(status, _)| status.parse::<u16>().ok());
    let (code, recovery) = match (tool, status) {
        (Some("somite.source_workflow.resolve_nfcore"), status)
            if status.is_none_or(|status| status >= 500) =>
        {
            (
            "source_workflow_resolution_failed",
            Some(
                "A first exact source fetch can take several minutes. Retry with the same idempotency_key if the response was lost; Somite will return the original transaction without importing twice."
                    .to_owned(),
            ),
            )
        }
        (Some("somite.workflow.compile"), _) => (
            "compile_failed",
            Some(
                "Inspect the exact compiler message, repair only the reported contract, then compile again."
                    .to_owned(),
            ),
        ),
        (Some("somite.run.status" | "somite.run.cancel"), Some(404)) => (
            "run_not_found",
            Some("Use the exact run id returned by a Somite start tool.".to_owned()),
        ),
        (_, Some(422)) => (
            "invalid_workflow_operation",
            Some("Inspect the workflow and exact operator contract before retrying.".to_owned()),
        ),
        (_, Some(400..=499)) => ("runtime_request_rejected", None),
        _ => (
            "runtime_unavailable",
            Some("Confirm the Somite web server is running, then retry once.".to_owned()),
        ),
    };
    tool_error(
        code,
        message,
        status.is_none_or(|status| status >= 500),
        recovery,
        None,
        None,
    )
}

#[derive(Debug, Clone)]
struct HttpEndpoint {
    authority: String,
}

impl HttpEndpoint {
    fn parse(server_url: &str) -> Result<Self, String> {
        let authority = server_url
            .strip_prefix("http://")
            .ok_or_else(|| "Somite MCP only accepts a local http:// server URL".to_owned())?
            .trim_end_matches('/');
        if authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
            return Err("invalid Somite server URL".to_owned());
        }
        let host = if let Some(bracketed) = authority.strip_prefix('[') {
            bracketed
                .split_once(']')
                .map(|(host, _)| host)
                .ok_or_else(|| "invalid bracketed Somite server URL".to_owned())?
        } else {
            authority.split(':').next().unwrap_or_default()
        };
        if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
            return Err("Somite MCP only connects to the local runtime".to_owned());
        }
        Ok(Self {
            authority: authority.to_owned(),
        })
    }

    fn json(
        &self,
        runtime_capability: &str,
        tool: Option<&str>,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !path.starts_with('/') || path.contains(['\r', '\n']) {
            return Err("invalid internal Somite path".to_owned());
        }
        let body = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| format!("encode Somite request: {error}"))?
            .unwrap_or_default();
        let mut stream = TcpStream::connect(&self.authority)
            .map_err(|error| format!("connect to Somite runtime: {error}"))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| format!("set Somite read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|error| format!("set Somite write timeout: {error}"))?;
        let tool_header = tool
            .map(|tool| format!("X-Somite-Mcp-Tool: {tool}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nAuthorization: Bearer {runtime_capability}\r\n{tool_header}Content-Length: {}\r\nConnection: close\r\n\r\n",
            self.authority,
            body.len()
        )
        .map_err(|error| format!("write Somite request: {error}"))?;
        stream
            .write_all(&body)
            .map_err(|error| format!("write Somite request body: {error}"))?;
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .map_err(|error| format!("read Somite response: {error}"))?;
        parse_http_response(&response)
    }
}

fn parse_http_response(response: &[u8]) -> Result<Value, String> {
    let boundary = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Somite runtime returned an invalid HTTP response".to_owned())?;
    let header = std::str::from_utf8(&response[..boundary])
        .map_err(|_| "Somite runtime returned non-UTF-8 headers".to_owned())?;
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Somite runtime omitted an HTTP status".to_owned())?;
    let mut body = response[boundary + 4..].to_vec();
    if header
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"))
    {
        body = decode_chunked(&body)?;
    }
    let value = if body.is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(&body)
            .map_err(|error| format!("Somite runtime returned invalid JSON: {error}"))?
    };
    if !(200..300).contains(&status) {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Somite request failed");
        return Err(format!("HTTP {status}: {message}"));
    }
    Ok(value)
}

fn decode_chunked(mut encoded: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    loop {
        let end = encoded
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "invalid chunked Somite response".to_owned())?;
        let length = std::str::from_utf8(&encoded[..end])
            .ok()
            .and_then(|value| value.split(';').next())
            .and_then(|value| usize::from_str_radix(value.trim(), 16).ok())
            .ok_or_else(|| "invalid Somite response chunk length".to_owned())?;
        encoded = &encoded[end + 2..];
        if length == 0 {
            break;
        }
        if encoded.len() < length + 2 || &encoded[length..length + 2] != b"\r\n" {
            return Err("truncated Somite response chunk".to_owned());
        }
        decoded.extend_from_slice(&encoded[..length]);
        encoded = &encoded[length + 2..];
    }
    Ok(decoded)
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_loopback_only() {
        assert!(HttpEndpoint::parse("http://127.0.0.1:7310").is_ok());
        assert!(HttpEndpoint::parse("http://localhost:7310").is_ok());
        assert!(HttpEndpoint::parse("http://[::1]:7310").is_ok());
        assert!(HttpEndpoint::parse("https://example.com").is_err());
        assert!(HttpEndpoint::parse("http://192.0.2.1:7310").is_err());
    }

    #[test]
    fn chunked_json_response_is_decoded() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"ok\":t\r\n4\r\nrue}\r\n0\r\n\r\n";
        assert_eq!(parse_http_response(response).unwrap()["ok"], true);
    }

    #[test]
    fn schema_v3_port_types_deserialize_through_the_mcp_contract() {
        for name in ["Gff3", "Sam", "Bed", "Agp", "Chain"] {
            let port: PortTypeOutput =
                serde_json::from_value(Value::String(name.to_owned())).expect("valid port type");
            assert_eq!(serde_json::to_value(port).expect("port JSON"), name);
        }
    }

    #[test]
    fn first_nfcore_source_fetch_has_a_long_idempotent_bridge_timeout() {
        assert_eq!(
            http_timeout_for_tool(Some("somite.source_workflow.resolve_nfcore")),
            Duration::from_secs(300)
        );
        assert_eq!(
            http_timeout_for_tool(Some("somite.workflow.get")),
            Duration::from_secs(30)
        );
    }
}
