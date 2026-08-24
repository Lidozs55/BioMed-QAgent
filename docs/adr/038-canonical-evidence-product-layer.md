# ADR-038: Canonical Evidence Product Layer

## Status

Proposed — 2026-08-20; partially implemented.

> [ADR-039](039-family-transform-host.md) is now Accepted and supersedes this
> proposal's supplementary/isolated transform target with the explicit
> `in_process_unisolated` fixed slot. The ProductAssessment and canonical
> evidence portions remain the proposed semantic foundation and are implemented
> incrementally; this status does not by itself authorize new production
> packages or relax Publisher gates.

## Context

The Dataset Core currently has a fixed, trusted execution skeleton and registered
family capabilities. A successful `BuildResult` proves that the admitted family
pipeline completed and that its publication invariants passed. It does not by
itself prove that a user's requested biomedical evidence product is complete.

Gold2-Gold5 exposed the same boundary at different domains: a valid publication
could contain only a probe table, a generic target table set, four structure
tables, or four ChEMBL activity tables while lacking the semantic entities,
relations, cross-references and provenance closure required by the requested
product. Adding a table or provider for each benchmark case would make the Core
benchmark-oriented instead of reusable.

The product requirements in `PROBLEM.md` are broader: heterogeneous source
finding, traceable retrieval, cleaning, alignment, integration, source labeling,
usable structured output, chart handling and error correction. These need a
shared semantic vocabulary without replacing the current TS Host + Pi + TS
Dataset Core topology.

## Decision

Introduce an additive Canonical Evidence Product Layer.

1. A registered semantic package declares biomedical entity types, relation
   predicates, evidence types, identity rules, measurement/row semantics and
   valid projections. A package is reusable product capability, not a Gold case
   schema.
2. The Core may represent committed results as typed canonical entities,
   relations, evidence, cross-references, provenance and confidence/review
   objects. Existing family batches and CSV projections remain compatible during
   migration.
3. Add `ProductRequirementManifest` and `ProductAssessment` as separate
   concepts. Execution status and product publishability are not the same state.
   A completed execution may be assessed as incomplete; only Core-owned
   assessment may authorize a new publishable flow.
4. Product evaluation is machine-readable and checks schema/entity closure,
   relations, identifiers/crosswalks, provenance, confidence/HIL state and
   artifact reproducibility. Gold requirement manifests are evaluator inputs,
   not production family implementations.
5. Agent-authored scripts remain candidate research transforms. A future
   `RegisteredTransform` may be promoted only after its canonical output
   capability, implementation digest, locked runtime, registered input receipts,
   resource limits, no-network/path policy and deterministic replay are fixed by
   Core. It outputs canonical objects, not final table topology.
6. The existing fixed pipeline remains the execution topology. Derivation stays
   in the fixed server-owned derive slot; the Agent cannot add nodes, choose
   publication policy, or bypass Publisher.

Initial package vocabulary:

- `expression_evidence`;
- `target_evidence`;
- `structure_interaction`;
- `bioactivity_identity`;
- later `figure_evidence`.

Implementation starts with a pure evaluator contract and generic fixtures,
followed by additive assessment fields. Canonical IR and package projections are
introduced incrementally with compatibility fixtures.

## Consequences

### Positive

- “Execution completed” and “requested product is publishable” become explicit
  and distinguishable.
- Missing relations, crosswalks, provenance or confidence are named blockers
  instead of silent partial success.
- The same entity/identity/relation model can serve expression, target,
  structure, bioactivity and figure evidence products.
- Supplementary transforms can be made useful without allowing arbitrary
  workspace CSVs to bypass the trusted publication boundary.
- Existing Dataset Core, SourceAsset, operation, checkpoint and Publisher
  boundaries remain in place.

### Costs and risks

- A new internal semantic layer must coexist with current family projections.
- Package and requirement registries need versioning and migration fixtures.
- Product assessment must avoid becoming an unbounded benchmark policy engine.
- Canonical identity and crosswalk rules require domain-specific review while
  remaining generic at the contract level.

## Rejected Alternatives

### One production profile per Gold case

Rejected because it encodes evaluation examples into the runtime and does not
provide a reusable biomedical product language.

### Agent-generated final CSVs

Rejected because workspace files lack Core-owned asset receipts, deterministic
operation results, trusted provenance and Publisher admission.

### Arbitrary script/DAG execution in the Core

Rejected because it would allow the Agent to define topology, transforms and
publication policy dynamically, weakening reproducibility and the trust boundary.
