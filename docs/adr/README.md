# Architecture Decision Records

This directory is the single index for all architecture decisions (ADR-001-038).
ADR-001-016 were extracted verbatim from the legacy top-level index; the original
discussion history, rejected designs and pitfalls remain in
[legacy-decisions-and-lessons.md](legacy-decisions-and-lessons.md). ADRs explain why a
boundary exists. The current architecture remains authoritative in
[ARCHITECTURE.md](../ARCHITECTURE.md), while Phase 1 operating contracts are indexed
in [migration/README.md](../migration/README.md).

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-001](001-product-boundary-dataset-construction.md) | Product boundary is dataset construction, not a full research agent | Accepted |
| [ADR-002](002-single-family-single-granularity.md) | One DatasetBuild has one primary family and one row granularity | Accepted |
| [ADR-003](003-trusted-execution-core.md) | Keep the trusted execution core, not a fixed five-stage state machine | Accepted |
| [ADR-004](004-no-dag-no-build-recipe.md) | No full DAG and no new BuildRecipe | Accepted |
| [ADR-005](005-manifest-identifies-primary-data.md) | Primary data identified by Manifest, not fixed filenames | Accepted |
| [ADR-006](006-artifact-role-classification.md) | Manifest classified by Artifact Role; no mixed-granularity primary data | Accepted |
| [ADR-007](007-agent-plans-not-data-values.md) | Agent decides the plan, not scientific data values | Accepted |
| [ADR-008](008-availability-vs-mergeability.md) | Source availability and data mergeability are two dimensions | Accepted |
| [ADR-009](009-string-similarity-proposes-not-approves.md) | String similarity only proposes mappings, cannot approve them | Accepted |
| [ADR-010](010-run-build-validation-publication-orthogonal.md) | RunStatus / BuildResult / ValidationResult / Publication are orthogonal | Accepted |
| [ADR-011](011-no-metadata-only-placeholder.md) | No metadata-only placeholder primary table | Accepted |
| [ADR-012](012-profile-driven-validation.md) | Validation driven by Profile; architecture keeps three publication invariants | Accepted |
| [ADR-013](013-explainable-confidence-levels.md) | Confidence uses explainable levels, not fake probabilities | Accepted |
| [ADR-014](014-provenance-sidecar.md) | Provenance via record/batch sidecars; primary table keeps references only | Accepted |
| [ADR-015](015-cache-schema-build-parameters.md) | Cache identified by Schema and build parameters | Accepted |
| [ADR-016](016-strangler-migration.md) | Migration uses strangler pattern, not one-shot rewrite | Accepted |
| [ADR-017](017-pi-agent-runtime.md) | Pi replaces the custom Agent layer, not deterministic dataset semantics | Accepted |
| [ADR-018](018-single-ts-application-host.md) | One TypeScript Application Host and one browser-facing port | Accepted |
| [ADR-019](019-session-task-run-build-boundary.md) | Pi Session, BioMed Task, Run, and DatasetBuild remain distinct | Accepted |
| [ADR-020](020-dataset-core-remains-deterministic.md) | Python V2 Dataset Core remains authoritative in Phase 0/1 | Accepted |
| [ADR-021](021-pi-adapter-boundary.md) | Pi dependencies are isolated behind one adapter | Accepted |
| [ADR-022](022-phase1-legacy-core-bridge.md) | Phase 1 uses a named-operation Legacy Dataset Core bridge | Accepted |
| [ADR-023](023-workspace-policy.md) | Agent writes remain staging-only and publications remain immutable | Accepted |
| [ADR-024](024-contract-source-of-truth.md) | `@biomed/contracts` is canonical for TypeScript wire DTOs | Accepted |
| [ADR-025](025-layered-validation-http-persistence.md) | One runtime validation layer and one HTTP/persistence layer per process | Accepted |
| [ADR-026](026-durable-hil-confidence-protocol.md) | Durable evidence-bound HIL remains distinct from confidence and validation | Accepted |
| [ADR-026](026-agent-workspace-permissions.md) | Agent Workspace is `data/workspaces/<taskId>`; everything outside goes through allow/ask/deny; Publication trust is hash-verified | Accepted |
| [ADR-027](027-dataset-family-registry.md) | Dataset families are registered runtime capabilities | Accepted |
| [ADR-028](028-multitable-contracts.md) | Versioned multi-table publication contracts and evidence locators | Accepted |
| [ADR-029](029-source-asset-registration.md) | Core-owned SourceAsset registration receipts and task ownership | Accepted |
| [ADR-030](030-operation-result-manifest.md) | Versioned operation result manifests and checkpoint migration | Accepted |
| [ADR-031](031-core-owned-acquisition.md) | Core-owned acquisition identity, recipe promotion and retry lineage | Accepted |
| [ADR-032](032-generic-multitable-validation.md) | Generic multi-table validation is structural and fail-closed | Accepted |
| [ADR-033](033-publication-candidate-family-assembly.md) | Core-only PublicationCandidate and registered family assembler handlers | Accepted |
| [ADR-034](034-registered-table-adapter.md) | Registered-table adapters trust only Core asset receipts and registered parsers | Accepted |
| [ADR-035](035-biomedical-common-schemas.md) | Parameterized biomedical common schemas remain non-production capabilities | Accepted |
| [ADR-036](036-deterministic-derive-slot.md) | Fixed deterministic derive slot and registered algorithm provenance | Accepted |
| [ADR-037](037-durable-build-api-state-machine.md) | Durable Build API, idempotency, and independent state machine | Accepted |
| [ADR-038](038-canonical-evidence-product-layer.md) | Canonical Evidence Product Layer separates execution from biomedical product completeness | Proposed |

> 注：`026-durable-hil-confidence-protocol.md` 与 `026-agent-workspace-permissions.md` 编号
> 均为 026（两个独立工作流各自分配）；两者互不替代，均处于 Accepted 状态。

New records use the next available three-digit number and the sections `Status`,
`Context`, `Decision`, and `Consequences`. A superseding ADR must link both ways;
accepted records are not silently rewritten into a different decision.
