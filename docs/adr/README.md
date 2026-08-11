# Architecture Decision Records

This directory continues the repository ADR sequence after ADR-016 in
[BioMed-QAgent_Architecture_Decisions_and_Lessons.md](../BioMed-QAgent_Architecture_Decisions_and_Lessons.md).
ADRs explain why a boundary exists. The current architecture remains authoritative
in [ARCHITECTURE.md](../ARCHITECTURE.md), while Phase 1 operating contracts are
indexed in [migration/README.md](../migration/README.md).

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-017](017-pi-agent-runtime.md) | Pi replaces the custom Agent layer, not deterministic dataset semantics | Accepted |
| [ADR-018](018-single-ts-application-host.md) | One TypeScript Application Host and one browser-facing port | Accepted |
| [ADR-019](019-session-task-run-build-boundary.md) | Pi Session, BioMed Task, Run, and DatasetBuild remain distinct | Accepted |
| [ADR-020](020-dataset-core-remains-deterministic.md) | Python V2 Dataset Core remains authoritative in Phase 0/1 | Accepted |
| [ADR-021](021-pi-adapter-boundary.md) | Pi dependencies are isolated behind one adapter | Accepted |
| [ADR-022](022-phase1-legacy-core-bridge.md) | Phase 1 uses a named-operation Legacy Dataset Core bridge | Accepted |
| [ADR-023](023-workspace-policy.md) | Agent writes remain staging-only and publications remain immutable | Accepted |
| [ADR-024](024-contract-source-of-truth.md) | `@biomed/contracts` is canonical for TypeScript wire DTOs | Accepted |

New records use the next available three-digit number and the sections `Status`,
`Context`, `Decision`, and `Consequences`. A superseding ADR must link both ways;
accepted records are not silently rewritten into a different decision.
