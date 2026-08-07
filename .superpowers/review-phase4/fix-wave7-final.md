# Fix Wave 7 (Final) — Phase 4 Review MUST-FIX Items (K1/K2/K3)

Branch: `fix/phase4-review-bugs` · Base: wave 6 merged HEAD (`e55103a`)
Worktree: `/tmp/pi-agent-969ac217-41f0-48f-45006a7c` (detached at base)
Commit: `c521197` — `fix(phase4): review wave 7 — discard cancelled V2 outputs,
contract-coherent mixed-source NO_DATA, store gap cleared on socket reset (TDD)`

3 fixes, all TDD (red test → fix → green). K1/K2 backend, K3 frontend. No
redesign beyond the directives.

## Verification summary (exact outputs)

| Gate | Command | Result |
|---|---|---|
| Backend full suite | `python -m pytest -q` | **2390 passed, 2 skipped, 28 deselected** (baseline 2388 → +2 new tests: K1 discard/retry, K2 all-empty-mixed regression) |
| Backend lint | `ruff check app/ tests/ launcher.py` | All checks passed |
| Backend import | `python -c "import app.main"` | OK |
| Frontend full suite | `cd frontend && pnpm test` | **42 files, 687 passed** (baseline 686 → +1 new test: K3 store-gap clear on replacement) |
| Frontend lint | `pnpm lint` (eslint . --max-warnings 0) | 0 errors, exit 0 |
| Frontend build | `pnpm build` (tsc -b && vite build) | OK (only pre-existing chunk-size warning) |

---

## K1 = D2 — in-flight sync op not interruptible: cancelled worker outputs discarded + workspace hygiene (backend)

Files: `backend/app/datasets/build/expression_runner.py`,
`backend/app/datasets/runtime/executor.py`,
`backend/tests/test_dataset_expression_runner.py`

- **Round-2 verdict recap**: the `asyncio.to_thread` offload (wave 5) keeps the
  loop responsive, but the worker thread keeps running after the executor
  returns on cancellation; the honest close is (a) discard the cancelled
  operation's outputs at the boundary, (b) record the cancellation so a retry
  starts from a clean checkpoint, (c) document the residual.
- **Mechanism established**: the tool-level cancellation channel is the
  cooperative `cancellation_requested` token (`RunContext`, an `asyncio.Event`
  set by `manager.request_cancellation` — never a task cancel). The
  operation-boundary check in `_execute_operation` runs **only after** the
  `to_thread` await completed, i.e. the thread's files are finished at the
  moment cancellation is observed — so discarding at the boundary is safe,
  never mid-write.
- **Repro (test-first)**:
  `test_cancelled_integrate_outputs_are_discarded_and_retry_publishes_clean`
  — monkeypatched blocking integrate (event + `time.sleep(0.4)` then the real
  integrate), cancel the token while integrate is in flight → executor returns
  `cancelled` without publishing; **RED pre-fix**: the completed-too-late
  thread's `merged/primary.csv` (and `conflicts.csv`) remained in the build
  workspace after the cancelled run. Also asserts the state dir records the
  CANCELLED integrate attempt (clean checkpoint — no SUCCEEDED attempt for the
  retry to reuse), then re-runs the same `build_id` with **new inputs** and
  asserts the retry completes and the published version's `merged/primary.csv`
  contains only the new run's data (`{9,10,11,12}`, ensembl namespace), i.e.
  no old-input values leaked into the publication.
- **Fix**:
  - `ExpressionBuildRunner.discard_operation_outputs(op)` deletes the
    deterministic per-operation output paths (parse → `batches/<binding>*.csv`;
    canonicalize → `canonical/<binding>.*`; integrate →
    `merged/primary.csv`+`conflicts.csv`; validate_profile → manifest,
    validation report, provenance; publish → `.*.tmp` staged dirs), best-effort
    per file (`OSError` ignored: a file held open by a dying thread may refuse
    deletion and the retry rewrites the same paths anyway).
  - `DatasetBuildExecutor._execute_operation` post-cancellation-check calls the
    new `_discard_cancelled_operation_outputs(op.operation_id)` (duck-typed on
    the operation runner; `contextlib.suppress` so discard never masks the
    cancellation outcome) **before** raising `BuildCancelledError`. The
    pre-check path is untouched (nothing to discard there), and the existing
    operation-boundary checks + `_finalize_cancelled` flow are unchanged.
  - Workspace-hygiene record: the state dir already records the CANCELLED
    attempt (append-only `operation_attempts.jsonl` + saved `BuildState`), and
    `load_operation_output` verifies referenced files before digest-reuse, so a
    retry can never reuse a cancelled attempt's leftovers — a retry acquires a
    clean checkpoint for the cancelled operation by construction.
- **Residual (documented in code)**: in-flight sync work is not preemptable;
  the cooperative token path discards only the *finished* outputs at the
  boundary, never mid-write. The operation-timeout path
  (`asyncio.timeout` cancels the await while the thread keeps running) is a
  FAILURE outcome, out of K1's cancellation scope; a retry there re-runs the
  operation (no SUCCEEDED attempt) and rewrites the paths.

## K2 = B5 — mixed-source abort must not emit contract-incoherent PARTIAL_SUCCESS (backend)

Files: `backend/app/pipeline/dataset_build_tool.py`,
`backend/tests/test_dataset_build_tool.py`

- **Round-2 verdict recap**: `_classify_failed_outcome` returned
  `PARTIAL_SUCCESS` with `valid_row_count=0` and no publication for the
  mixed-source abort case; ARCHITECTURE §9.2 defines `PARTIAL_SUCCESS` as
  "remaining valid sources validated AND publishable" (a Publication is
  allowed), which an abort-at-first-empty build never did. Per-binding
  tolerance + publishing the usable source was evaluated: the fixed
  `build_operation_plan` skeleton aborts at the first empty parse, integrate
  requires **all** bindings' canonical results (`_canonical_results_for_bindings`
  raises on any missing binding), and nothing validates/publishes a subset —
  per-binding independence is a feature, not small effort. So the verdict's
  fallback was taken: **NO_DATA with precise reason codes**.
- **Repro (test-first)**:
  - (i)/(ii) `test_execute_dataset_build_mixed_empty_and_usable_sources_is_no_data_not_partial_success`
    — empty GDC + usable Xena: **RED pre-fix** (`status == "partial_success"`);
    GREEN post-fix: `status == "no_data"`, `valid_row_count == 0`,
    `successful_sources == []`, `rejected_sources == ["binding_gdc"]`,
    `reason_codes == ["no_primary_data:binding_gdc"]` (the empty binding is
    identified in the codes), `publication_id` None, not retryable, no version
    dirs.
  - (iii) `test_execute_dataset_build_all_empty_mixed_sources_is_no_data` —
    both bindings empty → regression: the established all-empty NO_DATA
    envelope (`reason_codes == ["no_primary_data"]`, all sources rejected).
  - Existing single-binding header-only NO_DATA test stays green.
- **Fix**: the `no_primary_data` branch of `_classify_failed_outcome` computes
  the empty bindings (adapter-agnostic data-row probe, unchanged) and returns:
  - mixed abort (`empty` non-empty and `<` all bindings) → `NO_DATA` with
    `rejected_sources == sorted(empty)`, `reason_codes ==
    ["no_primary_data:<binding_id>" ...]`, the (renamed)
    `_MIXED_EMPTY_SOURCE_SUMMARY` / `_MIXED_EMPTY_SOURCE_NEXT_ACTION` text;
  - all-empty → the previous NO_DATA envelope, byte-for-byte unchanged.
  `PARTIAL_SUCCESS` is no longer produced by the V2 tool (V1 never produced it;
  the enum value and the V1-side handling are untouched). The build-result
  model validator is unaffected (`NO_DATA` requires only `valid_row_count == 0`).

## K3 = C2 — store-level sequenceGap must clear on socket replacement (frontend)

Files: `frontend/src/runtime/transport.ts`, `frontend/src/runtime/reducer.ts`,
`frontend/src/runtime/reducers/shared.ts`, `frontend/src/runtime/reducers/index.ts`,
`frontend/src/stores/agentStore.ts`, `frontend/src/hooks/useAgentStream.ts`,
`frontend/src/test/agent-stream.test.ts`

- **Round-2 verdict recap**: the recovery-driven socket replacement cleared only
  transport-internal maps (`gapRecoveryCursors/Failures/gapFallbackFired`); the
  store-level `sequenceGap` marker stayed set, so a lingering marker kept
  treating valid replayed events as gapped until the first contiguous frame or
  a snapshot hydration.
- **Fix**: new store action `markContiguous(taskId)` (reducer
  `markTaskContiguous` in `reducers/shared.ts`, exported through
  `reducers/index.ts` and the `runtime/reducer.ts` barrel; clears
  `sequenceGap` to null, no-op for unknown tasks / no marker). The transport
  gains an optional `markContiguous` option (guarded, backward compatible) and
  calls it for every desired task from the `openSocket` `onopen` handler (via
  `clearStoreSequenceGaps()`), i.e. at the point a fresh connection
  establishes and `flushSubscriptions` replays every subscribed task from its
  watermark — the stream is contiguous again by construction. A
  still-undeliverable frame simply re-sets the marker on the next replay; the
  transport's bounded recovery guards are untouched (the marker is the
  reducer's truthful record; the transport re-arms recovery independently).
  Wiring: `useAgentStream.ts` passes `useAgentStore.getState().markContiguous`.
- **Repro (test-first)**: `clears the store-level sequenceGap when the
  replacement socket opens (K3)` — seed task_a at cursor 4, deliver frame 6
  (gap marker `{expected:5, received:6}` recorded, recovery armed, socket
  replaced); **RED pre-fix**: after `sockets[1].open()` the marker is still set;
  GREEN post-fix: marker null, cursor still 4, then frames 5/6 apply normally
  (`lastSequence` 5/6) with no additional recovery. Existing gap tests
  (detection, F2 natural-reconnect re-arm, F2 permanent-gap snapshot fallback)
  all stay green — the marker assertions that precede the replacement and the
  post-hydration assertions are unaffected.

## Concerns / notes

1. **K1 discard placement**: the discard fires only on the *post-run* boundary
   check (the `_execute_operation` after-check), never the pre-check, so it is
   scoped to operations whose worker thread actually finished writing — the
   exact "completed-too-late" case. Runner-internal raises (e.g. `_publish`'s
   own token check) raise before writing anything, so nothing to discard there.
   The one residual not closed by K1 is the live-process *timeout* path where a
   thread may still be writing after the executor returns a failed outcome;
   this is documented in the executor/runner docstrings and is out of the
   cancellation directive's scope.
2. **K2 reason-code shape**: the mixed envelope uses binding-scoped codes
   (`no_primary_data:<binding_id>`) while the all-empty envelope keeps the
   generic `no_primary_data`. No consumer matches on the generic code
   substring (frontend renders codes opaquely), so the precision is safe; the
   all-empty envelope is byte-identical to before (regression-protected).
3. **K3 placement**: clearing happens at `onopen` (fresh connection
   established) rather than at `replaceSocket()`/`onclose` — this preserves
   the wave-5 test's observation that the marker is truthfully set while the
   stream is broken, and clears it exactly when the replay makes the stream
   contiguous again. Transport-internal guards are deliberately not reset at
   `onopen` (only the natural-close path resets them, unchanged from wave 6).
4. **Frontend gate note**: the isolated worktree has no `node_modules`; tests
   ran with `CI=true pnpm ...` (pnpm otherwise wants to reinstall when the
   modules dir is missing). A temporary `node_modules` symlink to the main
   repo was used for the raw vitest run and removed before commit.
