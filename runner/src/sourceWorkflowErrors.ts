export type SourceWorkflowTrustCode =
  | "source_object_invalid"
  | "workflow_revision_invalid"
  | "source_derivation_mismatch"
  | "binding_invalid"
  | "replacement_invalid";

/** A source-workflow failure at a runner trust boundary, safe to return as 422. */
export class SourceWorkflowTrustError extends Error {
  readonly code: SourceWorkflowTrustCode;

  constructor(code: SourceWorkflowTrustCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SourceWorkflowTrustError";
    this.code = code;
  }
}

export function sourceWorkflowTrustFailure(
  code: SourceWorkflowTrustCode,
  message: string,
  cause?: unknown,
): never {
  throw new SourceWorkflowTrustError(code, message, cause);
}
