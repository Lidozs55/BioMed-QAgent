# Phase 0/1/3 Migration Boundary Index

These documents define the Phase 0/1 operating contracts now implemented by the
TypeScript Host, Pi experimental adapter, governed Workspace, and Python V2 Core
bridge, plus the Phase 3 durable TS Application Runtime boundary. They are
subordinate to [ARCHITECTURE.md](../ARCHITECTURE.md) and the
[ADR index](../adr/README.md); they do not duplicate the full execution sequence in
[BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md](../BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md)
and the overall phase plan in
[BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md).
Migration progress and remaining Phase 8 work are tracked in [TODO.md](../TODO.md).

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
| Phase 5 completion plan, baseline/migration matrix, PDF spike | [Phase 5 external capabilities](phase5-external-capabilities.md) + [completion plan](phase5-external-capabilities-completion-plan.md) + [PDF spike](phase5-pdf-spike.md) |
| Phase 7 default TS Host cutover, rollback boundary, acceptance evidence | [Phase 7 Frontend → TS Host](phase7-frontend-ts-host.md) |
| Node/pnpm, Python/uv, environment variables, local data, validation, rollback | [Phase 0/1 environment migration](ENVIRONMENT_MIGRATION.md) |
| Final whole-branch findings, fixes, quality gates, and startup evidence | [Phase 0/1 final verification](PHASE0_1_FINAL_VERIFICATION.md) |

## Current status

- root `pnpm dev` is the normal single-port TypeScript Host entry;
- formal `/api/v1` and durable replay are native TS Host authority;
- `/experimental/pi/*` is disabled by default, live-only, and non-durable when enabled;
- `/internal/migration/*` is loopback-only and excluded from the public proxy;
- FastAPI starts only for legacy Agent, Python Core, or experimental Pi rollback profiles;
- rollback and standalone commands remain migration/debug-only.

The boundary documents remain contracts, not proof by themselves. Exact implementation
and E2E evidence is recorded in `.superpowers/sdd/task-5-report.md` through
`task-12-report.md`; code and tests remain the source of truth.

## Migration progress

Per [BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md) §0:
Phases 0–7 are complete. Phase 5 (external capabilities + Python data-processing
retirement, 2026-08-14) migrated every business tool to TypeScript behind the
shared network/acquisition foundation and wired them into the formal Pi runtime;
the M2 integration closure made `DATASET_CORE=ts` a working opt-in profile.
Phase 7 promoted `ts/pi/ts/0` to the default and made FastAPI conditional.
Python now serves only the explicit legacy rollback runtime and the DB bridge
(`database/bridge.py`). Phase 8 deletes the legacy Python runtime.
Checkboxes and priorities live in [TODO.md](../TODO.md).

## Phase 3 runtime after Phase 7

The durable TypeScript application runtime is now the default formal Task authority.
`AGENT_RUNTIME=legacy` and `DATASET_CORE=python` remain explicit rollback choices;
they create private FastAPI only for the responsibilities selected by that profile.
