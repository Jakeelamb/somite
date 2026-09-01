import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CompiledArtifactIntegrityError,
  createCompiledArtifactManifest,
  verifyCompiledArtifactDirectory,
  type CompiledArtifactSourceFile,
} from "../src/compiledArtifact.ts";

const encoder = new TextEncoder();
const closureDigest = `blake3:${"a".repeat(64)}`;
const graphRevision = `blake3:${"b".repeat(64)}`;

function artifactFiles(): readonly CompiledArtifactSourceFile[] {
  return [{
    path: "main.nf",
    bytes: encoder.encode("workflow {}\n"),
    mode: 0o644,
  }, {
    path: "somite-run",
    bytes: encoder.encode("#!/bin/sh\nexit 0\n"),
    mode: 0o755,
  }, {
    path: ".somite/run/source-task-nextflow.config",
    bytes: encoder.encode("process.executor = 'local'\n"),
    mode: 0o644,
  }, {
    path: ".somite/run/run-closure.json",
    bytes: encoder.encode(`${JSON.stringify({
      schema_version: 1,
      kind: "source_workflow",
      closure_digest: closureDigest,
      graph_revision: graphRevision,
    })}\n`),
    mode: 0o644,
  }];
}

async function writeArtifact(root: string, files = artifactFiles()) {
  for (const file of files) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { mode: file.mode });
    await chmod(destination, file.mode);
  }
  return createCompiledArtifactManifest(closureDigest, graphRevision, files);
}

test("compiled artifact verification rejects stale policy bytes and preserves them", async () => {
  const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
  const root = join(parent, "artifact");
  await mkdir(root);
  try {
    const manifest = await writeArtifact(root);
    await verifyCompiledArtifactDirectory(root, manifest);

    const policy = join(root, ".somite", "run", "source-task-nextflow.config");
    await writeFile(policy, "process.executor = 'slurm'\n");
    await assert.rejects(
      verifyCompiledArtifactDirectory(root, manifest),
      (error: unknown) => error instanceof CompiledArtifactIntegrityError
        && /source-task-nextflow\.config/.test(error.message)
        && /(?:bytes|digest)/.test(error.message),
    );
    assert.equal(await readFile(policy, "utf8"), "process.executor = 'slurm'\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("compiled artifact verification rejects an unmanifested file", async () => {
  const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
  const root = join(parent, "artifact");
  await mkdir(root);
  try {
    const manifest = await writeArtifact(root);
    await writeFile(join(root, "stale-output.txt"), "stale\n");
    await assert.rejects(
      verifyCompiledArtifactDirectory(root, manifest),
      (error: unknown) => error instanceof CompiledArtifactIntegrityError
        && /unexpected file.*stale-output\.txt/.test(error.message),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("compiled artifact verification rejects symlinks, hardlinks, mode drift, and closure identity drift", async (context) => {
  await context.test("symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
    const root = join(parent, "artifact");
    await mkdir(root);
    try {
      const manifest = await writeArtifact(root);
      await rm(join(root, "main.nf"));
      await symlink("somite-run", join(root, "main.nf"));
      await assert.rejects(verifyCompiledArtifactDirectory(root, manifest), /symbolic link/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  await context.test("hardlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
    const root = join(parent, "artifact");
    await mkdir(root);
    try {
      const manifest = await writeArtifact(root);
      await link(join(root, "main.nf"), join(parent, "external-hardlink"));
      await assert.rejects(verifyCompiledArtifactDirectory(root, manifest), /hard link/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  await context.test("mode", async () => {
    const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
    const root = join(parent, "artifact");
    await mkdir(root);
    try {
      const manifest = await writeArtifact(root);
      await chmod(join(root, "somite-run"), 0o644);
      await assert.rejects(verifyCompiledArtifactDirectory(root, manifest), /mode/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  await context.test("directory inventory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
    const root = join(parent, "artifact");
    await mkdir(root);
    try {
      const manifest = await writeArtifact(root);
      await mkdir(join(root, "unmanifested-empty-directory"));
      await assert.rejects(verifyCompiledArtifactDirectory(root, manifest), /unexpected directory/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  await context.test("run closure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "somite-compiled-artifact-"));
    const root = join(parent, "artifact");
    await mkdir(root);
    try {
      const files = artifactFiles().map((file) => file.path === ".somite/run/run-closure.json"
        ? { ...file, bytes: encoder.encode(`${JSON.stringify({
          schema_version: 1,
          kind: "source_workflow",
          closure_digest: `blake3:${"c".repeat(64)}`,
          graph_revision: graphRevision,
        })}\n`) }
        : file);
      const manifest = await writeArtifact(root, files);
      await assert.rejects(verifyCompiledArtifactDirectory(root, manifest), /run closure identity/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
