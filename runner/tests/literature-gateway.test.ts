import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { jatsText, LiteratureGateway } from "../src/literatureGateway.ts";

function jats(body: string, journal = "bioRxiv") {
  return `<?xml version="1.0"?><article><front><journal-meta><journal-id>${journal}</journal-id></journal-meta></front><body><sec><title>Methods</title><p>${body}</p></sec></body></article>`;
}

test("bioRxiv search is constrained to preprints and retains full-text availability", async () => {
  const seen: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    return Response.json({ resultList: { result: [{
      id: "PPR123456",
      doi: "10.1101/2026.01.02.123456",
      title: "A <i>visual</i> workflow",
      authorString: "A. Scientist; B. Builder",
      firstPublicationDate: "2026-01-02",
      abstractText: "An abstract",
      inEPMC: "Y",
    }, { id: "PMC999", doi: "10.1/not-biorxiv" }] } });
  };
  const gateway = new LiteratureGateway("/tmp", fetcher);
  const response = await gateway.search("visual workflow");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.title, "A visual workflow");
  assert.equal(response.results[0]?.full_text_available, true);
  assert.match(seen[0]!.searchParams.get("query")!, /SRC:PPR/);
  assert.match(seen[0]!.searchParams.get("query")!, /PUBLISHER:"bioRxiv"/);
  await gateway.search("visual workflow");
  assert.equal(seen.length, 1, "identical searches share the bounded cache");
});

test("bioRxiv JATS is validated, cached, and converted into headed text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-literature-"));
  let requests = 0;
  const article = jats("RNA-seq reads were aligned with STAR and counted with featureCounts. ".repeat(8));
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return new Response(article, { headers: { "content-type": "application/xml" } });
  };
  try {
    const first = new LiteratureGateway(root, fetcher);
    const text = await first.fullText("PPR123456");
    assert.match(text, /Methods/);
    assert.match(text, /featureCounts/);
    const afterRestart = new LiteratureGateway(root, fetcher);
    assert.equal(await afterRestart.fullText("PPR123456"), text);
    assert.equal(requests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JATS validation rejects non-bioRxiv and tiny payloads", () => {
  assert.throws(() => jatsText(jats("short", "Other Journal")), /not a bioRxiv paper/);
  assert.throws(() => jatsText(jats("short")), /full text is not available/);
});
