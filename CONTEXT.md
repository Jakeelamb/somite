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
A source-anchored projection of indexed invocation calls and their known relationships. Workflow, subworkflow, and process scopes supply provenance and grouping suggestions without becoming automatic cards or containers; the outline is not independently executable truth.
_Avoid_: Process DAG, preview graph

**Semantic frame**:
One level of detail inside the persistent canvas. Zooming into a Workflow instance or Source group changes the active projection and rebases the camera without replacing the canvas, controls, or interaction model.
_Avoid_: Nested canvas, separate editor, modal workflow

**Source-structure relationship**:
A dashed, nonconnectable relationship retained from imported Source structure. It explains known source organization and is never a typed dataflow Edge.
_Avoid_: Wire, dependency Edge, channel contract

**Source group**:
An explicitly authored, presentation-only grouping made from selected Workflow-outline entities or relationships. Selecting a relationship groups its exact endpoints; Source scopes may suggest a group, but never create one automatically.
_Avoid_: Source scope, executable Compound, AST ownership

**Soft hull**:
The expanded presentation of a Source group: a lightweight overlay around its members that leaves their cards and relationships readable at normal size.
_Avoid_: Container Node, Source scope

**Macro**:
The collapsed presentation of a Source group. It contains a live miniature of its members and proxies their exact boundary relationships, but is neither executable nor connectable.
_Avoid_: Compound, tool Node, subworkflow call

**Semantic portal**:
A Workflow instance, soft hull, or Macro whose live child preview becomes the active Semantic frame when it fills the viewport. Entry and exit are reversible camera transforms over the same persistent canvas.
_Avoid_: Open button, breadcrumb navigation, second React Flow

**Source-group presentation**:
The undoable membership, nesting, disclosure, and placement state of Source groups. It is document presentation, not source, workflow, or execution identity.
_Avoid_: Source edit, Graph semantics

**Source scope**:
A source-anchored workflow, subworkflow, or process definition retained as provenance and grouping-suggestion metadata for invocation calls. It is not automatically a visible card or canvas container.
_Avoid_: Group, process card, canvas ownership

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

**Managed resource**:
Versioned scientific data required by a tool but distinct from executable software and sample inputs. It carries a specialized Resource profile, provenance, and scientific effect.
_Avoid_: Dependency, package, database path

**Operator candidate**:
A project-scoped proposed Operator contract supported by authoritative evidence but not yet present in the Catalog.
_Avoid_: Generated tool, custom node, installed package

**Operator proof**:
Evidence that one exact Operator candidate completed one representative fixture workflow. It proves that fixture, not general scientific correctness or user trust.
_Avoid_: Validation, acceptance, smoke test

**Operator acceptance**:
The human decision that admits a proven Operator candidate into one Project Catalog without changing the distributed Catalog.
_Avoid_: Promotion, installation, automatic approval
