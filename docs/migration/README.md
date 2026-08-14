# Phase 0/1/3 Migration Boundary Index

These documents define the Phase 0/1 operating contracts implemented by the
TypeScript Host, Pi adapter, governed Workspace, and TS Dataset Core, plus the
Phase 3 durable TS Application Runtime boundary. They are subordinate to
[ARCHITECTURE.md](../ARCHITECTURE.md) and the
[ADR index](../adr/README.md); they do not duplicate the full execution sequence in
[BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md](../BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md)
and the overall phase plan in
[BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md).
Migration progress is tracked in [TODO.md](../TODO.md).

> **Phase 8 status（2026-08-14）：迁移完成。** Legacy Python Runtime / FastAPI
> rollback topology 已物理删除，本索引中的边界文档为历史契约记录
> （historical / completed），不再是当前启动说明。当前唯一拓扑：
> TS Host + Pi Agent + TS Dataset Core；Python 仅剩 `database/` persistence
> bridge（JSONL named-op）。

| Boundary | Authoritative migration document |
| --- | --- |
| Frozen environment, legacy measurements, DatasetBuild golden fixtures | [Pi migration baseline — 2026-08-11](baseline-2026-08-11.md) |
| Current/Phase 1/later resource ownership and cleanup | [Runtime ownership matrix](runtime-ownership-matrix.md) |
| Current Main Agent tools and minimal Phase 1 prompt | [Agent tool and prompt matrix](agent-tool-prompt-matrix.md) |
| Named Python V2 Core operations, envelopes, errors, transport, cancellation (historical) | [Legacy Dataset Core bridge](legacy-dataset-core-bridge.md) |
| Task Workspace permissions, exec modes, Windows/Linux security cases | [Phase 1 Workspace policy](workspace-policy-phase1.md) |
| Phase 2 decisions: skill content migration, stable Skill↔Tool map, retired skill runtime, thin database store | [Phase 2 skills & tools migration](phase2-skills-tools-migration.md) |
| Pi-to-BioMed event mapping and sequence meaning | [Pi event adapter](pi-event-adapter.md) |
| Single Host startup/shutdown, flags, valid combinations, rollback (historical) | [Single-Host lifecycle and flags](single-host-lifecycle-and-flags.md) |
| Phase 3 durable TS Task/Run/Event ownership | [Phase 3 TypeScript Application Runtime](phase3-ts-application-runtime.md) |
| Phase 5 completion plan, baseline/migration matrix, PDF spike | [Phase 5 external capabilities](phase5-external-capabilities.md) + [completion plan](phase5-external-capabilities-completion-plan.md) + [PDF spike](phase5-pdf-spike.md) |
| Phase 7 default TS Host cutover, rollback boundary, acceptance evidence | [Phase 7 Frontend → TS Host](phase7-frontend-ts-host.md) |
| **Phase 8 legacy Python Runtime retirement（执行计划 / 盘点 / 最终验证）** | [执行计划](phase8-python-runtime-retirement.md) + [retirement inventory](phase8-retirement-inventory.md) + [PHASE8_FINAL_VERIFICATION](PHASE8_FINAL_VERIFICATION.md) |
| Node/pnpm, Python/uv, environment variables, local data, validation (historical) | [Phase 0/1 environment migration](ENVIRONMENT_MIGRATION.md) |
| Final whole-branch findings, fixes, quality gates, and startup evidence (historical) | [Phase 0/1 final verification](PHASE0_1_FINAL_VERIFICATION.md) |

## Current status（Phase 8 后）

- root `pnpm dev` is the single-port TypeScript Host entry（Vite HMR）；
- root `pnpm start` serves the production bundle（`frontend/dist` static）；
- formal `/api/v1`、durable Task/Run/Event、WS replay 全部为 TS Host 原生 authority；
- Agent = Pi（`server/src/agent/pi-adapter.ts`），Dataset Core = TS（`server/src/dataset/`）；
- Python 仅 `database/bridge.py`：JSONL stdin/stdout named-op persistence bridge，
  由 TS `DatabaseClient` 按需管理生命周期；
- 不存在：FastAPI、Uvicorn、OpenAI Agents SDK、Python Agent loop / Dataset Core /
  Skill Runtime、legacy profile、第二个应用服务器、`/experimental/pi`。

The boundary documents remain historical contracts, not proof by themselves.
Code and tests remain the source of truth.
