import type { ReadinessItem, ReadinessSnapshot, ValidationEvidenceResponse } from "./types";

export type ReadinessTone = "checking" | "building" | "attention" | "ready" | "validated";

export function readinessSummary(
  snapshot: ReadinessSnapshot | null,
  running: boolean,
  evidence: ValidationEvidenceResponse | null,
) {
  if (running) return { label: "Preparing", detail: "Execution is active", tone: "checking" as const };
  if (!snapshot) return { label: "Checking readiness…", detail: "Inspecting this graph", tone: "checking" as const };
  if (snapshot.state === "empty") return { label: "Start building", detail: "Add a tool or input", tone: "building" as const };
  if (snapshot.required_count > 0) {
    const count = snapshot.required_count;
    return {
      label: `Needs ${count} item${count === 1 ? "" : "s"}`,
      detail: "Open readiness for exact requirements",
      tone: "attention" as const,
    };
  }
  if (evidence?.receipt?.result === "passed") {
    return { label: "Validated", detail: "Representative evidence is current", tone: "validated" as const };
  }
  return { label: "Ready", detail: "All required inputs are connected", tone: "ready" as const };
}

export function formatResourceBytes(bytes?: number | null) {
  if (bytes == null) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const precision = unit === 0 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

export function readinessAgentPrompt(item: ReadinessItem, graphRevision: string) {
  const options = item.resolutions
    .map((resolution) => {
      const download = formatResourceBytes(resolution.download_bytes);
      const stored = formatResourceBytes(resolution.stored_bytes);
      const sizes = [download && `download ${download}`, stored && `stored ${stored}`].filter(Boolean).join(", ");
      return `- ${resolution.label}${sizes ? ` (${sizes})` : ""}: ${resolution.detail}${resolution.scientific_effect ? ` Scientific effect: ${resolution.scientific_effect}` : ""}`;
    })
    .join("\n");
  return [
    "Help me resolve this deterministic Somite readiness requirement.",
    `Graph revision: ${graphRevision}`,
    `Requirement: ${item.id}`,
    `Node: ${item.node_id} (${item.operator_id})`,
    `Field: ${item.field}`,
    `Kind: ${item.kind}`,
    `Detail: ${item.detail}`,
    options ? `Known resolutions:\n${options}` : "",
    "Use Somite tools immediately. Treat Somite readiness as the final authority, and ask before making a scientific choice that changes reference coverage.",
  ].filter(Boolean).join("\n");
}
