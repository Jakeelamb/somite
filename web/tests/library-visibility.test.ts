import assert from "node:assert/strict";
import test from "node:test";

import { libraryOperatorIsAvailable, libraryOperatorIsVisible } from "../app/libraryVisibility.ts";
import type { Operator } from "../app/types.ts";

test("typed source and normalization primitives do not expand the user-facing Add list", () => {
  for (const id of ["archive.gunzip_fasta", "archive.gunzip_fastq", "files.import_gtf", "files.import_gff3", "files.import_bam"]) {
    assert.equal(libraryOperatorIsVisible({ id, kind: "external", palette: ["Inputs"] }), false, id);
  }
  assert.equal(libraryOperatorIsVisible({ id: "files.import_kraken2_database", kind: "inprocess", palette: ["Inputs"] }), true);
  assert.equal(libraryOperatorIsVisible({ id: "align.bwa_index", kind: "external", palette: ["Alignment"] }), true);
});

test("FASTQ decompression appears only as an exact typed continuation", () => {
  const gunzip: Operator = {
    id: "archive.gunzip_fastq",
    title: "Decompress FASTQ",
    palette: ["Files", "Archives"],
    kind: "external",
    cost: "low",
    params: {},
    ports: {
      in: [{ name: "compressed", type: "FastqGz" }],
      out: [{ name: "fastq", type: "Fastq" }],
    },
  };
  assert.equal(libraryOperatorIsAvailable(gunzip, null), false);
  assert.equal(libraryOperatorIsAvailable(gunzip, {
    nodeId: "compressed-reads",
    port: { name: "reads", dir: "out", ty: "FastqGz" },
    position: { x: 0, y: 0 },
  }), true);
  assert.equal(libraryOperatorIsAvailable(gunzip, {
    nodeId: "plain-reads",
    port: { name: "reads", dir: "out", ty: "Fastq" },
    position: { x: 0, y: 0 },
  }), false);
});
