import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function byteDigest(bytes: Uint8Array) {
  return `blake3:${bytesToHex(blake3(bytes))}`;
}

export function jsonDigest(value: unknown) {
  return byteDigest(new TextEncoder().encode(JSON.stringify(value)));
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Property-order-independent JSON material for persisted transport state. */
export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

export function canonicalJsonDigest(value: unknown) {
  return jsonDigest(canonicalJsonValue(value));
}
