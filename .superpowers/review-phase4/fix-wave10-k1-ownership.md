# Fix Wave 10 (Final K1 Ownership Closure) — process-aware worker-unfinished ownership + orphan-race closure

Branch: `fix/phase4-review-bugs` · Base: wave 9 merged HEAD (`b330772`)
Commit: (see git log) — `fix(phase4): review wave 10 — process-aware worker-unfinished ownership, orphan-race closure (TDD)`

TDD (red test → fix → green). Backend only; frontend untouched.

## Verification summary (exact outputs)

| Gate | Command | Result |
|---|---|---|
| Backend full suite | `python -m pytest -q` | **2402 passed, 2 skipped, 28 deselected** (baseline 2397 → +5 new tests) |
| Backend lint | `ruff check app/ tests/ launcher.py` | All checks passed |
| Backend import | `python -c "import app.main"` | OK |
| Frontend | untouched | `git status` shows only backend files modified |

---

## The residuals (round-5 verdict)

1. **mtime-based stale deletion does not establish process death.** A live
   in-process straggler — same process, worker exceeded the grace — could be
   misclassified stale after the 60s TTL, and a same-`build_id` retry would
   enter the workspace while the worker still writes `merged/primary.csv`
   etc. (the original K1 race, re-opened by TTL expiry).
2. **Orphan-marker race.** The worker's `finally` unlinks the marker just
   before the executor writes it → a fresh orphan marker with no live worker
   blocks retries up to the poll cap.

## The fix — a process-aware ownership protocol

All in `backend/app/datasets/runtime/executor.py` +
`backend/app/datasets/build/expression_runner.py`.

### 1. Process identity (`executor.py`)

- Module-level `_PROCESS_NONCE = uuid.uuid4().hex`, generated ONCE per
  process (module import).
- The `.worker_unfinished` marker payload is now
  `{"build_id", "operation_id", "pid": os.getpid(), "process_nonce",
  "worker_id", "ts"}`.

### 2. Write the marker only when the straggler is genuinely still running

`_mark_unfinished_worker` (called from the grace-expiry path):

- Re-probes `_in_flight_worker_futures()` first: if nothing is pending, the
  straggler resolved during the grace wait — its `finally` already ran (and
  cleaned any marker that existed) — so NO marker is written (closes the
  orphan race: the worker's finally ran before any marker existed).
- The write is atomic (temp file `+` rename in the same dir).
- **Write-then-verify**: after the atomic rename, the named worker's future
  is re-checked; if it resolved between the probe and the write (its finally
  unlinked before the marker existed), the marker is dropped immediately.
  This closes the residual check-then-act window on the write itself.

### 3. Worker-side read-compare-unlink (`expression_runner.py`)

- Each `_offload` creates a `_WorkerCompletionFuture` tagged with a unique
  `worker_id` (`w{id(completion):x}`). The executor records that id in the
  marker; the worker's `finally` reads the same object, so both sides agree
  by construction.
- The worker's `finally` now calls `_cleanup_worker_marker(own_worker_id)`:
  read the marker, unlink ONLY when `marker.worker_id == own_worker_id`;
  absent/corrupt/other-worker markers are left untouched
  (`OSError`/`JSONDecodeError` suppressed). A marker for a still-live
  straggler must survive until THAT straggler's finally runs.

### 4. Retry-side stale check is ownership-based, not mtime-based

`_exclude_unstable_workspace` (before any operation of a same-`build_id`
run):

- **(a) same pid + same process nonce** → the straggler is LIVE in this
  process → poll every `unstable_poll_interval` until the worker's finally
  removes the marker, bounded by `unstable_poll_cap`; if the cap expires →
  RETRYABLE conflict outcome (`failed` + `ErrorCode.TIMEOUT` +
  `retryable=True` + message naming the unstable state). The marker is NEVER
  auto-deleted for a same-process marker — only the owning worker's finally
  may remove it.
- **(b) different pid OR different nonce** → the owning process is gone; its
  worker threads died with it → remove the marker and proceed (no permanent
  block after a crash).
- **(c) legacy wave-9 markers without `pid`/`process_nonce`** → the mtime TTL
  (`unstable_marker_ttl`) remains as a fallback: older than TTL → stale →
  removed → proceed; fresh → polled like any other (cap → conflict).

### 5. Discovered sub-fix: the grace wait must not corrupt the liveness signal

The wave-8/9 `_await_straggler_workers` awaited `asyncio.wrap_future(worker)`
under `asyncio.timeout(grace)`. A timed-out gather CANCELLES the (pending)
completion futures — a cancelled future reads as `done()` while the thread is
still writing, so `in_flight_workers()` reported nothing after grace expiry
(wave-9 concern #1, now confirmed). That would make the wave-10 re-probe see
"nothing pending" for a genuinely live straggler and never write the marker.
The wait now POLLS the worker completion futures (`asyncio.sleep` at
`_STRAGGLER_POLL_INTERVAL = 0.01` up to the grace deadline): a pending
completion future means exactly "thread still running", so the marker step
can distinguish a worker that resolved during the grace from one that
outlived it. Side benefit: `in_flight_workers()` stays accurate after grace
expiry.

### 6. Kept from wave 7/8/9

- Bounded straggler grace wait before finalize/unlock.
- Digest closure re-executing failed ops (FAILED attempt never reusable).
- Wave-7 discard-cancelled-outputs and the TIMEOUT outcome shape.
- Wave-9 race-safe completion signal (`_complete_worker_future`).

## Tests (deterministic — controllable workers/events, no fixed sleeps)

All in `tests/test_dataset_expression_runner.py` (executor/runner level).
Straggler tests reuse the wave-8 pattern (blocking `integrate` gated on a
test-controlled `threading.Event`).

1. `test_grace_expired_straggler_blocks_same_build_retry_until_worker_finishes`
   — (i) upgraded with marker-payload assertions: the executor-written marker
   carries `pid == os.getpid()`, `process_nonce == _PROCESS_NONCE`, and a
   non-empty `worker_id`. A same-`build_id` retry started while the straggler
   is alive stays in its exclusion poll and never enters the plan; after the
   worker is released (finally removes the marker) the retry proceeds and
   publishes only its own data (`{9,10,11,12}`).
2. `test_same_process_marker_persists_past_poll_cap_returns_retryable_conflict`
   — (ii) a same-process marker (current pid + nonce) that persists past the
   poll cap returns `failed` + `retryable=True` + "unstable" message and is
   NEVER auto-deleted.
3. `test_dead_process_marker_removed_and_retry_proceeds` — (iii) a marker with
   a DIFFERENT pid + nonce is removed and the retry completes — no permanent
   block after a crash.
4. `test_stale_worker_unfinished_marker_ttl_unblocks_retry` — (iv) legacy
   wave-9 schema marker (no pid/nonce), mtime beyond TTL → removed → retry
   completes (existing wave-9 test, now exercising the legacy fallback).
5. `test_worker_resolving_during_grace_does_not_write_orphan_marker` — (v)
   the orphan-race closure: the executor re-probe after the grace timeout
   finds the straggler's future resolved → no marker is written; a subsequent
   retry's `_exclude_unstable_workspace` returns `None` immediately.
6. `test_marker_dropped_when_worker_resolves_between_probe_and_write` — (v
   hardening) the write-then-verify: a worker that resolves between the probe
   and the atomic rename leaves no marker behind.
7. `test_worker_cleanup_leaves_other_workers_marker_untouched` — (vi) a
   worker's `finally` read-compares: another worker's marker is left
   untouched, its own marker is removed, corrupt/absent markers raise
   nothing.

Tool-level mapping (`tests/test_dataset_build_tool.py`) is unchanged: the
legacy-schema marker in
`test_tool_returns_retryable_error_on_unstable_workspace` now flows through
the legacy fallback (fresh → poll → retryable envelope) and still passes.

## Concerns / notes

1. **Single-straggler invariant**: the plan is sequential (`_run_plan` awaits
   each operation), so at most one worker is in flight when the grace wait
   runs, and the marker carries a single `worker_id`. A future parallel plan
   would need a worker-id LIST in the marker; the executor's write-then-verify
   re-probes all pending futures, so the marker still cannot outlive every
   worker.
2. **Foreign runners** (a runner with `in_flight_workers` but without the
   wave-9/10 marker cleanup): the executor writes `worker_id: null` for a
   future without the tag, and no worker would ever remove such a marker —
   the retry polls to the cap and returns a retryable conflict (never an
   entry into an unstable workspace). Only `ExpressionBuildRunner` is wired
   into the protocol, so this is theoretical; it degrades to the same
   exclusion semantics as wave 9's "runner cannot clean a marker" case.
3. **Same-process cap is a deliberate trade-off**: a genuinely hung thread in
   the current process blocks retries with retryable conflicts (never an
   auto-delete), matching the directive's "never enter the workspace, never
   auto-delete a same-process marker". Recovery requires the process to die
   (then the ownership check treats the marker as stale) or the worker to
   finish (its finally removes the marker).
4. **Grace wait granularity**: the poll-based wait adds up to one
   `_STRAGGLER_POLL_INTERVAL` (10 ms) of overshoot vs. the exact
   `asyncio.timeout`; irrelevant at the 10s default and bounded well inside
   test `wait_for` budgets.
5. **External `asyncio.CancelledError` of the executor task** remains out of
   scope (the tool-level cancellation channel is the cooperative token; the
   timeout path was wave 8).
