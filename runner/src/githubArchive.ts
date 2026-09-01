import { gunzip } from "node:zlib";

import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_FILES,
  safeSourcePath,
  type FrozenSourceFile,
} from "@somite/workflow/nextflowSource";

const MAX_UNPACKED_BYTES = 640 * 1024 * 1024;
const MAX_TAR_ENTRIES = MAX_SOURCE_FILES * 3 + 16;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function unzip(bytes: Uint8Array) {
  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    gunzip(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }, (error, result) => {
      if (error) rejectPromise(error);
      else resolvePromise(result);
    });
  });
}

function tarText(block: Uint8Array, start: number, length: number) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end)).trim();
}

function tarOctal(block: Uint8Array, start: number, length: number, label: string) {
  const value = tarText(block, start, length).replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(value)) throw new Error(`tar ${label} is not octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`tar ${label} is outside the safe integer domain`);
  return parsed;
}

function verifyTarHeader(block: Uint8Array) {
  const expected = tarOctal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : block[index]!;
  if (actual !== expected) throw new Error("tar header checksum is invalid");
}

function parsePax(bytes: Uint8Array) {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("PAX record has no length separator");
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error("PAX record length is invalid");
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) values.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return values;
}

export async function extractGithubTarGz(compressed: Uint8Array): Promise<FrozenSourceFile[]> {
  const archive = await unzip(compressed);
  const raw: Array<{ path: string; mode: number; bytes: Uint8Array }> = [];
  let offset = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let entries = 0;
  let sourceBytes = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_TAR_ENTRIES) throw new Error(`source archive exceeds ${MAX_TAR_ENTRIES} tar entries`);
    verifyTarHeader(header);
    const size = tarOctal(header, 124, 12, "size");
    const mode = tarOctal(header, 100, 8, "mode");
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = tarText(header, 345, 155);
    const headerName = `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) throw new Error("tar entry exceeds the archive");
    if ((type === "x" || type === "L" || type === "g") && size > MAX_TAR_METADATA_BYTES) {
      throw new Error(`source archive tar metadata exceeds ${MAX_TAR_METADATA_BYTES} bytes`);
    }
    if (type === "0" || type === "\0") {
      if (raw.length >= MAX_SOURCE_FILES) throw new Error(`source archive exceeds ${MAX_SOURCE_FILES} regular files`);
      if (size > MAX_SOURCE_FILE_BYTES) throw new Error(`source archive file ${headerName} exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
      sourceBytes += size;
      if (sourceBytes > MAX_SOURCE_BYTES) throw new Error(`source archive exceeds ${MAX_SOURCE_BYTES} source bytes`);
    }
    const body = archive.slice(bodyStart, bodyEnd);
    if (type === "x") pax = parsePax(body);
    else if (type === "L") longName = tarText(body, 0, body.length);
    else if (type === "0" || type === "\0") {
      const path = pax.get("path") ?? longName ?? headerName;
      raw.push({ path, mode, bytes: body });
      pax = new Map();
      longName = undefined;
    } else if (type === "1" || type === "2") {
      throw new Error(`source archive contains unsupported linked entry ${headerName}`);
    } else if (type !== "5" && type !== "g") {
      throw new Error(`source archive contains unsupported tar entry type ${JSON.stringify(type)}`);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!raw.length) throw new Error("source archive contains no regular files");
  const roots = new Set(raw.map((file) => file.path.split("/")[0]));
  if (roots.size !== 1) throw new Error("source archive does not have one repository root");
  return raw.map((file): FrozenSourceFile => {
    const path = file.path.split("/").slice(1).join("/");
    if (!safeSourcePath(path)) throw new Error(`source archive contains unsafe path ${file.path}`);
    return { path, mode: file.mode & 0o111 ? 0o100755 : 0o100644, bytes: file.bytes };
  });
}
