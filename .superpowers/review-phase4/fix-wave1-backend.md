# Fix Wave 1 (Backend) — Phase 4 Review Bug Sweep

Branch: `fix/phase4-review-bugs` · Base: `08c961c` · Commit: `77dfede`
Worktree: `/tmp/pi-agent-6cbb5f5b-66cd-435-1d650ba8` (detached HEAD at branch tip)

8 fixes, all TDD (red test → fix → green), all confirmed by reviewers A/B/D.
No frontend files touched. No redesign beyond the directives.

## Verification summary (exact outputs)

- Full backend suite: `python -m pytest -q` → **2365 passed, 2 skipped, 28 deselected**
  (baseline was 2339 passed; +26 new tests from this wave, all green).
- `ruff check app/ tests/ launcher.py` → **All checks passed**.
- `python -c "import app.main"` → OK.
- Focused per-fix files (149 tests) → all green.

---

## F1 = B1 (Critical) — path escape in dataset build spec

Files: `app/tools/workdir.py`, `app/datasets/contracts.py`, `app/pipeline/dataset_build_tool.py`,
`tests/test_dataset_contracts.py`, `tests/test_dataset_build_tool.py`

- Exposed the TaskWorkDir strict single-component ID validator as
  `validate_safe_path_id` (regex `^[A-Za-z0-9_-]{1,128}$`; rejects separators,
  `..`, absolute paths) and applied it via `field_validator` to
  `DatasetBuildSpec.build_id` and `SourceBinding.binding_id` — invalid values
  are rejected at model construction.
- Defense in depth: new `_ensure_build_output_inside(build_root, build_id)`
  containment guard in the tool, called before any executor is built; a
  violation returns `invalid_input` (never writes outside the workspace).
- Tests: model-level rejection of `/tmp/outside`, `../escape`, `a/b`, `a\b`,
  `..` for both fields + valid-ID acceptance; tool-level end-to-end guard
  (escape target under `tmp_path` never created, no escaped child in the task
  build workspace; the baseline valid build still succeeds).
- Note: cleaned up a stale `/tmp/published-by-agent` directory left behind by
  reviewer B's earlier probe on this machine.

## F2 = B2 (Important) — V2 checkpoint digest omits source content

Files: `app/datasets/runtime/executor.py`, `app/pipeline/dataset_build_tool.py`,
`tests/test_dataset_expression_runner.py`

- `DatasetBuildExecutor` now accepts `source_assets` and folds the sorted
  `binding -> {sha256, size_bytes}` mapping into the input digest of **every**
  operation. Rationale (documented in code): operation outputs are structural
  metadata (row counts, paths, `batch_<binding_id>` ids), so a source-content
  change would not otherwise propagate through the upstream digest chain;
  folding into the acquire-only digest was verified insufficient with the real
  runner (canonicalize+ were still reused after parse re-ran with identical
  structural output). This matches the directive's stated alternative
  ("invalidate the build state when source assets change" — conservative
  invalidation).
- Root-cause reproduction: with `output_dir == task_root` (so checkpoint file
  verification succeeds), the pre-fix second build returned the identical
  `publication_id` and stale `1.5/2/3/4.25` values; post-fix it publishes a new
  version with `99/100/101/102`, and the re-run acquire attempt carries a new
  input digest with no SKIPPED acquire.
- Also verified end-to-end through the tool: replaced source file → new
  publication reported, new values in `merged/primary.csv` (in combination with
  F4's time-based reporting).

## F3 = B7 (Important) — artifact routes load entire files into memory

Files: `app/api/routes.py`, `tests/api/test_artifact_api.py`

- `_file_sha256` now streams fixed 1 MiB chunks (`_HASH_CHUNK_SIZE = 1 << 20`)
  instead of `Path.read_bytes()`; it backs the run-manifest listing digest, the
  artifact integrity checks on list + download, and the
  `.runtime-publication.json` marker verification (the last was a second
  `read_bytes` site in `_load_validated_manifest`).
- Behavior kept identical: list still raises 409 on size/hash mismatch
  (existing `test_artifact_api_preserves_manifest_and_integrity_conflicts`
  `hash_mismatch` case requires it); the memory exhaustion is fixed by bounded
  chunked reads, not by dropping verification.
- Test: `Path.read_bytes` monkeypatched to raise (scoped to the artifact tree +
  a >2 MiB multi-chunk file) → `_file_sha256` still returns the correct sha256,
  list and download routes work, digests match the manifest-recorded values.

## F4 = B8 (Important) — V2 supersedes chain picks lexicographic max

Files: `app/datasets/build/expression_runner.py`, `app/pipeline/dataset_build_tool.py`,
`tests/test_dataset_expression_runner.py`

- `_find_latest_publication` now selects the newest record by its authoritative
  `published_at` timestamp (parsed from each version dir's `publication.json`),
  tie-breaking deterministically on `(published_at, publication_id)`; malformed
  records are skipped. Docstring updated.
- The tool's sibling `_latest_publication_id` had the identical bug (B8's
  verification noted "both V2 helpers") — it now delegates to
  `_find_latest_publication` so the tool and the supersedes chain agree.
- Tests: digests `f.../a.../0...` with the middle-ID newest by time → returns
  `0...` (not the lexicographic max `f...`); equal-timestamp tie-break is
  deterministic across calls; malformed records ignored.

## F5 = B9 (Important) — V1 tool envelope omits build_result

Files: `app/pipeline/tool.py`, `tests/pipeline/test_pipeline_tool.py`

- `run_research_pipeline`'s result envelope now carries
  `build_result = manifest.build_result.model_dump(mode="json")` when present
  (additive key, backward compatible; `getattr` keeps FakeRunner-based tests
  working).
- Tests: the real fixture SUCCEEDED run now asserts
  `payload["build_result"]["status"] == "succeeded"` with `valid_row_count > 0`
  and a `publication_id`; a fake-runner NO_DATA completed run asserts
  `status == "no_data"`, `valid_row_count == 0`, `reason_codes ==
  ["no_primary_data"]`.

## F6 = D2 (Important) — V2 build is not cancellation-aware

Files: `app/pipeline/dataset_build_tool.py`, `app/datasets/build/expression_runner.py`,
`tests/test_dataset_build_tool.py`, `tests/test_dataset_expression_runner.py`

- The tool now passes `run_ctx.cancellation_requested` (an `asyncio.Event`,
  satisfying the executor's `CancellationToken` protocol) into both
  `ExpressionBuildRunner` and `DatasetBuildExecutor`.
- The runner gains an optional `cancellation_requested` and `_publish` refuses a
  set token with `BuildCancelledError` (defense in depth; the executor already
  checks around every operation).
- Tests: a pre-cancelled RunContext → the tool returns a non-ok status and no
  publish directory is created (red before the tool change: status was `ok`);
  cancelling between validate and publish via a wrapped runner → executor
  outcome `cancelled`, no version dir, publish attempts recorded `cancelled`;
  direct runner `_publish` with a set token raises `BuildCancelledError`.

## F7 = D3 (Minor) — model-controlled timeout_seconds unbounded

Files: `app/agent_loop/request_human_correction.py`,
`tests/agent_loop/test_request_human_correction_tool.py`

- Module constants `_MIN_TIMEOUT_SECONDS = 1.0`, `_MAX_TIMEOUT_SECONDS = 3600.0`
  and `_is_valid_timeout()` (finite + in-range; catches TypeError/ValueError/
  OverflowError). The tool entry rejects invalid `timeout_seconds` with an
  agent-facing failure text and never pauses the Run; valid values still route
  to the broker.
- Tests: `-1`, `0`, `NaN`, `inf`, `3601` → failure text containing
  `timeout_seconds`, broker `received == {}` (no pause); `42.0` → still pauses
  and forwards the value.

## F8 = A8 (Minor) — artifact_count no dedup

Files: `app/domain/contracts/runtime.py`, `app/runtime/state.py`,
`app/runtime/repository.py`, `app/runtime/index.py`,
`tests/runtime/test_state_reducer.py`, `tests/runtime/test_repository.py`

- `TaskSnapshot` gains a private `_artifact_ids_by_run: dict[str, set[str]]`
  (`PrivateAttr` — never part of the wire contract; API responses unchanged).
- The reducer dedups `artifact_produced` by `(run_id, artifact_id)`: only new
  identities increment `artifact_count`; the private map is copied per reduce
  so the input snapshot is never aliased/mutated (purity preserved).
- Persistence: `_snapshot_with_internal()` serializes the private map under a
  private JSON key `_artifact_ids_by_run`; `_load_snapshot_sync` and
  `index.py`'s rebuild restore it before validating/reducing, so the dedup
  survives repository round-trips and restarts. Two existing repository tests
  that validate raw persisted JSON directly were updated to pop the private key
  (`_load_persisted_snapshot` helper).
- Tests: identical payload at two sequences → count stays 1; different
  artifact_id increments; same id under a different run increments; repository
  integration: append duplicate + distinct events across persistence
  round-trips and a fresh repository instance → count 2, seen-set restored.

---

## Concerns / notes

1. **F2's digest placement**: the directive said "fold them into the
   first-operation input digest"; the acquire-only version was proven
   insufficient against the real runner (structural outputs short-circuit the
   chain), so the mapping is folded into every operation's input digest
   (equivalent to the directive's "invalidate build state when source assets
   change" alternative). Reviewer B's stated end-to-end probe now passes.
2. **F3 eager list verification kept**: the existing 409-on-list integrity
   contract (`hash_mismatch` test) conflicts with "avoid eager hashing on
   list"; the memory bug is fixed by chunked reads, verification semantics are
   unchanged.
3. **F4 tool helper also fixed**: `_latest_publication_id` in
   `dataset_build_tool.py` had the identical lexicographic bug and now shares
   the time-based selection.
4. **F8 persistence key**: the private dedup state is persisted under the JSON
   key `_artifact_ids_by_run`; it is popped before any `extra="forbid"`
   validation and never appears in API responses. Two legacy-load sites
   (repository + index rebuild) restore it.
5. Stale `/tmp/published-by-agent` from reviewer B's probe was removed (it
   predated this wave and could trip the F1 escape assertion).
