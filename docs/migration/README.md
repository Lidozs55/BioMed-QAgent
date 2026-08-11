# Phase 0/1 Migration Boundary Index

These documents define the Phase 1 operating contracts now implemented by the
TypeScript Host, Pi experimental adapter, governed Workspace, and Python V2 Core bridge.
They are subordinate to [ARCHITECTURE.md](../ARCHITECTURE.md) and the
[ADR index](../adr/README.md); they do not duplicate the full execution sequence in
[BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md](../BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md).

| Boundary | Authoritative migration document |
| --- | --- |
| Frozen environment, legacy measurements, DatasetBuild golden fixtures | [Pi migration baseline — 2026-08-11](baseline-2026-08-11.md) |
| Current/Phase 1/later resource ownership and cleanup | [Runtime ownership matrix](runtime-ownership-matrix.md) |
| Current Main Agent tools and minimal Phase 1 prompt | [Agent tool and prompt matrix](agent-tool-prompt-matrix.md) |
| Named Python V2 Core operations, envelopes, errors, transport, cancellation | [Legacy Dataset Core bridge](legacy-dataset-core-bridge.md) |
| Task Workspace permissions, exec modes, Windows/Linux security cases | [Phase 1 Workspace policy](workspace-policy-phase1.md) |
| Pi-to-BioMed experimental event mapping and sequence meaning | [Pi event adapter](pi-event-adapter.md) |
| Single Host startup/shutdown, flags, valid combinations, rollback | [Single-Host lifecycle and flags](single-host-lifecycle-and-flags.md) |

## Implemented Phase 0/1 status

- root `pnpm dev` is the normal single-port TypeScript Host entry;
- formal `/api/v1` and durable replay remain private FastAPI authority;
- `/experimental/pi/*` is explicit, live-only, and non-durable;
- `/internal/migration/*` is loopback-only and excluded from the public proxy;
- rollback and standalone commands remain migration/debug-only.

The boundary documents remain contracts, not proof by themselves. Exact implementation
and E2E evidence is recorded in `.superpowers/sdd/task-5-report.md` through
`task-12-report.md`; code and tests remain the source of truth.
