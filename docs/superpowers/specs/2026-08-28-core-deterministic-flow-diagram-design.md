# Dataset Core Deterministic Flow Diagram Design

## Goal

Create a new one-page draw.io architecture diagram that presents BioMed-QAgent's
deterministic data-processing Core as the product's main technical advantage. The
diagram is for architecture explanation and competition presentation, so it must
be visually striking while remaining faithful to the current TypeScript Core.

## Scope

The figure focuses only on data entering, traversing, and leaving Dataset Core.
The Agent appears only as the author of a controlled execution proposal. The
frontend, model runtime, database bridge, and general application-host topology
are out of scope.

The source of truth is current architecture documentation and code under
`server/src/dataset/`. Historical migration diagrams and plans do not define the
flow.

## Chosen Visual Narrative

Use a left-to-right "deterministic trust spine" with two controlled entry lanes:

1. Registered Family lane: a `DatasetExecutionSpec`, registry-approved family,
   and registered `SourceAsset` receipts enter the fixed Core operation plan.
2. Dynamic Family lane: a digest-bound `FamilySpec` and explicit
   `in_process_unisolated` transform produce quarantined bytes. Core re-hashes and
   admits them as a native `OperationResult`; the transform never receives
   publication authority.

Both lanes converge before the common trust gates. This makes extensibility
visible without suggesting that dynamic code can bypass deterministic Core
authority.

## Main Processing Flow

The center of the figure is a wide, numbered pipeline:

1. Input admission: validate the self-contained execution contract, family,
   schema/profile references, asset ownership, receipts, and digests.
2. Acquire and register: Core-owned providers or promoted acquisition recipes
   materialize immutable, content-addressed `SourceAsset` inputs.
3. Parse and adapt: source-specific adapters convert carriers into typed batches.
4. Canonicalize: normalize identifiers, units, vocabularies, and field semantics.
5. Compatibility gate: reject incompatible family, row granularity, keys,
   measurements, or mappings before integration.
6. Deterministic construction: integrate sources, run the fixed derive slot when
   registered, and assemble family-owned table topology.
7. Result commitment: commit hash-bound `OperationResult` manifests and reusable
   checkpoints.
8. Trust gates: run structural/profile validation, B3 where applicable, provenance
   closure, confidence/review policy, and Core-owned `ProductAssessment`.
9. Atomic publication: publish only eligible results as an immutable Publication
   containing a manifest, primary/supporting tables, schema, provenance, and audit
   evidence.

The final state is explicitly one of Published, NO_DATA, Rejected, Failed, or
Cancelled. Completion does not imply publication.

## Cross-Cutting Reliability Rail

A dark lower rail spans the processing flow and names the reliability mechanisms
that apply throughout: content hashes and receipts, operation timeouts, build/run
lock and generation/cancel fences, durable event log, checkpoints, bounded
resources, deterministic replay identity, and evidence-bound HIL.

The rail is visually connected to the relevant stages without turning the figure
into a sequence diagram.

## Trust Boundary and Authority

The Core boundary is a prominent container. Labels inside the figure communicate
these invariants:

- Agent proposes specifications; Core owns data values and execution topology.
- Dynamic transforms produce candidate bytes, not trusted publications.
- Compatibility and validation failures cannot be bypassed.
- Empty primary data cannot publish.
- Publication is immutable, atomic, and manifest-addressed.

## Visual Design

- Canvas: 16:9 landscape, suitable for slides and documentation.
- Style: clean technical architecture, not a hand-drawn recreation of the input
  sketch.
- Primary flow: deep blue rounded cards with large stage numbers.
- Data and trusted outputs: teal/green.
- Admission and validation gates: amber/orange diamonds or shield-like cards.
- Rejected/NO_DATA paths: restrained red with short terminal labels.
- Reliability rail: charcoal with compact white labels.
- Dynamic lane: purple accent, converging into the same blue Core spine.
- Typography: Chinese-first labels with essential contract names in English.
- Edges: orthogonal, directional, and routed outside unrelated shapes; no crossing
  through nodes.

## Deliverables and Verification

Deliver an editable `.drawio` source plus a PNG preview. Validate the XML for
dangling edges, duplicate IDs, broken parents, and overlaps. Inspect the rendered
preview for clipped labels, edge crossings, stacked connectors, and visual
hierarchy. The preview becomes the review artifact; the embedded editable PNG is
exported only after approval.

