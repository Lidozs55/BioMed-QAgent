# Phase 7 — T1 Report: builds API + durable execution.build_result + F4 PlatformRecord

Branch: `feat/phase7-t1-api-builds` (worktree `/tmp/pi-agent-e24cf538-0207-490-7aaa7241`)

## Summary

Three seams closed (all TDD red-first, backend-only):

1. **Durable `execution.build_result` for V2 builds** (bug-sweep REVIEW §3 V2-dup, TODO Phase 7 P0).
2. **Builds API endpoints** (`GET /api/v1/builds`, `GET /api/v1/builds/{build_id}`, `GET /api/v1/builds/{build_id}/artifacts/{artifact_id}`).
3. **F4 (Phase 5 REVIEW §3)**: probe-primary publications now emit `PlatformRecord` (platform_audit.csv).

## Seam 1 — durable execution.build_result wiring (V2)

**Gap found**: `execute_dataset_build` computed a structured `BuildResult` and returned it as JSON to the LLM, but nothing bridged it to the durable `RunExecution`. `RunContext` exposes no execution handle. The V1 path bridges via `RunContext.set_pending_publication(...)` + the executor's `_transfer_pending_publication`; V2 had no equivalent, so every V2 build run completed with the manager's generic `NO_DATA` fallback (and the bug-sweep "B9/B5 end-to-end inconsistent" symptom).

**Fix** (no new abstractions; reuses the existing pending-publication seam):

- `app/agent_loop/context.py`: added a `PendingDatasetBuild` dataclass (mirrors `PendingPublication`) + `RunContext.install_dataset_build_outcome` / `take_dataset_build_outcome` (one slot per run, last build wins; requires matching `managed_run_id`).
- `app/pipeline/dataset_build_tool.py`: `_install_dataset_build_outcome(...)` installs the outcome on the managed context after a successful build and after a classified NO_DATA envelope. No-op for direct/unit-test invocations (no managed run). `_load_publication(...)` reads the immutable `DatasetPublication` record from the version dir.
- `app/agent_loop/runner.py`: `_transfer_pending_publication` now checks the V2 outcome first and delegates to `_transfer_dataset_build_outcome` — sets `execution.build_result`, emits `PublicationCreatedPayload` (real publication_id / published_at / supersedes; manifest_sha256 = DatasetManifest package digest). No file copying: build outputs already live under `datasets_build/<build_id>/` (the V1 `ArtifactManifestEntry` contract requires `artifacts/`-prefixed paths, so V2 build files are deliberately not emitted as V1 artifact events — the builds API serves them; legacy dual-read-write is T2's wave).
- `app/runtime/manager.py`: zero-artifact completion branch now requires `execution.build_result is None` — an executor-attached structured BuildResult (incl. NO_DATA envelopes) always wins over the generic fallback. Backward compatible: V1 paths never set build_result without completion events.

**Test** (red → green): `tests/agent_loop/test_agent_run_e2e.py::test_agent_e2e_v2_dataset_build_wires_durable_build_result` — real `execute_dataset_build` call inside the manager/executor loop; asserts `RunCompletedPayload.build_result.status == SUCCEEDED` (valid_row_count 4, successful_sources, real publication_id), a single `PublicationCreatedPayload` matching, and no `artifact_manifest_missing` warning. Before: FAILED with `NO_DATA`; after: passes.

## Seam 2 — builds API (`app/api/routes.py`, prefix `/api/v1`)

Typed ContractModel response models (file-local, per routes.py convention): `BuildSummary`, `BuildPage`, `BuildDetail`.

- `GET /api/v1/builds?limit=&cursor=` — paginated build list, newest manifest first. Each item: BuildResult + dataset manifest pointer (`manifest_ref`, `manifest_sha256`), family/grain/schema/row_count/status/publication_id/published_at. Cursor = base64 `mtime_ns|task_id|build_id` (422 on malformed, same convention as task cursor).
- `GET /api/v1/builds/{build_id}` — single BuildResult with the full `DatasetManifest` summary + `DatasetPublication` + manifest artifact inventory.
- `GET /api/v1/builds/{build_id}/artifacts/{artifact_id}` — download `dataset_manifest` or any manifest-registered artifact (sha/size verified, path-traversal guarded, mirrors the task artifact pattern).

**BuildResult resolution**: durable events first (`RunCompletedPayload.build_result` correlated by `publication_id` — preserves PARTIAL_SUCCESS/NO_DATA envelopes the manifest alone cannot express), else a deterministic manifest projection (`_derive_build_result`). Builds are discovered by scanning `tasks_dir/*/datasets_build/*/dataset_manifest.json` (the manifest is the immutable record; no snapshot requirement). Existing task endpoints untouched.

**Tests** (`tests/api/test_builds_api.py`, 6): list with pointer+result, cursor pagination, detail, manifest+primary download, 404s, and durable-event correlation (partial_success wins over projection).

## Seam 3 — F4 PlatformRecord on V2 probe-primary publications

**Gap**: D5 row 2 probe-primary publications emitted `ProbeMappingSummary` + audits but no `PlatformRecord` (V1 covered by T3; V2 was a documented Phase 7 item).

**Fix**:

- `app/datasets/build/probe_mapping.py`: `parse_platform_table` now also returns `(probe_column, gene_column)`; `ProbeMappingResult` gained `platform_record: PlatformRecord | None`; `build_probe_mapping` builds one D3 `PlatformRecord` per GPL attempt (status mapping MAPPED/PARTIAL→mapped, NO_GENE_ANNOTATION, UNMAPPED; annotation_asset_id/sha256, probe/gene columns; `source_id` defaults to the annotation asset's source id, else binding id).
- `app/datasets/build/expression_runner.py`: `self._platform_records` per binding; NOT_ATTEMPTED records for declared platforms without an annotation asset; `_validate_profile` writes `platform_audit.csv` (V1-identical columns) into the manifest audit list → lands in the immutable publication package.

**Tests**: unit (`test_dataset_probe_mapping.py`, +2) and integration (`test_dataset_build_tool.py::test_execute_dataset_build_probe_level_emits_platform_records` — platform_audit.csv in build root, manifest audit artifact, published version dir).

## Constraints respected

- No cache endpoints / legacy double-read-write touched (T2 wave); no `stage_*` event semantics changed (T3 parallel); no new router file; no live network tests; no frontend changes.

## Verification (all in worktree `backend/`)

| Gate | Result |
| --- | --- |
| `pytest -q` | **2668 passed, 2 skipped, 28 deselected** (baseline 2658 → +10 new tests) |
| `ruff check app/ tests/ launcher.py` | All checks passed |
| `python -c "import app.main"` | OK |
| uvicorn smoke | `/api/v1/health` ok; `/api/v1/builds` → `{"schema_version":"1.0","items":[],"next_cursor":null}` |

## Concerns / notes

- **Build identity**: `build_id` is agent-supplied and only unique per task; `GET /builds/{build_id}` resolves the newest matching build across tasks (documented). A future global build index (Phase 7 P0 cache wave) could key by task_id+build_id.
- **No V2 artifact_produced events**: the V1 `ArtifactManifestEntry.relative_path` validator requires `artifacts/`-prefixed paths, which V2 build files cannot satisfy; the builds API is the serving surface (T2's dual-read-write migration may revisit).
- **Multi-build runs**: one outcome slot per run — the last `execute_dataset_build` outcome wins; a run publishing multiple builds keeps only the last BuildResult in `run_completed` (V1 has the same single-slot limitation).
- **Derived projection lossy by design**: pre-wiring builds show the manifest-derived BuildResult (SUCCEEDED/NO_DATA); PARTIAL_SUCCESS requires the durable events (Seam 1 wiring) to surface.
