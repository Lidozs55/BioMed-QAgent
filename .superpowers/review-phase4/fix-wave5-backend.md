# Fix Wave 5 (Backend) — Phase 4 Final-Review MUST-FIX Items

Branch: `fix/phase4-review-bugs` · Base: current branch HEAD (includes waves 1/3)
Worktree: `/tmp/pi-agent-2ae11b6a-c3dc-448-b8cd9a00` (this session)

6 fixes, all TDD (red test → fix → green). Backend only — no frontend files
touched. No redesign beyond the directives.

## Verification summary (exact outputs)

- Full backend suite: `python -m pytest -q` → **2388 passed, 2 skipped, 28
  deselected** (baseline 2377 passed; +11 new tests from this wave, all green).
- `ruff check app/ tests/ launcher.py` → **All checks passed**.
- `python -c "import app.main"` → OK.
- Startup smoke: `python -m uvicorn app.main:app` boots, `/api/v1/health`
  returns `{"status":"ok",...}`.
- Focused per-fix files (298 tests: dataset build tool + expression runner +
  adapters + runtime + invariants + chain + manager + repository + state
  reducers + index) → all green.

---

## H1 = D2 — V2 build not cancellation-responsive mid-operation (Important)

Files: `app/datasets/build/expression_runner.py`,
`tests/test_dataset_expression_runner.py`

- **Root cause**: `_parse`/`_canonicalize`/`_integrate` ran full-file sync
  work directly in the async handlers; the executor's cancellation checks only
  run between operations, so during a long operation the event loop is blocked
  — a cancel request cannot even be processed, and the build can publish after
  cancellation was requested.
- **Repro (test-first)**:
  `test_cancellation_during_blocking_integrate_is_observed_and_blocks_publication`
  — monkeypatches `expression_runner.integrate` with a wrapper that blocks
  `time.sleep(0.4)` in a worker signal, runs the executor in a task, waits for
  integrate to be in flight, then sets the token. RED pre-fix (the loop was
  blocked for the whole build; the token was set only after the build had
  already **published**, outcome `completed`) → GREEN (token observed at the
  operation boundary; outcome `cancelled` within the bounded `wait_for(2.0)`,
  no version dir).
- **Fix**: the three heavy synchronous calls are offloaded with
  `await asyncio.to_thread(...)` (parse/canonicalize/integrate); the existing
  operation-boundary cancellation checks (`_execute_operation` pre/post checks,
  `_run_plan` loop check, `_publish` defense-in-depth check) are unchanged, so
  cancellation still yields a cancelled `BuildRunOutcome` and never publishes.

## H2 = D1 — publication-time recheck missing (Important)

Files: `app/datasets/build/expression_runner.py`,
`app/pipeline/dataset_build_tool.py`, `tests/test_dataset_expression_runner.py`,
`tests/test_dataset_build_tool.py`

- **Root cause**: the `main_input_pending` gate is a point-in-time entry check;
  the broker sets pending later, and there was no recheck before the V2
  immutable rename — a correction that became pending mid-build could still
  publish a version from inputs under correction.
- **Repro (test-first)**:
  - Runner level: `test_publish_refuses_when_pending_check_flips_after_validation`
    — a `pending_check` callable flips True right after VALIDATE_PROFILE; the
    publish operation must refuse. RED pre-fix (constructor rejects
    `pending_check`; publish proceeded) → GREEN (outcome `failed` with the
    refusal prefix, no version dir, no stray `.tmp` staged dir).
  - Tool level: `test_execute_dataset_build_refuses_publication_when_correction_pending_mid_build`
    — a real broker's `request_input` is started *between* validation and
    publish (the runner's `_validate_profile` is held on an event while the
    broker flips pending); the tool must return the refusal envelope with no
    version dir / no `publication.json`. RED pre-fix (`status == "ok"`,
    published) → GREEN.
- **Fix**: `ExpressionBuildRunner` accepts `pending_check: Callable[[], bool]`;
  `_publish` rechecks immediately before `staged_dir.rename(version_dir)` and
  raises `PublicationRefusedError` (`BuildError` subclass) when pending; the
  staged dir is cleaned up and nothing is promoted. The tool passes
  `pending_check=lambda: run_ctx.main_input_pending` and maps a failed outcome
  whose message starts with `_PUBLICATION_REFUSED_PREFIX` to the same
  agent-facing refusal text family as the entry gate (`retryable: False`).
  The entry gate is kept.

## H3 = B5 — NO_DATA detection not structured/attempt-scoped (Important)

Files: `app/datasets/build/errors.py`, `app/datasets/build/adapters.py`,
`app/datasets/runtime/executor.py`, `app/pipeline/dataset_build_tool.py`,
`tests/test_dataset_build_tool.py`, `tests/test_dataset_expression_runner.py`

- **Root cause**: the first NO_DATA signal was a broad substring match on
  `"contains no data rows"` in the error text; stale zero-row manifests from
  an earlier attempt could drive the classification for a later genuine
  failure, and a mixed-source build (one empty + one usable) was classified
  NO_DATA with ALL bindings rejected.
- **Repro (test-first)**:
  - (a/i) `test_no_data_classification_is_scoped_to_current_attempt` — attempt
    A: a source that parses but yields zero valid rows → zero-row manifest +
    NO_DATA (naturally produced); attempt B: a genuine malformed-row parse
    failure on the same build_id must NOT be NO_DATA via the stale manifest;
    attempt C: real data succeeds. RED pre-fix (B was misclassified NO_DATA) →
    GREEN (B is a retryable error; C publishes).
  - (ii) `test_execute_dataset_build_mixed_empty_and_usable_sources_not_all_rejected`
    — empty GDC + usable Xena → not all-rejected; `partial_success` with
    `successful_sources=["binding_xena"]`, `rejected_sources=["binding_gdc"]`,
    `valid_row_count=0`, no publication. RED pre-fix (`no_data`,
    `rejected_sources=[gdc, xena]`, verified by probe) → GREEN.
  - (iii) header-only source → NO_DATA envelope (wave-3 G4 regression — the
    existing test stays green).
  - Structured signal: `test_failed_outcome_carries_structured_no_data_reason` —
    an empty source's failed outcome carries
    `details.reason_code == "no_primary_data"` and
    `details.failed_operation == "parse:binding_gdc"`. RED pre-fix (empty
    details) → GREEN.
- **Fix**:
  - (a) New `EmptySourceError(AdapterError)` with `reason_code =
    "no_primary_data"`; the three adapters raise it. The executor's
    `_finalize_failed` propagates `reason_code` and the in-flight
    `failed_operation` into `ErrorDetail.details` — the tool never
    substring-matches error text.
  - (b) The classifier `_classify_failed_outcome` only trusts a persisted
    manifest when THIS attempt wrote it (`failed_operation` is
    validate_profile/publish); a stale zero-row manifest from an earlier
    attempt can no longer classify a parse-stage failure as NO_DATA. The
    empty-source reason is attempt-scoped by construction.
  - (c) Mixed-source: only NO_DATA when every source is empty; if any source
    file has data rows (adapter-agnostic header probe, since the plan aborts
    before later bindings parse), a `partial_success` envelope surfaces the
    usable sources instead of marking all rejected. The normal retryable-error
    path is kept for genuine failures.

## H4 = A1 — terminalization failure swallowed (Important)

Files: `app/runtime/manager.py`, `tests/runtime/test_manager.py`

- **Root cause**: in `_handle_worker_failure`'s CANCEL_REQUESTED branch, the
  fallback `_append_status(RunCancelledPayload)` was wrapped in a
  try/`finally` that popped `_running` even when the append raised, and the
  outer except swallowed the exception — the run could be left CANCEL_REQUESTED
  nonterminal with no live ownership. Additionally, `_finalize_run`'s finally
  (and the `_dispatch_run` failure branches) popped `_running` before the
  worker-failure handler ever ran, so the handler alone could not retain
  ownership.
- **Repro (test-first)**:
  - `test_cancel_worker_failure_retries_terminal_append_before_releasing_ownership`
    — `_append_status` fails for RunCancelledPayload twice then succeeds (and
    the completion-cleanup RunFailedPayload append is also failed, mirroring
    the wave-3 repro, so the worker-failure path is the terminalizer). RED
    pre-fix (run left CANCEL_REQUESTED with ownership dropped / no retry) →
    GREEN: exactly one terminal `RunCancelledPayload`, 3 append attempts,
    `_running` released.
  - `test_cancel_worker_failure_keeps_ownership_when_terminal_append_always_fails`
    — every append fails. RED pre-fix (`_running` was dropped) → GREEN: the run
    stays owned in `_running` with durable status CANCEL_REQUESTED, and a fresh
    manager on the same repository recovers it to a terminal
    `RunInterruptedPayload` (startup recovery's CANCEL_REQUESTED handling is
    the documented safety net).
- **Fix**:
  - `_handle_worker_failure`: bounded retry of the fallback append (up to
    `_TERMINAL_APPEND_MAX_ATTEMPTS = 3` with `_TERMINAL_APPEND_RETRY_DELAY =
    0.05`s between); `_running` is popped only after the append succeeds; if
    all retries fail, a critical log records it and `_running` is left in
    place for startup recovery.
  - `_finalize_run` / `_dispatch_run` failure branches now retain live
    ownership (`retain_cancellation = True`) when the terminal failure event
    cannot be persisted (`_persist_failure_or_retain_ownership` helper), so the
    run is never silently dropped nonterminal before the worker-failure path
    gets a chance to reconcile it.

## H5 = B8 — naive/aware datetime TypeError (Important)

Files: `app/datasets/build/expression_runner.py`,
`tests/test_dataset_expression_runner.py`

- **Root cause**: `_find_latest_publication` compared
  `datetime.fromisoformat(record["published_at"])` values directly; older
  records may carry naive ISO strings, and `max()` over a mix of naive and
  timezone-aware datetimes raises `TypeError`.
- **Repro (test-first)**:
  `test_find_latest_publication_normalizes_naive_timestamps` — one naive
  (`2026-08-08T00:00:00`) and one aware (`2026-08-08T01:00:00+00:00`) record.
  RED pre-fix (`TypeError: can't compare offset-naive and offset-aware
  datetimes`) → GREEN: deterministic result, the chronologically-later aware
  record wins.
- **Fix**: parsed naive datetimes are normalized with
  `dt.replace(tzinfo=UTC)` (module-level `UTC` import) before comparison.

## H6 = A8 — dedup state not reconstructed for pre-fix snapshots + conflicting duplicates accepted (Minor)

Files: `app/domain/contracts/runtime.py`, `app/runtime/state.py`,
`app/runtime/repository.py`, `app/runtime/index.py`,
`tests/runtime/test_repository.py`, `tests/runtime/test_state_reducer.py`

- **Root cause**: `_load_snapshot_sync` gated historical reconstruction of
  `_artifact_ids_by_run` on the ABSENCE of `artifact_count` — a pre-fix
  snapshot that already has `artifact_count` never gets its dedup state, so
  replaying an old duplicate after upgrade can over-count; and the reducer
  accepted conflicting same-ID artifacts (different digest/path) without
  comparison.
- **Repro (test-first)**:
  - `test_repository_reconstructs_dedup_state_for_pre_fix_snapshot` — a
    pre-fix snapshot JSON (`artifact_count=2`, no `_artifact_ids_by_run` key)
    with two artifact events in the journal; load then replay a duplicate
    artifact_produced. RED pre-fix (count inflated to 3) → GREEN (count stays
    2; reconstructed `_artifact_ids_by_run` asserted).
  - `test_reducer_rejects_conflicting_duplicate_artifact_event` — same
    artifact_id with a different sha256 or relative_path at a later sequence.
    RED pre-fix (`DID NOT RAISE`) → GREEN (`ValueError: conflicting duplicate
    artifact event`), while an identical replay stays a no-op.
- **Fix**:
  - (a) `_load_snapshot_sync` (and the index rebuild) now rebuild the dedup
    identity set AND the first-occurrence fingerprints from the
    `artifact_produced` events whenever the stored private keys are missing
    (new `artifact_identities_from_events` helper in `state.py`) — independent
    of whether `artifact_count` is present — and persists the rebuilt state.
  - (b) `TaskSnapshot` gains a private
    `_artifact_fingerprints_by_run: dict[str, dict[str, tuple[str, str]]]`
    (sha256, relative_path of the first occurrence); the reducer rejects a
    duplicate artifact event whose digest/path conflicts, mirroring the
    publication duplicate handling. Persistence (`_snapshot_with_internal`) and
    both load sites (repository + index) carry the new key; the repository
    test helper `_load_persisted_snapshot` pops it before strict validation.

---

## Concerns / notes

1. **H1 mechanism**: the test demonstrates the loop-responsiveness property
   (a cancel request set while integrate is blocked is observed at the next
   operation boundary, yielding `cancelled` and no publication, within a
   bounded time). `asyncio.to_thread` also makes `_run_with_timeout`'s
   operation timeout actually enforceable during long sync work (previously the
   blocked loop deferred it) — a secondary benefit, not asserted.
2. **H2 placement**: the recheck sits immediately before the immutable rename,
   after the release-invariants gate and staging copies; the refusal cleans up
   the staged directory and never creates a version dir. The same refusal text
   family is used at entry and at publish time.
3. **H3 mixed-source semantics**: a mixed build where an empty source aborts
   the plan is surfaced as `partial_success` (build ran, one source usable, one
   empty; nothing published, `valid_row_count=0`) rather than attempting a
   partial publication — the latter would require per-binding parse tolerance
   in the executor, which is beyond this directive. The "usable" determination
   for bindings whose parse never ran uses an adapter-agnostic header/data-row
   probe of the source files (the plan aborts at the first empty source).
4. **H4 recovery safety net verified**: `_recover` treats CANCEL_REQUESTED as
   recoverable and converts it to `run_interrupted` on restart — the always-fail
   test asserts that convergence explicitly with a fresh manager.
5. **H6 fingerprint fallback**: for snapshots where the identity set exists but
   fingerprints are missing (not produced by this or later versions), a
   duplicate is accepted without conflict comparison (degraded to the old
   behavior) — after this fix both keys are always written together, so the
   gap cannot recur.
