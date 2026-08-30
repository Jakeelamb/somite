import { writeFile } from "node:fs/promises";

const [mode, pidPath, payloadBytesText] = process.argv.slice(2);
const payloadBytes = Number(payloadBytesText);
if ((mode !== "newline-free" && mode !== "oversized-frame")
  || !pidPath
  || !Number.isSafeInteger(payloadBytes)
  || payloadBytes < 1) {
  throw new Error("usage: hostile-acp-stdout <newline-free|oversized-frame> <pid-path> <payload-bytes>");
}

await writeFile(pidPath, `${process.pid}\n`);
if (mode === "newline-free") {
  process.stdout.write(Buffer.alloc(payloadBytes, 0x78));
} else {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(payloadBytes) })}\n`);
}
setInterval(() => undefined, 1_000);
