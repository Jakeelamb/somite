use std::collections::{BTreeMap, BTreeSet};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use somite_assessment::{assess, AssessmentState, SupportKind, WorkflowAssessment};
use somite_bundle::{
    absolutize_import_paths, archive_frozen_package, create_frozen_package_with_pixi,
    pixi_executable, plan_frozen_package, BundlePlan, ExportTarget,
};
use somite_fixtures::{bind_representative_fastq, content_digest, FixtureBinding};
use somite_ir::{
    Graph, Layout, Node, SourceCapabilities, SourceProvider as WorkflowSourceProvider,
    SourceWorkflowInstance, WorkflowBinding, WorkflowSourcePin, MAX_SOURCE_PATH_BYTES,
};
use somite_linker::{
    evidence_receipt, graph_state_revision, semantic_graph_revision, EvidenceDraft, EvidenceIndex,
    EvidenceReceipt, EvidenceResult,
};
use somite_ops::{current_pixi_platform, Catalog, OpKind, Operator};
use somite_ops::{nfcore, snakemake, snakemake_local, workflow};
use somite_paper::{
    extract_from_path, extract_from_path_with_toolchain, reconstruct, resource_citations, Assay,
    CandidateRole, EvidenceStatus, EvidenceTarget, ExtractVia, ExtractionLimits,
    ExtractionProgress, ExtractionToolchain, MethodSupport, PaperError, ReconstructionOutcome,
    ResourceCitationKind, ResourceRole,
};
use somite_source_workflow::workflow_revision as calculate_source_workflow_revision;
use somite_source_workflow::{
    apply as apply_source_edit, promote_invocation, restore_source_workflow, EditTransaction,
    FrozenSourceFile, SemanticEdit, SourceFileManifest, SourceManifest, SOURCE_INDEXER_REVISION,
};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{watch, Notify, Semaphore};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

mod agent;
mod agent_discovery;
mod literature;
mod mcp;
mod source_search;

pub use agent::{
    AgentConfigValue, AgentEvent, AgentEventKind, AgentSnapshot, AgentTranscript,
    AgentTranscriptMessage, AgentTranscriptPermission, AgentTranscriptToolCall, GraphOperation,
    GraphTransaction, PermissionChoice, TransactionResult,
};
pub use mcp::serve_stdio as serve_mcp_stdio;

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("{0}")]
    InvalidGraph(#[from] somite_ir::IrError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Catalog(#[from] somite_ops::OpsError),
    #[error("upload did not contain a file")]
    MissingUpload,
    #[error("invalid upload filename")]
    InvalidFilename,
    #[error("upload: {0}")]
    Upload(String),
    #[error("upload store: {0}")]
    UnsafeUploadStore(String),
    #[error("upload exceeds the {limit_bytes} byte limit")]
    UploadTooLarge { limit_bytes: u64 },
    #[error(
        "upload would exceed the project upload budget of {limit_bytes} bytes (currently using {used_bytes} bytes)"
    )]
    UploadProjectBudgetExceeded { limit_bytes: u64, used_bytes: u64 },
    #[error("paper upload exceeds the {limit_bytes} byte limit")]
    PaperUploadTooLarge { limit_bytes: u64 },
    #[error("unsupported paper upload: {0}")]
    UnsupportedPaperUpload(String),
    #[error("paper artifact not found: {0}")]
    PaperArtifactNotFound(String),
    #[error("paper intake job not found: {0}")]
    PaperIntakeNotFound(String),
    #[error("paper intake capacity is full; wait for an active job to finish")]
    PaperIntakeBusy,
    #[error("paper intake request: {0}")]
    InvalidPaperIntake(String),
    #[error("run: {0}")]
    Run(String),
    #[error("run not found: {0}")]
    RunNotFound(String),
    #[error("validation: {0}")]
    Validation(String),
    #[error("paper: {0}")]
    Paper(String),
    #[error("{0}")]
    Literature(#[from] literature::LiteratureError),
    #[error("project path is not a readable file: {0}")]
    InvalidProjectPath(String),
    #[error("unsafe graph path: {0}")]
    UnsafeGraphPath(String),
    #[error(
        "serialized graph is {encoded_bytes} bytes and exceeds the {limit_bytes} byte graph limit"
    )]
    GraphTooLarge {
        encoded_bytes: u64,
        limit_bytes: u64,
    },
    #[error("nf-core catalog: {0}")]
    CatalogDiscovery(String),
    #[error("workflow import: {0}")]
    WorkflowImport(String),
    #[error("source workflow: {0}")]
    SourceWorkflow(String),
    #[error(
        "serialized {record} is {encoded_bytes} bytes and exceeds the {limit_bytes} byte source record limit"
    )]
    SourceRecordTooLarge {
        record: String,
        encoded_bytes: u64,
        limit_bytes: u64,
    },
    #[error("source search: {0}")]
    SourceSearch(String),
    #[error("source request: {0}")]
    InvalidSourceRequest(String),
    #[error("agent: {0}")]
    Agent(#[from] agent::AgentError),
    #[error("export: {0}")]
    Export(#[from] somite_bundle::BundleError),
    #[error("link: {0}")]
    Link(#[from] somite_linker::LinkError),
    #[error("assessment: {0}")]
    Assessment(#[from] somite_assessment::AssessmentError),
    #[error("workflow is not ready: {0}")]
    NotReady(String),
    #[error(
        "graph state conflict: base_state_revision {provided} does not match current state_revision {current}"
    )]
    GraphStateConflict { provided: String, current: String },
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        if let Self::GraphStateConflict { current, .. } = &self {
            return (
                StatusCode::CONFLICT,
                Json(GraphWriteConflictResponse {
                    error: self.to_string(),
                    state_revision: current.clone(),
                }),
            )
                .into_response();
        }
        let status = match self {
            Self::InvalidGraph(_)
            | Self::Catalog(
                somite_ops::OpsError::Unknown(_)
                | somite_ops::OpsError::RevisionMismatch { .. }
                | somite_ops::OpsError::GraphSchema(_)
                | somite_ops::OpsError::InvalidGraph(_)
                | somite_ops::OpsError::Argv(_),
            ) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::MissingUpload
            | Self::InvalidFilename
            | Self::InvalidProjectPath(_)
            | Self::UnsafeGraphPath(_)
            | Self::InvalidSourceRequest(_)
            | Self::InvalidPaperIntake(_)
            | Self::Literature(
                literature::LiteratureError::InvalidQuery
                | literature::LiteratureError::InvalidPaperId,
            ) => StatusCode::BAD_REQUEST,
            Self::PaperUploadTooLarge { .. }
            | Self::UploadTooLarge { .. }
            | Self::UploadProjectBudgetExceeded { .. }
            | Self::GraphTooLarge { .. }
            | Self::SourceRecordTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedPaperUpload(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::PaperIntakeBusy => StatusCode::SERVICE_UNAVAILABLE,
            Self::RunNotFound(_)
            | Self::PaperArtifactNotFound(_)
            | Self::PaperIntakeNotFound(_) => StatusCode::NOT_FOUND,
            Self::Io(_)
            | Self::Json(_)
            | Self::Catalog(_)
            | Self::Upload(_)
            | Self::Run(_)
            | Self::Export(_)
            | Self::Literature(literature::LiteratureError::Cache(_)) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Self::Link(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Assessment(_) | Self::NotReady(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Paper(_) | Self::WorkflowImport(_) | Self::SourceWorkflow(_) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            Self::UnsafeUploadStore(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Literature(
                literature::LiteratureError::FullTextUnavailable
                | literature::LiteratureError::NotBiorxiv,
            ) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Literature(literature::LiteratureError::Upstream(_)) => StatusCode::BAD_GATEWAY,
            Self::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Agent(
                agent::AgentError::StaleTransaction { .. }
                | agent::AgentError::InvalidIdempotencyKey
                | agent::AgentError::IdempotencyConflict
                | agent::AgentError::InvalidOperationCount
                | agent::AgentError::InvalidSummary
                | agent::AgentError::InvalidIdentifier(_)
                | agent::AgentError::NodeNotFound(_)
                | agent::AgentError::EdgeNotFound(_)
                | agent::AgentError::UnknownParameter { .. }
                | agent::AgentError::ParameterType { .. }
                | agent::AgentError::ParameterBounds { .. }
                | agent::AgentError::InvalidNote
                | agent::AgentError::SourceOperatorRequiresResolver(_)
                | agent::AgentError::ResolverOnlyOperator(_)
                | agent::AgentError::SourceImportRequiresEmptyCanvas
                | agent::AgentError::SourceWorkflowNotFound
                | agent::AgentError::StaleSourceWorkflow { .. }
                | agent::AgentError::InvalidSourceEditCount
                | agent::AgentError::EmptyCommand
                | agent::AgentError::InvalidCommand
                | agent::AgentError::InvalidPrompt
                | agent::AgentError::InvalidConfigOption,
            ) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Agent(agent::AgentError::NotConnected) => StatusCode::CONFLICT,
            Self::Agent(agent::AgentError::AlreadyConnected | agent::AgentError::Busy) => {
                StatusCode::CONFLICT
            }
            Self::Agent(agent::AgentError::Launch(_) | agent::AgentError::Config(_)) => {
                StatusCode::BAD_GATEWAY
            }
            Self::Agent(
                agent::AgentError::Catalog(_)
                | agent::AgentError::Graph(_)
                | agent::AgentError::Identity(_),
            ) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::SourceSearch(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::CatalogDiscovery(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::GraphStateConflict { .. } => StatusCode::CONFLICT,
        };
        (
            status,
            Json(ErrorResponse {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize)]
struct GraphWriteConflictResponse {
    error: String,
    state_revision: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectSession {
    pub project_name: String,
    pub graph_path: String,
    pub graph: Graph,
    pub state_revision: String,
    pub operators: Vec<CatalogOperator>,
    pub recovered_autosave: bool,
    pub agent_cursor: u64,
}

#[derive(Debug, Serialize)]
pub struct CatalogOperator {
    #[serde(flatten)]
    pub operator: Operator,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct ValidationResponse {
    pub valid: bool,
}

#[derive(Debug, Deserialize)]
pub struct GraphWriteRequest {
    pub base_state_revision: String,
    pub graph: Graph,
}

#[derive(Debug, Serialize)]
pub struct GraphWriteResponse {
    pub valid: bool,
    pub state_revision: String,
}

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub path: String,
    pub filename: String,
}

#[derive(Debug, Serialize)]
pub struct SystemProfile {
    pub cpu: String,
    pub physical_cores: usize,
    pub logical_threads: usize,
    pub memory_bytes: u64,
    pub gpus: Vec<String>,
    pub os: String,
    pub tools: ToolReadiness,
    pub paper_extraction: PaperExtractionPreflight,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperExtractionPreflight {
    pub native_pdf_text: bool,
    pub scanned_pdf_ocr: bool,
    pub tools: Vec<PaperExtractionToolReadiness>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperExtractionToolReadiness {
    pub name: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PaperToolSource>,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperToolSource {
    ManagedPixi,
    ProjectPixi,
    SystemPath,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Preparing,
    Running,
    Finalizing,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

impl RunPhase {
    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunNodeState {
    Queued,
    Running,
    Cached,
    Done,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunStatusResponse {
    pub run_id: String,
    pub phase: RunPhase,
    pub states: BTreeMap<String, RunNodeState>,
    pub closure_digest: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub evidence_receipt: Option<EvidenceReceipt>,
    pub progress: RunProgress,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunProgress {
    pub completed: usize,
    pub total: usize,
    pub unit: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunStartResponse {
    pub run_id: String,
    pub phase: RunPhase,
    pub replayed: bool,
}

#[derive(Debug, Default, Deserialize)]
struct RunStartQuery {
    idempotency_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RunStatusQuery {
    #[serde(default)]
    wait_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ValidationEvidenceResponse {
    pub subject_digest: String,
    pub configuration_digest: String,
    pub fixture_pack: String,
    pub receipt: Option<EvidenceReceipt>,
}

#[derive(Debug, Deserialize)]
pub struct PaperRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct BiorxivPaperRequest {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperResponse {
    pub extracted_via: String,
    pub outcome: String,
    pub warnings: Vec<String>,
    pub mentions: Vec<PaperMethodMention>,
    pub resources: Vec<PaperResourceCitation>,
    pub candidates: Vec<PaperCandidate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperMethodMention {
    pub display_name: String,
    pub normalized_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_class: Option<String>,
    pub evidence: String,
    pub support: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperResourceCitation {
    pub accession: String,
    pub kind: String,
    pub role: String,
    pub context: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PaperResourceResolveRequest {
    pub resources: Vec<PaperResourceCitation>,
}

#[derive(Debug, Serialize)]
pub struct PaperResourceResolution {
    pub groups: Vec<PaperResourceGroup>,
}

#[derive(Debug, Serialize)]
pub struct PaperResourceGroup {
    pub citation: PaperResourceCitation,
    pub provider: String,
    pub status: String,
    pub results: Vec<source_search::SearchResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperCandidate {
    pub name: String,
    pub role: String,
    pub assay: String,
    pub graph: Graph,
    pub warnings: Vec<String>,
    pub evidence: Vec<PaperEvidence>,
    pub assessment: WorkflowAssessment,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperEvidence {
    pub target_kind: String,
    pub target_id: String,
    pub status: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<String>,
}

const DEFAULT_MAX_PAPER_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_TEXT_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_MAX_PAPER_OCR_PAGES: usize = 200;
const DEFAULT_PAPER_COMMAND_TIMEOUT_SECONDS: u64 = 120;
const DEFAULT_MAX_ACTIVE_PAPER_EXECUTIONS: usize = 2;
const PAPER_MULTIPART_OVERHEAD_BYTES: u64 = 1024 * 1024;
const MAX_ACTIVE_PAPER_INTAKES: usize = 256;
const PAPER_EXTRACTOR_REVISION: &str = "somite-paper-extractor-v2";
const PAPER_RECONSTRUCTOR_REVISION: &str = "somite-paper-reconstructor-v4";
// Bump this whenever indexing changes can alter the full stored source-workflow
// instance for the same upstream release. The request cache is deliberately
// keyed by this presentation/index revision, not only by semantic identity.
const NFCORE_SOURCE_RESOLVER_REVISION: &str = "nfcore-source-resolver-v3";
const MAX_NFCORE_TRACKED_FILES: usize = 20_000;
const MAX_NFCORE_TRACKED_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_NFCORE_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NFCORE_GIT_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_NFCORE_GIT_DIAGNOSTIC_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_NFCORE_CATALOG_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GRAPH_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_MAX_GENERIC_UPLOAD_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const DEFAULT_MAX_GENERIC_UPLOAD_PROJECT_BYTES: u64 = 256 * 1024 * 1024 * 1024;
const MAX_CONFIGURED_GENERIC_UPLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024 * 1024;
const MAX_GRAPH_TRANSACTION_REPLAYS: usize = 64;
const MAX_VERIFIED_SOURCE_OBJECTS: usize = 128;
const MAX_VERIFIED_SOURCE_INSTANCES: usize = 512;
const SOURCE_VERIFICATION_GATE_STRIPES: usize = 64;

#[derive(Clone, Copy, Debug)]
struct PaperLimits {
    max_upload_bytes: u64,
    max_extracted_text_bytes: u64,
    max_ocr_pages: usize,
    command_timeout: Duration,
    max_active_executions: usize,
}

#[derive(Clone, Copy, Debug)]
struct GenericUploadLimits {
    max_file_bytes: u64,
    max_project_bytes: u64,
}

impl GenericUploadLimits {
    fn from_environment() -> Self {
        let max_project_bytes = bounded_environment_u64(
            "SOMITE_UPLOAD_MAX_PROJECT_BYTES",
            DEFAULT_MAX_GENERIC_UPLOAD_PROJECT_BYTES,
            MAX_CONFIGURED_GENERIC_UPLOAD_BYTES,
        );
        let max_file_bytes = bounded_environment_u64(
            "SOMITE_UPLOAD_MAX_FILE_BYTES",
            DEFAULT_MAX_GENERIC_UPLOAD_BYTES,
            MAX_CONFIGURED_GENERIC_UPLOAD_BYTES,
        )
        .min(max_project_bytes);
        Self {
            max_file_bytes,
            max_project_bytes,
        }
    }
}

impl PaperLimits {
    fn from_environment() -> Self {
        Self {
            max_upload_bytes: bounded_environment_bytes(
                "SOMITE_PAPER_MAX_UPLOAD_BYTES",
                DEFAULT_MAX_PAPER_UPLOAD_BYTES,
            ),
            max_extracted_text_bytes: bounded_environment_bytes(
                "SOMITE_PAPER_MAX_TEXT_BYTES",
                DEFAULT_MAX_EXTRACTED_TEXT_BYTES,
            ),
            max_ocr_pages: bounded_environment_u64(
                "SOMITE_PAPER_MAX_OCR_PAGES",
                DEFAULT_MAX_PAPER_OCR_PAGES as u64,
                10_000,
            ) as usize,
            command_timeout: Duration::from_secs(bounded_environment_u64(
                "SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS",
                DEFAULT_PAPER_COMMAND_TIMEOUT_SECONDS,
                3_600,
            )),
            max_active_executions: bounded_environment_u64(
                "SOMITE_PAPER_MAX_ACTIVE_JOBS",
                DEFAULT_MAX_ACTIVE_PAPER_EXECUTIONS as u64,
                32,
            ) as usize,
        }
    }
}

fn bounded_environment_bytes(name: &str, fallback: u64) -> u64 {
    bounded_environment_u64(name, fallback, 1024 * 1024 * 1024)
}

fn bounded_environment_u64(name: &str, fallback: u64, maximum: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=maximum).contains(value))
        .unwrap_or(fallback)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperMediaKind {
    Pdf,
    Text,
}

impl PaperMediaKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Text => "txt",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperArtifactResponse {
    pub digest: String,
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub media_kind: PaperMediaKind,
    pub reused: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredPaperArtifact {
    schema_version: u32,
    digest: String,
    size_bytes: u64,
    media_kind: PaperMediaKind,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredPaperDisplayName {
    schema_version: u32,
    source_digest: String,
    filename: String,
}

#[derive(Debug, Deserialize)]
pub struct PaperIntakeRequest {
    pub digest: String,
}

#[derive(Debug, Default, Deserialize)]
struct PaperIntakeStartQuery {
    idempotency_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperIntakePhase {
    Queued,
    Extracting,
    LocatingMethods,
    RecognizingMethods,
    AssessingDrafts,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

impl PaperIntakePhase {
    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperIntakeProgress {
    pub completed: usize,
    pub total: usize,
    pub unit: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PaperCacheUse {
    pub extraction: bool,
    pub reconstruction: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperIntakeStatusResponse {
    pub job_id: String,
    pub source_digest: String,
    pub phase: PaperIntakePhase,
    pub progress: PaperIntakeProgress,
    pub durations_ms: BTreeMap<String, u64>,
    pub cache: PaperCacheUse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<PaperResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<PaperFailure>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperIntakeStartResponse {
    pub job_id: String,
    pub source_digest: String,
    pub phase: PaperIntakePhase,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ExtractedPaperCache {
    schema_version: u32,
    source_digest: String,
    extractor_revision: String,
    extracted_via: String,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReconstructedPaperCache {
    schema_version: u32,
    source_digest: String,
    extracted_text_digest: String,
    reconstructor_revision: String,
    catalog_revision: String,
    response: PaperResponse,
}

#[derive(Debug, Serialize)]
pub struct NfcoreCatalogResponse {
    pub entries: Vec<NfcoreEntry>,
    pub cached: bool,
}

#[derive(Debug, Serialize)]
pub struct NfcoreEntry {
    pub operator: Operator,
    pub description: String,
    pub topics: Vec<String>,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct NfcoreSourceSearchResponse {
    pub query: String,
    pub provenance: String,
    pub cached: bool,
    pub total_matches: usize,
    pub entries: Vec<NfcoreSourceSearchEntry>,
}

#[derive(Debug, Serialize)]
pub struct NfcoreSourceSearchEntry {
    pub repository: String,
    pub title: String,
    pub description: String,
    pub topics: Vec<String>,
    pub revision: String,
}

#[derive(Debug, Deserialize)]
struct NfcoreSourceSearchQuery {
    q: String,
    #[serde(default = "default_nfcore_source_search_limit")]
    limit: usize,
}

fn default_nfcore_source_search_limit() -> usize {
    12
}

#[derive(Debug, Serialize)]
pub struct SnakemakeCatalogResponse {
    pub entries: Vec<SnakemakeEntry>,
    pub cached: bool,
}

#[derive(Debug, Serialize)]
pub struct SnakemakeEntry {
    pub operator: Operator,
    pub description: String,
    pub topics: Vec<String>,
    pub revision: String,
    pub stars: u64,
    pub expandable: bool,
}

#[derive(Debug, Deserialize)]
pub struct WorkflowGraphRequest {
    pub workflow: String,
    pub revision: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AgentNfcoreSourceImportRequest {
    workflow: String,
    revision: String,
    base_state_revision: String,
    idempotency_key: String,
    summary: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AgentSourceWorkflowEditRequest {
    base_state_revision: String,
    workflow_revision: String,
    idempotency_key: String,
    summary: String,
    edits: Vec<SemanticEdit>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AgentSourceWorkflowPromotionRequest {
    base_state_revision: String,
    workflow_revision: String,
    invocation_id: String,
    idempotency_key: String,
    summary: String,
}

#[derive(Debug, Deserialize)]
pub struct SourceWorkflowEditRequest {
    pub base_state_revision: String,
    pub workflow_revision: String,
    pub edits: Vec<SemanticEdit>,
}

#[derive(Debug, Deserialize)]
pub struct SourceWorkflowPromotionRequest {
    pub base_state_revision: String,
    pub workflow_revision: String,
    pub invocation_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SourceWorkflowRestoreRequest {
    pub base_state_revision: String,
}

#[derive(Debug, Serialize)]
pub struct SourceWorkflowEditResponse {
    pub state_revision: String,
    pub graph_revision: String,
    pub graph: Graph,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredNfcoreRequest {
    schema_version: u32,
    resolver_revision: String,
    #[serde(default)]
    indexer_revision: String,
    workflow: String,
    requested_revision: String,
    resolved_revision: String,
    source_digest: String,
    workflow_revision: String,
    instance_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredWorkflowInstanceRecord {
    schema_version: u32,
    #[serde(default)]
    indexer_revision: String,
    instance_digest: String,
    source_digest: String,
    workflow: SourceWorkflowInstance,
}

type StoredSourceFiles = Vec<(SourceFileManifest, Vec<u8>)>;
type SourceVerificationKey = (PathBuf, String, String);

#[derive(Debug, Clone, Deserialize)]
struct LegacyStoredSourceObjectRecord {
    schema_version: u32,
    manifest: SourceManifest,
    #[serde(default)]
    capabilities: SourceCapabilities,
}

#[derive(Debug, Clone, PartialEq)]
struct StoredSourceInstance {
    workflow: SourceWorkflowInstance,
    manifest: SourceManifest,
    files: StoredSourceFiles,
}

#[derive(Debug, Clone, PartialEq)]
struct StoredSourceInstanceMetadata {
    workflow: SourceWorkflowInstance,
    manifest: SourceManifest,
    source_root: PathBuf,
    metadata_fingerprint: String,
}

struct SourceTreeInspection {
    metadata_fingerprint: String,
    files: Option<StoredSourceFiles>,
    #[cfg(test)]
    metadata_operations: usize,
    #[cfg(test)]
    file_metadata_operations: usize,
}

#[derive(Clone, Copy)]
enum SourceTreeReadMode {
    MetadataOnly,
    Contents,
}

#[derive(Debug, Clone)]
struct SourceVerificationToken {
    metadata_fingerprint: String,
    derived_projection_digest: String,
    #[cfg(test)]
    cold_verification_sequence: u64,
}

static VERIFIED_SOURCE_OBJECTS: OnceLock<
    Mutex<BTreeMap<SourceVerificationKey, SourceVerificationToken>>,
> = OnceLock::new();
static SOURCE_VERIFICATION_GATES: OnceLock<Vec<Mutex<()>>> = OnceLock::new();
static VERIFIED_SOURCE_INSTANCES: OnceLock<Mutex<BTreeSet<(PathBuf, String)>>> = OnceLock::new();
#[cfg(test)]
static SOURCE_VERIFICATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
static SOURCE_COLD_VERIFICATIONS: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
static SOURCE_EXACT_CONTENT_READS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
pub struct LocalSnakemakeRequest {
    pub path: String,
    #[serde(default)]
    pub targets: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkflowGraphResponse {
    pub engine: String,
    pub workflow: String,
    pub revision: String,
    pub graph: Graph,
    pub cached: bool,
}

#[derive(Debug, Serialize)]
pub struct ToolReadiness {
    pub pixi: bool,
    pub sra: bool,
    pub datasets: bool,
    pub ensembl: bool,
    pub nextflow: bool,
    pub snakemake: bool,
}

#[derive(Debug)]
pub struct WebProject {
    root: PathBuf,
    graph_path: PathBuf,
    catalog: Catalog,
    pixi: Option<PathBuf>,
    runs: Mutex<BTreeMap<String, Arc<RunJob>>>,
    paper_intakes: Mutex<BTreeMap<String, Arc<PaperIntakeJob>>>,
    paper_execution: Arc<Semaphore>,
    upload_execution: Arc<Semaphore>,
    graph_lock: Mutex<()>,
    agent: agent::AgentBridge,
    mcp_capability: RuntimeCapability,
    transaction_replays: Mutex<BTreeMap<String, TransactionReplay>>,
    run_replays: Mutex<BTreeMap<String, RunReplay>>,
    paper_intake_replays: Mutex<BTreeMap<String, PaperIntakeReplay>>,
    replay_sequence: AtomicU64,
    sequence: AtomicU64,
    paper_limits: PaperLimits,
    upload_limits: GenericUploadLimits,
    paper_tools: PaperToolchainState,
    source_search_cache: Mutex<BTreeMap<String, (Instant, Vec<source_search::SearchResult>)>>,
    paper_search_cache: Mutex<BTreeMap<String, (Instant, Vec<literature::PaperSearchResult>)>>,
}

#[derive(Clone)]
struct RuntimeCapability(String);

impl std::fmt::Debug for RuntimeCapability {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RuntimeCapability([redacted])")
    }
}

impl RuntimeCapability {
    fn generate() -> Result<Self, ServerError> {
        if let Ok(value) = std::env::var("SOMITE_MCP_RUNTIME_CAPABILITY") {
            if value.len() >= 32
                && value.len() <= 256
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            {
                return Ok(Self(value));
            }
            return Err(ServerError::Agent(agent::AgentError::Config(
                "SOMITE_MCP_RUNTIME_CAPABILITY must contain 32 to 256 ASCII alphanumeric characters"
                    .to_owned(),
            )));
        }
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| {
            ServerError::Agent(agent::AgentError::Config(format!(
                "could not generate MCP runtime capability: {error}"
            )))
        })?;
        let value = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(Self(value))
    }

    fn authorizes(&self, authorization: Option<&str>) -> bool {
        let Some(supplied) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
            return false;
        };
        constant_time_equal(self.0.as_bytes(), supplied.as_bytes())
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

#[derive(Debug)]
struct RunJob {
    package: PathBuf,
    status: Mutex<RunStatusResponse>,
    pending_terminal: Mutex<Option<RunPhase>>,
    cancel: watch::Sender<bool>,
    validation: Option<ValidationContext>,
}

#[derive(Debug)]
struct PaperIntakeJob {
    status: Mutex<PaperIntakeStatusResponse>,
    cancel: Arc<AtomicBool>,
    cancelled: Notify,
    created_at: Instant,
}

#[derive(Debug, Clone)]
struct TransactionReplay {
    request_digest: String,
    result: TransactionResult,
    sequence: u64,
}

#[derive(Debug, Clone)]
struct RunReplay {
    request_digest: String,
    result: RunStartResponse,
    sequence: u64,
}

#[derive(Debug, Clone)]
struct PaperIntakeReplay {
    request_digest: String,
    result: PaperIntakeStartResponse,
    sequence: u64,
}

#[derive(Debug)]
struct ValidationContext {
    subject_digest: String,
    configuration_digest: String,
    fixture_pack: String,
    fixture_digests: Vec<String>,
    edge_nodes: BTreeMap<String, (String, String)>,
    evidence_dir: PathBuf,
}

impl WebProject {
    pub fn open(
        root: impl Into<PathBuf>,
        graph_path: impl Into<PathBuf>,
    ) -> Result<Self, ServerError> {
        let supplied_root = root.into();
        let root = supplied_root.canonicalize()?;
        let supplied_graph_path = graph_path.into();
        let candidate_graph_path = if supplied_graph_path.is_absolute() {
            supplied_graph_path
        } else {
            supplied_root.join(supplied_graph_path)
        };
        let graph_path = checked_existing_graph_path(&root, &candidate_graph_path)?;
        let catalog = Catalog::load_dir(&root.join("operators"))?;
        let server_url = local_server_url();
        let mcp_command = std::env::current_exe()?;
        let mcp_capability = RuntimeCapability::generate()?;
        let agent = agent::AgentBridge::new(
            root.clone(),
            server_url,
            mcp_command,
            mcp_capability.0.clone(),
        );
        let paper_tools = PaperToolchainState::detect(&root);
        let paper_limits = PaperLimits::from_environment();
        let paper_execution = Arc::new(Semaphore::new(paper_limits.max_active_executions));
        let upload_limits = GenericUploadLimits::from_environment();
        Ok(Self {
            root,
            graph_path,
            catalog,
            pixi: pixi_executable(),
            runs: Mutex::new(BTreeMap::new()),
            paper_intakes: Mutex::new(BTreeMap::new()),
            paper_execution,
            upload_execution: Arc::new(Semaphore::new(1)),
            graph_lock: Mutex::new(()),
            agent,
            mcp_capability,
            transaction_replays: Mutex::new(BTreeMap::new()),
            run_replays: Mutex::new(BTreeMap::new()),
            paper_intake_replays: Mutex::new(BTreeMap::new()),
            replay_sequence: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
            paper_limits,
            upload_limits,
            paper_tools,
            source_search_cache: Mutex::new(BTreeMap::new()),
            paper_search_cache: Mutex::new(BTreeMap::new()),
        })
    }

    #[doc(hidden)]
    pub fn mcp_runtime_capability(&self) -> &str {
        &self.mcp_capability.0
    }

    pub fn session(&self) -> Result<ProjectSession, ServerError> {
        // Read the Agent cursor before the graph. The graph snapshot is then
        // guaranteed to represent every transaction event through that cursor
        // (and may safely be newer if a transaction has committed but has not
        // recorded its event yet).
        let agent_cursor = self.agent.cursor();
        let _guard = self
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let recovery_path = self.autosave_path();
        let recovered = read_valid_graph(&self.root, &recovery_path, &self.catalog)?;
        let recovered_autosave = recovered.is_some();
        let mut graph = match recovered {
            Some(graph) => graph,
            None => {
                let raw = read_graph_file(&self.root, &self.graph_path)?;
                let mut graph: Graph = serde_json::from_slice(&raw)?;
                self.catalog.pin_graph(&mut graph)?;
                graph
            }
        };
        workflow::upgrade_reference_ports(&mut graph);
        graph.validate()?;
        reject_resolver_only_graph(&graph)?;
        self.catalog.verify_graph(&graph)?;
        verify_graph_source_store(&self.root, &graph)?;
        let operators = self
            .catalog
            .ops
            .values()
            .filter(|operator| !resolver_only_operator_id(&operator.id))
            .map(|operator| {
                Ok(CatalogOperator {
                    revision: operator.revision()?,
                    operator: operator.clone(),
                })
            })
            .collect::<Result<Vec<_>, somite_ops::OpsError>>()?;
        let state_revision = graph_state_revision(&graph)?;
        Ok(ProjectSession {
            project_name: self.project_name(),
            graph_path: display_path(&self.root, &self.graph_path),
            graph,
            state_revision,
            operators,
            recovered_autosave,
            agent_cursor,
        })
    }

    fn project_name(&self) -> String {
        self.root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Somite project")
            .to_owned()
    }

    fn workflow_name(&self, graph: &Graph) -> String {
        graph
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| self.project_name())
    }

    fn next_id(&self, prefix: &str) -> String {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{epoch:x}-{sequence:x}")
    }

    pub fn save_graph_cas(
        &self,
        base_state_revision: &str,
        graph: &Graph,
    ) -> Result<String, ServerError> {
        self.save_browser_graph_cas(base_state_revision, graph, true)
    }

    pub fn save_autosave_cas(
        &self,
        base_state_revision: &str,
        graph: &Graph,
    ) -> Result<String, ServerError> {
        self.save_browser_graph_cas(base_state_revision, graph, false)
    }

    fn save_browser_graph_cas(
        &self,
        base_state_revision: &str,
        graph: &Graph,
        save_project_graph: bool,
    ) -> Result<String, ServerError> {
        let _guard = self
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = current_agent_graph(self)?;
        let current_state_revision = graph_state_revision(&current)?;
        if base_state_revision != current_state_revision {
            return Err(ServerError::GraphStateConflict {
                provided: base_state_revision.to_owned(),
                current: current_state_revision,
            });
        }
        verify_graph_source_store(&self.root, graph)?;
        reject_resolver_only_graph(graph)?;
        if save_project_graph {
            self.save_graph_at(&self.graph_path, graph)?;
        }
        self.save_graph_at(&self.autosave_path(), graph)?;
        graph_state_revision(graph).map_err(ServerError::from)
    }

    fn autosave_path(&self) -> PathBuf {
        let default_graph = self.root.join(".somite/web.somite.json");
        if self.graph_path == default_graph {
            self.root.join(".somite/autosave.somite.json")
        } else {
            self.graph_path.with_extension("autosave.somite.json")
        }
    }

    fn save_graph_at(&self, path: &Path, graph: &Graph) -> Result<(), ServerError> {
        Self::write_graph_at(&self.root, path, graph, &self.catalog)
    }

    fn write_graph_at(
        root: &Path,
        path: &Path,
        graph: &Graph,
        catalog: &Catalog,
    ) -> Result<(), ServerError> {
        Self::write_graph_at_with_limit(root, path, graph, catalog, MAX_GRAPH_BYTES)
    }

    fn write_graph_at_with_limit(
        root: &Path,
        path: &Path,
        graph: &Graph,
        catalog: &Catalog,
        max_graph_bytes: u64,
    ) -> Result<(), ServerError> {
        graph.validate()?;
        catalog.verify_graph(graph)?;
        let encoded = serialize_graph_with_limit(graph, max_graph_bytes)?;
        let (parent, destination) = checked_graph_write_path(root, path)?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".somite-graph-")
            .tempfile_in(&parent)?;
        temporary.as_file_mut().write_all(&encoded)?;
        temporary.as_file_mut().flush()?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| ServerError::Io(error.error))?;
        #[cfg(unix)]
        std::fs::File::open(&parent)?.sync_all()?;
        Ok(())
    }

    fn papers_dir(&self) -> PathBuf {
        self.root.join(".somite/papers")
    }

    fn resolve_paper_artifact(
        &self,
        digest: &str,
        max_size_bytes: u64,
    ) -> Result<(StoredPaperArtifact, PathBuf), ServerError> {
        let hex = paper_digest_hex(digest)?;
        let objects = self.papers_dir().join("objects");
        let directory = objects.join(hex);
        let directory_metadata = std::fs::symlink_metadata(&directory)
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact object path must be a regular non-symlink directory".to_owned(),
            ));
        }
        let canonical_objects = objects
            .canonicalize()
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        let canonical_directory = directory
            .canonicalize()
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if canonical_directory.parent() != Some(canonical_objects.as_path()) {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact object path escapes the content-addressed store".to_owned(),
            ));
        }

        let metadata_path = directory.join("artifact.json");
        let metadata_file = std::fs::symlink_metadata(&metadata_path)
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if metadata_file.file_type().is_symlink() || !metadata_file.is_file() {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact metadata must be a regular non-symlink file".to_owned(),
            ));
        }
        let canonical_metadata = metadata_path
            .canonicalize()
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if canonical_metadata.parent() != Some(canonical_directory.as_path()) {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact metadata escapes its content-addressed object directory".to_owned(),
            ));
        }
        let metadata: StoredPaperArtifact = std::fs::read(&canonical_metadata)
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(ServerError::from))?;
        if metadata.schema_version != 1 || metadata.digest != digest {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact metadata does not match its content address".to_owned(),
            ));
        }
        if metadata.size_bytes > max_size_bytes {
            return Err(ServerError::PaperUploadTooLarge {
                limit_bytes: max_size_bytes,
            });
        }
        let payload = directory.join(format!("payload.{}", metadata.media_kind.extension()));
        let before_open = std::fs::symlink_metadata(&payload)
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if before_open.file_type().is_symlink() || !before_open.is_file() {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact payload must be a regular non-symlink file".to_owned(),
            ));
        }
        let canonical_payload = payload
            .canonicalize()
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if canonical_payload.parent() != Some(canonical_directory.as_path()) {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact payload escapes its content-addressed object directory".to_owned(),
            ));
        }

        let mut file = std::fs::File::open(&canonical_payload)
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        let opened = file
            .metadata()
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if !opened.is_file() || !same_file_identity(&before_open, &opened) {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact payload changed while it was being opened".to_owned(),
            ));
        }
        if opened.len() != metadata.size_bytes {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact size does not match its metadata".to_owned(),
            ));
        }

        let mut hasher = blake3::Hasher::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut size = 0_u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size = size.checked_add(count as u64).ok_or_else(|| {
                ServerError::InvalidPaperIntake(
                    "paper artifact size exceeds the supported range".to_owned(),
                )
            })?;
            hasher.update(&buffer[..count]);
        }
        if size != metadata.size_bytes {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact size changed while verifying its content address".to_owned(),
            ));
        }
        let verified_digest = format!("blake3:{}", hasher.finalize().to_hex());
        if verified_digest != digest {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact bytes do not match their content address".to_owned(),
            ));
        }

        let after_read = std::fs::symlink_metadata(&payload)
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        let final_payload = payload
            .canonicalize()
            .map_err(|_| ServerError::PaperArtifactNotFound(digest.to_owned()))?;
        if after_read.file_type().is_symlink()
            || !after_read.is_file()
            || !same_file_identity(&opened, &after_read)
            || final_payload != canonical_payload
        {
            return Err(ServerError::InvalidPaperIntake(
                "paper artifact payload changed while verifying its content address".to_owned(),
            ));
        }
        Ok((metadata, canonical_payload))
    }

    fn resolve_project_file(&self, relative: &str) -> Result<PathBuf, ServerError> {
        let supplied = Path::new(relative);
        if supplied.is_absolute() {
            return Err(ServerError::InvalidProjectPath(relative.to_owned()));
        }
        let root = self.root.canonicalize()?;
        let resolved = self
            .root
            .join(supplied)
            .canonicalize()
            .map_err(|_| ServerError::InvalidProjectPath(relative.to_owned()))?;
        if !resolved.starts_with(&root) || !resolved.is_file() {
            return Err(ServerError::InvalidProjectPath(relative.to_owned()));
        }
        Ok(resolved)
    }
}

#[cfg(unix)]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.len() == right.len()
        && left.file_type() == right.file_type()
        && left.modified().ok() == right.modified().ok()
}

fn paper_digest_hex(digest: &str) -> Result<&str, ServerError> {
    digest
        .strip_prefix("blake3:")
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            ServerError::InvalidPaperIntake(
                "digest must be an algorithm-prefixed BLAKE3 content identity".to_owned(),
            )
        })
}

fn local_server_url() -> String {
    if let Ok(url) = std::env::var("SOMITE_SERVER_URL") {
        return url;
    }
    let address = std::env::var("SOMITE_WEB_ADDR").unwrap_or_else(|_| "127.0.0.1:7310".to_owned());
    let address = address
        .strip_prefix("0.0.0.0:")
        .map(|port| format!("127.0.0.1:{port}"))
        .unwrap_or(address);
    format!("http://{address}")
}

fn read_valid_graph(
    root: &Path,
    path: &Path,
    catalog: &Catalog,
) -> Result<Option<Graph>, ServerError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ServerError::Io(error)),
    }
    let raw = read_graph_file(root, path)?;
    let Ok(mut graph) = serde_json::from_slice::<Graph>(&raw) else {
        return Ok(None);
    };
    if catalog.pin_graph(&mut graph).is_err() {
        return Ok(None);
    }
    Ok(Some(graph))
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

pub fn app(project: WebProject) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            HeaderValue::from_static("http://localhost:3000"),
            HeaderValue::from_static("http://127.0.0.1:3000"),
        ]))
        .allow_methods([Method::GET, Method::POST, Method::PUT])
        .allow_headers([header::CONTENT_TYPE]);
    let paper_body_limit = project
        .paper_limits
        .max_upload_bytes
        .saturating_add(PAPER_MULTIPART_OVERHEAD_BYTES)
        .min(usize::MAX as u64) as usize;
    let project = Arc::new(project);
    Router::new()
        .route("/api/health", get(health))
        .route("/api/session", get(session))
        .route("/api/system", get(system_profile))
        .route("/api/catalog/nfcore", get(discover_nfcore))
        .route("/api/catalog/nfcore/expand", post(expand_nfcore))
        .route("/api/source-workflows/nfcore/resolve", post(expand_nfcore))
        .route(
            "/api/source-workflows/nfcore/search",
            get(search_nfcore_sources),
        )
        .route("/api/source-workflows/edit", post(edit_source_workflow))
        .route(
            "/api/source-workflows/promote",
            post(promote_source_workflow),
        )
        .route(
            "/api/source-workflows/restore",
            post(restore_source_workflow_view),
        )
        .route("/api/catalog/snakemake", get(discover_snakemake))
        .route("/api/catalog/snakemake/expand", post(expand_snakemake))
        .route(
            "/api/workflows/snakemake/import",
            post(import_local_snakemake),
        )
        .route("/api/sources/search", get(search_sources))
        .route(
            "/api/paper/resources/resolve",
            post(resolve_paper_resources),
        )
        .route("/api/papers/search", get(search_papers))
        .route("/api/graph", put(save_graph))
        .route("/api/graph/autosave", put(autosave_graph))
        .route("/api/graph/validate", post(validate_graph))
        .route("/api/readiness", post(readiness_snapshot))
        .route("/api/runs", post(start_run))
        .route("/api/runs/{run_id}", get(run_status))
        .route("/api/runs/{run_id}/cancel", post(cancel_run))
        .route("/api/validations", post(start_validation))
        .route("/api/validations/status", post(validation_status))
        .route("/api/agent/graph", get(agent_graph))
        .route("/api/agent/catalog", get(agent_catalog))
        .route("/api/agent/transactions", post(agent_transaction))
        .route(
            "/api/agent/source-workflows/nfcore/resolve",
            post(agent_import_nfcore_source),
        )
        .route(
            "/api/agent/source-workflows/edit",
            post(agent_edit_source_workflow),
        )
        .route(
            "/api/agent/source-workflows/promote",
            post(agent_promote_source_workflow),
        )
        .route("/api/agent/compile", post(agent_compile))
        .route("/api/agent/evidence", get(agent_evidence))
        .route("/api/agent/discover", get(agent_discover))
        .route("/api/agent/connect", post(agent_connect))
        .route("/api/agent/config", post(agent_set_config))
        .route("/api/agent/prompt", post(agent_prompt))
        .route("/api/agent/events", get(agent_events))
        .route("/api/agent/transcript", get(agent_transcript))
        .route("/api/agent/cancel", post(agent_cancel))
        .route("/api/agent/disconnect", post(agent_disconnect))
        .route(
            "/api/agent/permissions/{permission_id}",
            post(agent_permission),
        )
        .route("/api/export/plan", post(export_plan))
        .route("/api/export", post(export_bundle))
        .route("/api/paper", post(rebuild_paper))
        .route(
            "/api/papers/uploads",
            post(upload_paper)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(paper_body_limit))
                .layer(RequestBodyLimitLayer::new(paper_body_limit)),
        )
        .route("/api/papers/intakes", post(start_paper_intake))
        .route("/api/papers/intakes/{job_id}", get(paper_intake_status))
        .route(
            "/api/papers/intakes/{job_id}/cancel",
            post(cancel_paper_intake),
        )
        .route(
            "/api/papers/biorxiv/reconstruct",
            post(rebuild_biorxiv_paper),
        )
        .route(
            "/api/files",
            post(upload_file).layer(DefaultBodyLimit::disable()),
        )
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(reject_cross_origin_mutation))
        .layer(middleware::from_fn_with_state(
            project.clone(),
            record_mcp_activity,
        ))
        .with_state(project)
}

async fn reject_cross_origin_mutation(request: Request, next: Next) -> Response {
    let mutating = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::DELETE | Method::PATCH
    );
    if mutating && !request_origin_is_allowed(&request) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "cross-origin mutation of the local Somite project is forbidden".to_owned(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

fn request_origin_is_allowed(request: &Request) -> bool {
    let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        // Hyper supplies Host/:authority for real HTTP requests. Most in-module
        // Router::oneshot tests use deliberately incomplete relative requests;
        // keep only those originless fixtures working under cfg(test).
        return cfg!(test) && request.headers().get(header::ORIGIN).is_none();
    };
    if !loopback_authority(host) {
        return false;
    }
    let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        // Native clients must opt into a non-CORS-safelisted header. The MCP
        // bridge already supplies its bearer capability. A browser cannot add
        // either header through a hostile simple form, and its preflight is
        // rejected by the CORS policy.
        return request
            .headers()
            .get("x-somite-request")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == "local")
            || request
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("Bearer "));
    };
    if matches!(origin, "http://localhost:3000" | "http://127.0.0.1:3000") {
        return true;
    }
    let Some(authority) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .filter(|authority| !authority.is_empty() && !authority.contains('/'))
    else {
        return false;
    };
    authority.eq_ignore_ascii_case(host)
}

fn loopback_authority(value: &str) -> bool {
    let Ok(authority) = value.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    let host = authority.host();
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

async fn agent_discover() -> Json<agent_discovery::AgentDiscoveryResponse> {
    Json(agent_discovery::discover_agents().await)
}

async fn record_mcp_activity(
    State(project): State<Arc<WebProject>>,
    request: Request,
    next: Next,
) -> Response {
    let mcp_runtime_route = matches!(
        request.uri().path(),
        "/api/agent/graph"
            | "/api/agent/catalog"
            | "/api/agent/transactions"
            | "/api/agent/source-workflows/nfcore/resolve"
            | "/api/agent/source-workflows/edit"
            | "/api/agent/source-workflows/promote"
            | "/api/agent/compile"
            | "/api/agent/evidence"
    );
    let tool = request
        .headers()
        .get("x-somite-mcp-tool")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("somite."))
        .map(str::to_owned);
    let detail = format!("{} {}", request.method(), request.uri().path());
    if (tool.is_some() || mcp_runtime_route)
        && !project.mcp_capability.authorizes(
            request
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
        )
    {
        if let Some(tool) = tool {
            project.agent.record_tool_activity(
                tool,
                format!("{detail} → 401 Unauthorized"),
                "failed".to_owned(),
            );
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "unauthorized MCP runtime hop".to_owned(),
            }),
        )
            .into_response();
    }
    if let Some(tool) = &tool {
        project
            .agent
            .record_tool_activity(tool.clone(), detail.clone(), "running".to_owned());
    }
    let response = next.run(request).await;
    if let Some(tool) = tool {
        let status = if response.status().is_success() {
            "completed"
        } else {
            "failed"
        };
        project.agent.record_tool_activity(
            tool,
            format!("{detail} → {}", response.status()),
            status.to_owned(),
        );
    }
    response
}

async fn health() -> &'static str {
    "ok"
}

async fn run_server_blocking<T, F>(label: &'static str, operation: F) -> Result<T, ServerError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ServerError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| ServerError::SourceWorkflow(format!("{label} task failed: {error}")))?
}

async fn session(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<ProjectSession>, ServerError> {
    Ok(Json(
        run_server_blocking("project session", move || project.session()).await?,
    ))
}

async fn system_profile(State(project): State<Arc<WebProject>>) -> Json<SystemProfile> {
    Json(detect_system_profile(&project.paper_tools))
}

#[derive(Debug, Deserialize)]
struct SourceSearchQuery {
    q: String,
    provider: String,
}

async fn search_sources(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<SourceSearchQuery>,
) -> Result<Json<source_search::SearchResponse>, ServerError> {
    let query = request.q.trim();
    if !valid_source_query(query, &request.provider) {
        return Err(ServerError::InvalidSourceRequest(
            "invalid query".to_owned(),
        ));
    }
    let results = cached_source_results(&project, query, &request.provider).await?;
    Ok(Json(source_search::SearchResponse {
        query: query.to_owned(),
        provider: request.provider,
        results,
    }))
}

fn valid_source_query(query: &str, provider: &str) -> bool {
    (2..=120).contains(&query.len())
        && !query.chars().any(char::is_control)
        && matches!(provider, "ncbi" | "ensembl")
}

async fn cached_source_results(
    project: &Arc<WebProject>,
    query: &str,
    provider: &str,
) -> Result<Vec<source_search::SearchResult>, ServerError> {
    let key = format!("{}:{}", provider, query.to_ascii_lowercase());
    if let Some((_, results)) = project
        .source_search_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .filter(|(created, _)| created.elapsed() < Duration::from_secs(600))
        .cloned()
    {
        return Ok(results);
    }
    let worker_provider = provider.to_owned();
    let worker_query = query.to_owned();
    let results = tokio::task::spawn_blocking(move || match worker_provider.as_str() {
        "ncbi" => source_search::search_ncbi(&worker_query),
        "ensembl" => source_search::search_ensembl(&worker_query),
        _ => Vec::new(),
    })
    .await
    .map_err(|error| ServerError::SourceSearch(error.to_string()))?;
    project
        .source_search_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, (Instant::now(), results.clone()));
    Ok(results)
}

async fn resolve_paper_resources(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<PaperResourceResolveRequest>,
) -> Result<Json<PaperResourceResolution>, ServerError> {
    if request.resources.len() > 32
        || request
            .resources
            .iter()
            .any(|resource| !valid_paper_resource(resource))
    {
        return Err(ServerError::InvalidSourceRequest(
            "invalid paper resource request".to_owned(),
        ));
    }
    let mut groups = Vec::with_capacity(request.resources.len());
    for citation in request.resources {
        let provider = if citation.kind == "ensembl" {
            "ensembl"
        } else {
            "ncbi"
        };
        let query = match (citation.role.as_str(), citation.kind.as_str()) {
            ("reads", _) => Some(format!("{} sra", citation.accession)),
            ("sample_metadata", "sra_sample" | "biosample")
            | (
                "unknown",
                "sra_study" | "sra_sample" | "sra_experiment" | "sra_run" | "bioproject",
            ) => Some(format!("{} sra", citation.accession)),
            ("reference", "assembly") => Some(format!("{} reference genome", citation.accession)),
            ("annotation", "ensembl") | ("reference", "ensembl") => {
                Some(citation.accession.clone())
            }
            _ => None,
        };
        let mut results = match query {
            Some(query) => cached_source_results(&project, &query, provider).await?,
            None => Vec::new(),
        };
        results.retain(|result| match citation.role.as_str() {
            "reads" => result.data_kind == "Reads",
            "reference" => result.data_kind == "Reference",
            _ => true,
        });
        groups.push(PaperResourceGroup {
            citation,
            provider: provider.to_owned(),
            status: if results.is_empty() {
                "unavailable".to_owned()
            } else {
                "available".to_owned()
            },
            results,
        });
    }
    Ok(Json(PaperResourceResolution { groups }))
}

fn valid_paper_resource(resource: &PaperResourceCitation) -> bool {
    if resource.context.len() > 1_000
        || resource
            .source_location
            .as_ref()
            .is_some_and(|value| value.len() > 80)
        || !matches!(
            resource.role.as_str(),
            "reads" | "reference" | "annotation" | "sample_metadata" | "unknown"
        )
    {
        return false;
    }
    resource_citations(&resource.accession)
        .into_iter()
        .any(|citation| {
            citation.accession == resource.accession
                && paper_resource_kind_label(citation.kind) == resource.kind
        })
}

#[derive(Debug, Deserialize)]
struct PaperSearchQuery {
    q: String,
}

async fn search_papers(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<PaperSearchQuery>,
) -> Result<Json<literature::PaperSearchResponse>, ServerError> {
    let query = request.q.trim();
    let key = query.to_ascii_lowercase();
    if let Some((_, results)) = project
        .paper_search_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .filter(|(created, _)| created.elapsed() < Duration::from_secs(600))
        .cloned()
    {
        return Ok(Json(literature::PaperSearchResponse {
            query: query.to_owned(),
            results,
        }));
    }

    let owned_query = query.to_owned();
    let worker_query = owned_query.clone();
    let results = tokio::task::spawn_blocking(move || literature::search_biorxiv(&worker_query))
        .await
        .map_err(|error| ServerError::Paper(error.to_string()))??;
    project
        .paper_search_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, (Instant::now(), results.clone()));
    Ok(Json(literature::PaperSearchResponse {
        query: owned_query,
        results,
    }))
}

async fn discover_nfcore(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<NfcoreCatalogResponse>, ServerError> {
    let root = project.root.clone();
    let response = tokio::task::spawn_blocking(move || {
        let (pipelines, cached) = load_current_nfcore_catalog(&root)?;
        Ok::<_, ServerError>(NfcoreCatalogResponse {
            entries: pipelines
                .into_iter()
                .map(|pipeline| NfcoreEntry {
                    operator: pipeline.operator(),
                    description: pipeline.description,
                    topics: pipeline.topics,
                    revision: pipeline.revision,
                })
                .collect(),
            cached,
        })
    })
    .await
    .map_err(|error| ServerError::CatalogDiscovery(error.to_string()))??;
    Ok(Json(response))
}

fn load_current_nfcore_catalog(root: &Path) -> Result<(Vec<nfcore::Pipeline>, bool), ServerError> {
    let cache_path = checked_nfcore_catalog_cache_path(root, true)?.ok_or_else(|| {
        ServerError::CatalogDiscovery("could not initialize nf-core catalog cache".to_owned())
    })?;
    match nfcore::fetch() {
        Ok((raw, pipelines)) => {
            write_catalog_cache_atomic(&cache_path, raw.as_bytes())?;
            Ok((pipelines, false))
        }
        Err(fetch_error) => {
            let raw = String::from_utf8(
                read_regular_file(&cache_path, MAX_NFCORE_CATALOG_BYTES)
                    .map_err(|_| ServerError::CatalogDiscovery(fetch_error.clone()))?,
            )
            .map_err(|_| {
                ServerError::CatalogDiscovery("nf-core catalog cache is not valid UTF-8".to_owned())
            })?;
            let pipelines = nfcore::parse(&raw).map_err(ServerError::CatalogDiscovery)?;
            Ok((pipelines, true))
        }
    }
}

fn checked_nfcore_catalog_cache_path(
    root: &Path,
    create: bool,
) -> Result<Option<PathBuf>, ServerError> {
    let canonical_root = root.canonicalize().map_err(|error| {
        ServerError::CatalogDiscovery(format!("could not resolve project root: {error}"))
    })?;
    let somite = canonical_root.join(".somite");
    if !ensure_or_find_store_directory(&somite, &canonical_root, ".somite", create)? {
        return Ok(None);
    }
    let canonical_somite = somite.canonicalize()?;
    let catalog = somite.join("catalog");
    if !ensure_or_find_store_directory(&catalog, &canonical_somite, ".somite/catalog", create)? {
        return Ok(None);
    }
    let cache = catalog.join("nfcore-pipelines.json");
    match std::fs::symlink_metadata(&cache) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(ServerError::CatalogDiscovery(
                "nf-core catalog cache must be a regular non-symlink file".to_owned(),
            ))
        }
        Ok(_) => Ok(Some(cache)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => Ok(Some(cache)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ServerError::Io(error)),
    }
}

fn write_catalog_cache_atomic(path: &Path, contents: &[u8]) -> Result<(), ServerError> {
    let parent = path.parent().ok_or_else(|| {
        ServerError::CatalogDiscovery("nf-core catalog cache has no parent".to_owned())
    })?;
    validate_store_directory(
        parent,
        &parent
            .parent()
            .ok_or_else(|| {
                ServerError::CatalogDiscovery("nf-core catalog directory has no parent".to_owned())
            })?
            .canonicalize()?,
        ".somite/catalog",
    )?;
    if path_entry_exists(path)? {
        read_regular_file(path, MAX_NFCORE_CATALOG_BYTES)?;
    }
    let temporary = tempfile::Builder::new()
        .prefix(".nfcore-catalog-")
        .tempfile_in(parent)?;
    std::fs::write(temporary.path(), contents)?;
    std::fs::rename(temporary.path(), path)?;
    Ok(())
}

async fn search_nfcore_sources(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<NfcoreSourceSearchQuery>,
) -> Result<Json<NfcoreSourceSearchResponse>, ServerError> {
    let query = request.q.trim();
    if query.is_empty() || query.len() > 120 || query.chars().any(char::is_control) {
        return Err(ServerError::InvalidSourceRequest(
            "nf-core query must contain 1 to 120 printable bytes".to_owned(),
        ));
    }
    let query = query.to_owned();
    let limit = request.limit.clamp(1, 50);
    let root = project.root.clone();
    let response = tokio::task::spawn_blocking(move || {
        let (pipelines, cached) = load_current_nfcore_catalog(&root)?;
        Ok::<_, ServerError>(filter_nfcore_source_catalog(
            &query, limit, pipelines, cached,
        ))
    })
    .await
    .map_err(|error| ServerError::CatalogDiscovery(error.to_string()))??;
    Ok(Json(response))
}

fn filter_nfcore_source_catalog(
    query: &str,
    limit: usize,
    pipelines: Vec<nfcore::Pipeline>,
    cached: bool,
) -> NfcoreSourceSearchResponse {
    let terms = query
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let mut matches = pipelines
        .into_iter()
        .filter(|pipeline| {
            let haystack = format!(
                "{} {} {}",
                pipeline.name,
                pipeline.description,
                pipeline.topics.join(" ")
            )
            .to_ascii_lowercase();
            terms.iter().all(|term| haystack.contains(term))
        })
        .map(|pipeline| NfcoreSourceSearchEntry {
            repository: format!("nf-core/{}", pipeline.name),
            title: format!("nf-core/{}", pipeline.name),
            description: pipeline.description,
            topics: pipeline.topics,
            revision: pipeline.revision,
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| left.repository.cmp(&right.repository));
    let total_matches = matches.len();
    matches.truncate(limit);
    NfcoreSourceSearchResponse {
        query: query.to_owned(),
        provenance: nfcore::CATALOG_URL.to_owned(),
        cached,
        total_matches,
        entries: matches,
    }
}

async fn discover_snakemake(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<SnakemakeCatalogResponse>, ServerError> {
    let cache_path = project
        .root
        .join(".somite/catalog/snakemake-workflows.json");
    let response = tokio::task::spawn_blocking(move || {
        let (workflows, cached) = match snakemake::fetch() {
            Ok(workflows) => {
                if let Some(parent) = cache_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&cache_path, serde_json::to_vec(&workflows)?)?;
                (workflows, false)
            }
            Err(fetch_error) => {
                let raw = std::fs::read_to_string(&cache_path)
                    .map_err(|_| ServerError::CatalogDiscovery(fetch_error))?;
                let workflows =
                    snakemake::parse_compact(&raw).map_err(ServerError::CatalogDiscovery)?;
                (workflows, true)
            }
        };
        Ok::<_, ServerError>(SnakemakeCatalogResponse {
            entries: workflows
                .into_iter()
                .map(|workflow| SnakemakeEntry {
                    operator: workflow.operator(),
                    description: workflow.description,
                    topics: workflow.topics,
                    revision: workflow.revision,
                    stars: workflow.stars,
                    expandable: workflow.rulegraph.is_some(),
                })
                .collect(),
            cached,
        })
    })
    .await
    .map_err(|error| ServerError::CatalogDiscovery(error.to_string()))??;
    Ok(Json(response))
}

async fn expand_snakemake(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<WorkflowGraphRequest>,
) -> Result<Json<WorkflowGraphResponse>, ServerError> {
    if request.workflow.split('/').count() != 2
        || request.workflow.chars().any(|character| {
            !character.is_ascii_alphanumeric() && !matches!(character, '/' | '.' | '-' | '_')
        })
        || request.revision.is_empty()
    {
        return Err(ServerError::WorkflowImport(
            "invalid Snakemake workflow or revision".to_owned(),
        ));
    }
    let cache_path = project
        .root
        .join(".somite/catalog/snakemake-workflows.json");
    let reference_operator_revision = project.catalog.revision("workflow.reference")?;
    let response = tokio::task::spawn_blocking(move || {
        let raw = std::fs::read_to_string(cache_path).map_err(|_| {
            ServerError::WorkflowImport("Snakemake catalog cache is not ready".to_owned())
        })?;
        let workflows = snakemake::parse_compact(&raw).map_err(ServerError::WorkflowImport)?;
        let workflow_entry = workflows
            .into_iter()
            .find(|entry| entry.full_name == request.workflow && entry.revision == request.revision)
            .ok_or_else(|| ServerError::WorkflowImport("workflow release is not in the current catalog".to_owned()))?;
        let dot = workflow_entry.rulegraph.ok_or_else(|| {
            ServerError::WorkflowImport(
                "the official catalog could not resolve this workflow's rule graph; Somite will not insert an opaque replacement".to_owned(),
            )
        })?;
        let graph = workflow::graph_from_dot(
            workflow::DotFlavor::Snakemake,
            &request.workflow,
            &request.revision,
            &reference_operator_revision,
            &dot,
        )
        .map_err(ServerError::WorkflowImport)?;
        Ok::<_, ServerError>(WorkflowGraphResponse {
            engine: "snakemake".to_owned(),
            workflow: request.workflow,
            revision: request.revision,
            graph,
            cached: true,
        })
    })
    .await
    .map_err(|error| ServerError::WorkflowImport(error.to_string()))??;
    Ok(Json(response))
}

async fn import_local_snakemake(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<LocalSnakemakeRequest>,
) -> Result<Json<WorkflowGraphResponse>, ServerError> {
    let path = PathBuf::from(request.path.trim());
    let targets = request.targets;
    let pixi = project.pixi.clone();
    let reference_operator_revision = project.catalog.revision("workflow.reference")?;
    let response = tokio::task::spawn_blocking(move || {
        let imported = snakemake_local::import(
            &path,
            &targets,
            pixi.as_deref(),
            &reference_operator_revision,
        )
        .map_err(|error| ServerError::WorkflowImport(error.to_string()))?;
        Ok::<_, ServerError>(WorkflowGraphResponse {
            engine: "snakemake".to_owned(),
            workflow: imported.project.display().to_string(),
            revision: imported.revision,
            graph: imported.graph,
            cached: false,
        })
    })
    .await
    .map_err(|error| ServerError::WorkflowImport(error.to_string()))??;
    Ok(Json(response))
}

async fn expand_nfcore(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<WorkflowGraphRequest>,
) -> Result<Json<WorkflowGraphResponse>, ServerError> {
    validate_nfcore_workflow_request(&request)?;
    let root = project.root.clone();
    let source_operator_revision = project.catalog.revision("workflow.source")?;
    let response = tokio::task::spawn_blocking(move || {
        import_nfcore_source(&root, &request, &source_operator_revision, None)
    })
    .await
    .map_err(|error| ServerError::WorkflowImport(error.to_string()))??;
    Ok(Json(response))
}

fn validate_nfcore_workflow_request(request: &WorkflowGraphRequest) -> Result<(), ServerError> {
    if !request.workflow.starts_with("nf-core/")
        || request.workflow.len() == "nf-core/".len()
        || request.workflow["nf-core/".len()..]
            .chars()
            .any(|character| !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_'))
        || request.revision.is_empty()
        || request.revision.chars().any(|character| {
            !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '_')
        })
    {
        return Err(ServerError::WorkflowImport(
            "invalid nf-core workflow or revision".to_owned(),
        ));
    }
    Ok(())
}

fn import_nfcore_source(
    root: &Path,
    request: &WorkflowGraphRequest,
    source_operator_revision: &str,
    repository_override: Option<&Path>,
) -> Result<WorkflowGraphResponse, ServerError> {
    require_current_nfcore_release(root, request)?;
    let request_key = nfcore_source_request_key(request);
    if let Some(workflow) = read_cached_nfcore_source(root, request, &request_key)? {
        return source_workflow_response(request, source_operator_revision, workflow, true);
    }

    let fetched = fetch_nfcore_git_source(root, request, repository_override)?;
    let reindexed =
        somite_source_workflow::reindex_frozen(&fetched.manifest, &fetched.files, "main.nf")
            .map_err(|error| {
                ServerError::WorkflowImport(format!(
                    "{}@{} source could not be indexed: {error}",
                    request.workflow, request.revision
                ))
            })?;
    let file_count = u32::try_from(fetched.manifest.files.len()).map_err(|_| {
        ServerError::WorkflowImport("nf-core tracked file count exceeds u32".to_owned())
    })?;
    let mut workflow = SourceWorkflowInstance {
        schema_version: 1,
        workflow_revision: String::new(),
        source: WorkflowSourcePin {
            provider: WorkflowSourceProvider::NfCore,
            repository: format!("https://github.com/{}", request.workflow),
            requested_revision: request.revision.clone(),
            resolved_revision: fetched.resolved_revision,
            source_digest: fetched.manifest.source_digest.clone(),
            entrypoint: "main.nf".to_owned(),
            file_count,
            source_bytes: fetched.manifest.source_bytes,
        },
        profiles: Vec::new(),
        parameters: reindexed.parameters,
        unsupported_required_parameters: reindexed.unsupported_required_parameters,
        bindings: BTreeMap::new(),
        scopes: reindexed.scopes,
        invocations: reindexed.invocations,
        replacements: Vec::new(),
        capabilities: reindexed.capabilities,
        diagnostics: reindexed.diagnostics,
    };
    workflow.workflow_revision = calculate_source_workflow_revision(&workflow)
        .map_err(|error| ServerError::WorkflowImport(error.to_string()))?;
    let files = pair_frozen_source_files(fetched.files, &fetched.manifest)?;
    let stored = StoredSourceInstance {
        workflow,
        manifest: fetched.manifest,
        files,
    };
    publish_nfcore_source_import(
        root,
        request,
        source_operator_revision,
        &request_key,
        stored,
        MAX_GRAPH_BYTES,
    )
}

fn publish_nfcore_source_import(
    root: &Path,
    request: &WorkflowGraphRequest,
    source_operator_revision: &str,
    request_key: &str,
    stored: StoredSourceInstance,
    max_graph_bytes: u64,
) -> Result<WorkflowGraphResponse, ServerError> {
    let response = source_workflow_response_with_limit(
        request,
        source_operator_revision,
        stored.workflow.clone(),
        false,
        max_graph_bytes,
    )?;
    let prepared_request =
        prepare_nfcore_request(request, &stored.workflow, MAX_SOURCE_RECORD_BYTES)?;
    persist_source_instance(root, &stored)?;
    verify_stored_source_instance_cached(root, &stored.workflow).map_err(|error| {
        ServerError::WorkflowImport(format!(
            "{}@{} stored source could not be reindexed exactly: {error}",
            request.workflow, request.revision
        ))
    })?;
    persist_prepared_nfcore_request(root, request_key, prepared_request)?;
    Ok(response)
}

fn require_current_nfcore_release(
    root: &Path,
    request: &WorkflowGraphRequest,
) -> Result<(), ServerError> {
    let cache_path = checked_nfcore_catalog_cache_path(root, false)?.ok_or_else(|| {
        ServerError::WorkflowImport(
            "nf-core catalog cache is not ready; refresh the catalog before importing".to_owned(),
        )
    })?;
    let raw = String::from_utf8(read_regular_file(&cache_path, MAX_NFCORE_CATALOG_BYTES)?)
        .map_err(|_| {
            ServerError::WorkflowImport("nf-core catalog cache is not valid UTF-8".to_owned())
        })?;
    let pipelines = nfcore::parse(&raw).map_err(ServerError::WorkflowImport)?;
    let name = request.workflow.trim_start_matches("nf-core/");
    if pipelines
        .iter()
        .any(|pipeline| pipeline.name == name && pipeline.revision == request.revision)
    {
        Ok(())
    } else {
        Err(ServerError::WorkflowImport(
            "workflow release is not in the current nf-core catalog".to_owned(),
        ))
    }
}

fn nfcore_source_request_key(request: &WorkflowGraphRequest) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-nfcore-source-request-v3\0");
    hasher.update(NFCORE_SOURCE_RESOLVER_REVISION.as_bytes());
    hasher.update(b"\0");
    hasher.update(SOURCE_INDEXER_REVISION.as_bytes());
    hasher.update(b"\0");
    hasher.update(request.workflow.as_bytes());
    hasher.update(b"\0");
    hasher.update(request.revision.as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn read_cached_nfcore_source(
    root: &Path,
    request: &WorkflowGraphRequest,
    request_key: &str,
) -> Result<Option<SourceWorkflowInstance>, ServerError> {
    let Some(requests) = checked_source_store_subdir(root, "requests", false)? else {
        return Ok(None);
    };
    let path = requests.join(format!("{request_key}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let record: StoredNfcoreRequest =
        serde_json::from_slice(&read_regular_file(&path, MAX_SOURCE_RECORD_BYTES)?)?;
    if record.schema_version != 2
        || record.resolver_revision != NFCORE_SOURCE_RESOLVER_REVISION
        || record.indexer_revision != SOURCE_INDEXER_REVISION
        || record.workflow != request.workflow
        || record.requested_revision != request.revision
    {
        return Err(ServerError::SourceWorkflow(format!(
            "cached nf-core request {}@{} does not match its immutable request key",
            request.workflow, request.revision
        )));
    }
    let stored = read_stored_source_instance_record(root, &record.instance_digest)?;
    let source = &stored.workflow.source;
    if stored.workflow.workflow_revision != record.workflow_revision
        || source.provider != WorkflowSourceProvider::NfCore
        || source.repository != format!("https://github.com/{}", request.workflow)
        || source.requested_revision != request.revision
        || source.resolved_revision != record.resolved_revision
        || source.source_digest != record.source_digest
    {
        return Err(ServerError::SourceWorkflow(format!(
            "cached nf-core source {}@{} does not match its stored source identity",
            request.workflow, request.revision
        )));
    }
    verify_stored_source_instance_cached(root, &stored.workflow)?;
    Ok(Some(stored.workflow))
}

struct FetchedNfcoreSource {
    resolved_revision: String,
    manifest: SourceManifest,
    files: Vec<FrozenSourceFile>,
}

struct NfcoreGitIsolation {
    home: PathBuf,
    xdg_config: PathBuf,
    global_config: PathBuf,
    hooks: PathBuf,
    templates: PathBuf,
    allow_local_repository: bool,
}

impl NfcoreGitIsolation {
    fn new(root: &Path, allow_local_repository: bool) -> Result<Self, ServerError> {
        let home = root.join("git-home");
        let xdg_config = root.join("git-xdg-config");
        let hooks = root.join("git-hooks-disabled");
        let templates = root.join("git-templates-empty");
        for directory in [&home, &xdg_config, &hooks, &templates] {
            std::fs::create_dir(directory)?;
        }
        let global_config = root.join("git-global-config-empty");
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&global_config)?
            .sync_all()?;
        Ok(Self {
            home,
            xdg_config,
            global_config,
            hooks,
            templates,
            allow_local_repository,
        })
    }

    fn apply(&self, command: &mut Command) {
        for variable in [
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_ALLOW_PROTOCOL",
            "GIT_ASKPASS",
            "GIT_ATTR_NOSYSTEM",
            "GIT_CEILING_DIRECTORIES",
            "GIT_COMMON_DIR",
            "GIT_CONFIG",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_SYSTEM",
            "GIT_DIR",
            "GIT_EXEC_PATH",
            "GIT_INDEX_FILE",
            "GIT_NAMESPACE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_PROTOCOL",
            "GIT_PROTOCOL_FROM_USER",
            "GIT_PROXY_COMMAND",
            "GIT_SSL_NO_VERIFY",
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "GIT_TEMPLATE_DIR",
            "GIT_WORK_TREE",
            "SSH_ASKPASS",
            "XDG_CONFIG_HOME",
        ] {
            command.env_remove(variable);
        }
        command
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", &self.xdg_config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &self.global_config)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "/bin/false")
            .env("SSH_ASKPASS", "/bin/false")
            .env("GIT_CONFIG_COUNT", "6")
            .env("GIT_CONFIG_KEY_0", "core.hooksPath")
            .env("GIT_CONFIG_VALUE_0", &self.hooks)
            .env("GIT_CONFIG_KEY_1", "init.templateDir")
            .env("GIT_CONFIG_VALUE_1", &self.templates)
            .env("GIT_CONFIG_KEY_2", "protocol.ext.allow")
            .env("GIT_CONFIG_VALUE_2", "never")
            .env("GIT_CONFIG_KEY_3", "protocol.file.allow")
            .env(
                "GIT_CONFIG_VALUE_3",
                if self.allow_local_repository {
                    "user"
                } else {
                    "never"
                },
            )
            .env("GIT_CONFIG_KEY_4", "credential.interactive")
            .env("GIT_CONFIG_VALUE_4", "never")
            .env("GIT_CONFIG_KEY_5", "core.fsmonitor")
            .env("GIT_CONFIG_VALUE_5", "false");
    }
}

fn fetch_nfcore_git_source(
    root: &Path,
    request: &WorkflowGraphRequest,
    repository_override: Option<&Path>,
) -> Result<FetchedNfcoreSource, ServerError> {
    let store = checked_source_workflow_store(root, true)?.ok_or_else(|| {
        ServerError::SourceWorkflow("could not initialize source workflow store".to_owned())
    })?;
    let temporary = tempfile::Builder::new()
        .prefix(".nfcore-fetch-")
        .tempdir_in(&store)?;
    let git_isolation = NfcoreGitIsolation::new(temporary.path(), repository_override.is_some())?;
    let bare = temporary.path().join("repository.git");
    run_nfcore_git(
        Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .arg(&bare),
        &git_isolation,
        "initialize an isolated nf-core repository",
    )?;
    let repository = repository_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(format!("https://github.com/{}.git", request.workflow)));
    run_nfcore_git(
        Command::new("git")
            .arg("--git-dir")
            .arg(&bare)
            .args(["remote", "add", "origin"])
            .arg(&repository),
        &git_isolation,
        "configure the catalog-advertised nf-core repository",
    )?;
    run_nfcore_git(
        Command::new("git").arg("--git-dir").arg(&bare).args([
            "fetch",
            "--quiet",
            "--no-tags",
            "--depth=1",
            "origin",
            &format!("refs/tags/{}", request.revision),
        ]),
        &git_isolation,
        &format!(
            "fetch catalog release {}@{}",
            request.workflow, request.revision
        ),
    )?;
    let resolved_revision = git_stdout(
        Command::new("git").arg("--git-dir").arg(&bare).args([
            "rev-parse",
            "--verify",
            "FETCH_HEAD^{commit}",
        ]),
        &git_isolation,
        "resolve the fetched nf-core tag",
    )?
    .trim()
    .to_ascii_lowercase();
    if resolved_revision.len() != 40
        || !resolved_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ServerError::WorkflowImport(
            "Git did not resolve the nf-core tag to a full 40-character commit".to_owned(),
        ));
    }

    let tree = run_nfcore_git(
        Command::new("git")
            .arg("--git-dir")
            .arg(&bare)
            .args(["ls-tree", "-l", "-r", "-z", "--full-tree"])
            .arg(&resolved_revision),
        &git_isolation,
        "enumerate exact tracked nf-core source files",
    )?;
    let mut entrypoint_found = false;
    let mut paths = BTreeSet::new();
    let mut portable_paths = PortableSourcePathRegistry::default();
    let mut source_bytes = 0_u64;
    let mut files = Vec::new();
    for raw_entry in tree
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let entry = std::str::from_utf8(raw_entry).map_err(|_| {
            ServerError::WorkflowImport(
                "nf-core source tree contains a non-UTF-8 tracked path".to_owned(),
            )
        })?;
        let (header, path) = entry.split_once('\t').ok_or_else(|| {
            ServerError::WorkflowImport("Git returned a malformed source tree entry".to_owned())
        })?;
        let fields = header.split_whitespace().collect::<Vec<_>>();
        let [mode, kind, object, size] = fields.as_slice() else {
            return Err(ServerError::WorkflowImport(
                "Git returned a malformed source tree identity".to_owned(),
            ));
        };
        if *kind != "blob" || !matches!(*mode, "100644" | "100755") {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core source contains unsupported tracked entry {path} ({mode} {kind})"
            )));
        }
        if object.len() != 40 || !object.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ServerError::WorkflowImport(format!(
                "Git returned an invalid SHA-1 object identity for {path}"
            )));
        }
        if !safe_source_relative_path(path)
            || reserved_git_metadata_path(path)
            || !paths.insert(path.to_owned())
        {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core source contains unsafe or duplicate tracked path {path}"
            )));
        }
        portable_paths.insert(path).map_err(|collision| {
            ServerError::WorkflowImport(format!("nf-core source {collision}"))
        })?;
        if paths.len() > MAX_NFCORE_TRACKED_FILES {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core source exceeds {MAX_NFCORE_TRACKED_FILES} tracked files"
            )));
        }
        let size = size.parse::<u64>().map_err(|_| {
            ServerError::WorkflowImport(format!(
                "Git returned an invalid tracked byte count for {path}"
            ))
        })?;
        if size > MAX_NFCORE_TRACKED_FILE_BYTES {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core tracked file {path} exceeds {MAX_NFCORE_TRACKED_FILE_BYTES} bytes"
            )));
        }
        source_bytes = source_bytes.checked_add(size).ok_or_else(|| {
            ServerError::WorkflowImport("nf-core source byte count overflowed u64".to_owned())
        })?;
        if source_bytes > MAX_NFCORE_SOURCE_BYTES {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core source exceeds {MAX_NFCORE_SOURCE_BYTES} tracked bytes"
            )));
        }
        let blob = read_nfcore_git_blob(&bare, &git_isolation, object, size, path)?;
        if blob.len() as u64 != size {
            return Err(ServerError::WorkflowImport(format!(
                "Git blob {path} changed size while source was fetched"
            )));
        }
        files.push(FrozenSourceFile {
            path: path.to_owned(),
            mode: if *mode == "100755" {
                0o100755
            } else {
                0o100644
            },
            bytes: blob,
        });
        entrypoint_found |= path == "main.nf";
    }
    if !entrypoint_found {
        return Err(ServerError::WorkflowImport(
            "nf-core release does not contain a regular tracked main.nf entrypoint".to_owned(),
        ));
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = source_manifest_from_frozen(&files, source_bytes)?;
    Ok(FetchedNfcoreSource {
        resolved_revision,
        manifest,
        files,
    })
}

fn run_nfcore_git(
    command: &mut Command,
    isolation: &NfcoreGitIsolation,
    operation: &str,
) -> Result<std::process::Output, ServerError> {
    run_nfcore_git_bounded(command, isolation, operation, MAX_NFCORE_GIT_METADATA_BYTES)
}

fn run_nfcore_git_bounded(
    command: &mut Command,
    isolation: &NfcoreGitIsolation,
    operation: &str,
    stdout_limit: usize,
) -> Result<std::process::Output, ServerError> {
    isolation.apply(command);
    let output = capture_nfcore_git_output(command, stdout_limit, MAX_NFCORE_GIT_DIAGNOSTIC_BYTES)
        .map_err(|error| ServerError::WorkflowImport(format!("could not {operation}: {error}")))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(ServerError::WorkflowImport(format!(
            "could not {operation}: {}",
            command_failure_detail(&output)
        )))
    }
}

fn read_nfcore_git_blob(
    bare: &Path,
    isolation: &NfcoreGitIsolation,
    object: &str,
    expected_bytes: u64,
    path: &str,
) -> Result<Vec<u8>, ServerError> {
    let mut command = Command::new("git");
    command
        .arg("--git-dir")
        .arg(bare)
        .args(["cat-file", "blob", object]);
    isolation.apply(&mut command);
    let expected_bytes_usize = usize::try_from(expected_bytes).map_err(|_| {
        ServerError::WorkflowImport(format!(
            "Git blob {path} declared a byte size unsupported on this platform"
        ))
    })?;
    let output = match capture_nfcore_git_output(
        &mut command,
        expected_bytes_usize,
        MAX_NFCORE_GIT_DIAGNOSTIC_BYTES,
    ) {
        Ok(output) => output,
        Err(BoundedGitOutputError::Limit {
            stream: "stdout", ..
        }) => {
            return Err(ServerError::WorkflowImport(format!(
                "Git blob {path} exceeded its declared {expected_bytes} byte size"
            )))
        }
        Err(error) => {
            return Err(ServerError::WorkflowImport(format!(
                "could not read exact tracked source blob {path}: {error}"
            )))
        }
    };
    if !output.status.success() {
        return Err(ServerError::WorkflowImport(format!(
            "could not read exact tracked source blob {path}: {}",
            command_failure_detail(&output)
        )));
    }
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", output.stdout.len()).as_bytes());
    hasher.update(&output.stdout);
    let actual_object = format!("{:x}", hasher.finalize());
    if !actual_object.eq_ignore_ascii_case(object) {
        return Err(ServerError::WorkflowImport(format!(
            "Git blob {path} did not match its advertised object identity {object}; got {actual_object}"
        )));
    }
    Ok(output.stdout)
}

#[derive(Debug, Error)]
enum BoundedGitOutputError {
    #[error("could not spawn Git: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("Git did not expose its {0} pipe")]
    MissingPipe(&'static str),
    #[error("could not wait for Git: {0}")]
    Wait(#[source] std::io::Error),
    #[error("could not read Git {stream}: {source}")]
    Read {
        stream: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("Git {stream} reader stopped unexpectedly")]
    ReaderPanicked { stream: &'static str },
    #[error("Git {stream} exceeded the {limit}-byte capture limit")]
    Limit { stream: &'static str, limit: usize },
}

struct BoundedPipeCapture {
    bytes: Vec<u8>,
    exceeded: bool,
}

fn capture_nfcore_git_output(
    command: &mut Command,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<std::process::Output, BoundedGitOutputError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(BoundedGitOutputError::Spawn)?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BoundedGitOutputError::MissingPipe("stdout"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BoundedGitOutputError::MissingPipe("stderr"));
        }
    };

    let abort = Arc::new(AtomicBool::new(false));
    let stdout_abort = abort.clone();
    let stdout_reader =
        std::thread::spawn(move || read_bounded_git_pipe(stdout, stdout_limit, stdout_abort));
    let stderr_abort = abort.clone();
    let stderr_reader =
        std::thread::spawn(move || read_bounded_git_pipe(stderr, stderr_limit, stderr_abort));

    let status = loop {
        if abort.load(Ordering::Acquire) {
            let _ = child.kill();
            break child.wait().map_err(BoundedGitOutputError::Wait)?;
        }
        match child.try_wait().map_err(BoundedGitOutputError::Wait)? {
            Some(status) => break status,
            None => std::thread::sleep(Duration::from_millis(1)),
        }
    };

    let stdout_joined = stdout_reader.join();
    let stderr_joined = stderr_reader.join();
    let stdout = stdout_joined
        .map_err(|_| BoundedGitOutputError::ReaderPanicked { stream: "stdout" })?
        .map_err(|source| BoundedGitOutputError::Read {
            stream: "stdout",
            source,
        })?;
    let stderr = stderr_joined
        .map_err(|_| BoundedGitOutputError::ReaderPanicked { stream: "stderr" })?
        .map_err(|source| BoundedGitOutputError::Read {
            stream: "stderr",
            source,
        })?;
    if stdout.exceeded {
        return Err(BoundedGitOutputError::Limit {
            stream: "stdout",
            limit: stdout_limit,
        });
    }
    if stderr.exceeded {
        return Err(BoundedGitOutputError::Limit {
            stream: "stderr",
            limit: stderr_limit,
        });
    }
    Ok(std::process::Output {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn read_bounded_git_pipe(
    mut pipe: impl Read,
    limit: usize,
    abort: Arc<AtomicBool>,
) -> Result<BoundedPipeCapture, std::io::Error> {
    let capture_limit = limit.saturating_add(1);
    let mut bytes = Vec::with_capacity(capture_limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = match pipe.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                abort.store(true, Ordering::Release);
                return Err(error);
            }
        };
        if read == 0 {
            return Ok(BoundedPipeCapture {
                bytes,
                exceeded: false,
            });
        }
        let remaining = capture_limit.saturating_sub(bytes.len());
        let retained = read.min(remaining);
        bytes
            .try_reserve_exact(retained)
            .map_err(std::io::Error::other)?;
        bytes.extend_from_slice(&buffer[..retained]);
        if read > remaining || bytes.len() > limit {
            abort.store(true, Ordering::Release);
            return Ok(BoundedPipeCapture {
                bytes,
                exceeded: true,
            });
        }
    }
}

fn git_stdout(
    command: &mut Command,
    isolation: &NfcoreGitIsolation,
    operation: &str,
) -> Result<String, ServerError> {
    let output = run_nfcore_git(command, isolation, operation)?;
    String::from_utf8(output.stdout).map_err(|_| {
        ServerError::WorkflowImport(format!(
            "could not {operation}: Git returned non-UTF-8 output"
        ))
    })
}

fn command_failure_detail(output: &std::process::Output) -> String {
    last_nonempty_output_line(&output.stderr)
        .or_else(|| last_nonempty_output_line(&output.stdout))
        .unwrap_or_else(|| output.status.to_string())
}

fn source_workflow_response(
    request: &WorkflowGraphRequest,
    source_operator_revision: &str,
    workflow: SourceWorkflowInstance,
    cached: bool,
) -> Result<WorkflowGraphResponse, ServerError> {
    source_workflow_response_with_limit(
        request,
        source_operator_revision,
        workflow,
        cached,
        MAX_GRAPH_BYTES,
    )
}

fn source_workflow_response_with_limit(
    request: &WorkflowGraphRequest,
    source_operator_revision: &str,
    workflow: SourceWorkflowInstance,
    cached: bool,
    max_graph_bytes: u64,
) -> Result<WorkflowGraphResponse, ServerError> {
    let resolved_short = workflow
        .source
        .resolved_revision
        .get(..12)
        .unwrap_or(&workflow.source.resolved_revision)
        .to_owned();
    let graph = Graph {
        schema_version: somite_ir::SCHEMA_VERSION,
        name: Some(request.workflow.clone()),
        nodes: vec![Node {
            id: format!("source-{}", request.workflow.trim_start_matches("nf-core/")),
            operator: "workflow.source".to_owned(),
            operator_revision: source_operator_revision.to_owned(),
            ports: Vec::new(),
            params: BTreeMap::new(),
            source_workflow: Some(workflow),
            layout: Layout { x: 0.0, y: 0.0 },
            note: Some(format!(
                "Pinned from {}@{} ({resolved_short})",
                request.workflow, request.revision
            )),
            color: None,
        }],
        edges: Vec::new(),
        annotations: Vec::new(),
        variant_origin: None,
    };
    graph.validate()?;
    let _ = serialize_graph_with_limit(&graph, max_graph_bytes)?;
    Ok(WorkflowGraphResponse {
        engine: "nextflow".to_owned(),
        workflow: request.workflow.clone(),
        revision: request.revision.clone(),
        graph,
        cached,
    })
}

fn serialize_graph_with_limit(graph: &Graph, max_graph_bytes: u64) -> Result<Vec<u8>, ServerError> {
    let encoded = serde_json::to_vec_pretty(graph)?;
    let encoded_bytes = u64::try_from(encoded.len()).unwrap_or(u64::MAX);
    if encoded_bytes > max_graph_bytes {
        return Err(ServerError::GraphTooLarge {
            encoded_bytes,
            limit_bytes: max_graph_bytes,
        });
    }
    Ok(encoded)
}

#[cfg(test)]
fn source_workflow_store(root: &Path) -> PathBuf {
    root.join(".somite/source-workflows")
}

fn checked_source_workflow_store(
    root: &Path,
    create: bool,
) -> Result<Option<PathBuf>, ServerError> {
    let canonical_root = root.canonicalize().map_err(|error| {
        ServerError::SourceWorkflow(format!("could not resolve project root: {error}"))
    })?;
    let somite = canonical_root.join(".somite");
    if !ensure_or_find_store_directory(&somite, &canonical_root, ".somite", create)? {
        return Ok(None);
    }
    let canonical_somite = somite.canonicalize().map_err(ServerError::Io)?;
    let store = somite.join("source-workflows");
    if !ensure_or_find_store_directory(
        &store,
        &canonical_somite,
        ".somite/source-workflows",
        create,
    )? {
        return Ok(None);
    }
    let canonical_store = store.canonicalize().map_err(ServerError::Io)?;
    for name in ["objects", "instances", "revisions", "requests"] {
        let child = store.join(name);
        match std::fs::symlink_metadata(&child) {
            Ok(_) => {
                validate_store_directory(&child, &canonical_store, name)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ServerError::Io(error)),
        }
    }
    Ok(Some(store))
}

fn checked_source_store_subdir(
    root: &Path,
    name: &str,
    create: bool,
) -> Result<Option<PathBuf>, ServerError> {
    let Some(store) = checked_source_workflow_store(root, create)? else {
        return Ok(None);
    };
    let canonical_store = store.canonicalize().map_err(ServerError::Io)?;
    let directory = store.join(name);
    if !ensure_or_find_store_directory(&directory, &canonical_store, name, create)? {
        return Ok(None);
    }
    Ok(Some(directory))
}

fn ensure_or_find_store_directory(
    path: &Path,
    canonical_parent: &Path,
    label: &str,
    create: bool,
) -> Result<bool, ServerError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            validate_store_directory(path, canonical_parent, label)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            match std::fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(ServerError::Io(error)),
            }
            validate_store_directory(path, canonical_parent, label)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ServerError::Io(error)),
    }
}

fn validate_store_directory(
    path: &Path,
    canonical_parent: &Path,
    label: &str,
) -> Result<(), ServerError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow store path {label} must be a regular non-symlink directory"
        )));
    }
    let canonical = path.canonicalize()?;
    if canonical.parent() != Some(canonical_parent) {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow store path {label} escapes its canonical parent"
        )));
    }
    Ok(())
}

fn source_instance_digest(workflow: &SourceWorkflowInstance) -> Result<String, ServerError> {
    let encoded = serde_json::to_vec(workflow)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-workflow-instance-v2\0");
    hasher.update(SOURCE_INDEXER_REVISION.as_bytes());
    hasher.update(b"\0");
    hasher.update(&encoded);
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

fn verify_source_workflow_revision_cached(
    root: &Path,
    workflow: &SourceWorkflowInstance,
    instance_digest: &str,
) -> Result<(), ServerError> {
    let key = (root.canonicalize()?, instance_digest.to_owned());
    let verified = VERIFIED_SOURCE_INSTANCES.get_or_init(|| Mutex::new(BTreeSet::new()));
    {
        let verified = verified
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if verified.contains(&key) {
            return Ok(());
        }
    }
    let expected = calculate_source_workflow_revision(workflow)
        .map_err(|error| ServerError::SourceWorkflow(error.to_string()))?;
    if expected != workflow.workflow_revision {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow instance {instance_digest} has stale semantic revision {}; expected {expected}",
            workflow.workflow_revision
        )));
    }
    let mut verified = verified
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if verified.len() >= MAX_VERIFIED_SOURCE_INSTANCES && !verified.contains(&key) {
        if let Some(oldest) = verified.first().cloned() {
            verified.remove(&oldest);
        }
    }
    verified.insert(key);
    Ok(())
}

fn source_instance_digest_hex(digest: &str) -> Result<String, ServerError> {
    blake3_identity_hex(digest, "source workflow instance digest")
}

fn source_digest_hex(digest: &str) -> Result<String, ServerError> {
    blake3_identity_hex(digest, "source digest")
}

fn blake3_identity_hex(identity: &str, kind: &str) -> Result<String, ServerError> {
    let Some(hex) = identity.strip_prefix("blake3:") else {
        return Err(ServerError::SourceWorkflow(format!(
            "{kind} {identity} is not a blake3 identity"
        )));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ServerError::SourceWorkflow(format!(
            "{kind} {identity} is malformed"
        )));
    }
    Ok(hex.to_ascii_lowercase())
}

fn safe_source_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.trim().is_empty()
        && value.len() <= MAX_SOURCE_PATH_BYTES
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

#[derive(Debug)]
enum PortableSourcePathError {
    Collision { first: String, second: String },
    InvalidComponent { path: String, component: String },
}

impl std::fmt::Display for PortableSourcePathError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collision { first, second } => write!(
                formatter,
                "paths {first} and {second} collide on a portable filesystem"
            ),
            Self::InvalidComponent { path, component } => write!(
                formatter,
                "path {path} contains component {component:?}, which is not portable across supported filesystems"
            ),
        }
    }
}

#[derive(Default)]
struct PortableSourcePathRegistry {
    // Track every prefix, not only complete file names. This rejects cases
    // such as `A/file.nf` plus `a/other.nf`, whose distinct directory
    // spellings collapse on a case-insensitive filesystem and make exact
    // manifest enumeration ambiguous.
    prefixes: BTreeMap<Vec<String>, String>,
    directories: BTreeMap<Vec<String>, String>,
    files: BTreeMap<Vec<String>, String>,
}

impl PortableSourcePathRegistry {
    fn insert(&mut self, path: &str) -> Result<(), PortableSourcePathError> {
        let components = Path::new(path)
            .components()
            .map(|component| {
                let std::path::Component::Normal(component) = component else {
                    return Err(PortableSourcePathError::InvalidComponent {
                        path: path.to_owned(),
                        component: component.as_os_str().to_string_lossy().into_owned(),
                    });
                };
                component
                    .to_str()
                    .ok_or_else(|| PortableSourcePathError::InvalidComponent {
                        path: path.to_owned(),
                        component: component.to_string_lossy().into_owned(),
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut portable_prefix = Vec::new();
        let mut source_prefix = Vec::new();
        for (index, &component) in components.iter().enumerate() {
            let portable_component = portable_source_component_key(path, component)?;
            portable_prefix.push(portable_component);
            source_prefix.push(component);
            let source_prefix = source_prefix.join("/");
            if let Some(first) = self.prefixes.get(&portable_prefix) {
                if first != &source_prefix {
                    return Err(PortableSourcePathError::Collision {
                        first: first.clone(),
                        second: source_prefix,
                    });
                }
            } else {
                let _ = self
                    .prefixes
                    .insert(portable_prefix.clone(), source_prefix.clone());
            }

            let final_component = index + 1 == components.len();
            if final_component {
                if let Some(first) = self.directories.get(&portable_prefix) {
                    return Err(PortableSourcePathError::Collision {
                        first: first.clone(),
                        second: source_prefix,
                    });
                }
                let _ = self.files.insert(portable_prefix.clone(), source_prefix);
            } else {
                if let Some(first) = self.files.get(&portable_prefix) {
                    return Err(PortableSourcePathError::Collision {
                        first: first.clone(),
                        second: source_prefix,
                    });
                }
                let _ = self
                    .directories
                    .insert(portable_prefix.clone(), source_prefix);
            }
        }
        Ok(())
    }
}

fn portable_source_component_key(
    path: &str,
    component: &str,
) -> Result<String, PortableSourcePathError> {
    let portable_component = component.nfkc().case_fold().nfkc().collect::<String>();
    let invalid_character = portable_component.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
    });
    let trailing_dot_or_space = portable_component.ends_with(['.', ' ']);
    let stem = portable_component.split('.').next().unwrap_or_default();
    let reserved_device = matches!(stem, "con" | "prn" | "aux" | "nul")
        || stem.strip_prefix("com").is_some_and(|number| {
            matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || stem.strip_prefix("lpt").is_some_and(|number| {
            matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        });
    if portable_component.is_empty()
        || invalid_character
        || trailing_dot_or_space
        || reserved_device
    {
        return Err(PortableSourcePathError::InvalidComponent {
            path: path.to_owned(),
            component: component.to_owned(),
        });
    }
    Ok(portable_component)
}

fn reserved_git_metadata_path(value: &str) -> bool {
    Path::new(value).components().any(|component| {
        let std::path::Component::Normal(component) = component else {
            return false;
        };
        component.to_str().is_some_and(|component| {
            let component = component
                .split(':')
                .next()
                .unwrap_or(component)
                .trim_end_matches(['.', ' ']);
            // Git protects both the NTFS 8.3 alias and HFS spellings that
            // differ from `.git` only by filesystem-ignorable Unicode. The
            // resolver never materializes beside Git metadata, but reject the
            // aliases before they enter Somite's cross-platform source CAS as
            // defense in depth.
            let ascii_projection = component.chars().filter(char::is_ascii).collect::<String>();
            ascii_projection.eq_ignore_ascii_case(".git")
                || ascii_projection.eq_ignore_ascii_case("git~1")
        })
    })
}

fn source_manifest_from_frozen(
    files: &[FrozenSourceFile],
    expected_source_bytes: u64,
) -> Result<SourceManifest, ServerError> {
    if files.is_empty() || files.len() > MAX_NFCORE_TRACKED_FILES {
        return Err(ServerError::WorkflowImport(format!(
            "nf-core source must contain between 1 and {MAX_NFCORE_TRACKED_FILES} tracked files"
        )));
    }
    let mut manifest_files = Vec::with_capacity(files.len());
    let mut source_bytes = 0_u64;
    let mut source_hasher = blake3::Hasher::new();
    source_hasher.update(b"somite-source-manifest-v1\0");
    let mut previous_path: Option<&str> = None;
    let mut portable_paths = PortableSourcePathRegistry::default();
    for file in files {
        if !safe_source_relative_path(&file.path)
            || reserved_git_metadata_path(&file.path)
            || previous_path.is_some_and(|previous| previous >= file.path.as_str())
            || !matches!(file.mode, 0o100644 | 0o100755)
        {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core source contains an invalid frozen file {}",
                file.path
            )));
        }
        portable_paths.insert(&file.path).map_err(|collision| {
            ServerError::WorkflowImport(format!("nf-core source {collision}"))
        })?;
        previous_path = Some(&file.path);
        let bytes = u64::try_from(file.bytes.len()).map_err(|_| {
            ServerError::WorkflowImport(format!("nf-core tracked file {} exceeds u64", file.path))
        })?;
        if bytes > MAX_NFCORE_TRACKED_FILE_BYTES {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core tracked file {} exceeds {MAX_NFCORE_TRACKED_FILE_BYTES} bytes",
                file.path
            )));
        }
        source_bytes = source_bytes.checked_add(bytes).ok_or_else(|| {
            ServerError::WorkflowImport("nf-core source byte count overflowed u64".to_owned())
        })?;
        if source_bytes > MAX_NFCORE_SOURCE_BYTES {
            return Err(ServerError::WorkflowImport(format!(
                "nf-core source exceeds {MAX_NFCORE_SOURCE_BYTES} tracked bytes"
            )));
        }
        update_source_digest_frame(&mut source_hasher, file.path.as_bytes());
        source_hasher.update(&file.mode.to_le_bytes());
        source_hasher.update(&bytes.to_le_bytes());
        update_source_digest_frame(&mut source_hasher, &file.bytes);
        manifest_files.push(SourceFileManifest {
            path: file.path.clone(),
            mode: file.mode,
            bytes,
            digest: format!("blake3:{}", blake3::hash(&file.bytes).to_hex()),
        });
    }
    if source_bytes != expected_source_bytes {
        return Err(ServerError::WorkflowImport(format!(
            "nf-core source declared {expected_source_bytes} bytes but fetched {source_bytes}"
        )));
    }
    Ok(SourceManifest {
        schema_version: 1,
        source_digest: format!("blake3:{}", source_hasher.finalize().to_hex()),
        source_bytes,
        files: manifest_files,
    })
}

fn pair_frozen_source_files(
    frozen: Vec<FrozenSourceFile>,
    manifest: &SourceManifest,
) -> Result<Vec<(SourceFileManifest, Vec<u8>)>, ServerError> {
    if frozen.len() != manifest.files.len() {
        return Err(ServerError::SourceWorkflow(
            "frozen source file count does not match its manifest".to_owned(),
        ));
    }
    manifest
        .files
        .iter()
        .cloned()
        .zip(frozen)
        .map(|(entry, file)| {
            if file.mode != entry.mode
                || file.path != entry.path
                || file.bytes.len() as u64 != entry.bytes
                || format!("blake3:{}", blake3::hash(&file.bytes).to_hex()) != entry.digest
            {
                return Err(ServerError::SourceWorkflow(format!(
                    "frozen source file {} does not match its manifest",
                    entry.path
                )));
            }
            Ok((entry, file.bytes))
        })
        .collect()
}

fn verify_source_instance_contents(stored: &StoredSourceInstance) -> Result<(), ServerError> {
    verify_source_instance_metadata(&stored.workflow, &stored.manifest)?;
    if stored.files.len() != stored.manifest.files.len() {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow {} does not match its source manifest",
            stored.workflow.workflow_revision
        )));
    }

    let mut source_bytes = 0_u64;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-manifest-v1\0");
    let mut previous_path: Option<&str> = None;
    let mut entrypoint_found = false;
    for (index, (entry, bytes)) in stored.files.iter().enumerate() {
        if stored.manifest.files.get(index) != Some(entry)
            || !safe_source_relative_path(&entry.path)
            || previous_path.is_some_and(|previous| previous >= entry.path.as_str())
            || !matches!(entry.mode, 0o100644 | 0o100755)
            || entry.bytes != bytes.len() as u64
            || entry.digest != format!("blake3:{}", blake3::hash(bytes).to_hex())
        {
            return Err(ServerError::SourceWorkflow(format!(
                "stored source file {} does not match its immutable manifest entry",
                entry.path
            )));
        }
        previous_path = Some(&entry.path);
        entrypoint_found |= entry.path == stored.workflow.source.entrypoint;
        source_bytes = source_bytes.checked_add(entry.bytes).ok_or_else(|| {
            ServerError::SourceWorkflow("stored source byte count overflowed u64".to_owned())
        })?;
        update_source_digest_frame(&mut hasher, entry.path.as_bytes());
        hasher.update(&entry.mode.to_le_bytes());
        hasher.update(&entry.bytes.to_le_bytes());
        update_source_digest_frame(&mut hasher, bytes);
    }
    let source_digest = format!("blake3:{}", hasher.finalize().to_hex());
    if source_bytes != stored.manifest.source_bytes
        || source_digest != stored.manifest.source_digest
        || !entrypoint_found
    {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow {} failed exact source identity verification",
            stored.workflow.workflow_revision
        )));
    }
    Ok(())
}

fn verify_source_instance_metadata(
    workflow: &SourceWorkflowInstance,
    manifest: &SourceManifest,
) -> Result<(), ServerError> {
    validate_stored_source_manifest(manifest)?;
    if workflow.capabilities.exact_execution {
        return Err(ServerError::SourceWorkflow(
            "source workflow exact_execution must remain false until an execution environment is frozen"
                .to_owned(),
        ));
    }
    if workflow.capabilities.structural_edits
        || workflow.capabilities.channel_contracts
        || workflow.capabilities.source_edits
    {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow {} capabilities violate the source-backed workflow invariants",
            workflow.workflow_revision
        )));
    }
    if manifest.schema_version != 1
        || manifest.source_digest != workflow.source.source_digest
        || manifest.source_bytes != workflow.source.source_bytes
        || manifest.files.len() != workflow.source.file_count as usize
    {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow {} does not match its source manifest",
            workflow.workflow_revision
        )));
    }
    Ok(())
}

fn update_source_digest_frame(hasher: &mut blake3::Hasher, bytes: &[u8]) {
    hasher.update(&(bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn persist_source_instance(root: &Path, stored: &StoredSourceInstance) -> Result<(), ServerError> {
    persist_source_instance_with_limit(root, stored, MAX_SOURCE_RECORD_BYTES)
}

fn persist_source_instance_with_limit(
    root: &Path,
    stored: &StoredSourceInstance,
    max_record_bytes: u64,
) -> Result<(), ServerError> {
    verify_source_instance_contents(stored)?;
    let prepared = prepare_workflow_instance_record(root, &stored.workflow, max_record_bytes)?;
    persist_prepared_source_instance(root, stored, prepared)
}

fn persist_prepared_source_instance(
    root: &Path,
    stored: &StoredSourceInstance,
    prepared: PreparedWorkflowInstanceRecord,
) -> Result<(), ServerError> {
    persist_source_object(root, &stored.manifest, &stored.files)?;
    persist_prepared_workflow_instance_record(root, prepared)
}

fn persist_source_instance_metadata(
    root: &Path,
    stored: &StoredSourceInstanceMetadata,
) -> Result<(), ServerError> {
    verify_source_instance_metadata(&stored.workflow, &stored.manifest)?;
    let prepared =
        prepare_workflow_instance_record(root, &stored.workflow, MAX_SOURCE_RECORD_BYTES)?;
    let (canonical_source_root, canonical_manifest, canonical_fingerprint) =
        read_stored_source_object_manifest(root, &stored.workflow.source.source_digest)?;
    if canonical_manifest != stored.manifest
        || canonical_source_root != stored.source_root
        || canonical_fingerprint != stored.metadata_fingerprint
    {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow {} does not match its immutable source object",
            stored.workflow.workflow_revision
        )));
    }
    persist_prepared_workflow_instance_record(root, prepared)
}

fn persist_source_object(
    root: &Path,
    manifest: &SourceManifest,
    files: &[(SourceFileManifest, Vec<u8>)],
) -> Result<(), ServerError> {
    validate_stored_source_manifest(manifest)?;
    let manifest_identity = format!("source object {} manifest", manifest.source_digest);
    let encoded_manifest = pretty_json_line(manifest)?;
    ensure_source_record_size(
        &encoded_manifest,
        &manifest_identity,
        MAX_SOURCE_RECORD_BYTES,
    )?;
    let store = checked_source_workflow_store(root, true)?.ok_or_else(|| {
        ServerError::SourceWorkflow("could not initialize source workflow store".to_owned())
    })?;
    let objects = checked_source_store_subdir(root, "objects", true)?.ok_or_else(|| {
        ServerError::SourceWorkflow("could not initialize source object store".to_owned())
    })?;
    let destination = objects.join(source_digest_hex(&manifest.source_digest)?);
    if path_entry_exists(&destination)? {
        let (existing_manifest, existing_files) =
            read_stored_source_object(root, &manifest.source_digest)?;
        return if existing_manifest == *manifest && existing_files == files {
            Ok(())
        } else {
            Err(ServerError::SourceWorkflow(format!(
                "source object {} conflicts with its existing immutable store",
                manifest.source_digest
            )))
        };
    }

    let stage = tempfile::Builder::new()
        .prefix(".source-object-")
        .tempdir_in(&store)?;
    let source = stage.path().join("source");
    std::fs::create_dir(&source)?;
    for (entry, bytes) in files {
        let destination = source.join(&entry.path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&destination, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = if entry.mode == 0o100755 { 0o755 } else { 0o644 };
            std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(permissions))?;
        }
    }
    std::fs::write(stage.path().join("source-manifest.json"), encoded_manifest)?;
    verify_staged_source_object(stage.path(), manifest, files)?;
    match std::fs::rename(stage.path(), &destination) {
        Ok(()) => Ok(()),
        Err(_) if path_entry_exists(&destination)? => {
            let (existing_manifest, existing_files) =
                read_stored_source_object(root, &manifest.source_digest)?;
            if existing_manifest == *manifest && existing_files == files {
                Ok(())
            } else {
                Err(ServerError::SourceWorkflow(format!(
                    "source object {} raced with different stored content",
                    manifest.source_digest
                )))
            }
        }
        Err(error) => Err(ServerError::Io(error)),
    }
}

fn verify_staged_source_object(
    directory: &Path,
    expected_manifest: &SourceManifest,
    expected_files: &[(SourceFileManifest, Vec<u8>)],
) -> Result<(), ServerError> {
    verify_source_object_root_entries(directory, &expected_manifest.source_digest)?;
    let encoded_manifest = read_regular_file(
        &directory.join("source-manifest.json"),
        MAX_SOURCE_RECORD_BYTES,
    )?;
    let manifest: SourceManifest = serde_json::from_slice(&encoded_manifest)?;
    if manifest != *expected_manifest {
        return Err(ServerError::SourceWorkflow(format!(
            "staged source object {} does not contain its exact manifest",
            expected_manifest.source_digest
        )));
    }
    validate_stored_source_manifest(&manifest)?;

    let canonical_directory = directory.canonicalize()?;
    let source_root = directory.join("source");
    validate_store_directory(&source_root, &canonical_directory, "staged source")?;
    let inspection =
        inspect_stored_source_tree(&source_root, &manifest, SourceTreeReadMode::Contents)?;
    let files = inspection.files.ok_or_else(|| {
        ServerError::SourceWorkflow(format!(
            "staged source object {} was not read with its exact contents",
            expected_manifest.source_digest
        ))
    })?;
    if files != expected_files {
        return Err(ServerError::SourceWorkflow(format!(
            "staged source object {} does not contain its exact source bytes",
            expected_manifest.source_digest
        )));
    }
    Ok(())
}

fn path_entry_exists(path: &Path) -> Result<bool, ServerError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ServerError::Io(error)),
    }
}

#[cfg(test)]
fn persist_workflow_instance_record_with_limit(
    root: &Path,
    workflow: &SourceWorkflowInstance,
    max_record_bytes: u64,
) -> Result<(), ServerError> {
    let prepared = prepare_workflow_instance_record(root, workflow, max_record_bytes)?;
    persist_prepared_workflow_instance_record(root, prepared)
}

struct PreparedWorkflowInstanceRecord {
    instance_digest: String,
    identity: String,
    encoded: Vec<u8>,
}

fn prepare_workflow_instance_record(
    root: &Path,
    workflow: &SourceWorkflowInstance,
    max_record_bytes: u64,
) -> Result<PreparedWorkflowInstanceRecord, ServerError> {
    let instance_digest = source_instance_digest(workflow)?;
    verify_source_workflow_revision_cached(root, workflow, &instance_digest)?;
    let record = StoredWorkflowInstanceRecord {
        schema_version: 2,
        indexer_revision: SOURCE_INDEXER_REVISION.to_owned(),
        instance_digest: instance_digest.clone(),
        source_digest: workflow.source.source_digest.clone(),
        workflow: workflow.clone(),
    };
    let encoded = pretty_json_line(&record)?;
    let identity = format!("source workflow instance {instance_digest}");
    ensure_source_record_size(&encoded, &identity, max_record_bytes)?;
    Ok(PreparedWorkflowInstanceRecord {
        instance_digest,
        identity,
        encoded,
    })
}

fn persist_prepared_workflow_instance_record(
    root: &Path,
    prepared: PreparedWorkflowInstanceRecord,
) -> Result<(), ServerError> {
    let instances = checked_source_store_subdir(root, "instances", true)?.ok_or_else(|| {
        ServerError::SourceWorkflow("could not initialize source instance store".to_owned())
    })?;
    let destination = instances.join(format!(
        "{}.json",
        source_instance_digest_hex(&prepared.instance_digest)?
    ));
    persist_immutable_json_file(
        &instances,
        &destination,
        &prepared.encoded,
        &prepared.identity,
    )
}

fn pretty_json_line(value: &impl Serialize) -> Result<Vec<u8>, ServerError> {
    let mut encoded = serde_json::to_vec_pretty(value)?;
    encoded.push(b'\n');
    Ok(encoded)
}

fn ensure_source_record_size(
    encoded: &[u8],
    record: &str,
    max_record_bytes: u64,
) -> Result<(), ServerError> {
    let encoded_bytes = u64::try_from(encoded.len()).unwrap_or(u64::MAX);
    if encoded_bytes > max_record_bytes {
        return Err(ServerError::SourceRecordTooLarge {
            record: record.to_owned(),
            encoded_bytes,
            limit_bytes: max_record_bytes,
        });
    }
    Ok(())
}

fn persist_immutable_json_file(
    directory: &Path,
    destination: &Path,
    encoded: &[u8],
    identity: &str,
) -> Result<(), ServerError> {
    let temporary = tempfile::Builder::new()
        .prefix(".source-record-")
        .tempfile_in(directory)?;
    std::fs::write(temporary.path(), encoded)?;
    match std::fs::hard_link(temporary.path(), destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if read_regular_file(destination, encoded.len() as u64 + 1)? == encoded {
                Ok(())
            } else {
                Err(ServerError::SourceWorkflow(format!(
                    "{identity} conflicts with its existing immutable record"
                )))
            }
        }
        Err(error) => Err(ServerError::Io(error)),
    }
}

struct PreparedNfcoreRequestRecord {
    identity: String,
    encoded: Vec<u8>,
}

fn prepare_nfcore_request(
    request: &WorkflowGraphRequest,
    workflow: &SourceWorkflowInstance,
    max_record_bytes: u64,
) -> Result<PreparedNfcoreRequestRecord, ServerError> {
    let record = StoredNfcoreRequest {
        schema_version: 2,
        resolver_revision: NFCORE_SOURCE_RESOLVER_REVISION.to_owned(),
        indexer_revision: SOURCE_INDEXER_REVISION.to_owned(),
        workflow: request.workflow.clone(),
        requested_revision: request.revision.clone(),
        resolved_revision: workflow.source.resolved_revision.clone(),
        source_digest: workflow.source.source_digest.clone(),
        workflow_revision: workflow.workflow_revision.clone(),
        instance_digest: source_instance_digest(workflow)?,
    };
    let encoded = pretty_json_line(&record)?;
    let identity = format!("nf-core request {}@{}", request.workflow, request.revision);
    ensure_source_record_size(&encoded, &identity, max_record_bytes)?;
    Ok(PreparedNfcoreRequestRecord { identity, encoded })
}

fn persist_prepared_nfcore_request(
    root: &Path,
    request_key: &str,
    prepared: PreparedNfcoreRequestRecord,
) -> Result<(), ServerError> {
    let requests = checked_source_store_subdir(root, "requests", true)?.ok_or_else(|| {
        ServerError::SourceWorkflow("could not initialize source request store".to_owned())
    })?;
    let destination = requests.join(format!("{request_key}.json"));
    persist_immutable_json_file(
        &requests,
        &destination,
        &prepared.encoded,
        &prepared.identity,
    )
}

fn read_stored_source_instance(
    root: &Path,
    expected: &SourceWorkflowInstance,
) -> Result<StoredSourceInstance, ServerError> {
    #[cfg(test)]
    SOURCE_EXACT_CONTENT_READS.fetch_add(1, Ordering::Relaxed);
    let digest = source_instance_digest(expected)?;
    let stored = read_stored_source_instance_digest(root, &digest)?;
    if stored.workflow != *expected {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow instance {digest} does not match its canonical stored instance"
        )));
    }
    Ok(stored)
}

fn read_stored_source_instance_metadata(
    root: &Path,
    expected: &SourceWorkflowInstance,
) -> Result<StoredSourceInstanceMetadata, ServerError> {
    let digest = source_instance_digest(expected)?;
    let record = read_stored_source_instance_record(root, &digest)?;
    if record.workflow != *expected {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow instance {digest} does not match its canonical stored instance"
        )));
    }
    let (source_root, manifest, metadata_fingerprint) =
        read_stored_source_object_manifest(root, &record.source_digest)?;
    verify_source_instance_metadata(&record.workflow, &manifest)?;
    Ok(StoredSourceInstanceMetadata {
        workflow: record.workflow,
        manifest,
        source_root,
        metadata_fingerprint,
    })
}

fn read_stored_source_instance_digest(
    root: &Path,
    instance_digest: &str,
) -> Result<StoredSourceInstance, ServerError> {
    let record = read_stored_source_instance_record(root, instance_digest)?;
    let (manifest, files) = read_stored_source_object(root, &record.source_digest)?;
    let stored = StoredSourceInstance {
        workflow: record.workflow,
        manifest,
        files,
    };
    verify_source_instance_contents(&stored)?;
    Ok(stored)
}

fn read_stored_source_instance_record(
    root: &Path,
    instance_digest: &str,
) -> Result<StoredWorkflowInstanceRecord, ServerError> {
    let instances = checked_source_store_subdir(root, "instances", false)?.ok_or_else(|| {
        ServerError::SourceWorkflow(format!(
            "source workflow instance {instance_digest} is not stored under .somite/source-workflows"
        ))
    })?;
    let path = instances.join(format!(
        "{}.json",
        source_instance_digest_hex(instance_digest)?
    ));
    let record: StoredWorkflowInstanceRecord =
        serde_json::from_slice(&read_regular_file(&path, MAX_SOURCE_RECORD_BYTES).map_err(|_| {
            ServerError::SourceWorkflow(format!(
                "source workflow instance {instance_digest} is not stored under .somite/source-workflows"
            ))
        })?)?;
    if record.schema_version == 1 {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow instance {instance_digest} predates explicit indexer identity; re-import the source workflow"
        )));
    }
    if record.schema_version != 2 {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow instance {instance_digest} uses unsupported record schema {}; re-import the source workflow",
            record.schema_version
        )));
    }
    if record.indexer_revision != SOURCE_INDEXER_REVISION {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow instance {instance_digest} was indexed under {}; this server requires {SOURCE_INDEXER_REVISION}; re-import the source workflow",
            record.indexer_revision
        )));
    }
    if record.instance_digest != instance_digest
        || source_instance_digest(&record.workflow)? != instance_digest
        || record.source_digest != record.workflow.source.source_digest
    {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source workflow instance {instance_digest} has an invalid identity record"
        )));
    }
    verify_source_workflow_revision_cached(root, &record.workflow, instance_digest)?;
    Ok(record)
}

fn read_stored_source_object(
    root: &Path,
    source_digest: &str,
) -> Result<(SourceManifest, StoredSourceFiles), ServerError> {
    let (_, manifest, inspection) =
        read_stored_source_object_inspected(root, source_digest, SourceTreeReadMode::Contents)?;
    let files = inspection.files.ok_or_else(|| {
        ServerError::SourceWorkflow(format!(
            "source object {source_digest} was not read with its exact contents"
        ))
    })?;
    Ok((manifest, files))
}

fn read_stored_source_object_manifest(
    root: &Path,
    source_digest: &str,
) -> Result<(PathBuf, SourceManifest, String), ServerError> {
    let (source_root, manifest, inspection) =
        read_stored_source_object_inspected(root, source_digest, SourceTreeReadMode::MetadataOnly)?;
    Ok((source_root, manifest, inspection.metadata_fingerprint))
}

fn read_stored_source_object_inspected(
    root: &Path,
    source_digest: &str,
    read_mode: SourceTreeReadMode,
) -> Result<(PathBuf, SourceManifest, SourceTreeInspection), ServerError> {
    let objects = checked_source_store_subdir(root, "objects", false)?.ok_or_else(|| {
        ServerError::SourceWorkflow(format!(
            "source object {source_digest} is not stored under .somite/source-workflows"
        ))
    })?;
    let canonical_objects = objects.canonicalize()?;
    let directory = objects.join(source_digest_hex(source_digest)?);
    std::fs::symlink_metadata(&directory).map_err(|_| {
        ServerError::SourceWorkflow(format!(
            "source object {source_digest} is not stored under .somite/source-workflows"
        ))
    })?;
    validate_store_directory(&directory, &canonical_objects, source_digest)?;
    verify_source_object_root_entries(&directory, source_digest)?;
    let manifest_bytes = read_regular_file(
        &directory.join("source-manifest.json"),
        MAX_SOURCE_RECORD_BYTES,
    )?;
    let manifest = match serde_json::from_slice::<SourceManifest>(&manifest_bytes) {
        Ok(manifest) => manifest,
        Err(_) => {
            let legacy: LegacyStoredSourceObjectRecord = serde_json::from_slice(&manifest_bytes)?;
            if legacy.schema_version != 1 {
                return Err(ServerError::SourceWorkflow(format!(
                    "stored source object {source_digest} has an unsupported record schema"
                )));
            }
            let _legacy_capabilities = legacy.capabilities;
            legacy.manifest
        }
    };
    if manifest.source_digest != source_digest {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source object {source_digest} contains manifest {}",
            manifest.source_digest
        )));
    }
    validate_stored_source_manifest(&manifest)?;
    let source_root = directory.join("source");
    let canonical_directory = directory.canonicalize()?;
    validate_store_directory(&source_root, &canonical_directory, "source")?;
    let inspection = inspect_stored_source_tree(&source_root, &manifest, read_mode)?;
    Ok((source_root, manifest, inspection))
}

fn validate_stored_source_manifest(manifest: &SourceManifest) -> Result<(), ServerError> {
    if manifest.schema_version != 1 || manifest.files.len() > MAX_NFCORE_TRACKED_FILES {
        return Err(ServerError::SourceWorkflow(
            "stored source manifest has an unsupported schema or file count".to_owned(),
        ));
    }
    if manifest.source_bytes > MAX_NFCORE_SOURCE_BYTES {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source manifest exceeds {MAX_NFCORE_SOURCE_BYTES} bytes"
        )));
    }
    let mut total = 0_u64;
    let mut previous: Option<&str> = None;
    let mut portable_paths = PortableSourcePathRegistry::default();
    for file in &manifest.files {
        if !safe_source_relative_path(&file.path)
            || reserved_git_metadata_path(&file.path)
            || previous.is_some_and(|path| path >= file.path.as_str())
            || !matches!(file.mode, 0o100644 | 0o100755)
            || file.bytes > MAX_NFCORE_TRACKED_FILE_BYTES
        {
            return Err(ServerError::SourceWorkflow(format!(
                "stored source manifest contains invalid entry {}",
                file.path
            )));
        }
        portable_paths.insert(&file.path).map_err(|collision| {
            ServerError::SourceWorkflow(format!("stored source manifest {collision}"))
        })?;
        total = total.checked_add(file.bytes).ok_or_else(|| {
            ServerError::SourceWorkflow("stored source byte count overflowed u64".to_owned())
        })?;
        previous = Some(&file.path);
    }
    if total != manifest.source_bytes {
        return Err(ServerError::SourceWorkflow(
            "stored source manifest byte total does not match its source identity".to_owned(),
        ));
    }
    Ok(())
}

fn verify_source_object_root_entries(
    directory: &Path,
    source_digest: &str,
) -> Result<(), ServerError> {
    let mut source_found = false;
    let mut manifest_found = false;
    let mut entry_count = 0_usize;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            ServerError::SourceWorkflow(format!(
                "source object {source_digest} contains a non-UTF-8 entry"
            ))
        })?;
        if !matches!(name.as_str(), "source" | "source-manifest.json") {
            return Err(ServerError::SourceWorkflow(format!(
                "source object {source_digest} contains unmanifested entry {name}"
            )));
        }
        source_found |= name == "source";
        manifest_found |= name == "source-manifest.json";
        entry_count += 1;
    }
    if !source_found || !manifest_found || entry_count != 2 {
        return Err(ServerError::SourceWorkflow(format!(
            "source object {source_digest} is missing its exact source tree or manifest"
        )));
    }
    Ok(())
}

struct SourceTreeExpectations<'a> {
    files: BTreeMap<&'a str, (usize, &'a SourceFileManifest)>,
    directories: BTreeSet<&'a str>,
}

impl<'a> SourceTreeExpectations<'a> {
    fn from_manifest(manifest: &'a SourceManifest) -> Self {
        let mut files = BTreeMap::new();
        let mut directories = BTreeSet::new();
        for (index, file) in manifest.files.iter().enumerate() {
            let _ = files.insert(file.path.as_str(), (index, file));
            for (separator, _) in file.path.match_indices('/') {
                let _ = directories.insert(&file.path[..separator]);
            }
        }
        Self { files, directories }
    }
}

fn inspect_stored_source_tree(
    source_root: &Path,
    manifest: &SourceManifest,
    read_mode: SourceTreeReadMode,
) -> Result<SourceTreeInspection, ServerError> {
    let expected = SourceTreeExpectations::from_manifest(manifest);
    let root_metadata = std::fs::symlink_metadata(source_root)?;
    #[cfg(test)]
    let mut metadata_operations = 1_usize;
    #[cfg(test)]
    let mut file_metadata_operations = 0_usize;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(ServerError::SourceWorkflow(
            "stored source root is not a regular non-symlink directory".to_owned(),
        ));
    }
    let mut found_files = 0_usize;
    let mut found_directories = 0_usize;
    let mut pending = vec![(source_root.to_path_buf(), String::new())];
    let mut metadata_by_path = BTreeMap::new();
    let mut file_bytes = matches!(read_mode, SourceTreeReadMode::Contents).then(|| {
        std::iter::repeat_with(|| None)
            .take(manifest.files.len())
            .collect::<Vec<Option<Vec<u8>>>>()
    });
    while let Some((directory, prefix)) = pending.pop() {
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| {
                ServerError::SourceWorkflow(
                    "stored source tree contains a non-UTF-8 entry".to_owned(),
                )
            })?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let metadata = std::fs::symlink_metadata(entry.path())?;
            #[cfg(test)]
            {
                metadata_operations += 1;
            }
            if metadata.file_type().is_symlink() {
                return Err(ServerError::SourceWorkflow(format!(
                    "stored source tree contains symlink {relative}"
                )));
            }
            if metadata.is_dir() {
                if !expected.directories.contains(relative.as_str()) {
                    return Err(ServerError::SourceWorkflow(format!(
                        "stored source tree contains unmanifested directory {relative}"
                    )));
                }
                found_directories += 1;
                pending.push((entry.path(), relative.clone()));
            } else if metadata.is_file() {
                let Some(&(file_index, expected_file)) = expected.files.get(relative.as_str())
                else {
                    return Err(ServerError::SourceWorkflow(format!(
                        "stored source tree contains unmanifested file {relative}"
                    )));
                };
                if metadata.len() != expected_file.bytes {
                    return Err(ServerError::SourceWorkflow(format!(
                        "stored source file {relative} does not match its manifest byte count"
                    )));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let executable = metadata.permissions().mode() & 0o111 != 0;
                    if executable != (expected_file.mode == 0o100755) {
                        return Err(ServerError::SourceWorkflow(format!(
                            "stored source file {relative} does not match its manifest mode"
                        )));
                    }
                }
                if let Some(file_bytes) = &mut file_bytes {
                    let bytes = read_inspected_source_file(
                        &entry.path(),
                        &relative,
                        expected_file.bytes,
                        &metadata,
                    )?;
                    #[cfg(test)]
                    {
                        file_metadata_operations += 2;
                    }
                    if file_bytes[file_index].replace(bytes).is_some() {
                        return Err(ServerError::SourceWorkflow(format!(
                            "stored source tree contains duplicate file {relative}"
                        )));
                    }
                }
                found_files += 1;
            } else {
                return Err(ServerError::SourceWorkflow(format!(
                    "stored source tree contains unsupported entry {relative}"
                )));
            }
            if metadata_by_path
                .insert(relative.clone(), metadata)
                .is_some()
            {
                return Err(ServerError::SourceWorkflow(format!(
                    "stored source tree contains duplicate entry {relative}"
                )));
            }
        }
    }
    if found_files != expected.files.len() || found_directories != expected.directories.len() {
        return Err(ServerError::SourceWorkflow(
            "stored source tree does not exactly match its manifest".to_owned(),
        ));
    }

    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-object-metadata-v2\0");
    update_source_digest_frame(&mut hasher, &serde_json::to_vec(manifest)?);
    update_source_metadata_frame(&mut hasher, &root_metadata)?;
    for (relative, metadata) in &metadata_by_path {
        update_source_digest_frame(&mut hasher, relative.as_bytes());
        update_source_metadata_frame(&mut hasher, metadata)?;
    }
    let files = file_bytes
        .map(|file_bytes| {
            manifest
                .files
                .iter()
                .zip(file_bytes)
                .map(|(entry, bytes)| {
                    bytes.map(|bytes| (entry.clone(), bytes)).ok_or_else(|| {
                        ServerError::SourceWorkflow(format!(
                            "stored source tree is missing file {} after inspection",
                            entry.path
                        ))
                    })
                })
                .collect::<Result<StoredSourceFiles, ServerError>>()
        })
        .transpose()?;
    Ok(SourceTreeInspection {
        metadata_fingerprint: format!("blake3:{}", hasher.finalize().to_hex()),
        files,
        #[cfg(test)]
        metadata_operations,
        #[cfg(test)]
        file_metadata_operations,
    })
}

fn read_inspected_source_file(
    path: &Path,
    relative: &str,
    expected_bytes: u64,
    inspected_metadata: &std::fs::Metadata,
) -> Result<Vec<u8>, ServerError> {
    if expected_bytes > MAX_NFCORE_TRACKED_FILE_BYTES {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source file {relative} exceeds the source file read limit"
        )));
    }
    let inspected_identity = source_metadata_identity(inspected_metadata)?;
    let mut file = std::fs::File::open(path)?;
    let opened_metadata = file.metadata()?;
    if !opened_metadata.is_file()
        || source_metadata_identity(&opened_metadata)? != inspected_identity
    {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source file {relative} changed between inspection and open"
        )));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(expected_bytes).unwrap_or_default());
    (&mut file)
        .take(expected_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    let confirmed_metadata = file.metadata()?;
    if source_metadata_identity(&confirmed_metadata)? != inspected_identity
        || bytes.len() as u64 != expected_bytes
    {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source file {relative} changed while it was read"
        )));
    }
    Ok(bytes)
}

fn source_metadata_identity(metadata: &std::fs::Metadata) -> Result<blake3::Hash, ServerError> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-metadata-identity-v1\0");
    update_source_metadata_frame(&mut hasher, metadata)?;
    Ok(hasher.finalize())
}

fn read_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ServerError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ServerError::SourceWorkflow(format!("stored source file {}: {error}", path.display()))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source file {} is not a regular non-symlink file",
            path.display()
        )));
    }
    if metadata.len() > max_bytes {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source file {} exceeds the {max_bytes} byte read limit",
            path.display()
        )));
    }
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(ServerError::SourceWorkflow(format!(
            "stored source file {} changed beyond the {max_bytes} byte read limit",
            path.display()
        )));
    }
    Ok(bytes)
}

fn update_source_metadata_frame(
    hasher: &mut blake3::Hasher,
    metadata: &std::fs::Metadata,
) -> Result<(), ServerError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hasher.update(&metadata.dev().to_le_bytes());
        hasher.update(&metadata.ino().to_le_bytes());
        hasher.update(&metadata.mode().to_le_bytes());
        hasher.update(&metadata.nlink().to_le_bytes());
        hasher.update(&metadata.size().to_le_bytes());
        hasher.update(&metadata.mtime().to_le_bytes());
        hasher.update(&metadata.mtime_nsec().to_le_bytes());
        hasher.update(&metadata.ctime().to_le_bytes());
        hasher.update(&metadata.ctime_nsec().to_le_bytes());
    }
    #[cfg(not(unix))]
    {
        update_portable_source_metadata_frame(
            hasher,
            metadata.len(),
            metadata.modified(),
            metadata.is_file(),
            metadata.is_dir(),
        )?;
    }
    Ok(())
}

#[cfg(any(not(unix), test))]
fn update_portable_source_metadata_frame(
    hasher: &mut blake3::Hasher,
    len: u64,
    modified: std::io::Result<SystemTime>,
    is_file: bool,
    is_dir: bool,
) -> Result<(), ServerError> {
    hasher.update(&len.to_le_bytes());
    let modified = modified?.duration_since(UNIX_EPOCH).unwrap_or_default();
    hasher.update(&modified.as_secs().to_le_bytes());
    hasher.update(&modified.subsec_nanos().to_le_bytes());
    hasher.update(&[u8::from(is_file), u8::from(is_dir)]);
    Ok(())
}

fn source_derived_projection_digest(
    workflow: &SourceWorkflowInstance,
) -> Result<String, ServerError> {
    let encoded = serde_json::to_vec(&(
        &workflow.parameters,
        &workflow.unsupported_required_parameters,
        &workflow.scopes,
        &workflow.invocations,
        &workflow.capabilities,
        &workflow.diagnostics,
    ))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"somite-source-derived-projection-v1\0");
    hasher.update(&encoded);
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

// The verified-object fast path is sound only when the metadata frame carries
// Unix device/inode/mode/link-count/size/mtime/ctime change tokens. Portable
// std metadata permits a same-length replacement with a restored modification
// time, so non-Unix builds deliberately cold-read/reindex on every check and
// then content-verify a second read instead of trusting a weak post-read frame.
const fn source_verification_metadata_cache_enabled() -> bool {
    cfg!(unix)
}

fn source_verification_gate(key: &SourceVerificationKey) -> &'static Mutex<()> {
    let gates = SOURCE_VERIFICATION_GATES.get_or_init(|| {
        (0..SOURCE_VERIFICATION_GATE_STRIPES)
            .map(|_| Mutex::new(()))
            .collect()
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    let stripe_count = u64::try_from(gates.len()).unwrap_or(1);
    let index = usize::try_from(hasher.finish() % stripe_count).unwrap_or_default();
    &gates[index]
}

fn verify_stored_source_instance_cached(
    root: &Path,
    workflow: &SourceWorkflowInstance,
) -> Result<(), ServerError> {
    let canonical_project_root = root.canonicalize()?;
    let key = (
        canonical_project_root,
        workflow.source.source_digest.clone(),
        SOURCE_INDEXER_REVISION.to_owned(),
    );
    let _verification_guard = source_verification_gate(&key)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stored = read_stored_source_instance_metadata(root, workflow)?;
    let canonical_source_root = stored.source_root.canonicalize()?;
    let metadata_fingerprint = stored.metadata_fingerprint;
    let derived_projection_digest = source_derived_projection_digest(workflow)?;
    if source_verification_metadata_cache_enabled() {
        let cache = VERIFIED_SOURCE_OBJECTS.get_or_init(|| Mutex::new(BTreeMap::new()));
        let verified = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if verified.get(&key).is_some_and(|token| {
            token.metadata_fingerprint == metadata_fingerprint
                && token.derived_projection_digest == derived_projection_digest
        }) {
            return Ok(());
        }
    }

    #[cfg(test)]
    SOURCE_COLD_VERIFICATIONS.fetch_add(1, Ordering::Relaxed);
    {
        let exact = read_stored_source_instance(root, workflow)?;
        verify_source_instance_derivation(exact)?;
    }
    let confirmed = read_stored_source_instance_metadata(root, workflow)?;
    let confirmed_root = confirmed.source_root.canonicalize()?;
    let confirmed_fingerprint = confirmed.metadata_fingerprint;
    if confirmed_root != canonical_source_root || confirmed_fingerprint != metadata_fingerprint {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow {} immutable source object changed during verification",
            workflow.workflow_revision
        )));
    }
    #[cfg(not(unix))]
    {
        // The second bounded read revalidates every per-file and aggregate
        // digest after the weak portable metadata confirmation above.
        let _confirmed_exact = read_stored_source_instance(root, workflow)?;
    }

    if source_verification_metadata_cache_enabled() {
        let cache = VERIFIED_SOURCE_OBJECTS.get_or_init(|| Mutex::new(BTreeMap::new()));
        let mut verified = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if verified.len() >= MAX_VERIFIED_SOURCE_OBJECTS && !verified.contains_key(&key) {
            if let Some(oldest_key) = verified.keys().next().cloned() {
                verified.remove(&oldest_key);
            }
        }
        verified.insert(
            key,
            SourceVerificationToken {
                metadata_fingerprint,
                derived_projection_digest,
                #[cfg(test)]
                cold_verification_sequence: SOURCE_VERIFICATION_SEQUENCE
                    .fetch_add(1, Ordering::Relaxed),
            },
        );
    }
    Ok(())
}

fn verify_source_instance_derivation(stored: StoredSourceInstance) -> Result<(), ServerError> {
    let StoredSourceInstance {
        workflow,
        manifest,
        files,
    } = stored;
    let frozen = into_frozen_source_files(files);
    let reindexed =
        somite_source_workflow::reindex_frozen(&manifest, &frozen, &workflow.source.entrypoint)
            .map_err(|error| ServerError::SourceWorkflow(error.to_string()))?;
    if reindexed.parameters != workflow.parameters
        || reindexed.unsupported_required_parameters != workflow.unsupported_required_parameters
        || reindexed.scopes != workflow.scopes
        || reindexed.invocations != workflow.invocations
        || reindexed.capabilities != workflow.capabilities
        || reindexed.diagnostics != workflow.diagnostics
    {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow {} derived index does not match its exact stored source bytes under {SOURCE_INDEXER_REVISION}; re-import the source workflow",
            workflow.workflow_revision
        )));
    }
    Ok(())
}

fn into_frozen_source_files(files: StoredSourceFiles) -> Vec<FrozenSourceFile> {
    files
        .into_iter()
        .map(|(entry, bytes)| FrozenSourceFile {
            path: entry.path,
            mode: entry.mode,
            bytes,
        })
        .collect()
}

fn verify_graph_source_store(root: &Path, graph: &Graph) -> Result<(), ServerError> {
    for node in graph.nodes.iter().chain(
        graph
            .variant_origin
            .iter()
            .map(|origin| &origin.source_node),
    ) {
        let Some(workflow) = &node.source_workflow else {
            continue;
        };
        verify_stored_source_instance_cached(root, workflow).map_err(|error| {
            ServerError::SourceWorkflow(format!(
                "source node {} failed stored identity verification: {error}",
                node.id
            ))
        })?;
        verify_source_project_bindings(root, workflow)?;
    }
    Ok(())
}

fn verify_source_project_bindings(
    root: &Path,
    workflow: &SourceWorkflowInstance,
) -> Result<(), ServerError> {
    let project_root = root.canonicalize().map_err(|error| {
        ServerError::SourceWorkflow(format!(
            "could not resolve the project root for source bindings: {error}"
        ))
    })?;
    for (parameter, binding) in &workflow.bindings {
        match binding {
            WorkflowBinding::ProjectFile { path } => verify_project_binding_path(
                &project_root,
                parameter,
                path,
                ProjectBindingKind::File,
            )?,
            WorkflowBinding::ProjectDirectory { path } => verify_project_binding_path(
                &project_root,
                parameter,
                path,
                ProjectBindingKind::Directory,
            )?,
            WorkflowBinding::Literal { .. } => {}
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ProjectBindingKind {
    File,
    Directory,
}

impl ProjectBindingKind {
    fn label(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

fn verify_project_binding_path(
    project_root: &Path,
    parameter: &str,
    relative: &str,
    kind: ProjectBindingKind,
) -> Result<(), ServerError> {
    if !safe_source_relative_path(relative) {
        return Err(ServerError::SourceWorkflow(format!(
            "source parameter {parameter} project {} path must be safe and relative",
            kind.label()
        )));
    }
    let components = Path::new(relative).components().collect::<Vec<_>>();
    let mut path = project_root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(component) = component else {
            return Err(ServerError::SourceWorkflow(format!(
                "source parameter {parameter} project {} path must be safe and relative",
                kind.label()
            )));
        };
        path.push(component);
        let final_component = index + 1 == components.len();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            ServerError::SourceWorkflow(format!(
                "source parameter {parameter} project {} {relative} is not available: {error}",
                kind.label()
            ))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(ServerError::SourceWorkflow(format!(
                "source parameter {parameter} project {} {relative} crosses a symlink",
                kind.label()
            )));
        }
        if !final_component && !metadata.is_dir() {
            return Err(ServerError::SourceWorkflow(format!(
                "source parameter {parameter} project {} {relative} crosses a non-directory component",
                kind.label()
            )));
        }
        if final_component {
            let expected_type = match kind {
                ProjectBindingKind::File => metadata.is_file(),
                ProjectBindingKind::Directory => metadata.is_dir(),
            };
            if !expected_type {
                return Err(ServerError::SourceWorkflow(format!(
                    "source parameter {parameter} project {} {relative} has the wrong file type",
                    kind.label()
                )));
            }
        }
    }
    Ok(())
}

async fn edit_source_workflow(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<SourceWorkflowEditRequest>,
) -> Result<Json<SourceWorkflowEditResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("source workflow edit", move || {
            edit_source_workflow_locked(&project, request)
        })
        .await?,
    ))
}

fn edit_source_workflow_locked(
    project: &WebProject,
    request: SourceWorkflowEditRequest,
) -> Result<SourceWorkflowEditResponse, ServerError> {
    if !(1..=64).contains(&request.edits.len()) {
        return Err(ServerError::SourceWorkflow(
            "source workflow transaction must contain between 1 and 64 edits".to_owned(),
        ));
    }
    let _guard = project
        .graph_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut graph = current_agent_graph(project)?;
    let current_state_revision = graph_state_revision(&graph)?;
    if request.base_state_revision != current_state_revision {
        return Err(ServerError::GraphStateConflict {
            provided: request.base_state_revision,
            current: current_state_revision,
        });
    }
    let base_workflow = graph_source_workflow(&graph)?.clone();
    if request.workflow_revision != base_workflow.workflow_revision {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow revision {} is stale; current workflow revision is {}",
            request.workflow_revision, base_workflow.workflow_revision
        )));
    }
    let stored = read_stored_source_instance_metadata(&project.root, &base_workflow)?;
    let edited = apply_checked_source_edit(
        &stored.workflow,
        &EditTransaction {
            base_workflow_revision: request.workflow_revision,
            edits: request.edits,
        },
    )?;
    verify_source_project_bindings(&project.root, &edited)?;
    let edited_metadata = StoredSourceInstanceMetadata {
        workflow: edited.clone(),
        manifest: stored.manifest,
        source_root: stored.source_root,
        metadata_fingerprint: stored.metadata_fingerprint,
    };
    graph.nodes[0].source_workflow = Some(edited);
    graph.validate()?;
    project.catalog.verify_graph(&graph)?;
    let _ = serialize_graph_with_limit(&graph, MAX_GRAPH_BYTES)?;
    let state_revision = graph_state_revision(&graph)?;
    let graph_revision = semantic_graph_revision(&graph)?;
    persist_source_instance_metadata(&project.root, &edited_metadata)?;
    verify_graph_source_store(&project.root, &graph)?;
    WebProject::write_graph_at(
        &project.root,
        &project.autosave_path(),
        &graph,
        &project.catalog,
    )?;
    Ok(SourceWorkflowEditResponse {
        state_revision,
        graph_revision,
        graph,
    })
}

fn apply_checked_source_edit(
    workflow: &SourceWorkflowInstance,
    transaction: &EditTransaction,
) -> Result<SourceWorkflowInstance, ServerError> {
    if transaction.edits.iter().any(|edit| {
        matches!(
            edit,
            SemanticEdit::SetParameter { .. } | SemanticEdit::ResetParameter { .. }
        )
    }) && !workflow.capabilities.parameter_edits
    {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow {} does not permit parameter edits",
            workflow.workflow_revision
        )));
    }
    apply_source_edit(workflow, transaction)
        .map_err(|error| ServerError::SourceWorkflow(error.to_string()))
}

async fn promote_source_workflow(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<SourceWorkflowPromotionRequest>,
) -> Result<Json<SourceWorkflowEditResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("source workflow promotion", move || {
            promote_source_workflow_locked(&project, request)
        })
        .await?,
    ))
}

fn promote_source_workflow_locked(
    project: &WebProject,
    request: SourceWorkflowPromotionRequest,
) -> Result<SourceWorkflowEditResponse, ServerError> {
    let _guard = project
        .graph_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let graph = current_agent_graph(project)?;
    let current_state_revision = graph_state_revision(&graph)?;
    if request.base_state_revision != current_state_revision {
        return Err(ServerError::GraphStateConflict {
            provided: request.base_state_revision,
            current: current_state_revision,
        });
    }
    let promoted = build_promoted_source_graph(
        project,
        &graph,
        &request.workflow_revision,
        &request.invocation_id,
    )?;
    WebProject::write_graph_at(
        &project.root,
        &project.autosave_path(),
        &promoted,
        &project.catalog,
    )?;
    Ok(SourceWorkflowEditResponse {
        state_revision: graph_state_revision(&promoted)?,
        graph_revision: semantic_graph_revision(&promoted)?,
        graph: promoted,
    })
}

fn build_promoted_source_graph(
    project: &WebProject,
    graph: &Graph,
    workflow_revision: &str,
    invocation_id: &str,
) -> Result<Graph, ServerError> {
    verify_graph_source_store(&project.root, graph)?;
    let workflow = graph_source_workflow(graph)?;
    if workflow_revision != workflow.workflow_revision {
        return Err(ServerError::SourceWorkflow(format!(
            "source workflow revision {} is stale; current workflow revision is {}",
            workflow_revision, workflow.workflow_revision
        )));
    }
    let replacement = workflow
        .replacements
        .iter()
        .find(|replacement| replacement.invocation_id == invocation_id)
        .ok_or_else(|| {
            ServerError::SourceWorkflow(format!(
                "source invocation {} has no selected replacement to promote",
                invocation_id
            ))
        })?;
    let operator = project.catalog.get(&replacement.operator)?;
    let node_id = promoted_node_id(&operator.id, invocation_id);
    let promoted_node = Node {
        id: node_id,
        operator: operator.id.clone(),
        operator_revision: operator.revision()?,
        ports: operator.ir_ports(),
        params: replacement.params.clone(),
        source_workflow: None,
        layout: graph.nodes[0].layout.clone(),
        note: None,
        color: graph.nodes[0].color,
    };
    let promoted = promote_invocation(graph, workflow_revision, invocation_id, promoted_node)
        .map_err(|error| ServerError::SourceWorkflow(error.to_string()))?;
    promoted.validate()?;
    project.catalog.verify_graph(&promoted)?;
    let _ = serialize_graph_with_limit(&promoted, MAX_GRAPH_BYTES)?;
    verify_graph_source_store(&project.root, &promoted)?;
    Ok(promoted)
}

fn promoted_node_id(operator: &str, invocation_id: &str) -> String {
    let base = operator
        .rsplit('.')
        .next()
        .unwrap_or("promoted")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let suffix = blake3::hash(invocation_id.as_bytes()).to_hex();
    format!("{}-{}", base.trim_matches('-'), &suffix[..8])
}

async fn restore_source_workflow_view(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<SourceWorkflowRestoreRequest>,
) -> Result<Json<SourceWorkflowEditResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("source workflow restore", move || {
            restore_source_workflow_view_locked(&project, request)
        })
        .await?,
    ))
}

fn restore_source_workflow_view_locked(
    project: &WebProject,
    request: SourceWorkflowRestoreRequest,
) -> Result<SourceWorkflowEditResponse, ServerError> {
    let _guard = project
        .graph_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let graph = current_agent_graph(project)?;
    let current_state_revision = graph_state_revision(&graph)?;
    if request.base_state_revision != current_state_revision {
        return Err(ServerError::GraphStateConflict {
            provided: request.base_state_revision,
            current: current_state_revision,
        });
    }
    verify_graph_source_store(&project.root, &graph)?;
    let restored = restore_source_workflow(&graph)
        .map_err(|error| ServerError::SourceWorkflow(error.to_string()))?;
    project.catalog.verify_graph(&restored)?;
    let _ = serialize_graph_with_limit(&restored, MAX_GRAPH_BYTES)?;
    verify_graph_source_store(&project.root, &restored)?;
    WebProject::write_graph_at(
        &project.root,
        &project.autosave_path(),
        &restored,
        &project.catalog,
    )?;
    Ok(SourceWorkflowEditResponse {
        state_revision: graph_state_revision(&restored)?,
        graph_revision: semantic_graph_revision(&restored)?,
        graph: restored,
    })
}

#[cfg(test)]
fn run_nfcore_preview(
    nextflow: &Path,
    work: &Path,
    request: &WorkflowGraphRequest,
    dot_path: &Path,
) -> std::io::Result<std::process::Output> {
    let output = run_nfcore_preview_attempt(nextflow, work, request, dot_path, None)?;
    if output.status.success() && dot_path.is_file()
        || !nfcore_preview_needs_legacy_parser(work, &output)
    {
        return Ok(output);
    }
    run_nfcore_preview_attempt(nextflow, work, request, dot_path, Some("v1"))
}

#[cfg(test)]
fn run_nfcore_preview_attempt(
    nextflow: &Path,
    work: &Path,
    request: &WorkflowGraphRequest,
    dot_path: &Path,
    syntax_parser: Option<&str>,
) -> std::io::Result<std::process::Output> {
    remove_preview_artifact(dot_path)?;
    remove_preview_artifact(&work.join(".nextflow.log"))?;
    let mut command = Command::new("timeout");
    command
        .arg("120s")
        .arg(nextflow)
        .args([
            "run",
            &request.workflow,
            "-r",
            &request.revision,
            "-profile",
            "test",
            "-preview",
            "-with-dag",
        ])
        .arg(dot_path)
        .args(["--outdir", "results"])
        .current_dir(work);
    match syntax_parser {
        Some(parser) => command.env("NXF_SYNTAX_PARSER", parser),
        None => command.env_remove("NXF_SYNTAX_PARSER"),
    };
    command.output()
}

#[cfg(test)]
fn remove_preview_artifact(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
fn nfcore_preview_needs_legacy_parser(work: &Path, output: &std::process::Output) -> bool {
    if output.status.code() == Some(124) {
        return false;
    }
    let evidence = nfcore_preview_failure_evidence(work, output).to_ascii_lowercase();
    evidence.contains("config parsing failed")
        || evidence.contains("configparseexception")
        || evidence.contains("_nf_config")
            && (evidence.contains(" is not defined @ line ")
                || evidence.contains("unexpected input"))
        || evidence.contains("configparserv2")
            && evidence.contains("multiplecompilationerrorsexception")
}

#[cfg(test)]
fn nfcore_preview_failure_evidence(work: &Path, output: &std::process::Output) -> String {
    let log = std::fs::read_to_string(work.join(".nextflow.log")).unwrap_or_default();
    format!(
        "{}\n{}\n{log}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

#[cfg(test)]
fn nfcore_preview_failure_detail(work: &Path, output: &std::process::Output) -> String {
    let log = std::fs::read_to_string(work.join(".nextflow.log")).unwrap_or_default();
    if let Some(detail) = concise_nextflow_log_failure(&log) {
        return detail;
    }
    if output.status.code() == Some(124) {
        return "Nextflow preview timed out after 120 seconds".to_owned();
    }
    last_nonempty_output_line(&output.stderr)
        .or_else(|| last_nonempty_output_line(&output.stdout))
        .unwrap_or_else(|| "Nextflow did not produce a DAG".to_owned())
}

#[cfg(test)]
fn concise_nextflow_log_failure(log: &str) -> Option<String> {
    let headline = log.lines().rev().find_map(|line| {
        let error = line
            .split_once(" ERROR ")
            .map(|(_, error)| error)
            .or_else(|| line.trim().strip_prefix("ERROR "))?;
        Some(
            error
                .rsplit_once(" - ")
                .map_or(error, |(_, message)| message)
                .trim()
                .to_owned(),
        )
    });
    let diagnostic = log.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.contains(" is not defined @ line ") && !trimmed.contains("Unexpected input") {
            return None;
        }
        let diagnostic = trimmed.find('`').map_or(trimmed, |start| &trimmed[start..]);
        Some(diagnostic.to_owned())
    });
    match (headline, diagnostic) {
        (Some(headline), Some(diagnostic)) if headline != diagnostic => {
            Some(format!("{headline}: {diagnostic}"))
        }
        (Some(headline), _) => Some(headline),
        (None, Some(diagnostic)) => Some(diagnostic),
        (None, None) => None,
    }
}

fn last_nonempty_output_line(output: &[u8]) -> Option<String> {
    String::from_utf8_lossy(output)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_owned())
}

async fn validate_graph(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<ValidationResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("workflow validation", move || {
            let mut graph = graph;
            project.catalog.pin_graph(&mut graph)?;
            reject_resolver_only_graph(&graph)?;
            verify_graph_source_store(&project.root, &graph)?;
            Ok(ValidationResponse { valid: true })
        })
        .await?,
    ))
}

async fn readiness_snapshot(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<WorkflowAssessment>, ServerError> {
    Ok(Json(
        run_server_blocking("workflow readiness", move || {
            let catalog = project.catalog.clone();
            let mut graph = graph;
            catalog.pin_graph(&mut graph)?;
            reject_resolver_only_graph(&graph)?;
            verify_graph_source_store(&project.root, &graph)?;
            assess(&graph, &catalog).map_err(ServerError::from)
        })
        .await?,
    ))
}

async fn save_graph(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<GraphWriteRequest>,
) -> Result<Json<GraphWriteResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("graph save", move || {
            let mut request = request;
            project.catalog.pin_graph(&mut request.graph)?;
            let state_revision =
                project.save_graph_cas(&request.base_state_revision, &request.graph)?;
            Ok(GraphWriteResponse {
                valid: true,
                state_revision,
            })
        })
        .await?,
    ))
}

async fn autosave_graph(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<GraphWriteRequest>,
) -> Result<Json<GraphWriteResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("graph autosave", move || {
            let mut request = request;
            project.catalog.pin_graph(&mut request.graph)?;
            let state_revision =
                project.save_autosave_cas(&request.base_state_revision, &request.graph)?;
            Ok(GraphWriteResponse {
                valid: true,
                state_revision,
            })
        })
        .await?,
    ))
}

#[derive(Debug, Serialize)]
struct AgentGraphResponse {
    state_revision: String,
    graph_revision: String,
    graph: Graph,
}

async fn agent_graph(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<AgentGraphResponse>, ServerError> {
    Ok(Json(
        run_server_blocking("agent graph read", move || {
            let graph = current_agent_graph(&project)?;
            let state_revision = graph_state_revision(&graph)?;
            let graph_revision = semantic_graph_revision(&graph)?;
            Ok(AgentGraphResponse {
                state_revision,
                graph_revision,
                graph,
            })
        })
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct AgentCatalogQuery {
    q: String,
    #[serde(default = "default_agent_catalog_limit")]
    limit: usize,
    #[serde(default)]
    cursor: Option<String>,
}

fn default_agent_catalog_limit() -> usize {
    12
}

fn add_catalog_terms(terms: &mut BTreeSet<String>, value: &str) {
    for term in value
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|term| !term.is_empty())
    {
        terms.insert(term.to_owned());
    }
}

fn operator_catalog_terms(operator: &Operator) -> BTreeSet<String> {
    let mut terms = BTreeSet::new();
    add_catalog_terms(&mut terms, &operator.id);
    add_catalog_terms(&mut terms, &operator.title);
    for value in operator.palette.iter().chain(operator.pixi.iter()) {
        add_catalog_terms(&mut terms, value);
    }
    if let Some(binary) = &operator.bin {
        add_catalog_terms(&mut terms, binary);
    }
    for (name, parameter) in &operator.params {
        add_catalog_terms(&mut terms, name);
        add_catalog_terms(&mut terms, &parameter.ty);
        if let Some(label) = &parameter.label {
            add_catalog_terms(&mut terms, label);
        }
        if let Some(page) = &parameter.page {
            add_catalog_terms(&mut terms, page);
        }
    }
    let ports = operator.ports.r#in.iter().chain(&operator.ports.out);
    for port in ports {
        add_catalog_terms(&mut terms, &port.name);
        add_catalog_terms(&mut terms, &format!("{:?}", port.ty));
        for ty in &port.union {
            add_catalog_terms(&mut terms, &format!("{ty:?}"));
        }
        if let Some(resource) = &port.resource {
            add_catalog_terms(&mut terms, &resource.profile);
            add_catalog_terms(&mut terms, &resource.title);
            add_catalog_terms(&mut terms, &resource.detail);
            for resolution in &resource.resolutions {
                add_catalog_terms(&mut terms, &resolution.label);
                add_catalog_terms(&mut terms, &resolution.detail);
                if let Some(effect) = &resolution.scientific_effect {
                    add_catalog_terms(&mut terms, effect);
                }
            }
        }
    }
    for (name, output) in &operator.outputs {
        add_catalog_terms(&mut terms, name);
        add_catalog_terms(&mut terms, &output.glob);
        add_catalog_terms(&mut terms, &format!("{:?}", output.ty));
    }

    let is_source = operator.ports.r#in.is_empty() && !operator.ports.out.is_empty();
    if is_source {
        add_catalog_terms(&mut terms, "source input entry local data");
    }
    if operator
        .palette
        .iter()
        .any(|palette| palette.eq_ignore_ascii_case("files"))
    {
        add_catalog_terms(&mut terms, "file files path local source input");
    }
    let has_fastq = operator
        .ports
        .r#in
        .iter()
        .chain(&operator.ports.out)
        .any(|port| format!("{:?}", port.ty).eq_ignore_ascii_case("fastq"));
    if has_fastq {
        add_catalog_terms(&mut terms, "fastq read reads sequence sequences");
    }
    let has_r1 = operator.ports.out.iter().any(|port| port.name == "r1");
    let has_r2 = operator.ports.out.iter().any(|port| port.name == "r2");
    if has_r1 && has_r2 {
        add_catalog_terms(&mut terms, "paired pair mate mates r1 r2");
    }
    terms
}

fn catalog_search_score(operator: &Operator, query_terms: &[String]) -> Option<(u32, Vec<String>)> {
    let operator_terms = operator_catalog_terms(operator);
    let mut matched = 0_u32;
    let mut exact = 0_u32;
    let mut matched_terms = Vec::new();
    for query in query_terms {
        let exact_match = operator_terms.contains(query);
        let prefix_match = query.len() >= 3
            && operator_terms
                .iter()
                .any(|candidate| candidate.starts_with(query));
        if exact_match || prefix_match {
            matched += 1;
            exact += u32::from(exact_match);
            matched_terms.push(query.clone());
        }
    }
    if matched == 0 || (query_terms.len() > 1 && matched < 2) {
        return None;
    }
    let complete = usize::try_from(matched).ok() == Some(query_terms.len());
    let first = &query_terms[0];
    let starts = operator.id.to_ascii_lowercase().starts_with(first)
        || operator.title.to_ascii_lowercase().starts_with(first);
    Some((
        matched * 100 + exact * 10 + u32::from(complete) * 50 + u32::from(starts) * 25,
        matched_terms,
    ))
}

#[derive(Debug, Serialize)]
struct AgentCatalogMatch {
    #[serde(flatten)]
    contract: CatalogOperator,
    score: u32,
    matched_terms: Vec<String>,
}

#[derive(Debug, Serialize)]
struct AgentCatalogResponse {
    query: String,
    catalog_revision: String,
    total_matches: usize,
    next_cursor: Option<String>,
    matches: Vec<AgentCatalogMatch>,
}

fn catalog_cursor(catalog_revision: &str, offset: usize) -> String {
    format!(
        "somite-catalog-v1-{}-{offset}",
        catalog_revision
            .strip_prefix("blake3:")
            .unwrap_or(catalog_revision)
    )
}

fn resolver_only_operator_id(operator_id: &str) -> bool {
    operator_id.starts_with("nf.") || operator_id.starts_with("smk.")
}

fn reject_resolver_only_graph(graph: &Graph) -> Result<(), ServerError> {
    if let Some(node) = graph
        .nodes
        .iter()
        .find(|node| resolver_only_operator_id(&node.operator))
    {
        return Err(ServerError::SourceWorkflow(format!(
            "node {} uses resolver-only operator {}; import its canonical workflow instead",
            node.id, node.operator
        )));
    }
    Ok(())
}

fn catalog_cursor_offset(
    cursor: Option<&str>,
    catalog_revision: &str,
) -> Result<usize, agent::AgentError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let prefix = catalog_cursor(catalog_revision, 0)
        .strip_suffix('0')
        .expect("catalog cursor suffix")
        .to_owned();
    cursor
        .strip_prefix(&prefix)
        .and_then(|offset| offset.parse::<usize>().ok())
        .ok_or_else(|| agent::AgentError::InvalidIdentifier(cursor.to_owned()))
}

async fn agent_catalog(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<AgentCatalogQuery>,
) -> Result<Json<AgentCatalogResponse>, ServerError> {
    let query = request.q.trim();
    if query.is_empty() || query.len() > 120 || query.chars().any(char::is_control) {
        return Err(ServerError::Agent(agent::AgentError::InvalidIdentifier(
            request.q,
        )));
    }
    let mut query_terms = BTreeSet::new();
    add_catalog_terms(&mut query_terms, query);
    let query_terms = query_terms.into_iter().collect::<Vec<_>>();
    let catalog = project.catalog.clone();
    let catalog_revision = catalog.catalog_revision()?;
    let offset = catalog_cursor_offset(request.cursor.as_deref(), &catalog_revision)?;
    let mut matches = catalog
        .ops
        .values()
        .filter(|operator| {
            operator.kind != OpKind::Source && !resolver_only_operator_id(&operator.id)
        })
        .filter_map(|operator| {
            catalog_search_score(operator, &query_terms).map(|(score, matched_terms)| {
                (
                    std::cmp::Reverse(score),
                    operator.id.clone(),
                    operator.clone(),
                    matched_terms,
                )
            })
        })
        .collect::<Vec<_>>();
    if query_terms.len() > 1
        && matches
            .iter()
            .any(|(_, _, _, matched_terms)| matched_terms.len() == query_terms.len())
    {
        matches.retain(|(_, _, _, matched_terms)| matched_terms.len() == query_terms.len());
    }
    matches.sort_by(|left, right| (&left.0, &left.1).cmp(&(&right.0, &right.1)));
    let total_matches = matches.len();
    if offset > total_matches {
        return Err(ServerError::Agent(agent::AgentError::InvalidIdentifier(
            request.cursor.unwrap_or_default(),
        )));
    }
    let limit = request.limit.clamp(1, 50);
    let next_offset = offset.saturating_add(limit);
    let next_cursor =
        (next_offset < total_matches).then(|| catalog_cursor(&catalog_revision, next_offset));
    let matches = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(score, _, operator, matched_terms)| {
            Ok(AgentCatalogMatch {
                contract: CatalogOperator {
                    revision: operator.revision()?,
                    operator,
                },
                score: score.0,
                matched_terms,
            })
        })
        .collect::<Result<Vec<_>, somite_ops::OpsError>>()?;
    Ok(Json(AgentCatalogResponse {
        query: query.to_owned(),
        catalog_revision,
        total_matches,
        next_cursor,
        matches,
    }))
}

async fn agent_transaction(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<GraphTransaction>,
) -> Result<Json<AgentTransactionResponse>, ServerError> {
    let request_digest = content_digest(&serde_json::to_vec(&request)?);
    let idempotency_key = request.idempotency_key.clone();
    let (result, replayed) = {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut replays = project
            .transaction_replays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(replay) = replays.get(&idempotency_key) {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            (replay.result.clone(), true)
        } else {
            let graph = current_agent_graph(&project)?;
            let catalog = project.catalog.clone();
            let result = agent::apply_graph_transaction(
                &graph,
                &catalog,
                request,
                project.next_id("transaction"),
            )?;
            verify_graph_source_store(&project.root, &result.graph)?;
            WebProject::write_graph_at(
                &project.root,
                &project.autosave_path(),
                &result.graph,
                &catalog,
            )?;
            if replays.len() >= MAX_GRAPH_TRANSACTION_REPLAYS {
                if let Some(oldest_key) = replays
                    .iter()
                    .min_by_key(|(_, replay)| replay.sequence)
                    .map(|(key, _)| key.clone())
                {
                    replays.remove(&oldest_key);
                }
            }
            replays.insert(
                idempotency_key,
                TransactionReplay {
                    request_digest,
                    result: result.clone(),
                    sequence: project.replay_sequence.fetch_add(1, Ordering::Relaxed),
                },
            );
            (result, false)
        }
    };
    if !replayed {
        project.agent.record_transaction(result.clone());
    }
    Ok(Json(AgentTransactionResponse { result, replayed }))
}

async fn agent_import_nfcore_source(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<AgentNfcoreSourceImportRequest>,
) -> Result<Json<AgentTransactionResponse>, ServerError> {
    if !agent::valid_idempotency_key(&request.idempotency_key) {
        return Err(ServerError::Agent(agent::AgentError::InvalidIdempotencyKey));
    }
    let summary = request.summary.trim();
    if summary.is_empty() || summary.chars().count() > 240 || summary.chars().any(char::is_control)
    {
        return Err(ServerError::Agent(agent::AgentError::InvalidSummary));
    }
    let workflow_request = WorkflowGraphRequest {
        workflow: request.workflow.clone(),
        revision: request.revision.clone(),
    };
    validate_nfcore_workflow_request(&workflow_request)?;
    let request_digest = content_digest(&serde_json::to_vec(&request)?);

    {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let replays = project
            .transaction_replays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(replay) = replays.get(&request.idempotency_key) {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            return Ok(Json(AgentTransactionResponse {
                result: replay.result.clone(),
                replayed: true,
            }));
        }
        let current = current_agent_graph(&project)?;
        let current_revision = graph_state_revision(&current)?;
        if request.base_state_revision != current_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleTransaction {
                actual: request.base_state_revision,
                expected: current_revision,
            }));
        }
        if !current.nodes.is_empty() || !current.edges.is_empty() {
            return Err(ServerError::Agent(
                agent::AgentError::SourceImportRequiresEmptyCanvas,
            ));
        }
    }

    let root = project.root.clone();
    let source_operator_revision = project.catalog.revision("workflow.source")?;
    let resolved = tokio::task::spawn_blocking(move || {
        import_nfcore_source(&root, &workflow_request, &source_operator_revision, None)
    })
    .await
    .map_err(|error| ServerError::WorkflowImport(error.to_string()))??;

    let result = {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut replays = project
            .transaction_replays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(replay) = replays.get(&request.idempotency_key) {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            return Ok(Json(AgentTransactionResponse {
                result: replay.result.clone(),
                replayed: true,
            }));
        }

        let current = current_agent_graph(&project)?;
        let previous_state_revision = graph_state_revision(&current)?;
        if request.base_state_revision != previous_state_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleTransaction {
                actual: request.base_state_revision,
                expected: previous_state_revision,
            }));
        }
        if !current.nodes.is_empty() || !current.edges.is_empty() {
            return Err(ServerError::Agent(
                agent::AgentError::SourceImportRequiresEmptyCanvas,
            ));
        }

        let mut graph = resolved.graph;
        graph.annotations = current.annotations;
        if current.name.is_some() {
            graph.name = current.name;
        }
        project.catalog.verify_graph(&graph)?;
        verify_graph_source_store(&project.root, &graph)?;
        let result = TransactionResult {
            transaction_id: project.next_id("transaction"),
            previous_state_revision,
            state_revision: graph_state_revision(&graph)?,
            graph_revision: semantic_graph_revision(&graph)?,
            summary: summary.to_owned(),
            graph,
        };
        WebProject::write_graph_at(
            &project.root,
            &project.autosave_path(),
            &result.graph,
            &project.catalog,
        )?;
        if replays.len() >= MAX_GRAPH_TRANSACTION_REPLAYS {
            if let Some(oldest_key) = replays
                .iter()
                .min_by_key(|(_, replay)| replay.sequence)
                .map(|(key, _)| key.clone())
            {
                replays.remove(&oldest_key);
            }
        }
        replays.insert(
            request.idempotency_key,
            TransactionReplay {
                request_digest,
                result: result.clone(),
                sequence: project.replay_sequence.fetch_add(1, Ordering::Relaxed),
            },
        );
        result
    };
    project.agent.record_transaction(result.clone());
    Ok(Json(AgentTransactionResponse {
        result,
        replayed: false,
    }))
}

async fn agent_edit_source_workflow(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<AgentSourceWorkflowEditRequest>,
) -> Result<Json<AgentTransactionResponse>, ServerError> {
    agent_edit_source_workflow_with_phase_two_hook(project, request, |_| {})
}

fn agent_edit_source_workflow_with_phase_two_hook(
    project: Arc<WebProject>,
    request: AgentSourceWorkflowEditRequest,
    before_phase_two: impl FnOnce(&WebProject),
) -> Result<Json<AgentTransactionResponse>, ServerError> {
    if !agent::valid_idempotency_key(&request.idempotency_key) {
        return Err(ServerError::Agent(agent::AgentError::InvalidIdempotencyKey));
    }
    let summary = request.summary.trim();
    if summary.is_empty() || summary.chars().count() > 240 || summary.chars().any(char::is_control)
    {
        return Err(ServerError::Agent(agent::AgentError::InvalidSummary));
    }
    if !(1..=64).contains(&request.edits.len()) {
        return Err(ServerError::Agent(
            agent::AgentError::InvalidSourceEditCount,
        ));
    }
    let request_digest = content_digest(&serde_json::to_vec(&request)?);

    let base_workflow = {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let replays = project
            .transaction_replays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(replay) = replays.get(&request.idempotency_key) {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            return Ok(Json(AgentTransactionResponse {
                result: replay.result.clone(),
                replayed: true,
            }));
        }
        let current = current_agent_graph(&project)?;
        let current_state_revision = graph_state_revision(&current)?;
        if request.base_state_revision != current_state_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleTransaction {
                actual: request.base_state_revision,
                expected: current_state_revision,
            }));
        }
        let workflow = graph_source_workflow(&current)?;
        if request.workflow_revision != workflow.workflow_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleSourceWorkflow {
                actual: request.workflow_revision,
                expected: workflow.workflow_revision.clone(),
            }));
        }
        workflow.clone()
    };

    let stored = read_stored_source_instance_metadata(&project.root, &base_workflow)?;
    let edited = apply_checked_source_edit(
        &stored.workflow,
        &EditTransaction {
            base_workflow_revision: request.workflow_revision.clone(),
            edits: request.edits.clone(),
        },
    )?;
    verify_source_project_bindings(&project.root, &edited)?;
    let edited_metadata = StoredSourceInstanceMetadata {
        workflow: edited.clone(),
        manifest: stored.manifest,
        source_root: stored.source_root,
        metadata_fingerprint: stored.metadata_fingerprint,
    };
    before_phase_two(&project);

    let result = {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut replays = project
            .transaction_replays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(replay) = replays.get(&request.idempotency_key) {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            return Ok(Json(AgentTransactionResponse {
                result: replay.result.clone(),
                replayed: true,
            }));
        }
        let mut graph = current_agent_graph(&project)?;
        let previous_state_revision = graph_state_revision(&graph)?;
        if request.base_state_revision != previous_state_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleTransaction {
                actual: request.base_state_revision,
                expected: previous_state_revision,
            }));
        }
        let current_workflow_revision = graph_source_workflow(&graph)?.workflow_revision.clone();
        if request.workflow_revision != current_workflow_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleSourceWorkflow {
                actual: request.workflow_revision,
                expected: current_workflow_revision,
            }));
        }
        let node = graph.nodes.first_mut().ok_or(ServerError::Agent(
            agent::AgentError::SourceWorkflowNotFound,
        ))?;
        node.source_workflow = Some(edited);
        graph.validate()?;
        project.catalog.verify_graph(&graph)?;
        let _ = serialize_graph_with_limit(&graph, MAX_GRAPH_BYTES)?;
        let state_revision = graph_state_revision(&graph)?;
        let graph_revision = semantic_graph_revision(&graph)?;
        persist_source_instance_metadata(&project.root, &edited_metadata)?;
        verify_graph_source_store(&project.root, &graph)?;
        let result = TransactionResult {
            transaction_id: project.next_id("transaction"),
            previous_state_revision,
            state_revision,
            graph_revision,
            summary: summary.to_owned(),
            graph,
        };
        WebProject::write_graph_at(
            &project.root,
            &project.autosave_path(),
            &result.graph,
            &project.catalog,
        )?;
        if replays.len() >= MAX_GRAPH_TRANSACTION_REPLAYS {
            if let Some(oldest_key) = replays
                .iter()
                .min_by_key(|(_, replay)| replay.sequence)
                .map(|(key, _)| key.clone())
            {
                replays.remove(&oldest_key);
            }
        }
        replays.insert(
            request.idempotency_key,
            TransactionReplay {
                request_digest,
                result: result.clone(),
                sequence: project.replay_sequence.fetch_add(1, Ordering::Relaxed),
            },
        );
        result
    };
    project.agent.record_transaction(result.clone());
    Ok(Json(AgentTransactionResponse {
        result,
        replayed: false,
    }))
}

async fn agent_promote_source_workflow(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<AgentSourceWorkflowPromotionRequest>,
) -> Result<Json<AgentTransactionResponse>, ServerError> {
    if !agent::valid_idempotency_key(&request.idempotency_key) {
        return Err(ServerError::Agent(agent::AgentError::InvalidIdempotencyKey));
    }
    let summary = request.summary.trim();
    if summary.is_empty() || summary.chars().count() > 240 || summary.chars().any(char::is_control)
    {
        return Err(ServerError::Agent(agent::AgentError::InvalidSummary));
    }
    if request.invocation_id.is_empty()
        || request.invocation_id.len() > 512
        || request.invocation_id.chars().any(char::is_control)
    {
        return Err(ServerError::SourceWorkflow(
            "source invocation id must contain 1 to 512 printable bytes".to_owned(),
        ));
    }
    let request_digest = content_digest(&serde_json::to_vec(&request)?);
    let result = {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut replays = project
            .transaction_replays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(replay) = replays.get(&request.idempotency_key) {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            return Ok(Json(AgentTransactionResponse {
                result: replay.result.clone(),
                replayed: true,
            }));
        }

        let graph = current_agent_graph(&project)?;
        let previous_state_revision = graph_state_revision(&graph)?;
        if request.base_state_revision != previous_state_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleTransaction {
                actual: request.base_state_revision,
                expected: previous_state_revision,
            }));
        }
        let workflow = graph_source_workflow(&graph)?;
        if request.workflow_revision != workflow.workflow_revision {
            return Err(ServerError::Agent(agent::AgentError::StaleSourceWorkflow {
                actual: request.workflow_revision,
                expected: workflow.workflow_revision.clone(),
            }));
        }
        let promoted = build_promoted_source_graph(
            &project,
            &graph,
            &workflow.workflow_revision,
            &request.invocation_id,
        )?;
        let result = TransactionResult {
            transaction_id: project.next_id("transaction"),
            previous_state_revision,
            state_revision: graph_state_revision(&promoted)?,
            graph_revision: semantic_graph_revision(&promoted)?,
            summary: summary.to_owned(),
            graph: promoted,
        };
        WebProject::write_graph_at(
            &project.root,
            &project.autosave_path(),
            &result.graph,
            &project.catalog,
        )?;
        if replays.len() >= MAX_GRAPH_TRANSACTION_REPLAYS {
            if let Some(oldest_key) = replays
                .iter()
                .min_by_key(|(_, replay)| replay.sequence)
                .map(|(key, _)| key.clone())
            {
                replays.remove(&oldest_key);
            }
        }
        replays.insert(
            request.idempotency_key,
            TransactionReplay {
                request_digest,
                result: result.clone(),
                sequence: project.replay_sequence.fetch_add(1, Ordering::Relaxed),
            },
        );
        result
    };
    project.agent.record_transaction(result.clone());
    Ok(Json(AgentTransactionResponse {
        result,
        replayed: false,
    }))
}

fn graph_source_workflow(graph: &Graph) -> Result<&SourceWorkflowInstance, ServerError> {
    if graph.nodes.len() != 1 || !graph.edges.is_empty() {
        return Err(ServerError::Agent(
            agent::AgentError::SourceWorkflowNotFound,
        ));
    }
    graph.nodes[0]
        .source_workflow
        .as_ref()
        .ok_or(ServerError::Agent(
            agent::AgentError::SourceWorkflowNotFound,
        ))
}

#[derive(Debug, Serialize)]
struct AgentTransactionResponse {
    #[serde(flatten)]
    result: TransactionResult,
    replayed: bool,
}

#[derive(Debug, Serialize)]
struct AgentCompileResponse {
    source_graph_revision: String,
    closure_digest: String,
    compiled_graph_revision: String,
    output_path: String,
    reused: bool,
}

async fn agent_compile(
    State(project): State<Arc<WebProject>>,
    Json(_request): Json<Value>,
) -> Result<Json<AgentCompileResponse>, ServerError> {
    let source_graph = current_agent_graph(&project)?;
    let source_graph_revision = semantic_graph_revision(&source_graph)?;
    let (graph, catalog, target) = production_inputs(&project, &source_graph)?;
    require_ready(&graph, &catalog)?;
    let pixi = project
        .pixi
        .clone()
        .ok_or_else(|| ServerError::Run("Pixi is required to compile this workflow".to_owned()))?;
    let compiled_root = project.root.join(".somite/compiled");
    let temporary = compiled_root.join(format!(".{}.partial", project.next_id("compile")));
    let temporary_for_task = temporary.clone();
    let compiled_root_for_task = compiled_root.clone();
    let (closure, output, reused) = tokio::task::spawn_blocking(move || {
        let result = create_frozen_package_with_pixi(
            &graph,
            &catalog,
            &target,
            &temporary_for_task,
            executable,
            &pixi,
        );
        match result {
            Ok(package) => {
                let key = package
                    .closure
                    .closure_digest
                    .strip_prefix("blake3:")
                    .unwrap_or(&package.closure.closure_digest);
                let output = compiled_root_for_task.join(key);
                let reused = if output.join("run-closure.json").is_file() {
                    let _ = std::fs::remove_dir_all(&temporary_for_task);
                    true
                } else {
                    match std::fs::rename(&temporary_for_task, &output) {
                        Ok(()) => false,
                        Err(_) if output.join("run-closure.json").is_file() => {
                            let _ = std::fs::remove_dir_all(&temporary_for_task);
                            true
                        }
                        Err(error) => return Err(somite_bundle::BundleError::from(error)),
                    }
                };
                Ok((package.closure, output, reused))
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temporary_for_task);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| ServerError::Run(format!("compile task failed: {error}")))??;
    let display = display_path(&project.root, &output);
    Ok(Json(AgentCompileResponse {
        source_graph_revision,
        closure_digest: closure.closure_digest,
        compiled_graph_revision: closure.graph_revision,
        output_path: display,
        reused,
    }))
}

#[derive(Debug, Deserialize)]
struct AgentEvidenceQuery {
    subject: Option<String>,
}

#[derive(Debug, Serialize)]
struct AgentEvidenceResponse {
    subject_digest: String,
    receipts: Vec<EvidenceReceipt>,
}

async fn agent_evidence(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<AgentEvidenceQuery>,
) -> Result<Json<AgentEvidenceResponse>, ServerError> {
    let subject_digest = match request.subject {
        Some(subject) if !subject.trim().is_empty() && subject.len() <= 160 => subject,
        Some(subject) => {
            return Err(ServerError::Agent(agent::AgentError::InvalidIdentifier(
                subject,
            )))
        }
        None => {
            let graph = current_agent_graph(&project)?;
            semantic_graph_revision(&graph)?
        }
    };
    let index = read_evidence_index(&project.root.join(".somite/evidence"))?;
    let receipts = index
        .receipts
        .into_iter()
        .filter(|receipt| receipt.subject_digest == subject_digest)
        .collect();
    Ok(Json(AgentEvidenceResponse {
        subject_digest,
        receipts,
    }))
}

#[derive(Debug, Deserialize)]
struct AgentConnectRequest {
    command: String,
}

async fn agent_connect(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<AgentConnectRequest>,
) -> Result<(StatusCode, Json<AgentSnapshot>), ServerError> {
    let snapshot = project.agent.connect(request.command).await?;
    Ok((StatusCode::ACCEPTED, Json(snapshot)))
}

#[derive(Debug, Deserialize)]
struct AgentConfigRequest {
    config_id: String,
    value: AgentConfigValue,
}

async fn agent_set_config(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<AgentConfigRequest>,
) -> Result<Json<AgentSnapshot>, ServerError> {
    Ok(Json(
        project
            .agent
            .set_config(request.config_id, request.value)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct AgentPromptRequest {
    message: String,
    base_state_revision: String,
    graph: Graph,
}

async fn agent_prompt(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<AgentPromptRequest>,
) -> Result<(StatusCode, Json<GraphWriteResponse>), ServerError> {
    let message = request.message;
    project.agent.preflight_prompt(&message)?;
    let state_revision = run_server_blocking("agent prompt graph commit", {
        let project = project.clone();
        move || {
            let mut graph = request.graph;
            project.catalog.pin_graph(&mut graph)?;
            project.save_autosave_cas(&request.base_state_revision, &graph)
        }
    })
    .await?;
    project.agent.prompt(message).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(GraphWriteResponse {
            valid: true,
            state_revision,
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct AgentEventsQuery {
    #[serde(default)]
    after: u64,
}

async fn agent_events(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<AgentEventsQuery>,
) -> Result<Json<AgentSnapshot>, ServerError> {
    let snapshot = run_server_blocking("authoritative agent event snapshot", move || {
        // Capture the event batch first. The graph revision is then read under
        // the same lock used by every server mutation, so it represents this
        // complete batch or a state that superseded it.
        let mut snapshot = project.agent.snapshot_after(request.after);
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let graph = current_agent_graph(&project)?;
        snapshot.authoritative_state_revision = Some(graph_state_revision(&graph)?);
        Ok(snapshot)
    })
    .await?;
    Ok(Json(snapshot))
}

async fn agent_transcript(State(project): State<Arc<WebProject>>) -> Json<AgentTranscript> {
    Json(project.agent.transcript())
}

async fn agent_cancel(State(project): State<Arc<WebProject>>) -> Result<StatusCode, ServerError> {
    project.agent.cancel().await?;
    Ok(StatusCode::ACCEPTED)
}

async fn agent_disconnect(
    State(project): State<Arc<WebProject>>,
) -> Result<StatusCode, ServerError> {
    project.agent.disconnect().await?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct AgentPermissionRequest {
    option_id: Option<String>,
}

async fn agent_permission(
    State(project): State<Arc<WebProject>>,
    AxumPath(permission_id): AxumPath<String>,
    Json(request): Json<AgentPermissionRequest>,
) -> Result<StatusCode, ServerError> {
    project
        .agent
        .answer_permission(&permission_id, request.option_id)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

fn checked_existing_graph_path(root: &Path, path: &Path) -> Result<PathBuf, ServerError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ServerError::UnsafeGraphPath(format!(
            "{} is not a readable regular file: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ServerError::UnsafeGraphPath(format!(
            "{} must be a regular non-symlink file",
            path.display()
        )));
    }
    let canonical = path.canonicalize()?;
    let canonical_root = root.canonicalize()?;
    if !canonical.starts_with(&canonical_root) {
        return Err(ServerError::UnsafeGraphPath(format!(
            "{} escapes the canonical project root {}",
            path.display(),
            canonical_root.display()
        )));
    }
    checked_graph_write_path(&canonical_root, &canonical)?;
    Ok(canonical)
}

fn checked_graph_write_path(root: &Path, path: &Path) -> Result<(PathBuf, PathBuf), ServerError> {
    let canonical_root = root.canonicalize()?;
    let parent = path.parent().ok_or_else(|| {
        ServerError::UnsafeGraphPath(format!("{} has no parent directory", path.display()))
    })?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        ServerError::UnsafeGraphPath(format!(
            "graph parent {} is not available: {error}",
            parent.display()
        ))
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(ServerError::UnsafeGraphPath(format!(
            "graph parent {} must be a regular non-symlink directory",
            parent.display()
        )));
    }
    let canonical_parent = parent.canonicalize()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(ServerError::UnsafeGraphPath(format!(
            "graph parent {} escapes the canonical project root {}",
            parent.display(),
            canonical_root.display()
        )));
    }
    let filename = path.file_name().ok_or_else(|| {
        ServerError::UnsafeGraphPath(format!("{} has no filename", path.display()))
    })?;
    let destination = canonical_parent.join(filename);
    if destination != path {
        return Err(ServerError::UnsafeGraphPath(format!(
            "graph path {} is not canonical within its project parent",
            path.display()
        )));
    }
    match std::fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(ServerError::UnsafeGraphPath(format!(
                "{} must be a regular non-symlink file",
                destination.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ServerError::Io(error)),
    }
    Ok((canonical_parent, destination))
}

fn read_graph_file(root: &Path, path: &Path) -> Result<Vec<u8>, ServerError> {
    let (_, destination) = checked_graph_write_path(root, path)?;
    let before_open = std::fs::symlink_metadata(&destination)?;
    if before_open.file_type().is_symlink() || !before_open.is_file() {
        return Err(ServerError::UnsafeGraphPath(format!(
            "{} must be a regular non-symlink file",
            destination.display()
        )));
    }
    let file = std::fs::File::open(&destination)?;
    let opened = file.metadata()?;
    if !opened.is_file() || !same_file_identity(&before_open, &opened) {
        return Err(ServerError::UnsafeGraphPath(format!(
            "{} changed while it was being opened",
            destination.display()
        )));
    }
    if opened.len() > MAX_GRAPH_BYTES {
        return Err(ServerError::UnsafeGraphPath(format!(
            "{} exceeds the {MAX_GRAPH_BYTES} byte graph limit",
            destination.display()
        )));
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_GRAPH_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_GRAPH_BYTES {
        return Err(ServerError::UnsafeGraphPath(format!(
            "{} exceeds the {MAX_GRAPH_BYTES} byte graph limit",
            destination.display()
        )));
    }
    Ok(bytes)
}

fn current_agent_graph(project: &WebProject) -> Result<Graph, ServerError> {
    let recovery_path = project.autosave_path();
    let catalog = project.catalog.clone();
    let mut graph = if let Some(graph) = read_valid_graph(&project.root, &recovery_path, &catalog)?
    {
        graph
    } else {
        let raw = read_graph_file(&project.root, &project.graph_path)?;
        serde_json::from_slice::<Graph>(&raw)?
    };
    catalog.pin_graph(&mut graph)?;
    workflow::upgrade_reference_ports(&mut graph);
    graph.validate()?;
    reject_resolver_only_graph(&graph)?;
    catalog.verify_graph(&graph)?;
    verify_graph_source_store(&project.root, &graph)?;
    Ok(graph)
}

async fn start_run(
    State(project): State<Arc<WebProject>>,
    Query(query): Query<RunStartQuery>,
    Json(graph): Json<Graph>,
) -> Result<(StatusCode, Json<RunStartResponse>), ServerError> {
    let request_digest = content_digest(&serde_json::to_vec(&("run", &graph))?);
    let (graph, catalog, target) = run_server_blocking("run readiness", {
        let project = project.clone();
        move || {
            let inputs = production_inputs(&project, &graph)?;
            require_ready(&inputs.0, &inputs.1)?;
            Ok(inputs)
        }
    })
    .await?;
    queue_run(
        &project,
        graph,
        catalog,
        target,
        None,
        query.idempotency_key.as_deref(),
        request_digest,
    )
}

async fn start_validation(
    State(project): State<Arc<WebProject>>,
    Query(query): Query<RunStartQuery>,
    Json(graph): Json<Graph>,
) -> Result<(StatusCode, Json<RunStartResponse>), ServerError> {
    let request_digest = content_digest(&serde_json::to_vec(&("validation", &graph))?);
    let (graph, catalog, target, validation) = run_server_blocking("validation readiness", {
        let project = project.clone();
        move || {
            let readiness_catalog = project.catalog.clone();
            let mut readiness_graph = graph.clone();
            readiness_catalog.pin_graph(&mut readiness_graph)?;
            verify_graph_source_store(&project.root, &readiness_graph)?;
            require_ready(&readiness_graph, &readiness_catalog)?;
            validation_inputs(&project, &graph)
        }
    })
    .await?;
    queue_run(
        &project,
        graph,
        catalog,
        target,
        Some(validation),
        query.idempotency_key.as_deref(),
        request_digest,
    )
}

fn require_ready(graph: &Graph, catalog: &Catalog) -> Result<(), ServerError> {
    let snapshot = assess(graph, catalog)?;
    if snapshot.is_ready() {
        return Ok(());
    }
    let detail = match snapshot.state {
        AssessmentState::Empty => "add at least one operator".to_owned(),
        _ => {
            let requirements = snapshot
                .items
                .iter()
                .map(|item| format!("{}: {}", item.title, item.detail))
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "resolve {} required item{}: {requirements}",
                snapshot.required_count,
                if snapshot.required_count == 1 {
                    ""
                } else {
                    "s"
                }
            )
        }
    };
    Err(ServerError::NotReady(detail))
}

fn queue_run(
    project: &Arc<WebProject>,
    graph: Graph,
    catalog: Catalog,
    target: ExportTarget,
    validation: Option<ValidationContext>,
    idempotency_key: Option<&str>,
    request_digest: String,
) -> Result<(StatusCode, Json<RunStartResponse>), ServerError> {
    let mut replays = project
        .run_replays
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(key) = idempotency_key {
        if !agent::valid_idempotency_key(key) {
            return Err(ServerError::Agent(agent::AgentError::InvalidIdempotencyKey));
        }
        if let Some(replay) = replays.get(key).cloned() {
            if replay.request_digest != request_digest {
                return Err(ServerError::Agent(agent::AgentError::IdempotencyConflict));
            }
            let mut result = replay.result.clone();
            result.replayed = true;
            return Ok((StatusCode::ACCEPTED, Json(result)));
        }
    }

    let run_id = project.next_id(if validation.is_some() {
        "validation"
    } else {
        "run"
    });
    let package = project.root.join(".somite/runs").join(&run_id);
    let states = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), RunNodeState::Queued))
        .collect();
    let (cancel, cancel_rx) = watch::channel(false);
    let job = Arc::new(RunJob {
        package,
        status: Mutex::new(RunStatusResponse {
            run_id: run_id.clone(),
            phase: RunPhase::Preparing,
            states,
            closure_digest: None,
            exit_code: None,
            error: None,
            evidence_receipt: None,
            progress: RunProgress {
                completed: 0,
                total: graph.nodes.len(),
                unit: "nodes",
                message: "Preparing workflow".to_owned(),
            },
        }),
        pending_terminal: Mutex::new(None),
        cancel,
        validation,
    });
    project
        .runs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(run_id.clone(), Arc::clone(&job));

    let pixi = project.pixi.clone();
    tokio::spawn(execute_run(job, graph, catalog, target, pixi, cancel_rx));

    let result = RunStartResponse {
        run_id,
        phase: RunPhase::Preparing,
        replayed: false,
    };
    if let Some(key) = idempotency_key {
        if replays.len() >= 1_024 {
            if let Some(oldest_key) = replays
                .iter()
                .min_by_key(|(_, replay)| replay.sequence)
                .map(|(key, _)| key.clone())
            {
                replays.remove(&oldest_key);
            }
        }
        replays.insert(
            key.to_owned(),
            RunReplay {
                request_digest,
                result: result.clone(),
                sequence: project.replay_sequence.fetch_add(1, Ordering::Relaxed),
            },
        );
    }

    Ok((StatusCode::ACCEPTED, Json(result)))
}

async fn run_status(
    State(project): State<Arc<WebProject>>,
    AxumPath(run_id): AxumPath<String>,
    Query(query): Query<RunStatusQuery>,
) -> Result<Json<RunStatusResponse>, ServerError> {
    let job = find_run(&project, &run_id)?;
    let wait = Duration::from_millis(query.wait_ms.min(25_000));
    let started = Instant::now();
    loop {
        refresh_run_status(&job);
        let snapshot = run_snapshot(&job);
        if wait.is_zero() || snapshot.phase.terminal() || started.elapsed() >= wait {
            return Ok(Json(snapshot));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn cancel_run(
    State(project): State<Arc<WebProject>>,
    AxumPath(run_id): AxumPath<String>,
) -> Result<Json<RunStatusResponse>, ServerError> {
    let job = find_run(&project, &run_id)?;
    {
        let mut status = job
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(status.phase, RunPhase::Preparing | RunPhase::Running) {
            status.phase = RunPhase::Cancelling;
        }
    }
    let _ = job.cancel.send(true);
    Ok(Json(run_snapshot(&job)))
}

fn find_run(project: &WebProject, run_id: &str) -> Result<Arc<RunJob>, ServerError> {
    project
        .runs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(run_id)
        .cloned()
        .ok_or_else(|| ServerError::RunNotFound(run_id.to_owned()))
}

fn run_snapshot(job: &RunJob) -> RunStatusResponse {
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    status.progress.completed = status
        .states
        .values()
        .filter(|state| {
            matches!(
                state,
                RunNodeState::Cached
                    | RunNodeState::Done
                    | RunNodeState::Failed
                    | RunNodeState::Skipped
                    | RunNodeState::Cancelled
            )
        })
        .count();
    status.progress.total = status.states.len();
    status.progress.message = match status.phase {
        RunPhase::Preparing => "Preparing workflow",
        RunPhase::Running => "Executing workflow",
        RunPhase::Finalizing => "Recording validation evidence",
        RunPhase::Completed => "Workflow completed",
        RunPhase::Failed => "Workflow failed",
        RunPhase::Cancelling => "Cancelling workflow",
        RunPhase::Cancelled => "Workflow cancelled",
    }
    .to_owned();
    status
}

async fn execute_run(
    job: Arc<RunJob>,
    graph: Graph,
    catalog: Catalog,
    target: ExportTarget,
    pixi: Option<PathBuf>,
    cancel: watch::Receiver<bool>,
) {
    execute_run_inner(Arc::clone(&job), graph, catalog, target, pixi, cancel).await;
    refresh_run_status(&job);
    let terminal_phase = job
        .pending_terminal
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(terminal_phase) = terminal_phase {
        match persist_validation_evidence(&job, terminal_phase) {
            Ok(()) => {
                job.status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .phase = terminal_phase;
            }
            Err(error) => {
                let mut status = job
                    .status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                status.phase = RunPhase::Failed;
                status.error = Some(format!("could not persist validation evidence: {error}"));
            }
        }
    }
}

async fn execute_run_inner(
    job: Arc<RunJob>,
    graph: Graph,
    catalog: Catalog,
    target: ExportTarget,
    pixi: Option<PathBuf>,
    mut cancel: watch::Receiver<bool>,
) {
    let Some(pixi) = pixi else {
        fail_run(
            &job,
            "Pixi is required to freeze and run this workflow".to_owned(),
        );
        return;
    };
    if let Some(parent) = job.package.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            fail_run(&job, format!("could not create run directory: {error}"));
            return;
        }
    }
    let package_path = job.package.clone();
    let package_pixi = pixi.clone();
    let package = tokio::task::spawn_blocking(move || {
        create_frozen_package_with_pixi(
            &graph,
            &catalog,
            &target,
            &package_path,
            executable,
            &package_pixi,
        )
    })
    .await;
    if *cancel.borrow() {
        finish_cancelled(&job);
        return;
    }
    let package = match package {
        Ok(Ok(package)) => package,
        Ok(Err(error)) => {
            fail_run(&job, error.to_string());
            return;
        }
        Err(error) => {
            fail_run(&job, format!("package task failed: {error}"));
            return;
        }
    };
    {
        let mut status = job
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.closure_digest = Some(package.closure.closure_digest);
    }
    let stdout = match std::fs::File::create(job.package.join("run.stdout.log")) {
        Ok(file) => file,
        Err(error) => {
            fail_run(&job, format!("could not create run log: {error}"));
            return;
        }
    };
    let stderr = match std::fs::File::create(job.package.join("run.stderr.log")) {
        Ok(file) => file,
        Err(error) => {
            fail_run(&job, format!("could not create run log: {error}"));
            return;
        }
    };
    let mut command = tokio::process::Command::new(pixi);
    command
        .args(["run", "--frozen", "--manifest-path"])
        .arg(job.package.join("pixi.toml"))
        .arg("run")
        .current_dir(&job.package)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            fail_run(&job, format!("could not start Pixi: {error}"));
            return;
        }
    };
    {
        let mut status = job
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.phase = RunPhase::Running;
    }
    refresh_run_status(&job);

    tokio::select! {
        result = child.wait() => match result {
            Ok(exit) if exit.success() => {
                if job.validation.is_some() {
                    *job.pending_terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        Some(RunPhase::Completed);
                }
                let mut status = job.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                status.phase = if job.validation.is_some() {
                    RunPhase::Finalizing
                } else {
                    RunPhase::Completed
                };
                status.exit_code = exit.code();
            }
            Ok(exit) => {
                let detail = log_tail(&job.package.join("run.stderr.log"))
                    .unwrap_or_else(|| format!("Nextflow exited with {exit}"));
                if job.validation.is_some() {
                    *job.pending_terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        Some(RunPhase::Failed);
                }
                let mut status = job.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                status.phase = if job.validation.is_some() {
                    RunPhase::Finalizing
                } else {
                    RunPhase::Failed
                };
                status.exit_code = exit.code();
                status.error = Some(detail);
            }
            Err(error) => fail_run(&job, format!("could not wait for Nextflow: {error}")),
        },
        changed = cancel.changed() => {
            if changed.is_ok() && *cancel.borrow() {
                let _ = child.start_kill();
                let _ = child.wait().await;
                finish_cancelled(&job);
            }
        }
    }
    refresh_run_status(&job);
}

fn fail_run(job: &RunJob, error: String) {
    if job.validation.is_some() {
        *job.pending_terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(RunPhase::Failed);
    }
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    status.phase = if job.validation.is_some() {
        RunPhase::Finalizing
    } else {
        RunPhase::Failed
    };
    status.error = Some(error);
    for state in status.states.values_mut() {
        *state = match *state {
            RunNodeState::Done | RunNodeState::Cached | RunNodeState::Failed => *state,
            RunNodeState::Running => RunNodeState::Failed,
            RunNodeState::Queued | RunNodeState::Skipped | RunNodeState::Cancelled => {
                RunNodeState::Skipped
            }
        };
    }
}

fn finish_cancelled(job: &RunJob) {
    if job.validation.is_some() {
        *job.pending_terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(RunPhase::Cancelled);
    }
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    status.phase = if job.validation.is_some() {
        RunPhase::Finalizing
    } else {
        RunPhase::Cancelled
    };
    for state in status.states.values_mut() {
        *state = match *state {
            RunNodeState::Done | RunNodeState::Cached => *state,
            RunNodeState::Running => RunNodeState::Cancelled,
            _ => RunNodeState::Skipped,
        };
    }
}

#[derive(Debug, Deserialize)]
struct RuntimeNodeMapEntry {
    process: Option<String>,
    kind: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeNodeMap {
    nodes: BTreeMap<String, RuntimeNodeMapEntry>,
}

fn refresh_run_status(job: &RunJob) {
    let Ok(raw) = std::fs::read_to_string(job.package.join("node-map.json")) else {
        return;
    };
    let Ok(node_map) = serde_json::from_str::<RuntimeNodeMap>(&raw) else {
        return;
    };
    let log = std::fs::read_to_string(job.package.join(".nextflow.log")).unwrap_or_default();
    let trace = std::fs::read_to_string(job.package.join(".somite/trace.tsv")).ok();
    let pending_terminal = *job
        .pending_terminal
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let effective_phase = pending_terminal.unwrap_or(status.phase);
    for (node_id, entry) in &node_map.nodes {
        let state = if entry.kind == "input" && effective_phase != RunPhase::Preparing {
            RunNodeState::Done
        } else if let Some(process) = &entry.process {
            trace_state(trace.as_deref(), process).unwrap_or_else(|| match effective_phase {
                RunPhase::Running | RunPhase::Cancelling if log.contains(process) => {
                    RunNodeState::Running
                }
                RunPhase::Completed => RunNodeState::Done,
                RunPhase::Failed => RunNodeState::Skipped,
                RunPhase::Cancelled => RunNodeState::Skipped,
                _ => RunNodeState::Queued,
            })
        } else {
            RunNodeState::Queued
        };
        status.states.insert(node_id.clone(), state);
    }
}

fn trace_state(trace: Option<&str>, process: &str) -> Option<RunNodeState> {
    let mut lines = trace?.lines();
    let header = lines.next()?.split('\t').collect::<Vec<_>>();
    let name_index = header.iter().position(|field| *field == "name")?;
    let status_index = header.iter().position(|field| *field == "status")?;
    lines
        .filter_map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            let name = fields.get(name_index)?;
            if !name.contains(process) {
                return None;
            }
            match fields.get(status_index)?.to_ascii_uppercase().as_str() {
                "COMPLETED" => Some(RunNodeState::Done),
                "CACHED" => Some(RunNodeState::Cached),
                "FAILED" | "ABORTED" => Some(RunNodeState::Failed),
                "RUNNING" | "SUBMITTED" => Some(RunNodeState::Running),
                _ => None,
            }
        })
        .next_back()
}

fn log_tail(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let lines = raw
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

fn persist_validation_evidence(job: &RunJob, terminal_phase: RunPhase) -> Result<(), ServerError> {
    let Some(validation) = &job.validation else {
        return Ok(());
    };
    let status = run_snapshot(job);
    if status.evidence_receipt.is_some() {
        return Ok(());
    }
    let node_results = status
        .states
        .iter()
        .map(|(node, state)| (node.clone(), evidence_node_result(*state)))
        .collect::<BTreeMap<_, _>>();
    let edge_results = validation
        .edge_nodes
        .iter()
        .map(|(edge, (source, target))| {
            let source = node_results
                .get(source)
                .copied()
                .unwrap_or(EvidenceResult::Inconclusive);
            let target = node_results
                .get(target)
                .copied()
                .unwrap_or(EvidenceResult::Inconclusive);
            let result = if source == EvidenceResult::Failed || target == EvidenceResult::Failed {
                EvidenceResult::Failed
            } else if source == EvidenceResult::Passed && target == EvidenceResult::Passed {
                EvidenceResult::Passed
            } else {
                EvidenceResult::Inconclusive
            };
            (edge.clone(), result)
        })
        .collect();
    let result = match terminal_phase {
        RunPhase::Completed
            if node_results
                .values()
                .all(|result| *result == EvidenceResult::Passed) =>
        {
            EvidenceResult::Passed
        }
        RunPhase::Failed => EvidenceResult::Failed,
        _ => EvidenceResult::Inconclusive,
    };
    let receipt = evidence_receipt(EvidenceDraft {
        recorded_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
        subject_digest: validation.subject_digest.clone(),
        observed_closure_digest: status.closure_digest,
        kind: "configuration_validation".to_owned(),
        scope: format!("graph_e2e:{}", validation.fixture_pack),
        configuration_digest: validation.configuration_digest.clone(),
        fixture_digests: validation.fixture_digests.clone(),
        verifier: format!("somite-validation@{}", env!("CARGO_PKG_VERSION")),
        result,
        node_results,
        edge_results,
        artifact_digests: digest_tree(&job.package.join("results"))?,
        log_digests: digest_paths(&[
            job.package.join("run.stdout.log"),
            job.package.join("run.stderr.log"),
            job.package.join(".nextflow.log"),
            job.package.join(".somite/trace.tsv"),
        ])?,
    })
    .map_err(|error| ServerError::Validation(error.to_string()))?;

    std::fs::create_dir_all(&validation.evidence_dir)?;
    let receipt_name = format!(
        "{}.json",
        receipt
            .receipt_digest
            .strip_prefix("blake3:")
            .unwrap_or(&receipt.receipt_digest)
    );
    write_json_atomic(&validation.evidence_dir.join(receipt_name), &receipt)?;
    let mut index = read_evidence_index(&validation.evidence_dir)?;
    index.insert(receipt.clone());
    write_json_atomic(&validation.evidence_dir.join("index.json"), &index)?;
    job.status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .evidence_receipt = Some(receipt);
    Ok(())
}

fn evidence_node_result(state: RunNodeState) -> EvidenceResult {
    match state {
        RunNodeState::Done | RunNodeState::Cached => EvidenceResult::Passed,
        RunNodeState::Failed => EvidenceResult::Failed,
        RunNodeState::Queued
        | RunNodeState::Running
        | RunNodeState::Skipped
        | RunNodeState::Cancelled => EvidenceResult::Inconclusive,
    }
}

fn digest_tree(root: &Path) -> Result<Vec<String>, ServerError> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    collect_regular_files(root, &mut paths)?;
    digest_paths(&paths)
}

fn collect_regular_files(root: &Path, paths: &mut Vec<PathBuf>) -> Result<(), ServerError> {
    let mut entries = std::fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_regular_files(&path, paths)?;
        } else if path.is_file() {
            paths.push(path);
        }
    }
    Ok(())
}

fn digest_paths(paths: &[PathBuf]) -> Result<Vec<String>, ServerError> {
    paths
        .iter()
        .filter(|path| path.is_file())
        .map(|path| std::fs::read(path).map(|contents| content_digest(&contents)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(ServerError::from)
}

fn read_evidence_index(directory: &Path) -> Result<EvidenceIndex, ServerError> {
    let path = directory.join("index.json");
    if !path.is_file() {
        return Ok(EvidenceIndex::default());
    }
    serde_json::from_slice(&std::fs::read(path)?)
        .map_err(|error| ServerError::Validation(format!("evidence index: {error}")))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), ServerError> {
    let mut encoded = serde_json::to_vec_pretty(value)?;
    encoded.push(b'\n');
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, encoded)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

async fn export_plan(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<BundlePlan>, ServerError> {
    Ok(Json(
        run_server_blocking("export planning", move || {
            let (graph, catalog, target) = production_inputs(&project, &graph)?;
            plan_frozen_package(&graph, &catalog, &target, executable).map_err(ServerError::from)
        })
        .await?,
    ))
}

async fn export_bundle(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Response, ServerError> {
    let (graph, catalog, target) = run_server_blocking("export readiness", {
        let project = project.clone();
        move || {
            let inputs = production_inputs(&project, &graph)?;
            require_ready(&inputs.0, &inputs.1)?;
            Ok(inputs)
        }
    })
    .await?;
    let pixi = project
        .pixi
        .clone()
        .ok_or_else(|| ServerError::Run("Pixi is required to freeze an export".to_owned()))?;
    let workspace = project
        .root
        .join(".somite/exports")
        .join(project.next_id("export"));
    let package_path = workspace.join("package");
    let (plan, bytes) = tokio::task::spawn_blocking(move || {
        let result = (|| -> Result<_, somite_bundle::BundleError> {
            let package = create_frozen_package_with_pixi(
                &graph,
                &catalog,
                &target,
                &package_path,
                executable,
                &pixi,
            )?;
            let bytes = archive_frozen_package(&package)?;
            Ok((package.plan, bytes))
        })();
        let _ = std::fs::remove_dir_all(&workspace);
        result
    })
    .await
    .map_err(|error| ServerError::Run(format!("export task failed: {error}")))??;
    let disposition = format!("attachment; filename=\"{}\"", plan.filename);
    let mut response = Response::new(axum::body::Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(|error| ServerError::Run(error.to_string()))?,
    );
    Ok(response)
}

fn production_inputs(
    project: &WebProject,
    graph: &Graph,
) -> Result<(Graph, Catalog, ExportTarget), ServerError> {
    let mut catalog = project.catalog.clone();
    catalog
        .ops
        .retain(|operator_id, _| !resolver_only_operator_id(operator_id));
    let mut graph = graph.clone();
    reject_resolver_only_graph(&graph)?;
    catalog.pin_graph(&mut graph)?;
    verify_graph_source_store(&project.root, &graph)?;
    let graph_base = project.graph_path.parent().unwrap_or(&project.root);
    absolutize_import_paths(&mut graph, &project.root, graph_base);
    let target = ExportTarget::new(project.workflow_name(&graph), current_pixi_platform());
    Ok((graph, catalog, target))
}

fn validation_inputs(
    project: &WebProject,
    graph: &Graph,
) -> Result<(Graph, Catalog, ExportTarget, ValidationContext), ServerError> {
    let mut catalog = project.catalog.clone();
    catalog
        .ops
        .retain(|operator_id, _| !resolver_only_operator_id(operator_id));
    let mut source_graph = graph.clone();
    reject_resolver_only_graph(&source_graph)?;
    catalog.pin_graph(&mut source_graph)?;
    verify_graph_source_store(&project.root, &source_graph)?;
    let subject_digest = semantic_graph_revision(&source_graph)
        .map_err(|error| ServerError::Validation(error.to_string()))?;
    let root = project
        .root
        .canonicalize()
        .map_err(|error| ServerError::Validation(error.to_string()))?;
    let FixtureBinding {
        fixture_pack,
        configuration_digest,
        fixture_digests,
        bindings: _,
        graph,
    } = bind_representative_fastq(&source_graph, &root.join(".somite/fixtures"))
        .map_err(|error| ServerError::Validation(error.to_string()))?;
    catalog.verify_graph(&graph)?;
    let edge_nodes = source_graph
        .edges
        .iter()
        .map(|edge| {
            (
                edge.id.clone(),
                (edge.from_node.clone(), edge.to_node.clone()),
            )
        })
        .collect();
    let target = ExportTarget::new(
        project.workflow_name(&source_graph),
        current_pixi_platform(),
    );
    let validation = ValidationContext {
        subject_digest,
        configuration_digest,
        fixture_pack,
        fixture_digests,
        edge_nodes,
        evidence_dir: root.join(".somite/evidence"),
    };
    Ok((graph, catalog, target, validation))
}

async fn validation_status(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<ValidationEvidenceResponse>, ServerError> {
    let (_, _, _, validation) = validation_inputs(&project, &graph)?;
    let index = read_evidence_index(&validation.evidence_dir)?;
    let receipt = index
        .receipts
        .into_iter()
        .filter(|receipt| {
            receipt.kind == "configuration_validation"
                && receipt.subject_digest == validation.subject_digest
                && receipt.configuration_digest == validation.configuration_digest
        })
        .max_by_key(|receipt| receipt.recorded_at_unix_ms);
    Ok(Json(ValidationEvidenceResponse {
        subject_digest: validation.subject_digest,
        configuration_digest: validation.configuration_digest,
        fixture_pack: validation.fixture_pack,
        receipt,
    }))
}

fn paper_progress(phase: PaperIntakePhase) -> PaperIntakeProgress {
    let (completed, message) = match phase {
        PaperIntakePhase::Queued => (0, "Waiting to read paper"),
        PaperIntakePhase::Extracting => (0, "Extracting paper text"),
        PaperIntakePhase::LocatingMethods => (1, "Locating methods and cited data"),
        PaperIntakePhase::RecognizingMethods => (2, "Recognizing described methods"),
        PaperIntakePhase::AssessingDrafts => (3, "Assessing reconstructed drafts"),
        PaperIntakePhase::Completed => (4, "Paper intake completed"),
        PaperIntakePhase::Failed => (4, "Paper intake failed"),
        PaperIntakePhase::Cancelling => (0, "Stopping paper intake"),
        PaperIntakePhase::Cancelled => (4, "Paper intake cancelled"),
    };
    PaperIntakeProgress {
        completed,
        total: 4,
        unit: "stages".to_owned(),
        message: message.to_owned(),
    }
}

fn update_paper_phase(job: &PaperIntakeJob, phase: PaperIntakePhase) {
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if status.phase.terminal() || status.phase == PaperIntakePhase::Cancelling {
        return;
    }
    status.phase = phase;
    status.progress = paper_progress(phase);
}

fn update_paper_extraction_progress(job: &PaperIntakeJob, progress: ExtractionProgress) {
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if status.phase.terminal() || status.phase == PaperIntakePhase::Cancelling {
        return;
    }
    status.phase = PaperIntakePhase::Extracting;
    status.progress = match progress {
        ExtractionProgress::NativeText => PaperIntakeProgress {
            completed: 0,
            total: 4,
            unit: "stages".to_owned(),
            message: "Reading embedded PDF text".to_owned(),
        },
        ExtractionProgress::Rasterizing { page, total } => PaperIntakeProgress {
            completed: page.saturating_sub(1),
            total,
            unit: "pages".to_owned(),
            message: format!("Preparing OCR page {page} of {total}"),
        },
        ExtractionProgress::Ocr { page, total } => PaperIntakeProgress {
            completed: page.saturating_sub(1),
            total,
            unit: "pages".to_owned(),
            message: format!("Reading OCR page {page} of {total}"),
        },
        ExtractionProgress::PageComplete { page, total } => PaperIntakeProgress {
            completed: page,
            total,
            unit: "pages".to_owned(),
            message: format!("Read OCR page {page} of {total}"),
        },
    };
}

fn paper_intake_snapshot(job: &PaperIntakeJob) -> PaperIntakeStatusResponse {
    job.status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn paper_intake_observable_changed(
    initial: &PaperIntakeStatusResponse,
    current: &PaperIntakeStatusResponse,
) -> bool {
    initial.phase != current.phase
        || initial.progress.completed != current.progress.completed
        || initial.progress.total != current.progress.total
        || initial.progress.unit != current.progress.unit
        || initial.progress.message != current.progress.message
}

fn paper_failure(code: &str, message: impl Into<String>, retryable: bool) -> PaperFailure {
    PaperFailure {
        code: code.to_owned(),
        message: message.into(),
        retryable,
    }
}

fn extraction_failure(error: &PaperError) -> PaperFailure {
    match error {
        PaperError::MissingTool { .. } => {
            paper_failure("missing_extraction_dependency", error.to_string(), true)
        }
        PaperError::Limit(_) => paper_failure("paper_extraction_limit", error.to_string(), false),
        PaperError::Timeout { .. } => {
            paper_failure("paper_extraction_timeout", error.to_string(), true)
        }
        PaperError::Cancelled => {
            paper_failure("paper_extraction_cancelled", error.to_string(), true)
        }
        _ => paper_failure("paper_extraction_failed", error.to_string(), true),
    }
}

fn finish_paper_failure(job: &PaperIntakeJob, failure: PaperFailure, total_started: Instant) {
    if job.cancel.load(Ordering::Acquire) {
        finish_paper_cancelled(job, total_started);
        return;
    }
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if status.phase.terminal() {
        return;
    }
    status
        .durations_ms
        .insert("total".to_owned(), duration_millis(total_started.elapsed()));
    status.phase = PaperIntakePhase::Failed;
    status.progress = paper_progress(PaperIntakePhase::Failed);
    status.result = None;
    status.failure = Some(failure);
}

fn finish_paper_cancelled(job: &PaperIntakeJob, total_started: Instant) {
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if status.phase.terminal() {
        return;
    }
    status
        .durations_ms
        .insert("total".to_owned(), duration_millis(total_started.elapsed()));
    status.phase = PaperIntakePhase::Cancelled;
    status.progress = paper_progress(PaperIntakePhase::Cancelled);
    status.result = None;
    status.failure = None;
}

fn finish_paper_success(job: &PaperIntakeJob, response: PaperResponse, total_started: Instant) {
    if job.cancel.load(Ordering::Acquire) {
        finish_paper_cancelled(job, total_started);
        return;
    }
    let mut status = job
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if status.phase.terminal() || status.phase == PaperIntakePhase::Cancelling {
        return;
    }
    status
        .durations_ms
        .insert("total".to_owned(), duration_millis(total_started.elapsed()));
    status.phase = PaperIntakePhase::Completed;
    status.progress = paper_progress(PaperIntakePhase::Completed);
    status.result = Some(response);
    status.failure = None;
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn extraction_cache_path(project: &WebProject, digest: &str) -> Result<PathBuf, ServerError> {
    let hex = paper_digest_hex(digest)?;
    Ok(project
        .papers_dir()
        .join("cache/extracted")
        .join(hex)
        .join(format!("{PAPER_EXTRACTOR_REVISION}.json")))
}

fn reconstruction_cache_path(
    project: &WebProject,
    digest: &str,
    text_digest: &str,
    catalog_revision: &str,
) -> Result<PathBuf, ServerError> {
    let source_hex = paper_digest_hex(digest)?;
    let key = content_digest(&serde_json::to_vec(&(
        text_digest,
        PAPER_RECONSTRUCTOR_REVISION,
        catalog_revision,
    ))?);
    let key_hex = paper_digest_hex(&key)?;
    Ok(project
        .papers_dir()
        .join("cache/reconstructed")
        .join(source_hex)
        .join(format!("{key_hex}.json")))
}

fn read_json_cache<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn write_json_cache<T: Serialize>(
    project: &WebProject,
    path: &Path,
    value: &T,
) -> Result<(), ServerError> {
    let parent = path
        .parent()
        .ok_or_else(|| ServerError::Paper("paper cache path has no parent".to_owned()))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", project.next_id("paper-cache")));
    let encoded = serde_json::to_vec(value)?;
    if let Err(error) = std::fs::write(&temporary, encoded) {
        let _ = std::fs::remove_file(&temporary);
        return Err(ServerError::Io(error));
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(ServerError::Io(error));
    }
    Ok(())
}

fn record_paper_duration(job: &PaperIntakeJob, stage: &str, started: Instant) {
    job.status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .durations_ms
        .insert(stage.to_owned(), duration_millis(started.elapsed()));
}

fn paper_stage_duration_key(phase: PaperIntakePhase) -> Option<&'static str> {
    match phase {
        PaperIntakePhase::LocatingMethods => Some("locating_methods"),
        PaperIntakePhase::RecognizingMethods => Some("recognizing_methods"),
        PaperIntakePhase::AssessingDrafts => Some("assessing_drafts"),
        _ => None,
    }
}

fn execute_paper_intake(
    project: Arc<WebProject>,
    job: Arc<PaperIntakeJob>,
    artifact: StoredPaperArtifact,
    path: PathBuf,
) {
    let total_started = job.created_at;
    if job.cancel.load(Ordering::Acquire) {
        finish_paper_cancelled(&job, total_started);
        return;
    }

    update_paper_phase(&job, PaperIntakePhase::Extracting);
    let extraction_started = Instant::now();
    let extraction_path = match extraction_cache_path(&project, &artifact.digest) {
        Ok(path) => path,
        Err(error) => {
            finish_paper_failure(
                &job,
                paper_failure("paper_cache_key_failed", error.to_string(), true),
                total_started,
            );
            return;
        }
    };
    let extracted = read_json_cache::<ExtractedPaperCache>(&extraction_path).filter(|cached| {
        cached.schema_version == 1
            && cached.source_digest == artifact.digest
            && cached.extractor_revision == PAPER_EXTRACTOR_REVISION
    });
    let extracted = match extracted {
        Some(extracted) => {
            job.status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .cache
                .extraction = true;
            extracted
        }
        None => {
            let limits = ExtractionLimits {
                max_pages: project.paper_limits.max_ocr_pages,
                max_text_bytes: project
                    .paper_limits
                    .max_extracted_text_bytes
                    .min(usize::MAX as u64) as usize,
                command_timeout: project.paper_limits.command_timeout,
            };
            let tools = paper_extraction_toolchain(&project.paper_tools);
            let extracted = match extract_from_path_with_toolchain(
                &path,
                limits,
                &tools,
                || job.cancel.load(Ordering::Acquire),
                |progress| update_paper_extraction_progress(&job, progress),
            ) {
                Ok(extracted) => extracted,
                Err(PaperError::Cancelled) => {
                    finish_paper_cancelled(&job, total_started);
                    return;
                }
                Err(error) => {
                    finish_paper_failure(&job, extraction_failure(&error), total_started);
                    return;
                }
            };
            let cached = ExtractedPaperCache {
                schema_version: 1,
                source_digest: artifact.digest.clone(),
                extractor_revision: PAPER_EXTRACTOR_REVISION.to_owned(),
                extracted_via: extract_via_label(extracted.via).to_owned(),
                text: extracted.text,
            };
            if cached.text.len() as u64 <= project.paper_limits.max_extracted_text_bytes {
                if job.cancel.load(Ordering::Acquire) {
                    finish_paper_cancelled(&job, total_started);
                    return;
                }
                if let Err(error) = write_json_cache(&project, &extraction_path, &cached) {
                    finish_paper_failure(
                        &job,
                        paper_failure("paper_cache_write_failed", error.to_string(), true),
                        total_started,
                    );
                    return;
                }
            }
            cached
        }
    };
    record_paper_duration(&job, "extraction", extraction_started);
    if extracted.text.len() as u64 > project.paper_limits.max_extracted_text_bytes {
        finish_paper_failure(
            &job,
            paper_failure(
                "extracted_text_too_large",
                format!(
                    "extracted text exceeds the {} byte safety limit",
                    project.paper_limits.max_extracted_text_bytes
                ),
                false,
            ),
            total_started,
        );
        return;
    }
    if job.cancel.load(Ordering::Acquire) {
        finish_paper_cancelled(&job, total_started);
        return;
    }

    let reconstruction_started = Instant::now();
    let text_digest = content_digest(extracted.text.as_bytes());
    let catalog_revision = match project.catalog.catalog_revision() {
        Ok(revision) => revision,
        Err(error) => {
            finish_paper_failure(
                &job,
                paper_failure("catalog_identity_failed", error.to_string(), false),
                total_started,
            );
            return;
        }
    };
    let reconstruction_path = match reconstruction_cache_path(
        &project,
        &artifact.digest,
        &text_digest,
        &catalog_revision,
    ) {
        Ok(path) => path,
        Err(error) => {
            finish_paper_failure(
                &job,
                paper_failure("paper_cache_key_failed", error.to_string(), true),
                total_started,
            );
            return;
        }
    };
    let reconstructed =
        read_json_cache::<ReconstructedPaperCache>(&reconstruction_path).filter(|cached| {
            cached.schema_version == 1
                && cached.source_digest == artifact.digest
                && cached.extracted_text_digest == text_digest
                && cached.reconstructor_revision == PAPER_RECONSTRUCTOR_REVISION
                && cached.catalog_revision == catalog_revision
        });
    let response = match reconstructed {
        Some(cached) => {
            let mut status = job
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            status.cache.reconstruction = true;
            cached.response
        }
        None => {
            let mut active_stage: Option<(PaperIntakePhase, Instant)> = None;
            let response = paper_response_with_progress(
                &project.catalog,
                &extracted.extracted_via,
                &extracted.text,
                |phase| {
                    if let Some((previous, started)) = active_stage.take() {
                        if let Some(key) = paper_stage_duration_key(previous) {
                            record_paper_duration(&job, key, started);
                        }
                    }
                    update_paper_phase(&job, phase);
                    active_stage = Some((phase, Instant::now()));
                },
            );
            if let Some((last, started)) = active_stage {
                if let Some(key) = paper_stage_duration_key(last) {
                    record_paper_duration(&job, key, started);
                }
            }
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    finish_paper_failure(
                        &job,
                        paper_failure("paper_reconstruction_failed", error.to_string(), true),
                        total_started,
                    );
                    return;
                }
            };
            if job.cancel.load(Ordering::Acquire) {
                finish_paper_cancelled(&job, total_started);
                return;
            }
            let cached = ReconstructedPaperCache {
                schema_version: 1,
                source_digest: artifact.digest.clone(),
                extracted_text_digest: text_digest,
                reconstructor_revision: PAPER_RECONSTRUCTOR_REVISION.to_owned(),
                catalog_revision,
                response: response.clone(),
            };
            if let Err(error) = write_json_cache(&project, &reconstruction_path, &cached) {
                finish_paper_failure(
                    &job,
                    paper_failure("paper_cache_write_failed", error.to_string(), true),
                    total_started,
                );
                return;
            }
            response
        }
    };
    record_paper_duration(&job, "reconstruction", reconstruction_started);
    finish_paper_success(&job, response, total_started);
}

async fn start_paper_intake(
    State(project): State<Arc<WebProject>>,
    Query(query): Query<PaperIntakeStartQuery>,
    Json(request): Json<PaperIntakeRequest>,
) -> Result<(StatusCode, Json<PaperIntakeStartResponse>), ServerError> {
    let requested_digest = request.digest;
    let resolver = Arc::clone(&project);
    let resolve_digest = requested_digest.clone();
    let max_size_bytes = project.paper_limits.max_upload_bytes;
    let (artifact, path) = tokio::task::spawn_blocking(move || {
        resolver.resolve_paper_artifact(&resolve_digest, max_size_bytes)
    })
    .await
    .map_err(|error| {
        ServerError::Paper(format!(
            "paper artifact verifier stopped unexpectedly: {error}"
        ))
    })??;
    let request_digest = content_digest(&serde_json::to_vec(&("paper_intake", &requested_digest))?);
    let mut replays = project
        .paper_intake_replays
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(key) = query.idempotency_key.as_deref() {
        if !agent::valid_idempotency_key(key) {
            return Err(ServerError::InvalidPaperIntake(
                "invalid idempotency key".to_owned(),
            ));
        }
        if let Some(replay) = replays.get(key).cloned() {
            if replay.request_digest != request_digest {
                return Err(ServerError::InvalidPaperIntake(
                    "idempotency key was already used for a different paper".to_owned(),
                ));
            }
            let retained = project
                .paper_intakes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(&replay.result.job_id);
            if retained {
                let mut response = replay.result;
                response.replayed = true;
                return Ok((StatusCode::ACCEPTED, Json(response)));
            }
            replays.remove(key);
        }
    }

    let job_id = project.next_id("paper");
    let cancel = Arc::new(AtomicBool::new(false));
    let job = Arc::new(PaperIntakeJob {
        status: Mutex::new(PaperIntakeStatusResponse {
            job_id: job_id.clone(),
            source_digest: artifact.digest.clone(),
            phase: PaperIntakePhase::Queued,
            progress: paper_progress(PaperIntakePhase::Queued),
            durations_ms: BTreeMap::new(),
            cache: PaperCacheUse::default(),
            result: None,
            failure: None,
        }),
        cancel,
        cancelled: Notify::new(),
        created_at: Instant::now(),
    });
    {
        let mut jobs = project
            .paper_intakes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while jobs.len() >= MAX_ACTIVE_PAPER_INTAKES {
            let expired = jobs.iter().find_map(|(id, existing)| {
                paper_intake_snapshot(existing)
                    .phase
                    .terminal()
                    .then(|| id.clone())
            });
            if let Some(expired) = expired {
                jobs.remove(&expired);
                replays.retain(|_, replay| replay.result.job_id != expired);
            } else {
                return Err(ServerError::PaperIntakeBusy);
            }
        }
        jobs.insert(job_id.clone(), Arc::clone(&job));
    }

    let worker_project = Arc::clone(&project);
    let paper_execution = Arc::clone(&project.paper_execution);
    tokio::spawn(async move {
        let permit = tokio::select! {
            permit = paper_execution.acquire_owned() => permit,
            _ = job.cancelled.notified() => {
                finish_paper_cancelled(&job, job.created_at);
                return;
            }
        };
        let Ok(_permit) = permit else {
            finish_paper_failure(
                &job,
                paper_failure(
                    "paper_execution_unavailable",
                    "paper intake execution capacity is unavailable",
                    true,
                ),
                job.created_at,
            );
            return;
        };
        if job.cancel.load(Ordering::Acquire) {
            finish_paper_cancelled(&job, job.created_at);
            return;
        }
        let worker_job = Arc::clone(&job);
        let result = tokio::task::spawn_blocking(move || {
            execute_paper_intake(worker_project, worker_job, artifact, path)
        })
        .await;
        if let Err(error) = result {
            finish_paper_failure(
                &job,
                paper_failure(
                    "paper_worker_failed",
                    format!("paper worker stopped unexpectedly: {error}"),
                    true,
                ),
                job.created_at,
            );
        }
    });

    let response = PaperIntakeStartResponse {
        job_id,
        source_digest: requested_digest,
        phase: PaperIntakePhase::Queued,
        replayed: false,
    };
    if let Some(key) = query.idempotency_key {
        if replays.len() >= 1_024 {
            if let Some(oldest) = replays
                .iter()
                .min_by_key(|(_, replay)| replay.sequence)
                .map(|(key, _)| key.clone())
            {
                replays.remove(&oldest);
            }
        }
        replays.insert(
            key,
            PaperIntakeReplay {
                request_digest,
                result: response.clone(),
                sequence: project.replay_sequence.fetch_add(1, Ordering::Relaxed),
            },
        );
    }
    Ok((StatusCode::ACCEPTED, Json(response)))
}

fn find_paper_intake(
    project: &WebProject,
    job_id: &str,
) -> Result<Arc<PaperIntakeJob>, ServerError> {
    project
        .paper_intakes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(job_id)
        .cloned()
        .ok_or_else(|| ServerError::PaperIntakeNotFound(job_id.to_owned()))
}

async fn paper_intake_status(
    State(project): State<Arc<WebProject>>,
    AxumPath(job_id): AxumPath<String>,
    Query(query): Query<RunStatusQuery>,
) -> Result<Json<PaperIntakeStatusResponse>, ServerError> {
    let job = find_paper_intake(&project, &job_id)?;
    let wait = Duration::from_millis(query.wait_ms.min(25_000));
    let started = Instant::now();
    let initial = paper_intake_snapshot(&job);
    if wait.is_zero() || initial.phase.terminal() {
        return Ok(Json(initial));
    }
    loop {
        let remaining = wait.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Ok(Json(paper_intake_snapshot(&job)));
        }
        tokio::time::sleep(Duration::from_millis(100).min(remaining)).await;
        let snapshot = paper_intake_snapshot(&job);
        if snapshot.phase.terminal()
            || paper_intake_observable_changed(&initial, &snapshot)
            || started.elapsed() >= wait
        {
            return Ok(Json(snapshot));
        }
    }
}

async fn cancel_paper_intake(
    State(project): State<Arc<WebProject>>,
    AxumPath(job_id): AxumPath<String>,
) -> Result<Json<PaperIntakeStatusResponse>, ServerError> {
    let job = find_paper_intake(&project, &job_id)?;
    {
        let mut status = job
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !status.phase.terminal() {
            status.phase = PaperIntakePhase::Cancelling;
            status.progress = paper_progress(PaperIntakePhase::Cancelling);
            job.cancel.store(true, Ordering::Release);
            job.cancelled.notify_one();
        }
    }
    Ok(Json(paper_intake_snapshot(&job)))
}

async fn rebuild_paper(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<PaperRequest>,
) -> Result<Json<PaperResponse>, ServerError> {
    let path = project.resolve_project_file(&request.path)?;
    let catalog = project.catalog.clone();
    let response = tokio::task::spawn_blocking(move || {
        let extracted =
            extract_from_path(&path).map_err(|error| ServerError::Paper(error.to_string()))?;
        paper_response(&catalog, extract_via_label(extracted.via), &extracted.text)
    })
    .await
    .map_err(|error| ServerError::Paper(error.to_string()))??;
    Ok(Json(response))
}

async fn rebuild_biorxiv_paper(
    State(project): State<Arc<WebProject>>,
    Json(request): Json<BiorxivPaperRequest>,
) -> Result<Json<PaperResponse>, ServerError> {
    let cache_directory = project.root.join(".somite/papers");
    let catalog = project.catalog.clone();
    let response = tokio::task::spawn_blocking(move || {
        let text = literature::fetch_biorxiv_text(&cache_directory, &request.id)?;
        paper_response(&catalog, "jats", &text)
    })
    .await
    .map_err(|error| ServerError::Paper(error.to_string()))??;
    Ok(Json(response))
}

fn paper_response(
    catalog: &Catalog,
    extracted_via: &str,
    text: &str,
) -> Result<PaperResponse, ServerError> {
    paper_response_with_progress(catalog, extracted_via, text, |_| {})
}

fn paper_response_with_progress(
    catalog: &Catalog,
    extracted_via: &str,
    text: &str,
    mut progress: impl FnMut(PaperIntakePhase),
) -> Result<PaperResponse, ServerError> {
    progress(PaperIntakePhase::LocatingMethods);
    let resources = resource_citations(text)
        .into_iter()
        .map(|citation| PaperResourceCitation {
            accession: citation.accession,
            kind: paper_resource_kind_label(citation.kind).to_owned(),
            role: paper_resource_role_label(citation.role).to_owned(),
            context: citation.context,
            source_location: (matches!(extracted_via, "poppler" | "ocr"))
                .then(|| citation.page.map(|page| format!("PDF page {page}")))
                .flatten(),
        })
        .collect();
    progress(PaperIntakePhase::RecognizingMethods);
    let reconstruction = reconstruct(catalog, text);
    let outcome = reconstruction_outcome_label(reconstruction.outcome).to_owned();
    let warnings = reconstruction.warnings;
    let mentions = reconstruction
        .mentions
        .into_iter()
        .map(|mention| {
            let (support, operator_id) = match mention.support {
                MethodSupport::Operator(operator_id) => ("operator".to_owned(), Some(operator_id)),
                MethodSupport::Unsupported => ("unsupported".to_owned(), None),
            };
            PaperMethodMention {
                display_name: mention.display_name,
                normalized_name: mention.normalized_name,
                operation_class: mention.operation_class,
                evidence: mention.evidence,
                support,
                operator_id,
                source_location: (matches!(extracted_via, "poppler" | "ocr"))
                    .then(|| mention.page.map(|page| format!("PDF page {page}")))
                    .flatten(),
            }
        })
        .collect();
    progress(PaperIntakePhase::AssessingDrafts);
    Ok(PaperResponse {
        extracted_via: extracted_via.to_owned(),
        outcome,
        warnings,
        mentions,
        resources,
        candidates: reconstruction
            .candidates
            .into_iter()
            .map(|candidate| -> Result<PaperCandidate, ServerError> {
                let assessment = assess(&candidate.graph, catalog)?;
                let evidence = candidate
                    .evidence
                    .into_iter()
                    .map(|evidence| {
                        let (target_kind, target_id) = match evidence.target {
                            EvidenceTarget::Node(id) => ("node", id),
                            EvidenceTarget::Edge(id) => ("edge", id),
                        };
                        let resolution = (target_kind == "node")
                            .then(|| assessment.node(&target_id))
                            .flatten();
                        let source_location = evidence_source_location(
                            extracted_via,
                            text,
                            evidence.status,
                            &evidence.detail,
                        );
                        PaperEvidence {
                            target_kind: target_kind.to_owned(),
                            target_id,
                            status: evidence_status_label(evidence.status).to_owned(),
                            detail: evidence.detail,
                            resolution_kind: resolution
                                .map(|value| support_kind_label(value.kind).to_owned()),
                            resolution_label: resolution.map(|value| value.label.clone()),
                            resolution_detail: resolution.map(|value| value.detail.clone()),
                            resolution_required: resolution.map(|value| value.requires_action),
                            source_location,
                        }
                    })
                    .collect();
                Ok(PaperCandidate {
                    name: candidate.name,
                    role: candidate_role_label(candidate.role).to_owned(),
                    assay: assay_label(candidate.assay).to_owned(),
                    graph: candidate.graph,
                    warnings: candidate.warnings,
                    evidence,
                    assessment,
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn reconstruction_outcome_label(outcome: ReconstructionOutcome) -> &'static str {
    match outcome {
        ReconstructionOutcome::DraftsReady => "drafts_ready",
        ReconstructionOutcome::RecognizedUnsupported => "recognized_unsupported",
        ReconstructionOutcome::NoReconstructableMethods => "no_reconstructable_methods",
    }
}

fn paper_resource_kind_label(kind: ResourceCitationKind) -> &'static str {
    match kind {
        ResourceCitationKind::SraStudy => "sra_study",
        ResourceCitationKind::SraSample => "sra_sample",
        ResourceCitationKind::SraExperiment => "sra_experiment",
        ResourceCitationKind::SraRun => "sra_run",
        ResourceCitationKind::BioProject => "bioproject",
        ResourceCitationKind::BioSample => "biosample",
        ResourceCitationKind::Assembly => "assembly",
        ResourceCitationKind::Ensembl => "ensembl",
    }
}

fn paper_resource_role_label(role: ResourceRole) -> &'static str {
    match role {
        ResourceRole::Reads => "reads",
        ResourceRole::Reference => "reference",
        ResourceRole::Annotation => "annotation",
        ResourceRole::SampleMetadata => "sample_metadata",
        ResourceRole::Unknown => "unknown",
    }
}

fn support_kind_label(kind: SupportKind) -> &'static str {
    match kind {
        SupportKind::InputRequired => "input_required",
        SupportKind::ManagedTool => "managed_tool",
        SupportKind::SourceWorkflow => "source_workflow",
        SupportKind::BuiltIn => "built_in",
        SupportKind::SystemTool => "system_tool",
        SupportKind::ManualCheckpoint => "manual_checkpoint",
        SupportKind::MethodDetails => "method_details",
        SupportKind::LegacySource => "legacy_source",
        SupportKind::Adapter => "adapter",
    }
}

fn evidence_source_location(
    extracted_via: &str,
    text: &str,
    status: EvidenceStatus,
    detail: &str,
) -> Option<String> {
    if status != EvidenceStatus::Explicit || !matches!(extracted_via, "poppler" | "ocr") {
        return None;
    }
    let needle = normalized_evidence_text(detail);
    if needle.is_empty() {
        return None;
    }
    text.split('\u{000c}')
        .enumerate()
        .find(|(_, page)| normalized_evidence_text(page).contains(&needle))
        .map(|(index, _)| format!("PDF page {}", index + 1))
}

fn normalized_evidence_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn extract_via_label(via: ExtractVia) -> &'static str {
    match via {
        ExtractVia::Utf8 => "text",
        ExtractVia::Poppler => "poppler",
        ExtractVia::Tesseract => "ocr",
    }
}

fn candidate_role_label(role: CandidateRole) -> &'static str {
    match role {
        CandidateRole::Primary => "primary",
        CandidateRole::Parallel => "parallel",
        CandidateRole::Alternative => "alternative",
    }
}

fn assay_label(assay: Assay) -> &'static str {
    match assay {
        Assay::Assembly => "assembly",
        Assay::RnaSeq => "rna-seq",
        Assay::Variants => "variants",
        Assay::Metagenome => "metagenome",
        Assay::SingleCell => "single-cell",
        Assay::Mixed => "mixed",
        Assay::Qc => "quality control",
        Assay::Unknown => "unknown",
    }
}

fn evidence_status_label(status: EvidenceStatus) -> &'static str {
    match status {
        EvidenceStatus::Explicit => "explicit",
        EvidenceStatus::Inferred => "inferred",
        EvidenceStatus::MissingImplementation => "needs_adapter",
    }
}

fn detect_system_profile(paper_tools: &PaperToolchainState) -> SystemProfile {
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let (cpu, physical_cores, logical_threads) = parse_cpuinfo(&cpuinfo);
    let memory_bytes = meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|kib| kib * 1024)
        .unwrap_or(0);
    let gpus = Command::new("lspci")
        .arg("-nn")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .map(|output| {
            output
                .lines()
                .filter(|line| {
                    [
                        "VGA compatible controller",
                        "3D controller",
                        "Display controller",
                    ]
                    .iter()
                    .any(|kind| line.contains(kind))
                })
                .filter_map(|line| line.split_once("]: ").map(|(_, value)| value.trim()))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let os = os_release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|value| value.trim_matches('"').to_owned())
        .unwrap_or_else(|| std::env::consts::OS.to_owned());
    let paper_extraction = paper_extraction_preflight(paper_tools);
    SystemProfile {
        cpu,
        physical_cores,
        logical_threads,
        memory_bytes,
        gpus,
        os,
        tools: ToolReadiness {
            pixi: pixi_executable().is_some(),
            sra: executable("prefetch") && executable("fasterq-dump"),
            datasets: executable("datasets"),
            ensembl: executable("curl"),
            nextflow: executable("nextflow"),
            snakemake: executable("snakemake"),
        },
        paper_extraction,
    }
}

#[derive(Clone, Debug)]
struct ResolvedPaperTool {
    path: PathBuf,
    source: PaperToolSource,
}

#[derive(Clone, Debug)]
struct PaperToolchainState {
    unavailable_directory: PathBuf,
    pdftotext: Option<ResolvedPaperTool>,
    pdfinfo: Option<ResolvedPaperTool>,
    pdftoppm: Option<ResolvedPaperTool>,
    tesseract: Option<ResolvedPaperTool>,
}

impl PaperToolchainState {
    fn detect(project_root: &Path) -> Self {
        Self {
            unavailable_directory: project_root.join(".somite/tools/paper/unavailable"),
            pdftotext: resolve_paper_tool(project_root, "pdftotext"),
            pdfinfo: resolve_paper_tool(project_root, "pdfinfo"),
            pdftoppm: resolve_paper_tool(project_root, "pdftoppm"),
            tesseract: resolve_paper_tool(project_root, "tesseract"),
        }
    }

    #[cfg(test)]
    fn unavailable(project_root: &Path) -> Self {
        Self {
            unavailable_directory: project_root.join(".somite/tools/paper/unavailable"),
            pdftotext: None,
            pdfinfo: None,
            pdftoppm: None,
            tesseract: None,
        }
    }

    fn get(&self, name: &str) -> Option<&ResolvedPaperTool> {
        match name {
            "pdftotext" => self.pdftotext.as_ref(),
            "pdfinfo" => self.pdfinfo.as_ref(),
            "pdftoppm" => self.pdftoppm.as_ref(),
            "tesseract" => self.tesseract.as_ref(),
            _ => None,
        }
    }

    fn command_path(&self, name: &str) -> PathBuf {
        self.get(name)
            .map(|tool| tool.path.clone())
            .unwrap_or_else(|| executable_candidate(&self.unavailable_directory, name))
    }
}

fn resolve_paper_tool(project_root: &Path, name: &str) -> Option<ResolvedPaperTool> {
    let candidates = [
        (
            project_root.join(".somite/tools/paper/.pixi/envs/default/bin"),
            PaperToolSource::ManagedPixi,
        ),
        (
            project_root.join(".pixi/envs/default/bin"),
            PaperToolSource::ProjectPixi,
        ),
    ];
    for (directory, source) in candidates {
        let path = executable_candidate(&directory, name);
        if executable_file(&path) {
            return Some(ResolvedPaperTool { path, source });
        }
    }
    executable_path(name).map(|path| ResolvedPaperTool {
        path,
        source: PaperToolSource::SystemPath,
    })
}

fn paper_tool_readiness(
    paper_tools: &PaperToolchainState,
    name: &str,
    pixi_package: &str,
    purpose: &str,
) -> PaperExtractionToolReadiness {
    match paper_tools.get(name) {
        Some(resolved) => PaperExtractionToolReadiness {
            name: name.to_owned(),
            available: true,
            path: Some(resolved.path.display().to_string()),
            source: Some(resolved.source),
            detail: format!("{purpose} is available."),
        },
        None => PaperExtractionToolReadiness {
            name: name.to_owned(),
            available: false,
            path: None,
            source: None,
            detail: format!(
                "{purpose} needs {name}. Add {pixi_package} to Somite's managed or project Pixi environment, or provide {name} on PATH."
            ),
        },
    }
}

fn paper_extraction_preflight(paper_tools: &PaperToolchainState) -> PaperExtractionPreflight {
    let tools = vec![
        paper_tool_readiness(
            paper_tools,
            "pdftotext",
            "conda-forge::poppler",
            "Native PDF text extraction",
        ),
        paper_tool_readiness(
            paper_tools,
            "pdfinfo",
            "conda-forge::poppler",
            "PDF page counting for bounded OCR",
        ),
        paper_tool_readiness(
            paper_tools,
            "pdftoppm",
            "conda-forge::poppler",
            "PDF page rendering for OCR",
        ),
        paper_tool_readiness(
            paper_tools,
            "tesseract",
            "conda-forge::tesseract",
            "Scanned-page text recognition",
        ),
    ];
    let available = |name: &str| {
        tools
            .iter()
            .find(|tool| tool.name == name)
            .is_some_and(|tool| tool.available)
    };
    PaperExtractionPreflight {
        native_pdf_text: available("pdftotext"),
        scanned_pdf_ocr: available("pdfinfo") && available("pdftoppm") && available("tesseract"),
        tools,
    }
}

fn paper_extraction_toolchain(paper_tools: &PaperToolchainState) -> ExtractionToolchain {
    ExtractionToolchain {
        pdftotext: paper_tools.command_path("pdftotext"),
        pdfinfo: paper_tools.command_path("pdfinfo"),
        pdftoppm: paper_tools.command_path("pdftoppm"),
        tesseract: paper_tools.command_path("tesseract"),
    }
}

fn parse_cpuinfo(text: &str) -> (String, usize, usize) {
    let mut cpu = String::new();
    let mut cores = BTreeSet::new();
    let mut logical_threads = 0;
    for block in text.split("\n\n") {
        let mut package = None;
        let mut core = None;
        let mut processor = false;
        for line in block.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            match key.trim() {
                "processor" => processor = true,
                "model name" | "Hardware" if cpu.is_empty() => cpu = value.trim().to_owned(),
                "physical id" => package = Some(value.trim().to_owned()),
                "core id" => core = Some(value.trim().to_owned()),
                _ => {}
            }
        }
        if processor {
            logical_threads += 1;
            if let (Some(package), Some(core)) = (package, core) {
                cores.insert((package, core));
            }
        }
    }
    let logical_threads = logical_threads.max(1);
    let physical_cores = if cores.is_empty() {
        logical_threads
    } else {
        cores.len()
    };
    if cpu.is_empty() {
        cpu = "Unknown CPU".to_owned();
    }
    (cpu, physical_cores, logical_threads)
}

fn executable(binary: &str) -> bool {
    executable_path(binary).is_some()
}

fn executable_candidate(directory: &Path, binary: &str) -> PathBuf {
    directory.join(format!("{binary}{}", std::env::consts::EXE_SUFFIX))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn executable_path(binary: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .as_deref()
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|directory| executable_candidate(&directory, binary))
        .find(|path| executable_file(path))
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| executable_candidate(&home.join(".local/bin"), binary))
                .filter(|path| executable_file(path))
        })
}

async fn upload_file(
    State(project): State<Arc<WebProject>>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, ServerError> {
    let _upload_permit = project
        .upload_execution
        .acquire()
        .await
        .map_err(|_| ServerError::Upload("upload coordinator is unavailable".to_owned()))?;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| ServerError::Upload(error.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let supplied = field.file_name().ok_or(ServerError::InvalidFilename)?;
        let filename = Path::new(supplied)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| {
                !name.is_empty()
                    && *name != "."
                    && *name != ".."
                    && name.len() <= 255
                    && !name.chars().any(char::is_control)
            })
            .ok_or(ServerError::InvalidFilename)?
            .to_owned();
        let uploads = checked_uploads_directory(&project.root)?;
        let existing_bytes = generic_upload_store_bytes(&uploads)?;
        if existing_bytes >= project.upload_limits.max_project_bytes {
            return Err(ServerError::UploadProjectBudgetExceeded {
                limit_bytes: project.upload_limits.max_project_bytes,
                used_bytes: existing_bytes,
            });
        }
        let temporary = tempfile::Builder::new()
            .prefix(".upload-")
            .tempfile_in(&uploads)?;
        let mut output = tokio::fs::File::from_std(temporary.as_file().try_clone()?);
        let mut size_bytes = 0_u64;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|error| ServerError::Upload(error.to_string()))?
        {
            size_bytes =
                size_bytes
                    .checked_add(chunk.len() as u64)
                    .ok_or(ServerError::UploadTooLarge {
                        limit_bytes: project.upload_limits.max_file_bytes,
                    })?;
            if size_bytes > project.upload_limits.max_file_bytes {
                return Err(ServerError::UploadTooLarge {
                    limit_bytes: project.upload_limits.max_file_bytes,
                });
            }
            if existing_bytes.saturating_add(size_bytes) > project.upload_limits.max_project_bytes {
                return Err(ServerError::UploadProjectBudgetExceeded {
                    limit_bytes: project.upload_limits.max_project_bytes,
                    used_bytes: existing_bytes,
                });
            }
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        output.sync_all().await?;
        drop(output);
        let destination = publish_uploaded_file(&uploads, &filename, temporary.path()).await?;
        #[cfg(unix)]
        std::fs::File::open(&uploads)?.sync_all()?;
        return Ok(Json(UploadResponse {
            path: display_path(&project.root, &destination),
            filename: destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&filename)
                .to_owned(),
        }));
    }
    Err(ServerError::MissingUpload)
}

fn generic_upload_store_bytes(uploads: &Path) -> Result<u64, ServerError> {
    let mut total = 0_u64;
    for entry in std::fs::read_dir(uploads)? {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ServerError::UnsafeUploadStore(format!(
                ".somite/uploads contains a non-regular entry: {}",
                entry.file_name().to_string_lossy()
            )));
        }
        total = total.checked_add(metadata.len()).ok_or_else(|| {
            ServerError::UnsafeUploadStore("upload store byte count overflowed".to_owned())
        })?;
    }
    Ok(total)
}

fn checked_uploads_directory(root: &Path) -> Result<PathBuf, ServerError> {
    let canonical_root = root.canonicalize().map_err(|error| {
        ServerError::UnsafeUploadStore(format!("could not resolve project root: {error}"))
    })?;
    let somite = canonical_root.join(".somite");
    ensure_upload_directory(&somite, &canonical_root, ".somite")?;
    let canonical_somite = somite.canonicalize()?;
    let uploads = somite.join("uploads");
    ensure_upload_directory(&uploads, &canonical_somite, ".somite/uploads")?;
    Ok(uploads)
}

fn ensure_upload_directory(
    path: &Path,
    canonical_parent: &Path,
    label: &str,
) -> Result<(), ServerError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(ServerError::Io(error)),
            }
        }
        Err(error) => return Err(ServerError::Io(error)),
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ServerError::UnsafeUploadStore(format!(
            "{label} must be a regular non-symlink directory"
        )));
    }
    let canonical = path.canonicalize()?;
    if canonical.parent() != Some(canonical_parent) {
        return Err(ServerError::UnsafeUploadStore(format!(
            "{label} escapes its canonical project parent"
        )));
    }
    Ok(())
}

async fn publish_uploaded_file(
    uploads: &Path,
    filename: &str,
    temporary: &Path,
) -> Result<PathBuf, ServerError> {
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("upload");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            uploads.join(filename)
        } else {
            match extension {
                Some(extension) => uploads.join(format!("{stem}-{index}.{extension}")),
                None => uploads.join(format!("{stem}-{index}")),
            }
        };
        let canonical_parent = uploads.parent().ok_or_else(|| {
            ServerError::UnsafeUploadStore("uploads directory has no parent".to_owned())
        })?;
        ensure_upload_directory(
            uploads,
            &canonical_parent.canonicalize()?,
            ".somite/uploads",
        )?;
        match tokio::fs::hard_link(temporary, &candidate).await {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(ServerError::Io(error)),
        }
    }
    Err(ServerError::Upload(format!(
        "could not allocate a unique name for {filename}"
    )))
}

struct IncomingPaperFile {
    path: PathBuf,
    retained: bool,
}

impl IncomingPaperFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            retained: false,
        }
    }

    fn retain(&mut self) {
        self.retained = true;
    }
}

impl Drop for IncomingPaperFile {
    fn drop(&mut self) {
        if !self.retained {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[derive(Default)]
struct Utf8StreamValidator {
    tail: Vec<u8>,
}

impl Utf8StreamValidator {
    fn push(&mut self, bytes: &[u8]) -> bool {
        let joined;
        let candidate = if self.tail.is_empty() {
            bytes
        } else {
            joined = self
                .tail
                .iter()
                .copied()
                .chain(bytes.iter().copied())
                .collect::<Vec<_>>();
            joined.as_slice()
        };
        match std::str::from_utf8(candidate) {
            Ok(_) => {
                self.tail.clear();
                true
            }
            Err(error) if error.error_len().is_some() => false,
            Err(error) => {
                self.tail = candidate[error.valid_up_to()..].to_vec();
                self.tail.len() <= 3
            }
        }
    }

    fn complete(&self) -> bool {
        self.tail.is_empty()
    }
}

fn paper_media_kind(
    filename: &str,
    content_type: Option<&str>,
) -> Result<PaperMediaKind, ServerError> {
    if filename.len() > 255 || filename.chars().any(char::is_control) {
        return Err(ServerError::InvalidFilename);
    }
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let kind = match extension.as_str() {
        "pdf" => PaperMediaKind::Pdf,
        "txt" | "md" => PaperMediaKind::Text,
        _ => {
            return Err(ServerError::UnsupportedPaperUpload(
                "choose one PDF, text, or Markdown file".to_owned(),
            ))
        }
    };
    let compatible = content_type.is_none_or(|content_type| match kind {
        PaperMediaKind::Pdf => {
            matches!(content_type, "application/pdf" | "application/octet-stream")
        }
        PaperMediaKind::Text => {
            content_type.starts_with("text/") || content_type == "application/octet-stream"
        }
    });
    if !compatible {
        return Err(ServerError::UnsupportedPaperUpload(format!(
            "{content_type} does not match {extension}",
            content_type = content_type.unwrap_or("unknown content type")
        )));
    }
    Ok(kind)
}

async fn install_immutable_file(
    temporary: &Path,
    destination: &Path,
    expected_size: u64,
    expected_digest: Option<&str>,
) -> Result<bool, ServerError> {
    let reused = match tokio::fs::hard_link(temporary, destination).await {
        Ok(()) => false,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => true,
        Err(error) => return Err(ServerError::Io(error)),
    };
    let actual_size = tokio::fs::metadata(destination).await?.len();
    if actual_size != expected_size {
        return Err(ServerError::Upload(
            "content-addressed paper object has an unexpected size".to_owned(),
        ));
    }
    if reused {
        if let Some(expected_digest) = expected_digest {
            let mut input = tokio::fs::File::open(destination).await?;
            let mut hasher = blake3::Hasher::new();
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                let read = input.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            let actual_digest = format!("blake3:{}", hasher.finalize().to_hex());
            if actual_digest != expected_digest {
                return Err(ServerError::Upload(
                    "content-addressed paper object does not match its digest".to_owned(),
                ));
            }
        }
    }
    tokio::fs::remove_file(temporary).await?;
    Ok(reused)
}

async fn store_paper_display_name(
    project: &WebProject,
    source_hex: &str,
    source_digest: &str,
    filename: &str,
) -> Result<(), ServerError> {
    let record = StoredPaperDisplayName {
        schema_version: 1,
        source_digest: source_digest.to_owned(),
        filename: filename.to_owned(),
    };
    let encoded = serde_json::to_vec_pretty(&record)?;
    let directory = project.papers_dir().join("display-names").join(source_hex);
    tokio::fs::create_dir_all(&directory).await?;
    let name_digest = blake3::hash(filename.as_bytes()).to_hex();
    let destination = directory.join(format!("{name_digest}.json"));
    let temporary = directory.join(format!(".{}.tmp", project.next_id("display-name")));
    let mut temporary_guard = IncomingPaperFile::new(temporary.clone());
    tokio::fs::write(&temporary, &encoded).await?;
    let reused =
        install_immutable_file(&temporary, &destination, encoded.len() as u64, None).await?;
    temporary_guard.retain();
    if reused && tokio::fs::read(&destination).await? != encoded {
        return Err(ServerError::Upload(
            "paper display-name metadata does not match its stored record".to_owned(),
        ));
    }
    Ok(())
}

async fn upload_paper(
    State(project): State<Arc<WebProject>>,
    mut multipart: Multipart,
) -> Result<Json<PaperArtifactResponse>, ServerError> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| ServerError::Upload(error.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let supplied = field.file_name().ok_or(ServerError::InvalidFilename)?;
        let filename = Path::new(supplied)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or(ServerError::InvalidFilename)?
            .to_owned();
        let content_type = field.content_type().map(str::to_owned);
        let media_kind = paper_media_kind(&filename, content_type.as_deref())?;
        let incoming = project.papers_dir().join("incoming");
        tokio::fs::create_dir_all(&incoming).await?;
        let temporary = incoming.join(format!("{}.part", project.next_id("paper-upload")));
        let mut temporary_guard = IncomingPaperFile::new(temporary.clone());
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        let mut hasher = blake3::Hasher::new();
        let mut size_bytes = 0_u64;
        let mut leading = Vec::with_capacity(8);
        let mut utf8 = Utf8StreamValidator::default();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|error| ServerError::Upload(error.to_string()))?
        {
            size_bytes = size_bytes.saturating_add(chunk.len() as u64);
            if size_bytes > project.paper_limits.max_upload_bytes {
                return Err(ServerError::PaperUploadTooLarge {
                    limit_bytes: project.paper_limits.max_upload_bytes,
                });
            }
            if leading.len() < 8 {
                let remaining = 8 - leading.len();
                leading.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
            if matches!(media_kind, PaperMediaKind::Text)
                && (!utf8.push(&chunk) || chunk.contains(&0))
            {
                return Err(ServerError::UnsupportedPaperUpload(
                    "text and Markdown papers must contain valid UTF-8 text".to_owned(),
                ));
            }
            hasher.update(&chunk);
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        drop(output);
        if size_bytes == 0 {
            return Err(ServerError::UnsupportedPaperUpload(
                "paper file is empty".to_owned(),
            ));
        }
        if matches!(media_kind, PaperMediaKind::Pdf) && !leading.starts_with(b"%PDF-") {
            return Err(ServerError::UnsupportedPaperUpload(
                "the uploaded .pdf does not contain a PDF header".to_owned(),
            ));
        }
        if matches!(media_kind, PaperMediaKind::Text) && leading.starts_with(b"%PDF-") {
            return Err(ServerError::UnsupportedPaperUpload(
                "PDF bytes must be uploaded with a .pdf filename".to_owned(),
            ));
        }
        if matches!(media_kind, PaperMediaKind::Text) && !utf8.complete() {
            return Err(ServerError::UnsupportedPaperUpload(
                "text and Markdown papers must contain complete UTF-8 text".to_owned(),
            ));
        }

        let digest = format!("blake3:{}", hasher.finalize().to_hex());
        let hex = paper_digest_hex(&digest)?;
        let object_directory = project.papers_dir().join("objects").join(hex);
        tokio::fs::create_dir_all(&object_directory).await?;
        let destination = object_directory.join(format!("payload.{}", media_kind.extension()));
        let reused =
            install_immutable_file(&temporary, &destination, size_bytes, Some(&digest)).await?;
        temporary_guard.retain();

        let metadata = StoredPaperArtifact {
            schema_version: 1,
            digest: digest.clone(),
            size_bytes,
            media_kind,
        };
        let metadata_bytes = serde_json::to_vec_pretty(&metadata)?;
        let metadata_temporary =
            object_directory.join(format!(".artifact-{}.tmp", project.next_id("metadata")));
        let mut metadata_guard = IncomingPaperFile::new(metadata_temporary.clone());
        tokio::fs::write(&metadata_temporary, &metadata_bytes).await?;
        let metadata_destination = object_directory.join("artifact.json");
        let metadata_reused = install_immutable_file(
            &metadata_temporary,
            &metadata_destination,
            metadata_bytes.len() as u64,
            None,
        )
        .await?;
        metadata_guard.retain();
        if metadata_reused && tokio::fs::read(&metadata_destination).await? != metadata_bytes {
            return Err(ServerError::Upload(
                "content-addressed paper metadata does not match the stored object".to_owned(),
            ));
        }
        store_paper_display_name(&project, hex, &digest, &filename).await?;

        return Ok(Json(PaperArtifactResponse {
            digest,
            path: display_path(&project.root, &destination),
            filename,
            size_bytes,
            media_kind,
            reused,
        }));
    }
    Err(ServerError::MissingUpload)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tempfile::TempDir;
    use tower::ServiceExt;
    use zip::ZipArchive;

    const READY_RUN_GRAPH: &str = r#"{"schema_version":1,"nodes":[{"id":"noop","operator":"test.noop","ports":[],"layout":{"x":0.0,"y":0.0}}],"edges":[]}"#;

    fn fixture_project() -> (TempDir, WebProject) {
        fixture_project_with_run("exit 0")
    }

    fn fixture_project_with_run(run_body: &str) -> (TempDir, WebProject) {
        let temp = TempDir::new().expect("temporary project");
        std::fs::create_dir(temp.path().join("operators")).expect("operator directory");
        std::fs::write(
            temp.path().join("operators/test.noop.json"),
            r#"{"id":"test.noop","title":"No-op","palette":[],"kind":"external","bin":"true","argv":["true"]}"#,
        )
        .expect("no-op operator");
        let graph_path = temp.path().join("graph.somite.json");
        std::fs::write(&graph_path, r#"{"schema_version":1,"nodes":[],"edges":[]}"#)
            .expect("fixture graph");
        let fake_pixi = install_fake_pixi(temp.path(), run_body);
        let mut project = WebProject::open(temp.path(), &graph_path).expect("web project");
        project.pixi = Some(fake_pixi);
        (temp, project)
    }

    fn agent_fixture_project() -> (TempDir, WebProject) {
        let temp = TempDir::new().expect("temporary agent project");
        let operators = temp.path().join("operators");
        std::fs::create_dir(&operators).expect("operator directory");
        std::fs::write(
            operators.join("files.import.json"),
            r#"{"id":"files.import","title":"Import file","palette":["Sources"],"kind":"inprocess","params":{"path":{"type":"string","required":true}},"ports":{"out":[{"name":"file","type":"Fastq"}]}}"#,
        )
        .expect("import operator");
        std::fs::write(
            operators.join("files.import_paired.json"),
            r#"{"id":"files.import_paired","title":"Paired reads","palette":["Files"],"kind":"inprocess","params":{"r1":{"type":"string","label":"R1 path","page":"Reads","required":true},"r2":{"type":"string","label":"R2 path","page":"Reads","required":true}},"ports":{"out":[{"name":"r1","type":"Fastq"},{"name":"r2","type":"Fastq"}]}}"#,
        )
        .expect("paired import operator");
        let graph_path = temp.path().join("graph.somite.json");
        std::fs::write(&graph_path, r#"{"schema_version":1,"nodes":[],"edges":[]}"#)
            .expect("agent graph");
        let mut project = WebProject::open(temp.path(), &graph_path).expect("agent project");
        project.pixi = Some(install_fake_pixi(temp.path(), "exit 0"));
        (temp, project)
    }

    fn install_fake_pixi(root: &Path, run_body: &str) -> PathBuf {
        let fake_pixi = root.join("pixi");
        std::fs::write(
            &fake_pixi,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"lock\" ]; then\n  shift\n  while [ \"$#\" -gt 0 ]; do\n    if [ \"$1\" = \"--manifest-path\" ]; then manifest=$2; shift 2; else shift; fi\n  done\n  printf 'version: 6\\n' > \"$(dirname \"$manifest\")/pixi.lock\"\n  exit 0\nfi\nif [ \"$1\" = \"run\" ]; then\n  {run_body}\nfi\nexit 2\n"
            ),
        )
        .expect("fake Pixi");
        let mut permissions = std::fs::metadata(&fake_pixi)
            .expect("fake Pixi metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_pixi, permissions).expect("fake Pixi executable");
        fake_pixi
    }

    fn validation_fixture_project() -> (TempDir, WebProject, String) {
        let temp = TempDir::new().expect("temporary validation project");
        let operators = temp.path().join("operators");
        std::fs::create_dir(&operators).expect("operator directory");
        std::fs::write(
            operators.join("files.import.json"),
            r#"{"id":"files.import","title":"Import","palette":[],"kind":"inprocess","params":{"path":{"type":"string","required":true}},"ports":{"out":[{"name":"file","type":"Fastq"}]}}"#,
        )
        .expect("import operator");
        std::fs::write(
            operators.join("test.consume.json"),
            r#"{"id":"test.consume","title":"Consume","palette":[],"kind":"external","bin":"cat","pixi":["coreutils"],"ports":{"in":[{"name":"read","type":"Fastq"}]},"argv":["{input.read}"]}"#,
        )
        .expect("consumer operator");
        let graph = r#"{"schema_version":1,"nodes":[{"id":"input1","operator":"files.import","ports":[{"name":"file","dir":"out","ty":"Fastq"}],"params":{"path":"private/sample.fastq"},"layout":{"x":0.0,"y":0.0}},{"id":"consume1","operator":"test.consume","ports":[{"name":"read","dir":"in","ty":"Fastq"}],"layout":{"x":200.0,"y":0.0}}],"edges":[{"id":"edge1","from_node":"input1","from_port":"file","to_node":"consume1","to_port":"read"}]}"#.to_owned();
        let graph_path = temp.path().join("graph.somite.json");
        std::fs::write(&graph_path, &graph).expect("validation graph");
        let mut project = WebProject::open(temp.path(), &graph_path).expect("web project");
        project.pixi = Some(install_fake_pixi(temp.path(), "exit 0"));
        (temp, project, graph)
    }

    async fn wait_for_phase(router: &Router, run_id: &str, expected: &str) -> serde_json::Value {
        for _ in 0..200 {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/runs/{run_id}"))
                        .body(Body::empty())
                        .expect("status request"),
                )
                .await
                .expect("status response");
            let body = response
                .into_body()
                .collect()
                .await
                .expect("status body")
                .to_bytes();
            let status: serde_json::Value = serde_json::from_slice(&body).expect("status json");
            if status["phase"] == expected {
                return status;
            }
            if matches!(
                status["phase"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                panic!(
                    "run reached {} before {expected}: {status}",
                    status["phase"]
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("run did not reach {expected}");
    }

    fn multipart_upload_request(
        uri: &str,
        boundary: &str,
        filename: &str,
        content_type: &str,
        contents: &[u8],
    ) -> Request<Body> {
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(contents);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:7310")
            .header("x-somite-request", "local")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .expect("multipart request")
    }

    async fn response_json(response: Response) -> serde_json::Value {
        serde_json::from_slice(
            &response
                .into_body()
                .collect()
                .await
                .expect("response body")
                .to_bytes(),
        )
        .expect("response json")
    }

    async fn wait_for_paper_phase(
        router: &Router,
        job_id: &str,
        expected: &str,
    ) -> serde_json::Value {
        for _ in 0..200 {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/papers/intakes/{job_id}?wait_ms=100"))
                        .body(Body::empty())
                        .expect("paper status request"),
                )
                .await
                .expect("paper status response");
            let status = response_json(response).await;
            if status["phase"] == expected {
                return status;
            }
            if matches!(
                status["phase"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                panic!(
                    "paper intake reached {} before {expected}: {status}",
                    status["phase"]
                );
            }
        }
        panic!("paper intake did not reach {expected}");
    }

    fn test_paper_intake_job(id: &str, phase: PaperIntakePhase) -> Arc<PaperIntakeJob> {
        Arc::new(PaperIntakeJob {
            status: Mutex::new(PaperIntakeStatusResponse {
                job_id: id.to_owned(),
                source_digest: format!("blake3:{}", "0".repeat(64)),
                phase,
                progress: paper_progress(phase),
                durations_ms: BTreeMap::new(),
                cache: PaperCacheUse::default(),
                result: None,
                failure: None,
            }),
            cancel: Arc::new(AtomicBool::new(false)),
            cancelled: Notify::new(),
            created_at: Instant::now(),
        })
    }

    fn write_test_executable(path: &Path, contents: &[u8]) {
        std::fs::write(path, contents).expect("test executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path)
                .expect("test executable metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).expect("test executable permissions");
        }
    }

    struct NfcoreSourceFixture {
        temp: TempDir,
        request: WorkflowGraphRequest,
        repository: PathBuf,
        resolved_revision: String,
        source_operator_revision: String,
    }

    impl NfcoreSourceFixture {
        fn root(&self) -> &Path {
            self.temp.path()
        }
    }

    fn nfcore_source_fixture() -> NfcoreSourceFixture {
        nfcore_source_fixture_with_parameter_schema(true)
    }

    fn nfcore_source_fixture_with_parameter_schema(
        include_parameter_schema: bool,
    ) -> NfcoreSourceFixture {
        let schema = include_parameter_schema.then_some(
            r#"{
  "type": "object",
  "properties": {
    "label": {"type": "string", "title": "Label"},
    "input_file": {"type": "string", "format": "file-path", "title": "Input file"},
    "input_dir": {"type": "string", "format": "directory-path", "title": "Input directory"}
  }
}
"#,
        );
        nfcore_source_fixture_with_schema(schema)
    }

    fn nfcore_source_fixture_with_schema(schema: Option<&str>) -> NfcoreSourceFixture {
        let temp = TempDir::new().expect("temporary nf-core source project");
        let root = temp.path();
        let seed = root.join("seed");
        run_test_command(
            Command::new("git").args(["init", "--quiet"]).arg(&seed),
            "initialize source repository",
        );
        run_test_command(
            Command::new("git")
                .arg("-C")
                .arg(&seed)
                .args(["config", "user.name", "Somite Test"]),
            "configure Git user",
        );
        run_test_command(
            Command::new("git").arg("-C").arg(&seed).args([
                "config",
                "user.email",
                "somite@example.invalid",
            ]),
            "configure Git email",
        );
        std::fs::write(
            seed.join("main.nf"),
            r#"nextflow.enable.dsl=2
process DEMO {
  output:
  path 'done.txt'
  script:
  """
  touch done.txt
  """
}
workflow { DEMO() }
"#,
        )
        .expect("workflow source");
        std::fs::write(
            seed.join("nextflow.config"),
            format!(
                "new File('{}').text = 'remote config was interpreted'\n",
                root.join("remote-config-ran").display()
            ),
        )
        .expect("non-executed workflow configuration fixture");
        if let Some(schema) = schema {
            std::fs::write(seed.join("nextflow_schema.json"), schema).expect("parameter schema");
        }
        run_test_command(
            Command::new("git").arg("-C").arg(&seed).args(["add", "."]),
            "stage source",
        );
        run_test_command(
            Command::new("git")
                .arg("-C")
                .arg(&seed)
                .args(["commit", "--quiet", "-m", "fixture"]),
            "commit source",
        );
        run_test_command(
            Command::new("git")
                .arg("-C")
                .arg(&seed)
                .args(["tag", "1.2.3"]),
            "tag source",
        );
        let resolved_revision = run_test_command(
            Command::new("git")
                .arg("-C")
                .arg(&seed)
                .args(["rev-parse", "HEAD"]),
            "resolve fixture revision",
        )
        .trim()
        .to_owned();

        let asset_root = root.join("assets/.repos/nf-core/demo");
        std::fs::create_dir_all(&asset_root).expect("asset root");
        run_test_command(
            Command::new("git")
                .args(["clone", "--quiet", "--bare"])
                .arg(&seed)
                .arg(asset_root.join("bare")),
            "clone bare asset",
        );

        let catalog = root.join(".somite/catalog");
        std::fs::create_dir_all(&catalog).expect("catalog directory");
        std::fs::write(
            catalog.join("nfcore-pipelines.json"),
            r#"{"remote_workflows":[{"name":"demo","description":"Demo pipeline","topics":["testing"],"archived":false,"releases":[{"tag_name":"1.2.3"}]}]}"#,
        )
        .expect("nf-core catalog");

        let operators = root.join("operators");
        std::fs::create_dir(&operators).expect("operator directory");
        std::fs::write(
            operators.join("workflow.source.json"),
            r#"{"id":"workflow.source","title":"Source-backed workflow","palette":[],"kind":"source","cost":"high","ports":{"in":[],"out":[]}}"#,
        )
        .expect("source operator");
        let source_operator_revision = Catalog::load_dir(&operators)
            .expect("source catalog")
            .revision("workflow.source")
            .expect("source operator revision");

        NfcoreSourceFixture {
            temp,
            request: WorkflowGraphRequest {
                workflow: "nf-core/demo".to_owned(),
                revision: "1.2.3".to_owned(),
            },
            repository: asset_root.join("bare"),
            resolved_revision,
            source_operator_revision,
        }
    }

    fn run_test_command(command: &mut Command, operation: &str) -> String {
        let output = command.output().expect(operation);
        assert!(
            output.status.success(),
            "{operation}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("UTF-8 command output")
    }

    fn run_test_command_with_stdin(command: &mut Command, input: &[u8], operation: &str) -> String {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect(operation);
        child
            .stdin
            .take()
            .expect("test command stdin")
            .write_all(input)
            .expect("write test command stdin");
        let output = child.wait_with_output().expect(operation);
        assert!(
            output.status.success(),
            "{operation}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("UTF-8 command output")
    }

    #[cfg(unix)]
    fn inject_reserved_git_hook_tree(fixture: &NfcoreSourceFixture, marker: &Path) {
        let hook = fixture.root().join("remote-hook-payload");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display()),
        )
        .expect("remote hook payload");
        let blob = run_test_command(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .args(["hash-object", "-w"])
                .arg(&hook),
            "write malicious hook blob",
        );
        let hooks_tree = run_test_command_with_stdin(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .arg("mktree"),
            format!(
                "100755 blob {}\tpost-index-change\n100755 blob {}\treference-transaction\n",
                blob.trim(),
                blob.trim()
            )
            .as_bytes(),
            "write malicious hooks tree",
        );
        let dot_git_tree = run_test_command_with_stdin(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .arg("mktree"),
            format!("040000 tree {}\thooks\n", hooks_tree.trim()).as_bytes(),
            "write malicious .git tree",
        );
        let base_tree = run_test_command(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .args(["ls-tree", &fixture.resolved_revision]),
            "read base source tree",
        );
        let root_tree = run_test_command_with_stdin(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .arg("mktree"),
            format!("040000 tree {}\t.git\n{base_tree}", dot_git_tree.trim()).as_bytes(),
            "write malicious root tree",
        );
        let commit = run_test_command(
            Command::new("git")
                .env("GIT_AUTHOR_NAME", "Somite Test")
                .env("GIT_AUTHOR_EMAIL", "somite@example.invalid")
                .env("GIT_COMMITTER_NAME", "Somite Test")
                .env("GIT_COMMITTER_EMAIL", "somite@example.invalid")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .args([
                    "commit-tree",
                    root_tree.trim(),
                    "-p",
                    &fixture.resolved_revision,
                    "-m",
                    "malicious reserved metadata tree",
                ]),
            "commit malicious tree",
        );
        run_test_command(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .args(["tag", "--force", "1.2.3", commit.trim()]),
            "retag malicious tree",
        );
    }

    fn directory_entry_count(path: &Path) -> usize {
        std::fs::read_dir(path)
            .expect("stored directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("stored entries")
            .len()
    }

    fn browser_parse_stringify_numbers(value: &mut Value) {
        match value {
            Value::Number(number) => {
                let Some(number) = number.as_f64() else {
                    return;
                };
                if !number.is_finite() || number.fract() != 0.0 {
                    return;
                }
                let integer = number as i64;
                if (somite_ir::MIN_EXACT_JSON_INTEGER..=somite_ir::MAX_EXACT_JSON_INTEGER)
                    .contains(&integer)
                    && integer as f64 == number
                {
                    *value = Value::from(integer);
                }
            }
            Value::Array(values) => {
                for value in values {
                    browser_parse_stringify_numbers(value);
                }
            }
            Value::Object(fields) => {
                for value in fields.values_mut() {
                    browser_parse_stringify_numbers(value);
                }
            }
            Value::Null | Value::Bool(_) | Value::String(_) => {}
        }
    }

    #[test]
    fn nfcore_source_resolver_enforces_the_cached_catalog_before_fetch() {
        let fixture = nfcore_source_fixture();
        let request = WorkflowGraphRequest {
            workflow: fixture.request.workflow.clone(),
            revision: "9.9.9".to_owned(),
        };

        let error = import_nfcore_source(
            fixture.root(),
            &request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect_err("uncatalogued release must fail");

        assert!(
            error
                .to_string()
                .contains("workflow release is not in the current nf-core catalog"),
            "{error}"
        );
    }

    #[test]
    fn nfcore_git_metadata_rejects_oversized_tree_output() {
        let fixture = nfcore_source_fixture();
        let isolation_root = TempDir::new().expect("temporary Git isolation root");
        let isolation = NfcoreGitIsolation::new(isolation_root.path(), true)
            .expect("bounded-output Git isolation");
        let error = run_nfcore_git_bounded(
            Command::new("git")
                .arg("--git-dir")
                .arg(&fixture.repository)
                .args(["ls-tree", "-l", "-r", "-z", "--full-tree"])
                .arg(&fixture.resolved_revision),
            &isolation,
            "enumerate exact tracked nf-core source files",
            64,
        )
        .expect_err("tree metadata beyond the fixed capture bound must fail");

        assert!(
            error
                .to_string()
                .contains("Git stdout exceeded the 64-byte capture limit"),
            "{error}"
        );
    }

    #[test]
    fn nfcore_git_capture_rejects_oversized_stderr_without_deadlock() {
        const CHILD: &str = "SOMITE_TEST_OVERSIZED_GIT_STDERR_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let chunk = [b'x'; 8 * 1024];
            let mut stderr = std::io::stderr().lock();
            for _ in 0..=(MAX_NFCORE_GIT_DIAGNOSTIC_BYTES / chunk.len()) {
                if stderr.write_all(&chunk).is_err() {
                    break;
                }
            }
            let _ = stderr.flush();
            return;
        }

        let isolation_root = TempDir::new().expect("temporary Git isolation root");
        let isolation = NfcoreGitIsolation::new(isolation_root.path(), false)
            .expect("bounded-output Git isolation");
        let error = run_nfcore_git_bounded(
            Command::new(std::env::current_exe().expect("server test executable"))
                .args([
                    "--exact",
                    "tests::nfcore_git_capture_rejects_oversized_stderr_without_deadlock",
                    "--nocapture",
                ])
                .env(CHILD, "1"),
            &isolation,
            "capture Git diagnostics",
            MAX_NFCORE_GIT_METADATA_BYTES,
        )
        .expect_err("diagnostics beyond the fixed capture bound must fail");

        assert!(
            error.to_string().contains(&format!(
                "Git stderr exceeded the {MAX_NFCORE_GIT_DIAGNOSTIC_BYTES}-byte capture limit"
            )),
            "{error}"
        );
    }

    #[test]
    fn nfcore_blob_read_verifies_bytes_against_the_advertised_git_object() {
        let repository_root = TempDir::new().expect("temporary bare repository root");
        let bare = repository_root.path().join("repository.git");
        run_test_command(
            Command::new("git")
                .args(["init", "--bare", "--quiet"])
                .arg(&bare),
            "initialize corrupt-object fixture",
        );
        let original = b"safe\n";
        let substitute = b"evil\n";
        let original_object = run_test_command_with_stdin(
            Command::new("git")
                .arg("--git-dir")
                .arg(&bare)
                .args(["hash-object", "-w", "--stdin"]),
            original,
            "write original loose blob",
        )
        .trim()
        .to_owned();
        let substitute_object = run_test_command_with_stdin(
            Command::new("git")
                .arg("--git-dir")
                .arg(&bare)
                .args(["hash-object", "-w", "--stdin"]),
            substitute,
            "write substitute loose blob",
        )
        .trim()
        .to_owned();
        assert_ne!(original_object, substitute_object);
        let loose_object =
            |object: &str| bare.join("objects").join(&object[..2]).join(&object[2..]);
        let original_path = loose_object(&original_object);
        std::fs::remove_file(&original_path).expect("remove original loose object bytes");
        std::fs::copy(loose_object(&substitute_object), &original_path)
            .expect("replace original object bytes without changing its advertised name");

        let isolation_root = TempDir::new().expect("temporary Git isolation root");
        let isolation = NfcoreGitIsolation::new(isolation_root.path(), true)
            .expect("corrupt-object Git isolation");
        let error = read_nfcore_git_blob(
            &bare,
            &isolation,
            &original_object,
            original.len() as u64,
            "main.nf",
        )
        .expect_err("substituted bytes must not inherit the advertised object identity");

        assert!(
            error
                .to_string()
                .contains("did not match its advertised object identity"),
            "{error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn nfcore_source_resolver_rejects_reserved_git_hooks_without_executing_them() {
        let fixture = nfcore_source_fixture();
        let marker = fixture.root().join("remote-hook-executed");
        inject_reserved_git_hook_tree(&fixture, &marker);

        let error = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect_err("reserved .git hook tree must fail before extraction");

        assert!(
            error
                .to_string()
                .contains("unsafe or duplicate tracked path .git/hooks/"),
            "{error}"
        );
        assert!(!marker.exists(), "remote Git hook payload was executed");
    }

    #[cfg(unix)]
    #[test]
    fn nfcore_source_resolver_ignores_hostile_global_git_fsmonitor() {
        const CHILD: &str = "SOMITE_TEST_HOSTILE_GIT_CHILD";
        const ROOT: &str = "SOMITE_TEST_HOSTILE_GIT_ROOT";
        const REPOSITORY: &str = "SOMITE_TEST_HOSTILE_GIT_REPOSITORY";
        const OPERATOR_REVISION: &str = "SOMITE_TEST_HOSTILE_GIT_OPERATOR_REVISION";
        const MARKER: &str = "SOMITE_TEST_HOSTILE_GIT_MARKER";

        if std::env::var_os(CHILD).is_some() {
            let root = PathBuf::from(std::env::var_os(ROOT).expect("child project root"));
            let repository = PathBuf::from(std::env::var_os(REPOSITORY).expect("child repository"));
            let source_operator_revision =
                std::env::var(OPERATOR_REVISION).expect("child source operator revision");
            let marker = PathBuf::from(std::env::var_os(MARKER).expect("child marker"));
            import_nfcore_source(
                &root,
                &WorkflowGraphRequest {
                    workflow: "nf-core/demo".to_owned(),
                    revision: "1.2.3".to_owned(),
                },
                &source_operator_revision,
                Some(&repository),
            )
            .expect("source resolution under hostile global Git configuration");
            assert!(
                !marker.exists(),
                "untrusted global core.fsmonitor was executed"
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        let fixture = nfcore_source_fixture();
        let marker = fixture.root().join("hostile-global-fsmonitor-ran");
        let fsmonitor = fixture.root().join("hostile-global-fsmonitor");
        std::fs::write(
            &fsmonitor,
            format!(
                "#!/bin/sh\nprintf executed > '{}'\nprintf 'somite-test-token\\n'\n",
                marker.display()
            ),
        )
        .expect("hostile fsmonitor fixture");
        std::fs::set_permissions(&fsmonitor, std::fs::Permissions::from_mode(0o755))
            .expect("executable hostile fsmonitor fixture");
        let hostile_global = fixture.root().join("hostile-global-git-config");
        std::fs::write(
            &hostile_global,
            format!(
                "[core]\n\tfsmonitor = {}\n\tfsmonitorHookVersion = 2\n",
                fsmonitor.display()
            ),
        )
        .expect("hostile global Git configuration");

        let output = Command::new(std::env::current_exe().expect("server test executable"))
            .args([
                "--exact",
                "tests::nfcore_source_resolver_ignores_hostile_global_git_fsmonitor",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env(ROOT, fixture.root())
            .env(REPOSITORY, &fixture.repository)
            .env(OPERATOR_REVISION, &fixture.source_operator_revision)
            .env(MARKER, &marker)
            .env("GIT_CONFIG_GLOBAL", &hostile_global)
            .output()
            .expect("run isolated source resolver child test");
        assert!(
            output.status.success(),
            "resolver child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !marker.exists(),
            "untrusted global core.fsmonitor was executed"
        );
    }

    #[test]
    fn source_paths_reserve_git_metadata_across_platform_spellings() {
        for reserved in [
            ".git/hooks/pre-commit",
            ".GIT/config",
            ".git./hooks/post-index-change",
            ".git /config",
            ".git::$INDEX_ALLOCATION/hooks/reference-transaction",
            "nested/.Git/hooks/pre-push",
            "git~1/config",
            "nested/GIT~1./config",
            ".g\u{200c}it/config",
        ] {
            assert!(
                reserved_git_metadata_path(reserved),
                "expected {reserved} to be reserved"
            );
        }
        for ordinary in [".gitignore", ".gitattributes", "git/hooks.txt"] {
            assert!(
                !reserved_git_metadata_path(ordinary),
                "expected {ordinary} to remain a source path"
            );
        }
    }

    #[test]
    fn portable_source_path_aliases_are_rejected_before_cas_materialization() {
        for aliases in [
            ["A.nf", "a.nf"],
            ["caf\u{e9}.nf", "cafe\u{301}.nf"],
            ["Stra\u{df}e.nf", "STRASSE.nf"],
            ["A/first.nf", "a/second.nf"],
            ["dir", "dir/file.nf"],
        ] {
            let mut files = aliases
                .into_iter()
                .map(|path| FrozenSourceFile {
                    path: path.to_owned(),
                    mode: 0o100644,
                    bytes: b"x".to_vec(),
                })
                .collect::<Vec<_>>();
            files.sort_by(|left, right| left.path.cmp(&right.path));
            let error = source_manifest_from_frozen(&files, files.len() as u64)
                .expect_err("portable source path aliases must be rejected");
            assert!(error.to_string().contains("portable filesystem"), "{error}");

            let manifest = SourceManifest {
                schema_version: 1,
                source_digest: format!("blake3:{}", "0".repeat(64)),
                source_bytes: files.len() as u64,
                files: files
                    .iter()
                    .map(|file| SourceFileManifest {
                        path: file.path.clone(),
                        mode: file.mode,
                        bytes: file.bytes.len() as u64,
                        digest: format!("blake3:{}", blake3::hash(&file.bytes).to_hex()),
                    })
                    .collect(),
            };
            let paired = manifest
                .files
                .iter()
                .cloned()
                .zip(files.iter().map(|file| file.bytes.clone()))
                .collect::<Vec<_>>();
            let target = TempDir::new().expect("portable collision target");
            let error = persist_source_object(target.path(), &manifest, &paired)
                .expect_err("portable aliases must fail before source CAS creation");
            assert!(error.to_string().contains("portable filesystem"), "{error}");
            assert!(!source_workflow_store(target.path()).exists());
        }
    }

    #[test]
    fn windows_invalid_source_components_are_rejected_before_cas_materialization() {
        for invalid in [
            "CON",
            "con.nf",
            "PrN.json",
            "AUX",
            "nul.txt",
            "COM1.nf",
            "com9",
            "LPT1.txt",
            "lpt9",
            "bad:name.nf",
            "bad<name.nf",
            "bad>name.nf",
            "bad\"name.nf",
            "bad\\name.nf",
            "bad|name.nf",
            "bad?name.nf",
            "bad*name.nf",
            "trailing-dot.",
            "trailing-space ",
            "control-\u{1f}.nf",
        ] {
            let error = PortableSourcePathRegistry::default()
                .insert(invalid)
                .expect_err("Windows-invalid source component must be rejected");
            assert!(
                error.to_string().contains("not portable"),
                "{invalid}: {error}"
            );
        }
        let mut registry = PortableSourcePathRegistry::default();
        for portable in [
            "console.nf",
            "printer.nf",
            "auxiliary.nf",
            "null.nf",
            "com0.nf",
            "com10.nf",
            "lpt0.nf",
            "lpt10.nf",
        ] {
            registry
                .insert(portable)
                .unwrap_or_else(|error| panic!("{portable} should remain portable: {error}"));
        }

        let manifest = SourceManifest {
            schema_version: 1,
            source_digest: format!("blake3:{}", "0".repeat(64)),
            source_bytes: 1,
            files: vec![SourceFileManifest {
                path: "CON.nf".to_owned(),
                mode: 0o100644,
                bytes: 1,
                digest: format!("blake3:{}", blake3::hash(b"x").to_hex()),
            }],
        };
        let files = vec![(manifest.files[0].clone(), b"x".to_vec())];
        let target = TempDir::new().expect("Windows-invalid source target");
        let error = persist_source_object(target.path(), &manifest, &files)
            .expect_err("Windows-invalid source must fail before CAS creation");
        assert!(error.to_string().contains("not portable"), "{error}");
        assert!(!source_workflow_store(target.path()).exists());
    }

    #[test]
    fn server_source_paths_match_shared_blank_and_byte_limits() {
        assert!(safe_source_relative_path("data/input file.fa"));
        assert!(safe_source_relative_path(
            &"a".repeat(MAX_SOURCE_PATH_BYTES)
        ));
        for invalid in [
            "".to_owned(),
            " \t\n".to_owned(),
            "\u{2003}".to_owned(),
            "a".repeat(MAX_SOURCE_PATH_BYTES + 1),
            "\u{e9}".repeat(MAX_SOURCE_PATH_BYTES / 2 + 1),
        ] {
            assert!(
                !safe_source_relative_path(&invalid),
                "source path should be rejected: {invalid:?}"
            );
        }

        let oversized_path = "a".repeat(MAX_SOURCE_PATH_BYTES + 1);
        let manifest = SourceManifest {
            schema_version: 1,
            source_digest: format!("blake3:{}", "0".repeat(64)),
            source_bytes: 1,
            files: vec![SourceFileManifest {
                path: oversized_path,
                mode: 0o100644,
                bytes: 1,
                digest: format!("blake3:{}", blake3::hash(b"x").to_hex()),
            }],
        };
        let files = vec![(manifest.files[0].clone(), b"x".to_vec())];
        let target = TempDir::new().expect("oversized source-path target");
        let error = persist_source_object(target.path(), &manifest, &files)
            .expect_err("oversized source path must fail before CAS materialization");
        assert!(error.to_string().contains("invalid entry"), "{error}");
        assert!(!source_workflow_store(target.path()).exists());
    }

    #[test]
    fn portable_metadata_frame_propagates_modified_time_errors() {
        let mut hasher = blake3::Hasher::new();
        let error = update_portable_source_metadata_frame(
            &mut hasher,
            1,
            Err(std::io::Error::other("modified time unavailable")),
            true,
            false,
        )
        .expect_err("portable metadata failures must not be ignored");
        assert!(error.to_string().contains("modified time unavailable"));

        let mut hasher = blake3::Hasher::new();
        update_portable_source_metadata_frame(
            &mut hasher,
            1,
            Ok(UNIX_EPOCH + Duration::from_secs(1)),
            true,
            false,
        )
        .expect("portable metadata frame");
        assert_ne!(hasher.finalize(), blake3::hash(&[]));
    }

    #[test]
    fn staged_source_object_verifier_rejects_changed_or_extra_bytes() {
        let frozen = vec![FrozenSourceFile {
            path: "main.nf".to_owned(),
            mode: 0o100644,
            bytes: b"ok\n".to_vec(),
        }];
        let manifest = source_manifest_from_frozen(&frozen, 3).expect("source manifest");
        let files = pair_frozen_source_files(frozen, &manifest).expect("paired source files");
        let stage = TempDir::new().expect("staged source object");
        let source = stage.path().join("source");
        std::fs::create_dir(&source).expect("staged source directory");
        std::fs::write(source.join("main.nf"), b"ok\n").expect("staged source file");
        std::fs::write(
            stage.path().join("source-manifest.json"),
            pretty_json_line(&manifest).expect("encoded source manifest"),
        )
        .expect("staged source manifest");
        verify_staged_source_object(stage.path(), &manifest, &files)
            .expect("exact staged source object");

        std::fs::write(source.join("main.nf"), b"no\n").expect("mutated staged source file");
        let error = verify_staged_source_object(stage.path(), &manifest, &files)
            .expect_err("changed staged bytes must fail before publish");
        assert!(error.to_string().contains("exact source bytes"), "{error}");

        std::fs::write(source.join("main.nf"), b"ok\n").expect("restored staged source file");
        std::fs::write(source.join("extra.nf"), b"extra\n").expect("extra staged source file");
        let error = verify_staged_source_object(stage.path(), &manifest, &files)
            .expect_err("extra staged entry must fail before publish");
        assert!(error.to_string().contains("unmanifested file"), "{error}");
    }

    #[test]
    fn full_cold_source_read_stats_each_deep_shared_entry_once() {
        const DEPTH: usize = 24;
        const FILES: usize = 256;

        let shared_prefix = (0..DEPTH)
            .map(|depth| format!("d{depth:02}"))
            .collect::<Vec<_>>()
            .join("/");
        let mut frozen = Vec::with_capacity(FILES);
        let mut source_bytes = 0_u64;
        for index in 0..FILES {
            let relative = format!("{shared_prefix}/file-{index:03}.nf");
            let bytes = format!("workflow {{ VALUE_{index}() }}\n").into_bytes();
            source_bytes += bytes.len() as u64;
            frozen.push(FrozenSourceFile {
                path: relative,
                mode: 0o100644,
                bytes,
            });
        }
        let manifest = source_manifest_from_frozen(&frozen, source_bytes)
            .expect("deep shared source manifest");
        let files = pair_frozen_source_files(frozen, &manifest).expect("deep shared source files");
        let project = TempDir::new().expect("deep shared source project");
        persist_source_object(project.path(), &manifest, &files)
            .expect("persist deep shared source object");
        let (_, stored_manifest, inspection) = read_stored_source_object_inspected(
            project.path(),
            &manifest.source_digest,
            SourceTreeReadMode::Contents,
        )
        .expect("linear full cold source read");
        assert_eq!(stored_manifest, manifest);
        assert_eq!(inspection.files.as_ref(), Some(&files));
        assert_eq!(
            inspection.metadata_operations,
            1 + DEPTH + FILES,
            "the root, each shared directory, and each file must be lstat'd exactly once"
        );
        assert!(
            inspection.metadata_operations < FILES * DEPTH,
            "inspection must not re-stat the shared directory chain for every file"
        );
        assert_eq!(
            inspection.file_metadata_operations,
            FILES * 2,
            "each opened file must be fstat'd once before and once after its bounded read"
        );
        let (wrapper_manifest, wrapper_files) =
            read_stored_source_object(project.path(), &manifest.source_digest)
                .expect("production cold source-object read");
        assert_eq!(wrapper_manifest, manifest);
        assert_eq!(wrapper_files, files);
        let (_, _, repeated) = read_stored_source_object_inspected(
            project.path(),
            &manifest.source_digest,
            SourceTreeReadMode::MetadataOnly,
        )
        .expect("repeat deep source metadata inspection");
        assert_eq!(
            repeated.metadata_fingerprint, inspection.metadata_fingerprint,
            "single-pass metadata fingerprints must be deterministic"
        );
    }

    #[test]
    fn source_derivation_reuses_cold_read_byte_allocations() {
        let files = ["main.nf", "nextflow.config"]
            .into_iter()
            .map(|path| {
                let bytes = format!("content for {path}\n").into_bytes();
                (
                    SourceFileManifest {
                        path: path.to_owned(),
                        mode: 0o100644,
                        bytes: bytes.len() as u64,
                        digest: format!("blake3:{}", blake3::hash(&bytes).to_hex()),
                    },
                    bytes,
                )
            })
            .collect::<StoredSourceFiles>();
        let allocations = files
            .iter()
            .map(|(_, bytes)| (bytes.as_ptr(), bytes.capacity()))
            .collect::<Vec<_>>();
        let frozen = into_frozen_source_files(files);
        assert_eq!(frozen.len(), allocations.len());
        for (file, (pointer, capacity)) in frozen.iter().zip(allocations) {
            assert_eq!(file.bytes.as_ptr(), pointer);
            assert_eq!(file.bytes.capacity(), capacity);
        }
    }

    #[test]
    fn source_verification_gates_remain_fixed_under_many_distinct_keys() {
        let mut gate_addresses = BTreeSet::new();
        for index in 0..4_096 {
            let key = (
                PathBuf::from(format!("/synthetic-project-{index}")),
                format!("blake3:{index:064x}"),
                format!("synthetic-indexer-{index}"),
            );
            let gate = source_verification_gate(&key);
            let _ = gate_addresses.insert(std::ptr::from_ref(gate).addr());
        }
        let gates = SOURCE_VERIFICATION_GATES
            .get()
            .expect("fixed source verification gates");
        assert_eq!(gates.len(), SOURCE_VERIFICATION_GATE_STRIPES);
        assert!(gate_addresses.len() > 1);
        assert!(gate_addresses.len() <= SOURCE_VERIFICATION_GATE_STRIPES);
    }

    #[cfg(unix)]
    #[test]
    fn nfcore_source_resolver_rejects_a_symlinked_store_parent_before_fetch() {
        let fixture = nfcore_source_fixture();
        let somite = fixture.root().join(".somite");
        let actual = fixture.root().join(".somite-actual");
        std::fs::rename(&somite, &actual).expect("move Somite fixture state");
        std::os::unix::fs::symlink(".somite-actual", &somite)
            .expect("symlink Somite fixture state");

        let error = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect_err("symlinked .somite parent must fail");

        assert!(
            error
                .to_string()
                .contains(".somite must be a regular non-symlink directory"),
            "{error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_store_rejects_symlinked_internal_directories() {
        for name in ["objects", "instances", "revisions", "requests"] {
            let project = TempDir::new().expect("temporary source store project");
            let store = project.path().join(".somite/source-workflows");
            std::fs::create_dir_all(&store).expect("source store");
            let outside = project.path().join(format!("outside-{name}"));
            std::fs::create_dir(&outside).expect("symlink target");
            std::os::unix::fs::symlink(&outside, store.join(name)).expect("source store symlink");

            let error = checked_source_workflow_store(project.path(), false)
                .expect_err("symlinked store child must fail");
            assert!(
                error
                    .to_string()
                    .contains("must be a regular non-symlink directory"),
                "{name}: {error}"
            );
        }
    }

    #[test]
    fn source_store_allows_concurrent_first_writers() {
        let project = TempDir::new().expect("temporary concurrent source store project");
        let root = project.path().to_path_buf();
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let writers = (0..16)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    checked_source_store_subdir(&root, "objects", true)
                        .expect("concurrent source store initialization")
                        .expect("created objects directory")
                })
            })
            .collect::<Vec<_>>();

        let paths = writers
            .into_iter()
            .map(|writer| writer.join().expect("source store writer"))
            .collect::<Vec<_>>();
        assert!(paths.iter().all(|path| path == &paths[0]));
        assert!(paths[0].is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn nfcore_catalog_cache_rejects_a_symlinked_file() {
        let project = TempDir::new().expect("temporary nf-core catalog project");
        let cache = checked_nfcore_catalog_cache_path(project.path(), true)
            .expect("initialize catalog cache")
            .expect("catalog cache path");
        let outside = project.path().join("outside-catalog.json");
        std::fs::write(&outside, b"{}\n").expect("outside catalog");
        std::os::unix::fs::symlink(&outside, &cache).expect("catalog cache symlink");

        let error = checked_nfcore_catalog_cache_path(project.path(), false)
            .expect_err("symlinked catalog cache must fail");
        assert!(
            error
                .to_string()
                .contains("catalog cache must be a regular non-symlink file"),
            "{error}"
        );
    }

    #[test]
    fn nfcore_catalog_cache_concurrent_writes_remain_whole() {
        let project = TempDir::new().expect("temporary nf-core catalog project");
        let cache = checked_nfcore_catalog_cache_path(project.path(), true)
            .expect("initialize catalog cache")
            .expect("catalog cache path");
        let first =
            br#"{"remote_workflows":[{"name":"first","releases":[{"tag_name":"1"}]}]}"#.to_vec();
        let second =
            br#"{"remote_workflows":[{"name":"second","releases":[{"tag_name":"2"}]}]}"#.to_vec();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writers = [first.clone(), second.clone()]
            .into_iter()
            .map(|contents| {
                let cache = cache.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    write_catalog_cache_atomic(&cache, &contents)
                        .expect("atomic catalog cache write");
                })
            })
            .collect::<Vec<_>>();
        for writer in writers {
            writer.join().expect("catalog cache writer");
        }
        let stored =
            read_regular_file(&cache, MAX_NFCORE_CATALOG_BYTES).expect("whole catalog cache");
        assert!(stored == first || stored == second);
        let text = String::from_utf8(stored).expect("UTF-8 catalog cache");
        nfcore::parse(&text).expect("complete catalog cache JSON");
    }

    #[test]
    fn nfcore_source_resolver_returns_one_cached_source_node_without_ports() {
        let fixture = nfcore_source_fixture();
        let first = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("first source resolution");

        assert!(!first.cached);
        assert!(
            !fixture.root().join("remote-config-ran").exists(),
            "source resolution must never interpret remote Nextflow configuration"
        );
        assert_eq!(first.graph.schema_version, somite_ir::SCHEMA_VERSION);
        assert_eq!(first.graph.nodes.len(), 1);
        assert!(first.graph.edges.is_empty());
        let node = &first.graph.nodes[0];
        assert_eq!(node.operator, "workflow.source");
        assert!(node.ports.is_empty());
        assert!(node.params.is_empty());
        let workflow = node.source_workflow.as_ref().expect("source instance");
        assert_eq!(workflow.source.resolved_revision, fixture.resolved_revision);
        assert!(!workflow.capabilities.exact_execution);
        verify_graph_source_store(fixture.root(), &first.graph).expect("stored identity");
        #[cfg(unix)]
        let verification_sequence = VERIFIED_SOURCE_OBJECTS
            .get()
            .expect("source verification cache")
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|((_, digest, revision), _)| {
                digest == &workflow.source.source_digest && revision == SOURCE_INDEXER_REVISION
            })
            .map(|(_, token)| token.cold_verification_sequence)
            .expect("cold verification token");
        #[cfg(not(unix))]
        let cold_verifications_before = SOURCE_COLD_VERIFICATIONS.load(Ordering::Relaxed);
        #[cfg(not(unix))]
        let exact_content_reads_before = SOURCE_EXACT_CONTENT_READS.load(Ordering::Relaxed);
        let warm_started = Instant::now();
        for _ in 0..32 {
            verify_graph_source_store(fixture.root(), &first.graph)
                .expect("warm source identity verification");
        }
        let warm_elapsed = warm_started.elapsed();
        #[cfg(unix)]
        let warm_sequence = VERIFIED_SOURCE_OBJECTS
            .get()
            .expect("source verification cache")
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|((_, digest, revision), _)| {
                digest == &workflow.source.source_digest && revision == SOURCE_INDEXER_REVISION
            })
            .map(|(_, token)| token.cold_verification_sequence)
            .expect("warm verification token");
        #[cfg(unix)]
        assert_eq!(warm_sequence, verification_sequence);
        #[cfg(not(unix))]
        assert!(
            SOURCE_COLD_VERIFICATIONS.load(Ordering::Relaxed)
                >= cold_verifications_before.saturating_add(32),
            "non-Unix verification must cold-read and reindex every round"
        );
        #[cfg(not(unix))]
        assert!(
            SOURCE_EXACT_CONTENT_READS.load(Ordering::Relaxed)
                >= exact_content_reads_before.saturating_add(64),
            "non-Unix verification must content-verify both sides of its weak metadata frame"
        );
        assert_eq!(source_verification_metadata_cache_enabled(), cfg!(unix));
        eprintln!(
            "warm source-store verification: 32 rounds in {} microseconds",
            warm_elapsed.as_micros()
        );
        let catalog =
            Catalog::load_dir(&fixture.root().join("operators")).expect("source operator catalog");
        let readiness = assess(&first.graph, &catalog).expect("source readiness");
        assert!(readiness
            .items
            .iter()
            .any(|item| item.field == "execution_environment"));

        let objects = source_workflow_store(fixture.root()).join("objects");
        let instances = source_workflow_store(fixture.root()).join("instances");
        assert_eq!(directory_entry_count(&objects), 1);
        assert_eq!(directory_entry_count(&instances), 1);
        assert!(std::fs::read_dir(&instances)
            .expect("instance records")
            .all(|entry| entry.expect("instance record").path().is_file()));

        let second = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            None,
        )
        .expect("cached source resolution without another Git fetch");
        assert!(second.cached);
        assert_eq!(second.graph, first.graph);
        assert_eq!(directory_entry_count(&objects), 1);

        let object = std::fs::read_dir(&objects)
            .expect("source objects")
            .next()
            .expect("source object")
            .expect("source object entry")
            .path();
        let extra = object.join("source/unmanifested.txt");
        std::fs::write(&extra, b"not in the source manifest\n")
            .expect("unmanifested source fixture");
        let error = verify_graph_source_store(fixture.root(), &first.graph)
            .expect_err("unmanifested stored source file must fail verification");
        assert!(error.to_string().contains("unmanifested file"), "{error}");
        std::fs::remove_file(extra).expect("remove unmanifested source fixture");

        #[cfg(unix)]
        {
            let source = object.join("source");
            let actual_source = fixture.root().join("stored-source-actual");
            std::fs::rename(&source, &actual_source).expect("move stored source tree");
            std::os::unix::fs::symlink(&actual_source, &source)
                .expect("symlink stored source tree");
            let error = verify_graph_source_store(fixture.root(), &first.graph)
                .expect_err("symlinked stored source root must fail verification");
            assert!(
                error
                    .to_string()
                    .contains("source must be a regular non-symlink directory"),
                "{error}"
            );
            std::fs::remove_file(&source).expect("remove stored source symlink");
            std::fs::rename(&actual_source, &source).expect("restore stored source tree");
        }

        let stored =
            read_stored_source_instance(fixture.root(), workflow).expect("original exact instance");
        let mut reindexed = workflow.clone();
        reindexed
            .scopes
            .first_mut()
            .expect("indexed source scope")
            .title
            .push_str(" (reindexed)");
        assert_eq!(
            calculate_source_workflow_revision(&reindexed).expect("semantic revision"),
            workflow.workflow_revision
        );
        assert_ne!(
            source_instance_digest(&reindexed).expect("reindexed instance digest"),
            source_instance_digest(workflow).expect("original instance digest")
        );
        persist_source_instance(
            fixture.root(),
            &StoredSourceInstance {
                workflow: reindexed.clone(),
                manifest: stored.manifest,
                files: stored.files,
            },
        )
        .expect("coexisting reindexed source instance");
        read_stored_source_instance(fixture.root(), workflow).expect("original remains exact");
        read_stored_source_instance(fixture.root(), &reindexed).expect("reindex remains exact");
        assert_eq!(directory_entry_count(&objects), 1);
        assert_eq!(directory_entry_count(&instances), 2);
        let mut reindexed_graph = first.graph.clone();
        reindexed_graph.nodes[0].source_workflow = Some(reindexed);
        let error = verify_graph_source_store(fixture.root(), &reindexed_graph)
            .expect_err("unproven derived presentation must fail closed");
        assert!(
            error
                .to_string()
                .contains("derived index does not match its exact stored source bytes"),
            "{error}"
        );
        verify_graph_source_store(fixture.root(), &first.graph)
            .expect("the original canonical presentation remains exact");

        std::fs::write(object.join("source/main.nf"), b"workflow { MUTATED() }\n")
            .expect("mutate stored source fixture");
        let error = verify_graph_source_store(fixture.root(), &first.graph)
            .expect_err("mutated stored source must fail readiness/save verification");
        assert!(
            error
                .to_string()
                .contains("does not match its manifest byte count"),
            "{error}"
        );
    }

    #[test]
    fn source_number_identity_survives_browser_json_and_autosave_cas() {
        let fixture = nfcore_source_fixture_with_schema(Some(
            r#"{
  "type": "object",
  "properties": {
    "threshold": {
      "type": "number",
      "minimum": -0.0,
      "enum": [1.0, -0.0],
      "default": 1.0
    }
  }
}
"#,
        ));
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source workflow with numeric schema");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("numeric source workflow");
        let threshold = workflow
            .parameters
            .iter()
            .find(|parameter| parameter.name == "threshold")
            .expect("threshold contract");
        assert_eq!(threshold.default, Some(somite_ir::ParamValue::Int(1)));
        assert_eq!(
            threshold.choices,
            vec![somite_ir::ParamValue::Int(1), somite_ir::ParamValue::Int(0)]
        );
        let minimum = threshold.minimum.expect("threshold minimum");
        assert_eq!(minimum, 0.0);
        assert!(!minimum.is_sign_negative());

        let workflow_revision = workflow.workflow_revision.clone();
        let instance_digest = source_instance_digest(workflow).expect("source instance digest");
        let state_revision =
            graph_state_revision(&imported.graph).expect("source graph state revision");
        let mut browser_json =
            serde_json::to_value(&imported.graph).expect("browser source graph JSON");
        browser_parse_stringify_numbers(&mut browser_json);
        let browser_graph: Graph =
            serde_json::from_value(browser_json).expect("browser-round-tripped source graph");
        let browser_workflow = browser_graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("browser source workflow");
        assert_eq!(browser_workflow.workflow_revision, workflow_revision);
        assert_eq!(
            source_instance_digest(browser_workflow).expect("browser instance digest"),
            instance_digest
        );
        assert_eq!(
            graph_state_revision(&browser_graph).expect("browser state revision"),
            state_revision
        );
        verify_graph_source_store(fixture.root(), &browser_graph)
            .expect("browser graph retains exact stored source identity");

        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let project =
            WebProject::open(fixture.root(), &graph_path).expect("numeric source project");
        let saved_revision = project
            .save_autosave_cas(&state_revision, &browser_graph)
            .expect("browser autosave CAS");
        assert_eq!(saved_revision, state_revision);
        verify_graph_source_store(fixture.root(), &browser_graph)
            .expect("saved browser graph retains its exact source instance");
    }

    #[test]
    fn oversized_source_instance_record_leaves_existing_records_unchanged() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("stored source instance fixture");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .clone()
            .expect("source workflow instance");
        let mut stored =
            read_stored_source_instance(fixture.root(), &workflow).expect("stored source instance");
        let mut oversized = workflow;
        oversized.diagnostics.push(somite_ir::SourceDiagnostic {
            code: "oversized_record_fixture".to_owned(),
            message: "x".repeat(4 * 1024),
            span: None,
        });

        let instances = source_workflow_store(fixture.root()).join("instances");
        let read_records = || {
            std::fs::read_dir(&instances)
                .expect("source instance directory")
                .map(|entry| {
                    let entry = entry.expect("source instance entry");
                    (
                        entry.file_name(),
                        std::fs::read(entry.path()).expect("source instance record"),
                    )
                })
                .collect::<BTreeMap<_, _>>()
        };
        let before = read_records();
        assert_eq!(before.len(), 1);
        let oversized_digest = source_instance_digest(&oversized).expect("oversized digest");
        let destination = instances.join(format!(
            "{}.json",
            source_instance_digest_hex(&oversized_digest).expect("oversized digest hex")
        ));
        assert!(!destination.exists());

        let error = persist_workflow_instance_record_with_limit(fixture.root(), &oversized, 1024)
            .expect_err("oversized source instance record must fail before persistence");
        assert!(
            matches!(
                error,
                ServerError::SourceRecordTooLarge {
                    limit_bytes: 1024,
                    ..
                }
            ),
            "{error}"
        );
        assert!(!destination.exists());
        assert_eq!(read_records(), before);

        let empty_target = TempDir::new().expect("empty oversized-import target");
        stored.workflow = oversized;
        let error = persist_source_instance_with_limit(empty_target.path(), &stored, 1024)
            .expect_err("oversized import must fail before source CAS publication");
        assert!(matches!(error, ServerError::SourceRecordTooLarge { .. }));
        assert!(
            !source_workflow_store(empty_target.path()).exists(),
            "oversized import must leave neither source object nor instance record"
        );
    }

    #[test]
    fn source_import_graph_size_preflight_precedes_cas_publication() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source import fixture");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("source workflow");
        let stored =
            read_stored_source_instance(fixture.root(), workflow).expect("stored source instance");
        let empty_target = TempDir::new().expect("empty graph-preflight target");
        let prepared = prepare_workflow_instance_record(
            empty_target.path(),
            &stored.workflow,
            MAX_SOURCE_RECORD_BYTES,
        )
        .expect("bounded source instance record");
        let preview = source_workflow_response_with_limit(
            &fixture.request,
            &fixture.source_operator_revision,
            stored.workflow.clone(),
            false,
            u64::MAX,
        )
        .expect("unbounded response preview");
        let graph_bytes = serde_json::to_vec_pretty(&preview.graph)
            .expect("source graph JSON")
            .len();
        assert!(graph_bytes > prepared.encoded.len());
        let graph_limit = u64::try_from(graph_bytes - 1).expect("near-boundary graph limit");
        assert!(prepared.encoded.len() as u64 <= graph_limit);

        let request_key = nfcore_source_request_key(&fixture.request);
        let error = publish_nfcore_source_import(
            empty_target.path(),
            &fixture.request,
            &fixture.source_operator_revision,
            &request_key,
            stored,
            graph_limit,
        )
        .expect_err("source graph beyond the save cap must fail before publication");
        assert!(
            matches!(
                error,
                ServerError::GraphTooLarge {
                    encoded_bytes,
                    limit_bytes,
                } if encoded_bytes == graph_bytes as u64 && limit_bytes == graph_limit
            ),
            "{error}"
        );
        assert!(
            !source_workflow_store(empty_target.path()).exists(),
            "unsavable source import must leave neither CAS object nor instance"
        );
    }

    #[test]
    #[ignore = "networked production-workload profile; run explicitly"]
    fn profile_live_nfcore_pangenome_source_store_warm_path() {
        const EXPECTED_RESOLVED_REVISION: &str = "3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337";
        const EXPECTED_SOURCE_DIGEST: &str =
            "blake3:4b8e157a3fbd3009095b60e4d857fba2af999ffe29c21bd01bd8304aaa427442";
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let catalog_source = repository_root.join(".somite/catalog/nfcore-pipelines.json");
        assert!(
            catalog_source.is_file(),
            "refresh the nf-core catalog before running the live profile"
        );
        let project = TempDir::new().expect("temporary live pangenome project");
        std::fs::create_dir(project.path().join("operators")).expect("operator directory");
        std::fs::copy(
            repository_root.join("operators/workflow.source.json"),
            project.path().join("operators/workflow.source.json"),
        )
        .expect("source operator");
        std::fs::create_dir_all(project.path().join(".somite/catalog")).expect("catalog directory");
        std::fs::copy(
            catalog_source,
            project.path().join(".somite/catalog/nfcore-pipelines.json"),
        )
        .expect("nf-core catalog");
        let catalog =
            Catalog::load_dir(&project.path().join("operators")).expect("source operator catalog");
        let request = WorkflowGraphRequest {
            workflow: "nf-core/pangenome".to_owned(),
            revision: "1.1.3".to_owned(),
        };

        let cold_started = Instant::now();
        let imported = import_nfcore_source(
            project.path(),
            &request,
            &catalog
                .revision("workflow.source")
                .expect("source revision"),
            None,
        )
        .expect("live pangenome source import");
        let cold_elapsed = cold_started.elapsed();
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("pangenome source workflow");
        assert_eq!(
            workflow.source.resolved_revision, EXPECTED_RESOLVED_REVISION,
            "catalog tag must still resolve to the profiled immutable commit"
        );
        assert_eq!(
            workflow.source.source_digest, EXPECTED_SOURCE_DIGEST,
            "profiled immutable source bytes must retain their aggregate digest"
        );
        assert!(
            workflow.capabilities.parameter_edits,
            "pinned pangenome source must permit supported parameter edits"
        );
        assert!(
            workflow
                .parameters
                .iter()
                .any(|parameter| parameter.name == "input"),
            "pinned pangenome source must expose its input parameter"
        );
        assert!(
            !workflow.bindings.contains_key("input"),
            "fresh pangenome import must leave input unbound"
        );
        let profile_input = "inputs/reference.fasta.gz";
        std::fs::create_dir(project.path().join("inputs")).expect("profile input directory");
        std::fs::write(
            project.path().join(profile_input),
            b"somite source-workflow profile input\n",
        )
        .expect("regular profile input file");

        let warm_started = Instant::now();
        for _ in 0..100 {
            verify_graph_source_store(project.path(), &imported.graph)
                .expect("warm exact source verification");
            assess(&imported.graph, &catalog).expect("warm pangenome readiness assessment");
        }
        let warm_elapsed = warm_started.elapsed();

        let stored = read_stored_source_instance_metadata(project.path(), workflow)
            .expect("pangenome source metadata");
        let mut current = workflow.clone();
        let edit_started = Instant::now();
        for round in 0..100 {
            let previous_revision = current.workflow_revision.clone();
            let edit = if round % 2 == 0 {
                SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: profile_input.to_owned(),
                    },
                }
            } else {
                SemanticEdit::ResetParameter {
                    name: "input".to_owned(),
                }
            };
            let edited = apply_checked_source_edit(
                &current,
                &EditTransaction {
                    base_workflow_revision: previous_revision.clone(),
                    edits: vec![edit],
                },
            )
            .expect("alternating pangenome input edit");
            assert_ne!(
                edited.workflow_revision, previous_revision,
                "each alternating edit must change semantic workflow state"
            );
            verify_source_project_bindings(project.path(), &edited)
                .expect("edited pangenome project binding");
            persist_source_instance_metadata(
                project.path(),
                &StoredSourceInstanceMetadata {
                    workflow: edited.clone(),
                    manifest: stored.manifest.clone(),
                    source_root: stored.source_root.clone(),
                    metadata_fingerprint: stored.metadata_fingerprint.clone(),
                },
            )
            .expect("metadata-only pangenome edit persistence");
            current = edited;
        }
        let edit_elapsed = edit_started.elapsed();
        assert_eq!(
            current.bindings, workflow.bindings,
            "100 alternating set/reset rounds must end at the imported binding state"
        );
        eprintln!(
            "pangenome source profile: resolved_revision={} source_digest={} files={} bytes={} cold_ms={} warm_100_ms={} alternating_set_reset_100_ms={}",
            workflow.source.resolved_revision,
            workflow.source.source_digest,
            workflow.source.file_count,
            workflow.source.source_bytes,
            cold_elapsed.as_millis(),
            warm_elapsed.as_millis(),
            edit_elapsed.as_millis()
        );
        assert_eq!(
            directory_entry_count(&source_workflow_store(project.path()).join("objects")),
            1
        );
    }

    #[tokio::test]
    async fn agent_nfcore_resolution_is_an_empty_canvas_transaction_and_replays() {
        let fixture = nfcore_source_fixture();
        import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("prime exact source cache");
        let graph_path = fixture.root().join("graph.somite.json");
        let empty = Graph {
            schema_version: somite_ir::SCHEMA_VERSION,
            name: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            annotations: Vec::new(),
            variant_origin: None,
        };
        std::fs::write(
            &graph_path,
            pretty_json_line(&empty).expect("empty graph JSON"),
        )
        .expect("empty graph");
        let project = Arc::new(
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project"),
        );
        let request = AgentNfcoreSourceImportRequest {
            workflow: fixture.request.workflow.clone(),
            revision: fixture.request.revision.clone(),
            base_state_revision: graph_state_revision(&empty).expect("empty state revision"),
            idempotency_key: "nfcore-source-import-1".to_owned(),
            summary: "Import nf-core demo source".to_owned(),
        };

        let first = agent_import_nfcore_source(State(project.clone()), Json(request.clone()))
            .await
            .expect("agent source import")
            .0;
        assert!(!first.replayed);
        assert_eq!(first.result.graph.nodes.len(), 1);
        assert!(first.result.graph.nodes[0].ports.is_empty());
        let saved: Graph = serde_json::from_slice(
            &std::fs::read(project.autosave_path()).expect("agent autosave"),
        )
        .expect("agent autosave JSON");
        assert_eq!(saved, first.result.graph);
        assert!(project
            .agent
            .snapshot_after(0)
            .events
            .iter()
            .any(|event| event.transaction.is_some()));

        let replay = agent_import_nfcore_source(State(project.clone()), Json(request))
            .await
            .expect("idempotent source import replay")
            .0;
        assert!(replay.replayed);
        assert_eq!(replay.result.transaction_id, first.result.transaction_id);

        let nonempty_request = AgentNfcoreSourceImportRequest {
            workflow: fixture.request.workflow,
            revision: fixture.request.revision,
            base_state_revision: first.result.state_revision,
            idempotency_key: "nfcore-source-import-2".to_owned(),
            summary: "Import another source".to_owned(),
        };
        let error = agent_import_nfcore_source(State(project), Json(nonempty_request))
            .await
            .expect_err("nonempty canvas must reject source import");
        assert!(error.to_string().contains("requires an empty canvas"));
    }

    #[tokio::test]
    async fn source_edits_validate_project_paths_and_reuse_one_source_object() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution");
        let base_workflow = imported.graph.nodes[0]
            .source_workflow
            .clone()
            .expect("source workflow");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let project = Arc::new(
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project"),
        );

        let missing = SourceWorkflowEditRequest {
            base_state_revision: graph_state_revision(&imported.graph)
                .expect("source graph state revision"),
            workflow_revision: base_workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input_file".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "missing.fastq".to_owned(),
                },
            }],
        };
        let error = edit_source_workflow(State(project.clone()), Json(missing))
            .await
            .expect_err("missing project file must fail");
        assert!(
            error.to_string().contains("missing.fastq is not available"),
            "{error}"
        );
        assert_eq!(
            directory_entry_count(&source_workflow_store(fixture.root()).join("instances")),
            1
        );

        std::fs::write(fixture.root().join("reads.fastq"), b"@r\nAC\n+\n!!\n")
            .expect("project input");
        let edit_request = AgentSourceWorkflowEditRequest {
            base_state_revision: graph_state_revision(&imported.graph)
                .expect("source graph state revision"),
            workflow_revision: base_workflow.workflow_revision.clone(),
            idempotency_key: "source-parameter-edit-1".to_owned(),
            summary: "Bind source workflow reads".to_owned(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input_file".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "reads.fastq".to_owned(),
                },
            }],
        };
        let edited = agent_edit_source_workflow(State(project.clone()), Json(edit_request.clone()))
            .await
            .expect("agent source edit")
            .0;
        assert!(!edited.replayed);
        let edited_workflow = edited.result.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("edited source workflow");
        assert_eq!(
            edited_workflow.bindings.get("input_file"),
            Some(&WorkflowBinding::ProjectFile {
                path: "reads.fastq".to_owned()
            })
        );
        let store = source_workflow_store(fixture.root());
        assert_eq!(directory_entry_count(&store.join("objects")), 1);
        assert_eq!(directory_entry_count(&store.join("instances")), 2);
        assert!(std::fs::read_dir(store.join("instances"))
            .expect("instance records")
            .all(|entry| entry.expect("instance record").path().is_file()));

        let replay = agent_edit_source_workflow(State(project.clone()), Json(edit_request))
            .await
            .expect("source edit replay")
            .0;
        assert!(replay.replayed);
        assert_eq!(replay.result.transaction_id, edited.result.transaction_id);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("reads.fastq", fixture.root().join("linked.fastq"))
                .expect("project symlink");
            let symlink_edit = SourceWorkflowEditRequest {
                base_state_revision: edited.result.state_revision.clone(),
                workflow_revision: edited_workflow.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "input_file".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: "linked.fastq".to_owned(),
                    },
                }],
            };
            let error = edit_source_workflow(State(project), Json(symlink_edit))
                .await
                .expect_err("project symlink must fail");
            assert!(error.to_string().contains("crosses a symlink"), "{error}");
            assert_eq!(directory_entry_count(&store.join("objects")), 1);
            assert_eq!(directory_entry_count(&store.join("instances")), 2);
        }
    }

    #[tokio::test]
    async fn source_invocation_replacement_persists_a_catalog_pinned_variant() {
        let fixture = nfcore_source_fixture_with_parameter_schema(false);
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("source workflow");
        let invocation = workflow
            .invocations
            .iter()
            .find(|invocation| invocation.name == "DEMO")
            .expect("DEMO invocation");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        std::fs::write(
            fixture.root().join("operators/align.bowtie2.json"),
            include_str!("../../../operators/align.bowtie2.json"),
        )
        .expect("Bowtie2 operator fixture");
        let project = Arc::new(
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project"),
        );
        let bowtie2_revision = project
            .catalog
            .revision("align.bowtie2")
            .expect("Bowtie2 catalog revision");

        let edited = edit_source_workflow(
            State(project.clone()),
            Json(SourceWorkflowEditRequest {
                base_state_revision: graph_state_revision(&imported.graph)
                    .expect("source graph state revision"),
                workflow_revision: workflow.workflow_revision.clone(),
                edits: vec![SemanticEdit::ReplaceInvocation {
                    invocation_id: invocation.id.clone(),
                    operator: "align.bowtie2".to_owned(),
                    operator_revision: bowtie2_revision.clone(),
                    params: BTreeMap::from([("threads".to_owned(), somite_ir::ParamValue::Int(8))]),
                }],
            }),
        )
        .await
        .expect("persist source replacement")
        .0;

        let variant = edited.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("variant workflow");
        assert_eq!(variant.invocations, workflow.invocations);
        assert_eq!(variant.replacements.len(), 1);
        assert_eq!(variant.replacements[0].invocation_id, invocation.id);
        assert_eq!(variant.replacements[0].operator, "align.bowtie2");
        assert_eq!(variant.replacements[0].operator_revision, bowtie2_revision);

        let promoted = promote_source_workflow(
            State(project.clone()),
            Json(SourceWorkflowPromotionRequest {
                base_state_revision: edited.state_revision.clone(),
                workflow_revision: variant.workflow_revision.clone(),
                invocation_id: invocation.id.clone(),
            }),
        )
        .await
        .expect("promote replacement into native graph")
        .0;
        assert_eq!(promoted.graph.nodes.len(), 1);
        assert_eq!(promoted.graph.nodes[0].operator, "align.bowtie2");
        assert!(promoted.graph.nodes[0].source_workflow.is_none());
        let origin = promoted
            .graph
            .variant_origin
            .as_ref()
            .expect("source provenance");
        assert_eq!(
            origin.promoted_invocations.get(&invocation.id),
            Some(&promoted.graph.nodes[0].id)
        );
        let saved: Graph = serde_json::from_slice(
            &std::fs::read(project.autosave_path()).expect("promoted autosave"),
        )
        .expect("promoted autosave JSON");
        assert_eq!(saved, promoted.graph);

        let restored = restore_source_workflow_view(
            State(project.clone()),
            Json(SourceWorkflowRestoreRequest {
                base_state_revision: promoted.state_revision,
            }),
        )
        .await
        .expect("restore retained source workflow")
        .0;
        assert_eq!(restored.graph.nodes.len(), 1);
        assert!(restored.graph.nodes[0].source_workflow.is_some());
        assert!(restored.graph.variant_origin.is_none());

        let agent_request = AgentSourceWorkflowPromotionRequest {
            base_state_revision: restored.state_revision,
            workflow_revision: restored.graph.nodes[0]
                .source_workflow
                .as_ref()
                .expect("restored source workflow")
                .workflow_revision
                .clone(),
            invocation_id: invocation.id.clone(),
            idempotency_key: "promote-demo-invocation".to_owned(),
            summary: "Promote DEMO to editable Bowtie2".to_owned(),
        };
        let agent_promoted =
            agent_promote_source_workflow(State(project.clone()), Json(agent_request.clone()))
                .await
                .expect("agent source promotion")
                .0;
        assert!(!agent_promoted.replayed);
        assert_eq!(
            agent_promoted.result.graph.nodes[0].operator,
            "align.bowtie2"
        );
        assert!(agent_promoted.result.graph.variant_origin.is_some());
        let replay = agent_promote_source_workflow(State(project), Json(agent_request))
            .await
            .expect("agent source promotion replay")
            .0;
        assert!(replay.replayed);
        assert_eq!(
            replay.result.transaction_id,
            agent_promoted.result.transaction_id
        );
    }

    #[test]
    fn stale_agent_source_edit_phase_two_does_not_publish_an_instance() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("source workflow");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let project = Arc::new(
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project"),
        );
        let instances = source_workflow_store(fixture.root()).join("instances");
        let before_instances = directory_entry_count(&instances);
        assert_eq!(before_instances, 1);

        let request = AgentSourceWorkflowEditRequest {
            base_state_revision: graph_state_revision(&imported.graph)
                .expect("source graph state revision"),
            workflow_revision: workflow.workflow_revision.clone(),
            idempotency_key: "stale-source-edit-phase-two".to_owned(),
            summary: "Edit a stale source workflow".to_owned(),
            edits: vec![SemanticEdit::SetParameter {
                name: "label".to_owned(),
                binding: WorkflowBinding::Literal {
                    value: somite_ir::ParamValue::String("stale".to_owned()),
                },
            }],
        };
        let error =
            agent_edit_source_workflow_with_phase_two_hook(project.clone(), request, |project| {
                let mut concurrent = current_agent_graph(project).expect("current source graph");
                let base = graph_state_revision(&concurrent).expect("concurrent base revision");
                concurrent.name = Some("Concurrent graph update".to_owned());
                project
                    .save_autosave_cas(&base, &concurrent)
                    .expect("concurrent autosave update");
            })
            .expect_err("phase-two state mismatch must reject the source edit");
        assert!(
            matches!(
                error,
                ServerError::Agent(agent::AgentError::StaleTransaction { .. })
            ),
            "{error}"
        );
        assert_eq!(
            directory_entry_count(&instances),
            before_instances,
            "a phase-two conflict must not orphan an immutable source instance"
        );
    }

    #[tokio::test]
    async fn source_edits_reject_instances_without_parameter_edit_capability() {
        let fixture = nfcore_source_fixture_with_parameter_schema(false);
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution without parameter schema");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .clone()
            .expect("source workflow");
        assert!(!workflow.capabilities.parameter_edits);
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let project = Arc::new(
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project"),
        );
        let edit = SemanticEdit::SetParameter {
            name: "label".to_owned(),
            binding: WorkflowBinding::Literal {
                value: somite_ir::ParamValue::String("blocked".to_owned()),
            },
        };

        let error = edit_source_workflow(
            State(project.clone()),
            Json(SourceWorkflowEditRequest {
                base_state_revision: graph_state_revision(&imported.graph)
                    .expect("source graph state revision"),
                workflow_revision: workflow.workflow_revision.clone(),
                edits: vec![edit.clone()],
            }),
        )
        .await
        .expect_err("browser source edit must honor capabilities");
        assert!(
            error
                .to_string()
                .contains("does not permit parameter edits"),
            "{error}"
        );

        let error = agent_edit_source_workflow(
            State(project),
            Json(AgentSourceWorkflowEditRequest {
                base_state_revision: graph_state_revision(&imported.graph)
                    .expect("source graph state revision"),
                workflow_revision: workflow.workflow_revision,
                idempotency_key: "disabled-source-parameter-edit".to_owned(),
                summary: "Try a disabled parameter edit".to_owned(),
                edits: vec![edit],
            }),
        )
        .await
        .expect_err("agent source edit must honor capabilities");
        assert!(
            error
                .to_string()
                .contains("does not permit parameter edits"),
            "{error}"
        );
        assert_eq!(
            directory_entry_count(&source_workflow_store(fixture.root()).join("instances")),
            1
        );
    }

    #[test]
    fn browser_save_rejects_exact_execution_capability_tampering() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let project =
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project");
        let base_state_revision =
            graph_state_revision(&imported.graph).expect("source graph state revision");
        let base_graph_revision =
            semantic_graph_revision(&imported.graph).expect("source semantic graph revision");
        let mut tampered = imported.graph.clone();
        tampered.nodes[0]
            .source_workflow
            .as_mut()
            .expect("source workflow")
            .capabilities
            .exact_execution = true;
        assert_eq!(
            semantic_graph_revision(&tampered).expect("tampered semantic graph revision"),
            base_graph_revision,
            "capabilities are presentation metadata in the current semantic revision"
        );

        let error = project
            .save_autosave_cas(&base_state_revision, &tampered)
            .expect_err("browser capability tampering must not persist");
        assert!(
            error.to_string().contains("source workflow instance")
                && error.to_string().contains("is not stored"),
            "{error}"
        );
        let saved: Graph =
            serde_json::from_slice(&std::fs::read(&graph_path).expect("unchanged source graph"))
                .expect("unchanged source graph JSON");
        assert!(
            !saved.nodes[0]
                .source_workflow
                .as_ref()
                .expect("saved source workflow")
                .capabilities
                .exact_execution
        );
    }

    #[test]
    fn nfcore_source_search_returns_exact_release_without_operator_descriptors() {
        let pipelines = nfcore::parse(
            r#"{"remote_workflows":[{"name":"rnaseq","description":"RNA sequencing","topics":["transcriptomics"],"archived":false,"releases":[{"tag_name":"3.21.0"}]},{"name":"ampliseq","description":"Amplicon sequencing","topics":[],"archived":false,"releases":[{"tag_name":"2.14.0"}]}]}"#,
        )
        .expect("nf-core fixture");

        let response = filter_nfcore_source_catalog("RNA sequencing", 12, pipelines, true);

        assert!(response.cached);
        assert_eq!(response.provenance, nfcore::CATALOG_URL);
        assert_eq!(response.total_matches, 1);
        assert_eq!(response.entries[0].repository, "nf-core/rnaseq");
        assert_eq!(response.entries[0].revision, "3.21.0");
    }

    #[test]
    fn nfcore_preview_scopes_legacy_config_parser_to_nextflow_child() {
        let temporary = TempDir::new().expect("temporary preview");
        let nextflow = temporary.path().join("nextflow");
        let inherited_parser = std::env::var_os("NXF_SYNTAX_PARSER");
        write_test_executable(
            &nextflow,
            br#"#!/bin/sh
printf '%s\n' "${NXF_SYNTAX_PARSER:-default}" >> parser-attempts
if [ "${NXF_SYNTAX_PARSER:-}" != "v1" ]; then
  printf '%s\n' 'ERROR nextflow.cli.Launcher - Config parsing failed' > .nextflow.log
  exit 1
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-with-dag" ]; then
    shift
    dot_path=$1
  fi
  shift
done
printf '%s\n' 'digraph workflow { input -> output }' > "$dot_path"
"#,
        );
        let dot_path = temporary.path().join("workflow.dot");
        let request = WorkflowGraphRequest {
            workflow: "nf-core/pangenome".to_owned(),
            revision: "1.1.3".to_owned(),
        };

        let output = run_nfcore_preview(&nextflow, temporary.path(), &request, &dot_path)
            .expect("preview child");

        assert!(
            output.status.success(),
            "legacy parser was not scoped to the preview child: {}",
            nfcore_preview_failure_detail(temporary.path(), &output)
        );
        assert!(dot_path.is_file(), "preview child did not produce a DAG");
        assert_eq!(
            std::fs::read_to_string(temporary.path().join("parser-attempts"))
                .expect("parser attempts"),
            "default\nv1\n"
        );
        assert_eq!(std::env::var_os("NXF_SYNTAX_PARSER"), inherited_parser);
    }

    #[test]
    fn nfcore_preview_surfaces_config_parser_diagnostic_from_log() {
        let temporary = TempDir::new().expect("temporary preview");
        let nextflow = temporary.path().join("nextflow");
        write_test_executable(
            &nextflow,
            br#"#!/bin/sh
cat > .nextflow.log <<'LOG'
Aug-28 17:45:47.405 [main] ERROR nextflow.cli.Launcher - Config parsing failed
nextflow.exception.ConfigParseException: Config parsing failed
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
_nf_config: 396: `manifest` is not defined @ line 396, column 33.
LOG
exit 1
"#,
        );
        let dot_path = temporary.path().join("workflow.dot");
        let request = WorkflowGraphRequest {
            workflow: "nf-core/pangenome".to_owned(),
            revision: "1.1.3".to_owned(),
        };

        let output = run_nfcore_preview(&nextflow, temporary.path(), &request, &dot_path)
            .expect("preview child");
        let detail = nfcore_preview_failure_detail(temporary.path(), &output);

        assert!(detail.contains("Config parsing failed"), "{detail}");
        assert!(
            detail.contains("`manifest` is not defined @ line 396"),
            "{detail}"
        );
        assert!(!detail.contains("did not produce a DAG"), "{detail}");
    }

    #[test]
    fn nfcore_preview_does_not_retry_non_parser_failures() {
        let temporary = TempDir::new().expect("temporary preview");
        let nextflow = temporary.path().join("nextflow");
        write_test_executable(
            &nextflow,
            br#"#!/bin/sh
printf '%s\n' "${NXF_SYNTAX_PARSER:-default}" >> parser-attempts
printf '%s\n' 'ERROR nextflow.scm.AssetManager - Unable to clone repository: network is unreachable' > .nextflow.log
exit 1
"#,
        );
        let dot_path = temporary.path().join("workflow.dot");
        let request = WorkflowGraphRequest {
            workflow: "nf-core/pangenome".to_owned(),
            revision: "1.1.3".to_owned(),
        };

        let output = run_nfcore_preview(&nextflow, temporary.path(), &request, &dot_path)
            .expect("preview child");

        assert!(!output.status.success());
        assert_eq!(
            std::fs::read_to_string(temporary.path().join("parser-attempts"))
                .expect("parser attempts"),
            "default\n"
        );
        assert_eq!(
            nfcore_preview_failure_detail(temporary.path(), &output),
            "Unable to clone repository: network is unreachable"
        );
    }

    #[test]
    fn nfcore_preview_does_not_classify_a_stale_log() {
        let temporary = TempDir::new().expect("temporary preview");
        std::fs::write(
            temporary.path().join(".nextflow.log"),
            "ERROR nextflow.cli.Launcher - Config parsing failed\n",
        )
        .expect("stale Nextflow log");
        let nextflow = temporary.path().join("nextflow");
        write_test_executable(
            &nextflow,
            br#"#!/bin/sh
printf '%s\n' "${NXF_SYNTAX_PARSER:-default}" >> parser-attempts
exit 1
"#,
        );
        let dot_path = temporary.path().join("workflow.dot");
        let request = WorkflowGraphRequest {
            workflow: "nf-core/pangenome".to_owned(),
            revision: "1.1.3".to_owned(),
        };

        let output = run_nfcore_preview(&nextflow, temporary.path(), &request, &dot_path)
            .expect("preview child");

        assert!(!output.status.success());
        assert_eq!(
            std::fs::read_to_string(temporary.path().join("parser-attempts"))
                .expect("parser attempts"),
            "default\n"
        );
        assert!(!temporary.path().join(".nextflow.log").exists());
    }

    #[test]
    fn nextflow_trace_updates_graph_node_states() {
        let temporary = TempDir::new().expect("temporary run");
        std::fs::create_dir(temporary.path().join(".somite")).expect("trace directory");
        std::fs::write(
            temporary.path().join("node-map.json"),
            r#"{"schema_version":1,"nodes":{"input1":{"kind":"input","operator":"files.import","operator_revision":"rev","process":null},"qc1":{"kind":"process","operator":"qc.fastqc","operator_revision":"rev","process":"SOMITE_QC1"}},"edges":[]}"#,
        )
        .expect("node map");
        std::fs::write(
            temporary.path().join(".somite/trace.tsv"),
            "name\tstatus\texit\thash\nSOMITE_QC1 (sample)\tCOMPLETED\t0\taa/bb\n",
        )
        .expect("trace");
        let (cancel, _receiver) = watch::channel(false);
        let job = RunJob {
            package: temporary.path().to_path_buf(),
            status: Mutex::new(RunStatusResponse {
                run_id: "run-test".to_owned(),
                phase: RunPhase::Running,
                states: BTreeMap::from([
                    ("input1".to_owned(), RunNodeState::Queued),
                    ("qc1".to_owned(), RunNodeState::Queued),
                ]),
                closure_digest: None,
                exit_code: None,
                error: None,
                evidence_receipt: None,
                progress: RunProgress {
                    completed: 0,
                    total: 2,
                    unit: "nodes",
                    message: "Preparing workflow".to_owned(),
                },
            }),
            pending_terminal: Mutex::new(None),
            cancel,
            validation: None,
        };

        refresh_run_status(&job);

        let status = run_snapshot(&job);
        assert_eq!(status.states["input1"], RunNodeState::Done);
        assert_eq!(status.states["qc1"], RunNodeState::Done);
    }

    #[test]
    fn preparation_failure_marks_unexecuted_nodes_inconclusive() {
        let temporary = TempDir::new().expect("temporary failed run");
        let (cancel, _receiver) = watch::channel(false);
        let job = RunJob {
            package: temporary.path().to_path_buf(),
            status: Mutex::new(RunStatusResponse {
                run_id: "validation-compile-failure".to_owned(),
                phase: RunPhase::Preparing,
                states: BTreeMap::from([
                    ("queued".to_owned(), RunNodeState::Queued),
                    ("running".to_owned(), RunNodeState::Running),
                    ("done".to_owned(), RunNodeState::Done),
                ]),
                closure_digest: None,
                exit_code: None,
                error: None,
                evidence_receipt: None,
                progress: RunProgress {
                    completed: 0,
                    total: 3,
                    unit: "nodes",
                    message: "Preparing workflow".to_owned(),
                },
            }),
            pending_terminal: Mutex::new(None),
            cancel,
            validation: None,
        };

        fail_run(&job, "compile failed".to_owned());

        let status = run_snapshot(&job);
        assert_eq!(status.phase, RunPhase::Failed);
        assert_eq!(status.states["queued"], RunNodeState::Skipped);
        assert_eq!(status.states["running"], RunNodeState::Failed);
        assert_eq!(status.states["done"], RunNodeState::Done);
        assert_eq!(
            evidence_node_result(status.states["queued"]),
            EvidenceResult::Inconclusive
        );
        assert_eq!(
            evidence_node_result(status.states["running"]),
            EvidenceResult::Failed
        );
        assert_eq!(
            evidence_node_result(status.states["done"]),
            EvidenceResult::Passed
        );
    }

    #[tokio::test]
    async fn session_returns_the_real_graph() {
        let (_temp, project) = fixture_project();
        let response = app(project)
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let session: serde_json::Value = serde_json::from_slice(&body).expect("session json");
        assert_eq!(
            session["graph"]["schema_version"],
            somite_ir::SCHEMA_VERSION
        );
        assert_eq!(session["graph_path"], "graph.somite.json");
        assert_eq!(session["recovered_autosave"], false);
    }

    #[tokio::test]
    async fn readiness_route_reports_an_empty_workflow_without_ai() {
        let (_temp, project) = fixture_project();
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/readiness")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"schema_version":1,"nodes":[],"edges":[]}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let readiness: serde_json::Value = serde_json::from_slice(&body).expect("readiness json");
        assert_eq!(readiness["state"], "empty");
        assert_eq!(readiness["required_count"], 0);
        assert!(readiness["graph_revision"]
            .as_str()
            .is_some_and(|revision| revision.starts_with("blake3:")));
    }

    #[tokio::test]
    async fn run_admission_rejects_an_empty_workflow_before_preparation() {
        let (_temp, project) = fixture_project();
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/runs")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"schema_version":1,"nodes":[],"edges":[]}"#))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let error: serde_json::Value = serde_json::from_slice(&body).expect("error json");
        assert!(error["error"]
            .as_str()
            .is_some_and(|message| message.contains("add at least one operator")));
    }

    #[tokio::test]
    async fn agent_transaction_route_is_atomic_visible_and_stale_safe() {
        let (temp, project) = agent_fixture_project();
        let authorization = format!("Bearer {}", project.mcp_runtime_capability());
        let router = app(project);
        let unauthorized_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent/graph")
                    .header("x-somite-mcp-tool", "somite.workflow.get")
                    .body(Body::empty())
                    .expect("unauthorized MCP request"),
            )
            .await
            .expect("unauthorized MCP response");
        assert_eq!(unauthorized_response.status(), StatusCode::UNAUTHORIZED);
        let headerless_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent/catalog?q=fastq")
                    .body(Body::empty())
                    .expect("headerless MCP route request"),
            )
            .await
            .expect("headerless MCP route response");
        assert_eq!(headerless_response.status(), StatusCode::UNAUTHORIZED);
        let graph_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent/graph")
                    .header("x-somite-mcp-tool", "somite.workflow.get")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::empty())
                    .expect("graph request"),
            )
            .await
            .expect("graph response");
        assert_eq!(graph_response.status(), StatusCode::OK);
        let graph_body = graph_response
            .into_body()
            .collect()
            .await
            .expect("graph body")
            .to_bytes();
        let graph: serde_json::Value = serde_json::from_slice(&graph_body).expect("graph json");
        let base_revision = graph["state_revision"].as_str().expect("state revision");
        let graph_revision = graph["graph_revision"]
            .as_str()
            .expect("semantic graph revision");
        assert!(base_revision.starts_with("blake3:"));
        assert!(graph_revision.starts_with("blake3:"));

        let compile_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/compile")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::from("{}"))
                    .expect("compile request"),
            )
            .await
            .expect("compile response");
        assert_eq!(compile_response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let transaction = serde_json::json!({
            "base_state_revision": base_revision,
            "idempotency_key": "route-atomic-edit-1",
            "summary": "Add a FASTQ source",
            "operations": [{
                "op": "add_operator",
                "node_id": "reads",
                "operator_id": "files.import",
                "params": {"path": "reads.fastq"},
                "x": 40,
                "y": 60
            }]
        });
        let edit_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/transactions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::from(transaction.to_string()))
                    .expect("transaction request"),
            )
            .await
            .expect("transaction response");
        assert_eq!(edit_response.status(), StatusCode::OK);
        let edit_body = edit_response
            .into_body()
            .collect()
            .await
            .expect("transaction body")
            .to_bytes();
        let edit: serde_json::Value = serde_json::from_slice(&edit_body).expect("transaction json");
        assert_eq!(edit["graph"]["nodes"][0]["id"], "reads");
        assert_eq!(edit["replayed"], false);
        assert_ne!(edit["state_revision"], base_revision);

        let compile_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/compile")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::from("{}"))
                    .expect("compile request"),
            )
            .await
            .expect("compile response");
        assert_eq!(compile_response.status(), StatusCode::OK);
        let compile_body = compile_response
            .into_body()
            .collect()
            .await
            .expect("compile body")
            .to_bytes();
        let compiled: serde_json::Value =
            serde_json::from_slice(&compile_body).expect("compile json");
        let closure_digest = compiled["closure_digest"].as_str().expect("closure digest");
        assert_eq!(compiled["source_graph_revision"], edit["graph_revision"]);
        assert!(compiled["compiled_graph_revision"]
            .as_str()
            .is_some_and(|revision| revision.starts_with("blake3:")));
        assert_ne!(compiled["compiled_graph_revision"], edit["graph_revision"]);
        assert_eq!(compiled["reused"], false);
        assert_eq!(
            compiled["output_path"],
            format!(
                ".somite/compiled/{}",
                closure_digest
                    .strip_prefix("blake3:")
                    .unwrap_or(closure_digest)
            )
        );
        assert!(temp
            .path()
            .join(compiled["output_path"].as_str().expect("compile path"))
            .join("run-closure.json")
            .is_file());

        let replay_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/transactions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::from(transaction.to_string()))
                    .expect("replay transaction request"),
            )
            .await
            .expect("replay transaction response");
        assert_eq!(replay_response.status(), StatusCode::OK);
        let replay: serde_json::Value = serde_json::from_slice(
            &replay_response
                .into_body()
                .collect()
                .await
                .expect("replay transaction body")
                .to_bytes(),
        )
        .expect("replay transaction json");
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["transaction_id"], edit["transaction_id"]);

        let events_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent/events?after=0")
                    .body(Body::empty())
                    .expect("events request"),
            )
            .await
            .expect("events response");
        let events_body = events_response
            .into_body()
            .collect()
            .await
            .expect("events body")
            .to_bytes();
        let events: serde_json::Value = serde_json::from_slice(&events_body).expect("events json");
        assert_eq!(
            events["authoritative_state_revision"], edit["state_revision"],
            "event polling must identify the graph state captured after its event batch"
        );
        let event_list = events["events"].as_array().expect("agent event list");
        assert!(event_list.iter().any(|event| {
            event["kind"] == "tool"
                && event["title"] == "somite.workflow.get"
                && event["status"] == "completed"
        }));
        assert_eq!(
            event_list
                .iter()
                .filter(|event| event["kind"] == "transaction")
                .count(),
            1
        );

        let mut conflict_transaction = transaction.clone();
        conflict_transaction["summary"] = serde_json::json!("Different edit");
        let conflict_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/transactions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::from(conflict_transaction.to_string()))
                    .expect("conflicting transaction request"),
            )
            .await
            .expect("conflicting transaction response");
        assert_eq!(conflict_response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let mut stale_transaction = transaction.clone();
        stale_transaction["idempotency_key"] = serde_json::json!("route-atomic-edit-2");
        let stale_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/transactions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::from(stale_transaction.to_string()))
                    .expect("stale transaction request"),
            )
            .await
            .expect("stale transaction response");
        assert_eq!(stale_response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let persisted: serde_json::Value = serde_json::from_slice(
            &std::fs::read(temp.path().join("graph.somite.autosave.somite.json"))
                .expect("agent autosave"),
        )
        .expect("agent autosave json");
        assert_eq!(persisted["nodes"].as_array().map(Vec::len), Some(1));

        let catalog_response = router
            .oneshot(
                Request::builder()
                    .uri("/api/agent/catalog?q=import")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::empty())
                    .expect("catalog request"),
            )
            .await
            .expect("catalog response");
        let catalog_body = catalog_response
            .into_body()
            .collect()
            .await
            .expect("catalog body")
            .to_bytes();
        let catalog: serde_json::Value =
            serde_json::from_slice(&catalog_body).expect("catalog json");
        assert_eq!(catalog["matches"][0]["id"], "files.import");
        assert!(catalog["matches"][0]["revision"]
            .as_str()
            .is_some_and(|revision| revision.starts_with("blake3:")));

        let (_search_temp, search_project) = agent_fixture_project();
        let search_authorization = format!("Bearer {}", search_project.mcp_runtime_capability());
        let search_router = app(search_project);
        let natural_search_response = search_router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent/catalog?q=FASTQ%20source%20local%20paired%20read")
                    .header(header::AUTHORIZATION, &search_authorization)
                    .body(Body::empty())
                    .expect("natural catalog request"),
            )
            .await
            .expect("natural catalog response");
        let natural_search_body = natural_search_response
            .into_body()
            .collect()
            .await
            .expect("natural catalog body")
            .to_bytes();
        let natural_search: serde_json::Value =
            serde_json::from_slice(&natural_search_body).expect("natural catalog json");
        assert_eq!(natural_search["matches"][0]["id"], "files.import_paired");
        assert_eq!(natural_search["total_matches"], 1);
        assert!(natural_search["catalog_revision"]
            .as_str()
            .is_some_and(|revision| revision.starts_with("blake3:")));
        assert!(natural_search["matches"][0]["matched_terms"]
            .as_array()
            .is_some_and(|terms| terms.len() >= 4));

        let first_page_response = search_router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent/catalog?q=fastq&limit=1")
                    .header(header::AUTHORIZATION, &search_authorization)
                    .body(Body::empty())
                    .expect("first catalog page request"),
            )
            .await
            .expect("first catalog page response");
        let first_page: serde_json::Value = serde_json::from_slice(
            &first_page_response
                .into_body()
                .collect()
                .await
                .expect("first catalog page body")
                .to_bytes(),
        )
        .expect("first catalog page json");
        assert_eq!(first_page["total_matches"], 2);
        assert_eq!(first_page["matches"].as_array().map(Vec::len), Some(1));
        let cursor = first_page["next_cursor"]
            .as_str()
            .expect("catalog continuation cursor");
        let second_page_response = search_router
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/agent/catalog?q=fastq&limit=1&cursor={cursor}"
                    ))
                    .header(header::AUTHORIZATION, &search_authorization)
                    .body(Body::empty())
                    .expect("second catalog page request"),
            )
            .await
            .expect("second catalog page response");
        let second_page: serde_json::Value = serde_json::from_slice(
            &second_page_response
                .into_body()
                .collect()
                .await
                .expect("second catalog page body")
                .to_bytes(),
        )
        .expect("second catalog page json");
        assert_ne!(
            first_page["matches"][0]["id"],
            second_page["matches"][0]["id"]
        );
        assert!(second_page["next_cursor"].is_null());
    }

    #[test]
    fn session_migrates_legacy_nodes_and_exposes_the_same_operator_revision() {
        let temp = TempDir::new().expect("temporary project");
        let operators = temp.path().join("operators");
        std::fs::create_dir(&operators).expect("operator directory");
        std::fs::write(
            operators.join("test.echo.json"),
            r#"{"id":"test.echo","title":"Echo","palette":[],"kind":"external","bin":"echo","ports":{}}"#,
        )
        .expect("operator");
        let graph_path = temp.path().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            r#"{"schema_version":1,"nodes":[{"id":"echo1","operator":"test.echo","ports":[],"layout":{"x":0.0,"y":0.0}}],"edges":[]}"#,
        )
        .expect("legacy graph");

        let session = WebProject::open(temp.path(), &graph_path)
            .expect("project")
            .session()
            .expect("session");

        assert_eq!(session.graph.schema_version, somite_ir::SCHEMA_VERSION);
        assert_eq!(
            session.graph.nodes[0].operator_revision,
            session.operators[0].revision
        );
        assert!(session.graph.nodes[0]
            .operator_revision
            .starts_with("blake3:"));
    }

    #[tokio::test]
    async fn session_recovers_a_valid_graph_scoped_autosave() {
        let (temp, project) = fixture_project();
        std::fs::write(
            temp.path().join("graph.somite.autosave.somite.json"),
            r#"{"schema_version":1,"nodes":[],"edges":[]}"#,
        )
        .expect("recovery graph");
        let response = app(project)
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let session: serde_json::Value = serde_json::from_slice(&body).expect("session json");
        assert_eq!(session["recovered_autosave"], true);
    }

    #[tokio::test]
    async fn custom_graph_does_not_recover_an_unrelated_legacy_autosave() {
        let (temp, project) = fixture_project();
        std::fs::create_dir(temp.path().join(".somite")).expect("legacy recovery directory");
        std::fs::write(
            temp.path().join(".somite/autosave.somite.json"),
            r#"{"schema_version":1,"nodes":[],"edges":[]}"#,
        )
        .expect("legacy recovery graph");
        let response = app(project)
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let session: serde_json::Value = serde_json::from_slice(&body).expect("session json");
        assert_eq!(session["recovered_autosave"], false);
    }

    #[tokio::test]
    async fn run_endpoint_freezes_and_supervises_the_nextflow_package() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/runs")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(READY_RUN_GRAPH))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let started: serde_json::Value = serde_json::from_slice(&body).expect("run start");
        let run_id = started["run_id"].as_str().expect("run id");
        assert_eq!(started["phase"], "preparing");
        let status = wait_for_phase(&router, run_id, "completed").await;
        assert!(status["closure_digest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("blake3:")));
        assert_eq!(status["exit_code"], 0);
        let package = temp.path().join(".somite/runs").join(run_id);
        assert!(package.join("main.nf").is_file());
        assert!(package.join("pixi.lock").is_file());
        assert!(package.join("run-closure.json").is_file());
    }

    #[tokio::test]
    async fn run_start_idempotency_replays_lost_responses_without_duplicate_work() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let graph = READY_RUN_GRAPH;
        let start = || {
            Request::builder()
                .method(Method::POST)
                .uri("/api/runs?idempotency_key=run-retry-test")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(graph))
                .expect("run request")
        };

        let first = router
            .clone()
            .oneshot(start())
            .await
            .expect("first start response");
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let first: serde_json::Value = serde_json::from_slice(
            &first
                .into_body()
                .collect()
                .await
                .expect("first body")
                .to_bytes(),
        )
        .expect("first start json");
        assert_eq!(first["replayed"], false);

        let replay = router
            .clone()
            .oneshot(start())
            .await
            .expect("replay response");
        assert_eq!(replay.status(), StatusCode::ACCEPTED);
        let replay: serde_json::Value = serde_json::from_slice(
            &replay
                .into_body()
                .collect()
                .await
                .expect("replay body")
                .to_bytes(),
        )
        .expect("replay json");
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["run_id"], first["run_id"]);

        let conflict = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/validations?idempotency_key=run-retry-test")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(graph))
                    .expect("conflicting validation request"),
            )
            .await
            .expect("conflict response");
        assert_eq!(conflict.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let run_id = first["run_id"].as_str().expect("run id");
        wait_for_phase(&router, run_id, "completed").await;
        assert_eq!(
            std::fs::read_dir(temp.path().join(".somite/runs"))
                .expect("run directory")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn run_status_long_poll_returns_when_the_run_becomes_terminal() {
        let (_temp, project) = fixture_project_with_run("sleep 0.2\nexit 0");
        let router = app(project);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/runs")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(READY_RUN_GRAPH))
                    .expect("start request"),
            )
            .await
            .expect("start response");
        let started: serde_json::Value = serde_json::from_slice(
            &response
                .into_body()
                .collect()
                .await
                .expect("start body")
                .to_bytes(),
        )
        .expect("start json");
        let run_id = started["run_id"].as_str().expect("run id");

        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/runs/{run_id}?wait_ms=2000"))
                    .body(Body::empty())
                    .expect("long poll request"),
            )
            .await
            .expect("long poll response");
        let status: serde_json::Value = serde_json::from_slice(
            &response
                .into_body()
                .collect()
                .await
                .expect("long poll body")
                .to_bytes(),
        )
        .expect("long poll json");
        assert_eq!(status["phase"], "completed");
        assert_eq!(status["progress"]["message"], "Workflow completed");
    }

    #[tokio::test]
    async fn run_failure_is_reported_by_the_same_supervisor() {
        let (_temp, project) = fixture_project_with_run("printf 'fixture failure\\n' >&2\nexit 7");
        let router = app(project);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/runs")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(READY_RUN_GRAPH))
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let started: serde_json::Value = serde_json::from_slice(&body).expect("run start");
        let status = wait_for_phase(
            &router,
            started["run_id"].as_str().expect("run id"),
            "failed",
        )
        .await;
        assert_eq!(status["exit_code"], 7);
        assert!(status["error"]
            .as_str()
            .is_some_and(|error| error.contains("fixture failure")));
    }

    #[tokio::test]
    async fn active_run_can_be_cancelled() {
        let (_temp, project) = fixture_project_with_run("exec sleep 30");
        let router = app(project);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/runs")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(READY_RUN_GRAPH))
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let started: serde_json::Value = serde_json::from_slice(&body).expect("run start");
        let run_id = started["run_id"].as_str().expect("run id");
        wait_for_phase(&router, run_id, "running").await;
        let cancel = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/runs/{run_id}/cancel"))
                    .body(Body::empty())
                    .expect("cancel request"),
            )
            .await
            .expect("cancel response");
        assert_eq!(cancel.status(), StatusCode::OK);
        wait_for_phase(&router, run_id, "cancelled").await;
    }

    #[tokio::test]
    async fn validation_uses_cas_fixtures_and_persists_scoped_evidence() {
        let (temp, project, graph) = validation_fixture_project();
        let router = app(project);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/validations")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(graph.clone()))
                    .expect("validation request"),
            )
            .await
            .expect("validation response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("start body")
            .to_bytes();
        let started: serde_json::Value = serde_json::from_slice(&body).expect("start json");
        let run_id = started["run_id"].as_str().expect("run id");
        let status = wait_for_phase(&router, run_id, "completed").await;
        let receipt = &status["evidence_receipt"];
        assert_eq!(receipt["result"], "passed");
        assert_eq!(receipt["node_results"]["input1"], "passed");
        assert_eq!(receipt["node_results"]["consume1"], "passed");
        assert_eq!(receipt["edge_results"]["edge1"], "passed");
        assert!(receipt["observed_closure_digest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("blake3:")));
        assert_eq!(receipt["fixture_digests"].as_array().map(Vec::len), Some(1));

        let evidence_index = temp.path().join(".somite/evidence/index.json");
        assert!(evidence_index.is_file());
        assert_eq!(
            std::fs::read_dir(temp.path().join(".somite/fixtures/objects"))
                .expect("fixture objects")
                .count(),
            1
        );
        let params = std::fs::read_to_string(
            temp.path()
                .join(".somite/runs")
                .join(run_id)
                .join("params.json"),
        )
        .expect("compiled fixture params");
        assert!(params.contains(".somite/fixtures/objects/"));
        assert!(!params.contains("private/sample.fastq"));

        let evidence = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/validations/status")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(graph.clone()))
                    .expect("evidence request"),
            )
            .await
            .expect("evidence response")
            .into_body()
            .collect()
            .await
            .expect("evidence body")
            .to_bytes();
        let evidence: serde_json::Value = serde_json::from_slice(&evidence).expect("evidence json");
        assert_eq!(
            evidence["receipt"]["receipt_digest"],
            receipt["receipt_digest"]
        );

        let mut changed: serde_json::Value = serde_json::from_str(&graph).expect("graph json");
        changed["nodes"][0]["params"]["path"] = "other/sample.fastq".into();
        let changed = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/validations/status")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(changed.to_string()))
                    .expect("changed evidence request"),
            )
            .await
            .expect("changed evidence response")
            .into_body()
            .collect()
            .await
            .expect("changed evidence body")
            .to_bytes();
        let changed: serde_json::Value = serde_json::from_slice(&changed).expect("changed json");
        assert!(changed["receipt"].is_null());
    }

    #[tokio::test]
    async fn export_endpoints_return_a_plan_and_downloadable_zip() {
        let (temp, project) = fixture_project();
        let graph = r#"{"schema_version":1,"name":"RNA seq review","nodes":[{"id":"noop","operator":"test.noop","ports":[],"layout":{"x":0.0,"y":0.0}}],"edges":[]}"#;
        let router = app(project);
        let plan_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/export/plan")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(graph))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(plan_response.status(), StatusCode::OK);
        let plan_body = plan_response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let plan: serde_json::Value = serde_json::from_slice(&plan_body).expect("plan json");
        assert_eq!(plan["filename"], "RNA-seq-review.somite-run.zip");
        assert_eq!(plan["platform"], current_pixi_platform());
        assert_eq!(plan["tools"].as_array().map(Vec::len), Some(1));
        assert_eq!(plan["tools"][0]["operator_id"], "test.noop");

        let zip_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(graph))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(zip_response.status(), StatusCode::OK);
        assert_eq!(
            zip_response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/zip"))
        );
        let disposition = zip_response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            disposition,
            "attachment; filename=\"RNA-seq-review.somite-run.zip\""
        );
        let zip_body = zip_response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert!(zip_body.starts_with(b"PK"));
        let mut zip = ZipArchive::new(Cursor::new(zip_body)).expect("frozen archive");
        for name in [
            "main.nf",
            "nextflow.config",
            "pixi.toml",
            "pixi.lock",
            "run-closure.json",
            "workflow.somite.json",
            "assessment.json",
        ] {
            assert!(zip.by_name(name).is_ok(), "missing {name}");
        }
        assert!(zip.by_name("run.sh").is_err());
        assert!(!temp
            .path()
            .join(".somite/exports")
            .read_dir()
            .is_ok_and(|mut entries| entries.next().is_some()));
    }

    #[tokio::test]
    async fn source_export_plan_is_inspectable_but_bundle_requires_the_execution_environment() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let router =
            app(WebProject::open(fixture.root(), &graph_path).expect("source workflow project"));
        let body = serde_json::to_vec(&imported.graph).expect("source graph request");

        let plan = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/export/plan")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.clone()))
                    .expect("source export plan request"),
            )
            .await
            .expect("source export plan response");
        assert_eq!(plan.status(), StatusCode::OK);

        let bundle = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("source export request"),
            )
            .await
            .expect("source export response");
        assert_eq!(bundle.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = response_json(bundle).await;
        assert!(
            error["error"].as_str().is_some_and(|message| message
                .contains("Finish the execution environment")
                && message.contains("task containers or Conda environments are not frozen")),
            "{error}"
        );
    }

    #[tokio::test]
    async fn paper_endpoint_rebuilds_uploaded_methods_with_evidence() {
        let temp = TempDir::new().expect("temporary project");
        let operators = temp.path().join("operators");
        std::fs::create_dir(&operators).expect("operator directory");
        for (filename, id, title, paper) in [
            (
                "fastqc.json",
                "qc.fastqc",
                "FastQC",
                r#"{"aliases":["FastQC","Fast QC"],"operation_class":"quality_control","assays":["qc","rna-seq"]}"#,
            ),
            (
                "star.json",
                "align.star",
                "STAR",
                r#"{"aliases":["STAR"],"operation_class":"read_alignment","assays":["rna-seq"]}"#,
            ),
        ] {
            std::fs::write(
                operators.join(filename),
                format!(r#"{{"id":"{id}","title":"{title}","palette":[],"paper":{paper},"kind":"external","params":{{}},"ports":{{"in":[],"out":[]}},"argv":[],"outputs":{{}}}}"#),
            )
            .expect("operator schema");
        }
        let graph_path = temp.path().join("graph.somite.json");
        std::fs::write(&graph_path, r#"{"schema_version":1,"nodes":[],"edges":[]}"#)
            .expect("fixture graph");
        let project = WebProject::open(temp.path(), &graph_path).expect("web project");
        let uploads = temp.path().join(".somite/uploads");
        std::fs::create_dir_all(&uploads).expect("uploads directory");
        std::fs::write(
            uploads.join("methods.txt"),
            "RNA-seq reads from NCBI BioProject PRJNA300706 were assessed with FastQC and aligned using STAR.",
        )
        .expect("methods text");
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/paper")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"path":".somite/uploads/methods.txt"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let review: serde_json::Value = serde_json::from_slice(&body).expect("paper review");
        assert_eq!(review["extracted_via"], "text");
        assert_eq!(review["resources"][0]["accession"], "PRJNA300706");
        assert_eq!(review["resources"][0]["kind"], "bioproject");
        assert_eq!(review["resources"][0]["role"], "reads");
        assert!(review["resources"][0]["source_location"].is_null());
        assert!(review["candidates"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(review["candidates"][0]["evidence"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(review["candidates"][0]["assessment"]["nodes"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(review["candidates"][0]["assessment"]["graph_revision"]
            .as_str()
            .is_some_and(|revision| revision.starts_with("blake3:")));
    }

    #[tokio::test]
    async fn paper_endpoint_never_exports_an_empty_candidate_as_ready() {
        let (temp, project) = fixture_project();
        let uploads = temp.path().join(".somite/uploads");
        std::fs::create_dir_all(&uploads).expect("uploads directory");
        std::fs::write(
            uploads.join("prose.txt"),
            "This article discusses the history of algebra without a computational methods workflow.",
        )
        .expect("prose fixture");
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/paper")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"path":".somite/uploads/prose.txt"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let review: serde_json::Value = serde_json::from_slice(&body).expect("paper review");
        assert_eq!(review["outcome"], "no_reconstructable_methods");
        assert_eq!(review["candidates"], serde_json::json!([]));
        assert_eq!(review["mentions"], serde_json::json!([]));
    }

    #[test]
    fn paper_evidence_reports_the_exact_pdf_page_when_available() {
        let text = "first page\u{000c}Methods used BWA-MEM and samtools.\u{000c}references";
        assert_eq!(
            evidence_source_location(
                "poppler",
                text,
                EvidenceStatus::Explicit,
                "Methods used BWA-MEM and samtools."
            )
            .as_deref(),
            Some("PDF page 2")
        );
        assert!(evidence_source_location(
            "poppler",
            text,
            EvidenceStatus::Inferred,
            "Methods used BWA-MEM and samtools."
        )
        .is_none());
    }

    #[tokio::test]
    async fn paper_discovery_rejects_invalid_queries_and_ids_before_network_access() {
        let (_temp, project) = fixture_project();
        let router = app(project);
        let search = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/papers/search?q=%21%21")
                    .body(Body::empty())
                    .expect("search request"),
            )
            .await
            .expect("search response");
        assert_eq!(search.status(), StatusCode::BAD_REQUEST);

        let reconstruction = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/biorxiv/reconstruct")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"id":"PMC123"}"#))
                    .expect("reconstruction request"),
            )
            .await
            .expect("reconstruction response");
        assert_eq!(reconstruction.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn paper_resource_resolution_rejects_forged_citations_before_network_access() {
        let (_temp, project) = fixture_project();
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/paper/resources/resolve")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"resources":[{"accession":"SRR123456","kind":"assembly","role":"reads","context":"paper"}]}"#,
                    ))
                    .expect("resource request"),
            )
            .await
            .expect("resource response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn invalid_graph_is_rejected_without_overwriting_the_project() {
        let (temp, project) = fixture_project();
        let graph_path = temp.path().join("graph.somite.json");
        let before = std::fs::read_to_string(&graph_path).expect("before");
        let base_graph = project.session().expect("project session").graph;
        let body = serde_json::json!({
            "base_state_revision": graph_state_revision(&base_graph).expect("base revision"),
            "graph": {"schema_version": 99, "nodes": [], "edges": []}
        });
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/graph")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(std::fs::read_to_string(graph_path).expect("after"), before);
    }

    #[test]
    fn oversized_encoded_graph_preserves_existing_graph_and_creates_no_autosave() {
        let (temp, project) = fixture_project();
        let graph_path = temp.path().join("graph.somite.json");
        let before = std::fs::read(&graph_path).expect("valid graph before oversized save");
        let mut graph = project.session().expect("project session").graph;
        graph.name = Some("x".repeat(somite_ir::MAX_GRAPH_NAME_CHARS));
        let test_limit = 128;
        assert!(
            serde_json::to_vec_pretty(&graph)
                .expect("encoded graph")
                .len()
                > test_limit as usize
        );

        let error = WebProject::write_graph_at_with_limit(
            temp.path(),
            &graph_path,
            &graph,
            &project.catalog,
            test_limit,
        )
        .expect_err("oversized project graph must fail before replacement");
        assert!(
            matches!(
                error,
                ServerError::GraphTooLarge {
                    limit_bytes: 128,
                    ..
                }
            ),
            "{error}"
        );
        assert_eq!(
            std::fs::read(&graph_path).expect("valid graph after rejected save"),
            before
        );

        let autosave = project.autosave_path();
        assert!(!autosave.exists());
        let error = WebProject::write_graph_at_with_limit(
            temp.path(),
            &autosave,
            &graph,
            &project.catalog,
            test_limit,
        )
        .expect_err("oversized autosave must fail before destination creation");
        assert!(matches!(error, ServerError::GraphTooLarge { .. }));
        assert!(!autosave.exists());
    }

    #[cfg(unix)]
    #[test]
    fn graph_write_ignores_a_malicious_legacy_temporary_symlink() {
        let (temp, project) = fixture_project();
        let graph_path = temp.path().join("graph.somite.json");
        let outside = TempDir::new().expect("outside directory");
        let outside_file = outside.path().join("do-not-truncate.txt");
        std::fs::write(&outside_file, b"preserve me\n").expect("outside file");
        let predictable_temporary = graph_path.with_extension("somite.json.tmp");
        std::os::unix::fs::symlink(&outside_file, &predictable_temporary)
            .expect("malicious legacy temporary symlink");

        let mut graph = project.session().expect("project session").graph;
        graph.name = Some("Safely saved".to_owned());
        project
            .save_graph_at(&graph_path, &graph)
            .expect("atomic graph write");

        assert_eq!(
            std::fs::read(&outside_file).expect("outside file after save"),
            b"preserve me\n"
        );
        assert!(std::fs::symlink_metadata(&predictable_temporary)
            .expect("legacy symlink remains untouched")
            .file_type()
            .is_symlink());
        let saved: Graph =
            serde_json::from_slice(&std::fs::read(&graph_path).expect("saved canonical graph"))
                .expect("saved graph JSON");
        assert_eq!(saved.name.as_deref(), Some("Safely saved"));
    }

    #[test]
    fn project_open_rejects_a_graph_path_outside_the_project_root() {
        let (temp, _project) = fixture_project();
        let outside = TempDir::new().expect("outside directory");
        let outside_graph = outside.path().join("outside.somite.json");
        let original = br#"{"schema_version":1,"nodes":[],"edges":[]}"#;
        std::fs::write(&outside_graph, original).expect("outside graph");

        let error = WebProject::open(temp.path(), &outside_graph)
            .expect_err("outside graph path must be rejected");
        assert!(matches!(error, ServerError::UnsafeGraphPath(_)), "{error}");
        assert_eq!(
            std::fs::read(&outside_graph).expect("unchanged outside graph"),
            original
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_open_rejects_a_symlink_graph_target() {
        let (temp, _project) = fixture_project();
        let real_graph = temp.path().join("graph.somite.json");
        let alias_graph = temp.path().join("alias.somite.json");
        std::os::unix::fs::symlink(&real_graph, &alias_graph).expect("graph symlink");

        let error = WebProject::open(temp.path(), &alias_graph)
            .expect_err("symlink graph path must be rejected");
        assert!(matches!(error, ServerError::UnsafeGraphPath(_)), "{error}");
    }

    #[tokio::test]
    async fn upload_streams_into_the_project_and_returns_a_relative_path() {
        let (temp, project) = fixture_project();
        let boundary = "somite-test-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"reads.fastq\"\r\nContent-Type: application/octet-stream\r\n\r\n@read-1\nACGT\n+\n!!!!\n\r\n--{boundary}--\r\n"
        );
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/files")
                    .header(header::HOST, "127.0.0.1:7310")
                    .header(header::ORIGIN, "http://localhost:3000")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let response_body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let upload: serde_json::Value =
            serde_json::from_slice(&response_body).expect("upload json");
        assert_eq!(upload["path"], ".somite/uploads/reads.fastq");
        assert_eq!(upload["filename"], "reads.fastq");
        assert_eq!(
            std::fs::read_to_string(temp.path().join(".somite/uploads/reads.fastq"))
                .expect("uploaded file"),
            "@read-1\nACGT\n+\n!!!!\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_session_rejects_a_symlink_autosave_target() {
        let (_temp, project) = fixture_project();
        let outside = TempDir::new().expect("outside directory");
        let outside_graph = outside.path().join("outside.somite.json");
        std::fs::write(
            &outside_graph,
            br#"{"schema_version":1,"nodes":[],"edges":[]}"#,
        )
        .expect("outside graph");
        std::os::unix::fs::symlink(&outside_graph, project.autosave_path())
            .expect("autosave symlink");

        let error = project
            .session()
            .expect_err("symlink autosave must be rejected");
        assert!(matches!(error, ServerError::UnsafeGraphPath(_)), "{error}");
    }

    #[tokio::test]
    async fn cross_origin_upload_is_rejected_before_creating_the_upload_store() {
        let (temp, project) = fixture_project();
        let mut request = multipart_upload_request(
            "/api/files",
            "hostile-origin-upload",
            "reads.fastq",
            "application/octet-stream",
            b"hostile\n",
        );
        request.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.example"),
        );
        let response = app(project)
            .oneshot(request)
            .await
            .expect("hostile upload response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!temp.path().join(".somite/uploads").exists());
    }

    #[tokio::test]
    async fn dns_rebinding_origin_and_host_cannot_mutate_the_project() {
        let (temp, project) = fixture_project();
        let mut request = multipart_upload_request(
            "/api/files",
            "dns-rebinding-upload",
            "reads.fastq",
            "application/octet-stream",
            b"rebound\n",
        );
        request.headers_mut().insert(
            header::HOST,
            HeaderValue::from_static("attacker.example:7310"),
        );
        request.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.example:7310"),
        );
        let response = app(project)
            .oneshot(request)
            .await
            .expect("DNS-rebinding upload response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!temp.path().join(".somite/uploads").exists());
    }

    #[tokio::test]
    async fn cors_preflight_allows_both_explicit_local_web_origins_only() {
        let (_temp, project) = fixture_project();
        let router = app(project);
        for origin in ["http://localhost:3000", "http://127.0.0.1:3000"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::OPTIONS)
                        .uri("/api/graph")
                        .header(header::HOST, "127.0.0.1:7310")
                        .header(header::ORIGIN, origin)
                        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
                        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                        .body(Body::empty())
                        .expect("local preflight request"),
                )
                .await
                .expect("local preflight response");
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .and_then(|value| value.to_str().ok()),
                Some(origin)
            );
        }

        let hostile = router
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/graph")
                    .header(header::HOST, "attacker.example:7310")
                    .header(header::ORIGIN, "http://attacker.example:3000")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                    .body(Body::empty())
                    .expect("hostile preflight request"),
            )
            .await
            .expect("hostile preflight response");
        assert!(hostile
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[test]
    fn mutation_host_allowlist_accepts_only_loopback_authorities() {
        for allowed in [
            "localhost",
            "localhost:7310",
            "127.0.0.1",
            "127.0.0.1:7310",
            "[::1]",
            "[::1]:7310",
        ] {
            assert!(loopback_authority(allowed), "expected {allowed} to pass");
        }
        for rejected in [
            "attacker.example",
            "attacker.example:7310",
            "localhost.attacker.example:7310",
            "0.0.0.0:7310",
            "192.168.1.2:7310",
        ] {
            assert!(!loopback_authority(rejected), "expected {rejected} to fail");
        }
    }

    #[tokio::test]
    async fn originless_upload_requires_the_local_request_header() {
        let (temp, project) = fixture_project();
        let mut request = multipart_upload_request(
            "/api/files",
            "missing-origin-upload",
            "reads.fastq",
            "application/octet-stream",
            b"missing origin\n",
        );
        request.headers_mut().remove("x-somite-request");
        let response = app(project)
            .oneshot(request)
            .await
            .expect("originless upload response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!temp.path().join(".somite/uploads").exists());
    }

    #[tokio::test]
    async fn generic_upload_enforces_file_and_project_byte_limits() {
        let (temp, mut project) = fixture_project();
        project.upload_limits = GenericUploadLimits {
            max_file_bytes: 8,
            max_project_bytes: 12,
        };
        let router = app(project);

        let oversized = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/files",
                "oversized-upload",
                "oversized.fastq",
                "application/octet-stream",
                b"123456789",
            ))
            .await
            .expect("oversized upload response");
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!temp.path().join(".somite/uploads/oversized.fastq").exists());

        let accepted = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/files",
                "accepted-upload",
                "accepted.fastq",
                "application/octet-stream",
                b"12345678",
            ))
            .await
            .expect("accepted upload response");
        assert_eq!(accepted.status(), StatusCode::OK);

        let over_budget = router
            .oneshot(multipart_upload_request(
                "/api/files",
                "budget-upload",
                "budget.fastq",
                "application/octet-stream",
                b"12345",
            ))
            .await
            .expect("project budget upload response");
        assert_eq!(over_budget.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!temp.path().join(".somite/uploads/budget.fastq").exists());
        assert_eq!(
            std::fs::read(temp.path().join(".somite/uploads/accepted.fastq"))
                .expect("accepted upload"),
            b"12345678"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_opened_project_upload_binds_through_source_edit() {
        let fixture = nfcore_source_fixture();
        let imported = import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("source resolution");
        let workflow = imported.graph.nodes[0]
            .source_workflow
            .as_ref()
            .expect("source workflow");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&imported.graph).expect("source graph JSON"),
        )
        .expect("source graph");
        let alias_parent = TempDir::new().expect("project alias parent");
        let alias = alias_parent.path().join("project-alias");
        std::os::unix::fs::symlink(fixture.root(), &alias).expect("project root alias");
        let project = WebProject::open(&alias, alias.join("graph.somite.json"))
            .expect("symlink-opened project");
        assert_eq!(
            project.root,
            fixture.root().canonicalize().expect("real root")
        );
        let router = app(project);

        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/files",
                "symlink-root-upload",
                "reads.fastq",
                "application/octet-stream",
                b"@read\nAC\n+\n!!\n",
            ))
            .await
            .expect("upload response");
        assert_eq!(upload.status(), StatusCode::OK);
        let upload = response_json(upload).await;
        assert_eq!(upload["path"], ".somite/uploads/reads.fastq");

        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/source-workflows/edit")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "base_state_revision": graph_state_revision(&imported.graph)
                                .expect("source state revision"),
                            "workflow_revision": workflow.workflow_revision,
                            "edits": [{
                                "kind": "set_parameter",
                                "name": "input_file",
                                "binding": {
                                    "kind": "project_file",
                                    "path": upload["path"]
                                }
                            }]
                        })
                        .to_string(),
                    ))
                    .expect("source edit request"),
            )
            .await
            .expect("source edit response");
        assert_eq!(response.status(), StatusCode::OK);
        let response = response_json(response).await;
        assert_eq!(
            response["graph"]["nodes"][0]["source_workflow"]["bindings"]["input_file"]["path"],
            ".somite/uploads/reads.fastq"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn generic_upload_rejects_a_symlinked_upload_directory() {
        let (temp, project) = fixture_project();
        let somite = temp.path().join(".somite");
        std::fs::create_dir_all(&somite).expect("Somite state directory");
        let outside = temp.path().join("outside-uploads");
        std::fs::create_dir(&outside).expect("outside upload directory");
        std::os::unix::fs::symlink(&outside, somite.join("uploads"))
            .expect("symlinked upload directory");

        let response = app(project)
            .oneshot(multipart_upload_request(
                "/api/files",
                "symlinked-generic-upload",
                "reads.fastq",
                "application/octet-stream",
                b"@read\nAC\n+\n!!\n",
            ))
            .await
            .expect("symlinked upload response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            std::fs::read_dir(outside)
                .expect("outside upload directory")
                .count(),
            0
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn simultaneous_same_name_generic_uploads_publish_without_clobbering() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let first = router.clone().oneshot(multipart_upload_request(
            "/api/files",
            "generic-upload-one",
            "reads.fastq",
            "application/octet-stream",
            b"first\n",
        ));
        let second = router.clone().oneshot(multipart_upload_request(
            "/api/files",
            "generic-upload-two",
            "reads.fastq",
            "application/octet-stream",
            b"second\n",
        ));
        let (first, second) = tokio::join!(first, second);
        let first = first.expect("first concurrent upload");
        let second = second.expect("second concurrent upload");
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        let first = response_json(first).await;
        let second = response_json(second).await;
        assert_ne!(first["path"], second["path"]);

        let mut contents = std::fs::read_dir(temp.path().join(".somite/uploads"))
            .expect("upload directory")
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                (!path.file_name()?.to_string_lossy().starts_with(".upload-"))
                    .then(|| std::fs::read(path).expect("published upload"))
            })
            .collect::<Vec<_>>();
        contents.sort();
        assert_eq!(contents, [b"first\n".to_vec(), b"second\n".to_vec()]);
    }

    #[tokio::test]
    async fn generic_biological_upload_can_exceed_the_default_json_body_limit() {
        let (temp, project) = fixture_project();
        let contents = vec![b'A'; 3 * 1024 * 1024];
        let response = app(project)
            .oneshot(multipart_upload_request(
                "/api/files",
                "large-biological-upload",
                "reads.fastq",
                "application/octet-stream",
                &contents,
            ))
            .await
            .expect("large generic upload response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::metadata(temp.path().join(".somite/uploads/reads.fastq"))
                .expect("large generic upload")
                .len(),
            contents.len() as u64
        );
    }

    #[tokio::test]
    async fn ordinary_api_routes_keep_axums_default_body_limit() {
        let (_temp, project) = fixture_project();
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/graph")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(vec![b' '; 3 * 1024 * 1024]))
                    .expect("oversized graph request"),
            )
            .await
            .expect("oversized graph response");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn paper_upload_is_bounded_and_content_addressed_without_changing_generic_uploads() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let pdf = b"%PDF-1.4\nminimal paper fixture\n%%EOF\n";

        let first = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-one",
                "first.pdf",
                "application/pdf",
                pdf,
            ))
            .await
            .expect("first paper upload");
        assert_eq!(first.status(), StatusCode::OK);
        let first = response_json(first).await;
        assert_eq!(first["reused"], false);
        assert_eq!(first["size_bytes"], pdf.len());
        assert_eq!(first["media_kind"], "pdf");
        assert!(first["digest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("blake3:")));

        let second = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-two",
                "renamed.pdf",
                "application/pdf",
                pdf,
            ))
            .await
            .expect("second paper upload");
        assert_eq!(second.status(), StatusCode::OK);
        let second = response_json(second).await;
        assert_eq!(second["reused"], true);
        assert_eq!(second["digest"], first["digest"]);
        assert_eq!(second["path"], first["path"]);
        assert_eq!(second["filename"], "renamed.pdf");

        let object_path = temp
            .path()
            .join(first["path"].as_str().expect("object path"));
        assert_eq!(std::fs::read(object_path).expect("paper object"), pdf);
        assert_eq!(
            std::fs::read_dir(temp.path().join(".somite/papers/objects"))
                .expect("paper objects")
                .count(),
            1
        );
        let source_hex = paper_digest_hex(first["digest"].as_str().expect("paper digest"))
            .expect("paper digest hex");
        let mut display_names = std::fs::read_dir(
            temp.path()
                .join(".somite/papers/display-names")
                .join(source_hex),
        )
        .expect("paper display names")
        .map(|entry| {
            let entry = entry.expect("paper display-name entry");
            let record: StoredPaperDisplayName = serde_json::from_slice(
                &std::fs::read(entry.path()).expect("paper display-name record"),
            )
            .expect("paper display-name JSON");
            record.filename
        })
        .collect::<Vec<_>>();
        display_names.sort();
        assert_eq!(display_names, ["first.pdf", "renamed.pdf"]);

        let generic = router
            .oneshot(multipart_upload_request(
                "/api/files",
                "generic-file",
                "reads.fastq",
                "application/octet-stream",
                b"@read\nACGT\n+\n!!!!\n",
            ))
            .await
            .expect("generic upload");
        assert_eq!(generic.status(), StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn simultaneous_identical_paper_uploads_converge_on_one_object() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let pdf = b"%PDF-1.4\nconcurrent paper fixture\n%%EOF\n";
        let first = router.clone().oneshot(multipart_upload_request(
            "/api/papers/uploads",
            "paper-race-one",
            "first.pdf",
            "application/pdf",
            pdf,
        ));
        let second = router.clone().oneshot(multipart_upload_request(
            "/api/papers/uploads",
            "paper-race-two",
            "second.pdf",
            "application/pdf",
            pdf,
        ));
        let (first, second) = tokio::join!(first, second);
        let first = first.expect("first upload response");
        let second = second.expect("second upload response");
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        let first = response_json(first).await;
        let second = response_json(second).await;
        assert_eq!(first["digest"], second["digest"]);
        assert_eq!(first["path"], second["path"]);
        assert_ne!(first["reused"], second["reused"]);
        assert_eq!(
            std::fs::read_dir(temp.path().join(".somite/papers/objects"))
                .expect("paper objects")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn duplicate_paper_upload_fails_closed_on_same_size_object_corruption() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let pdf = b"%PDF-1.4\nimmutable paper fixture\n%%EOF\n";
        let first = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-integrity-one",
                "paper.pdf",
                "application/pdf",
                pdf,
            ))
            .await
            .expect("first paper upload");
        let first = response_json(first).await;
        let object = temp
            .path()
            .join(first["path"].as_str().expect("paper object path"));
        let mut corrupt = pdf.to_vec();
        corrupt[12] ^= 1;
        std::fs::write(&object, &corrupt).expect("corrupt paper object");

        let second = router
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-integrity-two",
                "paper-again.pdf",
                "application/pdf",
                pdf,
            ))
            .await
            .expect("second paper upload");
        assert_eq!(second.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let error = response_json(second).await;
        assert!(error["error"]
            .as_str()
            .is_some_and(|message| message.contains("does not match its digest")));
        assert_eq!(
            std::fs::read(object).expect("corrupt object retained"),
            corrupt
        );
    }

    #[tokio::test]
    async fn paper_intake_rejects_a_same_size_mutated_content_addressed_payload() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let contents = b"Paper methods without a reconstructable workflow.";
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-intake-integrity",
                "methods.txt",
                "text/plain",
                contents,
            ))
            .await
            .expect("paper upload response");
        assert_eq!(upload.status(), StatusCode::OK);
        let upload = response_json(upload).await;
        let payload = temp
            .path()
            .join(upload["path"].as_str().expect("paper payload path"));
        let mut mutated = contents.to_vec();
        mutated[8] ^= 1;
        std::fs::write(&payload, &mutated).expect("mutated paper payload");

        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error = response_json(response).await;
        assert!(error["error"]
            .as_str()
            .is_some_and(|message| message.contains("content address")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paper_intake_rejects_a_payload_symlink_that_escapes_the_object_directory() {
        let (temp, project) = fixture_project();
        let router = app(project);
        let contents = b"Paper methods without a reconstructable workflow.";
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-intake-symlink",
                "methods.txt",
                "text/plain",
                contents,
            ))
            .await
            .expect("paper upload response");
        assert_eq!(upload.status(), StatusCode::OK);
        let upload = response_json(upload).await;
        let payload = temp
            .path()
            .join(upload["path"].as_str().expect("paper payload path"));
        let outside = temp.path().join("outside-paper.txt");
        std::fs::write(&outside, contents).expect("outside paper payload");
        std::fs::remove_file(&payload).expect("remove stored payload");
        std::os::unix::fs::symlink(&outside, &payload).expect("paper payload symlink");

        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error = response_json(response).await;
        assert!(error["error"]
            .as_str()
            .is_some_and(|message| message.contains("regular non-symlink file")));
    }

    #[tokio::test]
    async fn oversized_paper_upload_is_rejected_and_partial_file_is_removed() {
        let (_temp, mut project) = fixture_project();
        project.paper_limits.max_upload_bytes = 12;
        let incoming = project.root.join(".somite/papers/incoming");
        let response = app(project)
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-too-large",
                "methods.txt",
                "text/plain",
                b"this paper exceeds the configured test limit",
            ))
            .await
            .expect("oversized upload response");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!incoming
            .read_dir()
            .is_ok_and(|mut entries| entries.next().is_some()));
    }

    #[tokio::test]
    async fn missing_paper_tools_are_preflighted_and_fail_intake_actionably() {
        let (temp, mut project) = fixture_project();
        project.paper_tools = PaperToolchainState::unavailable(temp.path());
        let router = app(project);

        let system = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/system")
                    .body(Body::empty())
                    .expect("system request"),
            )
            .await
            .expect("system response");
        assert_eq!(system.status(), StatusCode::OK);
        let system = response_json(system).await;
        assert_eq!(system["paper_extraction"]["native_pdf_text"], false);
        assert_eq!(system["paper_extraction"]["scanned_pdf_ocr"], false);
        let tools = system["paper_extraction"]["tools"]
            .as_array()
            .expect("paper tool preflight");
        assert_eq!(tools.len(), 4);
        assert!(tools.iter().all(|tool| tool["available"] == false));
        assert!(tools.iter().all(|tool| tool["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("conda-forge::"))));

        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "missing-tools-paper",
                "scan.pdf",
                "application/pdf",
                b"%PDF-1.4\nimage-only fixture\n%%EOF\n",
            ))
            .await
            .expect("paper upload");
        let upload = response_json(upload).await;
        let started = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        assert_eq!(started.status(), StatusCode::ACCEPTED);
        let started = response_json(started).await;
        let failed = wait_for_paper_phase(
            &router,
            started["job_id"].as_str().expect("paper job id"),
            "failed",
        )
        .await;
        assert_eq!(failed["failure"]["code"], "missing_extraction_dependency");
        assert!(failed["failure"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("pdfinfo")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paper_intake_enforces_the_configured_ocr_page_limit() {
        let (temp, mut project) = fixture_project();
        let bin = temp
            .path()
            .join(".somite/tools/paper/.pixi/envs/default/bin");
        std::fs::create_dir_all(&bin).expect("managed Pixi bin directory");
        write_test_executable(
            &executable_candidate(&bin, "pdftotext"),
            b"#!/bin/sh\nprintf 'short image-only layer'\n",
        );
        write_test_executable(
            &executable_candidate(&bin, "pdfinfo"),
            b"#!/bin/sh\nprintf 'Pages: 2\\n'\n",
        );
        for name in ["pdftoppm", "tesseract"] {
            write_test_executable(&executable_candidate(&bin, name), b"#!/bin/sh\nexit 0\n");
        }
        project.paper_tools = PaperToolchainState::detect(temp.path());
        project.paper_limits.max_ocr_pages = 1;
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "ocr-page-limit",
                "scan.pdf",
                "application/pdf",
                b"%PDF-1.4\nimage-only fixture\n%%EOF\n",
            ))
            .await
            .expect("paper upload");
        let upload = response_json(upload).await;
        let started = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        let started = response_json(started).await;
        let failed = wait_for_paper_phase(
            &router,
            started["job_id"].as_str().expect("paper job id"),
            "failed",
        )
        .await;
        assert_eq!(failed["failure"]["code"], "paper_extraction_limit");
        assert!(failed["failure"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("2 pages") && message.contains("1 pages")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paper_intake_reports_determinate_ocr_page_progress() {
        let (temp, mut project) = fixture_project();
        let bin = temp
            .path()
            .join(".somite/tools/paper/.pixi/envs/default/bin");
        std::fs::create_dir_all(&bin).expect("managed Pixi bin directory");
        write_test_executable(
            &executable_candidate(&bin, "pdftotext"),
            b"#!/bin/sh\nprintf 'short image-only layer'\n",
        );
        write_test_executable(
            &executable_candidate(&bin, "pdfinfo"),
            b"#!/bin/sh\nprintf 'Pages: 1\\n'\n",
        );
        write_test_executable(
            &executable_candidate(&bin, "pdftoppm"),
            b"#!/bin/sh\nfor last in \"$@\"; do :; done\nprintf 'fake png' > \"${last}.png\"\n",
        );
        write_test_executable(
            &executable_candidate(&bin, "tesseract"),
            b"#!/bin/sh\nsleep 0.25\nprintf 'Methods RNA sequencing reads were quality checked with FastQC before downstream analysis.'\n",
        );
        project.paper_tools = PaperToolchainState::detect(temp.path());
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "ocr-progress",
                "scan.pdf",
                "application/pdf",
                b"%PDF-1.4\nimage-only fixture\n%%EOF\n",
            ))
            .await
            .expect("paper upload");
        let upload = response_json(upload).await;
        let started = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        let started = response_json(started).await;
        let job_id = started["job_id"].as_str().expect("paper job id");
        let mut observed_page_progress = false;
        for _ in 0..100 {
            let status = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/papers/intakes/{job_id}"))
                        .body(Body::empty())
                        .expect("paper status request"),
                )
                .await
                .expect("paper status response");
            let status = response_json(status).await;
            if status["progress"]["unit"] == "pages"
                && status["progress"]["total"] == 1
                && status["progress"]["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("OCR page 1 of 1"))
            {
                observed_page_progress = true;
                break;
            }
            if matches!(
                status["phase"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            observed_page_progress,
            "OCR page progress was never visible"
        );
        let completed = wait_for_paper_phase(&router, job_id, "completed").await;
        assert_eq!(completed["result"]["extracted_via"], "ocr");
    }

    #[tokio::test]
    async fn paper_status_long_poll_returns_when_progress_changes_without_a_phase_change() {
        let (_temp, project) = fixture_project();
        let job = test_paper_intake_job("paper-progress-poll", PaperIntakePhase::Extracting);
        project
            .paper_intakes
            .lock()
            .expect("paper jobs")
            .insert("paper-progress-poll".to_owned(), Arc::clone(&job));
        let router = app(project);
        let request = router.oneshot(
            Request::builder()
                .uri("/api/papers/intakes/paper-progress-poll?wait_ms=5000")
                .body(Body::empty())
                .expect("paper long-poll request"),
        );
        let change = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            update_paper_extraction_progress(&job, ExtractionProgress::Ocr { page: 2, total: 3 });
        };
        let started = Instant::now();
        let (response, ()) = tokio::join!(request, change);
        let response = response.expect("paper long-poll response");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "paper progress poll waited {:?}",
            started.elapsed()
        );
        let status = response_json(response).await;
        assert_eq!(status["phase"], "extracting");
        assert_eq!(status["progress"]["unit"], "pages");
        assert_eq!(status["progress"]["completed"], 1);
        assert_eq!(status["progress"]["total"], 3);
        assert_eq!(status["progress"]["message"], "Reading OCR page 2 of 3");
    }

    #[tokio::test]
    async fn paper_cancel_route_reaches_a_retained_cancelled_status() {
        let (_temp, mut project) = fixture_project();
        project.paper_execution = Arc::new(Semaphore::new(0));
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-cancel-upload",
                "article.txt",
                "text/plain",
                b"A queued paper intake that will be cancelled.",
            ))
            .await
            .expect("paper upload");
        let upload = response_json(upload).await;
        let started = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        let started = response_json(started).await;
        let job_id = started["job_id"].as_str().expect("paper job id");
        assert_eq!(started["phase"], "queued");
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/papers/intakes/{job_id}/cancel"))
                    .body(Body::empty())
                    .expect("cancel request"),
            )
            .await
            .expect("cancel response");
        assert_eq!(response.status(), StatusCode::OK);
        let response = response_json(response).await;
        assert!(matches!(
            response["phase"].as_str(),
            Some("cancelling" | "cancelled")
        ));
        let cancelled = wait_for_paper_phase(&router, job_id, "cancelled").await;
        assert!(cancelled["failure"].is_null());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn paper_cancel_route_stops_active_ocr_cleans_workspace_and_releases_capacity() {
        let (temp, mut project) = fixture_project();
        let bin = temp
            .path()
            .join(".somite/tools/paper/.pixi/envs/default/bin");
        std::fs::create_dir_all(&bin).expect("managed Pixi bin directory");
        write_test_executable(
            &executable_candidate(&bin, "pdftotext"),
            b"#!/bin/sh\nprintf 'short image-only layer'\n",
        );
        write_test_executable(
            &executable_candidate(&bin, "pdfinfo"),
            b"#!/bin/sh\nprintf 'Pages: 1\\n'\n",
        );
        let prefix_record = temp.path().join("ocr-prefix");
        write_test_executable(
            &executable_candidate(&bin, "pdftoppm"),
            format!(
                "#!/bin/sh\nfor last in \"$@\"; do :; done\nprintf '%s' \"$last\" > '{}'\nprintf 'fake png' > \"${{last}}.png\"\n",
                prefix_record.display()
            )
            .as_bytes(),
        );
        let child_record = temp.path().join("ocr-child-pid");
        write_test_executable(
            &executable_candidate(&bin, "tesseract"),
            format!(
                "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec sleep 30\n",
                child_record.display()
            )
            .as_bytes(),
        );
        project.paper_tools = PaperToolchainState::detect(temp.path());
        let execution = Arc::new(Semaphore::new(1));
        project.paper_execution = Arc::clone(&execution);
        let router = app(project);

        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "active-ocr-cancel",
                "scan.pdf",
                "application/pdf",
                b"%PDF-1.4\nimage-only fixture\n%%EOF\n",
            ))
            .await
            .expect("paper upload response");
        let upload = response_json(upload).await;
        let started = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        assert_eq!(started.status(), StatusCode::ACCEPTED);
        let started = response_json(started).await;
        let job_id = started["job_id"].as_str().expect("paper job id").to_owned();

        let mut child_pid = None;
        for _ in 0..200 {
            if let Ok(pid) = std::fs::read_to_string(&child_record) {
                child_pid = pid.trim().parse::<u32>().ok();
                if child_pid.is_some() && execution.available_permits() == 0 {
                    break;
                }
            }
            let status = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/papers/intakes/{job_id}"))
                        .body(Body::empty())
                        .expect("paper status request"),
                )
                .await
                .expect("paper status response");
            let status = response_json(status).await;
            assert!(
                !matches!(
                    status["phase"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                ),
                "paper intake terminated before active OCR: {status}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let child_pid = child_pid.expect("active OCR child PID");
        let prefix = std::fs::read_to_string(&prefix_record).expect("OCR workspace prefix");
        let workspace = PathBuf::from(prefix)
            .parent()
            .expect("OCR workspace directory")
            .to_owned();
        assert!(workspace.is_dir(), "OCR workspace should be active");
        assert!(Path::new(&format!("/proc/{child_pid}")).exists());
        assert_eq!(execution.available_permits(), 0);

        let cancel_started = Instant::now();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/papers/intakes/{job_id}/cancel"))
                    .body(Body::empty())
                    .expect("cancel request"),
            )
            .await
            .expect("cancel response");
        assert_eq!(response.status(), StatusCode::OK);
        let cancelled = wait_for_paper_phase(&router, &job_id, "cancelled").await;
        assert!(cancelled["failure"].is_null());
        assert!(
            cancel_started.elapsed() < Duration::from_secs(2),
            "active OCR cancellation took {:?}",
            cancel_started.elapsed()
        );

        for _ in 0..100 {
            if !workspace.exists()
                && !Path::new(&format!("/proc/{child_pid}")).exists()
                && execution.available_permits() == 1
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!workspace.exists(), "OCR workspace was not removed");
        assert!(
            !Path::new(&format!("/proc/{child_pid}")).exists(),
            "OCR child process was not reaped"
        );
        assert_eq!(execution.available_permits(), 1);
    }

    #[tokio::test]
    async fn paper_intake_admission_is_bounded_when_every_retained_job_is_active() {
        let (_temp, project) = fixture_project();
        {
            let mut jobs = project.paper_intakes.lock().expect("paper jobs");
            for index in 0..MAX_ACTIVE_PAPER_INTAKES {
                let id = format!("paper-active-{index}");
                jobs.insert(
                    id.clone(),
                    test_paper_intake_job(&id, PaperIntakePhase::Extracting),
                );
            }
        }
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-cap-upload",
                "article.txt",
                "text/plain",
                b"Methods without a reconstructable workflow.",
            ))
            .await
            .expect("paper upload");
        let upload = response_json(upload).await;
        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let error = response_json(response).await;
        assert!(error["error"]
            .as_str()
            .is_some_and(|message| message.contains("capacity is full")));
    }

    #[tokio::test]
    async fn paper_intake_retries_from_digest_and_reuses_both_cache_layers() {
        let (_temp, project) = fixture_project();
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-text",
                "article.txt",
                "text/plain",
                b"This article discusses morphology without a computational methods workflow.",
            ))
            .await
            .expect("paper upload");
        assert_eq!(upload.status(), StatusCode::OK);
        let upload = response_json(upload).await;
        let digest = upload["digest"].as_str().expect("paper digest");
        let start_body = serde_json::json!({ "digest": digest }).to_string();

        let first = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes?idempotency_key=paper-intake-one")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(start_body.clone()))
                    .expect("first intake request"),
            )
            .await
            .expect("first intake response");
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let first = response_json(first).await;
        assert_eq!(first["replayed"], false);
        let first_job = first["job_id"].as_str().expect("first job id");

        let replay = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes?idempotency_key=paper-intake-one")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(start_body.clone()))
                    .expect("replayed intake request"),
            )
            .await
            .expect("replayed intake response");
        assert_eq!(replay.status(), StatusCode::ACCEPTED);
        let replay = response_json(replay).await;
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["job_id"], first["job_id"]);

        let completed = wait_for_paper_phase(&router, first_job, "completed").await;
        assert_eq!(completed["result"]["outcome"], "no_reconstructable_methods");
        assert_eq!(completed["cache"]["extraction"], false);
        assert_eq!(completed["cache"]["reconstruction"], false);
        for stage in [
            "extraction",
            "locating_methods",
            "recognizing_methods",
            "assessing_drafts",
            "reconstruction",
            "total",
        ] {
            assert!(
                completed["durations_ms"].get(stage).is_some(),
                "missing {stage} duration: {completed}"
            );
        }

        let retry = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes?idempotency_key=paper-intake-two")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(start_body))
                    .expect("retry intake request"),
            )
            .await
            .expect("retry intake response");
        assert_eq!(retry.status(), StatusCode::ACCEPTED);
        let retry = response_json(retry).await;
        let retried = wait_for_paper_phase(
            &router,
            retry["job_id"].as_str().expect("retry job id"),
            "completed",
        )
        .await;
        assert_eq!(retried["cache"]["extraction"], true);
        assert_eq!(retried["cache"]["reconstruction"], true);
        assert_eq!(retried["result"], completed["result"]);
    }

    #[tokio::test]
    async fn same_paper_with_a_new_catalog_reuses_extraction_but_rebuilds_reconstruction() {
        let (temp, project) = fixture_project();
        let graph_path = temp.path().join("graph.somite.json");
        let first_catalog_revision = project
            .catalog
            .catalog_revision()
            .expect("catalog revision");
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-catalog-one",
                "article.txt",
                "text/plain",
                b"This article discusses morphology without a computational methods workflow.",
            ))
            .await
            .expect("paper upload");
        assert_eq!(upload.status(), StatusCode::OK);
        let upload = response_json(upload).await;
        let digest = upload["digest"].as_str().expect("paper digest").to_owned();
        let first = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": digest }).to_string(),
                    ))
                    .expect("first intake request"),
            )
            .await
            .expect("first intake response");
        let first = response_json(first).await;
        let completed = wait_for_paper_phase(
            &router,
            first["job_id"].as_str().expect("first paper job id"),
            "completed",
        )
        .await;
        assert_eq!(completed["cache"]["extraction"], false);
        assert_eq!(completed["cache"]["reconstruction"], false);
        drop(router);

        std::fs::write(
            temp.path().join("operators/test.noop.json"),
            r#"{"id":"test.noop","title":"No-op revised","palette":[],"kind":"external","bin":"true","argv":["true"]}"#,
        )
        .expect("revised no-op operator");
        let second_project =
            WebProject::open(temp.path(), &graph_path).expect("reopened web project");
        let second_catalog_revision = second_project
            .catalog
            .catalog_revision()
            .expect("revised catalog revision");
        assert_ne!(second_catalog_revision, first_catalog_revision);
        let second_router = app(second_project);
        let second = second_router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": digest }).to_string(),
                    ))
                    .expect("second intake request"),
            )
            .await
            .expect("second intake response");
        let second = response_json(second).await;
        let rebuilt = wait_for_paper_phase(
            &second_router,
            second["job_id"].as_str().expect("second paper job id"),
            "completed",
        )
        .await;
        assert_eq!(rebuilt["cache"]["extraction"], true);
        assert_eq!(rebuilt["cache"]["reconstruction"], false);
        assert_eq!(rebuilt["result"], completed["result"]);
    }

    #[tokio::test]
    async fn stale_paper_idempotency_replay_is_refreshed_after_job_eviction() {
        let (temp, project) = fixture_project();
        let contents = b"A paper without a reconstructable computational workflow.";
        let digest = format!("blake3:{}", blake3::hash(contents).to_hex());
        let source_hex = paper_digest_hex(&digest).expect("paper digest");
        let object_directory = temp.path().join(".somite/papers/objects").join(source_hex);
        std::fs::create_dir_all(&object_directory).expect("paper object directory");
        std::fs::write(object_directory.join("payload.txt"), contents).expect("paper object");
        std::fs::write(
            object_directory.join("artifact.json"),
            serde_json::to_vec_pretty(&StoredPaperArtifact {
                schema_version: 1,
                digest: digest.clone(),
                size_bytes: contents.len() as u64,
                media_kind: PaperMediaKind::Text,
            })
            .expect("paper metadata"),
        )
        .expect("paper metadata file");
        let request_digest = content_digest(
            &serde_json::to_vec(&("paper_intake", &digest)).expect("request identity"),
        );
        project
            .paper_intake_replays
            .lock()
            .expect("paper replays")
            .insert(
                "stale-paper-key".to_owned(),
                PaperIntakeReplay {
                    request_digest,
                    result: PaperIntakeStartResponse {
                        job_id: "paper-evicted".to_owned(),
                        source_digest: digest.clone(),
                        phase: PaperIntakePhase::Queued,
                        replayed: false,
                    },
                    sequence: 0,
                },
            );
        let router = app(project);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes?idempotency_key=stale-paper-key")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": digest }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let started = response_json(response).await;
        assert_eq!(started["replayed"], false);
        assert_ne!(started["job_id"], "paper-evicted");
        let completed = wait_for_paper_phase(
            &router,
            started["job_id"].as_str().expect("paper job id"),
            "completed",
        )
        .await;
        assert_eq!(completed["phase"], "completed");
    }

    #[tokio::test]
    async fn extracted_text_limit_fails_the_job_with_an_actionable_code() {
        let (_temp, mut project) = fixture_project();
        project.paper_limits.max_extracted_text_bytes = 16;
        let router = app(project);
        let upload = router
            .clone()
            .oneshot(multipart_upload_request(
                "/api/papers/uploads",
                "paper-text-limit",
                "article.txt",
                "text/plain",
                b"This extracted paper text exceeds sixteen bytes.",
            ))
            .await
            .expect("paper upload");
        let upload = response_json(upload).await;
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/papers/intakes")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "digest": upload["digest"] }).to_string(),
                    ))
                    .expect("paper intake request"),
            )
            .await
            .expect("paper intake response");
        let started = response_json(response).await;
        let failed = wait_for_paper_phase(
            &router,
            started["job_id"].as_str().expect("paper job id"),
            "failed",
        )
        .await;
        assert_eq!(failed["failure"]["code"], "paper_extraction_limit");
        assert_eq!(failed["result"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn autosave_validates_and_writes_a_recovery_graph() {
        let (temp, project) = fixture_project();
        let graph = project.session().expect("project session").graph;
        let base_state_revision = graph_state_revision(&graph).expect("base state revision");
        let body = serde_json::json!({
            "base_state_revision": base_state_revision,
            "graph": graph,
        });
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/graph/autosave")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let response = response_json(response).await;
        assert_eq!(response["valid"], true);
        assert_eq!(response["state_revision"], base_state_revision);
        let recovery =
            std::fs::read_to_string(temp.path().join("graph.somite.autosave.somite.json"))
                .expect("recovery graph");
        let graph: Graph = serde_json::from_str(&recovery).expect("recovery json");
        assert_eq!(graph.schema_version, somite_ir::SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn agent_prompt_preflight_does_not_commit_when_agent_is_unavailable() {
        let (temp, project) = fixture_project();
        let mut graph = project.session().expect("project session").graph;
        let base_state_revision = graph_state_revision(&graph).expect("base state revision");
        graph.name = Some("must not be committed".to_owned());
        let graph_path = project.graph_path.clone();
        let autosave_path = project.autosave_path();
        let before = std::fs::read(&graph_path).expect("project graph before prompt");

        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/prompt")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "message": "Inspect this graph",
                            "base_state_revision": base_state_revision,
                            "graph": graph,
                        })
                        .to_string(),
                    ))
                    .expect("agent prompt request"),
            )
            .await
            .expect("agent prompt response");
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            std::fs::read(graph_path).expect("project graph after prompt"),
            before
        );
        assert!(!autosave_path.exists());
        drop(temp);
    }

    #[tokio::test]
    async fn stale_browser_saves_cannot_overwrite_an_agent_source_import() {
        let fixture = nfcore_source_fixture();
        import_nfcore_source(
            fixture.root(),
            &fixture.request,
            &fixture.source_operator_revision,
            Some(&fixture.repository),
        )
        .expect("prime exact source cache");
        let empty = Graph {
            schema_version: somite_ir::SCHEMA_VERSION,
            name: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            annotations: Vec::new(),
            variant_origin: None,
        };
        let empty_revision = graph_state_revision(&empty).expect("empty state revision");
        let graph_path = fixture.root().join("graph.somite.json");
        std::fs::write(
            &graph_path,
            pretty_json_line(&empty).expect("empty graph JSON"),
        )
        .expect("empty graph");
        let project =
            WebProject::open(fixture.root(), &graph_path).expect("source workflow project");
        let authorization = format!("Bearer {}", project.mcp_runtime_capability());
        let router = app(project);

        let imported = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/agent/source-workflows/nfcore/resolve")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, authorization)
                    .body(Body::from(
                        serde_json::json!({
                            "workflow": fixture.request.workflow,
                            "revision": fixture.request.revision,
                            "base_state_revision": empty_revision,
                            "idempotency_key": "browser-cas-source-import",
                            "summary": "Import the exact source workflow"
                        })
                        .to_string(),
                    ))
                    .expect("agent source import request"),
            )
            .await
            .expect("agent source import response");
        assert_eq!(imported.status(), StatusCode::OK);
        let imported = response_json(imported).await;
        let imported_revision = imported["state_revision"]
            .as_str()
            .expect("imported state revision")
            .to_owned();

        let stale_request = serde_json::json!({
            "base_state_revision": empty_revision,
            "graph": empty,
        })
        .to_string();
        for route in ["/api/graph/autosave", "/api/graph"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PUT)
                        .uri(route)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(stale_request.clone()))
                        .expect("stale browser graph request"),
                )
                .await
                .expect("stale browser graph response");
            assert_eq!(response.status(), StatusCode::CONFLICT, "{route}");
            let conflict = response_json(response).await;
            assert_eq!(conflict["state_revision"], imported_revision, "{route}");
            assert!(
                conflict["error"]
                    .as_str()
                    .is_some_and(|message| message.contains("graph state conflict")),
                "{route}: {conflict}"
            );
        }

        let saved: Graph = serde_json::from_slice(
            &std::fs::read(graph_path.with_extension("autosave.somite.json"))
                .expect("agent autosave"),
        )
        .expect("agent autosave graph");
        assert_eq!(
            graph_state_revision(&saved).expect("saved state revision"),
            imported_revision
        );
        assert_eq!(saved.nodes[0].operator, "workflow.source");
    }

    #[test]
    fn cpu_profile_counts_physical_cores_and_threads() {
        let fixture = "processor: 0\nmodel name: Example CPU\nphysical id: 0\ncore id: 0\n\nprocessor: 1\nmodel name: Example CPU\nphysical id: 0\ncore id: 0\n\nprocessor: 2\nmodel name: Example CPU\nphysical id: 0\ncore id: 1\n";
        assert_eq!(parse_cpuinfo(fixture), ("Example CPU".to_owned(), 2, 3));
    }

    #[tokio::test]
    async fn system_profile_reports_the_managed_pixi_paper_toolchain_paths() {
        let (temp, mut project) = fixture_project();
        let bin = temp
            .path()
            .join(".somite/tools/paper/.pixi/envs/default/bin");
        std::fs::create_dir_all(&bin).expect("managed Pixi bin directory");
        for name in ["pdftotext", "pdfinfo", "pdftoppm", "tesseract"] {
            let path = executable_candidate(&bin, name);
            write_test_executable(&path, b"#!/bin/sh\nexit 0\n");
        }
        project.paper_tools = PaperToolchainState::detect(temp.path());
        let response = app(project)
            .oneshot(
                Request::builder()
                    .uri("/api/system")
                    .body(Body::empty())
                    .expect("system request"),
            )
            .await
            .expect("system response");
        assert_eq!(response.status(), StatusCode::OK);
        let profile = response_json(response).await;
        assert_eq!(profile["paper_extraction"]["native_pdf_text"], true);
        assert_eq!(profile["paper_extraction"]["scanned_pdf_ocr"], true);
        let tools = profile["paper_extraction"]["tools"]
            .as_array()
            .expect("paper tools");
        assert_eq!(tools.len(), 4);
        assert!(tools.iter().all(|tool| tool["source"] == "managed_pixi"));
        assert!(tools.iter().all(|tool| tool["path"]
            .as_str()
            .is_some_and(|path| path.contains(".somite/tools/paper/.pixi"))));
    }

    #[test]
    fn cached_nfcore_operators_do_not_join_the_production_compile_catalog() {
        let (temp, project) = fixture_project();
        let cache = temp.path().join(".somite/catalog");
        std::fs::create_dir_all(&cache).expect("catalog cache");
        std::fs::write(
            cache.join("nfcore-pipelines.json"),
            r#"{"remote_workflows":[{"name":"demo","description":"Demo","topics":[],"archived":false,"releases":[{"tag_name":"1.2.3"}]}]}"#,
        )
        .expect("catalog fixture");
        let graph = Graph {
            schema_version: somite_ir::SCHEMA_VERSION,
            name: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            annotations: Vec::new(),
            variant_origin: None,
        };
        let (_, catalog, _) = production_inputs(&project, &graph).expect("production inputs");
        assert!(catalog.get("nf.demo").is_err());
    }
}
