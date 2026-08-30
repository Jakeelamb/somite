import { Transform, type TransformCallback } from "node:stream";

import { MAX_ACP_CONTROL_FRAME_BYTES } from "@somite/workflow/limits";

export class NdjsonFrameSizeError extends Error {
  readonly code = "acp_frame_too_large";
  readonly actual_bytes: number;
  readonly maximum_bytes: number;

  constructor(actualBytes: number, maximumBytes: number) {
    super(`ACP stdout frame exceeds ${maximumBytes} bytes (acp_frame_too_large)`);
    this.name = "NdjsonFrameSizeError";
    this.actual_bytes = actualBytes;
    this.maximum_bytes = maximumBytes;
  }
}

/**
 * Forward only complete NDJSON frames, retaining at most one bounded partial
 * frame. Newlines are framing bytes and do not count toward the JSON payload.
 */
export class BoundedNdjsonTransform extends Transform {
  readonly #maximumFrameBytes: number;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;

  constructor(maximumFrameBytes = MAX_ACP_CONTROL_FRAME_BYTES) {
    if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
      throw new Error("NDJSON frame limit must be a positive safe integer");
    }
    super();
    this.#maximumFrameBytes = maximumFrameBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) break;
      const payloadBytes = this.#fragmentBytes + newline - start;
      if (payloadBytes > this.#maximumFrameBytes) {
        this.#clear();
        callback(new NdjsonFrameSizeError(payloadBytes, this.#maximumFrameBytes));
        return;
      }
      const tail = bytes.subarray(start, newline + 1);
      this.push(this.#fragments.length
        ? Buffer.concat([...this.#fragments, tail], this.#fragmentBytes + tail.byteLength)
        : tail);
      this.#clear();
      start = newline + 1;
    }

    const remainder = bytes.subarray(start);
    const unterminatedBytes = this.#fragmentBytes + remainder.byteLength;
    if (unterminatedBytes > this.#maximumFrameBytes) {
      this.#clear();
      callback(new NdjsonFrameSizeError(unterminatedBytes, this.#maximumFrameBytes));
      return;
    }
    if (remainder.byteLength) {
      // Copy the retained tail so a tiny partial frame cannot pin a much larger
      // upstream stdout chunk after its complete frames have been forwarded.
      this.#fragments.push(Buffer.from(remainder));
      this.#fragmentBytes = unterminatedBytes;
    }
    callback();
  }

  override _flush(callback: TransformCallback) {
    if (this.#fragmentBytes) this.push(Buffer.concat(this.#fragments, this.#fragmentBytes));
    this.#clear();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.#clear();
    callback(error);
  }

  #clear() {
    this.#fragments = [];
    this.#fragmentBytes = 0;
  }
}

export function boundedNdjsonStream(maximumFrameBytes = MAX_ACP_CONTROL_FRAME_BYTES) {
  return new BoundedNdjsonTransform(maximumFrameBytes);
}
