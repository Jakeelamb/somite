import { lstat, realpath } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import type { SomiteGraph } from "@somite/workflow/model";
import { graphStateRevision } from "@somite/workflow/workflow";

import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import type { GraphInputLocation } from "./productionGraph.ts";

const MAX_ORIGINS = 256;
const MAX_CONTEXT_BYTES = 16 * 1024;

type PersistedInputOrigin = Readonly<{
  schema_version: 1;
  graph_state_revision: string;
  workspace_graph_base: string;
  graph_base: string;
  relative_input_order: GraphInputLocation["relativeInputOrder"];
}>;

export class InputOriginError extends Error {
  readonly code: "input_origin_invalid" | "input_origin_unknown" | "input_origin_limit" | "input_origin_recovery_required";

  constructor(code: InputOriginError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InputOriginError";
    this.code = code;
  }
}

async function canonicalDirectory(path: string, label: string, exact = false) {
  const absolute = resolve(path);
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("not a regular directory");
    const canonical = await realpath(absolute);
    if (exact && canonical !== absolute) throw new Error("saved path crosses a symbolic link");
    return canonical;
  } catch (error) {
    throw new InputOriginError("input_origin_invalid", `${label} is not an available canonical directory`, error);
  }
}

function persistedContext(value: unknown): PersistedInputOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputOriginError("input_origin_invalid", "saved input origin must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "graph_state_revision", "workspace_graph_base", "graph_base", "relative_input_order"]);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) throw new InputOriginError("input_origin_invalid", `saved input origin contains unknown field ${unknown}`);
  if (record.schema_version !== 1
    || typeof record.graph_state_revision !== "string"
    || typeof record.workspace_graph_base !== "string"
    || typeof record.graph_base !== "string"
    || (record.relative_input_order !== "project_first" && record.relative_input_order !== "graph_first")) {
    throw new InputOriginError("input_origin_invalid", "saved input origin has an invalid contract");
  }
  return record as PersistedInputOrigin;
}

/**
 * Keeps the runner-only base of an opened graph out of its portable document
 * and browser payload. Callers retain an opaque identifier; this module owns
 * canonicalization, lookup, and association with the exact recovered graph.
 */
export class InputOrigins {
  readonly #contextPath: string;
  readonly #byId = new Map<string, GraphInputLocation>();
  readonly #byLocation = new Map<string, string>();
  #currentId = "";
  #workspaceGraphBase = "";
  warning: string | null = null;

  private constructor(contextPath: string) {
    this.#contextPath = contextPath;
  }

  static async open(projectRoot: string, workspaceGraphPath: string, defaultGraphBase: string, graph: SomiteGraph) {
    const contextRoot = await ensurePrivateDirectory(projectRoot, ".somite/input-origins");
    const workspaceKey = createHash("sha256").update(resolve(workspaceGraphPath)).digest("hex");
    const origins = new InputOrigins(join(contextRoot, `${workspaceKey}.json`));
    const initialId = await origins.#register(defaultGraphBase, "project_first");
    origins.#currentId = initialId;
    origins.#workspaceGraphBase = origins.location(initialId).graphBase;
    if (!await pathExists(origins.#contextPath)) return origins;
    try {
      const bytes = await regularFile(origins.#contextPath, MAX_CONTEXT_BYTES, "saved input origin");
      const persisted = persistedContext(JSON.parse(new TextDecoder().decode(bytes)));
      if (persisted.workspace_graph_base !== origins.#workspaceGraphBase) {
        origins.warning = "Saved workflow input location belongs to a different project graph; using the current graph location.";
        return origins;
      }
      if (persisted.graph_state_revision !== graphStateRevision(graph)) {
        origins.warning = "Saved workflow input location does not match the recovered canvas; using the current graph location.";
        return origins;
      }
      const restoredId = await origins.#register(persisted.graph_base, persisted.relative_input_order, true);
      origins.#currentId = restoredId;
    } catch (error) {
      origins.warning = `Saved workflow input location could not be restored: ${error instanceof Error ? error.message : String(error)}`;
    }
    return origins;
  }

  get currentId() {
    return this.#currentId;
  }

  location(originId = this.#currentId): GraphInputLocation {
    if (typeof originId !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(originId)) {
      throw new InputOriginError("input_origin_unknown", "input origin identifier is invalid");
    }
    const location = this.#byId.get(originId);
    if (!location) throw new InputOriginError("input_origin_unknown", "input origin is not known to this Somite session");
    return location;
  }

  requireRecovered() {
    if (!this.warning) return;
    throw new InputOriginError(
      "input_origin_recovery_required",
      "Workflow input location needs confirmation before Somite can save or materialize files. Reopen the original .somite.json file, or explicitly use this project folder.",
    );
  }

  executionLocation(originId = this.#currentId) {
    this.requireRecovered();
    return this.location(originId);
  }

  async registerOpenedGraph(graphBase: string) {
    return this.#register(graphBase, "graph_first");
  }

  async record(originId: string, graph: SomiteGraph) {
    this.requireRecovered();
    await this.#persist(originId, graph);
  }

  async recover(originId: string, graph: SomiteGraph) {
    const location = this.location(originId);
    const available = await canonicalDirectory(location.graphBase, "workflow input location", true);
    if (available !== location.graphBase) throw new InputOriginError("input_origin_invalid", "workflow input location changed before recovery");
    await this.#persist(originId, graph);
    this.warning = null;
  }

  async #persist(originId: string, graph: SomiteGraph) {
    const location = this.location(originId);
    const persisted: PersistedInputOrigin = {
      schema_version: 1,
      graph_state_revision: graphStateRevision(graph),
      workspace_graph_base: this.#workspaceGraphBase,
      graph_base: location.graphBase,
      relative_input_order: location.relativeInputOrder,
    };
    await atomicWrite(this.#contextPath, `${JSON.stringify(persisted, null, 2)}\n`);
    this.#currentId = originId;
  }

  async #register(graphBase: string, relativeInputOrder: GraphInputLocation["relativeInputOrder"], exact = false) {
    const canonical = await canonicalDirectory(graphBase, "workflow graph directory", exact);
    const key = `${relativeInputOrder}\0${canonical}`;
    const existing = this.#byLocation.get(key);
    if (existing) return existing;
    if (this.#byId.size >= MAX_ORIGINS) {
      throw new InputOriginError("input_origin_limit", `this Somite session already tracks ${MAX_ORIGINS} workflow input locations`);
    }
    const id = randomBytes(18).toString("base64url");
    this.#byId.set(id, { graphBase: canonical, relativeInputOrder });
    this.#byLocation.set(key, id);
    return id;
  }
}
