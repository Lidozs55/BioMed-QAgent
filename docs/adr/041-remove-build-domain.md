# ADR-041: Remove the Build domain

## Status

Accepted - 2026-08-27. Supersedes the Build-domain parts of ADR-010, ADR-019,
and ADR-037.

## Context

The Build API and independent Build state machine duplicated facts already owned
by Run events, deterministic operation receipts, product assessment, and immutable
publication. It also made ordinary non-dataset reporting appear incomplete unless a
Build terminal result existed. The intended restart behavior is checkpoint recovery,
not a second product lifecycle.

## Decision

The active product chain is:

```text
Run -> OperationResults -> ProductAssessment -> Publication
```

- Run owns scheduling, cancellation, and terminal execution state.
- OperationResult manifests are scoped by task, run, and requirement. Verified
  receipts and dependency digests are the deterministic resume checkpoints.
- ProductAssessment owns semantic completeness and publishability.
- Publication is the immutable artifact authority. A Run may complete without one.
- `events.jsonl` is authoritative durable history; snapshots are rebuildable
  projections and are never independent resume truth.
- The old Build HTTP routes, DTOs, IDs, events, stores, directories, aliases, and
  historical compatibility readers are removed without a migration layer.

## Consequences

- Dataset-producing work is formally complete only when its current requirement has
  a publishable ProductAssessment and verified Publication; other reporting work can
  complete with RunSummary alone.
- Restart verifies event identity plus committed checkpoints/publication receipts.
  It does not reconstruct an independent Build record.
- Clients use Publication list/detail/artifact APIs and typed Run/result events.
- Historical ADR text remains as decision history but is not current behavior.

