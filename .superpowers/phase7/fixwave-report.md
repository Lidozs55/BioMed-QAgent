# Phase 7 Review Fix Wave (F7-01 / F7-02 / F7-05)

Branch: `feat/phase7-fixwave` · Commit: `4bacba2`
Base: `cad68a5` (Phase 7 T1–T6 merged) · Worktree: `/tmp/pi-agent-ca8c0b02-dda0-472-426b3197`

## F7-01 — dual-read dead in production (Should-Fix)

**Bug**: `_cache_artifacts_for_task` (`backend/app/api/routes.py`) matched
`manifest.task_id == task_id`, but `ExpressionBuildRunner.assemble_manifest`
(`backend/app/datasets/build/expression_runner.py:617/641`) stamps the
manifest's `task_id` with `self._spec.build_id` (the spec carries no task id;
real builds use ids like `build_e2e`). The match never fired, so the artifact
API always served the V1 bridge in production. The existing tests masked this
by fabricating manifests whose `task_id` field held the real task id
(`backend/tests/api/test_artifact_api.py` `_seed_v2_cache_entry`).

**Fix**: match the cache entry to the task via the dataset build directory
shape `tasks_dir/<task_id>/datasets_build/<build_id>/` (the layout
`execute_dataset_build` writes, per `_scan_build_dirs`), plus the manifest
digest. `_task_build_identity` collects `(build_id, sha256)` from the task's
build manifests (byte-identical to committed cache entries, since
`DatasetCacheV2.commit` copies the build dir); a cache entry belongs to the
task when both its `build_id` and `sha256` match. The digest term also makes
two tasks that reuse the same build_id with different content resolve to the
correct content-addressed entry (content-addressed entries are immutable).

**Tests**:
- Fixture `_seed_v2_cache_entry` updated to the real production shape: build
  output dir at `tasks_dir/<task_id>/datasets_build/build_dual_read/`, manifest
  `task_id` == build_id. Assertion in `test_artifact_api_reads_v2_cache_first`
  updated accordingly.
- New `test_artifact_api_cache_matches_task_via_build_dir_shape`: production
  shape + the V1 bridge mirror dual-written; asserts the cache/content-
  addressed id (`artifact_primary`) is served, the V1-bridge
  (relative-path-hashed) id is not, and the V1-bridge id 404s on download
  (cache-first, no legacy fallback). Verified red against the unfixed code.

## F7-02 — build_id collision across tasks (Should-Fix)

**Bug**: `GET /api/v1/builds/{build_id}` resolved the newest build across all
tasks (`_locate_build_id`); `BuildResultsViewer` accepted a `taskId` prop but
ignored it.

**Fix**:
- Backend: `_locate_build_id(tasks_dir, build_id, task_id=None)` optionally
  scopes the scan to one task; `GET /builds/{build_id}` and
  `GET /builds/{build_id}/artifacts/{artifact_id}` accept an optional
  `?task_id=` query param. Without the param the newest build still wins
  (backward compatible).
- Frontend: `fetchBuild(buildId, taskId?)` / `getBuildArtifactUrl(buildId,
  artifactId, taskId?)` (`frontend/src/hooks/useAPI.ts`) append `?task_id=`
  only when a taskId is provided; `BuildResultsViewer` threads its `taskId`
  prop through `fetchBuild` and every `BuildArtifactCard` (all four tabs).

**Tests**:
- Backend `test_builds_api_task_filter_disambiguates_colliding_build_ids`: two
  tasks share `build_shared` with different row counts; unfiltered fetch
  returns the newest (task_b), `?task_id=task_a` returns task_a, unknown task
  404s, and the artifact endpoint honors the same filter. Verified red
  (unfiltered `?task_id=` returned task_b) against the unfixed code.
- Frontend: `api.test.ts` asserts `?task_id=` is appended and omitted when
  null; `build-results-viewer.test.tsx` asserts the viewer passes
  `task_id=task_results` in both the build detail and artifact fetch URLs.
  One mock fixture (`stubBuildFetchPerArtifact`) updated to strip the new
  query string when extracting the artifact id.

## F7-05 — path-traversal pins (Note)

Two regression tests in `backend/tests/api/test_artifact_api.py`:
`test_verified_build_artifact_path_rejects_traversal` and
`test_verified_cache_artifact_path_rejects_traversal`. Malicious
`relative_path` values (`../secret.csv`, `../../etc/passwd`, absolute paths)
raise 409 `Invalid … path` before any file access (sentinel file outside the
dir is never read); in-dir artifacts still resolve (guard not over-broad).

## Gates (all green)

- Backend: `pytest -q` **2702 passed** (2698 baseline + 4 new), 2 skipped, 28
  deselected · `ruff check app/ tests/ launcher.py` clean · `import app.main` OK.
- Frontend: `pnpm lint` 0 errors · `pnpm tsc` 0 errors · `pnpm test` **712
  passed** (711 baseline + 1 new, api.test.ts extended) · `pnpm build` OK
  (pre-existing chunk-size warning only).

## Residual risks / notes

- F7-01 drops the `manifest.task_id` check entirely; it never fired for V2
  builds in production, and every cache-committed build has its build dir
  under the task tree, so the build-dir-shape match is strictly more correct.
- `GET /builds` list endpoint was intentionally left unfiltered (the viewer
  only needs the detail + artifact endpoints); `useTaskBuildId` already
  correlates the list by `task_id` client-side.
- The new `?task_id=` param is optional and backward compatible.
