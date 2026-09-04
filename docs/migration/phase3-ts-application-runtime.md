# Phase 3 TypeScript Application Runtime

This document records the implemented Phase 3 boundary from
`BioMed-QAgent_Pi_Migration_Plan.md`. It is subordinate to
`docs/ARCHITECTURE.md` and ADR-017 through ADR-024.

## Activation

Phase 3 is opt-in while Phase 2 Skills and Phase 4 Dataset Core migration continue:

```text
APP_HOST=ts
AGENT_RUNTIME=pi
DATASET_CORE=python
PI_EXPERIMENTAL=0|1
```

The default profile remains `AGENT_RUNTIME=legacy`, so merging this phase does not
move existing formal traffic until the operator selects Pi. `PI_EXPERIMENTAL` now
controls only the additional `/experimental/pi/*` surface.

## Ownership

For TS-owned tasks (`task_ts_*`), the TypeScript runtime owns:

- Task and Run admission, request-id idempotency, and one active Run per Task;
- append-only `<task_id>/events.jsonl` with per-Task monotonic sequence;
- pure event reduction into Task/Run/message/publication projections;
- restart recovery of nonterminal Runs as `interrupted`;
- Pi Session mapping and task-local Pi session persistence under
  `state/pi-session/`;
- formal Task HTTP routes and `/api/v1/ws` replay followed by live delivery;
- cancellation acknowledgement and immutable-publication artifact serving.

Python remains authoritative for the deterministic Dataset Core and all APIs not
owned by Phase 3. Legacy Task HTTP requests fall through to FastAPI. One formal
WebSocket multiplexes TS Task subscriptions locally and forwards legacy Task
subscriptions to private FastAPI. The first task-list page merges TS and legacy
results; legacy pagination cursors continue through FastAPI.

## Durable Files

```text
tasks/<task_ts_id>/
├── events.jsonl
├── state/
│   ├── task.json
│   └── pi-session/*.jsonl
├── datasets_build/<build_id>/
└── logs/workspace-audit.jsonl
```

`task.json` contains immutable admission metadata plus the explicit Pi Session
mapping. Runtime status is rebuilt from `events.jsonl`; it is not independently
mutated in metadata.

Task artifact endpoints resolve only manifest-registered files from the newest
immutable publication directory. The server validates Task/Build/Manifest identity,
publication-to-manifest reference, relative path confinement, byte size, and SHA-256
before listing or downloading a file.

## Rollback

Set `AGENT_RUNTIME=legacy` and restart. Existing `task_ts_*` event logs, Pi session
files, DatasetBuild directories, and publications are left untouched. Legacy Task
history remains readable throughout Phase 3. A later migration step may add an
explicit read-only TS Task history endpoint in legacy mode; rollback never rewrites
or converts existing durable data.

## Verification

Server tests cover:

- request-id idempotency and sequential multi-Run Tasks;
- restart interruption recovery and sequence continuity past 1,000 events;
- replay-to-live WebSocket handoff and legacy subscription forwarding;
- cancellation terminal acknowledgement and shutdown convergence;
- BuildResult projection from the Python bridge;
- immutable publication artifact integrity and traversal protection;
- Host route ownership with legacy HTTP/WS fallback.
