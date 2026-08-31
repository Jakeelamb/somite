import { gzipSync } from "node:zlib";

export function tarEntry(path: string, contents: string, type = "0") {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

export function nfcoreSourceArchive() {
  const main = `include { FASTQC } from './modules/fastqc'\nworkflow { FASTQC() }\n`;
  const module = `process FASTQC {\n  script:\n  \"\"\"fastqc reads.fastq\"\"\"\n}\n`;
  const schema = JSON.stringify({
    type: "object",
    $defs: {
      input_options: {
        title: "Input options",
        type: "object",
        required: ["input"],
        properties: { input: { type: "string", format: "file-path", description: "Reads" } },
      },
    },
    allOf: [{ $ref: "#/$defs/input_options" }],
  });
  return gzipSync(Buffer.concat([
    tarEntry("demo-release/main.nf", main),
    tarEntry("demo-release/modules/fastqc.nf", module),
    tarEntry("demo-release/nextflow_schema.json", schema),
    Buffer.alloc(1024),
  ]));
}

export function nfcoreGroupableSourceArchive() {
  const main = `include { READ_QC } from './subworkflows/read_qc'\ninclude { REPORT } from './modules/report'\nworkflow {\n  READ_QC()\n  REPORT()\n}\n`;
  const subworkflow = `include { FASTQC } from '../modules/fastqc'\ninclude { TRIM } from '../modules/trim'\nworkflow READ_QC {\n  main:\n  FASTQC()\n  TRIM()\n}\n`;
  const fastqc = `process FASTQC {\n  script:\n  \"\"\"fastqc reads.fastq\"\"\"\n}\n`;
  const trim = `process TRIM {\n  script:\n  \"\"\"printf 'trimmed\\n' > trimmed.fastq\"\"\"\n}\n`;
  const report = `process REPORT {\n  script:\n  \"\"\"printf 'complete\\n' > report.txt\"\"\"\n}\n`;
  const schema = JSON.stringify({
    type: "object",
    properties: { input: { type: "string", format: "file-path", description: "Reads" } },
    required: ["input"],
  });
  return gzipSync(Buffer.concat([
    tarEntry("grouping-demo/main.nf", main),
    tarEntry("grouping-demo/subworkflows/read_qc.nf", subworkflow),
    tarEntry("grouping-demo/modules/fastqc.nf", fastqc),
    tarEntry("grouping-demo/modules/trim.nf", trim),
    tarEntry("grouping-demo/modules/report.nf", report),
    tarEntry("grouping-demo/nextflow_schema.json", schema),
    Buffer.alloc(1024),
  ]));
}

export const nfcoreCatalogFixture = JSON.stringify({ remote_workflows: [{
  name: "demo",
  description: "Deterministic demonstration pipeline",
  topics: ["testing"],
  releases: [{ tag_name: "1.0.0", tag_sha: "a".repeat(40) }],
}] });
