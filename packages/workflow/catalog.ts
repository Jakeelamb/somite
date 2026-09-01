import type { ParamValue, PortType, SomiteGraph, SomiteGraphNode, SomitePort } from "./model.ts";
import { GRAPH_SCHEMA_VERSION } from "./model.ts";

export type ParamSpec = {
  type: string;
  label?: string;
  page?: string;
  default?: ParamValue;
  required?: boolean;
  min?: number;
  max?: number;
};

export type ResourceResolutionKind = "use_existing" | "download" | "build";

export type ResourceResolutionSpec = {
  id: string;
  label: string;
  detail: string;
  kind: ResourceResolutionKind;
  recommended?: boolean;
  download_bytes?: number | null;
  stored_bytes?: number | null;
  scientific_effect?: string;
  source_url?: string;
};

export type ResourceSpec = {
  profile: string;
  title: string;
  detail: string;
  resolutions: ResourceResolutionSpec[];
};

export type PortSpec = {
  name: string;
  type: PortType;
  union?: PortType[];
  optional?: boolean;
  /** Scientific resource format provided by this output, beyond its physical artifact type. */
  resource_profile?: string;
  resource?: ResourceSpec;
  stage_as?: string;
  import_param?: string;
  /** The executable discovers this staged input by its conventional basename instead of an argv flag. */
  implicit_sidecar?: boolean;
};

export type OutputSpec = {
  glob: string;
  type: PortType;
  optional?: boolean;
  exclude?: string[];
};

export type OperatorResolutionKind = "manual_checkpoint" | "method_details" | "legacy_source" | "adapter";
export type ResolutionRecipeKind = "external_checkpoint" | "environment" | "method_selection" | "artifact_preparation" | "adapter_contract";

export type ResolutionRecipe = {
  id: string;
  title: string;
  summary: string;
  version: string;
  kind: ResolutionRecipeKind;
  steps: string[];
  parameters: string[];
  source_url?: string | null;
};

export type OperatorResolutionSpec = {
  kind: OperatorResolutionKind;
  title: string;
  detail: string;
  action_label: string;
  parameters: string[];
  source_url?: string;
  recipes: ResolutionRecipe[];
};

export type PaperRecognitionSpec = {
  aliases: string[];
  operation_class?: string;
  assays: string[];
};

/**
 * A normalized operator contract. Presentation-only fields at the bottom are
 * deliberately excluded from execution identity.
 */
export type Operator = {
  id: string;
  revision?: string;
  title: string;
  palette: string[];
  kind: "external" | "inprocess" | "reference" | "source";
  cost: "low" | "high";
  bin?: string;
  pixi?: string[];
  params: Record<string, ParamSpec>;
  ports: { in: PortSpec[]; out: PortSpec[] };
  argv?: string[];
  outputs?: Record<string, OutputSpec>;
  stdout?: string;
  resolution?: OperatorResolutionSpec;
  paper?: PaperRecognitionSpec;
  description?: string;
  topics?: string[];
  expandable?: boolean;
};

export type PinnedOperator = Operator & { revision: string };

export type CatalogIssueCode =
  | "graph_schema"
  | "source_workflow_graph_shape"
  | "unknown_operator"
  | "revision_mismatch"
  | "port_contract_mismatch"
  | "resource_profile_mismatch"
  | "source_workflow_contract_mismatch";

export type CatalogIssue = Readonly<{ code: CatalogIssueCode; message: string }>;
export type CatalogVerification = Readonly<{ ok: true }> | Readonly<{ ok: false; issue: CatalogIssue }>;

function failure(code: CatalogIssueCode, message: string): CatalogVerification {
  return { ok: false, issue: { code, message } };
}

function normalizedPort(port: SomitePort) {
  return {
    name: port.name,
    dir: port.dir,
    ty: port.ty,
    union: port.union ?? [],
    optional: port.optional ?? false,
  };
}

function samePorts(left: readonly SomitePort[], right: readonly SomitePort[]) {
  return JSON.stringify(left.map(normalizedPort)) === JSON.stringify(right.map(normalizedPort));
}

export function operatorPorts(operator: Operator): SomitePort[] {
  return [
    ...operator.ports.in.map((port) => ({
      name: port.name,
      dir: "in" as const,
      ty: port.type,
      ...(port.union?.length ? { union: [...port.union] } : {}),
      ...(port.optional ? { optional: true } : {}),
    })),
    ...operator.ports.out.map((port) => ({
      name: port.name,
      dir: "out" as const,
      ty: port.type,
      ...(port.union?.length ? { union: [...port.union] } : {}),
      ...(port.optional ? { optional: true } : {}),
    })),
  ];
}

export type OperatorImportPath = Readonly<{
  port: string;
  parameter: string;
  kind: "file" | "directory";
}>;

/** The exact local path parameters consumed directly by one in-process import operator. */
export function operatorImportPaths(operator: Operator): readonly OperatorImportPath[] {
  return operator.ports.out
    .filter((port) => port.import_param !== undefined)
    .map((port) => ({
      port: port.name,
      parameter: port.import_param!,
      kind: port.type === "Directory" ? "directory" as const : "file" as const,
    }));
}

export type OperatorContractIssueCode =
  | "missing_binary"
  | "missing_argv"
  | "unknown_input_reference"
  | "unknown_input_condition"
  | "unconsumed_input"
  | "unguarded_optional_input"
  | "unknown_parameter_reference"
  | "missing_output_rule"
  | "extra_output_rule"
  | "output_type_mismatch"
  | "output_optionality_mismatch"
  | "unsupported_output_exclude"
  | "unsupported_output_placeholder"
  | "unknown_stdout_output"
  | "invalid_import_parameter"
  | "unsupported_inprocess";

export type OperatorContractIssue = Readonly<{
  code: OperatorContractIssueCode;
  message: string;
}>;

function contractIssue(code: OperatorContractIssueCode, message: string): OperatorContractIssue {
  return { code, message };
}

/**
 * Cross-field invariants for one reviewed execution contract.
 *
 * The JSON codec validates shape. This validates that ports, argv, output
 * collection, and in-process lowering describe the same executable behavior.
 */
export function operatorContractIssues(operator: Operator): readonly OperatorContractIssue[] {
  const issues: OperatorContractIssue[] = [];
  if (operator.kind === "external") {
    if (!operator.bin?.trim()) issues.push(contractIssue("missing_binary", `${operator.id}: external operator has no executable binary`));
    if ((operator.argv ?? []).length === 0) issues.push(contractIssue("missing_argv", `${operator.id}: external operator argv is empty`));

    const inputs = new Map(operator.ports.in.map((port) => [port.name, port]));
    const references = new Map<string, Array<{ condition?: string }>>();
    for (const configured of operator.argv ?? []) {
      const conditional = /^(\?!|\?)([^:]+):/.exec(configured);
      const condition = conditional?.[2];
      if (condition !== undefined && !inputs.has(condition)) {
        issues.push(contractIssue("unknown_input_condition", `${operator.id}: argv conditions on unknown input ${condition}`));
      }
      for (const match of configured.matchAll(/\{input\.([^}]+)\}/g)) {
        const name = match[1]!;
        if (!inputs.has(name)) {
          issues.push(contractIssue("unknown_input_reference", `${operator.id}: argv references unknown input ${name}`));
          continue;
        }
        const uses = references.get(name) ?? [];
        uses.push({ ...(condition === undefined ? {} : { condition }) });
        references.set(name, uses);
      }
      for (const match of configured.matchAll(/\{(?:param|flag)\.([^}]+)\}/g)) {
        const name = match[1]!;
        if (!Object.hasOwn(operator.params, name)) {
          issues.push(contractIssue("unknown_parameter_reference", `${operator.id}: argv references unknown parameter ${name}`));
        }
      }
    }
    for (const input of operator.ports.in) {
      const uses = references.get(input.name) ?? [];
      if (uses.length === 0 && !input.implicit_sidecar) {
        issues.push(contractIssue("unconsumed_input", `${operator.id}.${input.name}: declared input is never consumed`));
      }
      if (input.optional && uses.some((reference) => reference.condition !== input.name)) {
        issues.push(contractIssue(
          "unguarded_optional_input",
          `${operator.id}.${input.name}: optional input is referenced outside its own conditional argv token`,
        ));
      }
    }

    const outputs = new Map(operator.ports.out.map((port) => [port.name, port]));
    for (const port of operator.ports.out) {
      const spec = operator.outputs?.[port.name];
      if (!spec) {
        issues.push(contractIssue("missing_output_rule", `${operator.id}.${port.name}: output port has no collection rule`));
        continue;
      }
      if (spec.type !== port.type) {
        issues.push(contractIssue(
          "output_type_mismatch",
          `${operator.id}.${port.name}: output port declares ${port.type}, collection rule declares ${spec.type}`,
        ));
      }
      if (Boolean(spec.optional) !== Boolean(port.optional)) {
        issues.push(contractIssue(
          "output_optionality_mismatch",
          `${operator.id}.${port.name}: output optionality differs between port and collection rule`,
        ));
      }
      if ((spec.exclude ?? []).length > 0) {
        issues.push(contractIssue(
          "unsupported_output_exclude",
          `${operator.id}.${port.name}: output exclusions are not supported by the Nextflow compiler`,
        ));
      }
      const controlledPattern = spec.glob
        .replaceAll("{work}/out", "somite_out")
        .replaceAll("{work}/tmp", "somite_tmp")
        .replaceAll("{work}", ".");
      if (controlledPattern.includes("{")) {
        issues.push(contractIssue(
          "unsupported_output_placeholder",
          `${operator.id}.${port.name}: output collection contains an unsupported placeholder`,
        ));
      }
    }
    for (const output of Object.keys(operator.outputs ?? {})) {
      if (!outputs.has(output)) {
        issues.push(contractIssue("extra_output_rule", `${operator.id}.${output}: collection rule has no output port`));
      }
    }
    if (operator.stdout !== undefined && !outputs.has(operator.stdout)) {
      issues.push(contractIssue("unknown_stdout_output", `${operator.id}: stdout names unknown output ${operator.stdout}`));
    }
  } else if (operator.kind === "inprocess") {
    const paths = operatorImportPaths(operator);
    for (const path of paths) {
      if (!Object.hasOwn(operator.params, path.parameter)) {
        issues.push(contractIssue(
          "invalid_import_parameter",
          `${operator.id}.${path.port}: import parameter ${path.parameter} is not declared`,
        ));
      }
    }
    if (paths.length === 0 && !operator.resolution) {
      issues.push(contractIssue(
        "unsupported_inprocess",
        `${operator.id}: in-process operator has neither path-import lowering nor an explicit unresolved contract`,
      ));
    }
  }
  return issues;
}

function stringParam(node: SomiteGraphNode, name: string) {
  const value = node.params?.[name];
  return typeof value === "string" && value.trim() ? value : null;
}

function componentAcceptsReads(label: string) {
  const component = (label.split(":").at(-1) ?? label).toUpperCase();
  return [
    "FASTQ",
    "FASTQC",
    "FASTP",
    "FQ_",
    "TRIMGALORE",
    "CUTADAPT",
    "BBSPLIT",
    "PORECHOP",
    "NANOPLOT",
    "FILTLONG",
    "CHOPPER",
    "UMITOOLS",
    "SEQKIT",
    "ALIGN",
  ].some((marker) => component.includes(marker));
}

function referencePorts(component: string, boundary: boolean, incomingCount: number): SomitePort[] {
  const ports: SomitePort[] = boundary && componentAcceptsReads(component)
    ? [
        { name: "r1", dir: "in", ty: "Fastq", union: ["FastqGz"] },
        { name: "r2", dir: "in", ty: "Fastq", union: ["FastqGz"], optional: true },
      ]
    : Array.from({ length: Math.max(incomingCount, 1) }, (_, index) => ({
        name: index === 0 ? "in" : `in_${index + 1}`,
        dir: "in" as const,
        ty: "Directory" as const,
        optional: true,
      }));
  ports.push({ name: "out", dir: "out", ty: "Directory", optional: true });
  return ports;
}

export function referenceNodeContractIsValid(node: SomiteGraphNode) {
  if (node.operator !== "workflow.reference" || Object.keys(node.params ?? {}).length !== 4) return false;
  const engine = stringParam(node, "engine");
  if (engine !== "nextflow" && engine !== "snakemake") return false;
  if (!stringParam(node, "workflow") || !stringParam(node, "revision")) return false;
  const component = stringParam(node, "component");
  if (!component) return false;
  const inputCount = node.ports.filter((port) => port.dir === "in").length;
  return samePorts(node.ports, referencePorts(component, false, inputCount))
    || samePorts(node.ports, referencePorts(component, true, 0));
}

/**
 * Immutable lookup for pinned operator contracts. It owns duplicate detection
 * and catalog verification so callers cannot accidentally verify against a
 * hand-built, partial map.
 */
export class OperatorCatalog {
  readonly #operators: ReadonlyMap<string, PinnedOperator>;

  constructor(operators: readonly Operator[]) {
    const byId = new Map<string, PinnedOperator>();
    for (const operator of operators) {
      if (byId.has(operator.id)) throw new Error(`duplicate operator id ${operator.id}`);
      if (!operator.revision?.trim()) throw new Error(`operator ${operator.id} has no revision`);
      byId.set(operator.id, operator as PinnedOperator);
    }
    this.#operators = byId;
  }

  get size() {
    return this.#operators.size;
  }

  get(id: string) {
    return this.#operators.get(id);
  }

  values() {
    return this.#operators.values();
  }

  isExtensionOf(previous: OperatorCatalog) {
    for (const operator of previous.values()) {
      if (this.#operators.get(operator.id)?.revision !== operator.revision) return false;
    }
    return true;
  }

  groups() {
    const groups = new Map<string, PinnedOperator[]>();
    for (const operator of [...this.#operators.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const key = operator.palette.length ? operator.palette.join("/") : "Other";
      const group = groups.get(key) ?? [];
      group.push(operator);
      groups.set(key, group);
    }
    return groups;
  }

  verifyGraph(graph: SomiteGraph): CatalogVerification {
    if (graph.schema_version !== GRAPH_SCHEMA_VERSION) {
      return failure("graph_schema", `graph schema ${graph.schema_version} cannot be migrated`);
    }
    const sourceNodes = graph.nodes.filter((node) => node.source_workflow !== undefined).length;
    if (sourceNodes > 0 && (sourceNodes !== 1 || graph.nodes.length !== 1 || graph.edges.length !== 0)) {
      return failure("source_workflow_graph_shape", "source-backed workflows currently require one source node and no edges");
    }
    for (const node of graph.nodes) {
      const issue = this.#verifyNode(node);
      if (issue) return issue;
    }
    if (graph.variant_origin) {
      const issue = this.#verifyNode(graph.variant_origin.source_node);
      if (issue) return issue;
    }
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      const sourceNode = nodes.get(edge.from_node);
      const targetNode = nodes.get(edge.to_node);
      if (!sourceNode || !targetNode) continue;
      const sourceOperator = this.#operators.get(sourceNode.operator);
      const targetOperator = this.#operators.get(targetNode.operator);
      if (!sourceOperator || !targetOperator) continue;
      const requiredProfile = targetOperator.ports.in
        .find((port) => port.name === edge.to_port)
        ?.resource?.profile;
      if (!requiredProfile) continue;
      const providedProfile = sourceOperator.ports.out
        .find((port) => port.name === edge.from_port)
        ?.resource_profile;
      if (providedProfile !== requiredProfile) {
        return failure(
          "resource_profile_mismatch",
          `edge ${edge.id} requires resource profile ${requiredProfile} at ${edge.to_node}.${edge.to_port}, but ${edge.from_node}.${edge.from_port} provides ${providedProfile ? `resource profile ${providedProfile}` : "no resource profile"}`,
        );
      }
    }
    return { ok: true };
  }

  #verifyNode(node: SomiteGraphNode): CatalogVerification | null {
    const operator = this.#operators.get(node.operator);
    if (!operator) return failure("unknown_operator", `unknown operator ${node.operator}`);
    if (node.operator_revision !== operator.revision) {
      return failure(
        "revision_mismatch",
        `node ${node.id} pins operator ${node.operator} revision ${node.operator_revision}, expected ${operator.revision}`,
      );
    }
    if ((operator.kind === "source") !== (node.source_workflow !== undefined)) {
      return failure(
        "source_workflow_contract_mismatch",
        `node ${node.id} source workflow does not match operator ${node.operator}`,
      );
    }
    if (node.source_workflow && Object.keys(node.params ?? {}).length > 0) {
      return failure(
        "source_workflow_contract_mismatch",
        `node ${node.id} source workflow does not match operator ${node.operator}`,
      );
    }
    for (const replacement of node.source_workflow?.replacements ?? []) {
      const replacementOperator = this.#operators.get(replacement.operator);
      if (!replacementOperator) return failure("unknown_operator", `unknown operator ${replacement.operator}`);
      if (replacement.operator_revision !== replacementOperator.revision) {
        return failure(
          "revision_mismatch",
          `node ${node.id}::${replacement.invocation_id} pins operator ${replacement.operator} revision ${replacement.operator_revision}, expected ${replacementOperator.revision}`,
        );
      }
    }
    const structuralAdapter = operator.resolution?.kind === "adapter";
    const validWorkflowReference = operator.id === "workflow.reference"
      && operator.kind === "reference"
      && referenceNodeContractIsValid(node);
    if (!samePorts(node.ports, operatorPorts(operator)) && !structuralAdapter && !validWorkflowReference) {
      return failure("port_contract_mismatch", `node ${node.id} ports do not match operator ${node.operator}`);
    }
    return null;
  }
}

export type CommandBindings = Readonly<{
  params: Readonly<Record<string, ParamValue>>;
  inputs: Readonly<Record<string, string>>;
  workOut: string;
  workTmp: string;
  work: string;
}>;

function substitute(token: string, bindings: CommandBindings) {
  let value = token
    .replaceAll("{work}/out", bindings.workOut)
    .replaceAll("{work}/tmp", bindings.workTmp)
    .replaceAll("{work}", bindings.work);
  value = value.replaceAll(/\{param\.([^}]+)\}/g, (_, name: string) => {
    const parameter = bindings.params[name];
    if (parameter === undefined) throw new Error(`argv: missing param ${name}`);
    return String(parameter);
  });
  value = value.replaceAll(/\{input\.([^}]+)\}/g, (_, name: string) => {
    const input = bindings.inputs[name];
    if (input === undefined) throw new Error(`argv: missing input ${name}`);
    return input;
  });
  if (value.includes("{")) throw new Error(`argv: unresolved ${value}`);
  return value;
}

export function renderArgv(operator: Operator, bindings: CommandBindings) {
  const rendered: string[] = [];
  for (const configured of operator.argv ?? []) {
    const conditional = configured.match(/^(\?!|\?)([^:]+):([\s\S]*)$/);
    let token = configured;
    if (conditional) {
      const [, mode, name, value] = conditional;
      if (!operator.ports.in.some((port) => port.name === name)) {
        throw new Error(`argv: unknown conditional input ${name}`);
      }
      const bound = bindings.inputs[name] !== undefined;
      if ((mode === "?" && !bound) || (mode === "?!" && bound)) continue;
      token = value;
    }
    const flag = token.match(/^\{flag\.([^}]+)\}$/);
    if (flag) {
      const parameter = bindings.params[flag[1]];
      if (parameter === true) rendered.push(`--${flag[1].replaceAll("_", "-")}`);
      else if (parameter !== false && parameter !== undefined) rendered.push(substitute(token, bindings));
      continue;
    }
    const exactInput = token.match(/^\{input\.([^/{}}]+)\}$/);
    if (exactInput) {
      const name = exactInput[1];
      const input = bindings.inputs[name];
      if (input !== undefined) rendered.push(input);
      else if (operator.ports.in.some((port) => port.name === name && port.optional)) {
        if (rendered.at(-1)?.startsWith("-")) rendered.pop();
      } else {
        throw new Error(`argv: missing input ${name}`);
      }
      continue;
    }
    rendered.push(substitute(token, bindings));
  }
  return rendered;
}

function splitRequirement(requirement: string) {
  const separator = requirement.indexOf("::");
  const channel = separator >= 0 ? requirement.slice(0, separator) : "";
  const packageRequirement = separator >= 0 ? requirement.slice(separator + 2) : requirement;
  const versionStart = packageRequirement.search(/[=<>!~]/);
  return {
    channel,
    package: versionStart >= 0 ? packageRequirement.slice(0, versionStart) : packageRequirement,
    version: versionStart >= 0 ? packageRequirement.slice(versionStart) : "*",
  };
}

function safeWorkspaceName(name: string) {
  const safe = [...name]
    .map((character) => /[A-Za-z0-9_-]/.test(character) ? character : "-")
    .join("")
    .replace(/^-+|-+$/g, "");
  return safe || "somite-workflow";
}

export function renderPixiManifest(name: string, platform: string, operators: Iterable<Operator>) {
  const requirements = [...new Set([...operators].flatMap((operator) => operator.pixi ?? []))].sort();
  let manifest = `[workspace]\nname = "${safeWorkspaceName(name)}"\nchannels = ["conda-forge", "bioconda"]\nplatforms = ["${platform}"]\n\n[dependencies]\n`;
  for (const requirement of requirements) {
    const dependency = splitRequirement(requirement);
    manifest += dependency.channel
      ? `"${dependency.package}" = { version = "${dependency.version}", channel = "${dependency.channel}" }\n`
      : `"${dependency.package}" = "${dependency.version}"\n`;
  }
  return manifest;
}
