# Somite

Somite helps people compose, understand, modify, and run reproducible biological workflows without hiding the scientific or executable truth.

## Language

**Native workflow**:
A workflow whose visible graph is authored in Somite and whose nodes have complete Somite contracts.
_Avoid_: Generated workflow, ordinary workflow

**Source-backed workflow**:
A workflow whose executable truth is an immutable upstream source tree and whose Somite views remain anchored to that source.
_Avoid_: Imported DAG, external node, opaque runner

**Workflow definition**:
The immutable source, published interface, parameter schema, and provenance from which source-backed workflow instances are created.
_Avoid_: Template, catalog node

**Workflow instance**:
One placed use of a Workflow definition with its input bindings, parameter values, execution profile, and user changes.
_Avoid_: Pipeline node, launcher

**Workflow outline**:
A hierarchical, source-anchored projection of workflows, subworkflows, processes, and invocations. Somite presents one level of the outline at a time on a Nested source canvas; it is not independently executable truth.
_Avoid_: Process DAG, preview graph

**Nested source canvas**:
A separate canvas entered from a Source-backed workflow that displays the current Source scope and only its immediate child invocations. Entering a child replaces the visible level; Back, breadcrumbs, or Escape returns outward.
_Avoid_: Expanded node, inner graph, process DAG

**Source scope**:
A source-anchored workflow, subworkflow, or process displayed inside a Source-backed workflow. A Source scope may be replaced or rewired in a Workflow variant even when some connection semantics remain unresolved.
_Avoid_: Read-only process card, fake node

**Workflow variant**:
A Workflow definition plus an explicit, provenance-retaining set of changes. The unchanged upstream definition remains identifiable.
_Avoid_: Copy, modified pipeline

**Native workflow variant**:
A Native workflow created from one or more promoted Source invocations while retaining the exact Source-backed workflow as provenance. Its visible Nodes and Edges, rather than the retained source program, are executable truth.
_Avoid_: Patched import, mixed workflow

**Invocation promotion**:
The atomic change that turns one Source invocation and its selected Operator into a normal editable Node in a Native workflow variant. Promotion preserves an explicit mapping back to the original invocation but does not invent surrounding dataflow.
_Avoid_: Expansion, cosmetic replacement, source rewrite

**Semantic edit**:
A user change expressed as workflow intent, such as setting a parameter or replacing a compatible invocation, and anchored to the exact definition it changes.
_Avoid_: Canvas mutation, text hack

**Invocation replacement**:
A Semantic edit that substitutes a catalog tool for one source invocation while retaining the original invocation as provenance. Missing or uncertain connections remain explicit work in the Workflow variant.
_Avoid_: Cosmetic swap, compatible-only replacement

**Logic check**:
A continuous explanation of what is connected, environment-ready, plausible, unresolved, or validated. A Logic check guides editing but does not grant permission to edit.
_Avoid_: Edit gate, type approval

**Source-only region**:
Exact executable source that Somite preserves when it cannot completely project the region onto the canvas. Users may experiment around it, while Somite keeps every unknown and unvalidated consequence visible.
_Avoid_: Locked region, unsupported node
