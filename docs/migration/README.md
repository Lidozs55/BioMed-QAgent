# Phase 0/1/3 Migration Boundary Index

These documents define the Phase 0/1 operating contracts now implemented by the
TypeScript Host, Pi experimental adapter, governed Workspace, and Python V2 Core
bridge, plus the Phase 3 durable TS Application Runtime boundary. They are
subordinate to [ARCHITECTURE.md](../ARCHITECTURE.md) and the
[ADR index](../adr/README.md); they do not duplicate the full execution sequence in
[BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md](../BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md)
and the overall phase plan in
[BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md).
Migration progress and remaining Phase 5-8 work are tracked in [TODO.md](../TODO.md).

| Boundary | Authoritative migration document |
| --- | --- |
| Frozen environment, legacy measurements, DatasetBuild golden fixtures | [Pi migration baseline — 2026-08-11](baseline-2026-08-11.md) |
| Current/Phase 1/later resource ownership and cleanup | [Runtime ownership matrix](runtime-ownership-matrix.md) |
| Current Main Agent tools and minimal Phase 1 prompt | [Agent tool and prompt matrix](agent-tool-prompt-matrix.md) |
| Named Python V2 Core operations, envelopes, errors, transport, cancellation | [Legacy Dataset Core bridge](legacy-dataset-core-bridge.md) |
| Task Workspace permissions, exec modes, Windows/Linux security cases | [Phase 1 Workspace policy](workspace-policy-phase1.md) |
| Phase 2 decisions: skill content migration, stable Skill↔Tool map, retired skill runtime, thin database store | [Phase 2 skills & tools migration](phase2-skills-tools-migration.md) |
| Pi-to-BioMed experimental event mapping and sequence meaning | [Pi event adapter](pi-event-adapter.md) |
| Single Host startup/shutdown, flags, valid combinations, rollback | [Single-Host lifecycle and flags](single-host-lifecycle-and-flags.md) |
| Phase 3 durable TS Task/Run/Event ownership and legacy fallback | [Phase 3 TypeScript Application Runtime](phase3-ts-application-runtime.md) |
| Node/pnpm, Python/uv, environment variables, local data, validation, rollback | [Phase 0/1 environment migration](ENVIRONMENT_MIGRATION.md) |
| Final whole-branch findings, fixes, quality gates, and startup evidence | [Phase 0/1 final verification](PHASE0_1_FINAL_VERIFICATION.md) |

## Implemented Phase 0/1 status

- root `pnpm dev` is the normal single-port TypeScript Host entry;
- formal `/api/v1` and durable replay remain private FastAPI authority;
- `/experimental/pi/*` is explicit, live-only, and non-durable;
- `/internal/migration/*` is loopback-only and excluded from the public proxy;
- rollback and standalone commands remain migration/debug-only.

The boundary documents remain contracts, not proof by themselves. Exact implementation
and E2E evidence is recorded in `.superpowers/sdd/task-5-report.md` through
`task-12-report.md`; code and tests remain the source of truth.

## Migration progress

Per [BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md) §0:
Phase 0/1/3/4 are complete (Phase 4 = TS Dataset Deterministic Core port,
`server/src/dataset/`, merged 2026-08-13; runtime wiring lands with the
Phase 7 host switch). Phase 2 (Skills migration) is next, followed by
Phase 5 (external capabilities), 6 (model settings), 7 (frontend switch),
and 8 (Python removal). Checkboxes and priorities live in [TODO.md](../TODO.md).

## Phase 3 opt-in status

With `APP_HOST=ts`, `AGENT_RUNTIME=pi`, and `DATASET_CORE=python`, new formal Agent
Tasks use the durable TypeScript application runtime. Legacy Tasks and all APIs not
yet migrated continue through private FastAPI. The default profile remains
`AGENT_RUNTIME=legacy` until this flag is selected explicitly; the planned default
switch waits for Phase 2 Skills and cross-phase integration gates (TODO.md Phase 3).
