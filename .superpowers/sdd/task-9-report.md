# Task 9 — Phase 1D Pi event adapter, WebSocket, and frontend report

Status: complete

Branch/worktree: `migration/pi-runtime-phase0-1` in
`D:\coding\BioMed-QAgent\.worktrees\migration-pi-runtime-phase0-1`

Starting HEAD: `ec1b5a0`

Commit: the commit containing this report, `feat: add experimental Pi event stream`
(resolve with `git rev-parse HEAD`; no push was performed).

## Genuine RED evidence

- Event adapter: the initial focused Vitest run failed because
  `server/src/agent/event-adapter.js` could not be resolved. After the first
  implementation, 4 tests passed and 1 failed because an unknown event after a
  terminal event was suppressed before its diagnostic was recorded. The final
  focused adapter suite passes 5/5.
- Experimental API/WebSocket: the first four WS cases all failed: the new
  task/run routes returned 404 and the runtime did not expose
  `handleUpgrade`. After the protocol implementation, 3/4 passed and one timed
  out because callback-based socket flushing stalled; the bounded microtask
  writer fixed it. The final WS suite passes 4/4 with no socket-cleanup hang.
- Slow-subscriber bound: the initial bound test failed with
  `BoundedWebSocketWriter is not a constructor`; exporting and applying the
  finite writer made the two bounds/isolation tests pass.
- Frontend: both initial experimental suites failed to resolve the absent
  experimental app/modules. The final two focused files pass 6/6 without
  stderr warnings.

## Event and protocol evidence

- `@biomed/contracts` now owns the experimental task/run/cancel DTOs and the
  subscribe/unsubscribe/ping/control-frame unions. Existing EventEnvelope and
  payload contracts were preserved.
- `PiEventAdapter` consumes only project-owned `BioMedAgentEvent` values and
  maps turn, assistant/reasoning, tool success/error, cancellation, completion,
  and failure events to schema-valid envelopes. It maintains positive,
  per-task in-memory sequence numbers across sequential runs, suppresses
  duplicate terminals, and reports unknown inputs only through bounded server
  diagnostics.
- Browser-bound chunks, arguments, output, paths, credentials, Bearer values,
  diagnostics, and failures are bounded/redacted. `run_completed` carries
  `build_result: null` and means only that the Agent turn ended.
- The feature-gated runtime implements task creation, sequential runs on one
  Pi session, cancellation request/ack separation, and live-only WebSocket
  subscribe/unsubscribe/ping. A replay request returns
  `experimental_replay_unavailable`.
- The event bus and subscription registry are ephemeral. A static isolation
  test proves the experimental source does not import TaskRepository,
  TaskManager, EventStore, or `events.jsonl`. Queued frames and socket buffering
  are finite; a slow subscriber is closed with code 1013.
- `/api/v1/*` and `/api/v1/ws` retain the existing proxy path; only the exact
  experimental WebSocket path is intercepted.

## Frontend evidence and shadcn reuse

- The experimental root is selected only by explicit build configuration
  `VITE_PI_EXPERIMENTAL_UI=1` or runtime configuration
  `window.__BIOMED_RUNTIME_CONFIG__.piExperimentalUi=true`. The legacy `App`,
  controller, store, reducer, transport, replay, and hydration remain the
  default path.
- A dedicated client, live WebSocket transport, and isolated projection render
  connection state, user turns, assistant/reasoning streams, tool
  start/result/error, terminal/failure/cancel state, sequence gaps, and the
  disconnect/no-replay limitation.
- Following the repository shadcn skill and inspected project metadata, the
  view composes the existing `MessageScroller`, `Message`, `Bubble`, `Marker`,
  `Alert`, `Badge`, `Button`, `Field`, and `Textarea` primitives, semantic
  variants, and Phosphor icons. It adds no parallel chat or form primitives and
  does not duplicate the mature legacy shell.
- Boundary and behavior tests prove the experimental modules do not import or
  mutate the legacy runtime transport/store and never send `after_sequence`.

## Exact verification

- Focused contracts: 2 files, 4 tests passed.
- Focused event adapter: 1 file, 5 tests passed.
- Focused WebSocket: 1 file, 4 tests passed.
- Focused bounds/isolation: 1 file, 2 tests passed.
- Focused frontend experimental path: 2 files, 6 tests passed with no stderr.
- Server full tests: 14 files, 73 tests passed.
- Frontend full tests: 56 files, 745 tests passed. Existing unrelated React
  `act(...)` warnings remain in older tests.
- `pnpm --filter @biomed/server lint`: passed.
- `pnpm --filter @biomed/server typecheck`: passed.
- `pnpm --filter @biomed/server build`: passed.
- `pnpm --filter @biomed/frontend lint`: passed.
- `pnpm --filter @biomed/frontend typecheck`: passed.
- `pnpm --filter @biomed/frontend build`: passed, with the existing Vite
  chunk-size advisory only.
- Root finite `pnpm test`: passed (contracts 4, server 73, frontend 745).
- Root finite `pnpm lint`: passed.
- Root finite `pnpm typecheck`: passed.
- Root finite `pnpm build`: passed, with the same Vite chunk-size advisory.
- Final focused server tests/lint/typecheck after diagnostic wiring: passed.

## Task 10/11 notes

- Task 10 bridge-tool diagnostics should retain request/build IDs, typed exit or
  error codes, and duration in bounded server diagnostics while keeping raw
  provider output, credentials, private paths, and tracebacks out of browser
  events. Publication success must remain distinct from this task's Agent-turn
  completion.
- Task 11 should exercise the real model/tool vertical slice, multiple turns on
  one session, cancellation, feature-profile startup, and host shutdown. The
  Task 8 workspace is created with the first run identity; if later bridge
  tools require an exact audit identity for every sequential turn, pass an
  explicit per-run context rather than treating the first run ID as current.
