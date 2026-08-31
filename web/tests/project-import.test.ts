import assert from "node:assert/strict";
import test from "node:test";

import { droppedProjectDirectory } from "../app/projectImport.ts";

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
  createReader?: () => { readEntries(success: (entries: Entry[]) => void, failure?: (error: DOMException) => void): void };
};

function file(name: string, contents: string): Entry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success) { success(new File([contents], name)); },
  };
}

function directory(name: string, chunks: Entry[][]): Entry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0;
      return { readEntries(success) { success(chunks[index++] ?? []); } };
    },
  };
}

function item(entry: Entry) {
  return { kind: "file", webkitGetAsEntry: () => entry };
}

test("dropped workflow directory retains its complete relative tree across reader batches", async () => {
  const root = directory("demo", [
    [file("main.nf", "workflow { PREPARE() }")],
    [directory("modules", [[file("prepare.nf", "process PREPARE {}")], []])],
    [],
  ]);

  const collected = await droppedProjectDirectory([item(root)]);

  assert.deepEqual(collected?.map((entry) => entry.path), ["demo/main.nf", "demo/modules/prepare.nf"]);
  assert.equal(await collected?.[1]?.file.text(), "process PREPARE {}");
});

test("ordinary file drops stay on the scientific-file import path", () => {
  assert.equal(droppedProjectDirectory([item(file("reads.fastq", "@read"))]), undefined);
});

test("a browser drop cannot merge multiple project roots", async () => {
  const first = directory("first", [[file("main.nf", "workflow {}")], []]);
  const second = directory("second", [[file("main.nf", "workflow {}")], []]);
  await assert.rejects(droppedProjectDirectory([item(first), item(second)])!, /one workflow directory/);
});
