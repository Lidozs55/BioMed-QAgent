# Fix Wave 3 (Backend) — Phase 4 Review Bug Sweep

Branch: `fix/phase4-review-bugs` · Base: merged wave-1 HEAD (`ffc49e6`)
Worktree: `/tmp/pi-agent-ab679071-fa0e-49d-60e7592a`
Commit: (see `git log -1`)

6 fixes, all TDD (red test → fix → green). Backend only — no frontend files touched.
No redesign beyond the directives. One finding's mechanism was verified to differ
from the review description (G4/B5 — see concerns), but the fix matches the
directive's required observable outcome.

## Verification summary (exact outputs)

- Full backend suite: `python -m pytest -q` → **2377 passed, 2 skipped, 28
  deselected** (baseline 2365 passed; +12 new tests from this wave, all green).
- `ruff check app/ tests/ launcher.py` → **All checks passed**.
- `python -c "import app.main"` → OK.
- Focused per-fix files: `tests/runtime/test_manager.py` (107),
  `tests/agent_loop/` (234), dataset suite (expression runner + invariants +
  build tool + profiles + adapters + integrator + manifest + runtime +
  contracts + canonicalizer + compat gate + confidence + gene maps: 158) — all green.

---

## G1 = A1 (Important) — worker failure while CANCEL_REQUESTED strands the run

Files: `app/runtime/manager.py` (`_handle_worker_failure`),
`tests/runtime/test_manager.py`

- **Root cause / reachability**: `_handle_worker_failure` only appended
  `run_failed` for `RUNNING`/`FINALIZING` and deliberately kept `_running` for
  `CANCEL_REQUESTED`. The strand is reachable when the worker raises *while the
  run is CANCEL_REQUESTED* AND the failure path itself cannot persist its event:
  `_finalize_run` → abort fails → `_record_completion_cleanup_failure` →
  `_append_status(RunFailedPayload)` raises → the exception escapes to
  `_handle_worker_failure`, which emitted no terminal event and kept `_running`;
  the cancel waiter then raises `RuntimeError("completion abort failed")` before
  appending `run_cancelled`. Result: permanently nonterminal `CANCEL_REQUESTED`.
  (A plain executor raise while CANCEL_REQUESTED does NOT strand — the cancel
  waiter wins and appends `run_cancelled`; the strand requires the
  waiter/executor failure, exactly as the review described.)
- **Repro (test-first)**: converted the existing
  `test_abort_failure_blocks_cancelled_when_failure_event_cannot_persist` (which
  asserted the stranding behavior) into
  `test_cancel_worker_failure_terminalizes_cancellation_when_failure_cannot_persist`:
  cancel a run whose completion-abort raises while the `RunFailedPayload` append
  is monkeypatched to fail → RED pre-fix (run stayed `CANCEL_REQUESTED`, no
  `RunCancelledPayload`, `_running` retained) → GREEN post-fix.
- **Fix**: for `CANCEL_REQUESTED`, `_handle_worker_failure` now appends
  `RunCancelledPayload(reason=None, cancelled_at_stage=None)` (the codebase's
  live-cancellation terminal event; matches `_cancel_run` semantics) and clears
  live ownership in a `finally` (so even a second append failure cannot retain
  `_running`). The task lock serializes with the cancel waiter's phase-2 append:
  whichever wins, exactly one terminal event exists (the other sees `CANCELLED`
  and only pops `_running`). Subagent cleanup runs through `_append_status` as
  usual ("parent run cancelled").

## G2 = A5 (Minor) — child resume routed before parent-state validation

Files: `app/runtime/manager.py` (`resume_run`), `tests/runtime/test_manager.py`

- **Root cause**: `resume_run` called `SubagentInputBroker.try_resume` *before*
  loading/validating the parent task snapshot and run status, under no task
  lock. A matching child request could be resolved after the parent was
  terminal (cleanup race / late request), returning a successful snapshot and
  letting the child emit `subagent_input_resumed` after its owner was terminal.
- **Repro (test-first)**:
  `test_resume_run_rejects_child_request_after_parent_terminal` — a real child
  context (`RunContext` + `DurableSubagentEventSink` + broker) registers a
  pending input (its `request_id` extracted from the durable
  `subagent_input_required` event); a parent terminal snapshot is persisted
  while the request is still pending; `resume_run` with the real request_id →
  RED pre-fix (`DID NOT RAISE`, broker resolved) → GREEN post-fix
  (`RuntimeError "… is not awaiting user input"`, `waiter` still pending, no
  `subagent_input_resumed` event in the journal).
- **Fix**: `resume_run` now acquires the task lock first, loads the snapshot,
  rejects any `_TERMINAL_RUN_STATUSES` parent with the standard "not awaiting
  user input" conflict, and only then routes to the broker — while holding the
  same task lock that terminal cleanup (`_terminate_owned_subagents` →
  `broker.cancel_run`, invoked from `_append_status` under the lock) uses, so
  parent-terminal cleanup and broker removal are serialized.

## G3 = B3+B4 (Important) — V2 publication integrity

Files: `app/datasets/build/expression_runner.py` (`_publish`),
`app/datasets/build/invariants.py`, `tests/test_dataset_expression_runner.py`,
`tests/test_dataset_invariants.py`

- **B3 root cause**: `_publish` copied every manifest artifact to
  `staged_dir / src.name` (flattened basename), while
  `dataset_manifest.json` retains paths like `merged/primary.csv` → the
  published manifest referenced files that do not exist in the version dir.
- **B4 root cause**: `check_release_invariants` only read the first provenance
  artifact and compared the *number* of listed sources; `_publish` silently
  skipped missing artifacts (`if src.is_file()`). A file deleted/edited after
  validation could still be promoted with a stale manifest.
- **Repro tests (test-first)**:
  - (a) `test_published_version_preserves_manifest_relative_paths` — RED
    pre-fix (`merged/primary.csv` missing from the version dir) → GREEN.
  - (b) `test_publish_rejects_missing_manifest_artifact_after_validation` —
    a wrapped runner deletes `schema.json` right after `validate_profile`
    (chosen because the pre-existing provenance-closure gate does NOT cover
    non-provenance artifacts; deleting `provenance.json` was already caught):
    RED pre-fix (outcome was `completed`, version dir published without the
    file) → GREEN (outcome `failed`, "release invariants failed", no version
    dir, and a direct `runner.run_operation(publish)` raises `BuildError`).
  - (c) `test_provenance_same_count_fake_source_ids_fail` +
    `test_provenance_exact_source_ids_pass` — RED pre-fix (gate had no
    `expected_source_asset_ids` parameter) → GREEN.
  - Plus `test_manifest_artifact_missing_fails` and
    `test_manifest_artifact_tampered_size_or_hash_fails` (size/sha256
    verification).
- **Fix**:
  - `_publish` copies each artifact preserving its `relative_path`
    (`staged_dir / artifact.relative_path` with parent dirs), never silently
    skipping; a vanished file raises `OSError` → `BuildError`.
  - `check_release_invariants` gains `expected_source_asset_ids: set[str] |
    None`: when provided, provenance document source asset IDs must equal the
    build's source-asset set **exactly** (identity, not count); when omitted
    the legacy count check is preserved (backward compatible for existing
    callers/tests). `_publish` always passes
    `{asset.asset_id for asset in self._source_assets.values()}`.
  - New `_check_manifest_artifacts` gate: every manifest artifact must exist
    as a regular file with exact declared `size_bytes` and SHA-256
    (`sha256_file` — `hashlib.file_digest`, already chunked/bounded, the
    same streaming pattern as wave-1 B7). `ReleaseInvariantsResult` gains an
    `artifacts_intact` field; the runner's publish output dict includes it.
  - `test_dataset_invariants.py` helpers were reworked to materialize real
    artifact files so the new inventory check is meaningful.

## G4 = B5 (Important) — V2 empty input returns generic error, not NO_DATA

Files: `app/pipeline/dataset_build_tool.py`, `tests/test_dataset_build_tool.py`

- **Mechanism note (verified)**: the current adapters reject a header-only
  source at PARSE time (`AdapterError("…contains no data rows")`), so the
  review's described path ("header-only source integrates into a header-only
  primary → minimum_valid_rows fails") does not occur with the shipped
  adapters — the build fails earlier, still as the generic
  `{"status":"error","retryable":true}`. The observable bug is identical to
  the review's claim; the fix targets the tool boundary where the outcome is
  mapped.
- **Repro (test-first)**:
  `test_execute_dataset_build_header_only_source_is_no_data` — stage a
  header-only GDC TSV → RED pre-fix (`status == "error"`, `retryable: true`)
  → GREEN (`status == "ok"`, `result.status == "no_data"`,
  `valid_row_count == 0`, `reason_codes == ["no_primary_data"]`,
  `publication_id is None`, no version dir, no `merged/primary.csv`).
- **Fix**: on a `failed` outcome, `_is_no_data_outcome(output_dir,
  outcome.error)` detects zero valid rows via two signals — (1) the
  adapter-level empty-source error ("contains no data rows", the same wording
  the V1 processing stages use) and (2) a persisted manifest with
  `row_count == 0` and no published version — and returns the structured
  NO_DATA `BuildResult` envelope (`status: "ok"` top level, mirroring the
  wave-1 B9 V1 envelope pattern: `result.status == "no_data"`,
  `valid_row_count == 0`, `reason_codes == ["no_primary_data"]`). It is NOT a
  retryable error; no primary is published.

## G5 = B6 (Important) — V2 profile checks header width only, not row width

Files: `app/datasets/build/profiles.py` (`_check_rows`),
`tests/test_dataset_profiles.py`

- **Root cause**: `_check_rows` used `csv.DictReader`, which stores extra
  fields under the `None` key; only named required fields were validated, so
  a malformed extra-column (or missing-cell) row could pass (pre-fix the
  extra-column row actually crashed with `AttributeError: 'NoneType' object
  has no attribute 'strip'`).
- **Repro (test-first)**: `test_extra_column_row_fails_row_width` and
  `test_row_with_missing_cells_fails_row_width` — a valid primary plus one
  row with an appended field / truncated cells → RED pre-fix (crash / pass)
  → GREEN (`ValidationResultStatus.FAILED` with
  `row_width_matches_schema` in the report).
- **Fix**: `_check_rows` now parses with `csv.reader`, compares each row's
  parsed field count against the actual header count (`zip(header, row,
  strict=False)` after the width gate), counts malformed rows into a new
  `row_width_matches_schema` check, and runs the required/numeric/unit/
  provenance field checks only on well-formed rows. `test_valid_primary_passes`
  updated for the new check count (8 → 9).

## G6 = D1 (Important) — HIL is not an exclusive boundary

Files: `app/agent_loop/main_input_broker.py`,
`app/agent_loop/context.py`, `app/pipeline/dataset_build_tool.py`,
`tests/test_dataset_build_tool.py`

- **Root cause**: the SDK may run sibling FunctionTools concurrently; a turn
  emitting both `request_human_correction` and `execute_dataset_build` could
  publish an immutable V2 version from inputs under correction.
- **Repro (test-first)**:
  `test_execute_dataset_build_refuses_while_main_input_pending` — a live
  `MainInputBroker` with a blocking `request_input` in flight (a real pause),
  then call `execute_dataset_build` → RED pre-fix (`main_input_pending`
  attribute missing / build proceeded) → GREEN (refusal
  `{"status":"error","retryable":false}` mentioning 人工修正, no publish dir).
  `test_execute_dataset_build_proceeds_without_pending_main_input` — broker
  installed but idle → build succeeds and publishes (happy path).
- **Fix**: `MainInputBroker` gains a `has_pending_request` property backed by
  a `_pending` flag set for the whole `request_input` window (including the
  fixture path; cleared in `finally`); `RunContext.main_input_pending`
  delegates to it (`False` when no broker is installed, e.g. subagent
  contexts); `execute_dataset_build` refuses at entry with an agent-facing
  error when `run_ctx.main_input_pending` is set.

---

## Concerns / notes

1. **G4 mechanism vs review text**: the review's B5 described a header-only
   source integrating into a header-only primary and failing
   `minimum_valid_rows`. The shipped adapters reject empty sources earlier at
   parse time ("contains no data rows"), so the exact mechanism is
   unreachable, but the observable outcome (generic retryable error instead
   of NO_DATA) is exactly as reported and is fixed at the tool boundary with
   both signals covered (empty-source parse failure AND empty integrated
   primary via manifest `row_count == 0`). No finding invalidated.
2. **G1 existing test converted**: `test_abort_failure_blocks_cancelled_when_failure_event_cannot_persist`
   asserted the stranding behavior (run stays `CANCEL_REQUESTED`, no
   `RunCancelledPayload`) and was converted to assert the fixed contract
   (exactly one terminal `RunCancelledPayload`, `_running` cleared). The
   sibling `test_abort_failure_does_not_terminalize_cancellation_as_cancelled`
   (abort failure with a working failure append → `FAILED`) is unchanged and
   still green.
3. **G3 gate backward compatibility**: `check_release_invariants` keeps the
   legacy count-only provenance check when `expected_source_asset_ids` is
   omitted; the runner always passes the exact set, so live V2 builds get
   exact-identity verification.
4. **G6 residual race**: the gate is best-effort — if the build tool's entry
   check runs before the concurrent correction coroutine sets the pending
   flag, the build can still proceed. Fully serializing SDK tool execution is
   out of scope; the directive's requested gate (broker pending state exposed
   on RunContext + refusal in the build tool) is implemented and tested.
5. **G3 validation_report_ref**: the publication's
   `validation_result_ref` points at `validation_report.json`, which is not
   among `manifest.artifacts` and is not copied into the version dir — a
   pre-existing gap not covered by B3/B4 (which scope to manifest artifact
   references). Not addressed in this wave.
