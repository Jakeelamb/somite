/** Portable Somite documents retain the established 64 MiB compatibility ceiling. */
export const MAX_WORKFLOW_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** HTTP envelopes add only bounded concurrency and input-origin metadata. */
export const MAX_WORKFLOW_REQUEST_BYTES = MAX_WORKFLOW_DOCUMENT_BYTES + 64 * 1024;
