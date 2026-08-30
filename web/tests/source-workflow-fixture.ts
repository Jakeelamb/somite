import { readFile } from "node:fs/promises";

import type { FrozenSourceFile } from "@somite/workflow/nextflowSource";
import { deriveSourceWorkflow } from "@somite/workflow/sourceWorkflow";

const root = new URL("../../testdata/source-workflow/", import.meta.url);
const paths = [
  "main.nf",
  "modules/odgi_stats.nf",
  "modules/wfmash.nf",
  "nextflow_schema.json",
  "subworkflows/odgi_qc.nf",
  "workflows/pangenome.nf",
] as const;

export async function trackedSourceWorkflowFixture() {
  const files = await Promise.all(paths.map(async (path): Promise<FrozenSourceFile> => ({
    path,
    mode: 0o100644,
    bytes: await readFile(new URL(path, root)),
  })));
  const derived = deriveSourceWorkflow(files, {
    provider: "nf_core",
    repository: "https://github.com/nf-core/pangenome",
    requested_revision: "fixture",
    resolved_revision: "0123456789abcdef0123456789abcdef01234567",
    entrypoint: "main.nf",
  });
  return { files, ...derived };
}
