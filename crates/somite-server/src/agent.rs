use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{
    BooleanConfigOptionCapabilities, CancelNotification, ClientCapabilities,
    ClientSessionCapabilities, ContentBlock, ContentChunk, EnvVariable, Implementation,
    InitializeRequest, McpServer, McpServerStdio, NewSessionRequest, PermissionOptionKind,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigOption, SessionConfigOptionValue,
    SessionConfigOptionsCapabilities, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo, SessionMessage};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use somite_ir::{Edge, Graph, Layout, Node, ParamValue};
use somite_linker::{graph_state_revision, semantic_graph_revision};
use somite_ops::Catalog;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

const EVENT_LIMIT: usize = 4_096;
const MAX_OPERATIONS: usize = 64;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const WORKFLOW_AGENT_CONTRACT: &str = r#"You are the Workflow Agent embedded in Somite. The current Somite canvas is the work product.

Work through the Somite MCP tools immediately. Do not inspect or modify the Somite repository, run shell commands, read project files directly, or create workflow JSON by hand. Do not use developer tools to discover capabilities that Somite already exposes.

Begin by inspecting the current workflow. Search exact catalog contracts instead of inventing operator ids, ports, parameters, or revisions. Use short single-concept catalog queries; issue independent queries in one parallel batch. When current NCBI or Ensembl data is relevant, use Somite source search before leaving the application. If a source result includes ordered operator_ids, treat them as Somite's native source recipe and search those exact ids. A local file or Directory input is a user/project resource, not an NCBI or Ensembl research query.

Generic web research is allowed only when the request genuinely requires current external evidence that no Somite tool can provide. Prefer authoritative primary sources, state what was learned, and return immediately to the Somite tools. Never use generic web research to inspect Somite's repository or operator contracts.

Before editing, identify every required non-optional input in the selected contracts. Apply a small coherent canvas transaction as soon as the available information supports one. Do not ask for confirmation before ordinary reversible canvas edits. After editing, call Somite readiness and use its typed requirements and resolutions instead of rediscovering missing inputs yourself. If a required local resource such as a database Directory has no user-supplied path, build only a scientifically useful partial graph, report the exact readiness item, and do not compile or start validation. Ask one concise question only when a missing scientific choice would materially change the valid graph and Somite cannot represent a safe useful subset first. If a required reviewed contract is missing, report the exact MCP-visible blocker; do not work around it by editing the repository. A representative-validation rejection for an unsupported source family is a blocker, not a reason to replace a scientifically correct source operator. Start validation only when readiness is clear. Never claim a workflow is runnable unless validation completed successfully.

Do not narrate a plan before the first relevant Somite tool call. Keep the final response short and centered on canvas changes, exact blockers, revisions, and validation evidence.

User request:"#;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent command must not be empty")]
    EmptyCommand,
    #[error("agent command is too long or contains control characters")]
    InvalidCommand,
    #[error("agent is already connected")]
    AlreadyConnected,
    #[error("agent is not connected")]
    NotConnected,
    #[error("agent is still working")]
    Busy,
    #[error("prompt must contain between 1 and {MAX_PROMPT_BYTES} bytes")]
    InvalidPrompt,
    #[error("invalid agent configuration option")]
    InvalidConfigOption,
    #[error("agent configuration: {0}")]
    Config(String),
    #[error("agent launch: {0}")]
    Launch(String),
    #[error("transaction base {actual} is stale; current state revision is {expected}")]
    StaleTransaction { actual: String, expected: String },
    #[error(
        "idempotency key must contain 8 to 128 ASCII letters, numbers, hyphens, or underscores"
    )]
    InvalidIdempotencyKey,
    #[error("idempotency key was already used for a different request")]
    IdempotencyConflict,
    #[error("transaction must contain between 1 and {MAX_OPERATIONS} operations")]
    InvalidOperationCount,
    #[error("transaction summary must contain between 1 and 240 characters")]
    InvalidSummary,
    #[error("invalid identifier: {0}")]
    InvalidIdentifier(String),
    #[error("node not found: {0}")]
    NodeNotFound(String),
    #[error("edge not found: {0}")]
    EdgeNotFound(String),
    #[error("parameter {parameter} is not declared by operator {operator}")]
    UnknownParameter { operator: String, parameter: String },
    #[error("parameter {parameter} for operator {operator} expects {expected}")]
    ParameterType {
        operator: String,
        parameter: String,
        expected: String,
    },
    #[error("parameter {parameter} for operator {operator} is outside its declared bounds")]
    ParameterBounds { operator: String, parameter: String },
    #[error("invalid note")]
    InvalidNote,
    #[error("operator catalog: {0}")]
    Catalog(#[from] somite_ops::OpsError),
    #[error("graph: {0}")]
    Graph(#[from] somite_ir::IrError),
    #[error("graph identity: {0}")]
    Identity(#[from] somite_linker::LinkError),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphTransaction {
    /// Full state revision returned by `somite.workflow.get`. Stale transactions are rejected.
    pub base_state_revision: String,
    /// Client-generated replay key. Reusing it with the same request returns the original result.
    pub idempotency_key: String,
    /// Short user-facing description shown in the activity feed and undo history.
    pub summary: String,
    /// Operations applied atomically in order. Any invalid operation rejects all of them.
    pub operations: Vec<GraphOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GraphOperation {
    AddOperator {
        node_id: String,
        operator_id: String,
        #[serde(default)]
        params: BTreeMap<String, Value>,
        #[serde(default)]
        x: f32,
        #[serde(default)]
        y: f32,
        #[serde(default)]
        note: Option<String>,
    },
    RemoveNode {
        node_id: String,
    },
    SetParam {
        node_id: String,
        parameter: String,
        value: Value,
    },
    UnsetParam {
        node_id: String,
        parameter: String,
    },
    Connect {
        edge_id: String,
        from_node: String,
        from_port: String,
        to_node: String,
        to_port: String,
    },
    Disconnect {
        edge_id: String,
    },
    SetNote {
        node_id: String,
        note: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionResult {
    pub transaction_id: String,
    pub previous_state_revision: String,
    pub state_revision: String,
    pub graph_revision: String,
    pub summary: String,
    pub graph: Graph,
}

pub fn apply_graph_transaction(
    graph: &Graph,
    catalog: &Catalog,
    request: GraphTransaction,
    transaction_id: String,
) -> Result<TransactionResult, AgentError> {
    let previous_state_revision = graph_state_revision(graph)?;
    if !valid_idempotency_key(&request.idempotency_key) {
        return Err(AgentError::InvalidIdempotencyKey);
    }
    if request.base_state_revision != previous_state_revision {
        return Err(AgentError::StaleTransaction {
            actual: request.base_state_revision,
            expected: previous_state_revision,
        });
    }
    let summary = request.summary.trim();
    if summary.is_empty() || summary.chars().count() > 240 || summary.chars().any(char::is_control)
    {
        return Err(AgentError::InvalidSummary);
    }
    if request.operations.is_empty() || request.operations.len() > MAX_OPERATIONS {
        return Err(AgentError::InvalidOperationCount);
    }

    let mut candidate = graph.clone();
    for operation in request.operations {
        apply_operation(&mut candidate, catalog, operation)?;
    }
    candidate.validate()?;
    catalog.verify_graph(&candidate)?;
    let state_revision = graph_state_revision(&candidate)?;
    let graph_revision = semantic_graph_revision(&candidate)?;
    Ok(TransactionResult {
        transaction_id,
        previous_state_revision,
        state_revision,
        graph_revision,
        summary: summary.to_owned(),
        graph: candidate,
    })
}

pub(crate) fn valid_idempotency_key(key: &str) -> bool {
    (8..=128).contains(&key.len())
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn apply_operation(
    graph: &mut Graph,
    catalog: &Catalog,
    operation: GraphOperation,
) -> Result<(), AgentError> {
    match operation {
        GraphOperation::AddOperator {
            node_id,
            operator_id,
            params,
            x,
            y,
            note,
        } => {
            valid_identifier(&node_id)?;
            if !x.is_finite() || !y.is_finite() {
                return Err(AgentError::InvalidIdentifier(
                    "non-finite layout".to_owned(),
                ));
            }
            valid_note(&note)?;
            if graph.nodes.iter().any(|node| node.id == node_id)
                || graph.edges.iter().any(|edge| edge.id == node_id)
            {
                return Err(AgentError::InvalidIdentifier(node_id));
            }
            let operator = catalog.get(&operator_id)?;
            let mut bound = operator
                .params
                .iter()
                .filter_map(|(name, spec)| spec.default.clone().map(|value| (name.clone(), value)))
                .collect::<BTreeMap<_, _>>();
            for (name, value) in params {
                let spec =
                    operator
                        .params
                        .get(&name)
                        .ok_or_else(|| AgentError::UnknownParameter {
                            operator: operator_id.clone(),
                            parameter: name.clone(),
                        })?;
                bound.insert(
                    name.clone(),
                    checked_param(&operator_id, &name, spec, value)?,
                );
            }
            graph.nodes.push(Node {
                id: node_id,
                operator: operator_id,
                operator_revision: operator.revision()?,
                ports: operator.ir_ports(),
                params: bound,
                layout: Layout { x, y },
                note,
                color: None,
            });
        }
        GraphOperation::RemoveNode { node_id } => {
            let before = graph.nodes.len();
            graph.nodes.retain(|node| node.id != node_id);
            if before == graph.nodes.len() {
                return Err(AgentError::NodeNotFound(node_id));
            }
            graph
                .edges
                .retain(|edge| edge.from_node != node_id && edge.to_node != node_id);
        }
        GraphOperation::SetParam {
            node_id,
            parameter,
            value,
        } => {
            let node = graph
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .ok_or_else(|| AgentError::NodeNotFound(node_id.clone()))?;
            let operator = catalog.get(&node.operator)?;
            let spec =
                operator
                    .params
                    .get(&parameter)
                    .ok_or_else(|| AgentError::UnknownParameter {
                        operator: node.operator.clone(),
                        parameter: parameter.clone(),
                    })?;
            let value = checked_param(&node.operator, &parameter, spec, value)?;
            node.params.insert(parameter, value);
        }
        GraphOperation::UnsetParam { node_id, parameter } => {
            let node = graph
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .ok_or_else(|| AgentError::NodeNotFound(node_id.clone()))?;
            let operator = catalog.get(&node.operator)?;
            let spec =
                operator
                    .params
                    .get(&parameter)
                    .ok_or_else(|| AgentError::UnknownParameter {
                        operator: node.operator.clone(),
                        parameter: parameter.clone(),
                    })?;
            if spec.required && spec.default.is_none() {
                return Err(AgentError::ParameterType {
                    operator: node.operator.clone(),
                    parameter,
                    expected: "a required value".to_owned(),
                });
            }
            node.params.remove(&parameter);
            if let Some(default) = &spec.default {
                node.params.insert(parameter, default.clone());
            }
        }
        GraphOperation::Connect {
            edge_id,
            from_node,
            from_port,
            to_node,
            to_port,
        } => {
            valid_identifier(&edge_id)?;
            for id in [&from_node, &from_port, &to_node, &to_port] {
                valid_identifier(id)?;
            }
            if graph.edges.iter().any(|edge| edge.id == edge_id)
                || graph.nodes.iter().any(|node| node.id == edge_id)
            {
                return Err(AgentError::InvalidIdentifier(edge_id));
            }
            graph.edges.push(Edge {
                id: edge_id,
                from_node,
                from_port,
                to_node,
                to_port,
            });
        }
        GraphOperation::Disconnect { edge_id } => {
            let before = graph.edges.len();
            graph.edges.retain(|edge| edge.id != edge_id);
            if before == graph.edges.len() {
                return Err(AgentError::EdgeNotFound(edge_id));
            }
        }
        GraphOperation::SetNote { node_id, note } => {
            valid_note(&note)?;
            let node = graph
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .ok_or(AgentError::NodeNotFound(node_id))?;
            node.note = note;
        }
    }
    Ok(())
}

fn checked_param(
    operator: &str,
    parameter: &str,
    spec: &somite_ops::ParamSpec,
    value: Value,
) -> Result<ParamValue, AgentError> {
    let converted = match spec.ty.as_str() {
        "string" => value
            .as_str()
            .map(|value| ParamValue::String(value.to_owned())),
        "bool" => value.as_bool().map(ParamValue::Bool),
        "int" => value.as_i64().map(ParamValue::Int),
        "float" => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(ParamValue::Float),
        _ => None,
    }
    .ok_or_else(|| AgentError::ParameterType {
        operator: operator.to_owned(),
        parameter: parameter.to_owned(),
        expected: spec.ty.clone(),
    })?;
    let outside_bounds = match &converted {
        ParamValue::Int(value) => {
            spec.min.is_some_and(|minimum| *value < minimum)
                || spec.max.is_some_and(|maximum| *value > maximum)
        }
        ParamValue::Float(value) => {
            spec.min.is_some_and(|minimum| *value < minimum as f64)
                || spec.max.is_some_and(|maximum| *value > maximum as f64)
        }
        _ => false,
    };
    if outside_bounds {
        return Err(AgentError::ParameterBounds {
            operator: operator.to_owned(),
            parameter: parameter.to_owned(),
        });
    }
    Ok(converted)
}

fn valid_identifier(value: &str) -> Result<(), AgentError> {
    if value.is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err(AgentError::InvalidIdentifier(value.to_owned()));
    }
    Ok(())
}

fn valid_note(note: &Option<String>) -> Result<(), AgentError> {
    if note.as_ref().is_some_and(|value| {
        value.len() > 4_096 || value.chars().any(|character| character == '\0')
    }) {
        return Err(AgentError::InvalidNote);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventKind {
    Status,
    User,
    Message,
    Tool,
    Transaction,
    Permission,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionChoice {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentConfigValue {
    Select(String),
    Boolean(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub cursor: u64,
    pub recorded_at_unix_ms: u64,
    pub kind: AgentEventKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<TransactionResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permission_choices: Vec<PermissionChoice>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSnapshot {
    pub connected: bool,
    pub connecting: bool,
    pub busy: bool,
    pub agent_name: Option<String>,
    pub config_options: Vec<SessionConfigOption>,
    pub cursor: u64,
    pub events: Vec<AgentEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTranscriptMessage {
    pub role: String,
    pub text: String,
    pub cursor_start: u64,
    pub cursor_end: u64,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTranscriptPermission {
    pub permission_id: String,
    pub title: String,
    pub detail: String,
    pub choices: Vec<PermissionChoice>,
    pub recorded_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTranscriptToolCall {
    pub tool_call_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    pub statuses: Vec<String>,
    pub permissions: Vec<AgentTranscriptPermission>,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTranscript {
    pub schema_version: u32,
    pub agent_name: Option<String>,
    pub config_options: Vec<SessionConfigOption>,
    pub cursor_start: u64,
    pub cursor_end: u64,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: u64,
    pub raw_event_count: usize,
    pub messages: Vec<AgentTranscriptMessage>,
    pub tool_calls: Vec<AgentTranscriptToolCall>,
    pub transactions: Vec<TransactionResult>,
    pub activity: Vec<AgentEvent>,
}

#[derive(Debug, Default)]
struct BridgeState {
    connected: bool,
    connecting: bool,
    busy: bool,
    agent_name: Option<String>,
    config_options: Vec<SessionConfigOption>,
    cursor: u64,
    events: VecDeque<AgentEvent>,
}

#[derive(Debug)]
enum AgentCommand {
    Prompt(String),
    SetConfig {
        config_id: String,
        value: SessionConfigOptionValue,
        response: oneshot::Sender<Result<(), String>>,
    },
    Cancel,
    Shutdown,
}

#[derive(Debug, Default)]
struct RuntimeControl {
    generation: u64,
    sender: Option<mpsc::UnboundedSender<AgentCommand>>,
}

struct PendingPermission {
    sender: oneshot::Sender<Option<String>>,
    option_ids: BTreeSet<String>,
}

type PermissionWaiters = BTreeMap<String, PendingPermission>;

struct AgentRuntimeContext {
    state: Arc<Mutex<BridgeState>>,
    permissions: Arc<tokio::sync::Mutex<PermissionWaiters>>,
    permission_sequence: Arc<AtomicU64>,
    project_root: PathBuf,
    server_url: String,
    mcp_command: PathBuf,
    mcp_capability: String,
}

pub struct AgentBridge {
    state: Arc<Mutex<BridgeState>>,
    runtime: Arc<tokio::sync::Mutex<RuntimeControl>>,
    permissions: Arc<tokio::sync::Mutex<PermissionWaiters>>,
    sequence: AtomicU64,
    permission_sequence: Arc<AtomicU64>,
    project_root: PathBuf,
    server_url: String,
    mcp_command: PathBuf,
    mcp_capability: String,
}

impl std::fmt::Debug for AgentBridge {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentBridge")
            .field("project_root", &self.project_root)
            .field("server_url", &self.server_url)
            .field("mcp_command", &self.mcp_command)
            .finish_non_exhaustive()
    }
}

impl AgentBridge {
    pub fn new(
        project_root: PathBuf,
        server_url: String,
        mcp_command: PathBuf,
        mcp_capability: String,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(BridgeState::default())),
            runtime: Arc::new(tokio::sync::Mutex::new(RuntimeControl::default())),
            permissions: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            sequence: AtomicU64::new(1),
            permission_sequence: Arc::new(AtomicU64::new(1)),
            project_root,
            server_url,
            mcp_command,
            mcp_capability,
        }
    }

    pub fn cursor(&self) -> u64 {
        self.state.lock().expect("agent state").cursor
    }

    pub fn snapshot_after(&self, after: u64) -> AgentSnapshot {
        let state = self.state.lock().expect("agent state");
        AgentSnapshot {
            connected: state.connected,
            connecting: state.connecting,
            busy: state.busy,
            agent_name: state.agent_name.clone(),
            config_options: state.config_options.clone(),
            cursor: state.cursor,
            events: state
                .events
                .iter()
                .filter(|event| event.cursor > after)
                .cloned()
                .collect(),
        }
    }

    pub fn transcript(&self) -> AgentTranscript {
        build_transcript(&self.state.lock().expect("agent state"))
    }

    pub fn record_transaction(&self, transaction: TransactionResult) {
        push_event(
            &self.state,
            AgentEventKind::Transaction,
            transaction.summary.clone(),
            format!(
                "{} → {}",
                transaction.previous_state_revision, transaction.state_revision
            ),
            Some("completed".to_owned()),
            Some(transaction),
            None,
            Vec::new(),
        );
    }

    pub fn record_tool_activity(&self, tool: String, detail: String, status: String) {
        push_event(
            &self.state,
            AgentEventKind::Tool,
            tool,
            detail,
            Some(status),
            None,
            None,
            Vec::new(),
        );
    }

    pub async fn connect(&self, command: String) -> Result<AgentSnapshot, AgentError> {
        let command = command.trim();
        if command.is_empty() {
            return Err(AgentError::EmptyCommand);
        }
        if command.len() > 4_096 || command.chars().any(char::is_control) {
            return Err(AgentError::InvalidCommand);
        }
        let agent =
            AcpAgent::from_str(command).map_err(|error| AgentError::Launch(error.to_string()))?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let generation = self.sequence.fetch_add(1, Ordering::Relaxed);
        {
            let mut runtime = self.runtime.lock().await;
            if runtime.sender.is_some() {
                return Err(AgentError::AlreadyConnected);
            }
            runtime.generation = generation;
            runtime.sender = Some(sender);
        }
        {
            let mut state = self.state.lock().expect("agent state");
            state.connecting = true;
            state.connected = false;
            state.busy = false;
            state.agent_name = None;
        }
        push_event(
            &self.state,
            AgentEventKind::Status,
            "Connecting ACP agent".to_owned(),
            "Somite is initializing the user-provided process.".to_owned(),
            Some("connecting".to_owned()),
            None,
            None,
            Vec::new(),
        );

        let state = self.state.clone();
        let runtime = self.runtime.clone();
        let permissions = self.permissions.clone();
        let permission_sequence = self.permission_sequence.clone();
        let project_root = self.project_root.clone();
        let server_url = self.server_url.clone();
        let mcp_command = self.mcp_command.clone();
        let mcp_capability = self.mcp_capability.clone();
        tokio::spawn(async move {
            let result = run_agent(
                agent,
                receiver,
                AgentRuntimeContext {
                    state: state.clone(),
                    permissions: permissions.clone(),
                    permission_sequence,
                    project_root,
                    server_url,
                    mcp_command,
                    mcp_capability,
                },
            )
            .await;
            match result {
                Err(error) => push_event(
                    &state,
                    AgentEventKind::Error,
                    "ACP agent stopped".to_owned(),
                    error,
                    Some("failed".to_owned()),
                    None,
                    None,
                    Vec::new(),
                ),
                Ok(()) => push_event(
                    &state,
                    AgentEventKind::Status,
                    "ACP agent disconnected".to_owned(),
                    "The canvas and Somite tools remain available.".to_owned(),
                    Some("disconnected".to_owned()),
                    None,
                    None,
                    Vec::new(),
                ),
            }
            {
                let mut current = state.lock().expect("agent state");
                current.connecting = false;
                current.connected = false;
                current.busy = false;
                current.agent_name = None;
                current.config_options.clear();
            }
            let mut runtime = runtime.lock().await;
            if runtime.generation == generation {
                runtime.sender = None;
            }
        });
        Ok(self.snapshot_after(0))
    }

    pub async fn prompt(&self, prompt: String) -> Result<(), AgentError> {
        let prompt = prompt.trim();
        if prompt.is_empty() || prompt.len() > MAX_PROMPT_BYTES {
            return Err(AgentError::InvalidPrompt);
        }
        {
            let mut state = self.state.lock().expect("agent state");
            if !state.connected {
                return Err(AgentError::NotConnected);
            }
            if state.busy {
                return Err(AgentError::Busy);
            }
            state.busy = true;
        }
        let sender = self.runtime.lock().await.sender.clone().ok_or_else(|| {
            self.state.lock().expect("agent state").busy = false;
            AgentError::NotConnected
        })?;
        if sender
            .send(AgentCommand::Prompt(workflow_agent_prompt(prompt)))
            .is_err()
        {
            self.state.lock().expect("agent state").busy = false;
            return Err(AgentError::NotConnected);
        }
        push_event(
            &self.state,
            AgentEventKind::User,
            "You".to_owned(),
            prompt.to_owned(),
            None,
            None,
            None,
            Vec::new(),
        );
        Ok(())
    }

    pub async fn set_config(
        &self,
        config_id: String,
        value: AgentConfigValue,
    ) -> Result<AgentSnapshot, AgentError> {
        valid_identifier(&config_id)?;
        let value = match value {
            AgentConfigValue::Select(value) if !value.is_empty() && value.len() <= 512 => {
                SessionConfigOptionValue::from(value.as_str())
            }
            AgentConfigValue::Boolean(value) => SessionConfigOptionValue::from(value),
            AgentConfigValue::Select(_) => return Err(AgentError::InvalidConfigOption),
        };
        {
            let state = self.state.lock().expect("agent state");
            if !state.connected {
                return Err(AgentError::NotConnected);
            }
            if state.busy {
                return Err(AgentError::Busy);
            }
            if !state
                .config_options
                .iter()
                .any(|option| option.id.to_string() == config_id)
            {
                return Err(AgentError::InvalidConfigOption);
            }
        }
        let sender = self
            .runtime
            .lock()
            .await
            .sender
            .clone()
            .ok_or(AgentError::NotConnected)?;
        let (response, receiver) = oneshot::channel();
        sender
            .send(AgentCommand::SetConfig {
                config_id,
                value,
                response,
            })
            .map_err(|_| AgentError::NotConnected)?;
        receiver
            .await
            .map_err(|_| AgentError::NotConnected)?
            .map_err(AgentError::Config)?;
        Ok(self.snapshot_after(self.cursor()))
    }

    pub async fn cancel(&self) -> Result<(), AgentError> {
        let sender = self
            .runtime
            .lock()
            .await
            .sender
            .clone()
            .ok_or(AgentError::NotConnected)?;
        sender
            .send(AgentCommand::Cancel)
            .map_err(|_| AgentError::NotConnected)
    }

    pub async fn disconnect(&self) -> Result<(), AgentError> {
        let sender = self
            .runtime
            .lock()
            .await
            .sender
            .clone()
            .ok_or(AgentError::NotConnected)?;
        sender
            .send(AgentCommand::Shutdown)
            .map_err(|_| AgentError::NotConnected)
    }

    pub async fn answer_permission(
        &self,
        permission_id: &str,
        option_id: Option<String>,
    ) -> Result<(), AgentError> {
        let mut permissions = self.permissions.lock().await;
        let Some(pending) = permissions.remove(permission_id) else {
            return Err(AgentError::InvalidIdentifier(permission_id.to_owned()));
        };
        if option_id
            .as_ref()
            .is_some_and(|option| !pending.option_ids.contains(option))
        {
            permissions.insert(permission_id.to_owned(), pending);
            return Err(AgentError::InvalidIdentifier(option_id.unwrap_or_default()));
        }
        drop(permissions);
        let status = if option_id.is_some() {
            "answered"
        } else {
            "cancelled"
        };
        let detail = option_id
            .clone()
            .unwrap_or_else(|| "Permission request cancelled".to_owned());
        let _ = pending.sender.send(option_id);
        push_event(
            &self.state,
            AgentEventKind::Status,
            "Agent permission resolved".to_owned(),
            detail,
            Some(status.to_owned()),
            None,
            None,
            Vec::new(),
        );
        Ok(())
    }
}

fn workflow_agent_prompt(prompt: &str) -> String {
    format!("{WORKFLOW_AGENT_CONTRACT}\n\n{prompt}")
}

async fn run_agent(
    agent: AcpAgent,
    commands: mpsc::UnboundedReceiver<AgentCommand>,
    context: AgentRuntimeContext,
) -> Result<(), String> {
    let AgentRuntimeContext {
        state,
        permissions,
        permission_sequence,
        project_root,
        server_url,
        mcp_command,
        mcp_capability,
    } = context;
    let permission_state = state.clone();
    let permission_waiters = permissions.clone();
    let agent_workspace = tempfile::Builder::new()
        .prefix("somite-workflow-agent-")
        .tempdir()
        .map_err(|error| format!("could not create isolated workflow-agent workspace: {error}"))?;
    let launch = agent.into_config();
    let command = launch
        .command()
        .to_str()
        .ok_or_else(|| "ACP agent command is not valid UTF-8".to_owned())?;
    let mut isolated_args = vec![
        "--chdir".to_owned(),
        agent_workspace.path().display().to_string(),
        "--".to_owned(),
        command.to_owned(),
    ];
    isolated_args.extend(launch.arguments().iter().cloned());
    let agent = AcpAgent::new(
        AcpAgentConfig::new("env")
            .args(isolated_args)
            .envs(launch.environment().clone()),
    );
    agent_client_protocol::Client
        .builder()
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let permission_id = format!(
                    "permission-{}",
                    permission_sequence.fetch_add(1, Ordering::Relaxed)
                );
                let choices = request
                    .options
                    .iter()
                    .map(|option| PermissionChoice {
                        option_id: option.option_id.to_string(),
                        name: option.name.clone(),
                        kind: permission_kind(option.kind).to_owned(),
                    })
                    .collect::<Vec<_>>();
                let tool_call_id = request.tool_call.tool_call_id.to_string();
                let mut fallback = recent_tool_call_fields(&permission_state, &tool_call_id);
                if request.tool_call.fields.title.is_none()
                    && request.tool_call.fields.raw_input.is_none()
                    && fallback.0.is_none()
                {
                    for _ in 0..20 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        fallback = recent_tool_call_fields(&permission_state, &tool_call_id);
                        if fallback.0.is_some() || fallback.1.is_some() {
                            break;
                        }
                    }
                }
                let (title, detail) = permission_event_fields(
                    &tool_call_id,
                    request.tool_call.fields.title.as_deref(),
                    request.tool_call.fields.raw_input.as_ref().or(fallback.1.as_ref()),
                    fallback.0.as_deref(),
                );
                if let Some(option_id) = automatic_somite_permission(&title, &choices) {
                    push_event_with_tool_call(
                        &permission_state,
                        AgentEventKind::Permission,
                        title,
                        format!("{detail} · Automatically allowed for this Somite session"),
                        Some("approved".to_owned()),
                        None,
                        Some(permission_id),
                        Vec::new(),
                        Some(tool_call_id),
                    );
                    return responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            option_id.to_owned(),
                        )),
                    ));
                }
                let (sender, receiver) = oneshot::channel();
                let option_ids = choices
                    .iter()
                    .map(|choice| choice.option_id.clone())
                    .collect();
                permission_waiters
                    .lock()
                    .await
                    .insert(permission_id.clone(), PendingPermission { sender, option_ids });
                push_event_with_tool_call(
                    &permission_state,
                    AgentEventKind::Permission,
                    title,
                    detail,
                    Some("waiting".to_owned()),
                    None,
                    Some(permission_id.clone()),
                    choices,
                    Some(tool_call_id),
                );
                let selected = tokio::time::timeout(Duration::from_secs(300), receiver)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten();
                permission_waiters.lock().await.remove(&permission_id);
                let outcome = selected
                    .map(|option_id| {
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
                    })
                    .unwrap_or(RequestPermissionOutcome::Cancelled);
                responder.respond(RequestPermissionResponse::new(outcome))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let agent_workspace = agent_workspace;
            let mut commands = commands;
            let initialize = InitializeRequest::new(ProtocolVersion::V1)
                .client_capabilities(ClientCapabilities::new().session(
                    ClientSessionCapabilities::new().config_options(
                        SessionConfigOptionsCapabilities::new()
                            .boolean(BooleanConfigOptionCapabilities::new()),
                    ),
                ))
                .client_info(
                    Implementation::new("somite", env!("CARGO_PKG_VERSION")).title("Somite"),
                );
            let initialized = connection.send_request(initialize).block_task().await?;
            if initialized.protocol_version != ProtocolVersion::V1 {
                return Err(agent_client_protocol::Error::invalid_request().data(
                    "Somite supports stable ACP protocol version 1",
                ));
            }
            let agent_name = initialized
                .agent_info
                .map(|info| info.title.unwrap_or(info.name))
                .unwrap_or_else(|| "ACP agent".to_owned());
            let mcp_server = McpServer::Stdio(
                McpServerStdio::new("Somite", mcp_command).args(vec![
                    "mcp".to_owned(),
                    "--server-url".to_owned(),
                    server_url,
                ])
                .env(vec![EnvVariable::new(
                    "SOMITE_MCP_RUNTIME_CAPABILITY",
                    mcp_capability,
                )]),
            );
            let mut session = connection
                .build_session_from(
                    NewSessionRequest::new(agent_workspace.path()).mcp_servers(vec![mcp_server]),
                )
                .block_task()
                .start_session()
                .await?;
            let initial_config_options = session.config_options().unwrap_or_default().to_vec();
            {
                let mut current = state.lock().expect("agent state");
                current.connecting = false;
                current.connected = true;
                current.agent_name = Some(agent_name.clone());
                current.config_options = initial_config_options;
            }
            push_event(
                &state,
                AgentEventKind::Status,
                format!("{agent_name} connected"),
                "Stable ACP v1 · Somite MCP tools attached over stdio".to_owned(),
                Some("ready".to_owned()),
                None,
                None,
                Vec::new(),
            );

            while let Some(command) = commands.recv().await {
                match command {
                    AgentCommand::Prompt(prompt) => {
                        session.send_prompt(prompt)?;
                        let mut turn_done = false;
                        while !turn_done {
                            tokio::select! {
                                update = session.read_update() => {
                                    match update? {
                                        SessionMessage::SessionMessage(dispatch) => {
                                            let event_state = state.clone();
                                            MatchDispatch::new(dispatch)
                                                .if_notification(async move |notification: SessionNotification| {
                                                    record_session_update(&event_state, notification.update);
                                                    Ok(())
                                                })
                                                .await
                                                .otherwise_ignore()?;
                                        }
                                        SessionMessage::StopReason(reason) => {
                                            turn_done = true;
                                            let status = stop_reason(&reason).to_owned();
                                            push_event(
                                                &state,
                                                AgentEventKind::Status,
                                                "Agent turn finished".to_owned(),
                                                status.clone(),
                                                Some(status),
                                                None,
                                                None,
                                                Vec::new(),
                                            );
                                            match persist_transcript(&state, &project_root) {
                                                Ok(path) => push_event(
                                                    &state,
                                                    AgentEventKind::Status,
                                                    "Agent transcript saved".to_owned(),
                                                    path.strip_prefix(&project_root)
                                                        .unwrap_or(&path)
                                                        .display()
                                                        .to_string(),
                                                    Some("saved".to_owned()),
                                                    None,
                                                    None,
                                                    Vec::new(),
                                                ),
                                                Err(error) => push_event(
                                                    &state,
                                                    AgentEventKind::Error,
                                                    "Agent transcript could not be saved".to_owned(),
                                                    error,
                                                    Some("failed".to_owned()),
                                                    None,
                                                    None,
                                                    Vec::new(),
                                                ),
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                command = commands.recv() => {
                                    match command {
                                        Some(AgentCommand::Cancel) => {
                                            session.connection().send_notification(CancelNotification::new(session.session_id().clone()))?;
                                            cancel_permissions(&permissions).await;
                                        }
                                        Some(AgentCommand::Shutdown) | None => {
                                            session.connection().send_notification(CancelNotification::new(session.session_id().clone()))?;
                                            cancel_permissions(&permissions).await;
                                            return Ok(());
                                        }
                                        Some(AgentCommand::SetConfig { response, .. }) => {
                                            let _ = response.send(Err("agent is still working".to_owned()));
                                        }
                                        Some(AgentCommand::Prompt(_)) => {}
                                    }
                                }
                            }
                        }
                        state.lock().expect("agent state").busy = false;
                    }
                    AgentCommand::SetConfig {
                        config_id,
                        value,
                        response,
                    } => {
                        let request = SetSessionConfigOptionRequest::new(
                            session.session_id().clone(),
                            config_id.clone(),
                            value,
                        );
                        match session
                            .connection()
                            .send_request(request)
                            .block_task()
                            .await
                        {
                            Ok(config) => {
                                state.lock().expect("agent state").config_options =
                                    config.config_options;
                                push_event(
                                    &state,
                                    AgentEventKind::Status,
                                    "Agent configuration updated".to_owned(),
                                    config_id,
                                    Some("ready".to_owned()),
                                    None,
                                    None,
                                    Vec::new(),
                                );
                                let _ = response.send(Ok(()));
                            }
                            Err(error) => {
                                let detail = error.to_string();
                                push_event(
                                    &state,
                                    AgentEventKind::Error,
                                    "Agent configuration failed".to_owned(),
                                    detail.clone(),
                                    Some("failed".to_owned()),
                                    None,
                                    None,
                                    Vec::new(),
                                );
                                let _ = response.send(Err(detail));
                            }
                        }
                    }
                    AgentCommand::Cancel => {}
                    AgentCommand::Shutdown => return Ok(()),
                }
            }
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())
}

async fn cancel_permissions(permissions: &tokio::sync::Mutex<PermissionWaiters>) {
    let waiters = std::mem::take(&mut *permissions.lock().await);
    for (_, pending) in waiters {
        let _ = pending.sender.send(None);
    }
}

fn permission_kind(kind: PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "other",
    }
}

fn automatic_somite_permission<'a>(
    title: &str,
    choices: &'a [PermissionChoice],
) -> Option<&'a str> {
    let action = title.strip_prefix("Approve ")?;
    if !action.starts_with("somite.")
        || action.len() == "somite.".len()
        || !action
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_'))
    {
        return None;
    }
    choices
        .iter()
        .find(|choice| {
            choice.kind == "allow_always" && choice.name.to_ascii_lowercase().contains("session")
        })
        .or_else(|| choices.iter().find(|choice| choice.kind == "allow_once"))
        .map(|choice| choice.option_id.as_str())
}

fn permission_event_fields(
    tool_call_id: &str,
    request_title: Option<&str>,
    raw_input: Option<&Value>,
    fallback_title: Option<&str>,
) -> (String, String) {
    let raw_tool = raw_input
        .and_then(|input| input.get("tool"))
        .and_then(Value::as_str);
    let action = raw_tool
        .or(request_title)
        .or(fallback_title)
        .unwrap_or("agent action")
        .strip_prefix("mcp.Somite.")
        .unwrap_or_else(|| {
            raw_tool
                .or(request_title)
                .or(fallback_title)
                .unwrap_or("agent action")
        });
    let mut details = vec![format!("Tool call `{tool_call_id}`")];
    let arguments = raw_input
        .and_then(|input| input.get("arguments"))
        .or(raw_input);
    if let Some(summary) = arguments
        .and_then(|input| input.get("summary"))
        .and_then(Value::as_str)
    {
        details.push(summary.to_owned());
    }
    if let Some(count) = arguments
        .and_then(|input| input.get("operations"))
        .and_then(Value::as_array)
        .map(Vec::len)
    {
        details.push(format!(
            "{count} operation{}",
            if count == 1 { "" } else { "s" }
        ));
    }
    (format!("Approve {action}"), details.join(" · "))
}

fn recent_tool_call_fields(
    state: &Arc<Mutex<BridgeState>>,
    tool_call_id: &str,
) -> (Option<String>, Option<Value>) {
    state
        .lock()
        .expect("agent state")
        .events
        .iter()
        .rev()
        .find(|event| {
            event.kind == AgentEventKind::Tool
                && event.tool_call_id.as_deref() == Some(tool_call_id)
        })
        .map(|event| {
            (
                Some(event.title.clone()),
                serde_json::from_str(&event.detail).ok(),
            )
        })
        .unwrap_or_default()
}

fn stop_reason(reason: &StopReason) -> &'static str {
    match reason {
        StopReason::EndTurn => "completed",
        StopReason::Cancelled => "cancelled",
        StopReason::MaxTokens => "max_tokens",
        StopReason::MaxTurnRequests => "max_turn_requests",
        StopReason::Refusal => "refused",
        _ => "stopped",
    }
}

fn record_session_update(state: &Arc<Mutex<BridgeState>>, update: SessionUpdate) {
    match update {
        SessionUpdate::AgentMessageChunk(ContentChunk {
            content: ContentBlock::Text(text),
            ..
        }) => push_event(
            state,
            AgentEventKind::Message,
            "Agent".to_owned(),
            text.text,
            None,
            None,
            None,
            Vec::new(),
        ),
        SessionUpdate::ToolCall(call) => {
            let tool_call_id = call.tool_call_id.to_string();
            push_event_with_tool_call(
                state,
                AgentEventKind::Tool,
                call.title,
                call.raw_input
                    .and_then(|value| serde_json::to_string_pretty(&value).ok())
                    .unwrap_or_default(),
                Some(format!("{:?}", call.status).to_ascii_lowercase()),
                None,
                None,
                Vec::new(),
                Some(tool_call_id),
            );
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let tool_call_id = update.tool_call_id.to_string();
            push_event_with_tool_call(
                state,
                AgentEventKind::Tool,
                update
                    .fields
                    .title
                    .unwrap_or_else(|| format!("Tool {}", update.tool_call_id)),
                update
                    .fields
                    .raw_output
                    .and_then(|value| serde_json::to_string_pretty(&value).ok())
                    .unwrap_or_default(),
                update
                    .fields
                    .status
                    .map(|status| format!("{status:?}").to_ascii_lowercase()),
                None,
                None,
                Vec::new(),
                Some(tool_call_id),
            );
        }
        SessionUpdate::Plan(plan) => push_event(
            state,
            AgentEventKind::Status,
            "Agent plan updated".to_owned(),
            serde_json::to_string(&plan).unwrap_or_default(),
            Some("planning".to_owned()),
            None,
            None,
            Vec::new(),
        ),
        SessionUpdate::ConfigOptionUpdate(update) => {
            state.lock().expect("agent state").config_options = update.config_options;
            push_event(
                state,
                AgentEventKind::Status,
                "Agent options refreshed".to_owned(),
                "Models and session configuration were updated by the agent.".to_owned(),
                Some("ready".to_owned()),
                None,
                None,
                Vec::new(),
            );
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn push_event(
    state: &Arc<Mutex<BridgeState>>,
    kind: AgentEventKind,
    title: String,
    detail: String,
    status: Option<String>,
    transaction: Option<TransactionResult>,
    permission_id: Option<String>,
    permission_choices: Vec<PermissionChoice>,
) {
    push_event_with_tool_call(
        state,
        kind,
        title,
        detail,
        status,
        transaction,
        permission_id,
        permission_choices,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
fn push_event_with_tool_call(
    state: &Arc<Mutex<BridgeState>>,
    kind: AgentEventKind,
    title: String,
    detail: String,
    status: Option<String>,
    transaction: Option<TransactionResult>,
    permission_id: Option<String>,
    permission_choices: Vec<PermissionChoice>,
    tool_call_id: Option<String>,
) {
    let mut state = state.lock().expect("agent state");
    state.cursor += 1;
    let cursor = state.cursor;
    state.events.push_back(AgentEvent {
        cursor,
        recorded_at_unix_ms: now_ms(),
        kind,
        title,
        detail,
        status,
        transaction,
        permission_id,
        tool_call_id,
        permission_choices,
    });
    while state.events.len() > EVENT_LIMIT {
        state.events.pop_front();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn transcript_value(detail: &str) -> Option<Value> {
    if detail.is_empty() {
        None
    } else {
        let mut value =
            serde_json::from_str(detail).unwrap_or_else(|_| Value::String(detail.to_owned()));
        redact_transcript_value(&mut value);
        Some(value)
    }
}

fn redact_transcript_value(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (name, value) in fields {
                let normalized = name.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "authorization",
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "password",
                    "passwd",
                    "credential",
                    "secret",
                ]
                .iter()
                .any(|sensitive| normalized.contains(sensitive))
                {
                    *value = Value::String("[redacted]".to_owned());
                } else {
                    redact_transcript_value(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_transcript_value(value);
            }
        }
        _ => {}
    }
}

fn transcript_tool_title(title: &str) -> String {
    title
        .strip_prefix("mcp.Somite.")
        .unwrap_or(title)
        .to_owned()
}

fn build_transcript(state: &BridgeState) -> AgentTranscript {
    let start_cursor = state
        .events
        .iter()
        .rfind(|event| event.kind == AgentEventKind::User)
        .map(|event| event.cursor)
        .or_else(|| state.events.front().map(|event| event.cursor))
        .unwrap_or(state.cursor);
    let events = state
        .events
        .iter()
        .filter(|event| event.cursor >= start_cursor)
        .collect::<Vec<_>>();
    let cursor_end = events
        .last()
        .map(|event| event.cursor)
        .unwrap_or(start_cursor);
    let started_at_unix_ms = events
        .first()
        .map(|event| event.recorded_at_unix_ms)
        .unwrap_or_else(now_ms);
    let finished_at_unix_ms = events
        .last()
        .map(|event| event.recorded_at_unix_ms)
        .unwrap_or(started_at_unix_ms);
    let mut messages: Vec<AgentTranscriptMessage> = Vec::new();
    let mut tool_calls: Vec<AgentTranscriptToolCall> = Vec::new();
    let mut tool_indices = BTreeMap::<String, usize>::new();
    let mut transactions = Vec::new();
    let mut activity = Vec::new();
    let mut previous_was_message = false;

    for event in &events {
        let role = match event.kind {
            AgentEventKind::User => Some("user"),
            AgentEventKind::Message => Some("assistant"),
            _ => None,
        };
        if let Some(role) = role {
            if previous_was_message && messages.last().is_some_and(|message| message.role == role) {
                let message = messages.last_mut().expect("message exists");
                message.text.push_str(&event.detail);
                message.cursor_end = event.cursor;
                message.finished_at_unix_ms = event.recorded_at_unix_ms;
            } else {
                messages.push(AgentTranscriptMessage {
                    role: role.to_owned(),
                    text: event.detail.clone(),
                    cursor_start: event.cursor,
                    cursor_end: event.cursor,
                    started_at_unix_ms: event.recorded_at_unix_ms,
                    finished_at_unix_ms: event.recorded_at_unix_ms,
                });
            }
            previous_was_message = true;
            continue;
        }
        previous_was_message = false;

        if let Some(tool_call_id) = &event.tool_call_id {
            let index = *tool_indices.entry(tool_call_id.clone()).or_insert_with(|| {
                let index = tool_calls.len();
                tool_calls.push(AgentTranscriptToolCall {
                    tool_call_id: tool_call_id.clone(),
                    title: transcript_tool_title(&event.title),
                    input: None,
                    output: None,
                    statuses: Vec::new(),
                    permissions: Vec::new(),
                    started_at_unix_ms: event.recorded_at_unix_ms,
                    finished_at_unix_ms: event.recorded_at_unix_ms,
                });
                index
            });
            let tool_call = &mut tool_calls[index];
            tool_call.finished_at_unix_ms = event.recorded_at_unix_ms;
            if tool_call.title.starts_with("Tool ") && !event.title.starts_with("Tool ") {
                tool_call.title = transcript_tool_title(&event.title);
            }
            if let Some(status) = &event.status {
                if tool_call.statuses.last() != Some(status) {
                    tool_call.statuses.push(status.clone());
                }
            }
            if event.kind == AgentEventKind::Permission {
                if let Some(permission_id) = &event.permission_id {
                    tool_call.permissions.push(AgentTranscriptPermission {
                        permission_id: permission_id.clone(),
                        title: event.title.clone(),
                        detail: event.detail.clone(),
                        choices: event.permission_choices.clone(),
                        recorded_at_unix_ms: event.recorded_at_unix_ms,
                    });
                }
            } else if event.kind == AgentEventKind::Tool {
                let terminal = matches!(
                    event.status.as_deref(),
                    Some("completed" | "failed" | "cancelled")
                );
                if terminal {
                    if let Some(value) = transcript_value(&event.detail) {
                        tool_call.output = Some(value);
                    }
                } else if tool_call.input.is_none() {
                    tool_call.input = transcript_value(&event.detail);
                }
            }
            continue;
        }

        if event.kind == AgentEventKind::Transaction {
            if let Some(transaction) = &event.transaction {
                transactions.push(transaction.clone());
            }
        } else {
            activity.push((*event).clone());
        }
    }

    AgentTranscript {
        schema_version: 1,
        agent_name: state.agent_name.clone(),
        config_options: state.config_options.clone(),
        cursor_start: start_cursor,
        cursor_end,
        started_at_unix_ms,
        finished_at_unix_ms,
        raw_event_count: events.len(),
        messages,
        tool_calls,
        transactions,
        activity,
    }
}

fn persist_transcript(
    state: &Arc<Mutex<BridgeState>>,
    project_root: &Path,
) -> Result<PathBuf, String> {
    let transcript = build_transcript(&state.lock().expect("agent state"));
    let directory = project_root.join(".somite/agent-transcripts");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!(
        "turn-{}-{}.json",
        transcript.started_at_unix_ms, transcript.finished_at_unix_ms
    ));
    crate::write_json_atomic(&path, &transcript).map_err(|error| error.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use somite_ir::SCHEMA_VERSION;
    use tempfile::TempDir;

    fn catalog() -> Catalog {
        Catalog::load_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators"))
            .expect("catalog")
    }

    fn empty_graph() -> Graph {
        Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            annotations: Vec::new(),
        }
    }

    #[test]
    fn transaction_is_atomic_and_pins_catalog_revisions() {
        let catalog = catalog();
        let graph = empty_graph();
        let base_revision = graph_state_revision(&graph).expect("revision");
        let result = apply_graph_transaction(
            &graph,
            &catalog,
            GraphTransaction {
                base_state_revision: base_revision,
                idempotency_key: "atomic-edit-1".to_owned(),
                summary: "Add reads and quality control".to_owned(),
                operations: vec![
                    GraphOperation::AddOperator {
                        node_id: "reads".to_owned(),
                        operator_id: "files.import".to_owned(),
                        params: BTreeMap::from([(
                            "path".to_owned(),
                            Value::String("reads.fastq".to_owned()),
                        )]),
                        x: 0.0,
                        y: 0.0,
                        note: None,
                    },
                    GraphOperation::AddOperator {
                        node_id: "fastqc".to_owned(),
                        operator_id: "qc.fastqc".to_owned(),
                        params: BTreeMap::new(),
                        x: 320.0,
                        y: 0.0,
                        note: None,
                    },
                    GraphOperation::Connect {
                        edge_id: "reads_to_fastqc".to_owned(),
                        from_node: "reads".to_owned(),
                        from_port: "file".to_owned(),
                        to_node: "fastqc".to_owned(),
                        to_port: "fastq".to_owned(),
                    },
                ],
            },
            "transaction-1".to_owned(),
        )
        .expect("transaction");

        assert_eq!(result.graph.nodes.len(), 2);
        assert_eq!(result.graph.edges.len(), 1);
        assert!(result
            .graph
            .nodes
            .iter()
            .all(|node| node.operator_revision.starts_with("blake3:")));
        result.graph.validate().expect("valid graph");

        let noted = apply_graph_transaction(
            &result.graph,
            &catalog,
            GraphTransaction {
                base_state_revision: result.state_revision.clone(),
                idempotency_key: "atomic-note-1".to_owned(),
                summary: "Annotate quality control".to_owned(),
                operations: vec![GraphOperation::SetNote {
                    node_id: "fastqc".to_owned(),
                    note: Some("Review this report".to_owned()),
                }],
            },
            "transaction-note".to_owned(),
        )
        .expect("note transaction");
        assert_eq!(noted.graph_revision, result.graph_revision);
        assert_ne!(noted.state_revision, result.state_revision);
        let stale_note = apply_graph_transaction(
            &noted.graph,
            &catalog,
            GraphTransaction {
                base_state_revision: result.state_revision,
                idempotency_key: "atomic-stale-note-1".to_owned(),
                summary: "Overwrite the note".to_owned(),
                operations: vec![GraphOperation::SetNote {
                    node_id: "fastqc".to_owned(),
                    note: Some("Stale change".to_owned()),
                }],
            },
            "transaction-stale-note".to_owned(),
        )
        .expect_err("presentation edits must advance CAS state");
        assert!(matches!(stale_note, AgentError::StaleTransaction { .. }));
    }

    #[test]
    fn failed_transaction_does_not_mutate_its_input() {
        let catalog = catalog();
        let graph = empty_graph();
        let original = graph.clone();
        let error = apply_graph_transaction(
            &graph,
            &catalog,
            GraphTransaction {
                base_state_revision: graph_state_revision(&graph).unwrap(),
                idempotency_key: "atomic-broken-1".to_owned(),
                summary: "Broken transaction".to_owned(),
                operations: vec![GraphOperation::Connect {
                    edge_id: "bad".to_owned(),
                    from_node: "missing".to_owned(),
                    from_port: "out".to_owned(),
                    to_node: "also_missing".to_owned(),
                    to_port: "in".to_owned(),
                }],
            },
            "transaction-2".to_owned(),
        )
        .expect_err("invalid transaction");

        assert!(matches!(error, AgentError::Graph(_)));
        assert_eq!(graph, original);
    }

    #[test]
    fn stale_transaction_is_rejected_before_any_operation() {
        let error = apply_graph_transaction(
            &empty_graph(),
            &catalog(),
            GraphTransaction {
                base_state_revision: "blake3:stale".to_owned(),
                idempotency_key: "atomic-stale-1".to_owned(),
                summary: "Stale".to_owned(),
                operations: vec![GraphOperation::RemoveNode {
                    node_id: "anything".to_owned(),
                }],
            },
            "transaction-3".to_owned(),
        )
        .expect_err("stale transaction");

        assert!(matches!(error, AgentError::StaleTransaction { .. }));
    }

    #[test]
    fn permission_event_names_and_correlates_the_pending_mcp_action() {
        let raw_input = serde_json::json!({
            "server": "Somite",
            "tool": "somite.graph.apply_transaction",
            "arguments": {
                "summary": "Add paired reads",
                "operations": [{"op": "add_operator"}, {"op": "connect"}]
            }
        });
        let (title, detail) = permission_event_fields(
            "exec-123",
            None,
            Some(&raw_input),
            Some("mcp.Somite.somite.graph.apply_transaction"),
        );

        assert_eq!(title, "Approve somite.graph.apply_transaction");
        assert_eq!(
            detail,
            "Tool call `exec-123` · Add paired reads · 2 operations"
        );
    }

    #[test]
    fn permission_can_recover_tool_identity_from_a_later_acp_update() {
        let state = Arc::new(Mutex::new(BridgeState::default()));
        push_event_with_tool_call(
            &state,
            AgentEventKind::Tool,
            "mcp.Somite.somite.validation.start".to_owned(),
            r#"{"server":"Somite","tool":"somite.validation.start","arguments":{"idempotency_key":"validation-retry-1"}}"#.to_owned(),
            Some("pending".to_owned()),
            None,
            None,
            Vec::new(),
            Some("exec-456".to_owned()),
        );

        let (fallback_title, fallback_input) = recent_tool_call_fields(&state, "exec-456");
        let (title, detail) = permission_event_fields(
            "exec-456",
            None,
            fallback_input.as_ref(),
            fallback_title.as_deref(),
        );

        assert_eq!(title, "Approve somite.validation.start");
        assert_eq!(detail, "Tool call `exec-456`");
    }

    #[test]
    fn somite_permissions_are_automatically_allowed_for_the_session_only() {
        let choices = vec![
            PermissionChoice {
                option_id: "allow_once".to_owned(),
                name: "Allow".to_owned(),
                kind: "allow_once".to_owned(),
            },
            PermissionChoice {
                option_id: "allow_session".to_owned(),
                name: "Allow for This Session".to_owned(),
                kind: "allow_always".to_owned(),
            },
            PermissionChoice {
                option_id: "allow_always".to_owned(),
                name: "Allow and Don't Ask Again".to_owned(),
                kind: "allow_always".to_owned(),
            },
        ];

        assert_eq!(
            automatic_somite_permission("Approve somite.graph.apply_transaction", &choices),
            Some("allow_session")
        );
        assert_eq!(
            automatic_somite_permission("Approve shell command", &choices),
            None
        );
        assert_eq!(
            automatic_somite_permission("Approve agent action", &choices),
            None
        );
    }

    #[test]
    fn transcript_coalesces_messages_and_correlates_tool_permission_and_result() {
        let state = Arc::new(Mutex::new(BridgeState {
            agent_name: Some("Fixture Agent".to_owned()),
            ..BridgeState::default()
        }));
        push_event(
            &state,
            AgentEventKind::User,
            "You".to_owned(),
            "Build the graph".to_owned(),
            None,
            None,
            None,
            Vec::new(),
        );
        for chunk in ["Using ", "Somite."] {
            push_event(
                &state,
                AgentEventKind::Message,
                "Agent".to_owned(),
                chunk.to_owned(),
                None,
                None,
                None,
                Vec::new(),
            );
        }
        push_event_with_tool_call(
            &state,
            AgentEventKind::Tool,
            "mcp.Somite.somite.graph.apply_transaction".to_owned(),
            r#"{"tool":"somite.graph.apply_transaction","arguments":{"summary":"Add reads"}}"#
                .to_owned(),
            Some("inprogress".to_owned()),
            None,
            None,
            Vec::new(),
            Some("exec-1".to_owned()),
        );
        push_event_with_tool_call(
            &state,
            AgentEventKind::Permission,
            "Approve somite.graph.apply_transaction".to_owned(),
            "Tool call `exec-1` · Add reads · 1 operation".to_owned(),
            Some("waiting".to_owned()),
            None,
            Some("permission-1".to_owned()),
            vec![PermissionChoice {
                option_id: "allow_once".to_owned(),
                name: "Allow once".to_owned(),
                kind: "allow_once".to_owned(),
            }],
            Some("exec-1".to_owned()),
        );
        push_event_with_tool_call(
            &state,
            AgentEventKind::Tool,
            "Tool exec-1".to_owned(),
            r#"{"result":{"state_revision":"blake3:new"}}"#.to_owned(),
            Some("completed".to_owned()),
            None,
            None,
            Vec::new(),
            Some("exec-1".to_owned()),
        );

        let transcript = build_transcript(&state.lock().expect("agent state"));

        assert_eq!(transcript.messages.len(), 2);
        assert_eq!(transcript.messages[1].role, "assistant");
        assert_eq!(transcript.messages[1].text, "Using Somite.");
        assert_eq!(transcript.tool_calls.len(), 1);
        assert_eq!(
            transcript.tool_calls[0].title,
            "somite.graph.apply_transaction"
        );
        assert_eq!(
            transcript.tool_calls[0].statuses,
            ["inprogress", "waiting", "completed"]
        );
        assert_eq!(transcript.tool_calls[0].permissions.len(), 1);
        assert_eq!(
            transcript.tool_calls[0].output.as_ref().and_then(|output| {
                output
                    .get("result")
                    .and_then(|result| result.get("state_revision"))
                    .and_then(Value::as_str)
            }),
            Some("blake3:new")
        );
    }

    #[test]
    fn transcript_redacts_nested_credentials_without_hiding_normal_arguments() {
        let value = transcript_value(
            r#"{"arguments":{"path":"reads.fastq","api_key":"private","nested":{"Authorization":"Bearer private"}}}"#,
        )
        .expect("transcript value");

        assert_eq!(value["arguments"]["path"], "reads.fastq");
        assert_eq!(value["arguments"]["api_key"], "[redacted]");
        assert_eq!(value["arguments"]["nested"]["Authorization"], "[redacted]");
    }

    #[tokio::test]
    async fn spawned_acp_v1_agent_receives_the_workflow_contract_and_keeps_user_text_visible() {
        let temporary = TempDir::new().expect("temporary ACP fixture");
        let fixture = temporary.path().join("fake-acp-agent");
        std::fs::write(
            &fixture,
            r#"#!/bin/sh
pwd > "$(dirname "$0")/captured-process-cwd.txt"
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([^,}]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[],\"agentInfo\":{\"name\":\"somite-fixture\",\"title\":\"Fixture Agent\",\"version\":\"1\"}}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "$line" > "$(dirname "$0")/captured-session.json"
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"session-1\",\"configOptions\":[{\"id\":\"model\",\"name\":\"Model\",\"category\":\"model\",\"type\":\"select\",\"currentValue\":\"fast\",\"options\":[{\"value\":\"fast\",\"name\":\"Fast\"},{\"value\":\"precise\",\"name\":\"Precise\"}]}]}}"
      ;;
    *'"method":"session/set_config_option"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"configOptions\":[{\"id\":\"model\",\"name\":\"Model\",\"category\":\"model\",\"type\":\"select\",\"currentValue\":\"precise\",\"options\":[{\"value\":\"fast\",\"name\":\"Fast\"},{\"value\":\"precise\",\"name\":\"Precise\"}]}]}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' "$line" > "$(dirname "$0")/captured-prompt.json"
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Built with Somite."}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done
"#,
        )
        .expect("ACP fixture script");
        let mut permissions = std::fs::metadata(&fixture)
            .expect("ACP fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fixture, permissions).expect("ACP fixture executable");

        let bridge = AgentBridge::new(
            temporary.path().to_path_buf(),
            "http://127.0.0.1:7310".to_owned(),
            PathBuf::from("/bin/true"),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
        );
        bridge
            .connect(fixture.display().to_string())
            .await
            .expect("connect ACP fixture");
        for _ in 0..100 {
            if bridge.snapshot_after(0).connected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let connected = bridge.snapshot_after(0);
        assert!(
            connected.connected,
            "ACP fixture never connected: {connected:?}"
        );
        assert_eq!(connected.agent_name.as_deref(), Some("Fixture Agent"));
        assert_eq!(connected.config_options.len(), 1);

        let configured = bridge
            .set_config(
                "model".to_owned(),
                AgentConfigValue::Select("precise".to_owned()),
            )
            .await
            .expect("set ACP model config");
        assert_eq!(configured.config_options.len(), 1);
        assert_eq!(
            serde_json::to_value(&configured.config_options[0])
                .expect("serialize config option")
                .get("currentValue"),
            Some(&serde_json::Value::String("precise".to_owned()))
        );

        bridge
            .prompt("Build a tiny workflow".to_owned())
            .await
            .expect("prompt ACP fixture");
        for _ in 0..100 {
            if !bridge.snapshot_after(0).busy {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let finished = bridge.snapshot_after(0);
        assert!(
            !finished.busy,
            "ACP fixture turn never finished: {finished:?}"
        );
        assert!(
            finished.events.iter().any(|event| {
                event.kind == AgentEventKind::Message && event.detail == "Built with Somite."
            }),
            "ACP message was not forwarded: {finished:?}"
        );
        assert!(finished.events.iter().any(|event| {
            event.kind == AgentEventKind::Status && event.status.as_deref() == Some("completed")
        }));
        let transcripts = std::fs::read_dir(temporary.path().join(".somite/agent-transcripts"))
            .expect("transcript directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("transcript entries");
        assert_eq!(transcripts.len(), 1);
        let transcript: serde_json::Value = serde_json::from_slice(
            &std::fs::read(transcripts[0].path()).expect("persisted transcript"),
        )
        .expect("transcript json");
        assert_eq!(transcript["schema_version"], 1);
        assert_eq!(transcript["agent_name"], "Fixture Agent");
        assert_eq!(transcript["messages"][0]["text"], "Build a tiny workflow");
        assert_eq!(transcript["messages"][1]["text"], "Built with Somite.");

        let captured_session: serde_json::Value = serde_json::from_slice(
            &std::fs::read(temporary.path().join("captured-session.json"))
                .expect("captured ACP session"),
        )
        .expect("captured ACP session json");
        let session_cwd = captured_session
            .pointer("/params/cwd")
            .and_then(Value::as_str)
            .expect("ACP session cwd");
        assert!(
            !Path::new(session_cwd).starts_with(temporary.path()),
            "workflow agent should not inherit the project instruction tree: {session_cwd}"
        );
        let process_cwd =
            std::fs::read_to_string(temporary.path().join("captured-process-cwd.txt"))
                .expect("captured ACP process cwd");
        assert_eq!(process_cwd.trim(), session_cwd);

        let captured: serde_json::Value = serde_json::from_slice(
            &std::fs::read(temporary.path().join("captured-prompt.json"))
                .expect("captured ACP prompt"),
        )
        .expect("captured ACP prompt json");
        let delivered = captured
            .pointer("/params/prompt/0/text")
            .and_then(Value::as_str)
            .expect("delivered workflow-agent prompt");
        assert!(delivered.contains("Work through the Somite MCP tools immediately"));
        assert!(delivered.contains("Do not inspect or modify the Somite repository"));
        assert!(delivered.contains("Generic web research is allowed only"));
        assert!(delivered.contains("Use short single-concept catalog queries"));
        assert!(delivered.contains("After editing, call Somite readiness"));
        assert!(delivered.contains("Start validation only when readiness is clear"));
        assert!(delivered.ends_with("Build a tiny workflow"));

        bridge.disconnect().await.expect("disconnect ACP fixture");
    }
}
