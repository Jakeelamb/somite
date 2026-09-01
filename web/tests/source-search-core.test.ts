import assert from "node:assert/strict";
import test from "node:test";

import {
  assemblyResult,
  ensemblFeatureResult,
  ensemblGenomeResult,
  runAccessions,
  searchEnsembl,
  searchNcbi,
  sraResults,
} from "@somite/workflow/sourceSearch";

test("SRA summaries become one actionable result per run", () => {
  const runs = '<Run acc="SRR10000001"/><Run acc="SRR10000002"/>';
  assert.deepEqual(runAccessions(runs), ["SRR10000001", "SRR10000002"]);
  const results = sraResults({
    runs,
    expxml: "<Title>Axolotl genome reads</Title><Organism ScientificName=\"Ambystoma mexicanum\"/><LIBRARY_STRATEGY>WGS</LIBRARY_STRATEGY><PAIRED/>",
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    key: "ncbi-sra-SRR10000001",
    title: "Axolotl genome reads",
    accession: "SRR10000001",
    description: "Ambystoma mexicanum · WGS",
    provider: "NCBI SRA",
    data_kind: "Reads",
    tags: ["WGS", "Paired"],
    request: {
      kind: "sra",
      value: "SRR10000001",
      provider: "NCBI SRA",
      result: "SRA download → separate R1 / R2 FASTQ streams",
      action: "Add Reads",
      operator_ids: ["sra.prefetch", "sra.fasterq_dump"],
      read_layout: "paired",
    },
  });

  const single = sraResults({
    runs: '<Run acc="SRR10000003"/>',
    expxml: "<Title>Single-end RNA reads</Title><Organism ScientificName=\"Homo sapiens\"/><LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY><SINGLE/>",
  });
  assert.deepEqual(single[0]?.tags, ["RNA-Seq", "Single"]);
  assert.deepEqual(single[0]?.request, {
    kind: "sra",
    value: "SRR10000003",
    provider: "NCBI SRA",
    result: "SRA download → one FASTQ stream",
    action: "Add Reads",
    operator_ids: ["sra.prefetch", "sra.fasterq_dump_single"],
    read_layout: "single",
  });
  assert.deepEqual(sraResults({
    runs: '<Run acc="SRR10000004"/>',
    expxml: "<Title>Incomplete record</Title><Organism ScientificName=\"Homo sapiens\"/><LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY>",
  }), [], "Somite must not invent a library layout when NCBI omits it");
});

test("NCBI and Ensembl records retain executable source identities", () => {
  assert.equal(assemblyResult({ assemblyname: "missing accession" }), undefined);
  assert.deepEqual(assemblyResult({
    assemblyaccession: "GCF_000001405.40",
    assemblyname: "GRCh38.p14",
    organism: "Homo sapiens",
    assemblystatus: "Chromosome",
  })?.request.operator_ids, ["ncbi.datasets_assembly", "ncbi.datasets_extract_assembly"]);
  assert.deepEqual(ensemblGenomeResult({
    assembly_accession: "GCA_009914755.4",
    display_name: "Human",
    assembly_name: "T2T-CHM13v2.0",
    genebuild: "2024-01",
  })?.tags, ["Genome", "2024-01"]);
  assert.deepEqual(ensemblFeatureResult({
    id: "ENST00000357654",
    object_type: "Transcript",
    display_name: "BRCA1-201",
  })?.request, {
    kind: "ensembl-transcript",
    value: "ENST00000357654",
    provider: "Ensembl REST",
    result: "Transcript FASTA sequence",
    action: "Add Sequence",
    operator_ids: ["ensembl.sequence"],
    sequence_type: "cdna",
  });
});

test("NCBI search performs ESearch then ESummary and preserves the user query", async () => {
  const urls: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("esearch.fcgi")) {
      return Response.json({ esearchresult: { idlist: ["123"] } });
    }
    return Response.json({ result: { "123": {
      runs: '<Run acc="SRR12345678"/>',
      expxml: "<Title>RNA reads</Title><Organism ScientificName=\"Homo sapiens\"/><LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY><SINGLE/>",
    } } });
  };
  const results = await searchNcbi("SRR12345678", fetcher);
  assert.equal(results[0]?.accession, "SRR12345678");
  assert.deepEqual(urls.map((url) => url.pathname.split("/").at(-1)), ["esearch.fcgi", "esummary.fcgi"]);
  assert.equal(urls[0]?.searchParams.get("db"), "sra");
  assert.equal(urls[0]?.searchParams.get("term"), "SRR12345678[Accession]");
});

test("exact NCBI assembly accessions use the assembly accession field without a reference-only filter", async () => {
  const urls: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("esearch.fcgi")) return Response.json({ esearchresult: { idlist: ["456"] } });
    return Response.json({ result: { "456": {
      assemblyaccession: "GCF_009914755.1",
      synonym: { genbank: "GCA_009914755.4", refseq: "GCF_009914755.1" },
      assemblyname: "T2T-CHM13v2.0",
      organism: "Homo sapiens",
      assemblystatus: "Chromosome",
    } } });
  };
  const results = await searchNcbi("GCA_009914755.4", fetcher);
  assert.equal(results[0]?.accession, "GCA_009914755.4");
  assert.equal(urls[0]?.searchParams.get("db"), "assembly");
  assert.equal(urls[0]?.searchParams.get("term"), "GCA_009914755.4[Assembly Accession]");
});

test("Ensembl lookup is tolerant only of authoritative provider misses", async () => {
  const result = await searchEnsembl("human BRCA1", async (input) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /lookup\/symbol\/human\/BRCA1$/);
    return Response.json({
      id: "ENSG00000012048",
      object_type: "Gene",
      display_name: "BRCA1",
      description: "BRCA1 DNA repair associated",
    });
  });
  assert.equal(result[0]?.accession, "ENSG00000012048");

  const missing = await searchEnsembl("human BRCA2", async () => new Response("missing", { status: 404 }));
  assert.deepEqual(missing, []);

  const missingGenome = await searchEnsembl("unknown species", async () => new Response("missing", { status: 404 }));
  assert.deepEqual(missingGenome, []);
  const emptyTaxonomy = await searchEnsembl("unknown species", async () => Response.json([]));
  assert.deepEqual(emptyTaxonomy, []);
});

test("exact Ensembl stable IDs use lookup by ID rather than symbol or taxonomy search", async () => {
  const urls: URL[] = [];
  const result = await searchEnsembl("ENST00000357654.9", async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return Response.json({
      id: "ENST00000357654",
      object_type: "Transcript",
      display_name: "BRCA1-201",
      description: "BRCA1 transcript",
    });
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0]!.pathname, /lookup\/id\/ENST00000357654$/);
  assert.equal(result[0]?.request.kind, "ensembl-transcript");
  assert.equal(result[0]?.request.sequence_type, "cdna");
});

test("Ensembl search propagates provider and transport failures", async (context) => {
  const failures: readonly [string, typeof fetch, RegExp][] = [
    ["server failure", async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }), /503 Service Unavailable/],
    ["malformed JSON", async () => new Response("{broken", { headers: { "content-type": "application/json" } }), /JSON|Unexpected|position/i],
    ["aborted request", async () => { throw new DOMException("search cancelled", "AbortError"); }, /search cancelled/],
    ["timed-out request", async () => { throw new DOMException("search timed out", "TimeoutError"); }, /search timed out/],
  ];

  for (const [name, fetcher, message] of failures) {
    await context.test(name, async () => {
      await assert.rejects(searchEnsembl("human BRCA1", fetcher), message);
    });
  }
});

test("public-data search cancels a remotely advertised oversized response", async () => {
  let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), {
    headers: {
      "content-type": "application/json",
      "content-length": String(8 * 1024 * 1024 + 1),
    },
  });
  await assert.rejects(searchEnsembl("human BRCA1", fetcher), /exceeds 8388608 bytes/);
  assert.equal(cancelled, true);
});

test("Ensembl search rejects successful responses with malformed schemas", async (context) => {
  await context.test("gene lookup", async () => {
    await assert.rejects(
      searchEnsembl("human BRCA1", async () => Response.json({ display_name: "BRCA1" })),
      /malformed Ensembl gene lookup response/i,
    );
  });
  await context.test("genome taxonomy lookup", async () => {
    await assert.rejects(
      searchEnsembl("Ambystoma mexicanum", async () => Response.json({ genomes: [] })),
      /malformed Ensembl genome lookup response/i,
    );
  });
});
