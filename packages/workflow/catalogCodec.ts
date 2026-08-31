import type { ParamValue, PortType } from "./model.ts";
import { jsonDigest } from "./contentIdentity.ts";
import type {
  Operator,
  PinnedOperator,
  OperatorResolutionSpec,
  OutputSpec,
  PaperRecognitionSpec,
  ParamSpec,
  PortSpec,
  ResolutionRecipe,
  ResourceResolutionSpec,
  ResourceSpec,
} from "./catalog.ts";

const PORT_TYPES = new Set<PortType>([
  "Sra",
  "Fastq",
  "FastqGz",
  "Fasta",
  "FastaGz",
  "Gtf",
  "GtfGz",
  "Gff3",
  "Sam",
  "Bam",
  "Bai",
  "Vcf",
  "VcfGz",
  "Bed",
  "Agp",
  "Chain",
  "Table",
  "Json",
  "Html",
  "Image",
  "Zip",
  "Directory",
  "Text",
  "Preview",
]);

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, path: string, fields: readonly string[]) {
  const known = new Set(fields);
  const unknown = Object.keys(value).find((field) => !known.has(field));
  if (unknown) throw new Error(`${path} has unknown field ${unknown}`);
}

function string(value: unknown, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string) {
  return value === undefined || value === null ? undefined : string(value, path);
}

function boolean(value: unknown, path: string, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function integer(value: unknown, path: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`);
  return value as number;
}

function optionalInteger(value: unknown, path: string) {
  return value === undefined || value === null ? undefined : integer(value, path);
}

function strings(value: unknown, path: string, fallback: string[] = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => string(item, `${path}[${index}]`));
}

function oneOf<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function paramValue(value: unknown, path: string): ParamValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  throw new Error(`${path} must be a browser-stable string, number, or boolean`);
}

function portType(value: unknown, path: string) {
  if (typeof value !== "string" || !PORT_TYPES.has(value as PortType)) throw new Error(`${path} is not a known port type`);
  return value as PortType;
}

function portTypes(value: unknown, path: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => portType(item, `${path}[${index}]`));
}

function resourceProfile(value: unknown, path: string) {
  const profile = string(value, path);
  if (profile.length > 128 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(profile)) {
    throw new Error(`${path} must be a lowercase resource profile identifier`);
  }
  return profile;
}

function optionalResourceProfile(value: unknown, path: string) {
  return value === undefined || value === null ? undefined : resourceProfile(value, path);
}

function parseParamSpec(value: unknown, path: string): ParamSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["type", "label", "page", "default", "required", "min", "max"]);
  return {
    type: string(raw.type, `${path}.type`),
    ...(optionalString(raw.label, `${path}.label`) !== undefined ? { label: optionalString(raw.label, `${path}.label`) } : {}),
    ...(optionalString(raw.page, `${path}.page`) !== undefined ? { page: optionalString(raw.page, `${path}.page`) } : {}),
    ...(raw.default !== undefined && raw.default !== null ? { default: paramValue(raw.default, `${path}.default`) } : {}),
    required: boolean(raw.required, `${path}.required`),
    ...(optionalInteger(raw.min, `${path}.min`) !== undefined ? { min: optionalInteger(raw.min, `${path}.min`) } : {}),
    ...(optionalInteger(raw.max, `${path}.max`) !== undefined ? { max: optionalInteger(raw.max, `${path}.max`) } : {}),
  };
}

function parseResolution(value: unknown, path: string): ResourceResolutionSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "label", "detail", "kind", "recommended", "download_bytes", "stored_bytes", "scientific_effect", "source_url"]);
  const downloadBytes = optionalInteger(raw.download_bytes, `${path}.download_bytes`);
  const storedBytes = optionalInteger(raw.stored_bytes, `${path}.stored_bytes`);
  const scientificEffect = optionalString(raw.scientific_effect, `${path}.scientific_effect`);
  const sourceUrl = optionalString(raw.source_url, `${path}.source_url`);
  if (sourceUrl !== undefined) {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${path}.source_url must be a credential-free HTTPS URL without a fragment`);
  }
  return {
    id: string(raw.id, `${path}.id`),
    label: string(raw.label, `${path}.label`),
    detail: string(raw.detail, `${path}.detail`),
    kind: oneOf(raw.kind, `${path}.kind`, ["use_existing", "download", "build"]),
    recommended: boolean(raw.recommended, `${path}.recommended`),
    ...(downloadBytes !== undefined ? { download_bytes: downloadBytes } : {}),
    ...(storedBytes !== undefined ? { stored_bytes: storedBytes } : {}),
    ...(scientificEffect !== undefined ? { scientific_effect: scientificEffect } : {}),
    ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
  };
}

function parseResource(value: unknown, path: string): ResourceSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["profile", "title", "detail", "resolutions"]);
  const resolutions = raw.resolutions === undefined ? [] : raw.resolutions;
  if (!Array.isArray(resolutions)) throw new Error(`${path}.resolutions must be an array`);
  return {
    profile: resourceProfile(raw.profile, `${path}.profile`),
    title: string(raw.title, `${path}.title`),
    detail: string(raw.detail, `${path}.detail`),
    resolutions: resolutions.map((item, index) => parseResolution(item, `${path}.resolutions[${index}]`)),
  };
}

function parsePort(value: unknown, path: string): PortSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["name", "type", "union", "optional", "resource", "resource_profile", "stage_as", "import_param"]);
  const resource = raw.resource === undefined || raw.resource === null ? undefined : parseResource(raw.resource, `${path}.resource`);
  const providedResourceProfile = optionalResourceProfile(raw.resource_profile, `${path}.resource_profile`);
  const stageAs = optionalString(raw.stage_as, `${path}.stage_as`);
  const importParam = optionalString(raw.import_param, `${path}.import_param`);
  return {
    name: string(raw.name, `${path}.name`),
    type: portType(raw.type, `${path}.type`),
    union: portTypes(raw.union, `${path}.union`),
    optional: boolean(raw.optional, `${path}.optional`),
    ...(resource ? { resource } : {}),
    ...(providedResourceProfile !== undefined ? { resource_profile: providedResourceProfile } : {}),
    ...(stageAs !== undefined ? { stage_as: stageAs } : {}),
    ...(importParam !== undefined ? { import_param: importParam } : {}),
  };
}

function parseOutput(value: unknown, path: string): OutputSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["glob", "type", "optional", "exclude"]);
  return {
    glob: string(raw.glob, `${path}.glob`),
    type: portType(raw.type, `${path}.type`),
    optional: boolean(raw.optional, `${path}.optional`),
    exclude: strings(raw.exclude, `${path}.exclude`),
  };
}

function parseRecipe(value: unknown, path: string): ResolutionRecipe {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "title", "summary", "version", "kind", "steps", "parameters", "source_url"]);
  const sourceUrl = optionalString(raw.source_url, `${path}.source_url`);
  return {
    id: string(raw.id, `${path}.id`),
    title: string(raw.title, `${path}.title`),
    summary: string(raw.summary, `${path}.summary`),
    version: string(raw.version, `${path}.version`),
    kind: oneOf(raw.kind, `${path}.kind`, ["external_checkpoint", "environment", "method_selection", "artifact_preparation", "adapter_contract"]),
    steps: strings(raw.steps, `${path}.steps`),
    parameters: strings(raw.parameters, `${path}.parameters`),
    ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
  };
}

function parseOperatorResolution(value: unknown, path: string): OperatorResolutionSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["kind", "title", "detail", "action_label", "parameters", "source_url", "recipes"]);
  const recipes = raw.recipes === undefined ? [] : raw.recipes;
  if (!Array.isArray(recipes)) throw new Error(`${path}.recipes must be an array`);
  const sourceUrl = optionalString(raw.source_url, `${path}.source_url`);
  return {
    kind: oneOf(raw.kind, `${path}.kind`, ["manual_checkpoint", "method_details", "legacy_source", "adapter"]),
    title: string(raw.title, `${path}.title`),
    detail: string(raw.detail, `${path}.detail`),
    action_label: string(raw.action_label, `${path}.action_label`),
    parameters: strings(raw.parameters, `${path}.parameters`),
    ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
    recipes: recipes.map((item, index) => parseRecipe(item, `${path}.recipes[${index}]`)),
  };
}

function parsePaper(value: unknown, path: string): PaperRecognitionSpec {
  const raw = object(value, path);
  knownFields(raw, path, ["aliases", "operation_class", "assays"]);
  const operationClass = optionalString(raw.operation_class, `${path}.operation_class`);
  return {
    aliases: strings(raw.aliases, `${path}.aliases`),
    ...(operationClass !== undefined ? { operation_class: operationClass } : {}),
    assays: strings(raw.assays, `${path}.assays`),
  };
}

function parseRecord<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T) {
  if (value === undefined) return {};
  const raw = object(value, path);
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, parse(item, `${path}.${key}`)]));
}

/** Parse untrusted catalog JSON and inject every contract-defaulted field. */
export function parseOperator(value: unknown, path = "operator"): Operator {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "title", "palette", "kind", "cost", "bin", "pixi", "params", "ports", "argv", "outputs", "stdout", "resolution", "paper"]);
  const ports = raw.ports === undefined ? {} : object(raw.ports, `${path}.ports`);
  knownFields(ports, `${path}.ports`, ["in", "out"]);
  const inputPorts = ports.in === undefined ? [] : ports.in;
  const outputPorts = ports.out === undefined ? [] : ports.out;
  if (!Array.isArray(inputPorts) || !Array.isArray(outputPorts)) throw new Error(`${path}.ports in and out must be arrays`);
  const bin = optionalString(raw.bin, `${path}.bin`);
  const stdout = optionalString(raw.stdout, `${path}.stdout`);
  const resolution = raw.resolution === undefined || raw.resolution === null
    ? undefined
    : parseOperatorResolution(raw.resolution, `${path}.resolution`);
  const paper = raw.paper === undefined || raw.paper === null ? undefined : parsePaper(raw.paper, `${path}.paper`);
  return {
    id: string(raw.id, `${path}.id`),
    title: string(raw.title, `${path}.title`),
    palette: strings(raw.palette, `${path}.palette`),
    kind: oneOf(raw.kind, `${path}.kind`, ["external", "inprocess", "reference", "source"]),
    cost: raw.cost === undefined ? "high" : oneOf(raw.cost, `${path}.cost`, ["low", "high"]),
    ...(bin !== undefined ? { bin } : {}),
    pixi: strings(raw.pixi, `${path}.pixi`),
    params: parseRecord(raw.params, `${path}.params`, parseParamSpec),
    ports: {
      in: inputPorts.map((item, index) => parsePort(item, `${path}.ports.in[${index}]`)),
      out: outputPorts.map((item, index) => parsePort(item, `${path}.ports.out[${index}]`)),
    },
    argv: strings(raw.argv, `${path}.argv`),
    outputs: parseRecord(raw.outputs, `${path}.outputs`, parseOutput),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(resolution ? { resolution } : {}),
    ...(paper ? { paper } : {}),
  };
}

/** Parse the runner's catalog response, whose content identity is already pinned. */
export function parsePinnedOperator(value: unknown, path = "operator"): PinnedOperator {
  const raw = object(value, path);
  const revision = string(raw.revision, `${path}.revision`);
  const { revision: _revision, ...operator } = raw;
  const parsed = parseOperator(operator, path);
  const expected = operatorRevision(parsed);
  if (revision !== expected) throw new Error(`${path}.revision does not match the normalized operator contract`);
  return { ...parsed, revision };
}

function sortedRecord<T, R>(record: Readonly<Record<string, T>>, map: (value: T) => R) {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, map(record[key])]));
}

function canonicalParam(spec: ParamSpec) {
  return {
    type: spec.type,
    label: spec.label ?? null,
    page: spec.page ?? null,
    default: spec.default ?? null,
    required: spec.required ?? false,
    min: spec.min ?? null,
    max: spec.max ?? null,
  };
}

function canonicalPort(spec: PortSpec) {
  return {
    name: spec.name,
    type: spec.type,
    union: spec.union ?? [],
    optional: spec.optional ?? false,
    ...(spec.resource ? { resource: canonicalResource(spec.resource) } : {}),
    ...(spec.resource_profile !== undefined ? { resource_profile: spec.resource_profile } : {}),
    ...(spec.stage_as !== undefined ? { stage_as: spec.stage_as } : {}),
    ...(spec.import_param !== undefined ? { import_param: spec.import_param } : {}),
  };
}

function canonicalResource(spec: ResourceSpec) {
  return {
    profile: spec.profile,
    title: spec.title,
    detail: spec.detail,
    resolutions: spec.resolutions.map((resolution) => ({
      id: resolution.id,
      label: resolution.label,
      detail: resolution.detail,
      kind: resolution.kind,
      recommended: resolution.recommended ?? false,
      download_bytes: resolution.download_bytes ?? null,
      stored_bytes: resolution.stored_bytes ?? null,
      scientific_effect: resolution.scientific_effect ?? null,
      source_url: resolution.source_url ?? null,
    })),
  };
}

function canonicalOutput(spec: OutputSpec) {
  return {
    glob: spec.glob,
    type: spec.type,
    optional: spec.optional ?? false,
    exclude: spec.exclude ?? [],
  };
}

function canonicalRecipe(recipe: ResolutionRecipe) {
  return {
    id: recipe.id,
    title: recipe.title,
    summary: recipe.summary,
    version: recipe.version,
    kind: recipe.kind,
    ...(recipe.steps.length ? { steps: recipe.steps } : {}),
    ...(recipe.parameters.length ? { parameters: recipe.parameters } : {}),
    ...(recipe.source_url !== undefined ? { source_url: recipe.source_url } : {}),
  };
}

function canonicalOperatorResolution(resolution: OperatorResolutionSpec) {
  return {
    kind: resolution.kind,
    title: resolution.title,
    detail: resolution.detail,
    action_label: resolution.action_label,
    ...(resolution.parameters.length ? { parameters: resolution.parameters } : {}),
    ...(resolution.source_url !== undefined ? { source_url: resolution.source_url } : {}),
    ...(resolution.recipes.length ? { recipes: resolution.recipes.map(canonicalRecipe) } : {}),
  };
}

function canonicalPaper(paper: PaperRecognitionSpec) {
  return {
    ...(paper.aliases.length ? { aliases: paper.aliases } : {}),
    ...(paper.operation_class !== undefined ? { operation_class: paper.operation_class } : {}),
    ...(paper.assays.length ? { assays: paper.assays } : {}),
  };
}

function canonicalOperator(operator: Operator) {
  return {
    id: operator.id,
    title: operator.title,
    palette: operator.palette,
    kind: operator.kind,
    cost: operator.cost,
    bin: operator.bin ?? null,
    pixi: operator.pixi ?? [],
    params: sortedRecord(operator.params, canonicalParam),
    ports: {
      in: operator.ports.in.map(canonicalPort),
      out: operator.ports.out.map(canonicalPort),
    },
    argv: operator.argv ?? [],
    outputs: sortedRecord(operator.outputs ?? {}, canonicalOutput),
    ...(operator.stdout !== undefined ? { stdout: operator.stdout } : {}),
    ...(operator.resolution ? { resolution: canonicalOperatorResolution(operator.resolution) } : {}),
    ...(operator.paper ? { paper: canonicalPaper(operator.paper) } : {}),
  };
}

/** Exact normalized JSON document written into frozen Operator manifests. */
export function operatorDocument(operator: Operator) {
  return canonicalOperator(operator);
}

/** Stable content identity locked by the shared parity fixtures. */
export function operatorRevision(operator: Operator) {
  const canonical = canonicalOperator(operator);
  return jsonDigest({
    id: canonical.id,
    kind: canonical.kind,
    bin: canonical.bin,
    pixi: canonical.pixi,
    params: sortedRecord(operator.params, (spec) => ({
      ty: spec.type,
      default: spec.default ?? null,
      required: spec.required ?? false,
      min: spec.min ?? null,
      max: spec.max ?? null,
    })),
    ports: canonical.ports,
    argv: canonical.argv,
    outputs: canonical.outputs,
    ...(operator.stdout !== undefined ? { stdout: operator.stdout } : {}),
    ...(operator.resolution ? { resolution: canonicalOperatorResolution(operator.resolution) } : {}),
  });
}

/** Stable search-catalog identity locked by the shared parity fixtures. */
export function catalogRevision(operators: Iterable<Operator>) {
  const sorted = [...operators].sort((left, right) => left.id.localeCompare(right.id));
  return jsonDigest(Object.fromEntries(sorted.map((operator) => [operator.id, canonicalOperator(operator)])));
}
