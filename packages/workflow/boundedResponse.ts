export class ResponseSizeError extends Error {
  readonly code = "response_too_large";
  readonly maximumBytes: number;

  constructor(maximumBytes: number, label = "Response") {
    super(`${label} exceeds ${maximumBytes} bytes.`);
    this.name = "ResponseSizeError";
    this.maximumBytes = maximumBytes;
  }
}

export class ResponseHeaderError extends Error {
  readonly code = "response_invalid_content_length";

  constructor(label = "Response") {
    super(`${label} has an invalid Content-Length header.`);
    this.name = "ResponseHeaderError";
  }
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

/** Read a web response without trusting Content-Length or buffering past the limit. */
export async function boundedResponseBytes(response: Response, maximumBytes: number, label = "Response"): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Response limit must be a positive safe integer.");
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const bytes = Number(advertised);
    if (!/^\d+$/.test(advertised) || !Number.isSafeInteger(bytes)) {
      await cancelBody(response);
      throw new ResponseHeaderError(label);
    }
    if (bytes > maximumBytes) {
      await cancelBody(response);
      throw new ResponseSizeError(maximumBytes, label);
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  let storage = new Uint8Array(Math.min(maximumBytes, 64 * 1024));
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return storage.subarray(0, used);
      const required = used + value.byteLength;
      if (required > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseSizeError(maximumBytes, label);
      }
      if (required > storage.byteLength) {
        const capacity = Math.min(maximumBytes, Math.max(required, storage.byteLength * 2));
        const expanded = new Uint8Array(capacity);
        expanded.set(storage.subarray(0, used));
        storage = expanded;
      }
      storage.set(value, used);
      used = required;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
