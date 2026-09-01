# Somite operator contract

An Operator is the reviewed Interface between a visible Somite Node and one
tool Implementation. The graph owns workflow structure. Operator metadata owns
the command, parameters, typed ports, output collection rules, and Pixi package
requirements for one node.

Every Graph Node stores the Operator's stable ID and an immutable revision
digest. The digest covers execution-semantic fields and excludes human title
and palette placement. Loading, saving, compiling, and executing a schema-v3
Graph reject a revision that does not match the supplied Operator manifest.
Schema-v1 and schema-v2 Graphs are upgraded through the exact catalog before
further use.

Package metadata is not an Operator. A Conda package can reveal that a binary
exists; it does not define safe arguments, input cardinality, artifact types,
or outputs.

## Artifact ports

Ports use the closed `PortType` union in the shared TypeScript workflow model.
Equal types connect. An
input may declare an explicit union such as `Fastq | FastqGz`. A scalar input
accepts at most one edge. Paired reads remain separate `r1` and `r2` ports.

`Directory` is not a wildcard. Use it only when the directory itself is the
tool's real artifact contract. Do not use it to avoid defining files.

A managed-resource input refines that physical type with `resource.profile`.
An output may provide the matching provenance with `resource_profile`. Catalog
verification requires an exact profile match before it accepts the edge, so an
ordinary `Directory` cannot satisfy a Kraken2 database input. A profiled output
remains usable by a generic `Directory` input because it still has that physical
artifact type.

Collections, scatter/gather, tuple metadata, and streaming channels are not in
the current Graph schema. An Operator that requires them is an adapter gap, not
a reason to hide semantics in a shell command.

Artifact preparation states that change downstream correctness remain typed.
For example, `Bam`, `ReadGroupedBam`, and `GatkReadyBam` are not interchangeable,
and `Fai`, `Dict`, and `Bai` sidecars are explicit ports. An
`implicit_sidecar` is still a visible incoming Edge; it only tells the
executable that the staged basename, rather than an argv flag, is how the tool
discovers that file.

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

A trusted Somite boundary that does not spawn a tool. File sources and manual
checkpoints lower to input channels. An output port may declare
`import_param` to name the parameter containing the local file it represents;
this supports multi-file checkpoints without adding paper-specific compiler
branches. Other in-process operators fail compilation until explicitly lowered.
An existing managed-resource directory uses this same local-path contract and a
reviewed output `resource_profile`; this records compatibility but neither
downloads the resource nor claims its biological contents were validated.

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

An input port may declare a safe basename-only `stage_as` when a legacy CLI
derives output names from an input filename. This is reviewed execution
metadata and is covered by the Operator revision.

Somite renders a Bash array and executes `"${argv[@]}"`. Operator tokens are
never concatenated into `bash -c`, `eval`, pipes, redirects, or command
substitutions. A `stdout` field may name one exact output port for tools such
as BWA that intentionally emit their artifact to stdout; Somite owns that
single controlled redirection, and the output still passes normal validation.

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

## Deterministic resolution profiles

`resolution` describes an honest non-package action for a structural or manual
operator. The supported kinds are `manual_checkpoint`, `method_details`,
`legacy_source`, and `adapter`. A profile owns the user-facing title, detail,
action label, optional official source URL, and any parameters whose presence
clears the requirement.

Readiness, paper review, and export consume the same profile. A package match
cannot clear one of these states. Manual checkpoints can become ready when the
declared artifacts are attached; method ambiguity and legacy-source nodes stay
blocked until the graph is replaced with a reviewed executable contract.

A profile may publish `recipes`. Each recipe has a stable id, version, kind,
summary, ordered steps, covered parameters, and optional source URL. Supported
kinds are `external_checkpoint`, `environment`, `method_selection`,
`artifact_preparation`, and `adapter_contract`. Recipes are included in the
Workflow assessment and frozen `assessment.json`; they are not appended to
`argv`, invoked by the runtime, or allowed to clear a Requirement by themselves.

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

## nf-core source-backed workflows and modules

Exact nf-core source reuse is a Source-backed workflow, not a generic external
Operator. A whole-root import must:

1. resolve a release to an immutable upstream commit;
2. read raw blobs from that exact commit tree and retain them by content digest,
   without consulting mutable worktree bytes, status, or checkout filters;
3. preserve source rather than translating DOT or launching by repository name;
4. expose workflow-schema parameters as typed bindings;
5. index nested scopes and invocations with exact source locations; and
6. freeze source-defined task environments before claiming Readiness.

Module-level structured editing additionally requires the complete callable
channel Interface, including metadata values and transforms, plus a source map
from runtime aliases to visible scopes. Until those contracts exist, regions
remain exact Source-only regions and expose no fabricated ports.

An invocation may cross from Source-only intent into native execution only by
explicit promotion to one catalog-pinned Operator. Promotion creates an ordinary
Node with that Operator's exact Ports and parameters; it does not infer adjacent
channels or keep the original source workflow running beneath it. The native
Graph retains the complete original Source Node and invocation-to-Node mapping
as non-executable provenance. From that point, normal graph validation,
Readiness, Nextflow compilation, and Pixi freezing apply without a separate
source execution path.

JSON Schema `pattern` bindings fail closed across regex engines. Somite accepts
only printable-ASCII patterns and values from the deliberately constrained
ECMA-262 subset shared by browser and runner: ordinary and non-capturing groups,
alternation, anchors, `.`,
ASCII classes and ranges, common class/boundary escapes, and `*`, `+`, or `?`
quantifiers. Lookarounds, inline modes, backreferences, Unicode or hex escapes,
counted quantifiers, POSIX classes, and class set operations remain Source-only.
An unsupported required patterned parameter is retained as a Readiness blocker,
while an unsupported optional patterned parameter remains diagnostic. Neither
disables edits to independently proven properties.

The source editor recognizes only primitive `type`, `enum`, inclusive `minimum`
and `maximum`, the pattern subset above, and the `file-path`, `directory-path`,
or `path` formats as editable constraints. A non-null `default` must satisfy
that complete contract before it is retained. Display annotations such as
`title`, `description`, `help_text`, `help`, `fa_icon`, `examples`, `hidden`,
`mimetype`, `errorMessage`, `readOnly`, `writeOnly`, and `$comment` do not
constrain values. The property contract is an allowlist: unknown/custom
keywords and nf-schema validators such as `exists`, referenced sample-sheet
`schema`, and `deprecated` remain Source-only until their validation behavior
is implemented with parity.
Integer values, defaults, enum choices, and bindings are limited to JavaScript's
exact integer domain, `[-(2^53-1), 2^53-1]`; the browser rejects rather than
rounds entries outside it. Persisted numeric `minimum` and `maximum` constraints
use the deliberately narrower `[-(2^53-2), 2^53-2]` domain because the IR stores
bounds as binary64 values and the outer safe-integer boundary does not survive
this project's decimal `f64` JSON round trip unchanged. Integer bounds must also
be integral. A property with a bound, default, or enum outside its applicable
domain remains Source-only.
For fractional numeric bounds, defaults, and enum choices, Somite compares the
original JSON decimal with the canonical decimal of its persisted binary64
value. If those numbers differ (for example `0.10000000000000001` becoming
`0.1`), that property remains Source-only. Path formats are editable only on
string properties; applying them to numbers, integers, or booleans is likewise
Source-only.
Other JSON Schema assertions—including `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `const`, length/item/property bounds,
conditionals, composition, references, object/array subschemas, and
unevaluated/additional-property rules—remain Source-only rather than being
silently ignored. On a required property they are retained as an explicit
non-actionable Readiness blocker. Optional unsupported properties remain visible
through source diagnostics. In both cases, only the affected property is omitted
from the editable contract, so the public edit API accepts proven emitted fields
and rejects omitted fields without locking unrelated controls.

At the container level, Somite supports an object root with either direct
`properties` or `$defs`/`definitions` groups, direct `required`, and root
`allOf` clauses containing exactly one known local group `$ref` or exactly one
`required` array. Groups support object `properties` plus `required` and display
annotations; unreferenced definitions are inert and never become phantom
parameters. Malformed `required` refuses that contract while retaining any
valid string names it contains. Other root/group assertions, mixed `allOf`
clauses, unknown or remote references, and conditional/dependent contracts
disable editing globally and remain explicit schema-review work because their
meaning can couple otherwise independent properties. A valid complete empty
object schema remains editable and produces no false schema-review blocker.
Duplicate JSON object members anywhere in the schema also disable editing
globally: last-member-wins behavior is parser-dependent and therefore cannot be
part of a proven source-editor contract.

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

Commands that emit stdout or derive filenames from staged inputs also require
a compiler fixture for their `stdout` or `stage_as` behavior.

Agents may propose contracts from `--help`, Bioconda recipes, nf-core
`meta.yml`, or existing workflow tests. Those are evidence sources. Promotion
still requires the contract and fixture to pass independently.
