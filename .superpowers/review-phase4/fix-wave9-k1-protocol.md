# Fix Wave 9 (Final K1 Closure) — worker-unfinished marker as a real exclusion + race-safe completion signal

Branch: `fix/phase4-review-bugs` · Base: wave 8 merged HEAD (`1170072`)
Commit: `bb05196` — `fix(phase4): review wave 9 — worker-unfinished marker as retry exclusion, race-safe completion signal (TDD)`

TDD (red test → fix → green). Backend only; frontend untouched.

## Verification summary (exact outputs)

| Gate | Command | Result |
|---|---|---|
| Backend full suite | `python -m pytest -q` | **2397 passed, 2 skipped, 28 deselected** (baseline 2392 → +5 new tests) |
| Backend lint | `ruff check app/ tests/ launcher.py` | All checks passed |
| Backend import | `python -c "import app.main"` | OK |
| Frontend | untouched | `git status` shows only backend files modified |

---

## The residual (round-4 verdict)

1. Wave 8's `.worker_unfinished` marker was **observational only** — the retry logged it,
   deleted it, and proceeded without consulting it. A grace-expired straggler thread could
   therefore still be writing `merged/primary.csv` etc. while a same-`build_id` retry ran
   (the original K1 race, window re-opened by grace expiry).
2. The completion signal `if not completion.done(): completion.set_result(None)`
   (`expression_runner.py`) is a check-then-act race: a cancel landing between `done()` and
   `set_result()` raises `concurrent.futures.InvalidStateError` in the worker's `finally`.

## The fix — a cooperative marker protocol (in-process, threads share the filesystem)

### 1. Marker semantics (`expression_runner.py`, `executor.py`)

- The marker is still written at grace expiry in the build's state dir
  (`_mark_unfinished_worker`, unchanged placement/payload).
- The **straggler's `finally` now removes the marker** when the worker thread truly finishes
  (best-effort, `OSError` suppressed). The executor registers the marker path on the runner
  at run start via a duck-typed accessor (`set_worker_marker_path`, same style as the
  existing `in_flight_workers` probe). Threads share the filesystem, so the straggler's
  finally and the retry's poll communicate through the marker file.

### 2. Retry exclusion (`executor.py::_exclude_unstable_workspace`)

Runs BEFORE any operation of a same-`build_id` run executes (after state load/recovery,
inside the build lock):

- **(a) stale by TTL** (`unstable_marker_ttl`, default 60s): worker threads die with the
  process, so any marker surviving a restart is stale by definition — remove it, proceed.
  (mtime-based; test sets mtime deterministically via `os.utime` — no sleeps.)
- **(b) fresh marker**: poll every `unstable_poll_interval` (default 50ms) until the marker
  disappears (the straggler's `finally` removed it), bounded by `unstable_poll_cap`
  (default 5s).
- **(c) cap expired, marker still present**: return a **RETRYABLE conflict outcome**
  (failed + `ErrorCode.TIMEOUT` + `retryable=True` + message naming the unstable state).
  The tool's generic failed+retryable envelope maps it to
  `{"status": "error", "retryable": true, ...}` (verified by a tool-level test). The marker
  is left in place so the next retry re-checks.

### 3. Race-safe signaling (`expression_runner.py::_complete_worker_future`)

The worker's finally now calls a module-level helper that sets the completion future with
`contextlib.suppress(concurrent.futures.InvalidStateError)`. `set_result` is the single
authoritative state transition; a future that was cancelled between the check and the call
simply raises and is suppressed — the worker's finally can never raise. (The wave-8
`done()` guard is subsumed; suppress is race-free by construction.)

### 4. Kept from wave 7/8

- Bounded straggler grace wait before finalize/unlock (`_await_straggler_workers`).
- Digest closure re-executing failed ops (FAILED attempt never reusable).
- Wave-7 discard-cancelled-outputs behavior and the TIMEOUT outcome shape.

## Tests (deterministic — controllable workers/events, no fixed sleeps)

All five new tests are in `tests/test_dataset_expression_runner.py` (executor level) and
`tests/test_dataset_build_tool.py` (tool-level mapping). The straggler tests reuse the
wave-8 pattern (blocking `integrate` gated on a test-controlled `threading.Event`).

1. `test_grace_expired_straggler_blocks_same_build_retry_until_worker_finishes` — (i) a
   grace-expired straggler is still alive (worker blocked, `worker_finished` event unset);
   a same-`build_id` retry started WHILE it is alive stays pending in its exclusion poll
   and never enters the plan (`retry_entered` event unset, `wait_for(shield(...))`
   TimeoutError), then after the worker is released the retry proceeds and publishes only
   its own data (`{9,10,11,12}`); the marker is gone afterwards. No overlap: the retry's
   publication reflects only its own inputs.
2. `test_stale_worker_unfinished_marker_ttl_unblocks_retry` — (ii) an old marker (mtime
   set 5s in the past via `os.utime` vs. TTL 0.5s) is treated as stale, removed, and the
   retry completes normally — no permanent block after a crash.
3. `test_worker_unfinished_marker_persists_past_poll_cap_returns_retryable_conflict` —
   (iii) executor-level: a marker that persists beyond the poll cap (0.3s, 10ms interval)
   returns `failed` + `retryable=True` + message containing "unstable"; no operation runs;
   the marker stays for the next retry.
4. `test_worker_completion_signal_race_safe_against_interleaved_cancel` — (iv) constructs
   the cancel-between-done-and-set window directly on a raw future (freezes `done()` at
   "not done", then cancels before `set_result`): `_complete_worker_future` must not raise
   and the future stays cancelled. This is RED pre-fix (InvalidStateError) and GREEN
   post-fix.
5. `test_tool_returns_retryable_error_on_unstable_workspace` — (iii) tool-level mapping:
   with a fresh marker in `datasets_build/state/<build_id>/`, `execute_dataset_build`
   returns `{"status": "error", "retryable": true}` with "unstable" in the message (poll
   params injected via a scoped `__init__` monkeypatch for speed); the marker persists.

## Concerns / notes

1. **`in_flight_workers()` reports nothing after grace expiry** — the grace timeout
   cancels the wrapped futures, which cancels the raw completion futures, and a cancelled
   future is `done()`. This is fine because wave 9 makes the *marker* the exclusion, not
   `in_flight_workers()`; the straggler's `finally` (which removes the marker) runs on the
   real thread-completion path regardless of the completion future's cancelled state. My
   first test draft asserted liveness via `in_flight_workers()` and failed for exactly this
   reason — replaced with the deterministic `worker_finished` event + marker presence.
2. **TTL semantics are the directive's trade-off**: a fresh marker is polled up to the cap,
   then the retry fails retryable (never a silent entry into a genuinely unstable
   workspace). A stale marker (older than the TTL) is removed on the assumption that worker
   threads cannot outlive the process — the crash/restart case.
3. **Marker cleanup is per-worker best-effort**: any finishing worker removes the marker
   (idempotent `unlink(missing_ok=True)`); at worst the marker disappears marginally before
   the last straggler's `finally` completes, but that straggler's file writes finished
   before its `finally`, so the exclusion remains sound. Runners without the duck-typed
   accessor never clean a marker — the TTL path still unblocks retries after a crash.
4. **Completion signal simplification**: the wave-8 `done()` guard plus a `suppress`
   wrapper would also be correct, but dropping the guard and relying solely on
   `suppress(InvalidStateError)` is race-free by construction and simpler — `set_result` is
   the single authoritative state transition.
5. **External `asyncio.CancelledError` of the executor task** remains out of scope (the
   tool-level cancellation channel is the cooperative token; the timeout path was wave 8).
