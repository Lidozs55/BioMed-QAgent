# Fix Wave 4 — Frontend (sequence-gap recovery, structured RunSummary rendering)

Base: wave-1 merged HEAD (`ffc49e6`) on `fix/phase4-review-bugs`.
Scope: frontend only (`frontend/`). No backend files touched.
Method: TDD (red → fix → green) for both findings.

## F1 = C2 (Important) — sequence-gap detection

**Bug (reducer level):** `reduceRuntimeEvent` accepted any `sequence > lastSequence`,
so a dropped/rejected frame at N followed by a valid N+1 permanently advanced the
cursor past N. After the wave-1 C1 fix (transport now accepts `publication_created`),
the generic flaw remained: a missed `user_input_required` (or any undeliverable
frame) followed by a later event would leave the paused run with no dialog forever,
because the cursor had advanced past the gap and replay could never re-send it.

**Fix (minimal, defensive + eager recovery):**

1. `frontend/src/runtime/reducers/index.ts` — `reduceRuntimeEvent` now rejects
   `sequence > lastSequence + 1`: the event payload is NOT reduced, the cursor is
   NOT advanced, and a recoverable marker is recorded on the task
   (`task.sequenceGap = { expected: lastSequence + 1, received: sequence }`).
   A contiguous event clears the marker (`sequenceGap: null`).
2. `frontend/src/runtime/types.ts` — new `SequenceGapMarker` type;
   `TaskProjection.sequenceGap: SequenceGapMarker | null` (init `null`).
3. `frontend/src/runtime/reducers/shared.ts` — `createTaskProjection` initializes
   `sequenceGap: null`; `hydrateTaskSnapshot` clears it (a snapshot is
   authoritative — its `latest_sequence` covers the event window).
4. `frontend/src/stores/agentStore.ts` — `applyEvent` now surfaces the reducer's
   gap marker to the transport (returns `SequenceGapMarker | null`).
5. `frontend/src/runtime/transport.ts` — after `applyEvent`, when the reducer
   recorded a gap for a still-desired task, the transport requests a replay:
   `recoverSubscription(taskId, getLastSequence(taskId))` (socket replacement +
   subscribe with `after_sequence = lastSequence`; the server replays contiguously
   from there). Bounded by a per-task `gapRecoveryCursors` map so a permanently
   undeliverable frame (e.g. schema drift rejected at the gate) triggers at most
   one recovery per cursor position; afterwards the transport is defensive-only
   and re-syncs on the next natural reconnect. Applied events clear the guard.

**Why the reducer is the right boundary:** the backend enforces contiguous
per-task sequences (`event_store.py` raises on `expected = latest.sequence + 1`),
so the server replays contiguously from `after_sequence`. The only way a reducer
sees a gap is a frame dropped/rejected client-side; keeping the cursor at the last
applied sequence makes the missing event recoverable by replay.

**Tests (red → green):**
- `src/test/runtime-reducer.test.ts` — seed `lastSequence=4`, deliver sequence 6:
  NOT reduced (no items), cursor stays 4, `sequenceGap = {expected: 5, received: 6}`;
  then deliver 5 and 6 → both applied, cursor 6, marker cleared.
- `src/test/agent-stream.test.ts` — real transport + store: deliver seq 6 at
  cursor 4 → not reduced, cursor 4, socket replaced and fresh connection
  subscribes `after_sequence: 4`; then deliver 5 and 6 on the new socket → both
  applied, cursor 6.

**Intent-preserving fixture updates required by the new invariant** (these tests
delivered non-contiguous sequences as shortcuts, which is exactly the C2 pattern
now forbidden):
- `store.test.ts` — seed `task_a`/`task_terminal` at latest 2 and `task_live` at
  latest 4 so the single terminal event is contiguous (3 = 2+1, 5 = 4+1).
- `runtime/__tests__/terminal-state.test.ts` — `summary()` latest_sequence 0 → 1
  so the first delivered event (sequence 2) is contiguous.
- `runtime-reducer.test.ts` — "same root for duplicate/stale" seeds cursor 2;
  re-entry test uses contiguous 1, 2, 3 instead of 1, 50, 90 (keeps the event-clock
  ordering assertion, just with contiguous sequences).
- `agent-stream.test.ts` — "reconnects after 1013" delivers events 1..8
  contiguously instead of a single jump to 8, preserving the watermark intent.
- `runtime-controller.test.ts` — two artifact-hydration tests make `fetchEvents`
  fixtures contiguous (1..4 / 1,2 then 3) since `prepareTaskSnapshotReplay`
  resets the cursor to 0 before REST replay.

## F2 = C6 (Important) — four-state UI hides structured RunSummary details

**Bug:** the header Marker only rendered a short label (`任务已完成` / `任务执行失败`
/ `任务已取消` / build label). `RunSummary` (BuildResult.user_summary,
recommended_next_action, error_code, user_message, cancelled_at_stage) was
discarded, contradicting the Phase 4a acceptance (COMPLETED 附 BuildResult、FAILED
附稳定错误分类、CANCELLED 附取消点).

**Fix (bounded, no redesign):** `frontend/src/components/ChatPanel.tsx` adds a
compact `renderLatestRunSummary(latestRun)` block right below the status Marker,
driven purely by the latest run's `run.summary` (never `run.error`):
- build outcomes (`build_result !== null`, covers succeeded/partial_success/
  spec_rejected/no_data): `user_summary` + `recommended_next_action` when present;
- failed: `错误码：<error_code>` + `user_message`;
- cancelled/interrupted: `取消于<STAGE_LABELS[cancelled_at_stage]>阶段`.
Renders nothing when there is no summary or no structured fields are populated, so
the existing label-only tests and the "no summary" failed test keep passing.

**Tests (red → green):** `src/test/chat-panel.test.tsx` renders ChatPanel with
terminal runs for partial_success, spec_rejected, failed (`download_incomplete` +
user message), and cancelled-at-processing, asserting the server summary / action /
error code / stage text is visible. All existing label tests (succeeded, partial,
no_data, spec_rejected, failed, generic completed, icon checks) still pass.

## Verification (from `frontend/`)

- `pnpm test` — **677 passed** (baseline 671 + 6 new: 2 F1 + 4 F2), 42 files.
- `pnpm lint` — clean (eslint `--max-warnings 0`).
- `pnpm build` — `tsc -b && vite build` OK.

## Residual risks / notes

- Gap recovery triggers a socket replacement (the transport's existing replay
  mechanism). Bounded per cursor position; permanent gaps degrade to
  defensive-only and heal on the next natural reconnect or when the server can
  finally deliver the missing frame.
- The `sequenceGap` marker is intentionally transient (reducer + hydration only);
  it is not persisted.
- No backend changes; the backend's contiguous-sequence guarantee is what makes
  the reducer-level check safe.
