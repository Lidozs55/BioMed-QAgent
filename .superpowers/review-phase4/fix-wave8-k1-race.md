# Fix Wave 8 (Final MUST-FIX) — K1 residual: timeout straggler race on the V2 build lock

Branch: `fix/phase4-review-bugs` · Base: wave 7 merged HEAD (`75511d8`)
Worktree: isolated, detached at base
Commit: `07cc281` — `fix(phase4): review wave 8 — await straggler V2 workers before lock release (TDD)`

One fix, TDD (red test → fix → green). Backend only; frontend untouched.

## Verification summary (exact outputs)

| Gate | Command | Result |
|---|---|---|
| Backend full suite | `python -m pytest -q` | **2392 passed, 2 skipped, 28 deselected** (baseline 2390 → +2 new tests) |
| Backend lint | `ruff check app/ tests/ launcher.py` | All checks passed |
| Backend import | `python -c "import app.main"` | OK |
| Frontend | untouched | `git status` shows no frontend files modified |

---

## The race (round-3 verdict, K1 residual)

In `backend/app/datasets/runtime/executor.py`, `asyncio.timeout` cancels only
the await — the `asyncio.to_thread` worker
(parse/canonicalize/integrate in `expression_runner.py`) keeps running. The
executor then finalizes the failure and releases the build lock
(`run()`'s `finally`). A same-`build_id` retry acquires the lock while the
old thread is still writing the SAME deterministic shared paths
(`merged/primary.csv` etc.) — the retry can validate/publish a file the late
thread later overwrites. Cooperative cancellation (wave 7) is covered; the
TIMEOUT path was not.

## The fix (bounded, correct — wait for stragglers before releasing ownership)

**Runner** (`backend/app/datasets/build/expression_runner.py`):
- The three `asyncio.to_thread(...)` call sites (parse/canonicalize/integrate)
  now go through a tracked `_offload(...)` helper (default executor, same
  offload semantics).
- **Key subtlety discovered while implementing** (this is the non-obvious
  part): `BaseEventLoop.run_in_executor` already wraps the submitted
  concurrent future with `asyncio.wrap_future` and returns the *destination*
  asyncio future. When `asyncio.timeout` cancels the await, `_chain_future`'s
  `_call_check_cancel` **cancels that wrapped future** — so `future.done()`
  becomes `True` while the thread is still running. Tracking "not done" on
  the wrapped future would therefore report *no straggler* exactly when one
  exists (my first implementation failed the RED test for precisely this
  reason).
- Fix: thread completion is tracked by a separate raw
  `concurrent.futures.Future` created per worker and set from inside the
  worker's `finally` (with a `not done()` guard so a late thread never raises
  `InvalidStateError` after the grace path cancelled it). That completion
  future is never cancelled by the timeout, so `in_flight_workers()` reports
  a straggler exactly while its thread may still be writing. The set is
  guarded by a lock (callbacks run in worker threads) and pruned by a done
  callback.
- `in_flight_workers()` returns the not-done completion futures.

**Executor** (`backend/app/datasets/runtime/executor.py`):
- New `straggler_grace: float = 10.0` constructor parameter (fixed short cap;
  a straggler is work already in progress — the operation timeout already
  bounded the work itself).
- `run()` awaits `_await_straggler_workers()` in **all three** exception
  paths (`BuildCancelledError`, `BuildOperationTimeoutError`, generic
  failure) **before** finalizing the outcome — the build lock is released
  only in `finally`, after the stragglers are accounted for. The wait defers
  only lock release, never the outcome: the timeout still aborts the
  operation (verified by the tests asserting `failed` + `TIMEOUT`).
- `_await_straggler_workers()` gathers the in-flight worker futures (via
  fresh `asyncio.wrap_future`, `return_exceptions=True`) bounded by
  `straggler_grace`. If a straggler still does not finish within the grace:
  `_mark_unfinished_worker()` writes `state/<build_id>/.worker_unfinished`
  (JSON: build_id, operation_id, written_at) and a warning is logged.
- `_mark_unfinished_worker` / `_warn_unfinished_worker`: the marker is
  honored by the next run of the same build (log + clear). The retry cannot
  reuse the unstable workspace by construction: the unfinished operation's
  attempt is FAILED (never SUCCEEDED, so `find_reusable` never matches it)
  and the digest closure re-executes it and everything downstream, rewriting
  the same deterministic paths.

## Tests (deterministic — a controllable worker, no fixed sleeps)

Both tests monkeypatch module `integrate` with a wrapper that signals a
`threading.Event` then blocks on a second event the test controls, then calls
the real integrate. `operation_timeout=0.5` (fixture parse/canonicalize are
~1 ms — >100x margin to reach integrate), no `time.sleep` anywhere.

1. `test_timed_out_integrate_waits_for_straggler_before_lock_release` — the
   round-3 directive's (a)/(b)/(c):
   - (a) RED pre-fix: after the timeout fires while the worker is mid-write,
     `wait_for(shield(run_task), 1.0)` does NOT raise — the executor
     returned without waiting (the race). GREEN post-fix: `run_task` stays
     pending (`TimeoutError`) until the worker is released.
   - (b) after `release_worker.set()`, the executor returns `failed` with
     `ErrorCode.TIMEOUT`, `retryable=True`, message naming `integrate`; the
     integrate attempt is recorded FAILED (clean checkpoint — no SUCCEEDED
     attempt for the retry to reuse).
   - (c) a same-`build_id` retry with new inputs completes and the union of
     all published `expression_value`s is exactly `{9,10,11,12}` — attempt
     A's late writes (fixture values 1.5/2/3/4.25) never leaked into any
     publication. The retry completing also proves the lock was released.
2. `test_timed_out_worker_beyond_grace_marks_state_dir_and_retry_proceeds` —
   the bounded/grace branch: with `straggler_grace=0.05` the executor
   returns the timed-out failure WITHOUT waiting for the still-blocked
   worker, `state/<build_id>/.worker_unfinished` exists with
   `operation_id == "integrate"`, and after releasing + awaiting the
   straggler thread, a same-`build_id` retry with new inputs completes and
   publishes only its own data.

Existing wave-7 cooperative-cancellation discard/retry test stays green
(unchanged), as do the K2 NO_DATA tests and the whole suite.

## Concerns / notes

1. **`asyncio.timeout` cancels the wrapped future, not the thread** — the
   tracking must use a thread-completion signal, never the awaitable's
   `done()` state. Documented in `_offload`'s docstring; this is the trap
   that makes the naive "track the to_thread task" approach wrong on 3.12.
2. **Grace-expiry residual is inherent**: a straggler that outlives the
   grace keeps running (threads cannot be killed); the marker makes the
   instability durable and observable, and the digest closure makes the
   retry re-execute the failed operation and its subtree, but a late write
   after the retry rewrote the same path is only prevented when the worker
   finishes within the grace (the common case — the operation already ran
   for up to `operation_timeout`). A retry after a grace-expired timeout is
   tested to publish only its own data once the straggler is known dead.
3. **External `asyncio.CancelledError` of the executor task** (not the
   cooperative token, not the operation timeout) still propagates without a
   straggler wait — out of the directive's scope (the tool-level cancellation
   channel is the cooperative token; the timeout path is this fix).
4. **Marker placement**: `.worker_unfinished` lives in the per-build state
   dir, so it cannot collide with the append-only attempt log or the
   checkpoint files; `validate_attempt_log_prefix` reads only
   `operation_attempts.jsonl` and is unaffected.
