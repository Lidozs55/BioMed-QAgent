# Fix Wave 6 — Frontend (Phase 4 Bug Sweep, final-review MUST-FIX items)

Base: wave-4 merged HEAD (`272b2b1`) on `fix/phase4-review-bugs`.
Worktree: `/tmp/pi-agent-9a8a0a75-76f6-427-62ecbc4d` (detached HEAD at `272b2b1`).
Scope: frontend only (runtime transport/controller/contracts, UserInputDialog, App wiring, tests).
No backend files touched.
Method: TDD per fix — red vitest test, minimal fix, green. Full gates re-run at the end.

## Gate results (recorded)

| Gate | Command | Result |
|---|---|---|
| Full frontend suite | `cd frontend && pnpm test` | **42 files, 686 passed** (baseline 677 → +9 new tests) |
| Lint | `pnpm lint` (eslint . --max-warnings 0) | 0 errors, exit 0 |
| Build | `pnpm build` (tsc -b && vite build) | OK (only pre-existing chunk-size warning) |

## Fixes

### F1 (C3 residual) — selection hydration resubscribed terminal history tasks
- **Files**: `frontend/src/runtime/controller.ts`, `frontend/src/test/runtime-controller.test.ts`
- **Root cause**: live terminal events are reconciled by the transport's
  `shouldSubscribe` (wave 1), but `performSelectionHandoff` (selection-time
  hydration, controller.ts:240-260) called `transport.subscribe(...)`
  UNCONDITIONALLY. Selecting a terminal history task therefore added a
  permanent desired subscription that nothing ever reconciled — the exact
  leak wave 1 fixed for live events, re-introduced by the hydration path.
- **Fix**: gate the selection-time subscribe with the same check the transport
  uses — `useAgentStore.getState().activeItems.includes(taskId)` — evaluated
  AFTER `hydrateTaskSnapshot` (hydration is authoritative: it recomputes
  `activeItems` from the snapshot's status via `updateClassification`, and
  clears any `sequenceGap`). Terminal selections hydrate fully but keep no
  subscription; active/awaiting selections subscribe as before. The catch-path
  background-subscription restoration and `continueTask`'s explicit
  resubscribe are untouched (the latter is correct: a continued task has a
  fresh active run).
- **Tests (red → green)**:
  - NEW: select a terminal history task → hydrated (`hydration: "snapshot"`,
    watermark) but `subscribe` NOT called and task not in `activeItems`.
  - NEW: select an active (`running`) history task → `subscribe(taskId, 6)`.
  - NEW: select an `awaiting_user_input` history task → still subscribes.
  - Regression guard (kept): `continueTask` on a terminal task still
    re-subscribes at its watermark ("re-subscribes a terminal task when it is
    continued").
  - Intent-preserving fixture updates: three selection tests that used
    completed snapshots now pass `"running"` (their purpose is ordering /
    dedup, not terminal semantics); the two summary-replay selection tests
    that asserted a terminal subscribe now assert NO subscribe.

### F2 (C2 residual) — permanent gap froze without a fallback
- **Files**: `frontend/src/runtime/transport.ts`, `frontend/src/runtime/controller.ts`,
  `frontend/src/hooks/useAgentStream.ts`, `frontend/src/App.tsx`,
  `frontend/src/test/agent-stream.test.ts`, `frontend/src/test/runtime-controller.test.ts`
- **Root cause**: gap recovery was bounded per cursor (wave 4) but the guard
  was never cleared on socket replacement / natural reconnect (contradicting
  the wave-4 report), AND a permanently rejected frame (schema drift /
  incompatible event) left the cursor stuck forever with no escape hatch —
  later valid events kept being rejected as gaps and nothing rebuilt the store.
- **Fix**:
  - **(a) guard reset on natural reconnect**: the `onclose` handler now clears
    the per-task gap-recovery guard (`gapRecoveryCursors` /
    `gapRecoveryFailures` / `gapFallbackFired`) so a fresh connection re-arms
    recovery. Recovery-driven socket replacements null the handlers before
    closing, so they never hit this branch (no recovery loop). `disconnect()`
    also clears the guard. The store-level `sequenceGap` marker is untouched —
    it is the reducer's truthful record of a real gap and is cleared by the
    next contiguous event or hydration.
  - **(b) bounded snapshot fallback**: new `handleSequenceGap` counts
    consecutive gap rejections at the same cursor (the replay still cannot
    deliver the missing frame). After `GAP_RECOVERY_FAILURE_LIMIT = 2`, the
    transport fires the new `onPermanentGap(taskId)` option (once per cursor
    position via `gapFallbackFired`). Production wiring: `useAgentStream`
    accepts the callback; `App.tsx` forwards it to a new
    `RuntimeController.hydrateTaskFromGap(taskId)` — `fetchTask` →
    `hydrateTaskSnapshot` (authoritative: clears `sequenceGap`, advances the
    cursor to the snapshot watermark) → `recoverSubscription(taskId, watermark)`
    so the undeliverable frame is skipped and later valid events apply.
    Bounded: at most one socket-replacement recovery per cursor + at most one
    fallback per cursor; a permanently stuck gap degrades to defensive-only
    until the next natural reconnect.
- **Tests (red → green)**:
  - (i) socket-replacement / natural-reconnect guard reset: gap at cursor 4 →
    one recovery; same-cursor gap is NOT re-armed; a natural close then a
    fresh connection re-arms recovery (new socket created) and the replayed
    missing frame + tail apply (cursor 6, `sequenceGap` null).
  - (ii) permanent gap → snapshot fallback: gap at cursor 4 → recovery; two
    failed recoveries → `onPermanentGap` fires once (not after the first);
    store hydrated to watermark 8, `sequenceGap` null; queued resume replaces
    the socket and subscribes after 8; a later contiguous event (9) applies.
  - NEW controller test: `hydrateTaskFromGap` fetches the snapshot, hydrates
    (`hydration: "snapshot"`, `lastSequence` = watermark, `sequenceGap` null)
    and calls `recoverSubscription(taskId, watermark)`.

### F3 (C8 residual) — expiry not re-evaluated while the dialog is mounted
- **Files**: `frontend/src/components/UserInputDialog.tsx`,
  `frontend/src/test/user-input-dialog.test.tsx`
- **Root cause**: `expired` was computed at render only; a mounted dialog that
  crossed its deadline kept `expired === false` (no timer/state update), so
  actions stayed enabled after expiry.
- **Fix**: while a deadline exists (`pending.expiresAt !== null`), a 1-second
  `setInterval` re-renders the dialog (`setExpiryTick`), so `Date.now()`
  recomputes within one second of the deadline and the expired state renders
  with all four actions disabled. The effect is keyed on `pending` (re-runs on
  prompt replacement) and cleans up on unmount — no project-internal interval
  precedent existed, so this is the first minimal instance.
- **Test (red → green, fake timers)**: mount with `expiresAt = now + 2s` →
  actions enabled, no expired text; advance 3s → "已超时" visible, both
  actions disabled. Existing F5 expiry tests (past/invalid deadline, future
  deadline) stay green.

### F4 (#11) — backend operation lifecycle events absent from the frontend allowlist
- **Files**: `frontend/src/runtime/transport.ts`, `frontend/src/runtime/contracts.ts`,
  `frontend/src/test/agent-stream.test.ts`, `frontend/src/test/runtime-reducer.test.ts`
- **Backend check**: the backend defines and the V2 dataset executor DOES emit
  `operation_started` / `operation_completed` / `operation_failed`
  (`backend/app/datasets/runtime/executor.py:342/372/410/457/603/639`;
  `operation_progress` is defined in the contract but not yet emitted). The
  production tool does not wire an `event_sink` today, so they are not yet on
  the live WS path — the fix is defensive but clearly intended-live (Design
  §15.1) and would otherwise be the C1/C2 class of permanent gap the moment
  the sink is bridged.
- **Fix**: add `operation_started` / `operation_progress` / `operation_completed`
  / `operation_failed` to `EVENT_TYPES`. The reducer already passes
  unknown-but-valid types through via its `default` case (cursor advances,
  `sequenceGap` cleared, `summary.latest_sequence`/`updated_at` updated, no
  projection change) — documented in a comment. The frontend `EventPayload`
  union now mirrors the backend payload contracts for the four types (same
  gap class as wave-1 C1 where a backend type was missing client-side).
- **Tests (red → green)**:
  - Transport: deliver all four operation envelopes contiguously → cursor
    advances to 4, no crash, no gap marker, no projection change (messages /
    runs / activities / summary status identical).
  - Reducer: same pass-through asserted directly at the reducer boundary.

## Notes / residual risks

- The snapshot fallback depends on `GET /tasks/{id}` returning a snapshot
  whose `latest_sequence` is at or after the stuck cursor; if the fetch fails,
  the fallback is fire-and-forget with an internal `.catch(() => undefined)`
  and the task stays defensive-only until the next natural reconnect (bounded,
  no loop).
- The reducer-level pass-through for operation events is the shared `default`
  case, not a dedicated branch — intentional (no state to project), consistent
  with how unknown-but-valid events behave.
- No backend files were modified.
