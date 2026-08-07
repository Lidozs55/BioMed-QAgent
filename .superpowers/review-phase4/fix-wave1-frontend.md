# Fix Wave 1 — Frontend (Phase 4 Bug Sweep)

Commit: `dc32b33` on `fix/phase4-review-bugs` (worktree `/tmp/pi-agent-675958ae-7e17-402-9a5b48bd`, base `main@08c961c`)
Author: fix-wave-1 subagent
Scope: frontend only (runtime transport/controller/reducers, UserInputDialog, ResultsViewer, ArtifactSheet, hooks wiring). No backend files touched.
Method: TDD per fix — red vitest test, minimal fix, green. Full gates re-run at the end.

## Gate results (recorded)

| Gate | Command | Result |
|---|---|---|
| Full frontend suite | `cd frontend && pnpm test` | **42 files, 671 passed** (baseline 657 → +14 new tests) |
| Lint | `pnpm lint` (eslint . --max-warnings 0) | 0 errors, exit 0 |
| Build | `pnpm build` (tsc -b && vite build) | OK (only pre-existing chunk-size warning) |

## Fixes

### F1 (C1 Critical) — `publication_created` dropped at transport gate
- **Files**: `frontend/src/runtime/transport.ts`, `frontend/src/test/agent-stream.test.ts`
- **Root cause**: `EVENT_TYPES` lacked `"publication_created"`, so `isEventEnvelope` rejected the frame before the reducer; `lastSequence` advanced past it on the live WS path, permanently losing the publication chain.
- **Fix**: added `"publication_created"` to `EVENT_TYPES`. Reducer/contract handling already existed (`reducers/runtime.ts:applyPublicationCreatedEvent`, `contracts.ts`).
- **Test**: real `AgentEventTransport` → subscribe → deliver valid `publication_created` envelope → `tasksById[taskId].currentPublicationId === "pub-1"` and `lastSequence === 1`; a subsequent `run_completed` still applies (`lastSequence === 2`, status completed).

### F2 (C3 Important) — terminal tasks never unsubscribed
- **Files**: `frontend/src/runtime/transport.ts`, `frontend/src/hooks/useAgentStream.ts`, `frontend/src/runtime/controller.ts`, `frontend/src/test/agent-stream.test.ts`, `frontend/src/test/runtime-controller.test.ts`
- **Root cause**: completed/failed/cancelled tasks stayed in the transport's `desired` map and were resubscribed on every reconnect, accumulating one permanent WS subscription per finished task.
- **Fix**: new optional transport option `shouldSubscribe(taskId)`; after every applied envelope the transport reconciles — when `shouldSubscribe` returns false for a currently-desired task it drops the subscription, discards assistant streams, and sends `unsubscribe`. Production wiring in `useAgentStream` uses `store.activeItems.includes(taskId)` (a task stays active while any run is active, so multi-turn conversations are unaffected). Absent the option, behavior is unchanged (all existing transport tests pass untouched).
- **Counterpart (required to avoid a regression)**: `controller.continueTask` now explicitly re-subscribes the task at its current `lastSequence` after `addAcceptedTask`, because a continued terminal task would otherwise have no live subscription for the new run (the old leaked subscription used to cover this).
- **Test 1 (transport)**: subscribe running `task_a` + `task_b` → deliver `run_completed` for `task_a` → `isSubscribed("task_a") === false`, an `unsubscribe` command was sent, `task_b` still subscribed; reconnect → new socket emits **no** subscribe for `task_a`, still emits one for `task_b`.
- **Test 2 (controller)**: fully-hydrated terminal task (`hydration: "snapshot"`, watermark 5) → `continueTask` → `subscribe("task_terminal", 5)` called.

### F3 (C4 Important) — cancel leaves `pendingUserInput` + blocking dialog
- **Files**: `frontend/src/runtime/reducers/runtime.ts`, `frontend/src/components/UserInputDialog.tsx`, `frontend/src/test/runtime-reducer.test.ts`, `frontend/src/test/user-input-dialog.test.tsx`
- **Root cause**: `run_cancel_requested` set the run to `cancel_requested` but never cleared the owning `pendingUserInput`; the dialog stayed open (openness depends only on the stale prompt) and its buttons could still call resume and race the cancellation.
- **Fix**: `applyRunTransitionEvent` clears `pendingUserInput` when `run_cancel_requested` targets the owning run (terminal transitions already cleared it). Dialog defensive guard: `awaitingInput = runsById[pending.runId]?.status === "awaiting_user_input"`; `submit()` early-returns and all four action buttons are disabled when not awaiting input.
- **Tests**: reducer clears prompt on `run_cancel_requested` for the owning run and keeps another run's prompt; component renders no dialog / no resume action after reduce(`user_input_required`) + reduce(`run_cancel_requested`); a prompt whose run is `cancel_requested` renders disabled 提交修正/跳过并继续.
- **Fixture note**: `taskWithPrompt` helper now seeds the run projection (status `awaiting_user_input`) — the realistic reducer-produced state; without it the new awaiting guard disabled everything in the pre-existing dialog tests.

### F4 (C5 Important) — `user_input_resumed` forces running before identity check
- **Files**: `frontend/src/runtime/reducers/hil.ts`, `frontend/src/test/runtime-reducer.test.ts`
- **Root cause**: every `user_input_resumed` upserted its run to `running` and switched `summary.status`/`active_run_id` before checking whether the resume matched the pending prompt; a late/mismatched resume regressed `cancel_requested → running` and could switch the active run.
- **Fix**: the running transition is applied only when the resume matches the pending prompt identity `{runId, requestId}` AND the run's status is `awaiting_user_input`; otherwise the event is ignored (cursor still advances via `reduceRuntimeEvent`).
- **Tests**: stale resume (`run_a`/`request_old` vs pending `request_new`) leaves status `awaiting_user_input`, prompt, and active run unchanged; resume for a different run creates no phantom run; a matching resume still transitions to `running` and clears the prompt. Existing fixture auto-resume and e2e tests stay green.

### F5 (C8 Minor) — past/NaN deadline still actionable
- **Files**: `frontend/src/components/UserInputDialog.tsx`, `frontend/src/test/user-input-dialog.test.tsx`, `frontend/src/test/hil-data-correction-e2e.test.tsx`
- **Root cause**: `expires_at` was presentation-only; a past or invalid deadline rendered “需在 … 前答复” with both actions enabled.
- **Fix**: parse the deadline (`new Date(expiresAt).getTime()`); when invalid or `<= Date.now()` render an expired state (“该请求已超时，将记录到 corrections_todo.csv 并继续”), disable all four action buttons, and gate `submit()`. No auto-submit — the durable resume/synthetic event closes the dialog.
- **Tests** (fake timers, `setSystemTime`): deadline one second in the past → “已超时” visible, no “需在 … 前答复”, both actions disabled; future deadline → actions enabled (after typing correction text, since 提交修正 also requires non-empty text); invalid `"not-a-date"` → expired state.
- **Fixture updates (stale dates)**: the pre-existing “expiry hint” test used fixed `2026-07-14T00:05:00Z` (already past vs system clock 2026-08-07) — changed to `Date.now() + 60s`. Same for the HIL e2e `dataCorrectionRequired` fixture.

### F6 (C9 Minor) — header-only CSV treated as populated
- **Files**: `frontend/src/components/ResultsViewer.tsx`, `frontend/src/test/results-viewer.test.tsx`
- **Root cause**: `CsvPreview` emptiness checked only `headers.length`; `"sample_id,condition\n"` rendered a bordered table with zero rows.
- **Fix**: `rows.length === 0` now triggers the existing empty state; when headers exist a schema note is rendered (“仅含表头：…”) per the review's optional allowance.
- **Test**: artifact text `"sample_id,condition\n"` → preview shows empty-state title “无数据”, `queryByRole("table")` is null.

### F7 (C10 Minor) — ArtifactSheet drops role
- **Files**: `frontend/src/components/ArtifactSheet.tsx`, `frontend/src/test/artifact-fab.test.tsx`
- **Root cause**: `fileType(artifact.name)` without `artifact.role`; audit/schema/provenance artifacts with unknown filenames got generic CSV/JSON labels.
- **Fix**: `fileType(artifact.name, artifact.role)` (mirrors ResultsViewer's `ArtifactCard`).
- **Test**: artifact `rejections-v2.csv` with `role: "audit_report"` renders “审计报告 · 128 B”, not “CSV · 128 B”.

## Notes / residual risks

- F2's `shouldSubscribe` reconcile runs after every applied envelope in the transport; it is a cheap store read consistent with the existing `getLastSequence`/`applyEvent` coupling. Only production wiring (useAgentStream) enables it; unit-level transports without the option keep legacy behavior.
- The continueTask re-subscribe is a necessary counterpart of F2 (documented in-code). The summary-hydrated continue path intentionally re-subscribes from 0 (addAcceptedTask resets summary-hydrated tasks to `lastSequence: 0` so full replay is requested — pre-existing semantics, unchanged).
- C2 (sequence-gap detection), C6 (ChatPanel RunSummary rendering), C7 (NO_DATA artifact ownership) were NOT part of this wave; they remain open for the next waves.
