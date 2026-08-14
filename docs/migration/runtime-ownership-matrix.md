# Phase 1 Runtime Ownership Matrix

> Historical Phase 1 inventory. For the Phase 7 default ownership, see
> [phase7-frontend-ts-host.md](phase7-frontend-ts-host.md).

This matrix inventories the process resources composed by `backend/app/main.py`
and the two transition resources named by the Phase 0/1 plan. It is an operational
record under [ARCHITECTURE.md §14 and §18](../ARCHITECTURE.md), not a replacement
runtime design. “Legacy” below means the loopback-only FastAPI process in Phase 1.

## Ownership and lifecycle

| Resource | Current owner | Phase 1 owner | Later target | Phase 1 action | Phase 1 creator | Phase 1 closer | Startup/runtime failure cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sync and storage thread executors | FastAPI lifespan | Legacy FastAPI lifespan | TS runtime or bounded service pools | Do not migrate | Legacy lifespan before serving | Legacy lifespan restores the prior loop executor and shuts both pools down | FastAPI startup fails closed; Host terminates a child that never becomes ready |
| `TaskIndex` and its single-thread executor | FastAPI lifespan | Legacy FastAPI lifespan | TS persistence index | Do not migrate | Legacy lifespan | `index_executor.close()` | Legacy `finally` closes the executor; Host reports backend startup failure |
| `TaskRepository` | FastAPI lifespan | Legacy FastAPI lifespan | TS persistence | Do not migrate | Legacy lifespan | No independent close; storage/index owners close their resources | Durable files remain authoritative; restart reconstructs projections rather than deleting task data |
| `TaskManager` and `ModeDispatchRunExecutor` | FastAPI lifespan | Legacy for `/api/v1`; TS Host Pi session registry for experimental runs | TS runtime using Pi | Introduce the Pi path in parallel; do not delete legacy | Legacy lifespan calls `manager.start()`; TS Host creates experimental sessions through the Pi adapter | Legacy `manager.close()`; TS Host cancels and disposes every experimental session | Admission stops, active work receives cancellation, and Host kills a managed legacy child if graceful shutdown fails |
| `EventHub` and `AssistantStreamHub` | FastAPI lifespan | Legacy FastAPI lifespan | TS durable projection plus realtime fan-out | Keep durable path legacy; add a separate experimental live bus | Legacy lifespan | `assistant_stream_hub.close()`, then `event_hub.close()` | Close subscribers without altering durable `events.jsonl`; experimental listeners are disposed with their Pi session |
| Skill runtime | DONE (Phase 2): `SkillCatalog`/`UserSkillStore` deleted; `DatabaseStore` (`app/databases/`) owns declarative database toggles; Pi adapter loads the curated `.pi/skills` root | — | `.pi/skills/*/SKILL.md` + `skill-tool-map.ts` | — | — | — | — |
| `ModelSettingsStore`, `ProviderModelStore`, and model preview HTTP client | FastAPI lifespan | Legacy FastAPI lifespan | TS/Pi settings and provider boundary | Do not migrate | Legacy lifespan | `model_preview_client.aclose()`; stores are process-owned | Client is closed in the legacy `finally`; Phase 1 Pi uses adapter-injected configuration and does not mutate legacy stores |
| `WorkflowRecipeStore`, `RecipeExecutor`, and controlled recipe client | FastAPI lifespan | Legacy FastAPI lifespan | TS acquisition services | Do not migrate | Legacy lifespan | `recipe_client.aclose()` | In-flight transport errors stay on the legacy operation; Host shutdown closes the client before terminating the process |
| `BrowserPool` and `CrawlerFacade` | FastAPI lifespan | Legacy FastAPI lifespan | Node browser/acquisition services | Do not migrate | Legacy lifespan calls `browser_pool.start()` | `crawler_facade.aclose()`, then `browser_pool.close()` | Browser startup failure prevents readiness; shutdown closes crawler work before browser contexts |
| `SubagentSupervisor`, `InputBroker`, and `DurableSubagentEventSink` | FastAPI lifespan | Legacy FastAPI lifespan | Optional Pi child sessions | Do not migrate in Phase 1 | Legacy lifespan | `subagent_supervisor.shutdown()` before `manager.close()` | Supervisor cancels children and releases waiters; Phase 1 does not create a second orchestration framework |
| `CacheStore` | FastAPI lifespan | Legacy FastAPI lifespan | TS data/cache service | Do not migrate | Legacy lifespan through `init_cache_store()` | Process-owned; no independent close in the current composition root | Initialization failure prevents readiness; persistent cache records are not removed during rollback |
| Python V2 Dataset Core | Constructed through Python service/tool paths | Python V2 Dataset Core | A parity-proven future Core | Add only the named-operation bridge | Legacy Python service | Per-operation cleanup plus legacy process shutdown | Cancellation and typed failures return through the bridge; incomplete staging is never promoted |
| Vite development server | Standalone Vite process | TS Application Host middleware | TS Application Host | Migrate lifecycle ownership | TS Host after Pi/legacy readiness | TS Host closes Vite before terminating the managed legacy backend | Host closes resources already created in reverse order and never opens the public port if a required dependency fails |
| Formal Task/Run/Event runtime | FastAPI `TaskManager` / repository / hubs | Phase 3 opt-in TS runtime for `task_ts_*`; legacy FastAPI for historical tasks | TS application runtime | Activate only with `AGENT_RUNTIME=pi` | TS Host after private FastAPI readiness | TS Host cancels sessions, disposes Workspace, waits execution tails, then closes sockets | Nonterminal TS Runs recover once as `interrupted`; durable files are preserved |

## Phase 1 composition rule

The TypeScript Host creates only resources needed for its new responsibilities:
the public HTTP server, Vite middleware, the Pi adapter/session registry, experimental
event bus, Workspace tools, the Legacy Dataset Core client, and optionally the
managed loopback FastAPI child. It does not translate the FastAPI composition root
or create a second TaskRepository, durable Event Store, Skill Store, model registry,
browser pool, recipe runtime, cache, or SubagentSupervisor.

Shutdown order is fixed by the
[single-host lifecycle contract](single-host-lifecycle-and-flags.md). A Phase 1 PR
that changes a row must name its creator, closer, and partial-startup cleanup before
the ownership change is accepted.
