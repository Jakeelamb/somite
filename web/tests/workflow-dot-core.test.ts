import assert from "node:assert/strict";
import test from "node:test";

import { graphFromDot } from "@somite/workflow/workflowDot";

test("Snakemake rule graphs preserve rules, dependencies, and fan-in ports", () => {
  const graph = graphFromDot("snakemake", "owner/workflow", "v1", "operator-rev", `digraph snakemake_dag {
    0[label = "prepare_a"];
    1[label = "prepare_b"];
    2[label = "all"];
    0 -> 2
    1 -> 2
  }`);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["prepare-a", "prepare-b", "all"]);
  assert.deepEqual(graph.edges.map((edge) => edge.to_port), ["in", "in_2"]);
  assert.deepEqual(graph.nodes.find((node) => node.id === "all")?.ports.filter((port) => port.dir === "in").map((port) => port.name), ["in", "in_2"]);
});

test("Nextflow DOT collapses channel intermediates and gives read boundaries typed inputs", () => {
  const graph = graphFromDot("nextflow", "nf-core/demo", "1.2.3", "operator-rev", `digraph workflow {
    v0 [shape=point,label=""];
    v1 [label="PIPE:CAT_FASTQ"];
    v2 [shape=circle,label="",xlabel="map"];
    v3 [label="PIPE:FASTQC"];
    v0 -> v1;
    v1 -> v2;
    v2 -> v3;
  }`);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["cat-fastq", "fastqc"]);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.nodes[0]?.ports.slice(0, 2).map((port) => port.name), ["r1", "r2"]);
});
