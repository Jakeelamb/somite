use std::collections::BTreeSet;

use rmcp::model::{CallToolRequestParams, ClientInfo, ProtocolVersion};
use rmcp::transport::{ConfigureCommandExt, TokioChildProcess};
use rmcp::ServiceExt;
use serde_json::{json, Map, Value};
use somite_server::{app, WebProject};
use tempfile::TempDir;

fn arguments(value: Value) -> Map<String, Value> {
    value.as_object().expect("tool arguments").clone()
}

#[tokio::test]
async fn spawned_stdio_server_lists_tools_and_applies_one_atomic_edit() {
    let project_root = TempDir::new().expect("temporary project");
    let operators = project_root.path().join("operators");
    std::fs::create_dir(&operators).expect("operators directory");
    std::fs::write(
        operators.join("files.import.json"),
        r#"{"id":"files.import","title":"Import file","palette":["Sources"],"kind":"inprocess","params":{"path":{"type":"string","required":true}},"ports":{"out":[{"name":"file","type":"Fastq"}]}}"#,
    )
    .expect("operator fixture");
    let graph_path = project_root.path().join("graph.somite.json");
    std::fs::write(&graph_path, r#"{"schema_version":1,"nodes":[],"edges":[]}"#)
        .expect("graph fixture");

    let project = WebProject::open(project_root.path(), &graph_path).expect("web project");
    let runtime_capability = project.mcp_runtime_capability().to_owned();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener");
    let address = listener.local_addr().expect("listener address");
    let web_task = tokio::spawn(async move {
        axum::serve(listener, app(project))
            .await
            .expect("Somite web server");
    });

    let transport = TokioChildProcess::new(
        tokio::process::Command::new(env!("CARGO_BIN_EXE_somite-server")).configure(|command| {
            command
                .args(["mcp", "--server-url", &format!("http://{address}")])
                .env("SOMITE_MCP_RUNTIME_CAPABILITY", &runtime_capability);
        }),
    )
    .expect("spawn Somite MCP server");
    let client = ClientInfo::default()
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
        .serve(transport)
        .await
        .expect("initialize MCP client");
    let peer_info = client.peer_info().expect("Somite MCP peer info");
    assert_eq!(peer_info.protocol_version, ProtocolVersion::V_2026_07_28);
    assert_eq!(
        peer_info
            .server_info
            .as_ref()
            .map(|server| server.name.as_str()),
        Some("somite")
    );
    let instructions = peer_info
        .instructions
        .as_deref()
        .expect("Somite server instructions");
    assert!(instructions.contains("state_revision as base_state_revision"));
    assert!(instructions.contains("fresh idempotency_key"));
    assert!(instructions.contains("run.status with wait_ms up to 25000"));
    assert!(instructions.contains("somite.source.search"));
    assert!(instructions.contains("Never claim a workflow is runnable"));

    let tools = client.list_all_tools().await.expect("list MCP tools");
    let inspect_tool = tools
        .iter()
        .find(|tool| tool.name == "somite.workflow.get")
        .expect("workflow inspection tool");
    let inspect_description = inspect_tool
        .description
        .as_deref()
        .expect("workflow inspection description");
    let inspect_description = inspect_description
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(inspect_description.contains("use the returned `state_revision`"));
    assert!(inspect_description.contains("not a transaction base"));
    let inspect_schema = inspect_tool
        .output_schema
        .as_ref()
        .expect("workflow output schema");
    assert!(inspect_schema["properties"]["state_revision"].is_object());
    assert!(inspect_schema["properties"]["graph_revision"].is_object());
    assert!(inspect_schema["properties"]["graph"].is_object());
    let edit_description = tools
        .iter()
        .find(|tool| tool.name == "somite.graph.apply_transaction")
        .and_then(|tool| tool.description.as_deref())
        .expect("workflow edit description");
    let edit_description = edit_description
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(edit_description.contains("latest `state_revision`"));
    for tool in &tools {
        assert!(tool.output_schema.is_some(), "{} output schema", tool.name);
        let annotations = tool
            .annotations
            .as_ref()
            .expect("explicit tool annotations");
        assert!(
            annotations.read_only_hint.is_some(),
            "{} read-only hint",
            tool.name
        );
        assert!(
            annotations.destructive_hint.is_some(),
            "{} destructive hint",
            tool.name
        );
        assert!(
            annotations.idempotent_hint.is_some(),
            "{} idempotent hint",
            tool.name
        );
        assert!(
            annotations.open_world_hint.is_some(),
            "{} open-world hint",
            tool.name
        );
    }
    let run_start = tools
        .iter()
        .find(|tool| tool.name == "somite.run.start")
        .expect("run start tool");
    assert_eq!(
        run_start
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.idempotent_hint),
        Some(true)
    );
    let catalog_schema = tools
        .iter()
        .find(|tool| tool.name == "somite.catalog.search")
        .and_then(|tool| tool.output_schema.as_ref())
        .expect("catalog output schema");
    let definitions = catalog_schema["$defs"]
        .as_object()
        .expect("catalog schema definitions");
    let operator = definitions["CatalogOperatorOutput"]
        .as_object()
        .expect("operator schema");
    assert!(operator["properties"]["params"].is_object());
    assert!(operator["properties"]["ports"].is_object());
    assert!(operator["properties"]["outputs"].is_object());
    let names = tools
        .iter()
        .map(|tool| tool.name.to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        names,
        BTreeSet::from([
            "somite.catalog.search".to_owned(),
            "somite.evidence.lookup".to_owned(),
            "somite.graph.apply_transaction".to_owned(),
            "somite.run.cancel".to_owned(),
            "somite.run.start".to_owned(),
            "somite.run.status".to_owned(),
            "somite.source.search".to_owned(),
            "somite.validation.start".to_owned(),
            "somite.workflow.compile".to_owned(),
            "somite.workflow.get".to_owned(),
        ])
    );

    let inspected = client
        .call_tool(CallToolRequestParams::new("somite.workflow.get"))
        .await
        .expect("inspect workflow")
        .structured_content
        .expect("structured graph response");
    let base_revision = inspected["state_revision"]
        .as_str()
        .expect("state revision");
    assert!(base_revision.starts_with("blake3:"));

    let transaction_arguments = arguments(json!({
        "base_state_revision": base_revision,
        "idempotency_key": "mcp-atomic-edit-1",
        "summary": "Add a local FASTQ source",
        "operations": [{
            "op": "add_operator",
            "node_id": "reads",
            "operator_id": "files.import",
            "params": {"path": "reads.fastq"},
            "x": 80,
            "y": 120
        }]
    }));
    let edited_result = client
        .call_tool(
            CallToolRequestParams::new("somite.graph.apply_transaction")
                .with_arguments(transaction_arguments.clone()),
        )
        .await
        .expect("apply transaction");
    assert_eq!(edited_result.is_error, Some(false));
    let edited = edited_result
        .structured_content
        .expect("structured transaction response");
    assert_eq!(edited["graph"]["nodes"][0]["id"], "reads");
    assert_eq!(edited["summary"], "Add a local FASTQ source");
    assert_eq!(edited["replayed"], false);
    assert_ne!(edited["state_revision"], base_revision);

    let replay = client
        .call_tool(
            CallToolRequestParams::new("somite.graph.apply_transaction")
                .with_arguments(transaction_arguments.clone()),
        )
        .await
        .expect("replayed transaction returns the original result");
    assert_eq!(replay.is_error, Some(false));
    let replay = replay
        .structured_content
        .expect("structured replayed transaction");
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["transaction_id"], edited["transaction_id"]);

    let mut stale_arguments = transaction_arguments;
    stale_arguments.insert(
        "idempotency_key".to_owned(),
        Value::String("mcp-atomic-edit-2".to_owned()),
    );
    let stale = client
        .call_tool(
            CallToolRequestParams::new("somite.graph.apply_transaction")
                .with_arguments(stale_arguments),
        )
        .await
        .expect("stale transaction returns a tool result");
    assert_eq!(stale.is_error, Some(true));
    let stale = stale
        .structured_content
        .expect("structured stale transaction error");
    assert_eq!(stale["error"]["code"], "stale_state_revision");
    assert_eq!(stale["error"]["retryable"], true);
    assert_eq!(stale["error"]["supplied_state_revision"], base_revision);
    assert_eq!(
        stale["error"]["current_state_revision"],
        edited["state_revision"]
    );

    let current = client
        .call_tool(CallToolRequestParams::new("somite.workflow.get"))
        .await
        .expect("inspect edited workflow")
        .structured_content
        .expect("structured edited graph");
    assert_eq!(current["graph"]["nodes"][0]["id"], "reads");

    client.cancel().await.expect("stop MCP client");
    web_task.abort();
}
