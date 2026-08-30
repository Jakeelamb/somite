const MEBIBYTE = 1024 * 1024;

/** Portable Somite documents retain the established compatibility ceiling. */
export const MAX_WORKFLOW_DOCUMENT_BYTES = 64 * MEBIBYTE;

/** Workflow HTTP envelopes add only bounded concurrency and input-origin metadata. */
export const MAX_WORKFLOW_REQUEST_BYTES = MAX_WORKFLOW_DOCUMENT_BYTES + 64 * 1024;

/** A resolved Pixi lock may be large, but must remain independently bounded. */
export const MAX_PIXI_LOCK_BYTES = 64 * MEBIBYTE;

/** Generated workflow, manifests, provenance, and archive overhead. */
export const MAX_GENERATED_PACKAGE_BYTES = 128 * MEBIBYTE;

/** One frozen package is the sum of its document, lock, and generated envelopes. */
export const MAX_FROZEN_PACKAGE_BYTES = MAX_WORKFLOW_DOCUMENT_BYTES
  + MAX_PIXI_LOCK_BYTES
  + MAX_GENERATED_PACKAGE_BYTES;

/** Individual Agent details cannot monopolize the retained event envelope. */
export const MAX_AGENT_EVENT_DETAIL_BYTES = 64 * 1024;

/** Agent-provided configuration is retained separately from the event log. */
export const MAX_AGENT_CONFIG_BYTES = MEBIBYTE;

/** Retained Agent events fit within one portable workflow request envelope. */
export const MAX_AGENT_EVENT_LOG_BYTES = MAX_WORKFLOW_REQUEST_BYTES;

/** Snapshot framing, identity, and other fixed metadata have a separate allowance. */
export const MAX_AGENT_SNAPSHOT_OVERHEAD_BYTES = MEBIBYTE;

/**
 * One ACP control frame may carry a complete workflow transaction plus bounded
 * JSON-RPC and tool metadata, but never an unbounded unterminated stdout line.
 */
export const MAX_ACP_CONTROL_FRAME_BYTES = MAX_WORKFLOW_REQUEST_BYTES
  + MAX_AGENT_SNAPSHOT_OVERHEAD_BYTES;

/** Browser and runner share one exact upper bound for an Agent snapshot response. */
export const MAX_AGENT_SNAPSHOT_BYTES = MAX_AGENT_EVENT_LOG_BYTES
  + MAX_AGENT_CONFIG_BYTES
  + MAX_AGENT_SNAPSHOT_OVERHEAD_BYTES;

/** A paper review retains a useful but finite set of cited public resources. */
export const MAX_PAPER_RESOURCE_CITATIONS = 4_096;

/** Paper reviews are independently bounded so completed jobs always cross the API. */
export const MAX_PAPER_REVIEW_BYTES = 16 * MEBIBYTE;

/** Intake status adds only bounded job metadata around a complete paper review. */
export const MAX_PAPER_STATUS_BYTES = MAX_PAPER_REVIEW_BYTES + 64 * 1024;
