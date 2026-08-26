# Somite operator contract

An Operator is the reviewed Interface between a visible Somite Node and one
tool Implementation. The graph owns workflow structure. Operator metadata owns
the command, parameters, typed ports, output collection rules, and Pixi package
requirements for one node.

Every Graph Node stores the Operator's stable ID and an immutable revision
digest. The digest covers execution-semantic fields and excludes human title
and palette placement. Loading, saving, compiling, and executing a schema-v2
Graph reject a revision that does not match the supplied Operator manifest.
Schema-v1 Graphs are upgraded through the exact catalog before further use.

Package metadata is not an Operator. A Conda package can reveal that a binary
exists; it does not define safe arguments, input cardinality, artifact types,
or outputs.

## Artifact ports

Ports use the closed `PortType` enum in `somite-ir`. Equal types connect. An
input may declare an explicit union such as `Fastq | FastqGz`. A scalar input
accepts at most one edge. Paired reads remain separate `r1` and `r2` ports.

`Directory` is not a wildcard. Use it only when the directory itself is the
tool's real artifact contract. Do not use it to avoid defining files.

Collections, scatter/gather, tuple metadata, and streaming channels are not in
Graph schema v1. An Operator that requires them is an adapter gap, not a reason
to hide semantics in a shell command.

## JSON shape

```json
{
  "id": "qc.fastp",
  "title": "fastp",
  "palette": ["QC"],
  "kind": "external",
  "cost": "high",
  "bin": "fastp",
  "pixi": ["bioconda::fastp"],
  "params": {
    "threads": {
      "type": "int",
      "label": "Threads",
      "default": 4,
      "min": 1,
      "max": 64
    }
  },
  "ports": {
    "in": [
      { "name": "r1", "type": "Fastq", "union": ["Fastq", "FastqGz"] },
      { "name": "r2", "type": "Fastq", "union": ["Fastq", "FastqGz"], "optional": true }
    ],
    "out": [
      { "name": "r1", "type": "FastqGz" },
      { "name": "r2", "type": "FastqGz", "optional": true }
    ]
  },
  "argv": [
    "fastp", "-i", "{input.r1}", "-o", "{work}/out/clean_R1.fastq.gz",
    "?r2:-I", "?r2:{input.r2}", "?r2:-O", "?r2:{work}/out/clean_R2.fastq.gz",
    "-w", "{param.threads}"
  ],
  "outputs": {
    "r1": { "glob": "{work}/out/clean_R1.fastq.gz", "type": "FastqGz" },
    "r2": { "glob": "{work}/out/clean_R2.fastq.gz", "type": "FastqGz", "optional": true }
  }
}
```

Unknown JSON fields are rejected.

## Kinds

### `external`

One typed tool invocation. `bin` and the first command token identify the real
tool. The production compiler emits one static Nextflow process for the Node.

### `inprocess`

A trusted Somite boundary that does not spawn a tool. The first compiler slice
supports only `files.import` and `files.import_paired`; all other in-process
operators fail compilation until explicitly lowered.

### `reference`

Visible imported structure or paper evidence with no executable contract.
References are editable and connectable where their conservative ports allow,
but compilation fails until they are replaced by reviewed Operators.

## Parameters

Supported scalar parameter types are `bool`, `int`, `float`, and `string`.
Declare defaults, required values, and integer ranges in metadata. Compilation
validates type and range before generating a process.

Placeholders are data, never shell source:

- `{param.name}` passes a scalar through a Nextflow environment input;
- `{flag.name}` emits `--name` only when a Boolean is true;
- `{input.port}` uses the controlled staged basename;
- `?port:token` includes a token only when an optional input is bound;
- `?!port:token` includes it only when the input is unbound;
- `{work}/out` and `{work}/tmp` resolve inside the task directory.

Somite renders a Bash array and executes `"${argv[@]}"`. Operator tokens are
never concatenated into `bash -c`, `eval`, pipes, redirects, or command
substitutions.

## Outputs

Every output port needs one `outputs` entry with the same type. Globs must stay
under the controlled task directory. Absolute paths, parent traversal, and
unresolved placeholders are rejected.

Before a process succeeds, generated validation requires every non-optional
output, rejects zero-byte files, verifies gzip integrity for compressed genomic
types, and verifies that `Directory` outputs are directories. This is artifact
integrity, not a claim that a scientific result is biologically correct.

`OutputSpec.exclude` is not lowered yet and therefore fails compilation. It
must not be silently ignored.

## Pixi environment

`pixi` lists the package requirements needed by the tool. Channel-qualified
requirements are preferred. The compiler creates one graph-wide Pixi manifest,
pins the validated Nextflow and OpenJDK versions, and merges all tool packages.
`somite compile` resolves and retains `pixi.lock` before publishing the run
package. A package without the exact target lock is a draft, not a frozen Run
closure.

Containers and per-node environments are intentionally deferred. An Operator
must not invoke Conda, Pixi, Docker, Apptainer, Nextflow, Snakemake, or another
workflow/package engine itself.

## nf-core modules

Exact nf-core source reuse is a separate Adapter Implementation, not a generic
external Operator. A future source-backed Adapter must:

1. pin the upstream module source and revision;
2. preserve the module script rather than translating it;
3. map the complete channel Interface, including metadata values;
4. map every generated process alias back to one visible Somite Node;
5. pass the upstream nf-test fixture and a Somite composition fixture; and
6. emit provenance for the pinned source.

The initial compiler does not yet expose this Adapter kind. Imported nf-core
processes therefore remain references until promoted.

## Snakemake workflows

The Snakemake Workflow Catalog is an import and testing ecosystem. Imported
rules remain structural references. Snakemake fixtures may help audit generic
Operators, but production compilation rejects nested `snakemake` commands.

## Submission checklist

A catalog contribution includes:

1. `operators/<family>.<name>.json`;
2. closed typed ports and explicit optionality;
3. parameter types, defaults, and bounds;
4. tokenized argv with no shell wrapper;
5. output rules that remain under `{work}`;
6. Pixi package requirements; and
7. a tiny fixture proving command construction and output collection.

Agents may propose contracts from `--help`, Bioconda recipes, nf-core
`meta.yml`, or existing workflow tests. Those are evidence sources. Promotion
still requires the contract and fixture to pass independently.
