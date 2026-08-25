use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axial_bundle::{build_bundle, BundlePlan, ExportTarget};
use axial_cook::{cook_graph, pixi_available, ArtifactMeta, NodeState, Project};
use axial_ir::Graph;
use axial_ops::{current_pixi_platform, Catalog, Operator};
use axial_ops::{nfcore, snakemake, workflow};
use axial_paper::{
    extract_from_path, reconstruct, Assay, CandidateRole, EvidenceStatus, EvidenceTarget,
    ExtractVia,
};
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

mod source_search;

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("{0}")]
    InvalidGraph(#[from] axial_ir::IrError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Catalog(#[from] axial_ops::OpsError),
    #[error("upload did not contain a file")]
    MissingUpload,
    #[error("invalid upload filename")]
    InvalidFilename,
    #[error("upload: {0}")]
    Upload(String),
    #[error("run: {0}")]
    Run(String),
    #[error("paper: {0}")]
    Paper(String),
    #[error("project path is not a readable file: {0}")]
    InvalidProjectPath(String),
    #[error("nf-core catalog: {0}")]
    CatalogDiscovery(String),
    #[error("workflow import: {0}")]
    WorkflowImport(String),
    #[error("source search: {0}")]
    SourceSearch(String),
    #[error("export: {0}")]
    Export(#[from] axial_bundle::BundleError),
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::InvalidGraph(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::MissingUpload | Self::InvalidFilename | Self::InvalidProjectPath(_) => {
                StatusCode::BAD_REQUEST
            }
            Self::Io(_)
            | Self::Json(_)
            | Self::Catalog(_)
            | Self::Upload(_)
            | Self::Run(_)
            | Self::Export(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Paper(_) | Self::WorkflowImport(_) => StatusCode::UNPROCESSABLE_ENTITY,
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
    pub operators: Vec<Operator>,
    pub recovered_autosave: bool,
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
}

#[derive(Debug, Serialize)]
pub struct RunResponse {
    pub states: BTreeMap<String, String>,
    pub artifacts: BTreeMap<String, BTreeMap<String, ArtifactMeta>>,
    pub errors: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct PaperRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct PaperResponse {
    pub extracted_via: String,
    pub candidates: Vec<PaperCandidate>,
}

#[derive(Debug, Serialize)]
pub struct PaperCandidate {
    pub name: String,
    pub role: String,
    pub assay: String,
    pub graph: Graph,
    pub warnings: Vec<String>,
    pub evidence: Vec<PaperEvidence>,
}

#[derive(Debug, Serialize)]
pub struct PaperEvidence {
    pub target_kind: String,
    pub target_id: String,
    pub status: String,
    pub detail: String,
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
    source_search_cache: Mutex<BTreeMap<String, (Instant, Vec<source_search::SearchResult>)>>,
}

impl WebProject {
    pub fn open(
        root: impl Into<PathBuf>,
        graph_path: impl Into<PathBuf>,
    ) -> Result<Self, ServerError> {
        let root = root.into();
        let graph_path = graph_path.into();
        let catalog = Catalog::load_dir(&root.join("operators"))?;
        Ok(Self {
            root,
            graph_path,
            catalog,
            source_search_cache: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn session(&self) -> Result<ProjectSession, ServerError> {
        let recovery_path = self.root.join(".axial/autosave.axial.json");
        let recovered = read_valid_graph(&recovery_path);
        let recovered_autosave = recovered.is_some();
        let mut graph = match recovered {
            Some(graph) => graph,
            None => {
                let raw = std::fs::read_to_string(&self.graph_path)?;
                let graph: Graph = serde_json::from_str(&raw)?;
                graph.validate()?;
                graph
            }
        };
        workflow::upgrade_reference_ports(&mut graph);
        graph.validate()?;
        Ok(ProjectSession {
            project_name: self.project_name(),
            graph_path: display_path(&self.root, &self.graph_path),
            graph,
            operators: self.catalog.ops.values().cloned().collect(),
            recovered_autosave,
        })
    }

    fn project_name(&self) -> String {
        self.root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Axial project")
            .to_owned()
    }

    pub fn save_graph(&self, graph: &Graph) -> Result<(), ServerError> {
        self.save_graph_at(&self.graph_path, graph)?;
        self.save_autosave(graph)
    }

    pub fn save_autosave(&self, graph: &Graph) -> Result<(), ServerError> {
        self.save_graph_at(&self.root.join(".axial/autosave.axial.json"), graph)
    }

    fn save_graph_at(&self, path: &Path, graph: &Graph) -> Result<(), ServerError> {
        graph.validate()?;
        let encoded = serde_json::to_vec_pretty(graph)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("axial.json.tmp");
        std::fs::write(&temporary, encoded)?;
        std::fs::rename(temporary, path)?;
        Ok(())
    }

    fn uploads_dir(&self) -> PathBuf {
        self.root.join(".axial/uploads")
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

fn read_valid_graph(path: &Path) -> Option<Graph> {
    let raw = std::fs::read_to_string(path).ok()?;
    let graph = serde_json::from_str::<Graph>(&raw).ok()?;
    graph.validate().ok()?;
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
    Router::new()
        .route("/api/health", get(health))
        .route("/api/session", get(session))
        .route("/api/system", get(system_profile))
        .route("/api/catalog/nfcore", get(discover_nfcore))
        .route("/api/catalog/nfcore/expand", post(expand_nfcore))
        .route("/api/catalog/snakemake", get(discover_snakemake))
        .route("/api/catalog/snakemake/expand", post(expand_snakemake))
        .route("/api/sources/search", get(search_sources))
        .route("/api/graph", put(save_graph))
        .route("/api/graph/autosave", put(autosave_graph))
        .route("/api/graph/validate", post(validate_graph))
        .route("/api/run", post(run_graph))
        .route("/api/export/plan", post(export_plan))
        .route("/api/export", post(export_bundle))
        .route("/api/paper", post(rebuild_paper))
        .route("/api/files", post(upload_file))
        .layer(DefaultBodyLimit::disable())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(Arc::new(project))
}

async fn health() -> &'static str {
    "ok"
}

async fn session(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<ProjectSession>, ServerError> {
    Ok(Json(project.session()?))
}

async fn system_profile() -> Json<SystemProfile> {
    Json(detect_system_profile())
}

#[derive(Debug, Deserialize)]
struct SourceSearchQuery {
    q: String,
    provider: String,
}

#[derive(Debug, Serialize)]
struct SourceSearchResponse {
    query: String,
    provider: String,
    results: Vec<source_search::SearchResult>,
}

async fn search_sources(
    State(project): State<Arc<WebProject>>,
    Query(request): Query<SourceSearchQuery>,
) -> Result<Json<SourceSearchResponse>, ServerError> {
    let query = request.q.trim();
    if !(2..=120).contains(&query.len())
        || query.chars().any(char::is_control)
        || !matches!(request.provider.as_str(), "ncbi" | "ensembl")
    {
        return Err(ServerError::SourceSearch("invalid query".to_owned()));
    }
    let key = format!("{}:{}", request.provider, query.to_ascii_lowercase());
    if let Some((_, results)) = project
        .source_search_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .filter(|(created, _)| created.elapsed() < Duration::from_secs(600))
        .cloned()
    {
        return Ok(Json(SourceSearchResponse {
            query: query.to_owned(),
            provider: request.provider,
            results,
        }));
    }
    let owned_query = query.to_owned();
    let provider = request.provider.clone();
    let worker_provider = provider.clone();
    let worker_query = owned_query.clone();
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
    Ok(Json(SourceSearchResponse {
        query: owned_query,
        provider,
        results,
    }))
}

async fn discover_nfcore(
    State(project): State<Arc<WebProject>>,
) -> Result<Json<NfcoreCatalogResponse>, ServerError> {
    let cache_path = project.root.join(".axial/catalog/nfcore-pipelines.json");
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
    let cache_path = project.root.join(".axial/catalog/snakemake-workflows.json");
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
    let cache_path = project.root.join(".axial/catalog/snakemake-workflows.json");
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
                "the official catalog could not resolve this workflow's rule graph; Axial will not insert an opaque replacement".to_owned(),
            )
        })?;
        let graph = workflow::graph_from_dot(
            workflow::DotFlavor::Snakemake,
            &request.workflow,
            &request.revision,
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
    let response = tokio::task::spawn_blocking(move || import_nfcore_graph(&root, &request))
        .await
        .map_err(|error| ServerError::WorkflowImport(error.to_string()))??;
    Ok(Json(response))
}

fn import_nfcore_graph(
    root: &Path,
    request: &WorkflowGraphRequest,
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
        .join(".axial/catalog/graphs")
        .join(format!("nfcore-v2-{key}.json"));
    if let Ok(raw) = std::fs::read_to_string(&cache_path) {
        let mut cached: WorkflowGraphResponse = serde_json::from_str(&raw)?;
        cached.cached = true;
        return Ok(cached);
    }
    let nextflow = executable_path("nextflow").ok_or_else(|| {
        ServerError::WorkflowImport(
            "Nextflow is required to resolve this pipeline graph; install it through Axial's Pixi toolchain first".to_owned(),
        )
    })?;
    let work = root.join(".axial/catalog/preview").join(&key);
    std::fs::create_dir_all(&work)?;
    let dot_path = work.join("workflow.dot");
    let _ = std::fs::remove_file(&dot_path);
    let output = Command::new("timeout")
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
        .arg(&dot_path)
        .args(["--outdir", "results"])
        .current_dir(&work)
        .output()?;
    if !output.status.success() || !dot_path.is_file() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Nextflow did not produce a DAG");
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

async fn validate_graph(Json(graph): Json<Graph>) -> Result<Json<ValidationResponse>, ServerError> {
    graph.validate()?;
    Ok(Json(ValidationResponse { valid: true }))
}

async fn save_graph(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<ValidationResponse>, ServerError> {
    project.save_graph(&graph)?;
    Ok(Json(ValidationResponse { valid: true }))
}

async fn autosave_graph(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<ValidationResponse>, ServerError> {
    project.save_autosave(&graph)?;
    Ok(Json(ValidationResponse { valid: true }))
}

async fn run_graph(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<RunResponse>, ServerError> {
    graph.validate()?;
    let root = project.root.clone();
    let mut catalog = project.catalog.clone();
    let report = tokio::task::spawn_blocking(move || {
        install_cached_nfcore(&root, &mut catalog);
        let runtime = Project::open(&root).map_err(ServerError::Io)?;
        cook_graph(&runtime, &catalog, &graph).map_err(|error| ServerError::Run(error.to_string()))
    })
    .await
    .map_err(|error| ServerError::Run(error.to_string()))??;
    let states = report
        .states
        .into_iter()
        .map(|(node, state)| (node, node_state_label(state).to_owned()))
        .collect();
    Ok(Json(RunResponse {
        states,
        artifacts: report.artifacts,
        errors: report.errors,
    }))
}

async fn export_plan(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Json<BundlePlan>, ServerError> {
    let bundle = project_bundle(&project, &graph)?;
    Ok(Json(bundle.plan))
}

async fn export_bundle(
    State(project): State<Arc<WebProject>>,
    Json(graph): Json<Graph>,
) -> Result<Response, ServerError> {
    let bundle = project_bundle(&project, &graph)?;
    let disposition = format!("attachment; filename=\"{}\"", bundle.plan.filename);
    let mut response = Response::new(axum::body::Body::from(bundle.bytes));
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

fn project_bundle(
    project: &WebProject,
    graph: &Graph,
) -> Result<axial_bundle::ExportBundle, ServerError> {
    let mut catalog = project.catalog.clone();
    install_cached_nfcore(&project.root, &mut catalog);
    let target = ExportTarget::new(project.project_name(), current_pixi_platform());
    Ok(build_bundle(graph, &catalog, &target, executable)?)
}

fn install_cached_nfcore(root: &Path, catalog: &mut Catalog) {
    let cache_path = root.join(".axial/catalog/nfcore-pipelines.json");
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

fn node_state_label(state: NodeState) -> &'static str {
    match state {
        NodeState::Cached => "cached",
        NodeState::Done => "done",
        NodeState::Failed => "failed",
        NodeState::Skipped => "skipped",
    }
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
        let reconstruction = reconstruct(&catalog, &extracted.text);
        Ok::<_, ServerError>(PaperResponse {
            extracted_via: extract_via_label(extracted.via).to_owned(),
            candidates: reconstruction
                .candidates
                .into_iter()
                .map(|candidate| PaperCandidate {
                    name: candidate.name,
                    role: candidate_role_label(candidate.role).to_owned(),
                    assay: assay_label(candidate.assay).to_owned(),
                    graph: candidate.graph,
                    warnings: candidate.warnings,
                    evidence: candidate
                        .evidence
                        .into_iter()
                        .map(|evidence| {
                            let (target_kind, target_id) = match evidence.target {
                                EvidenceTarget::Node(id) => ("node", id),
                                EvidenceTarget::Edge(id) => ("edge", id),
                            };
                            PaperEvidence {
                                target_kind: target_kind.to_owned(),
                                target_id,
                                status: evidence_status_label(evidence.status).to_owned(),
                                detail: evidence.detail,
                            }
                        })
                        .collect(),
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| ServerError::Paper(error.to_string()))??;
    Ok(Json(response))
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

fn detect_system_profile() -> SystemProfile {
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
    SystemProfile {
        cpu,
        physical_cores,
        logical_threads,
        memory_bytes,
        gpus,
        os,
        tools: ToolReadiness {
            pixi: pixi_available(),
            sra: executable("prefetch") && executable("fasterq-dump"),
            datasets: executable("datasets"),
            ensembl: executable("curl"),
            nextflow: executable("nextflow"),
            snakemake: executable("snakemake"),
        },
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

fn executable_path(binary: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .as_deref()
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|directory| directory.join(binary))
        .find(|path| path.is_file())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local/bin").join(binary))
                .filter(|path| path.is_file())
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
        let temporary = destination.with_extension("axial-upload-part");
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
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tempfile::TempDir;
    use tower::ServiceExt;

    fn fixture_project() -> (TempDir, WebProject) {
        let temp = TempDir::new().expect("temporary project");
        std::fs::create_dir(temp.path().join("operators")).expect("operator directory");
        let graph_path = temp.path().join("graph.axial.json");
        std::fs::write(&graph_path, r#"{"schema_version":1,"nodes":[],"edges":[]}"#)
            .expect("fixture graph");
        let project = WebProject::open(temp.path(), &graph_path).expect("web project");
        (temp, project)
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
        assert_eq!(session["graph"]["schema_version"], 1);
        assert_eq!(session["graph_path"], "graph.axial.json");
        assert_eq!(session["recovered_autosave"], false);
    }

    #[tokio::test]
    async fn session_recovers_a_valid_autosave() {
        let (temp, project) = fixture_project();
        std::fs::create_dir(temp.path().join(".axial")).expect("recovery directory");
        std::fs::write(
            temp.path().join(".axial/autosave.axial.json"),
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
    async fn run_endpoint_uses_the_native_execution_engine() {
        let (_temp, project) = fixture_project();
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/run")
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
        let report: serde_json::Value = serde_json::from_slice(&body).expect("run report");
        assert_eq!(report["states"], serde_json::json!({}));
        assert_eq!(report["errors"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn export_endpoints_return_a_plan_and_downloadable_zip() {
        let (temp, project) = fixture_project();
        let graph = r#"{"schema_version":1,"nodes":[],"edges":[]}"#;
        let plan_response = app(project)
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
        assert_eq!(plan["platform"], current_pixi_platform());
        assert_eq!(plan["tools"], serde_json::json!([]));

        let graph_path = temp.path().join("graph.axial.json");
        let project = WebProject::open(temp.path(), graph_path).expect("web project");
        let zip_response = app(project)
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
        assert!(disposition.ends_with(".axial.zip\""));
        let zip_body = zip_response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert!(zip_body.starts_with(b"PK"));
    }

    #[tokio::test]
    async fn paper_endpoint_rebuilds_uploaded_methods_with_evidence() {
        let temp = TempDir::new().expect("temporary project");
        let operators = temp.path().join("operators");
        std::fs::create_dir(&operators).expect("operator directory");
        for (filename, id, title) in [
            ("fastqc.json", "qc.fastqc", "FastQC"),
            ("star.json", "align.star", "STAR"),
        ] {
            std::fs::write(
                operators.join(filename),
                format!(r#"{{"id":"{id}","title":"{title}","palette":[],"kind":"external","params":{{}},"ports":{{"in":[],"out":[]}},"argv":[],"outputs":{{}}}}"#),
            )
            .expect("operator schema");
        }
        let graph_path = temp.path().join("graph.axial.json");
        std::fs::write(&graph_path, r#"{"schema_version":1,"nodes":[],"edges":[]}"#)
            .expect("fixture graph");
        let project = WebProject::open(temp.path(), &graph_path).expect("web project");
        let uploads = temp.path().join(".axial/uploads");
        std::fs::create_dir_all(&uploads).expect("uploads directory");
        std::fs::write(
            uploads.join("methods.txt"),
            "RNA-seq reads were assessed with FastQC and aligned using STAR.",
        )
        .expect("methods text");
        let response = app(project)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/paper")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"path":".axial/uploads/methods.txt"}"#))
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
        assert!(review["candidates"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(review["candidates"][0]["evidence"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }

    #[tokio::test]
    async fn invalid_graph_is_rejected_without_overwriting_the_project() {
        let (temp, project) = fixture_project();
        let graph_path = temp.path().join("graph.axial.json");
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
        let boundary = "axial-test-boundary";
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
        assert_eq!(upload["path"], ".axial/uploads/reads.fastq");
        assert_eq!(upload["filename"], "reads.fastq");
        assert_eq!(
            std::fs::read_to_string(temp.path().join(".axial/uploads/reads.fastq"))
                .expect("uploaded file"),
            "@read-1\nACGT\n+\n!!!!\n"
        );
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
        let recovery = std::fs::read_to_string(temp.path().join(".axial/autosave.axial.json"))
            .expect("recovery graph");
        let graph: Graph = serde_json::from_str(&recovery).expect("recovery json");
        assert_eq!(graph.schema_version, 1);
    }

    #[test]
    fn cpu_profile_counts_physical_cores_and_threads() {
        let fixture = "processor: 0\nmodel name: Example CPU\nphysical id: 0\ncore id: 0\n\nprocessor: 1\nmodel name: Example CPU\nphysical id: 0\ncore id: 0\n\nprocessor: 2\nmodel name: Example CPU\nphysical id: 0\ncore id: 1\n";
        assert_eq!(parse_cpuinfo(fixture), ("Example CPU".to_owned(), 2, 3));
    }

    #[test]
    fn cached_nfcore_operators_join_the_native_run_catalog() {
        let temp = TempDir::new().expect("temporary project");
        let cache = temp.path().join(".axial/catalog");
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
