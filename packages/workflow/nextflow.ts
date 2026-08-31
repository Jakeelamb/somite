import type { Operator, OutputSpec, ParamSpec, PinnedOperator } from "./catalog.ts";
import { OperatorCatalog, operatorPorts } from "./catalog.ts";
import type {
  ParamValue,
  PortType,
  SomiteEdge,
  SomiteGraph,
  SomiteGraphNode,
  SomitePort,
  SourceSpan,
} from "./model.ts";
import { topologicalOrder, validateGraph } from "./workflow.ts";

export const PINNED_NEXTFLOW_VERSION = "26.04.6";
export const PINNED_OPENJDK_VERSION = "25.0.2";

export type CompileOptions = Readonly<{
  workflowName: string;
  outputDirectory: string;
  platforms: readonly string[];
  nextflowVersion: string;
  openjdkVersion: string;
}>;

export type CompiledWorkflow = Readonly<{
  mainNf: string;
  nextflowConfig: string;
  paramsJson: string;
  nodeMapJson: string;
  pixiToml: string;
}>;

export type NextflowCompileErrorCode =
  | "invalid_graph"
  | "invalid_option"
  | "unknown_operator"
  | "reference_node"
  | "source_workflow_node"
  | "unsupported_inprocess"
  | "nested_engine"
  | "port_contract_mismatch"
  | "unknown_parameter"
  | "missing_parameter"
  | "invalid_parameter"
  | "missing_import_path"
  | "missing_input"
  | "multiple_inputs"
  | "unavailable_source"
  | "missing_binary"
  | "invalid_argv"
  | "invalid_output";

/** One stable failure shape for browser, worker, and eventual runner callers. */
export class NextflowCompileError extends Error {
  readonly code: NextflowCompileErrorCode;

  constructor(code: NextflowCompileErrorCode, message: string) {
    super(message);
    this.name = "NextflowCompileError";
    this.code = code;
  }
}

type PromotedSourceMapEntry = Readonly<{
  repository: string;
  requested_revision: string;
  resolved_revision: string;
  source_digest: string;
  invocation_id: string;
  invocation_name: string;
  span: SourceSpan;
}>;

type NodeMapEntry = Readonly<{
  operator: string;
  operator_revision: string;
  process: string | null;
  kind: "input" | "process";
  source?: PromotedSourceMapEntry;
}>;

type ExternalCompilation = Readonly<{
  processName: string;
  processBlock: string;
  invocation: string;
  outputs: ReadonlyMap<string, string>;
}>;

type ResolvedParams = ReadonlyMap<string, ParamValue>;

type CompilationGraphIndex = Readonly<{
  nodes: ReadonlyMap<string, SomiteGraphNode>;
  incomingEdges: ReadonlyMap<string, ReadonlyMap<string, SomiteEdge>>;
}>;

function fail(code: NextflowCompileErrorCode, message: string): never {
  throw new NextflowCompileError(code, message);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedEntries<T>(record: Readonly<Record<string, T>>) {
  return Object.keys(record).sort(compareText).map((key) => [key, record[key]] as const);
}

function recordFromSortedMap<T>(values: ReadonlyMap<string, T>) {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => compareText(left, right)));
}

function prettyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedPorts(ports: readonly SomitePort[]) {
  return ports.map((port) => ({
    name: port.name,
    dir: port.dir,
    ty: port.ty,
    union: port.union ?? [],
    optional: port.optional ?? false,
  }));
}

function portsMatch(node: SomiteGraphNode, operator: Operator) {
  return JSON.stringify(normalizedPorts(node.ports)) === JSON.stringify(normalizedPorts(operatorPorts(operator)));
}

function validateOptions(options: CompileOptions) {
  if (!options.workflowName.trim()) {
    fail("invalid_option", "invalid compile option workflow_name: must not be empty");
  }
  if (options.platforms.length === 0) {
    fail("invalid_option", "invalid compile option platforms: must contain at least one Pixi platform");
  }
  for (const platform of options.platforms) {
    if (!safeSpec(platform)) {
      fail("invalid_option", `invalid compile option platforms: unsafe platform ${JSON.stringify(platform)}`);
    }
  }
  for (const [field, version] of [
    ["nextflow_version", options.nextflowVersion],
    ["openjdk_version", options.openjdkVersion],
  ] as const) {
    if (!exactVersion(version)) {
      fail("invalid_option", `invalid compile option ${field}: must be an exact dotted numeric version`);
    }
  }
}

/**
 * Pure native-graph to Nextflow compilation.
 *
 * This is the Module's only Interface: no filesystem, process, or network I/O,
 * and no partially generated workflow on failure.
 */
export function compileNextflow(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  options: CompileOptions,
): CompiledWorkflow {
  const graphValidation = validateGraph(graph);
  if (!graphValidation.ok) fail("invalid_graph", `invalid graph: ${graphValidation.issue.message}`);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!catalogValidation.ok) fail("invalid_graph", `invalid graph: ${catalogValidation.issue.message}`);
  validateOptions(options);

  const graphIndex = indexCompilationGraph(graph);
  const paramsInputs = new Map<string, ParamValue>();
  const paramsValues = new Map<string, ParamValue>();
  const channels = new Map<string, string>();
  const processBlocks: string[] = [];
  const workflowLines: string[] = [];
  const nodeMap = new Map<string, NodeMapEntry>();
  const packages = new Set<string>();

  for (const nodeId of topologicalOrder(graph)) {
    const node = graphIndex.nodes.get(nodeId);
    if (!node) fail("invalid_graph", `invalid graph: missing node ${nodeId}`);
    const operator = catalog.get(node.operator);
    if (!operator) fail("unknown_operator", `node ${node.id} uses unknown operator ${node.operator}`);

    if (operator.kind === "reference") {
      fail("reference_node", `node ${node.id} is a structural reference and cannot be executed`);
    }
    if (operator.kind === "source") {
      fail("source_workflow_node", `node ${node.id} is a source-backed workflow and must be frozen through the source workflow compiler`);
    }
    if (operator.kind === "inprocess") {
      compileImport(graph, node, operator, paramsInputs, channels, workflowLines, nodeMap);
      continue;
    }

    const compiled = compileExternal(graphIndex, catalog, node, operator, channels, paramsValues);
    for (const requirement of operator.pixi ?? []) packages.add(requirement);
    for (const [port, expression] of compiled.outputs) channels.set(channelKey(node.id, port), expression);
    workflowLines.push(compiled.invocation);
    processBlocks.push(compiled.processBlock);
    const source = promotedSourceEntry(graph, node);
    nodeMap.set(node.id, {
      operator: node.operator,
      operator_revision: node.operator_revision,
      process: compiled.processName,
      kind: "process",
      ...(source ? { source } : {}),
    });
  }

  const nodesJson = Object.fromEntries(
    [...nodeMap.entries()].sort(([left], [right]) => compareText(left, right)),
  );
  const edgesJson = [...graph.edges]
    .sort((left, right) => compareText(left.id, right.id))
    .map(({ id, from_node, from_port, to_node, to_port }) => ({ id, from_node, from_port, to_node, to_port }));

  return {
    mainNf: renderMain(processBlocks, workflowLines),
    nextflowConfig: renderConfig(),
    paramsJson: prettyJson({
      inputs: recordFromSortedMap(paramsInputs),
      outdir: options.outputDirectory,
      values: recordFromSortedMap(paramsValues),
    }),
    nodeMapJson: prettyJson({ schema_version: 1, nodes: nodesJson, edges: edgesJson }),
    pixiToml: renderPixi(options, packages),
  };
}

function indexCompilationGraph(graph: SomiteGraph): CompilationGraphIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incomingEdges = new Map<string, Map<string, SomiteEdge>>();
  for (const edge of graph.edges) {
    let byPort = incomingEdges.get(edge.to_node);
    if (!byPort) {
      byPort = new Map();
      incomingEdges.set(edge.to_node, byPort);
    }
    if (byPort.has(edge.to_port)) {
      fail("multiple_inputs", `node ${edge.to_node} input ${edge.to_port} has more than one source`);
    }
    byPort.set(edge.to_port, edge);
  }
  return { nodes, incomingEdges };
}

function compileImport(
  graph: SomiteGraph,
  node: SomiteGraphNode,
  operator: PinnedOperator,
  paramsInputs: Map<string, ParamValue>,
  channels: Map<string, string>,
  workflowLines: string[],
  nodeMap: Map<string, NodeMapEntry>,
) {
  if (!portsMatch(node, operator)) {
    fail("port_contract_mismatch", `node ${node.id} ports do not match operator ${operator.id}`);
  }
  const values = resolvedParams(node, operator);
  const paths = operatorImportPaths(operator);
  if (!paths.length) {
    fail("unsupported_inprocess", `node ${node.id} uses unsupported in-process operator ${operator.id}`);
  }

  const hash = shortHash(node.id);
  for (const { port, parameter } of paths) {
    const path = values.get(parameter);
    if (typeof path !== "string") {
      fail("missing_import_path", `import node ${node.id} is missing string path parameter ${parameter}`);
    }
    const paramKey = `INPUT_${hash}_${ident(port)}`;
    const channel = `ch_input_${hash.toLowerCase()}_${lowerIdent(port)}`;
    paramsInputs.set(paramKey, path);
    workflowLines.push(`    ${channel} = channel.fromPath(params.inputs.${paramKey}, checkIfExists: true, glob: false)`);
    channels.set(channelKey(node.id, port), channel);
  }
  const source = promotedSourceEntry(graph, node);
  nodeMap.set(node.id, {
    operator: node.operator,
    operator_revision: node.operator_revision,
    process: null,
    kind: "input",
    ...(source ? { source } : {}),
  });
}

export type OperatorImportPath = Readonly<{
  port: string;
  parameter: string;
  kind: "file" | "directory";
}>;

/** The exact local path parameters consumed directly by one in-process import operator. */
export function operatorImportPaths(operator: PinnedOperator): readonly OperatorImportPath[] {
  const declared = operator.ports.out
    .filter((port) => port.import_param !== undefined)
    .map((port) => ({
      port: port.name,
      parameter: port.import_param!,
      kind: port.type === "Directory" ? "directory" as const : "file" as const,
    }));
  if (declared.length) return declared;
  if (operator.id === "files.import_paired") {
    return [
      { port: "r1", parameter: "r1", kind: "file" },
      { port: "r2", parameter: "r2", kind: "file" },
    ];
  }
  if (Object.hasOwn(operator.params, "path") && operator.ports.out.length === 1) {
    const port = operator.ports.out[0]!;
    return [{ port: port.name, parameter: "path", kind: port.type === "Directory" ? "directory" : "file" }];
  }
  return [];
}

function promotedSourceEntry(graph: SomiteGraph, node: SomiteGraphNode): PromotedSourceMapEntry | undefined {
  const origin = graph.variant_origin;
  if (!origin) return undefined;
  const promoted = sortedEntries(origin.promoted_invocations ?? {}).find(([, nodeId]) => nodeId === node.id);
  if (!promoted) return undefined;
  const [invocationId] = promoted;
  const workflow = origin.source_node.source_workflow;
  if (!workflow) return undefined;
  const invocation = (workflow.invocations ?? []).find((candidate) => candidate.id === invocationId);
  if (!invocation) return undefined;
  return {
    repository: workflow.source.repository,
    requested_revision: workflow.source.requested_revision,
    resolved_revision: workflow.source.resolved_revision,
    source_digest: workflow.source.source_digest,
    invocation_id: invocation.id,
    invocation_name: invocation.name,
    span: {
      path: invocation.span.path,
      start_line: invocation.span.start_line,
      end_line: invocation.span.end_line,
    },
  };
}

function compileExternal(
  graphIndex: CompilationGraphIndex,
  catalog: OperatorCatalog,
  node: SomiteGraphNode,
  operator: PinnedOperator,
  channels: ReadonlyMap<string, string>,
  paramsValues: Map<string, ParamValue>,
): ExternalCompilation {
  if (!portsMatch(node, operator)) {
    fail("port_contract_mismatch", `node ${node.id} ports do not match operator ${operator.id}`);
  }
  const binary = operator.bin;
  if (!binary) fail("missing_binary", `operator ${operator.id} has no executable binary`);
  const nestedArgv = (operator.argv ?? []).find(nestedEngine);
  if (nestedEngine(binary) || nestedArgv !== undefined) {
    fail("nested_engine", `node ${node.id} attempts to nest workflow engine ${nestedArgv ?? binary}`);
  }
  if ((operator.argv ?? []).length === 0) {
    fail("invalid_argv", `operator ${operator.id} argv: argv must not be empty`);
  }
  const values = resolvedParams(node, operator);
  const hash = shortHash(node.id);
  const processName = `SOMITE_${ident(node.id)}_${hash}`;
  const incoming = graphIndex.incomingEdges.get(node.id);
  const inputDeclarations: string[] = [];
  const invocationArguments: string[] = [];
  const inputTokens = new Map<string, string>();

  for (const [index, port] of operator.ports.in.entries()) {
    const edge = incoming?.get(port.name);
    if (!edge) {
      if (port.optional) continue;
      fail("missing_input", `node ${node.id} input ${port.name} has no source`);
    }
    const source = channels.get(channelKey(edge.from_node, edge.from_port));
    if (!source) {
      fail(
        "unavailable_source",
        `node ${node.id} input ${port.name} references unavailable source ${edge.from_node}.${edge.from_port}`,
      );
    }
    const sourceNode = graphIndex.nodes.get(edge.from_node);
    const sourcePort = sourceNode?.ports.find((candidate) => candidate.name === edge.from_port && candidate.dir === "out");
    if (!sourceNode || !sourcePort) {
      fail(
        "unavailable_source",
        `node ${node.id} input ${port.name} references unavailable source ${edge.from_node}.${edge.from_port}`,
      );
    }
    let staged: string;
    if (port.stage_as !== undefined) {
      if (!safeStagedBasename(port.stage_as)) {
        fail("invalid_argv", `operator ${operator.id} argv: input ${port.name} has unsafe stage_as ${JSON.stringify(port.stage_as)}`);
      }
      staged = port.stage_as;
    } else {
      staged = stagedName(catalog, sourceNode, edge.from_port, index, sourcePort.ty);
    }
    const variable = `input_${index}`;
    inputDeclarations.push(`    path ${variable}, name: '${bashSingle(staged)}'`);
    invocationArguments.push(source);
    inputTokens.set(port.name, staged);
  }

  const parameterEnvironment = new Map<string, string>();
  for (const [name, value] of values) {
    const key = `PARAM_${hash}_${ident(name)}`;
    const environmentName = `SOMITE_PARAM_${hash}_${ident(name)}`;
    paramsValues.set(key, value);
    inputDeclarations.push(`    env '${environmentName}'`);
    invocationArguments.push(`params.values.${key}.toString()`);
    parameterEnvironment.set(name, environmentName);
  }

  const argv = renderBashArgv(operator, values, inputTokens, parameterEnvironment);
  const outputDeclarations = renderOutputs(operator);
  const outputValidators = renderOutputValidators(operator);
  const stdoutPath = controlledStdoutPath(operator);
  let process = `process ${processName} {\n`;
  process += `    tag '${processName}'\n`;
  process += "    cache 'deep'\n";
  process += `    publishDir params.outdir + '/${processName}', mode: 'copy', overwrite: true\n`;
  if (inputDeclarations.length > 0) {
    process += "\n    input:\n";
    process += inputDeclarations.join("\n");
    process += "\n";
  }
  if (outputDeclarations.length > 0) {
    process += "\n    output:\n";
    process += outputDeclarations.join("\n");
    process += "\n";
  }
  process += "\n    script:\n    '''\n";
  process += "    set -euo pipefail\n";
  process += "    mkdir -p somite_out somite_tmp\n";
  process += "    argv=(\n";
  for (const token of argv) process += `      ${token}\n`;
  process += "    )\n";
  process += stdoutPath === undefined
    ? "    \"${argv[@]}\"\n"
    : `    "\${argv[@]}" > '${bashSingle(stdoutPath)}'\n`;
  for (const validator of outputValidators) process += validator;
  process += "    '''\n}\n";

  return {
    processName,
    processBlock: process,
    invocation: `    ${processName}(${invocationArguments.join(", ")})`,
    outputs: new Map(operator.ports.out.map((port) => [port.name, `${processName}.out.out_${lowerIdent(port.name)}`])),
  };
}

function renderBashArgv(
  operator: PinnedOperator,
  values: ResolvedParams,
  inputs: ReadonlyMap<string, string>,
  parameterEnvironment: ReadonlyMap<string, string>,
) {
  const rendered: string[] = [];
  for (const configured of operator.argv ?? []) {
    let token = configured;
    if (configured.startsWith("?!")) {
      const separator = configured.indexOf(":", 2);
      if (separator >= 0) {
        const name = configured.slice(2, separator);
        if (inputs.has(name)) continue;
        token = configured.slice(separator + 1);
      }
    } else if (configured.startsWith("?")) {
      const separator = configured.indexOf(":", 1);
      if (separator >= 0) {
        const name = configured.slice(1, separator);
        if (!inputs.has(name)) continue;
        token = configured.slice(separator + 1);
      }
    }

    const flag = token.match(/^\{flag\.([^}]+)\}$/);
    if (flag) {
      const value = values.get(flag[1]);
      if (value === true) rendered.push(`'--${bashSingle(flag[1].replaceAll("_", "-"))}'`);
      else if (value !== false && value !== undefined) rendered.push(renderToken(token, inputs, parameterEnvironment, operator));
      continue;
    }
    rendered.push(renderToken(token, inputs, parameterEnvironment, operator));
  }
  return rendered;
}

function renderToken(
  token: string,
  inputs: ReadonlyMap<string, string>,
  parameterEnvironment: ReadonlyMap<string, string>,
  operator: PinnedOperator,
) {
  const controlled = token
    .replaceAll("{work}/out", "somite_out")
    .replaceAll("{work}/tmp", "somite_tmp")
    .replaceAll("{work}", ".");
  let result = "";
  let rest = controlled;
  while (rest.includes("{")) {
    const start = rest.indexOf("{");
    const literal = rest.slice(0, start);
    if (literal) result += `'${bashSingle(literal)}'`;
    const tail = rest.slice(start);
    const end = tail.indexOf("}");
    if (end < 0) {
      fail("invalid_argv", `operator ${operator.id} argv: unterminated placeholder in ${JSON.stringify(token)}`);
    }
    const placeholder = tail.slice(1, end);
    if (placeholder.startsWith("input.")) {
      const name = placeholder.slice("input.".length);
      const value = inputs.get(name);
      if (value === undefined) fail("invalid_argv", `operator ${operator.id} argv: unbound input ${name}`);
      result += `'${bashSingle(value)}'`;
    } else if (placeholder.startsWith("param.")) {
      const name = placeholder.slice("param.".length);
      const environmentName = parameterEnvironment.get(name);
      if (!environmentName) fail("invalid_argv", `operator ${operator.id} argv: missing parameter ${name}`);
      result += `"\${${environmentName}}"`;
    } else {
      fail("invalid_argv", `operator ${operator.id} argv: unsupported placeholder {${placeholder}}`);
    }
    rest = tail.slice(end + 1);
  }
  if (rest) result += `'${bashSingle(rest)}'`;
  return result || "''";
}

function renderOutputs(operator: PinnedOperator) {
  return operator.ports.out.map((port) => {
    const spec = (operator.outputs ?? {})[port.name];
    if (!spec) fail("invalid_output", `operator ${operator.id} output ${port.name}: missing output collection rule`);
    if (spec.type !== port.type) {
      fail(
        "invalid_output",
        `operator ${operator.id} output ${port.name}: declares ${spec.type} but the output port declares ${port.type}`,
      );
    }
    if ((spec.exclude ?? []).length > 0) {
      fail("invalid_output", `operator ${operator.id} output ${port.name}: exclude rules are not supported by the Nextflow compiler`);
    }
    const pattern = controlledOutputPattern(operator, port.name, spec);
    const optional = spec.optional || port.optional ? ", optional: true" : "";
    return `    path '${bashSingle(pattern)}', emit: out_${lowerIdent(port.name)}${optional}`;
  });
}

function renderOutputValidators(operator: PinnedOperator) {
  const validators: string[] = [];
  for (const port of operator.ports.out) {
    const spec = (operator.outputs ?? {})[port.name];
    if (!spec) fail("invalid_output", `operator ${operator.id} output ${port.name}: missing output collection rule`);
    const pattern = controlledOutputPattern(operator, port.name, spec);
    const count = `somite_output_${lowerIdent(port.name)}_count`;
    // macOS ships Bash 3.2, which predates mapfile/readarray. Keep output
    // collection on the Bash-3.2-compatible surface used by the rest of the task.
    validators.push(`    ${count}=0\n`);
    validators.push("    while IFS= read -r somite_artifact; do\n");
    validators.push(`      ${count}=$(( ${count} + 1 ))\n`);
    if (port.type === "Directory") {
      validators.push("      if [[ ! -d \"$somite_artifact\" ]]; then echo \"Somite: expected directory $somite_artifact\" >&2; exit 74; fi\n");
    } else {
      validators.push("      if [[ ! -s \"$somite_artifact\" ]]; then echo \"Somite: empty output $somite_artifact\" >&2; exit 74; fi\n");
      if (["FastqGz", "FastaGz", "GtfGz", "VcfGz"].includes(port.type)) {
        validators.push("      gzip -t -- \"$somite_artifact\" || { echo \"Somite: corrupt gzip $somite_artifact\" >&2; exit 74; }\n");
      }
    }
    validators.push(`    done < <(compgen -G '${bashSingle(pattern)}' || true)\n`);
    if (!(spec.optional || port.optional)) {
      validators.push(
        `    if (( ${count} == 0 )); then echo 'Somite: required output ${bashSingle(port.name)} was not created' >&2; exit 74; fi\n`,
      );
    }
  }
  return validators;
}

function controlledStdoutPath(operator: PinnedOperator) {
  if (operator.stdout === undefined) return undefined;
  const spec = (operator.outputs ?? {})[operator.stdout];
  if (!spec) fail("invalid_output", `operator ${operator.id} output ${operator.stdout}: stdout names an unknown output port`);
  const path = controlledOutputPattern(operator, operator.stdout, spec);
  if ([...path].some((character) => "*?[]".includes(character))) {
    fail("invalid_output", `operator ${operator.id} output ${operator.stdout}: stdout capture requires one exact output path`);
  }
  return path;
}

function controlledOutputPattern(operator: PinnedOperator, output: string, spec: OutputSpec) {
  const pattern = spec.glob
    .replaceAll("{work}/out", "somite_out")
    .replaceAll("{work}/tmp", "somite_tmp")
    .replaceAll("{work}", ".");
  const safeCharacters = [...pattern].every((character) => /[A-Za-z0-9]/.test(character) || "/.-_*?[]".includes(character));
  const hasParentSegment = pattern.split("/").includes("..");
  if (pattern.includes("{") || pattern.startsWith("/") || hasParentSegment || !safeCharacters) {
    fail(
      "invalid_output",
      `operator ${operator.id} output ${output}: output must remain under the controlled work directory: ${JSON.stringify(pattern)}`,
    );
  }
  return pattern;
}

function stagedName(
  catalog: OperatorCatalog,
  sourceNode: SomiteGraphNode,
  sourcePort: string,
  index: number,
  sourceType: PortType,
) {
  const sourceOperator = catalog.get(sourceNode.operator);
  const sourceOutput = sourceOperator?.outputs?.[sourcePort];
  let declaredBasename: string | undefined;
  if (sourceOperator && sourceOutput) {
    try {
      const pattern = controlledOutputPattern(sourceOperator, sourcePort, sourceOutput);
      const basename = pattern.split("/").at(-1);
      if (basename && safeStageBasename(basename)) declaredBasename = basename;
    } catch (error) {
      if (!(error instanceof NextflowCompileError)) throw error;
    }
  }
  return declaredBasename ?? `somite_in_${index}${extension(sourceType)}`;
}

function resolvedParams(node: SomiteGraphNode, operator: PinnedOperator): Map<string, ParamValue> {
  for (const parameter of Object.keys(node.params ?? {}).sort(compareText)) {
    if (!Object.hasOwn(operator.params, parameter)) {
      fail("unknown_parameter", `node ${node.id} has unknown parameter ${parameter}`);
    }
  }
  const values = new Map<string, ParamValue>();
  for (const [name, spec] of sortedEntries(operator.params)) {
    const nodeValue = node.params?.[name];
    const value = nodeValue !== undefined ? nodeValue : spec.default;
    if (value !== undefined) {
      validateParam(node, name, spec, value);
      values.set(name, value);
    } else if (spec.required) {
      fail("missing_parameter", `node ${node.id} is missing required parameter ${name}`);
    }
  }
  return values;
}

function validateParam(node: SomiteGraphNode, name: string, spec: ParamSpec, value: ParamValue) {
  const typeMatches = spec.type === "bool" ? typeof value === "boolean"
    : spec.type === "int" ? typeof value === "number" && Number.isSafeInteger(value)
      : spec.type === "float" ? typeof value === "number" && Number.isFinite(value)
        : spec.type === "string" ? typeof value === "string" : false;
  if (!typeMatches) {
    fail("invalid_parameter", `node ${node.id} parameter ${name}: expected ${spec.type}, received ${JSON.stringify(value)}`);
  }
  if (typeof value === "number" && Number.isInteger(value)
    && ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) {
    fail(
      "invalid_parameter",
      `node ${node.id} parameter ${name}: value ${value} is outside ${String(spec.min)}..=${String(spec.max)}`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    fail("invalid_parameter", `node ${node.id} parameter ${name}: value must be finite`);
  }
}

function renderMain(processes: readonly string[], workflowLines: readonly string[]) {
  let main = "#!/usr/bin/env nextflow\nnextflow.enable.dsl=2\n\n";
  if (processes.length > 0) main += `${processes.join("\n")}\n`;
  main += "workflow {\n    main:\n";
  for (const line of workflowLines) main += `${line}\n`;
  return `${main}}\n`;
}

function renderConfig() {
  return "process {\n    cache = 'deep'\n    errorStrategy = 'terminate'\n}\n\ntrace {\n    enabled = true\n    file = '.somite/trace.tsv'\n    fields = 'name,status,exit,hash'\n    overwrite = true\n}\n";
}

function renderPixi(options: CompileOptions, requirements: ReadonlySet<string>) {
  const platforms = options.platforms.map((platform) => `"${platform}"`).join(", ");
  let manifest = `[workspace]\nname = "${tomlBasic(options.workflowName)}"\nchannels = ["conda-forge", "bioconda"]\nplatforms = [${platforms}]\n\n[dependencies]\nnextflow = "==${options.nextflowVersion}"\nopenjdk = "==${options.openjdkVersion}"\n`;
  for (const requirement of [...requirements].sort(compareText)) {
    const { channel, packageName, version } = splitRequirement(requirement);
    manifest += channel
      ? `"${tomlBasic(packageName)}" = { version = "${tomlBasic(version)}", channel = "${tomlBasic(channel)}" }\n`
      : `"${tomlBasic(packageName)}" = "${tomlBasic(version)}"\n`;
  }
  return `${manifest}\n[tasks]\nrun = "nextflow run main.nf -params-file params.json -resume"\n`;
}

function splitRequirement(requirement: string) {
  const separator = requirement.indexOf("::");
  const channel = separator >= 0 ? requirement.slice(0, separator) : "";
  const packageRequirement = separator >= 0 ? requirement.slice(separator + 2) : requirement;
  const versionStart = packageRequirement.search(/[=<>!~]/);
  return versionStart >= 0
    ? { channel, packageName: packageRequirement.slice(0, versionStart), version: packageRequirement.slice(versionStart) }
    : { channel, packageName: packageRequirement, version: "*" };
}

function channelKey(node: string, port: string) {
  return `${node}\u0000${port}`;
}

function nestedEngine(value: string) {
  const basename = value.split("/").at(-1)?.toLowerCase() ?? value.toLowerCase();
  return basename === "nextflow" || basename === "snakemake";
}

function exactVersion(value: string) {
  const parts = value.split(".");
  return parts.length >= 2 && parts.every((part) => /^[0-9]+$/.test(part));
}

function safeSpec(value: string) {
  return value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value);
}

function safeStagedBasename(value: string) {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")
    && /^[A-Za-z0-9._-]+$/.test(value);
}

function safeStageBasename(value: string) {
  return value.length > 0 && value !== "." && value !== ".." && ![...value].some((character) => "*?[]".includes(character))
    && /^[A-Za-z0-9._-]+$/.test(value);
}

function ident(value: string) {
  let result = [...value].map((character) => /[A-Za-z0-9]/.test(character) ? character.toUpperCase() : "_").join("");
  if (!result || /^[0-9]/.test(result)) result = `N_${result}`;
  return result;
}

function lowerIdent(value: string) {
  return ident(value).toLowerCase();
}

function shortHash(value: string) {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).toUpperCase().padStart(16, "0").slice(0, 8);
}

function extension(type: PortType) {
  const extensions: Record<PortType, string> = {
    Sra: ".sra",
    Fastq: ".fastq",
    FastqGz: ".fastq.gz",
    Fasta: ".fasta",
    FastaGz: ".fasta.gz",
    Gtf: ".gtf",
    GtfGz: ".gtf.gz",
    Gff3: ".gff3",
    Sam: ".sam",
    Bam: ".bam",
    Bai: ".bai",
    Vcf: ".vcf",
    VcfGz: ".vcf.gz",
    Bed: ".bed",
    Agp: ".agp",
    Chain: ".chain",
    Table: ".tsv",
    Json: ".json",
    Html: ".html",
    Image: ".png",
    Zip: ".zip",
    Directory: "",
    Text: ".txt",
    Preview: ".png",
  };
  return extensions[type];
}

function bashSingle(value: string) {
  return value.replaceAll("'", `'"'"'`);
}

function tomlBasic(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
