use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use somite_ir::{
    Direction, Graph, Layout, Node, ParamValue, Port, PortType, SourceProvider, SourceScopeKind,
    UnsupportedRequiredWorkflowParameter, WorkflowBinding, WorkflowParameterType,
    MAX_EXACT_JSON_INTEGER, MIN_EXACT_JSON_INTEGER, SCHEMA_VERSION,
};
use somite_source_workflow::{
    apply, freeze_local, load_local, promote_invocation, reindex_frozen, restore_source_workflow,
    workflow_revision, EditTransaction, LoadLocalRequest, SemanticEdit, SourceWorkflowError,
};
use tempfile::TempDir;

struct GitFixture {
    temporary: TempDir,
    commit: String,
}

impl GitFixture {
    fn root(&self) -> &Path {
        self.temporary.path()
    }

    fn request(&self) -> LoadLocalRequest {
        LoadLocalRequest {
            root: self.root().to_path_buf(),
            provider: SourceProvider::Local,
            repository: "local/example".to_owned(),
            requested_revision: "v1.0.0".to_owned(),
            expected_resolved_revision: self.commit.clone(),
            entrypoint: "main.nf".to_owned(),
            profiles: vec!["test".to_owned()],
        }
    }

    fn request_at_head(&self) -> LoadLocalRequest {
        let mut request = self.request();
        let head = git(self.root(), &["rev-parse", "HEAD"]).trim().to_owned();
        request.requested_revision.clone_from(&head);
        request.expected_resolved_revision = head;
        request
    }
}

fn fixture() -> GitFixture {
    let temporary = TempDir::new().expect("temporary Git fixture");
    fs::create_dir_all(temporary.path().join("workflows")).expect("workflow directory");
    fs::write(
        temporary.path().join("main.nf"),
        r#"nextflow.enable.dsl = 2

include { CHILD } from './workflows/child'
include { utility } from 'plugin/example'

workflow TOP {
    main:
    CHILD()
    utility()

    emit:
    done = CHILD.out.done
}

workflow {
    main:
    TOP()
}
"#,
    )
    .expect("entrypoint");
    fs::write(
        temporary.path().join("workflows/child.nf"),
        r#"process TOOL {
    input:
    path input

    output:
    path 'result.txt', emit: result

    script:
    """
    printf '%s\n' '{ braces in a script are not declarations }' > result.txt
    """
}

workflow CHILD {
    take:
    input

    main:
    TOOL(input)

    emit:
    done = TOOL.out.result
}
"#,
    )
    .expect("child workflow");
    fs::write(
        temporary.path().join("nextflow_schema.json"),
        r##"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "$defs": {
    "io": {
      "title": "Input and output",
      "type": "object",
      "required": ["input", "outdir"],
      "properties": {
        "input": {
          "type": "string",
          "format": "file-path",
          "description": "Input FASTA",
          "pattern": "^\\S+\\.fn?a(sta)?(\\.gz)?$"
        },
        "outdir": {
          "type": "string",
          "format": "directory-path",
          "description": "Output directory"
        },
        "threads": {
          "type": "integer",
          "default": 4,
          "minimum": 1,
          "maximum": 8
        },
        "mode": {
          "type": "string",
          "enum": ["fast", "careful"],
          "default": "fast"
        }
      }
    },
    "flags": {
      "title": "Flags",
      "type": "object",
      "properties": {
        "enabled": {"type": "boolean", "default": false, "hidden": true}
      }
    }
  },
  "allOf": [
    {"$ref": "#/$defs/io"},
    {"$ref": "#/$defs/flags"}
  ]
}
"##,
    )
    .expect("parameter schema");
    git(temporary.path(), &["init", "--quiet"]);
    git(temporary.path(), &["add", "."]);
    git(
        temporary.path(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    );
    let commit = git(temporary.path(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    git(temporary.path(), &["tag", "v1.0.0", &commit]);
    GitFixture { temporary, commit }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("start Git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("UTF-8 Git output")
}

#[test]
fn loads_exact_source_outline_and_parameter_schema_deterministically() {
    let fixture = fixture();
    let first = load_local(&fixture.request()).expect("load source workflow");
    let second = load_local(&fixture.request()).expect("load source workflow again");

    assert_eq!(first, second);
    assert_eq!(first.workflow.source.resolved_revision, fixture.commit);
    assert_eq!(first.workflow.source.file_count, 3);
    assert_eq!(first.source_manifest.files.len(), 3);
    assert!(first.workflow.source.source_digest.starts_with("blake3:"));
    assert_eq!(first.workflow.parameters.len(), 5);
    assert!(!first.workflow.capabilities.exact_execution);
    assert!(first.workflow.capabilities.hierarchy_indexed);
    assert!(first.workflow.capabilities.parameter_edits);
    assert!(!first.workflow.capabilities.channel_contracts);

    let scopes = &first.workflow.scopes;
    assert_eq!(scopes.len(), 4);
    assert_eq!(
        scopes
            .iter()
            .filter(|scope| scope.kind == SourceScopeKind::EntryWorkflow)
            .count(),
        1
    );
    assert!(scopes.iter().any(|scope| {
        scope.kind == SourceScopeKind::Workflow && scope.symbol.as_deref() == Some("CHILD")
    }));
    assert!(scopes.iter().any(|scope| {
        scope.kind == SourceScopeKind::Process && scope.symbol.as_deref() == Some("TOOL")
    }));

    assert_eq!(first.workflow.invocations.len(), 4);
    assert!(first
        .workflow
        .invocations
        .iter()
        .any(|invocation| invocation.name == "CHILD" && invocation.callee.is_some()));
    assert!(first
        .workflow
        .invocations
        .iter()
        .any(|invocation| invocation.name == "utility" && invocation.callee.is_none()));
    assert!(first
        .workflow
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "source_only_invocation"));

    let input = first
        .workflow
        .parameters
        .iter()
        .find(|parameter| parameter.name == "input")
        .expect("input parameter");
    assert_eq!(input.group, "Input and output");
    assert_eq!(input.ty, WorkflowParameterType::String);
    assert_eq!(input.format.as_deref(), Some("file-path"));
    assert!(input.required);
    let outdir = first
        .workflow
        .parameters
        .iter()
        .find(|parameter| parameter.name == "outdir")
        .expect("outdir parameter");
    assert!(outdir.managed);
    assert!(first.parameter_schema_digest.is_some());
}

#[test]
fn invocation_replacement_creates_a_variant_without_erasing_source_provenance() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let invocation = loaded
        .workflow
        .invocations
        .iter()
        .find(|invocation| invocation.name == "TOOL")
        .expect("source TOOL invocation");

    let replaced = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::ReplaceInvocation {
                invocation_id: invocation.id.clone(),
                operator: "align.bowtie2".to_owned(),
                operator_revision: format!("blake3:{}", "c".repeat(64)),
                params: std::collections::BTreeMap::from([(
                    "threads".to_owned(),
                    ParamValue::Int(8),
                )]),
            }],
        },
    )
    .expect("creative replacement is retained before channel contracts are known");

    assert_eq!(replaced.invocations, loaded.workflow.invocations);
    assert_eq!(replaced.replacements.len(), 1);
    assert_eq!(replaced.replacements[0].invocation_id, invocation.id);
    assert_eq!(replaced.replacements[0].operator, "align.bowtie2");
    assert_ne!(
        replaced.workflow_revision,
        loaded.workflow.workflow_revision
    );

    let restored = apply(
        &replaced,
        &EditTransaction {
            base_workflow_revision: replaced.workflow_revision.clone(),
            edits: vec![SemanticEdit::ResetInvocation {
                invocation_id: invocation.id.clone(),
            }],
        },
    )
    .expect("reset replacement");
    assert!(restored.replacements.is_empty());
    assert_eq!(
        restored.workflow_revision,
        loaded.workflow.workflow_revision
    );
}

#[test]
fn promotion_crosses_into_a_native_graph_without_losing_the_source() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let invocation = loaded
        .workflow
        .invocations
        .iter()
        .find(|invocation| invocation.name == "TOOL")
        .expect("source TOOL invocation");
    let replaced = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::ReplaceInvocation {
                invocation_id: invocation.id.clone(),
                operator: "align.bowtie2".to_owned(),
                operator_revision: format!("blake3:{}", "c".repeat(64)),
                params: std::collections::BTreeMap::from([(
                    "threads".to_owned(),
                    ParamValue::Int(8),
                )]),
            }],
        },
    )
    .expect("replacement");
    let source_graph = Graph {
        schema_version: SCHEMA_VERSION,
        name: Some("Pinned workflow".to_owned()),
        nodes: vec![Node {
            id: "source".to_owned(),
            operator: "workflow.source".to_owned(),
            operator_revision: format!("blake3:{}", "a".repeat(64)),
            ports: Vec::new(),
            params: std::collections::BTreeMap::new(),
            source_workflow: Some(replaced.clone()),
            layout: Layout { x: 20.0, y: 40.0 },
            note: None,
            color: None,
        }],
        edges: Vec::new(),
        annotations: Vec::new(),
        variant_origin: None,
    };
    let promoted_node = Node {
        id: "bowtie2".to_owned(),
        operator: "align.bowtie2".to_owned(),
        operator_revision: format!("blake3:{}", "c".repeat(64)),
        ports: vec![
            Port {
                name: "r1".to_owned(),
                dir: Direction::In,
                ty: PortType::Fastq,
                union: vec![PortType::FastqGz],
                optional: false,
            },
            Port {
                name: "sam".to_owned(),
                dir: Direction::Out,
                ty: PortType::Sam,
                union: Vec::new(),
                optional: false,
            },
        ],
        params: std::collections::BTreeMap::from([("threads".to_owned(), ParamValue::Int(8))]),
        source_workflow: None,
        layout: Layout { x: 20.0, y: 40.0 },
        note: None,
        color: None,
    };

    let native = promote_invocation(
        &source_graph,
        &replaced.workflow_revision,
        &invocation.id,
        promoted_node,
    )
    .expect("promote into a native graph");

    assert_eq!(native.nodes.len(), 1);
    assert_eq!(native.nodes[0].operator, "align.bowtie2");
    assert!(native.nodes[0].source_workflow.is_none());
    let origin = native
        .variant_origin
        .as_ref()
        .expect("retained source origin");
    assert_eq!(
        origin.promoted_invocations.get(&invocation.id),
        Some(&"bowtie2".to_owned())
    );
    assert_eq!(
        origin
            .source_node
            .source_workflow
            .as_ref()
            .expect("source instance"),
        &replaced
    );
    native.validate().expect("native variant graph");

    assert_eq!(
        restore_source_workflow(&native).expect("restore source view"),
        source_graph
    );
}

#[test]
fn malformed_property_contracts_remain_local_and_cannot_abort_import() {
    let fixture = fixture();
    fs::write(
        fixture.root().join("nextflow_schema.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "$defs": {
                "advanced": {
                    "title": "bad\nsection",
                    "type": "object",
                    "required": ["needs_tool"],
                    "properties": {
                        "good": {"type": "string", "title": "Good value"},
                        "bad_bounds": {
                            "type": "number",
                            "minimum": 2,
                            "maximum": 1
                        },
                        "inapplicable_bounds": {
                            "type": "string",
                            "minimum": 1
                        },
                        "needs_tool": {
                            "type": "string",
                            "title": "bad\nlabel",
                            "bad\nkeyword": true
                        }
                    }
                }
            },
            "allOf": [{"$ref": "#/$defs/advanced"}]
        }))
        .expect("serialize adversarial parameter schema"),
    )
    .expect("write adversarial parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "adversarial parameter contracts",
        ],
    );

    let loaded = load_local(&fixture.request_at_head()).expect("fail-closed source workflow");
    assert_eq!(loaded.workflow.parameters.len(), 1);
    assert_eq!(loaded.workflow.parameters[0].name, "good");
    assert_eq!(loaded.workflow.parameters[0].group, "Advanced");
    assert_eq!(loaded.workflow.unsupported_required_parameters.len(), 1);
    let unsupported = &loaded.workflow.unsupported_required_parameters[0];
    assert_eq!(unsupported.name, "needs_tool");
    assert_eq!(unsupported.label, "Needs tool");
    assert_eq!(unsupported.group, "Advanced");
    assert!(!unsupported.reason.chars().any(char::is_control));
    assert!(loaded.workflow.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "unsupported_parameter_constraint"
            && diagnostic.message.contains("bad_bounds")
    }));
    assert!(loaded.workflow.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "unsupported_parameter_constraint"
            && diagnostic.message.contains("inapplicable_bounds")
    }));
}

#[test]
fn control_characters_in_unknown_group_keywords_cannot_poison_persisted_reasons() {
    let fixture = fixture();
    fs::write(
        fixture.root().join("nextflow_schema.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "type": "object",
            "$defs": {
                "locked": {
                    "type": "object",
                    "required": ["input"],
                    "properties": {"input": {"type": "string"}},
                    "bad\ngroup_keyword": true
                }
            },
            "allOf": [{"$ref": "#/$defs/locked"}]
        }))
        .expect("serialize hostile group keyword"),
    )
    .expect("write hostile group keyword");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "hostile group keyword",
        ],
    );

    let loaded = load_local(&fixture.request_at_head()).expect("fail-closed source workflow");
    assert!(!loaded.workflow.capabilities.parameter_edits);
    assert!(loaded.workflow.parameters.is_empty());
    assert_eq!(loaded.workflow.unsupported_required_parameters.len(), 1);
    let unsupported = &loaded.workflow.unsupported_required_parameters[0];
    assert_eq!(unsupported.name, "input");
    assert!(!unsupported.reason.chars().any(char::is_control));
    assert!(unsupported.reason.contains("bad\\ngroup_keyword"));
}

#[test]
fn duplicate_and_malformed_schema_containers_remain_source_only_without_aborting_import() {
    let schemas: &[(&str, &[u8])] = &[
        (
            "duplicate root properties",
            br#"{"type":"object","properties":{},"properties":{"good":{"type":"string"}}}"#,
        ),
        (
            "duplicate group properties",
            br##"{"type":"object","$defs":{"io":{"type":"object","properties":{},"properties":{"good":{"type":"string"}}}},"allOf":[{"$ref":"#/$defs/io"}]}"##,
        ),
        (
            "non-object root properties",
            br#"{"type":"object","properties":[]}"#,
        ),
        (
            "non-object definitions",
            br#"{"type":"object","$defs":true}"#,
        ),
        (
            "non-object active group properties",
            br##"{"type":"object","$defs":{"io":{"type":"object","properties":[]}},"allOf":[{"$ref":"#/$defs/io"}]}"##,
        ),
    ];

    for (label, schema) in schemas {
        let fixture = fixture();
        fs::write(fixture.root().join("nextflow_schema.json"), schema)
            .expect("write malformed schema container");
        git(fixture.root(), &["add", "nextflow_schema.json"]);
        git(
            fixture.root(),
            &[
                "-c",
                "user.name=Somite Test",
                "-c",
                "user.email=somite@example.invalid",
                "commit",
                "--quiet",
                "-m",
                label,
            ],
        );

        let loaded = load_local(&fixture.request_at_head())
            .unwrap_or_else(|error| panic!("{label} must stay source-only: {error}"));
        assert!(!loaded.workflow.capabilities.parameter_edits, "{label}");
        assert!(
            loaded
                .workflow
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == "unsupported_schema_container" }),
            "{label}: {:#?}",
            loaded.workflow.diagnostics
        );
    }
}

#[test]
fn annotated_tag_at_head_persists_the_peeled_commit_revision() {
    let fixture = fixture();
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "tag",
            "--annotate",
            "v2.0.0",
            "--message",
            "fixture tag",
        ],
    );
    let tag_object = git(fixture.root(), &["rev-parse", "refs/tags/v2.0.0"])
        .trim()
        .to_owned();
    let commit = git(
        fixture.root(),
        &["rev-parse", "--verify", "refs/tags/v2.0.0^{commit}"],
    )
    .trim()
    .to_owned();
    assert_ne!(tag_object, commit);
    fs::write(fixture.root().join(".git/HEAD"), format!("{tag_object}\n"))
        .expect("detach HEAD at the annotated tag object");
    assert_eq!(
        git(fixture.root(), &["rev-parse", "HEAD"]).trim(),
        tag_object
    );

    let mut request = fixture.request();
    request.requested_revision = "v2.0.0".to_owned();
    request.expected_resolved_revision.clone_from(&commit);
    let loaded = load_local(&request).expect("annotated-tag HEAD must peel to its commit");
    assert_eq!(loaded.workflow.source.resolved_revision, commit);

    let frozen = freeze_local(fixture.root(), &loaded.workflow)
        .expect("freeze must re-resolve the same peeled commit");
    let persisted: serde_json::Value =
        serde_json::from_slice(&frozen.workflow_json).expect("persisted workflow JSON");
    assert_eq!(persisted["source"]["resolved_revision"], commit);
    assert_ne!(persisted["source"]["resolved_revision"], tag_object);
}

#[test]
fn requested_revision_must_exist_and_resolve_to_the_pinned_head() {
    let fixture = fixture();
    let mut missing = fixture.request();
    missing.requested_revision = "does-not-exist".to_owned();
    assert!(matches!(
        load_local(&missing),
        Err(SourceWorkflowError::GitFailed {
            operation: "requested revision",
            ..
        })
    ));

    fs::write(
        fixture.root().join("main.nf"),
        "nextflow.enable.dsl = 2\nworkflow {}\n",
    )
    .expect("second source revision");
    git(fixture.root(), &["add", "main.nf"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "second revision",
        ],
    );
    let current = git(fixture.root(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let mut mismatched = fixture.request();
    mismatched.expected_resolved_revision = current.clone();
    assert!(matches!(
        load_local(&mismatched),
        Err(SourceWorkflowError::RequestedRevisionMismatch {
            requested,
            expected,
            actual,
        }) if requested == "v1.0.0" && expected == current && actual == fixture.commit
    ));
}

#[test]
fn parameter_transactions_are_atomic_revision_checked_and_validated() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let base = &loaded.workflow;
    let edited = apply(
        base,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![
                SemanticEdit::SetParameter {
                    name: "threads".to_owned(),
                    binding: WorkflowBinding::Literal {
                        value: ParamValue::Int(6),
                    },
                },
                SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: "data/input.fa.gz".to_owned(),
                    },
                },
            ],
        },
    )
    .expect("valid transaction");
    assert_ne!(edited.workflow_revision, base.workflow_revision);
    assert_eq!(edited.source.source_digest, base.source.source_digest);
    assert_eq!(edited.bindings.len(), 2);

    let stale = apply(
        &edited,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![],
        },
    );
    assert!(matches!(
        stale,
        Err(SourceWorkflowError::StaleRevision { .. })
    ));

    for binding in [
        WorkflowBinding::Literal {
            value: ParamValue::String("six".to_owned()),
        },
        WorkflowBinding::Literal {
            value: ParamValue::Int(99),
        },
    ] {
        let invalid = apply(
            base,
            &EditTransaction {
                base_workflow_revision: base.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "threads".to_owned(),
                    binding,
                }],
            },
        );
        assert!(matches!(
            invalid,
            Err(SourceWorkflowError::InvalidParameter { .. })
        ));
    }

    let atomic_failure = apply(
        base,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![
                SemanticEdit::SetParameter {
                    name: "threads".to_owned(),
                    binding: WorkflowBinding::Literal {
                        value: ParamValue::Int(5),
                    },
                },
                SemanticEdit::ResetParameter {
                    name: "not_a_parameter".to_owned(),
                },
            ],
        },
    );
    assert!(matches!(
        atomic_failure,
        Err(SourceWorkflowError::UnknownParameter(_))
    ));
    assert!(base.bindings.is_empty());

    let reset = apply(
        &edited,
        &EditTransaction {
            base_workflow_revision: edited.workflow_revision.clone(),
            edits: vec![SemanticEdit::ResetParameter {
                name: "threads".to_owned(),
            }],
        },
    )
    .expect("reset parameter");
    assert!(!reset.bindings.contains_key("threads"));
}

#[test]
fn public_apply_rejects_integer_bindings_that_json_cannot_represent_exactly() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    let mut schema: serde_json::Value =
        serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
            .expect("parse parameter schema");
    schema["$defs"]["io"]["properties"]["large_id"] = serde_json::json!({"type": "integer"});
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "safe integer parameter",
        ],
    );
    let request = fixture.request_at_head();
    let loaded = load_local(&request).expect("integer source workflow");

    for value in [MIN_EXACT_JSON_INTEGER, MAX_EXACT_JSON_INTEGER] {
        let edited = apply(
            &loaded.workflow,
            &EditTransaction {
                base_workflow_revision: loaded.workflow.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "large_id".to_owned(),
                    binding: WorkflowBinding::Literal {
                        value: ParamValue::Int(value),
                    },
                }],
            },
        )
        .expect("exact JSON integer boundary");
        assert_eq!(
            edited.bindings.get("large_id"),
            Some(&WorkflowBinding::Literal {
                value: ParamValue::Int(value)
            })
        );
    }
    for value in [
        MIN_EXACT_JSON_INTEGER - 1,
        MAX_EXACT_JSON_INTEGER + 1,
        MAX_EXACT_JSON_INTEGER + 2,
    ] {
        assert!(matches!(
            apply(
                &loaded.workflow,
                &EditTransaction {
                    base_workflow_revision: loaded.workflow.workflow_revision.clone(),
                    edits: vec![SemanticEdit::SetParameter {
                        name: "large_id".to_owned(),
                        binding: WorkflowBinding::Literal {
                            value: ParamValue::Int(value),
                        },
                    }],
                },
            ),
            Err(SourceWorkflowError::InvalidParameter { parameter, .. }) if parameter == "large_id"
        ));
    }
}

#[test]
fn source_number_contracts_and_edits_canonicalize_browser_unstable_floats() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    let mut schema: serde_json::Value =
        serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
            .expect("parse parameter schema");
    schema["$defs"]["io"]["properties"]["threshold"] =
        serde_json::from_str(r#"{"type":"number","minimum":-0.0,"enum":[1.0,-0.0],"default":1.0}"#)
            .expect("number parameter schema");
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "canonical number parameter",
        ],
    );
    let loaded = load_local(&fixture.request_at_head()).expect("number source workflow");
    let threshold = loaded
        .workflow
        .parameters
        .iter()
        .find(|parameter| parameter.name == "threshold")
        .expect("threshold parameter");
    assert_eq!(threshold.default, Some(ParamValue::Int(1)));
    assert_eq!(
        threshold.choices,
        vec![ParamValue::Int(1), ParamValue::Int(0)]
    );
    let minimum = threshold.minimum.expect("threshold minimum");
    assert_eq!(minimum, 0.0);
    assert!(!minimum.is_sign_negative());

    for (input, canonical) in [(1.0, 1), (-0.0, 0)] {
        let edited = apply(
            &loaded.workflow,
            &EditTransaction {
                base_workflow_revision: loaded.workflow.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "threshold".to_owned(),
                    binding: WorkflowBinding::Literal {
                        value: ParamValue::Float(input),
                    },
                }],
            },
        )
        .expect("canonicalized numeric source edit");
        assert_eq!(
            edited.bindings.get("threshold"),
            Some(&WorkflowBinding::Literal {
                value: ParamValue::Int(canonical)
            })
        );
        edited.validate().expect("browser-stable edited workflow");
    }

    assert!(matches!(
        apply(
            &loaded.workflow,
            &EditTransaction {
                base_workflow_revision: loaded.workflow.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "threshold".to_owned(),
                    binding: WorkflowBinding::Literal {
                        value: ParamValue::Float((MAX_EXACT_JSON_INTEGER + 1) as f64),
                    },
                }],
            },
        ),
        Err(SourceWorkflowError::InvalidParameter { parameter, .. }) if parameter == "threshold"
    ));
}

#[test]
fn project_path_bindings_cannot_bypass_schema_or_path_safety() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let base = &loaded.workflow;

    let invalid = [
        (
            "threads",
            WorkflowBinding::ProjectFile {
                path: "data/value.txt".to_owned(),
            },
        ),
        (
            "input",
            WorkflowBinding::ProjectDirectory {
                path: "data/input".to_owned(),
            },
        ),
        (
            "outdir",
            WorkflowBinding::ProjectFile {
                path: "results.txt".to_owned(),
            },
        ),
        (
            "input",
            WorkflowBinding::Literal {
                value: ParamValue::String("data/input.fa.gz".to_owned()),
            },
        ),
        (
            "input",
            WorkflowBinding::ProjectFile {
                path: "/tmp/input.fa.gz".to_owned(),
            },
        ),
        (
            "input",
            WorkflowBinding::ProjectFile {
                path: "../input.fa.gz".to_owned(),
            },
        ),
        (
            "input",
            WorkflowBinding::ProjectFile {
                path: "data/input.txt".to_owned(),
            },
        ),
    ];
    for (name, binding) in invalid {
        let result = apply(
            base,
            &EditTransaction {
                base_workflow_revision: base.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: name.to_owned(),
                    binding,
                }],
            },
        );
        assert!(
            matches!(result, Err(SourceWorkflowError::InvalidParameter { .. })),
            "{name} unexpectedly accepted an invalid project binding"
        );
    }

    for (name, binding) in [
        (
            "input",
            WorkflowBinding::ProjectFile {
                path: "data/input.fa.gz".to_owned(),
            },
        ),
        (
            "outdir",
            WorkflowBinding::ProjectDirectory {
                path: "results".to_owned(),
            },
        ),
    ] {
        apply(
            base,
            &EditTransaction {
                base_workflow_revision: base.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: name.to_owned(),
                    binding,
                }],
            },
        )
        .expect("valid project binding");
    }
}

#[test]
fn project_path_bindings_enforce_schema_enum_choices() {
    let fixture = fixture();
    let mut base = load_local(&fixture.request())
        .expect("source workflow")
        .workflow;
    base.parameters
        .iter_mut()
        .find(|parameter| parameter.name == "input")
        .expect("input parameter")
        .choices = vec![
        ParamValue::String("data/allowed.fa".to_owned()),
        ParamValue::String("data/other.fasta.gz".to_owned()),
    ];
    base.workflow_revision = workflow_revision(&base).expect("revised path enum contract");

    let rejected = apply(
        &base,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "data/not-allowed.fa".to_owned(),
                },
            }],
        },
    );
    assert!(matches!(
        rejected,
        Err(SourceWorkflowError::InvalidParameter { parameter, .. }) if parameter == "input"
    ));

    let edited = apply(
        &base,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "data/allowed.fa".to_owned(),
                },
            }],
        },
    )
    .expect("allowed path enum choice");
    assert_eq!(
        edited.bindings.get("input"),
        Some(&WorkflowBinding::ProjectFile {
            path: "data/allowed.fa".to_owned()
        })
    );

    let mut forged = base;
    forged
        .parameters
        .iter_mut()
        .find(|parameter| parameter.name == "input")
        .expect("input parameter")
        .choices = vec![ParamValue::String("   ".to_owned())];
    assert!(matches!(
        workflow_revision(&forged),
        Err(SourceWorkflowError::InvalidParameter { parameter, .. }) if parameter == "input"
    ));
}

#[test]
fn pangenome_fasta_pattern_is_enforced_for_project_files() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let base = &loaded.workflow;

    for path in ["data/genome.fa", "data/genome.fna", "data/genome.fasta.gz"] {
        apply(
            base,
            &EditTransaction {
                base_workflow_revision: base.workflow_revision.clone(),
                edits: vec![SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: path.to_owned(),
                    },
                }],
            },
        )
        .expect("FASTA project path");
    }

    let repeated = apply(
        base,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![
                SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: "data/first.fa".to_owned(),
                    },
                },
                SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: "data/final.fasta.gz".to_owned(),
                    },
                },
            ],
        },
    )
    .expect("repeated patterned edits");
    assert_eq!(
        repeated.bindings.get("input"),
        Some(&WorkflowBinding::ProjectFile {
            path: "data/final.fasta.gz".to_owned(),
        })
    );

    let invalid = apply(
        base,
        &EditTransaction {
            base_workflow_revision: base.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "data/genome.fastq.gz".to_owned(),
                },
            }],
        },
    );
    assert!(matches!(
        invalid,
        Err(SourceWorkflowError::InvalidParameter { .. })
    ));

    let mut forged = base.clone();
    forged.bindings.insert(
        "input".to_owned(),
        WorkflowBinding::ProjectFile {
            path: "data/genome.fastq.gz".to_owned(),
        },
    );
    assert!(matches!(
        workflow_revision(&forged),
        Err(SourceWorkflowError::InvalidParameter { .. })
    ));
}

#[test]
fn unsupported_schema_pattern_is_source_only_without_locking_independent_edits() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    let mut schema: serde_json::Value =
        serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
            .expect("parse parameter schema");
    schema["$defs"]["io"]["properties"]["input"]["pattern"] =
        serde_json::json!("^(?=genome).+\\.fa$");
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "unsupported pattern",
        ],
    );
    let request = fixture.request_at_head();

    let loaded = load_local(&request).expect("source workflow with retained schema");
    assert!(loaded.workflow.capabilities.parameter_edits);
    assert!(loaded
        .workflow
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "unsupported_parameter_pattern"));
    assert!(loaded
        .workflow
        .unsupported_required_parameters
        .iter()
        .any(|parameter| parameter.name == "input"
            && parameter.reason.contains("ECMA-262-compatible")));
    assert!(!loaded
        .workflow
        .parameters
        .iter()
        .any(|parameter| parameter.name == "input"));
    let invalid = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "genome.fa".to_owned(),
                },
            }],
        },
    );
    assert!(matches!(
        invalid,
        Err(SourceWorkflowError::UnknownParameter(name)) if name == "input"
    ));

    let edited = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "threads".to_owned(),
                binding: WorkflowBinding::Literal {
                    value: ParamValue::Int(6),
                },
            }],
        },
    )
    .expect("an independently proven parameter remains editable");
    assert_eq!(
        edited.bindings.get("threads"),
        Some(&WorkflowBinding::Literal {
            value: ParamValue::Int(6)
        })
    );

    let mut forged = loaded.workflow.clone();
    forged.bindings.insert(
        "input".to_owned(),
        WorkflowBinding::ProjectFile {
            path: "genome.fa".to_owned(),
        },
    );
    assert!(matches!(
        workflow_revision(&forged),
        Err(SourceWorkflowError::UnknownParameter(name)) if name == "input"
    ));
}

#[test]
fn patterned_values_outside_printable_ascii_are_rejected_fail_closed() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let edit = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "data/génome.fa".to_owned(),
                },
            }],
        },
    );
    assert!(matches!(
        edit,
        Err(SourceWorkflowError::InvalidParameter { parameter, detail })
            if parameter == "input" && detail.contains("printable ASCII")
    ));
}

#[test]
fn invalid_patterned_enum_and_default_do_not_abort_source_import() {
    for (field, value, diagnostic_code) in [
        (
            "enum",
            serde_json::json!(["genome.fa", "génome.fa"]),
            "unsupported_parameter_enum",
        ),
        (
            "default",
            serde_json::json!("genome.fastq"),
            "unsupported_parameter_default",
        ),
    ] {
        let fixture = fixture();
        let schema_path = fixture.root().join("nextflow_schema.json");
        let mut schema: serde_json::Value =
            serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
                .expect("parse parameter schema");
        schema["$defs"]["io"]["properties"]["input"][field] = value;
        fs::write(
            &schema_path,
            serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
        )
        .expect("write parameter schema");
        git(fixture.root(), &["add", "nextflow_schema.json"]);
        git(
            fixture.root(),
            &[
                "-c",
                "user.name=Somite Test",
                "-c",
                "user.email=somite@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "invalid patterned schema annotation",
            ],
        );
        let request = fixture.request_at_head();

        let loaded = load_local(&request).expect("import retains unsupported contract");
        assert!(loaded.workflow.capabilities.parameter_edits);
        assert!(loaded
            .workflow
            .unsupported_required_parameters
            .iter()
            .any(|parameter| parameter.name == "input"));
        assert!(!loaded
            .workflow
            .parameters
            .iter()
            .any(|parameter| parameter.name == "input"));
        assert!(loaded
            .workflow
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == diagnostic_code));
        assert_eq!(
            workflow_revision(&loaded.workflow).expect("self-consistent parsed workflow"),
            loaded.workflow.workflow_revision
        );
    }
}

#[test]
fn valid_empty_parameter_schema_has_no_false_unsafe_schema_capability() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "type": "object",
            "properties": {}
        }))
        .expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "empty parameter schema",
        ],
    );
    let request = fixture.request_at_head();

    let loaded = load_local(&request).expect("valid empty source schema");
    assert!(loaded.workflow.parameters.is_empty());
    assert!(loaded.workflow.unsupported_required_parameters.is_empty());
    assert!(loaded.workflow.capabilities.parameter_edits);
    assert_eq!(
        workflow_revision(&loaded.workflow).expect("self-consistent workflow"),
        loaded.workflow.workflow_revision
    );
}

#[test]
fn unsupported_required_schema_is_retained_without_locking_proven_parameter_edits() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    let mut schema: serde_json::Value =
        serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
            .expect("parse parameter schema");
    schema["$defs"]["io"]["required"] = serde_json::json!(["input", "outdir", "sample_overrides"]);
    schema["$defs"]["io"]["properties"]["sample_overrides"] = serde_json::json!({
        "title": "Sample overrides",
        "description": "Per-sample override records",
        "type": "array",
        "items": {"type": "object"}
    });
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "unsupported required parameter",
        ],
    );
    let request = fixture.request_at_head();

    let loaded = load_local(&request).expect("source workflow with retained requirement");
    assert!(loaded.workflow.capabilities.parameter_edits);
    assert_eq!(loaded.workflow.unsupported_required_parameters.len(), 1);
    let unsupported = &loaded.workflow.unsupported_required_parameters[0];
    assert_eq!(unsupported.name, "sample_overrides");
    assert_eq!(unsupported.label, "Sample overrides");
    assert_eq!(unsupported.group, "Input and output");
    assert_eq!(unsupported.description, "Per-sample override records");
    assert!(unsupported.reason.contains("supported primitive"));

    let edited = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "threads".to_owned(),
                binding: WorkflowBinding::Literal {
                    value: ParamValue::Int(6),
                },
            }],
        },
    )
    .expect("independently proven parameter edit");
    assert_eq!(
        edited.bindings.get("threads"),
        Some(&WorkflowBinding::Literal {
            value: ParamValue::Int(6)
        })
    );
    let unsupported_edit = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "sample_overrides".to_owned(),
                binding: WorkflowBinding::Literal {
                    value: ParamValue::String("samples.json".to_owned()),
                },
            }],
        },
    );
    assert!(matches!(
        unsupported_edit,
        Err(SourceWorkflowError::UnknownParameter(name)) if name == "sample_overrides"
    ));
    let no_op = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: Vec::new(),
        },
    )
    .expect("an empty transaction remains a valid identity operation");
    assert_eq!(no_op, loaded.workflow);

    assert_eq!(
        workflow_revision(&loaded.workflow).expect("mixed schema remains self-consistent"),
        loaded.workflow.workflow_revision
    );
}

#[test]
fn unsupported_optional_schema_is_diagnostic_without_locking_input() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    let mut schema: serde_json::Value =
        serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
            .expect("parse parameter schema");
    schema["$defs"]["io"]["properties"]["sample_overrides"] = serde_json::json!({
        "title": "Sample overrides",
        "type": "string",
        "schema": "assets/samplesheet_schema.json"
    });
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "unsupported optional parameter",
        ],
    );
    let request = fixture.request_at_head();

    let loaded = load_local(&request).expect("mixed optional source schema");
    assert!(loaded.workflow.capabilities.parameter_edits);
    assert!(loaded.workflow.unsupported_required_parameters.is_empty());
    assert!(!loaded
        .workflow
        .parameters
        .iter()
        .any(|parameter| parameter.name == "sample_overrides"));
    assert!(loaded.workflow.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "unsupported_parameter_constraint"
            && diagnostic.message.contains("sample_overrides")
    }));

    let edited = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "data/genome.fa".to_owned(),
                },
            }],
        },
    )
    .expect("proven input edit");
    assert!(edited.bindings.contains_key("input"));
}

#[test]
fn duplicate_optional_unsupported_parameter_cannot_hide_a_later_requirement() {
    let fixture = fixture();
    let schema_path = fixture.root().join("nextflow_schema.json");
    let mut schema: serde_json::Value =
        serde_json::from_slice(&fs::read(&schema_path).expect("parameter schema"))
            .expect("parse parameter schema");
    schema["$defs"]["first"] = serde_json::json!({
        "type": "object",
        "properties": {"shadowed": {"type": "array"}}
    });
    schema["$defs"]["second"] = serde_json::json!({
        "type": "object",
        "required": ["shadowed"],
        "properties": {"shadowed": {"type": "array", "title": "Shadowed input"}}
    });
    schema["allOf"] = serde_json::json!([
        {"$ref": "#/$defs/first"},
        {"$ref": "#/$defs/second"}
    ]);
    fs::write(
        &schema_path,
        serde_json::to_vec_pretty(&schema).expect("serialize parameter schema"),
    )
    .expect("write parameter schema");
    git(fixture.root(), &["add", "nextflow_schema.json"]);
    git(
        fixture.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "duplicate unsupported requirement",
        ],
    );
    let request = fixture.request_at_head();

    let loaded = load_local(&request).expect("source workflow");
    assert!(!loaded.workflow.capabilities.parameter_edits);
    let shadowed = loaded
        .workflow
        .unsupported_required_parameters
        .iter()
        .filter(|parameter| parameter.name == "shadowed")
        .collect::<Vec<_>>();
    assert_eq!(shadowed.len(), 1);
    assert!(shadowed[0].reason.contains("duplicate parameter"));
    let edit = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "threads".to_owned(),
                binding: WorkflowBinding::Literal {
                    value: ParamValue::Int(6),
                },
            }],
        },
    );
    assert!(matches!(
        edit,
        Err(SourceWorkflowError::ParameterEditsUnsupported)
    ));
}

#[test]
fn workflow_revision_tracks_only_execution_semantics() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let mut presentation = loaded.workflow.clone();
    presentation.parameters.reverse();
    presentation.parameters[0].label.push_str(" display");
    presentation.parameters[0].group.push_str(" display");
    presentation.parameters[0].description.push_str(" display");
    presentation.parameters[0].help.push_str(" display");
    presentation.parameters[0].hidden = !presentation.parameters[0].hidden;
    presentation.scopes[0].title.push_str(" display");
    presentation.diagnostics.clear();
    presentation.capabilities.exact_execution = true;
    presentation.capabilities.hierarchy_indexed = false;
    presentation.capabilities.parameter_edits = false;
    presentation
        .unsupported_required_parameters
        .push(UnsupportedRequiredWorkflowParameter {
            name: "source_only_metadata".into(),
            label: "Source-only metadata".into(),
            group: "Source-only".into(),
            description: String::new(),
            reason: "type is not a supported primitive".into(),
            hidden: false,
        });
    assert_eq!(
        workflow_revision(&presentation).expect("presentation-only revision"),
        loaded.workflow.workflow_revision
    );

    let parameter = presentation
        .parameters
        .iter_mut()
        .find(|parameter| parameter.name == "threads")
        .expect("threads parameter");
    parameter.maximum = Some(9.0);
    assert_ne!(
        workflow_revision(&presentation).expect("changed contract revision"),
        loaded.workflow.workflow_revision
    );

    let mut forged = loaded.workflow.clone();
    forged.bindings.insert(
        "input".to_owned(),
        WorkflowBinding::Literal {
            value: ParamValue::String("data/genome.fa".to_owned()),
        },
    );
    assert!(matches!(
        workflow_revision(&forged),
        Err(SourceWorkflowError::InvalidParameter { .. })
    ));
}

#[test]
fn freeze_is_deterministic_and_contains_only_verified_bytes() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let edited = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![
                SemanticEdit::SetParameter {
                    name: "input".to_owned(),
                    binding: WorkflowBinding::ProjectFile {
                        path: "data/input.fa.gz".to_owned(),
                    },
                },
                SemanticEdit::SetParameter {
                    name: "threads".to_owned(),
                    binding: WorkflowBinding::Literal {
                        value: ParamValue::Int(6),
                    },
                },
            ],
        },
    )
    .expect("parameter edits");

    let first = freeze_local(fixture.root(), &edited).expect("first freeze");
    let second = freeze_local(fixture.root(), &edited).expect("second freeze");
    assert_eq!(first, second);
    assert_eq!(first.source_files.len(), 3);
    assert_eq!(first.manifest.source, loaded.source_manifest);
    assert!(first.manifest.freeze_digest.starts_with("blake3:"));

    let params: serde_json::Value =
        serde_json::from_slice(&first.params_json).expect("frozen params JSON");
    assert_eq!(params["input"], "data/input.fa.gz");
    assert_eq!(params["threads"], 6);
    assert!(params.get("outdir").is_none());
    for file in &first.source_files {
        let identity = first
            .manifest
            .source
            .files
            .iter()
            .find(|identity| identity.path == file.path)
            .expect("frozen file identity");
        assert_eq!(
            identity.digest,
            format!("blake3:{}", blake3::hash(&file.bytes).to_hex())
        );
    }

    fs::write(fixture.root().join("main.nf"), "workflow { BROKEN() }\n").expect("mutate checkout");
    let after_worktree_mutation =
        freeze_local(fixture.root(), &edited).expect("freeze remains pinned to commit blobs");
    assert_eq!(after_worktree_mutation, first);
}

#[test]
fn frozen_bytes_reindex_to_the_same_derived_contract_and_reject_tampering() {
    let fixture = fixture();
    let loaded = load_local(&fixture.request()).expect("source workflow");
    let frozen = freeze_local(fixture.root(), &loaded.workflow).expect("frozen source");

    let reindexed = reindex_frozen(
        &frozen.manifest.source,
        &frozen.source_files,
        &frozen.manifest.entrypoint,
    )
    .expect("byte-backed reindex");
    assert_eq!(reindexed.parameters, loaded.workflow.parameters);
    assert_eq!(
        reindexed.unsupported_required_parameters,
        loaded.workflow.unsupported_required_parameters
    );
    assert_eq!(reindexed.scopes, loaded.workflow.scopes);
    assert_eq!(reindexed.invocations, loaded.workflow.invocations);
    assert_eq!(reindexed.capabilities, loaded.workflow.capabilities);
    assert_eq!(reindexed.diagnostics, loaded.workflow.diagnostics);
    assert_eq!(
        reindexed.parameter_schema_digest,
        loaded.parameter_schema_digest
    );

    let mut tampered = frozen.source_files.clone();
    tampered[0].bytes.push(b'\n');
    assert!(matches!(
        reindex_frozen(
            &frozen.manifest.source,
            &tampered,
            &frozen.manifest.entrypoint
        ),
        Err(SourceWorkflowError::SourceChanged { .. })
    ));
}

#[test]
fn dirty_and_untracked_worktree_bytes_are_ignored_but_wrong_revision_is_rejected() {
    let dirty = fixture();
    let clean = load_local(&dirty.request()).expect("clean committed source");
    fs::write(dirty.root().join("main.nf"), "workflow { CHANGED() }\n").expect("dirty source");
    let loaded = load_local(&dirty.request()).expect("dirty worktree is not source truth");
    assert_eq!(loaded.source_manifest, clean.source_manifest);
    let frozen = freeze_local(dirty.root(), &loaded.workflow).expect("commit-backed freeze");
    let main = frozen
        .source_files
        .iter()
        .find(|file| file.path == "main.nf")
        .expect("committed entrypoint");
    assert_ne!(
        main.bytes,
        fs::read(dirty.root().join("main.nf")).expect("raw dirty worktree bytes")
    );

    let untracked = fixture();
    fs::write(untracked.root().join("untracked.txt"), "not pinned\n").expect("untracked file");
    let loaded = load_local(&untracked.request()).expect("untracked worktree file is ignored");
    assert!(!loaded
        .source_manifest
        .files
        .iter()
        .any(|file| file.path == "untracked.txt"));

    let wrong = fixture();
    let mut request = wrong.request();
    request.expected_resolved_revision = "0000000000000000000000000000000000000000".to_owned();
    assert!(matches!(
        load_local(&request),
        Err(SourceWorkflowError::RevisionMismatch { .. })
    ));
}

#[cfg(unix)]
#[test]
fn tracked_symlinks_and_submodules_are_rejected() {
    use std::os::unix::fs::symlink;

    let linked = fixture();
    symlink("main.nf", linked.root().join("linked.nf")).expect("source symlink");
    git(linked.root(), &["add", "linked.nf"]);
    git(
        linked.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "add symlink",
        ],
    );
    let request = linked.request_at_head();
    assert!(matches!(
        load_local(&request),
        Err(SourceWorkflowError::UnsupportedTrackedEntry {
            kind: "symlink",
            ..
        })
    ));

    let submodule_parent = fixture();
    let child = fixture();
    git_with_file_protocol(
        submodule_parent.root(),
        &[
            "submodule",
            "add",
            "--quiet",
            child.root().to_str().expect("UTF-8 child path"),
            "vendor/child",
        ],
    );
    git(
        submodule_parent.root(),
        &[
            "-c",
            "user.name=Somite Test",
            "-c",
            "user.email=somite@example.invalid",
            "commit",
            "--quiet",
            "-am",
            "add submodule",
        ],
    );
    let request = submodule_parent.request_at_head();
    assert!(matches!(
        load_local(&request),
        Err(SourceWorkflowError::UnsupportedTrackedEntry {
            kind: "submodule",
            ..
        })
    ));
}

#[cfg(unix)]
fn git_with_file_protocol(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg("protocol.file.allow=always")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("start Git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("UTF-8 Git output")
}

#[test]
#[ignore = "requires the local Nextflow nf-core/pangenome 1.1.3 asset checkout"]
fn pinned_local_pangenome_acceptance() {
    let Some(root) = std::env::var_os("SOMITE_PANGENOME_SOURCE").map(PathBuf::from) else {
        return;
    };
    if !root.is_dir() {
        return;
    }
    let loaded = load_local(&LoadLocalRequest {
        root,
        provider: SourceProvider::NfCore,
        repository: "nf-core/pangenome".to_owned(),
        requested_revision: "1.1.3".to_owned(),
        expected_resolved_revision: "3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337".to_owned(),
        entrypoint: "main.nf".to_owned(),
        profiles: Vec::new(),
    })
    .expect("pinned pangenome source");

    let workflow_bytes = serde_json::to_vec(&loaded.workflow).expect("serialize workflow");
    assert_eq!(
        format!("blake3:{}", blake3::hash(&workflow_bytes).to_hex()),
        "blake3:bc8c4fd5a97e3ad9423c80c2588a8813b25bfec5f7072dae6125c225515cafc2"
    );

    assert_eq!(loaded.workflow.source.file_count, 170);
    assert_eq!(loaded.workflow.source.source_bytes, 1_286_324);
    // 61 proven leaf parameter contracts across the eight schema groups. The
    // two optional email fields remain source-only because their counted
    // regex quantifiers are outside the deliberately shared regex subset.
    assert_eq!(
        loaded.workflow.parameters.len(),
        61,
        "diagnostics: {:#?}",
        loaded.workflow.diagnostics
    );
    assert!(loaded.workflow.unsupported_required_parameters.is_empty());
    assert_eq!(
        loaded
            .workflow
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "unsupported_parameter_pattern")
            .count(),
        2
    );
    assert!(loaded.workflow.capabilities.parameter_edits);
    assert!(loaded
        .workflow
        .parameters
        .iter()
        .any(|parameter| parameter.name == "input"));
    let edited = apply(
        &loaded.workflow,
        &EditTransaction {
            base_workflow_revision: loaded.workflow.workflow_revision.clone(),
            edits: vec![SemanticEdit::SetParameter {
                name: "input".to_owned(),
                binding: WorkflowBinding::ProjectFile {
                    path: "data/genome.fa".to_owned(),
                },
            }],
        },
    )
    .expect("pinned pangenome input must remain editable");
    assert_eq!(
        edited.bindings.get("input"),
        Some(&WorkflowBinding::ProjectFile {
            path: "data/genome.fa".to_owned()
        })
    );
    assert_eq!(
        loaded
            .workflow
            .scopes
            .iter()
            .filter(|scope| scope.kind == SourceScopeKind::EntryWorkflow)
            .count(),
        1
    );
    assert_eq!(
        loaded
            .workflow
            .scopes
            .iter()
            .filter(|scope| scope.kind == SourceScopeKind::Process)
            .count(),
        22
    );
    assert!(loaded.workflow.scopes.iter().any(|scope| {
        scope.kind == SourceScopeKind::Workflow
            && scope.symbol.as_deref() == Some("NFCORE_PANGENOME")
    }));
    assert!(loaded
        .workflow
        .invocations
        .iter()
        .any(|invocation| { invocation.name == "PANGENOME" && invocation.callee.is_some() }));
    assert!(!loaded.workflow.capabilities.exact_execution);
}
