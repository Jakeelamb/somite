//! A pure, one-way compiler from a native Somite graph to a self-contained
//! Nextflow DSL2 workflow. Runtime supervision remains outside this module.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value};
use somite_ir::{Direction, Graph, Node, ParamValue, PortType};
use somite_ops::{Catalog, OpKind, Operator, OutputSpec, ParamSpec};
use thiserror::Error;

pub const PINNED_NEXTFLOW_VERSION: &str = "26.04.6";
pub const PINNED_OPENJDK_VERSION: &str = "25.0.2";

/// Everything needed to write a compiled workflow directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledWorkflow {
    pub main_nf: String,
    pub nextflow_config: String,
    pub params_json: String,
    pub node_map_json: String,
    pub pixi_toml: String,
}

/// Values which belong to the compiled workflow rather than an Operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileOptions {
    pub workflow_name: String,
    pub output_dir: String,
    pub platforms: Vec<String>,
    pub nextflow_version: String,
    pub openjdk_version: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CompileError {
    #[error("invalid graph: {0}")]
    InvalidGraph(String),
    #[error("invalid compile option {field}: {detail}")]
    InvalidOption { field: &'static str, detail: String },
    #[error("node {node} uses unknown operator {operator}")]
    UnknownOperator { node: String, operator: String },
    #[error("node {node} is a structural reference and cannot be executed")]
    ReferenceNode { node: String },
    #[error("node {node} uses unsupported in-process operator {operator}")]
    UnsupportedInprocess { node: String, operator: String },
    #[error("node {node} attempts to nest workflow engine {binary}")]
    NestedEngine { node: String, binary: String },
    #[error("node {node} ports do not match operator {operator}")]
    PortContractMismatch { node: String, operator: String },
    #[error("node {node} has unknown parameter {parameter}")]
    UnknownParameter { node: String, parameter: String },
    #[error("node {node} is missing required parameter {parameter}")]
    MissingParameter { node: String, parameter: String },
    #[error("node {node} parameter {parameter}: {detail}")]
    InvalidParameter {
        node: String,
        parameter: String,
        detail: String,
    },
    #[error("import node {node} is missing string path parameter {parameter}")]
    MissingImportPath { node: String, parameter: String },
    #[error("node {node} input {port} has no source")]
    MissingInput { node: String, port: String },
    #[error("node {node} input {port} has more than one source")]
    MultipleInputs { node: String, port: String },
    #[error("node {node} input {port} references unavailable source {source_node}.{source_port}")]
    UnavailableSource {
        node: String,
        port: String,
        source_node: String,
        source_port: String,
    },
    #[error("operator {operator} has no executable binary")]
    MissingBinary { operator: String },
    #[error("operator {operator} argv: {detail}")]
    InvalidArgv { operator: String, detail: String },
    #[error("operator {operator} output {output}: {detail}")]
    InvalidOutput {
        operator: String,
        output: String,
        detail: String,
    },
    #[error("could not serialize {artifact}: {detail}")]
    Serialize {
        artifact: &'static str,
        detail: String,
    },
}

/// Compile a Graph and the exact Catalog snapshot it references.
///
/// This is the Module's only Interface. It performs no filesystem, process, or
/// network I/O and either returns all generated files or no partial result.
pub fn compile(
    graph: &Graph,
    catalog: &Catalog,
    options: &CompileOptions,
) -> Result<CompiledWorkflow, CompileError> {
    graph
        .validate()
        .map_err(|error| CompileError::InvalidGraph(error.to_string()))?;
    validate_options(options)?;

    let mut params_inputs = Map::new();
    let mut params_values = Map::new();
    let mut channels = BTreeMap::<(String, String), String>::new();
    let mut process_blocks = Vec::new();
    let mut workflow_lines = Vec::new();
    let mut node_map = BTreeMap::<String, NodeMapEntry>::new();
    let mut packages = BTreeSet::<String>::new();

    for node_id in graph.topo() {
        let node = graph
            .node(&node_id)
            .ok_or_else(|| CompileError::InvalidGraph(format!("missing node {node_id}")))?;
        let operator =
            catalog
                .ops
                .get(&node.operator)
                .ok_or_else(|| CompileError::UnknownOperator {
                    node: node.id.clone(),
                    operator: node.operator.clone(),
                })?;

        match operator.kind {
            OpKind::Reference => {
                return Err(CompileError::ReferenceNode {
                    node: node.id.clone(),
                })
            }
            OpKind::Inprocess => {
                compile_import(
                    node,
                    operator,
                    &mut params_inputs,
                    &mut channels,
                    &mut workflow_lines,
                    &mut node_map,
                )?;
            }
            OpKind::External => {
                let compiled = compile_external(
                    graph,
                    catalog,
                    node,
                    operator,
                    &channels,
                    &mut params_values,
                )?;
                for requirement in &operator.pixi {
                    packages.insert(requirement.clone());
                }
                for (port, expression) in &compiled.outputs {
                    channels.insert((node.id.clone(), port.clone()), expression.clone());
                }
                workflow_lines.push(compiled.invocation);
                process_blocks.push(compiled.process_block);
                node_map.insert(
                    node.id.clone(),
                    NodeMapEntry {
                        operator: node.operator.clone(),
                        process: Some(compiled.process_name),
                        kind: "process",
                    },
                );
            }
        }
    }

    let main_nf = render_main(&process_blocks, &workflow_lines);
    let nextflow_config = render_config();
    let params_json = pretty_json(
        "params.json",
        &serde_json::json!({
            "inputs": Value::Object(params_inputs),
            "outdir": options.output_dir,
            "values": Value::Object(params_values),
        }),
    )?;
    let node_map_json = pretty_json(
        "node-map.json",
        &serde_json::json!({
            "schema_version": 1,
            "nodes": node_map,
            "edges": sorted_edges(graph),
        }),
    )?;
    let pixi_toml = render_pixi(options, &packages);

    Ok(CompiledWorkflow {
        main_nf,
        nextflow_config,
        params_json,
        node_map_json,
        pixi_toml,
    })
}

#[derive(Serialize)]
struct NodeMapEntry {
    operator: String,
    process: Option<String>,
    kind: &'static str,
}

struct ExternalCompilation {
    process_name: String,
    process_block: String,
    invocation: String,
    outputs: BTreeMap<String, String>,
}

fn validate_options(options: &CompileOptions) -> Result<(), CompileError> {
    if options.workflow_name.trim().is_empty() {
        return Err(CompileError::InvalidOption {
            field: "workflow_name",
            detail: "must not be empty".into(),
        });
    }
    if options.platforms.is_empty() {
        return Err(CompileError::InvalidOption {
            field: "platforms",
            detail: "must contain at least one Pixi platform".into(),
        });
    }
    for platform in &options.platforms {
        if !safe_spec(platform) {
            return Err(CompileError::InvalidOption {
                field: "platforms",
                detail: format!("unsafe platform {platform:?}"),
            });
        }
    }
    for (field, version) in [
        ("nextflow_version", &options.nextflow_version),
        ("openjdk_version", &options.openjdk_version),
    ] {
        if !exact_version(version) {
            return Err(CompileError::InvalidOption {
                field,
                detail: "must be an exact dotted numeric version".into(),
            });
        }
    }
    Ok(())
}

fn compile_import(
    node: &Node,
    operator: &Operator,
    params_inputs: &mut Map<String, Value>,
    channels: &mut BTreeMap<(String, String), String>,
    workflow_lines: &mut Vec<String>,
    node_map: &mut BTreeMap<String, NodeMapEntry>,
) -> Result<(), CompileError> {
    if node.ports != operator.ir_ports() {
        return Err(CompileError::PortContractMismatch {
            node: node.id.clone(),
            operator: operator.id.clone(),
        });
    }
    let values = resolved_params(node, operator)?;
    let paths: &[(&str, &str)] = match operator.id.as_str() {
        "files.import" => &[("file", "path")],
        "files.import_paired" => &[("r1", "r1"), ("r2", "r2")],
        _ => {
            return Err(CompileError::UnsupportedInprocess {
                node: node.id.clone(),
                operator: operator.id.clone(),
            })
        }
    };
    let hash = short_hash(&node.id);
    for (port, parameter) in paths {
        let path = match values.get(*parameter) {
            Some(ParamValue::String(path)) => path,
            _ => {
                return Err(CompileError::MissingImportPath {
                    node: node.id.clone(),
                    parameter: (*parameter).into(),
                })
            }
        };
        let param_key = format!("INPUT_{hash}_{}", ident(port));
        let channel = format!(
            "ch_input_{}_{}",
            hash.to_ascii_lowercase(),
            lower_ident(port)
        );
        params_inputs.insert(param_key.clone(), Value::String(path.clone()));
        workflow_lines.push(format!(
            "    {channel} = channel.fromPath(params.inputs.{param_key}, checkIfExists: true, glob: false)"
        ));
        channels.insert((node.id.clone(), (*port).into()), channel);
    }
    node_map.insert(
        node.id.clone(),
        NodeMapEntry {
            operator: node.operator.clone(),
            process: None,
            kind: "input",
        },
    );
    Ok(())
}

fn compile_external(
    graph: &Graph,
    catalog: &Catalog,
    node: &Node,
    operator: &Operator,
    channels: &BTreeMap<(String, String), String>,
    params_values: &mut Map<String, Value>,
) -> Result<ExternalCompilation, CompileError> {
    if node.ports != operator.ir_ports() {
        return Err(CompileError::PortContractMismatch {
            node: node.id.clone(),
            operator: operator.id.clone(),
        });
    }
    let binary = operator
        .bin
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CompileError::MissingBinary {
            operator: operator.id.clone(),
        })?;
    let nested_argv = operator.argv.iter().find(|value| nested_engine(value));
    if nested_engine(binary) || nested_argv.is_some() {
        return Err(CompileError::NestedEngine {
            node: node.id.clone(),
            binary: nested_argv.map_or_else(|| binary.into(), |value| value.clone()),
        });
    }
    if operator.argv.is_empty() {
        return Err(CompileError::InvalidArgv {
            operator: operator.id.clone(),
            detail: "argv must not be empty".into(),
        });
    }
    let values = resolved_params(node, operator)?;

    let hash = short_hash(&node.id);
    let process_name = format!("SOMITE_{}_{}", ident(&node.id), hash);
    let incoming = incoming_edges(graph, node)?;
    let mut input_declarations = Vec::new();
    let mut invocation_arguments = Vec::new();
    let mut input_tokens = BTreeMap::<String, String>::new();

    for (index, port) in operator.ports.r#in.iter().enumerate() {
        let Some(edge) = incoming.get(&port.name) else {
            if port.optional {
                continue;
            }
            return Err(CompileError::MissingInput {
                node: node.id.clone(),
                port: port.name.clone(),
            });
        };
        let source = channels
            .get(&(edge.from_node.clone(), edge.from_port.clone()))
            .ok_or_else(|| CompileError::UnavailableSource {
                node: node.id.clone(),
                port: port.name.clone(),
                source_node: edge.from_node.clone(),
                source_port: edge.from_port.clone(),
            })?;
        let source_node =
            graph
                .node(&edge.from_node)
                .ok_or_else(|| CompileError::UnavailableSource {
                    node: node.id.clone(),
                    port: port.name.clone(),
                    source_node: edge.from_node.clone(),
                    source_port: edge.from_port.clone(),
                })?;
        let source_type = source_node
            .port(&edge.from_port, Direction::Out)
            .map(|port| port.ty)
            .ok_or_else(|| CompileError::UnavailableSource {
                node: node.id.clone(),
                port: port.name.clone(),
                source_node: edge.from_node.clone(),
                source_port: edge.from_port.clone(),
            })?;
        let variable = format!("input_{index}");
        let staged = staged_name(catalog, source_node, &edge.from_port, index, source_type);
        input_declarations.push(format!(
            "    path {variable}, name: '{}'",
            bash_single(&staged)
        ));
        invocation_arguments.push(source.clone());
        input_tokens.insert(port.name.clone(), staged);
    }

    let mut parameter_env = BTreeMap::<String, String>::new();
    for (name, value) in &values {
        let key = format!("PARAM_{hash}_{}", ident(name));
        let env_name = format!("SOMITE_PARAM_{hash}_{}", ident(name));
        params_values.insert(key.clone(), param_json(value));
        input_declarations.push(format!("    env '{env_name}'"));
        invocation_arguments.push(format!("params.values.{key}.toString()"));
        parameter_env.insert(name.clone(), env_name);
    }

    let argv = render_bash_argv(operator, &values, &input_tokens, &parameter_env)?;
    let output_declarations = render_outputs(operator)?;
    let output_validators = render_output_validators(operator)?;
    let mut process = String::new();
    process.push_str(&format!("process {process_name} {{\n"));
    process.push_str(&format!("    tag '{process_name}'\n"));
    process.push_str("    cache 'deep'\n");
    process.push_str(&format!(
        "    publishDir params.outdir + '/{process_name}', mode: 'copy', overwrite: true\n"
    ));
    if !input_declarations.is_empty() {
        process.push_str("\n    input:\n");
        process.push_str(&input_declarations.join("\n"));
        process.push('\n');
    }
    if !output_declarations.is_empty() {
        process.push_str("\n    output:\n");
        process.push_str(&output_declarations.join("\n"));
        process.push('\n');
    }
    process.push_str("\n    script:\n    '''\n");
    process.push_str("    set -euo pipefail\n");
    process.push_str("    mkdir -p somite_out somite_tmp\n");
    process.push_str("    argv=(\n");
    for token in argv {
        process.push_str("      ");
        process.push_str(&token);
        process.push('\n');
    }
    process.push_str("    )\n");
    process.push_str("    \"${argv[@]}\"\n");
    for validator in output_validators {
        process.push_str(&validator);
    }
    process.push_str("    '''\n}\n");

    let invocation = format!("    {process_name}({})", invocation_arguments.join(", "));
    let outputs = operator
        .ports
        .out
        .iter()
        .map(|port| {
            (
                port.name.clone(),
                format!("{process_name}.out.out_{}", lower_ident(&port.name)),
            )
        })
        .collect();

    Ok(ExternalCompilation {
        process_name,
        process_block: process,
        invocation,
        outputs,
    })
}

fn incoming_edges<'a>(
    graph: &'a Graph,
    node: &Node,
) -> Result<BTreeMap<String, &'a somite_ir::Edge>, CompileError> {
    let mut incoming = BTreeMap::new();
    for edge in graph.edges.iter().filter(|edge| edge.to_node == node.id) {
        if incoming.insert(edge.to_port.clone(), edge).is_some() {
            return Err(CompileError::MultipleInputs {
                node: node.id.clone(),
                port: edge.to_port.clone(),
            });
        }
    }
    Ok(incoming)
}

fn render_bash_argv(
    operator: &Operator,
    values: &BTreeMap<String, ParamValue>,
    inputs: &BTreeMap<String, String>,
    parameter_env: &BTreeMap<String, String>,
) -> Result<Vec<String>, CompileError> {
    let mut rendered = Vec::new();
    for configured in &operator.argv {
        let token = if let Some((name, token)) = configured
            .strip_prefix("?!")
            .and_then(|value| value.split_once(':'))
        {
            if inputs.contains_key(name) {
                continue;
            }
            token
        } else if let Some((name, token)) = configured
            .strip_prefix('?')
            .and_then(|value| value.split_once(':'))
        {
            if !inputs.contains_key(name) {
                continue;
            }
            token
        } else {
            configured.as_str()
        };

        if let Some(name) = token
            .strip_prefix("{flag.")
            .and_then(|value| value.strip_suffix('}'))
        {
            match values.get(name) {
                Some(ParamValue::Bool(true)) => {
                    rendered.push(format!("'--{}'", bash_single(&name.replace('_', "-"))))
                }
                Some(ParamValue::Bool(false)) | None => {}
                Some(_) => rendered.push(render_token(token, inputs, parameter_env, operator)?),
            }
            continue;
        }
        rendered.push(render_token(token, inputs, parameter_env, operator)?);
    }
    Ok(rendered)
}

fn render_token(
    token: &str,
    inputs: &BTreeMap<String, String>,
    parameter_env: &BTreeMap<String, String>,
    operator: &Operator,
) -> Result<String, CompileError> {
    let controlled = token
        .replace("{work}/out", "somite_out")
        .replace("{work}/tmp", "somite_tmp")
        .replace("{work}", ".");
    let mut result = String::new();
    let mut rest = controlled.as_str();
    while let Some(start) = rest.find('{') {
        let literal = &rest[..start];
        if !literal.is_empty() {
            result.push('\'');
            result.push_str(&bash_single(literal));
            result.push('\'');
        }
        let tail = &rest[start..];
        let Some(end) = tail.find('}') else {
            return Err(CompileError::InvalidArgv {
                operator: operator.id.clone(),
                detail: format!("unterminated placeholder in {token:?}"),
            });
        };
        let placeholder = &tail[1..end];
        if let Some(name) = placeholder.strip_prefix("input.") {
            let value = inputs.get(name).ok_or_else(|| CompileError::InvalidArgv {
                operator: operator.id.clone(),
                detail: format!("unbound input {name}"),
            })?;
            result.push('\'');
            result.push_str(&bash_single(value));
            result.push('\'');
        } else if let Some(name) = placeholder.strip_prefix("param.") {
            let env = parameter_env
                .get(name)
                .ok_or_else(|| CompileError::InvalidArgv {
                    operator: operator.id.clone(),
                    detail: format!("missing parameter {name}"),
                })?;
            result.push_str(&format!("\"${{{env}}}\""));
        } else {
            return Err(CompileError::InvalidArgv {
                operator: operator.id.clone(),
                detail: format!("unsupported placeholder {{{placeholder}}}"),
            });
        }
        rest = &tail[end + 1..];
    }
    if !rest.is_empty() {
        result.push('\'');
        result.push_str(&bash_single(rest));
        result.push('\'');
    }
    if result.is_empty() {
        Ok("''".into())
    } else {
        Ok(result)
    }
}

fn render_outputs(operator: &Operator) -> Result<Vec<String>, CompileError> {
    let mut declarations = Vec::new();
    for port in &operator.ports.out {
        let spec = operator
            .outputs
            .get(&port.name)
            .ok_or_else(|| CompileError::InvalidOutput {
                operator: operator.id.clone(),
                output: port.name.clone(),
                detail: "missing output collection rule".into(),
            })?;
        if spec.ty != port.ty {
            return Err(CompileError::InvalidOutput {
                operator: operator.id.clone(),
                output: port.name.clone(),
                detail: format!(
                    "declares {:?} but the output port declares {:?}",
                    spec.ty, port.ty
                ),
            });
        }
        if !spec.exclude.is_empty() {
            return Err(CompileError::InvalidOutput {
                operator: operator.id.clone(),
                output: port.name.clone(),
                detail: "exclude rules are not supported by the Nextflow compiler".into(),
            });
        }
        let pattern = controlled_output_pattern(operator, &port.name, spec)?;
        let optional = if spec.optional || port.optional {
            ", optional: true"
        } else {
            ""
        };
        declarations.push(format!(
            "    path '{}', emit: out_{}{}",
            bash_single(&pattern),
            lower_ident(&port.name),
            optional
        ));
    }
    Ok(declarations)
}

fn render_output_validators(operator: &Operator) -> Result<Vec<String>, CompileError> {
    let mut validators = Vec::new();
    for port in &operator.ports.out {
        let spec = operator
            .outputs
            .get(&port.name)
            .ok_or_else(|| CompileError::InvalidOutput {
                operator: operator.id.clone(),
                output: port.name.clone(),
                detail: "missing output collection rule".into(),
            })?;
        let pattern = controlled_output_pattern(operator, &port.name, spec)?;
        let variable = format!("somite_output_{}", lower_ident(&port.name));
        validators.push(format!(
            "    mapfile -t {variable} < <(compgen -G '{}' || true)\n",
            bash_single(&pattern)
        ));
        if !(spec.optional || port.optional) {
            validators.push(format!(
                "    if (( ${{#{variable}[@]}} == 0 )); then echo 'Somite: required output {} was not created' >&2; exit 74; fi\n",
                bash_single(&port.name)
            ));
        }
        validators.push(format!(
            "    for somite_artifact in \"${{{variable}[@]}}\"; do\n"
        ));
        if port.ty == PortType::Directory {
            validators.push(
                "      if [[ ! -d \"$somite_artifact\" ]]; then echo \"Somite: expected directory $somite_artifact\" >&2; exit 74; fi\n"
                    .into(),
            );
        } else {
            validators.push(
                "      if [[ ! -s \"$somite_artifact\" ]]; then echo \"Somite: empty output $somite_artifact\" >&2; exit 74; fi\n"
                    .into(),
            );
            if matches!(
                port.ty,
                PortType::FastqGz | PortType::FastaGz | PortType::GtfGz | PortType::VcfGz
            ) {
                validators.push(
                    "      gzip -t -- \"$somite_artifact\" || { echo \"Somite: corrupt gzip $somite_artifact\" >&2; exit 74; }\n"
                        .into(),
                );
            }
        }
        validators.push("    done\n".into());
    }
    Ok(validators)
}

fn controlled_output_pattern(
    operator: &Operator,
    output: &str,
    spec: &OutputSpec,
) -> Result<String, CompileError> {
    let pattern = spec
        .glob
        .replace("{work}/out", "somite_out")
        .replace("{work}/tmp", "somite_tmp")
        .replace("{work}", ".");
    let safe_characters = pattern.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character, '/' | '.' | '-' | '_' | '*' | '?' | '[' | ']')
    });
    let parent_segment = pattern.split('/').any(|segment| segment == "..");
    if pattern.contains('{') || pattern.starts_with('/') || parent_segment || !safe_characters {
        return Err(CompileError::InvalidOutput {
            operator: operator.id.clone(),
            output: output.into(),
            detail: format!("output must remain under the controlled work directory: {pattern:?}"),
        });
    }
    Ok(pattern)
}

fn staged_name(
    catalog: &Catalog,
    source_node: &Node,
    source_port: &str,
    index: usize,
    source_type: PortType,
) -> String {
    let declared_basename = catalog
        .ops
        .get(&source_node.operator)
        .and_then(|operator| {
            operator
                .outputs
                .get(source_port)
                .and_then(|spec| controlled_output_pattern(operator, source_port, spec).ok())
        })
        .and_then(|pattern| pattern.rsplit('/').next().map(str::to_owned))
        .filter(|name| safe_stage_basename(name));

    declared_basename.unwrap_or_else(|| format!("somite_in_{index}{}", extension(source_type)))
}

fn safe_stage_basename(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['*', '?', '[', ']'])
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn render_main(processes: &[String], workflow_lines: &[String]) -> String {
    let mut main = String::from("#!/usr/bin/env nextflow\nnextflow.enable.dsl=2\n\n");
    if !processes.is_empty() {
        main.push_str(&processes.join("\n"));
        main.push('\n');
    }
    main.push_str("workflow {\n    main:\n");
    for line in workflow_lines {
        main.push_str(line);
        main.push('\n');
    }
    main.push_str("}\n");
    main
}

fn resolved_params(
    node: &Node,
    operator: &Operator,
) -> Result<BTreeMap<String, ParamValue>, CompileError> {
    for parameter in node.params.keys() {
        if !operator.params.contains_key(parameter) {
            return Err(CompileError::UnknownParameter {
                node: node.id.clone(),
                parameter: parameter.clone(),
            });
        }
    }

    let mut values = BTreeMap::new();
    for (name, spec) in &operator.params {
        let value = node.params.get(name).or(spec.default.as_ref());
        if let Some(value) = value {
            validate_param(node, name, spec, value)?;
            values.insert(name.clone(), value.clone());
        } else if spec.required {
            return Err(CompileError::MissingParameter {
                node: node.id.clone(),
                parameter: name.clone(),
            });
        }
    }
    Ok(values)
}

fn validate_param(
    node: &Node,
    name: &str,
    spec: &ParamSpec,
    value: &ParamValue,
) -> Result<(), CompileError> {
    let type_matches = matches!(
        (spec.ty.as_str(), value),
        ("bool", ParamValue::Bool(_))
            | ("int", ParamValue::Int(_))
            | ("float", ParamValue::Float(_) | ParamValue::Int(_))
            | ("string", ParamValue::String(_))
    );
    if !type_matches {
        return Err(CompileError::InvalidParameter {
            node: node.id.clone(),
            parameter: name.into(),
            detail: format!("expected {}, received {value:?}", spec.ty),
        });
    }
    if let ParamValue::Int(number) = value {
        if spec.min.is_some_and(|minimum| *number < minimum)
            || spec.max.is_some_and(|maximum| *number > maximum)
        {
            return Err(CompileError::InvalidParameter {
                node: node.id.clone(),
                parameter: name.into(),
                detail: format!("value {number} is outside {:?}..={:?}", spec.min, spec.max),
            });
        }
    }
    if matches!(value, ParamValue::Float(number) if !number.is_finite()) {
        return Err(CompileError::InvalidParameter {
            node: node.id.clone(),
            parameter: name.into(),
            detail: "value must be finite".into(),
        });
    }
    Ok(())
}

fn sorted_edges(graph: &Graph) -> Vec<somite_ir::Edge> {
    let mut edges = graph.edges.clone();
    edges.sort_by(|left, right| left.id.cmp(&right.id));
    edges
}

fn render_config() -> String {
    "process {\n    cache = 'deep'\n    errorStrategy = 'terminate'\n}\n".into()
}

fn render_pixi(options: &CompileOptions, packages: &BTreeSet<String>) -> String {
    let platforms = options
        .platforms
        .iter()
        .map(|platform| format!("\"{platform}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let mut manifest = format!(
        "[workspace]\nname = \"{}\"\nchannels = [\"conda-forge\", \"bioconda\"]\nplatforms = [{platforms}]\n\n[dependencies]\nnextflow = \"=={}\"\nopenjdk = \"=={}\"\n",
        toml_basic(&options.workflow_name),
        options.nextflow_version,
        options.openjdk_version,
    );
    for requirement in packages {
        let (channel, package, version) = split_requirement(requirement);
        if channel.is_empty() {
            manifest.push_str(&format!(
                "\"{}\" = \"{}\"\n",
                toml_basic(package),
                toml_basic(version)
            ));
        } else {
            manifest.push_str(&format!(
                "\"{}\" = {{ version = \"{}\", channel = \"{}\" }}\n",
                toml_basic(package),
                toml_basic(version),
                toml_basic(channel)
            ));
        }
    }
    manifest
        .push_str("\n[tasks]\nrun = \"nextflow run main.nf -params-file params.json -resume\"\n");
    manifest
}

fn split_requirement(requirement: &str) -> (&str, &str, &str) {
    let (channel, package_requirement) = requirement.split_once("::").unwrap_or(("", requirement));
    let split = package_requirement.find(['=', '<', '>', '!', '~']);
    match split {
        Some(index) => (
            channel,
            &package_requirement[..index],
            &package_requirement[index..],
        ),
        None => (channel, package_requirement, "*"),
    }
}

fn pretty_json(artifact: &'static str, value: &Value) -> Result<String, CompileError> {
    serde_json::to_string_pretty(value)
        .map(|mut json| {
            json.push('\n');
            json
        })
        .map_err(|error| CompileError::Serialize {
            artifact,
            detail: error.to_string(),
        })
}

fn param_json(value: &ParamValue) -> Value {
    match value {
        ParamValue::Bool(value) => Value::Bool(*value),
        ParamValue::Int(value) => Value::Number((*value).into()),
        ParamValue::Float(value) => serde_json::Number::from_f64(*value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ParamValue::String(value) => Value::String(value.clone()),
    }
}

fn nested_engine(binary: &str) -> bool {
    let basename = binary.rsplit('/').next().unwrap_or(binary);
    matches!(
        basename.to_ascii_lowercase().as_str(),
        "nextflow" | "snakemake"
    )
}

fn exact_version(version: &str) -> bool {
    let mut parts = version.split('.');
    let count = parts.clone().count();
    count >= 2
        && parts.all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn safe_spec(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn ident(value: &str) -> String {
    let mut result = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    if result.is_empty() || result.starts_with(|character: char| character.is_ascii_digit()) {
        result.insert_str(0, "N_");
    }
    result
}

fn lower_ident(value: &str) -> String {
    ident(value).to_ascii_lowercase()
}

fn short_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016X}")[..8].into()
}

fn extension(port_type: PortType) -> &'static str {
    match port_type {
        PortType::Fastq => ".fastq",
        PortType::FastqGz => ".fastq.gz",
        PortType::Fasta => ".fasta",
        PortType::FastaGz => ".fasta.gz",
        PortType::Gtf => ".gtf",
        PortType::GtfGz => ".gtf.gz",
        PortType::Bam => ".bam",
        PortType::Bai => ".bai",
        PortType::Vcf => ".vcf",
        PortType::VcfGz => ".vcf.gz",
        PortType::Table => ".tsv",
        PortType::Json => ".json",
        PortType::Html => ".html",
        PortType::Image => ".png",
        PortType::Zip => ".zip",
        PortType::Text => ".txt",
        PortType::Preview => ".png",
        PortType::Sra => ".sra",
        PortType::Directory => "",
    }
}

fn bash_single(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

fn toml_basic(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
