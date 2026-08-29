use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use somite_assessment::{assess, AssessmentState, SupportKind, WorkflowAssessment};
use somite_bundle::{
    absolutize_import_paths, archive_frozen_package, create_frozen_package_with_pixi,
    pixi_executable, plan_frozen_package, BundlePlan, ExportTarget,
};
use somite_fixtures::{bind_representative_fastq, content_digest, FixtureBinding};
use somite_ir::Graph;
use somite_linker::{
    evidence_receipt, graph_state_revision, semantic_graph_revision, EvidenceDraft, EvidenceIndex,
    EvidenceReceipt, EvidenceResult,
};
use somite_ops::{current_pixi_platform, Catalog, Operator};
use somite_ops::{nfcore, snakemake, snakemake_local, workflow};
use somite_paper::{
    extract_from_path, extract_from_path_with_toolchain, reconstruct, resource_citations, Assay,
    CandidateRole, EvidenceStatus, EvidenceTarget, ExtractVia, ExtractionLimits,
    ExtractionProgress, ExtractionToolchain, MethodSupport, PaperError, ReconstructionOutcome,
    ResourceCitationKind, ResourceRole,
};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{watch, Notify, Semaphore};
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

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
    #[error("nf-core catalog: {0}")]
    CatalogDiscovery(String),
    #[error("workflow import: {0}")]
    WorkflowImport(String),
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
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
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
            | Self::InvalidSourceRequest(_)
            | Self::InvalidPaperIntake(_)
            | Self::Literature(
                literature::LiteratureError::InvalidQuery
                | literature::LiteratureError::InvalidPaperId,
            ) => StatusCode::BAD_REQUEST,
            Self::PaperUploadTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
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
            Self::Paper(_) | Self::WorkflowImport(_) => StatusCode::UNPROCESSABLE_ENTITY,
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
pub struct ProjectSession {
    pub project_name: String,
    pub graph_path: String,
    pub graph: Graph,
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

#[derive(Clone, Copy, Debug)]
struct PaperLimits {
    max_upload_bytes: u64,
    max_extracted_text_bytes: u64,
    max_ocr_pages: usize,
    command_timeout: Duration,
    max_active_executions: usize,
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
    graph_lock: Mutex<()>,
    agent: agent::AgentBridge,
    mcp_capability: RuntimeCapability,
    transaction_replays: Mutex<BTreeMap<String, TransactionReplay>>,
    run_replays: Mutex<BTreeMap<String, RunReplay>>,
    paper_intake_replays: Mutex<BTreeMap<String, PaperIntakeReplay>>,
    replay_sequence: AtomicU64,
    sequence: AtomicU64,
    paper_limits: PaperLimits,
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
        let root = root.into();
        let graph_path = graph_path.into();
        let graph_path = if graph_path.is_absolute() {
            graph_path
        } else {
            root.join(graph_path)
        };
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
        Ok(Self {
            root,
            graph_path,
            catalog,
            pixi: pixi_executable(),
            runs: Mutex::new(BTreeMap::new()),
            paper_intakes: Mutex::new(BTreeMap::new()),
            paper_execution,
            graph_lock: Mutex::new(()),
            agent,
            mcp_capability,
            transaction_replays: Mutex::new(BTreeMap::new()),
            run_replays: Mutex::new(BTreeMap::new()),
            paper_intake_replays: Mutex::new(BTreeMap::new()),
            replay_sequence: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
            paper_limits,
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
        let recovery_path = self.autosave_path();
        let recovered = read_valid_graph(&recovery_path, &self.catalog);
        let recovered_autosave = recovered.is_some();
        let mut graph = match recovered {
            Some(graph) => graph,
            None => {
                let raw = std::fs::read_to_string(&self.graph_path)?;
                let mut graph: Graph = serde_json::from_str(&raw)?;
                self.catalog.pin_graph(&mut graph)?;
                graph
            }
        };
        workflow::upgrade_reference_ports(&mut graph);
        graph.validate()?;
        self.catalog.verify_graph(&graph)?;
        let operators = self
            .catalog
            .ops
            .values()
            .map(|operator| {
                Ok(CatalogOperator {
                    revision: operator.revision()?,
                    operator: operator.clone(),
                })
            })
            .collect::<Result<Vec<_>, somite_ops::OpsError>>()?;
        Ok(ProjectSession {
            project_name: self.project_name(),
            graph_path: display_path(&self.root, &self.graph_path),
            graph,
            operators,
            recovered_autosave,
            agent_cursor: self.agent.cursor(),
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

    pub fn save_graph(&self, graph: &Graph) -> Result<(), ServerError> {
        let _guard = self
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.save_graph_at(&self.graph_path, graph)?;
        self.save_graph_at(&self.autosave_path(), graph)
    }

    pub fn save_autosave(&self, graph: &Graph) -> Result<(), ServerError> {
        let _guard = self
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.save_graph_at(&self.autosave_path(), graph)
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
        Self::write_graph_at(path, graph, &self.catalog)
    }

    fn write_graph_at(path: &Path, graph: &Graph, catalog: &Catalog) -> Result<(), ServerError> {
        graph.validate()?;
        catalog.verify_graph(graph)?;
        let encoded = serde_json::to_vec_pretty(graph)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("somite.json.tmp");
        std::fs::write(&temporary, encoded)?;
        std::fs::rename(temporary, path)?;
        Ok(())
    }

    fn uploads_dir(&self) -> PathBuf {
        self.root.join(".somite/uploads")
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

fn read_valid_graph(path: &Path, catalog: &Catalog) -> Option<Graph> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut graph = serde_json::from_str::<Graph>(&raw).ok()?;
    catalog.pin_graph(&mut graph).ok()?;
    Some(graph)
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

pub fn app(project: WebProject) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(HeaderValue::from_static("http://localhost:3000"))
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
        .layer(middleware::from_fn_with_state(
            project.clone(),
            record_mcp_activity,
        ))
        .with_state(project)
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

async fn session(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<ProjectSession>, ServerError> {
    Ok(Json(project.session()?))
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
    let cache_path = project.root.join(".somite/catalog/nfcore-pipelines.json");
    let response = tokio::task::spawn_blocking(move || {
        let (pipelines, cached) = match nfcore::fetch() {
            Ok((raw, pipelines)) => {
                if let Some(parent) = cache_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&cache_path, raw)?;
                (pipelines, false)
            }
            Err(fetch_error) => {
                let raw = std::fs::read_to_string(&cache_path)
                    .map_err(|_| ServerError::CatalogDiscovery(fetch_error))?;
                let pipelines = nfcore::parse(&raw).map_err(ServerError::CatalogDiscovery)?;
                (pipelines, true)
            }
        };
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
    if !request.workflow.starts_with("nf-core/")
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
    let root = project.root.clone();
    let reference_operator_revision = project.catalog.revision("workflow.reference")?;
    let response = tokio::task::spawn_blocking(move || {
        import_nfcore_graph(&root, &request, &reference_operator_revision)
    })
    .await
    .map_err(|error| ServerError::WorkflowImport(error.to_string()))??;
    Ok(Json(response))
}

fn import_nfcore_graph(
    root: &Path,
    request: &WorkflowGraphRequest,
    reference_operator_revision: &str,
) -> Result<WorkflowGraphResponse, ServerError> {
    let key = format!(
        "{}-{}",
        request
            .workflow
            .trim_start_matches("nf-core/")
            .replace('_', "-"),
        request.revision
    );
    let cache_path = root
        .join(".somite/catalog/graphs")
        .join(format!("nfcore-v2-{key}.json"));
    if let Ok(raw) = std::fs::read_to_string(&cache_path) {
        let mut cached: WorkflowGraphResponse = serde_json::from_str(&raw)?;
        if cached.graph.schema_version == somite_ir::LEGACY_SCHEMA_VERSION {
            cached.graph.schema_version = somite_ir::SCHEMA_VERSION;
            for node in &mut cached.graph.nodes {
                node.operator_revision = reference_operator_revision.to_owned();
            }
        }
        cached.graph.validate()?;
        cached.cached = true;
        return Ok(cached);
    }
    let nextflow = executable_path("nextflow").ok_or_else(|| {
        ServerError::WorkflowImport(
            "Nextflow is required to resolve this pipeline graph; install it through Somite's Pixi toolchain first".to_owned(),
        )
    })?;
    let work = root.join(".somite/catalog/preview").join(&key);
    std::fs::create_dir_all(&work)?;
    let dot_path = work.join("workflow.dot");
    let output = run_nfcore_preview(&nextflow, &work, request, &dot_path)?;
    if !output.status.success() || !dot_path.is_file() {
        let detail = nfcore_preview_failure_detail(&work, &output);
        return Err(ServerError::WorkflowImport(format!(
            "{}@{} could not be previewed: {detail}",
            request.workflow, request.revision
        )));
    }
    let dot = std::fs::read_to_string(dot_path)?;
    let graph = workflow::graph_from_dot(
        workflow::DotFlavor::Nextflow,
        &request.workflow,
        &request.revision,
        reference_operator_revision,
        &dot,
    )
    .map_err(ServerError::WorkflowImport)?;
    let response = WorkflowGraphResponse {
        engine: "nextflow".to_owned(),
        workflow: request.workflow.clone(),
        revision: request.revision.clone(),
        graph,
        cached: false,
    };
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(cache_path, serde_json::to_vec_pretty(&response)?)?;
    Ok(response)
}

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

fn remove_preview_artifact(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

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

fn nfcore_preview_failure_evidence(work: &Path, output: &std::process::Output) -> String {
    let log = std::fs::read_to_string(work.join(".nextflow.log")).unwrap_or_default();
    format!(
        "{}\n{}\n{log}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

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
    Json(mut graph): Json<Graph>,
) -> Result<Json<ValidationResponse>, ServerError> {
    project.catalog.pin_graph(&mut graph)?;
    Ok(Json(ValidationResponse { valid: true }))
}

async fn readiness_snapshot(
    State(project): State<Arc<WebProject>>,
    Json(mut graph): Json<Graph>,
) -> Result<Json<WorkflowAssessment>, ServerError> {
    let mut catalog = project.catalog.clone();
    install_cached_nfcore(&project.root, &mut catalog);
    catalog.pin_graph(&mut graph)?;
    Ok(Json(assess(&graph, &catalog)?))
}

async fn save_graph(
    State(project): State<Arc<WebProject>>,
    Json(mut graph): Json<Graph>,
) -> Result<Json<ValidationResponse>, ServerError> {
    project.catalog.pin_graph(&mut graph)?;
    project.save_graph(&graph)?;
    Ok(Json(ValidationResponse { valid: true }))
}

async fn autosave_graph(
    State(project): State<Arc<WebProject>>,
    Json(mut graph): Json<Graph>,
) -> Result<Json<ValidationResponse>, ServerError> {
    project.catalog.pin_graph(&mut graph)?;
    project.save_autosave(&graph)?;
    Ok(Json(ValidationResponse { valid: true }))
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
    let graph = current_agent_graph(&project)?;
    let state_revision = graph_state_revision(&graph)?;
    let graph_revision = semantic_graph_revision(&graph)?;
    Ok(Json(AgentGraphResponse {
        state_revision,
        graph_revision,
        graph,
    }))
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
    let mut catalog = project.catalog.clone();
    install_cached_nfcore(&project.root, &mut catalog);
    let catalog_revision = catalog.catalog_revision()?;
    let offset = catalog_cursor_offset(request.cursor.as_deref(), &catalog_revision)?;
    let mut matches = catalog
        .ops
        .values()
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
            let mut catalog = project.catalog.clone();
            install_cached_nfcore(&project.root, &mut catalog);
            let result = agent::apply_graph_transaction(
                &graph,
                &catalog,
                request,
                project.next_id("transaction"),
            )?;
            WebProject::write_graph_at(&project.autosave_path(), &result.graph, &catalog)?;
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
    graph: Graph,
}

async fn agent_prompt(
    State(project): State<Arc<WebProject>>,
    Json(mut request): Json<AgentPromptRequest>,
) -> Result<StatusCode, ServerError> {
    let mut catalog = project.catalog.clone();
    install_cached_nfcore(&project.root, &mut catalog);
    catalog.pin_graph(&mut request.graph)?;
    {
        let _guard = project
            .graph_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        WebProject::write_graph_at(&project.autosave_path(), &request.graph, &catalog)?;
    }
    project.agent.prompt(request.message).await?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct AgentEventsQuery {
    #[serde(default)]
    after: u64,
}

async fn agent_events(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<AgentEventsQuery>,
) -> Json<AgentSnapshot> {
    Json(project.agent.snapshot_after(request.after))
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

fn current_agent_graph(project: &WebProject) -> Result<Graph, ServerError> {
    let recovery_path = project.autosave_path();
    let mut catalog = project.catalog.clone();
    install_cached_nfcore(&project.root, &mut catalog);
    let mut graph = if let Some(graph) = read_valid_graph(&recovery_path, &catalog) {
        graph
    } else {
        let raw = std::fs::read_to_string(&project.graph_path)?;
        serde_json::from_str::<Graph>(&raw)?
    };
    catalog.pin_graph(&mut graph)?;
    workflow::upgrade_reference_ports(&mut graph);
    graph.validate()?;
    catalog.verify_graph(&graph)?;
    Ok(graph)
}

async fn start_run(
    State(project): State<Arc<WebProject>>,
    Query(query): Query<RunStartQuery>,
    Json(graph): Json<Graph>,
) -> Result<(StatusCode, Json<RunStartResponse>), ServerError> {
    let request_digest = content_digest(&serde_json::to_vec(&("run", &graph))?);
    let (graph, catalog, target) = production_inputs(&project, &graph)?;
    require_ready(&graph, &catalog)?;
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
    let mut readiness_catalog = project.catalog.clone();
    install_cached_nfcore(&project.root, &mut readiness_catalog);
    let mut readiness_graph = graph.clone();
    readiness_catalog.pin_graph(&mut readiness_graph)?;
    require_ready(&readiness_graph, &readiness_catalog)?;
    let (graph, catalog, target, validation) = validation_inputs(&project, &graph)?;
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
        _ => format!(
            "resolve {} required item{}; inspect /api/readiness or somite.readiness.get",
            snapshot.required_count,
            if snapshot.required_count == 1 {
                ""
            } else {
                "s"
            }
        ),
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
    let (graph, catalog, target) = production_inputs(&project, &graph)?;
    Ok(Json(plan_frozen_package(
        &graph, &catalog, &target, executable,
    )?))
}

async fn export_bundle(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Response, ServerError> {
    let (graph, catalog, target) = production_inputs(&project, &graph)?;
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
    install_cached_nfcore(&project.root, &mut catalog);
    let mut graph = graph.clone();
    catalog.pin_graph(&mut graph)?;
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
    install_cached_nfcore(&project.root, &mut catalog);
    let mut source_graph = graph.clone();
    catalog.pin_graph(&mut source_graph)?;
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

fn install_cached_nfcore(root: &Path, catalog: &mut Catalog) {
    let cache_path = root.join(".somite/catalog/nfcore-pipelines.json");
    let Some(pipelines) = std::fs::read_to_string(cache_path)
        .ok()
        .and_then(|raw| nfcore::parse(&raw).ok())
    else {
        return;
    };
    for pipeline in pipelines {
        catalog
            .ops
            .entry(pipeline.operator_id())
            .or_insert_with(|| pipeline.operator());
    }
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
        let uploads = project.uploads_dir();
        tokio::fs::create_dir_all(&uploads).await?;
        let destination = available_destination(&uploads, &filename).await?;
        let temporary = destination.with_extension("somite-upload-part");
        let mut output = tokio::fs::File::create(&temporary).await?;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|error| ServerError::Upload(error.to_string()))?
        {
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        drop(output);
        tokio::fs::rename(&temporary, &destination).await?;
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

async fn available_destination(directory: &Path, filename: &str) -> Result<PathBuf, ServerError> {
    let initial = directory.join(filename);
    if !tokio::fs::try_exists(&initial).await? {
        return Ok(initial);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("upload");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 2..=10_000 {
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem}-{index}.{extension}")),
            None => directory.join(format!("{stem}-{index}")),
        };
        if !tokio::fs::try_exists(&candidate).await? {
            return Ok(candidate);
        }
    }
    Err(ServerError::Upload(format!(
        "could not allocate a unique name for {filename}"
    )))
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
        assert_eq!(session["graph"]["schema_version"], 2);
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
        let graph = r#"{"schema_version":1,"name":"RNA seq review","nodes":[],"edges":[]}"#;
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
        assert_eq!(plan["tools"], serde_json::json!([]));

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
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/graph")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"schema_version":99,"nodes":[],"edges":[]}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(std::fs::read_to_string(graph_path).expect("after"), before);
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
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/graph/autosave")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"schema_version":1,"nodes":[],"edges":[]}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let recovery =
            std::fs::read_to_string(temp.path().join("graph.somite.autosave.somite.json"))
                .expect("recovery graph");
        let graph: Graph = serde_json::from_str(&recovery).expect("recovery json");
        assert_eq!(graph.schema_version, 2);
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
    fn cached_nfcore_operators_join_the_production_compile_catalog() {
        let temp = TempDir::new().expect("temporary project");
        let cache = temp.path().join(".somite/catalog");
        std::fs::create_dir_all(&cache).expect("catalog cache");
        std::fs::write(
            cache.join("nfcore-pipelines.json"),
            r#"{"remote_workflows":[{"name":"demo","description":"Demo","topics":[],"archived":false,"releases":[{"tag_name":"1.2.3"}]}]}"#,
        )
        .expect("catalog fixture");
        let mut catalog = Catalog::default();
        install_cached_nfcore(temp.path(), &mut catalog);
        let operator = catalog.get("nf.demo").expect("generated operator");
        assert_eq!(operator.argv[2], "nf-core/demo");
        assert_eq!(operator.argv[4], "{param.revision}");
    }
}
