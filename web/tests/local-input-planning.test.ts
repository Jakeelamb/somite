import assert from "node:assert/strict";
import test from "node:test";

import { LocalInputPlanError, localInputOperatorId, localInputOperatorIds, planLocalInputs } from "../app/localInputPlanning.ts";

test("local input planning pairs only the same sample and assigns read roles from names", () => {
  assert.deepEqual(planLocalInputs([
    { name: "sample_2.fastq.gz" },
    { name: "sample_R1.fastq.gz" },
  ]), [{ kind: "paired_fastq_gz", r1: 1, r2: 0, first: 0 }]);

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
    { kind: "paired_fastq_gz", r1: 0, r2: 1, first: 0 },
    { kind: "fastq", file: 2, first: 2 },
    { kind: "fasta", file: 3, first: 3 },
  ]);
});

test("compressed FASTQ planning preserves bytes and read roles without guessing mixed pairs", () => {
  const compressed = planLocalInputs([
    { name: "tumor_R1.fastq.gz" },
    { name: "tumor_R2.fastq.gz" },
    { name: "control.fq.gz" },
    { name: "plain.fastq" },
  ]);
  assert.deepEqual(compressed, [
    { kind: "paired_fastq_gz", r1: 0, r2: 1, first: 0 },
    { kind: "fastq_gz", file: 2, first: 2 },
    { kind: "fastq", file: 3, first: 3 },
  ]);
  assert.deepEqual(compressed.map(localInputOperatorId), [
    "files.import_paired_gz",
    "files.import_fastq_gz",
    "files.import",
  ]);
  assert.deepEqual(compressed.flatMap(localInputOperatorIds), [
    "files.import_paired_gz",
    "files.import_fastq_gz",
    "files.import",
  ]);

  assert.throws(
    () => planLocalInputs([
      { name: "mixed_R1.fastq" },
      { name: "mixed_R2.fastq.gz" },
    ]),
    (error: unknown) => error instanceof LocalInputPlanError
      && /mixed_R1\.fastq.*mixed_R2\.fastq\.gz.*same compression/i.test(error.message),
  );
});

test("compressed FASTA remains distinct from plain FASTA", () => {
  const plan = planLocalInputs([
    { name: "reference.fa.gz" },
    { name: "assembly.fna" },
  ]);
  assert.deepEqual(plan, [
    { kind: "fasta_gz", file: 0, first: 0 },
    { kind: "fasta", file: 1, first: 1 },
  ]);
  assert.deepEqual(plan.map(localInputOperatorId), [
    "files.import_fasta_gz",
    "files.import_fasta",
  ]);
  assert.deepEqual(plan.flatMap(localInputOperatorIds), [
    "files.import_fasta_gz",
    "archive.gunzip_fasta",
    "files.import_fasta",
  ]);
});

test("local input planning exposes typed annotation sources without guessing compressed or legacy GFF formats", () => {
  assert.deepEqual(planLocalInputs([
    { name: "genes.gtf" },
    { name: "features.GFF3" },
  ]), [
    { kind: "gtf", file: 0, first: 0 },
    { kind: "gff3", file: 1, first: 1 },
  ]);
  assert.deepEqual(
    planLocalInputs([{ name: "genes.gtf" }, { name: "features.gff3" }]).map(localInputOperatorId),
    ["files.import_gtf", "files.import_gff3"],
  );
  assert.throws(() => planLocalInputs([{ name: "genes.gtf.gz" }]), /GTF.*Unsupported: genes\.gtf\.gz/i);
  assert.throws(() => planLocalInputs([{ name: "features.gff" }]), /GFF3.*Unsupported: features\.gff/i);
});

test("local input planning accepts BAM through the same typed Local files seam", () => {
  const plan = planLocalInputs([
    { name: "sample.bam" },
    { name: "reads.fastq" },
  ]);
  assert.deepEqual(plan, [
    { kind: "bam", file: 0, first: 0 },
    { kind: "fastq", file: 1, first: 1 },
  ]);
  assert.deepEqual(plan.map(localInputOperatorId), [
    "files.import_bam",
    "files.import",
  ]);
  assert.deepEqual(plan.flatMap(localInputOperatorIds), [
    "files.import_bam",
    "files.import",
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
