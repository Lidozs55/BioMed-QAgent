# Dataset Core Deterministic Flow Diagram Design

## Compact Mirrored-Timeline Revision (final)

The user's final hand-tuned layout supersedes the intermediate narrow-corridor
revision below. The canvas compresses to 980x1320 with gridSize 5. The right
column is re-ordered as a mirrored timeline of the main axis: controlled inputs
beside stages 01-02, the non-publication grid beside the compatibility gate,
dynamic extension (a narrow 235-pixel panel, back on the right) beside stages
05-06, reliability beside stages 07-08, and the authority note closing the
column; the run-completion note sits under the main column and the footer moves
inside the container. Stage cards tighten to 400x70 with 30px routine gaps and
40-50px gaps at trust transitions.

Wiring keeps the convenience principle: Rejected and Review pending hold the
grid's left column facing the corridor, and the compatibility gate reaches
Rejected with one short corridor jog. Because the grid now sits beside gate 04,
the product gate's failure edge instead wraps around the outside of the right
band (a clear vertical lane in the right margin) and enters Review pending from
the bottom - no crossings and no shape pass-throughs. Grid cell widths are sized
to their text rather than forced equal. The layout style is codified in the
project skill `.agents/skills/drawio-diagram-style/`.

Export tooling note: this draw.io version writes a wrong CRC into the embedded
`mxGraphModel` zTXt chunk of `-e` PNG exports (in addition to the known
truncated-IEND bug). Strict decoders such as Pillow reject the file until the
zTXt CRC is recomputed; repair scripts must fix both.

## Narrow Corridor Revision

The narrow revision keeps the top-to-bottom spine but compresses the canvas from
1640 to 1240 pixels wide. The right information band shrinks to a 340-pixel
column holding controlled inputs, reliability, the authority note, the 2x2
non-publication grid, and the run-completion note. Dynamic Family execution
moves to a compact left side-entry panel beside stages 05-06: its candidate
results re-enter stage 06 through one short horizontal arrow, so the right
corridor carries only the two failure exits.

The point of the 2x2 grid is wiring convenience, not symmetry: the two wired
cells (Rejected, Review pending) occupy the left column facing the failure
corridor, and NO_DATA / Failed-Cancelled fill the right column. The
compatibility gate reaches Rejected with a single corridor vertical; the product
gate reaches Review pending with a short S-jog. No edge crosses another edge or
passes through any shape, and the structural validator reports zero crossings,
through-vertices, and overlaps.

Export tooling note: this draw.io version writes a wrong CRC into the embedded
`mxGraphModel` zTXt chunk of `-e` PNG exports (in addition to the known
truncated-IEND bug). Strict decoders such as Pillow reject the file until the
zTXt CRC is recomputed; repair scripts must fix both.

## Approved Vertical Revision

The approved revision replaces the original landscape trust spine with a
top-to-bottom architecture narrative. Data moves downward through one central
Core-owned path. Controlled inputs, reliability guarantees, authority notes,
dynamic extension, and explicit non-publication outcomes share one right-side
information band; the non-publication outcomes use a compact 2-by-2 grid.

The revision intentionally reduces implementation detail. The figure retains
only architecture contracts and authority boundaries: `DatasetExecutionSpec`,
`SourceAsset`, `OperationResult`, `ProductAssessment`, and immutable
`DatasetPublication`. Code paths, API routes, internal phase identifiers, exact
backend names, and file-level mechanisms are omitted.

The central flow uses eight compact stages with variable spacing:

1. contract admission and capability matching;
2. acquisition and immutable asset registration;
3. parsing and canonical normalization;
4. compatibility gate;
5. deterministic integration, derivation, and family assembly;
6. verifiable `OperationResult` commitment;
7. validation and Core-owned `ProductAssessment`;
8. atomic immutable publication.

Routine transformations use tighter gaps. Larger gaps surround the compatibility
gate, result commitment, and publication gate so the trust transitions read as
distinct architectural boundaries. Dynamic Family execution is compressed to a
side entry that produces candidate results; Core re-admits those results before
the common commitment and assessment path. It never becomes a second publication
path.

The visual language uses draw.io's default light palette, narrower cards, larger
type, and no legend. Reliability is a light vertical support panel rather than a
dark full-width base.

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

Use a top-to-bottom "deterministic trust spine". The registered-family path enters
at the top and traverses the complete Core-owned flow. Dynamic Family execution is
a secondary side entry: it may produce candidate results, but Core must re-admit
them before the common result-commitment and assessment path. It never receives a
parallel publication route.

## Main Processing Flow

The center of the figure is a narrow, numbered vertical pipeline:

1. Input admission: validate the self-contained execution contract, family,
   schema/profile references, asset ownership, receipts, and digests.
2. Acquire and register: controlled source capabilities materialize immutable,
   content-addressed `SourceAsset` inputs.
3. Parse and canonicalize: convert carriers into typed data and normalize
   identifiers, units, vocabularies, and field semantics.
4. Compatibility gate: reject incompatible family, row granularity, keys,
   measurements, or mappings before integration.
5. Deterministic construction: integrate sources, run the fixed derive slot when
   registered, and assemble family-owned table topology.
6. Result commitment: commit hash-bound `OperationResult` manifests and reusable
   checkpoints.
7. Product gate: assess structural and semantic validity, provenance closure,
   confidence/review policy, and Core-owned `ProductAssessment`.
8. Atomic publication: publish only eligible results as an immutable Publication
   containing a manifest, primary/supporting tables, schema, provenance, and audit
   evidence.

The final state is explicitly one of Published, NO_DATA, Rejected, Failed, or
Cancelled. Completion does not imply publication.

## Cross-Cutting Reliability Panel

A light, narrow side panel groups architecture-level guarantees into three
concepts: verifiable identity and provenance, recoverable controlled execution,
and fail-closed trust gates. It does not enumerate files, APIs, locks, or runtime
implementation details.

## Trust Boundary and Authority

The Core boundary is a prominent container. Labels inside the figure communicate
these invariants:

- Agent proposes specifications; Core owns data values and execution topology.
- Dynamic transforms produce candidate bytes, not trusted publications.
- Compatibility and validation failures cannot be bypassed.
- Empty primary data cannot publish.
- Publication is immutable, atomic, and manifest-addressed.

## Visual Design

- Canvas: tall single page, optimized for top-to-bottom reading.
- Style: default draw.io light palette with restrained semantic accents.
- Primary flow: compact blue rounded cards with large stage numbers.
- Data and trusted outputs: light green.
- Admission and product gates: light yellow/orange.
- Rejected/NO_DATA paths: restrained light red with short terminal labels.
- Reliability: light grey side panel; no dark base and no legend.
- Typography: Chinese-first labels with only essential contract names in English.
- Geometry: narrower cards, tight gaps for routine transformations, larger gaps at
  trust transitions, and visible uninterrupted arrow bodies.

## Deliverables and Verification

Deliver an editable `.drawio` source plus a PNG preview. Validate the XML for
dangling edges, duplicate IDs, broken parents, and overlaps. Inspect the rendered
preview for clipped labels, edge crossings, stacked connectors, and visual
hierarchy. The preview becomes the review artifact; the embedded editable PNG is
exported only after approval.
