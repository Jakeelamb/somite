import assert from "node:assert/strict";
import test from "node:test";

import { LocalInputPlanError, planLocalInputs } from "../app/localInputPlanning.ts";

test("local input planning pairs only the same sample and assigns read roles from names", () => {
  assert.deepEqual(planLocalInputs([
    { name: "sample_2.fastq.gz" },
    { name: "sample_R1.fastq.gz" },
  ]), [{ kind: "paired_fastq", r1: 1, r2: 0, first: 0 }]);

  assert.deepEqual(planLocalInputs([
    { name: "sampleA_R1.fastq" },
    { name: "sampleB_R2.fastq" },
  ]), [
    { kind: "fastq", file: 0, first: 0 },
    { kind: "fastq", file: 1, first: 1 },
  ]);
});

test("local input planning retains every independent FASTQ and FASTA selection", () => {
  assert.deepEqual(planLocalInputs([
    { name: "tumor_R1_001.fastq.gz" },
    { name: "tumor_R2_001.fastq.gz" },
    { name: "control.fastq" },
    { name: "reference.fna" },
  ]), [
    { kind: "paired_fastq", r1: 0, r2: 1, first: 0 },
    { kind: "fastq", file: 2, first: 2 },
    { kind: "fasta", file: 3, first: 3 },
  ]);
});

test("ambiguous same-role files are independent and unsupported selections fail before upload", () => {
  assert.deepEqual(planLocalInputs([
    { name: "sample_R1.fastq" },
    { name: "sample_1.fastq" },
    { name: "sample_R2.fastq" },
  ]), [
    { kind: "fastq", file: 0, first: 0 },
    { kind: "fastq", file: 1, first: 1 },
    { kind: "fastq", file: 2, first: 2 },
  ]);
  assert.throws(
    () => planLocalInputs([{ name: "reads.fastq" }, { name: "table.csv" }]),
    (error: unknown) => error instanceof LocalInputPlanError && /table\.csv.*No files were imported/.test(error.message),
  );
});
