# Agent Runtime Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Every behavior change follows RED-GREEN-REFACTOR and each task is committed and reviewed independently.

**Goal:** Add backend-authoritative, durable multi-turn Agent sessions with four-way cross-task concurrency, replayable state, paginated history, and a task-isolated shadcn frontend.

**Architecture:** A FastAPI-lifespan TaskManager owns run admission, per-task serialization, cancellation, and event fan-out. Per-task event logs and snapshots are authoritative; a rebuildable SQLite index serves pagination and idempotency. The frontend is only an ephemeral projection of backend sessions and events.

**Tech Stack:** Python 3.12, FastAPI, OpenAI Agents SDK, asyncio, sqlite3, React 19, Zustand, Vite, Tailwind v4, shadcn Base Nova, Phosphor, pnpm, uv.

## Global Constraints

- One Task is a durable multi-turn Agent session; one Run is one user turn. Runs in the same Task are serialized; Runs in different Tasks may execute concurrently.
- RunStatus is exactly: `queued | running | finalizing | cancel_requested | completed | failed | cancelled | interrupted`.
- Defaults: 4 active Runs, 4 synchronous worker threads, 100 queued Runs, task page size 30/max 100, WebSocket subscriber queue 1000.
- Generic Agent progress uses real lifecycle and tool activities; only fixture mode exposes deterministic pipeline stages.
- All session history is authoritative and durable on the backend. Frontend localStorage stores UI preferences only and v1 local sessions are discarded without import.
- Startup loads the first backend history page but leaves `activeTaskId=null` and displays a new-research draft.
- Preserve current artifact ID download endpoints and deterministic fixture behavior.
- Use `uv` for backend and `pnpm` for frontend. Never use npm or TypeScript error suppression.
- Do not modify CI/CD, packaging, or distribution flows.

---

### Task 1: Runtime Contracts And Authoritative Reducer

**Files:**
- Modify: `backend/app/domain/contracts/events.py`, `enums.py`, `ids.py`, `__init__.py`
- Create: `backend/app/domain/contracts/runtime.py`, `backend/app/runtime/state.py`, `backend/app/runtime/__init__.py`
- Test: `backend/tests/contracts/test_runtime_contracts.py`, `backend/tests/runtime/test_state_reducer.py`

**Required behavior:**
- Add EventEnvelope v2 fields `schema_version` and optional `run_id`; old v1 fixture JSON without these fields remains valid.
- Add TaskMode, RunStatus, MessageRole, RunRecord, TaskSummary, TaskSnapshot, TaskPage, MessagePage, StartTaskRequest, StartRunRequest, and TaskRunAccepted.
- Add discriminated payloads for run queued/started/finalizing/completed/failed/cancel requested/cancelled/interrupted, assistant delta, tool started/completed, conversation compacted, and warning.
- Enforce run_id on all run-scoped events, task-local monotonic sequence, legal transitions, and terminal immutability.
- Preserve stage_attempt_id validation for fixture stage events.

**TDD gate:** Tests must first fail for missing v2 parsing and invalid transitions, then pass with focused contract/reducer suites. Commit: `feat(runtime): add task run contracts and state reducer`.

---

### Task 2: Durable Event Store, Session, Index, And Pagination

**Files:**
- Create focused modules under `backend/app/runtime/`: `event_store.py`, `repository.py`, `index.py`, `session.py`
- Modify: `backend/app/config.py`
- Test: `backend/tests/runtime/test_event_store.py`, `test_repository.py`, `test_index.py`, `test_session.py`

**Required behavior:**
- Persist per-task `events.jsonl`, atomic `state/task_snapshot.json`, `state/session_items.jsonl`, and `state/conversation_summary.json`.
- Implement the Agents SDK Session protocol without manually concatenating prompts. Full raw session items remain durable.
- Maintain `tasks/task_index.sqlite3` in WAL mode using a dedicated single-thread executor. The index stores summaries, run/request idempotency, and pagination metadata but is rebuildable from task snapshots/events.
- `list_tasks(limit, cursor)` returns all active items plus inactive history ordered by immutable `(created_at DESC, task_id DESC)`, with an opaque cursor; defaults 30 and max 100.
- Task snapshot returns latest 100 messages and an older-message cursor. Message pagination uses immutable ordinals.
- Duplicate request_id returns the existing Task/Run.

**TDD gate:** Cover atomic recovery, malformed trailing JSONL, index rebuild, 65-item pages of 30/30/5 without duplicates, active items, idempotency, and Session add/get/pop/clear. Commit: `feat(runtime): persist sessions and paginated task history`.

---

### Task 3: TaskManager Concurrency, Queue, Recovery, And Cancellation

**Files:**
- Create: `backend/app/runtime/manager.py`, `hub.py`
- Modify: `backend/app/main.py`, `backend/app/config.py`, `backend/app/agent_loop/context.py`
- Test: `backend/tests/runtime/test_manager.py`, `test_hub.py`, `backend/tests/test_config.py`

**Required behavior:**
- FastAPI lifespan creates one TaskManager, FIFO queue, four-slot semaphore, per-task locks, event hub, four-thread default executor, and one-thread index executor.
- Reject a second active Run in the same Task with conflict; allow independent Tasks to overlap. Reject submissions beyond 100 queued Runs.
- Queued cancellation records cancel_requested then cancelled and workers skip the queue entry.
- Running cancellation sets a RunContext cancellation token, records cancel_requested, calls the stored SDK streaming result with `cancel("after_turn")`, drains events, then records cancelled.
- On startup, queued Runs re-enter FIFO; running/finalizing/cancel_requested Runs become interrupted.
- Each connection subscription queue is bounded at 1000 and fan-out never allows concurrent WebSocket sends.

**TDD gate:** Controlled fake runners prove four concurrent/fifth queued, FIFO, same-task conflict, cross-task isolation, cancellation ordering, restart recovery, and subscriber overflow. Commit: `feat(runtime): orchestrate concurrent task runs`.

---

### Task 4: Agent Session, Automatic Compaction, And Fixture Boundaries

**Files:**
- Modify: `backend/app/agent_loop/agent.py`, `runner.py`, `model.py`, `context.py`, `backend/app/pipeline/tool.py`, `pinned_case.py`
- Create: `backend/app/runtime/compaction.py`
- Test: agent/runtime compaction, runner, model lifecycle, pipeline cancellation tests

**Required behavior:**
- Run generic work through `Runner.run_streamed(agent, input, context=ctx, session=task_session)`.
- Replace module-global loaded skill metadata with an AgentBuild result carrying agent, skill names, and model handle. Close LazyDashScopeModel in every terminal path.
- Stream authoritative activity payloads through the manager; coalesce assistant text at 100 ms or 1 KiB before durable append.
- Before a new Run, compact when unsummarized history exceeds 60,000 characters. Use a no-tool same-model summarizer, keep five complete raw Runs, persist structured summary plus covered run/digest, and never delete originals.
- On compaction failure emit warning, retain the previous summary marker, and supply the latest 20 complete Runs for that turn.
- Add cancellation checkpoints between fixture stages and immediately before atomic artifact/manifest publication. Cancelled Runs do not emit artifact events.

**TDD gate:** Cover multi-turn SDK session usage, skill isolation under concurrency, model close on success/error/cancel, compaction threshold/result/failure fallback, and no artifact publication after cancel. Commit: `feat(agent): add durable multi-turn execution`.

---

### Task 5: REST Control Plane And WebSocket Replay

**Files:**
- Refactor: `backend/app/api/routes.py`, `ws.py`
- Test: backend API and WebSocket integration tests

**Required behavior:**
- `POST /api/v1/tasks` creates Task plus first Run and returns 202; `POST /tasks/{task_id}/runs` continues agent Tasks and returns 409 for active Runs or fixture continuation.
- `POST /tasks/{task_id}/runs/{run_id}/cancel`, paginated `GET /tasks`, `GET /tasks/{task_id}`, message/events pagination, and existing artifact endpoints use TaskManager/repository.
- WebSocket accepts only subscribe/unsubscribe/ping after migration. Subscribe carries per-task after_sequence, replays durable events, then joins live fan-out without a sequence gap.
- Keep the old WS run command only until the frontend consumer migrates, then remove it in this task's final commit.
- Slow consumers close with a reconnectable code and recover through replay.

**TDD gate:** Cover validation/status codes, idempotent retry, REST-snapshot/WS race, disconnect without cancellation, replay ordering/deduplication, ping, and slow consumer handling. Commit: `feat(api): expose durable task control and event replay`.

---

### Task 6: Frontend Task Projection, Transport, And Startup History

**Files:**
- Refactor: `frontend/src/stores/agentStore.ts`, `frontend/src/hooks/useAPI.ts`, `useAgentStream.ts`, `frontend/src/App.tsx`
- Create focused frontend runtime types/reducer modules under `frontend/src/runtime/`
- Test: store, reducer, API, transport, and App integration tests

**Required behavior:**
- Store shape is `tasksById/taskOrder/activeTaskId/activeItems/nextCursor/connectionStatus/draft`; each task owns messages, runs, activities, artifacts, fixture stages, and lastSequence.
- Pure reducer routes by task_id/run_id and ignores duplicate or stale sequence. Completing Task A never changes Task B.
- Startup concurrently loads databases, first task page, and WebSocket; it subscribes active backend tasks but leaves activeTaskId null and displays a new draft.
- Starting a task/continuation uses REST with `req_${crypto.randomUUID()}`; WebSocket is event-only.
- Persist store version 2 UI preferences only. Migration from v1 discards sessions and never uploads them.
- Loading more history merges/deduplicates Task summaries; selecting a task fetches snapshot and subscribes from latestSequence.

**TDD gate:** Cover interleaved tasks, background completion, sequence idempotency, pagination merge, startup blank draft, request retry, continuation conflict, reconnect replay, and v1 discard. Commit: `feat(frontend): project backend task sessions`.

---

### Task 7: Shadcn Multi-Task Workspace

**Files:**
- Refactor: `SessionSidebar.tsx`, `ChatPanel.tsx`, `ToolTrace.tsx`, `ResultsViewer.tsx`, `ResearchPipeline.tsx`
- Create: `AgentProgress.tsx`; add shadcn Sonner via pnpm CLI after docs/dry-run review
- Test: component and App workflow tests

**Required behavior:**
- Sidebar shows active tasks plus 30 historical tasks, status icon/Badge, load-more Button+Spinner, cancellation for active Runs, and deletion for terminal Tasks.
- Switching/viewing/new draft remains available while other Tasks run. The footer shows running count out of four and connection state separately.
- Generic mode shows real queued/running/finalizing/cancel/terminal state and current tool activity without fabricated percentage. Fixture mode retains deterministic stage progress.
- ChatPanel sends a continuation only when the selected Task is idle; otherwise its input is disabled. New research uses an independent draft.
- ToolTrace and ResultsViewer are scoped to activeTaskId; clearing/hiding traces cannot reset or delete backend history.
- Background completion/failure uses Sonner with a View action. Preserve existing MessageScroller/Bubble chat composition, semantic tokens, Base UI APIs, and Phosphor icons.

**TDD gate:** Cover pagination/loading, task switching during background work, cancel/delete separation, generic vs fixture progress, continuation, scoped artifacts/traces, notifications, long labels, and mobile layout behavior. Commit: `feat(frontend): add concurrent task workspace`.

---

### Task 8: End-To-End Verification And Cleanup

**Files:**
- Add only focused integration tests or docs needed to close verified gaps; do not touch CI/CD or packaging.

**Required behavior:**
- Run backend `uv run pytest` and frontend `pnpm lint`, `pnpm test --run`, `pnpm build`.
- Integration test two overlapping Tasks, fifth queued, same-Task conflict, cancellation, reconnect/replay, restart recovery, pagination, multi-turn context, and fixture stage events.
- Start backend/frontend dev servers and verify desktop/mobile with Playwright screenshots: first-page history, load more, blank startup draft, concurrent statuses, switching, notifications, long title truncation, and no overlap.
- Restore generated `frontend/tsconfig.app.tsbuildinfo`, run `git diff --check`, confirm no unmerged entries, and perform whole-branch code review.

**Commit:** `test: verify concurrent agent session workflows`.
