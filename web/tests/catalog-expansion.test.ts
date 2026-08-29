import assert from "node:assert/strict";
import test from "node:test";
import { catalogExpansionPresentation } from "../app/catalogExpansion.ts";

test("catalog expansion reports visible progress for the selected workflow", () => {
  assert.deepEqual(catalogExpansionPresentation({
    operatorId: "nf.pangenome",
    title: "nf-core/pangenome",
    phase: "resolving",
  }), {
    tone: "working",
    headline: "Resolving and pinning source…",
    summary: "Fetching the exact nf-core/pangenome release.",
    detail: null,
  });
});

test("an nf-core source resolution failure leaves the canvas unchanged and keeps the diagnostic", () => {
  const detail = "workflow import: nf-core/pangenome@1.1.3 could not be previewed: Nextflow did not produce a DAG";
  assert.deepEqual(catalogExpansionPresentation({
    operatorId: "nf.pangenome",
    title: "nf-core/pangenome",
    phase: "failed",
    detail,
  }), {
    tone: "error",
    headline: "Couldn’t add nf-core/pangenome",
    summary: "Somite could not resolve and pin this workflow’s source, so your canvas was left unchanged.",
    detail,
  });
});
