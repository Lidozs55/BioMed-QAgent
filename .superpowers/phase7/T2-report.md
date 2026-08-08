# Phase 7 — T2 Report: V2 Dataset Cache HTTP API + 双读双写迁移 + main_data.csv legacy 包装

Branch: `feat/phase7-t2-cache-api` (worktree `/tmp/pi-agent-c928e81c-5a99-41a-c065201e`)

## Summary

Three Phase 7 P0/P1 deliverables (all TDD red-first, backend-only, no live
network, no frontend):

1. **Cache HTTP endpoints** (`/api/v1/cache/datasets`, detail, artifact download).
2. **双读双写 (dual-read-dual-write) migration** of the legacy artifact API.
3. **`main_data.csv` legacy wrapper** as `gene_expression.long.legacy.v1`.

## Seam 1 — Cache HTTP endpoints (`app/api/routes.py`, prefix `/api/v1`)

Typed ContractModel response models (file-local, per routes.py convention):
`CacheDatasetSummary`, `CacheDatasetPage`, `CacheDatasetDetail`.

- `GET /api/v1/cache/datasets?namespace=&keyword=&limit=` — merged listing of
  V2 `DatasetCacheV2` entries and legacy `CacheStore` records (newest first).
  `namespace` filters one cache namespace (V2 `cache/datasets/<ns>` or legacy
  `cache/records/<ns>`, 422 on unsafe segments); `keyword` filters entry
  metadata only (family / schema_ref / build_id / keywords / legacy
  topic+description) — search-only, never part of the content-addressed
  identity (ARCHITECTURE §13). Default limit 50, cap 200.
- `GET /api/v1/cache/datasets/{dataset_id}?namespace=` — detail: manifest
  pointer (`manifest_ref`) + artifact inventory (`ManifestArtifactEntry`
  list). V2 wins over legacy on id collision; optional `namespace`
  disambiguates. 404 when unknown; 409 when the entry manifest is corrupt.
- `GET /api/v1/cache/datasets/{dataset_id}/artifacts/{artifact_id}` —
  download. V2 entries resolve through the entry manifest (special
  `dataset_manifest` id + sha/size integrity verification + path-traversal
  guard, mirrors the builds API); legacy entries serve `main_data` /
  `manifest` from the records tree.

The cache root is derived from the repository (`tasks_dir.parent.parent /
"cache"`), identical to the lifespan `init_cache_store` root.

## Seam 2 — 双读双写 migration of the legacy artifact API

**Dual-write** (`app/datasets/build/v1_bridge.py`, wired in
`execute_dataset_build` after the successful cache commit): a successful
managed build (managed_run_id set) mirrors its manifest-registered artifacts
into `<task_root>/artifacts/` and writes a valid V1 `run_manifest.json`
(fabricated from the V2 `DatasetManifest` + spec; artifacts sorted/unique by
id — the V2 content-addressed ids are NOT unique across relative paths, so
the bridge derives V1-style path-unique ids). Best-effort (never fails the
build); writes the manifest last so a crash leaves no partial surface.

**Deliberately no `.runtime-publication.json` marker**: the runtime startup
reconcile loop treats a marker under `artifacts/` as a V1 pipeline
publication and would synthesize a fake `pub-<run_id>` record. The legacy
artifact API therefore serves the bridged surface in degraded mode after the
run is COMPLETED (matching V1 semantics).

**Dual-read** (`list_artifacts` / `get_artifact_file`): the endpoints now
resolve the newest V2 cache entry whose manifest `task_id` matches the task
(`_cache_artifacts_for_task`, `build` namespace) and serve it in the legacy
shape (`run_manifest` pseudo-entry → `dataset_manifest.json`, then manifest
artifacts; integrity verified; requires ≥1 COMPLETED run — same as the
legacy marker path). Fallback to the legacy `artifacts/` dirs is unchanged,
so every existing artifact-API test stays green.

## Seam 3 — `main_data.csv` legacy wrapper (`app/datasets/build/legacy_cache.py`)

A read-side projection over the old `CacheStore` records tree
(`cache/records/<ns>/<dataset_id>/`): `list_legacy` / `find_legacy` /
`find_legacy_global` scan the authoritative on-disk layout (no sqlite index,
read-only), `legacy_artifacts` declares `main_data` (primary_dataset) +
`manifest` (schema). Served through the new cache API with
`schema_ref = "gene_expression.long.legacy.v1"`. The 22 legacy columns are
proven field-identical to `gene_expression.long.v1` (test), so the wrapper
is a faithful shape match, not a re-mapping.

## Tests (red → green)

| Suite | New tests | Coverage |
| --- | --- | --- |
| `tests/test_legacy_cache_wrapper.py` | 6 | projection, namespace filter, find/global-find, unsafe ids, artifacts, column identity |
| `tests/api/test_cache_api.py` | 8 | merged list, namespace filter, keyword, v2/legacy detail, v2/legacy download, integrity 409 |
| `tests/api/test_artifact_api.py` | +4 | dual-read list/download, cache-wins-over-legacy, completed-run gate, integrity conflict |
| `tests/test_dataset_build_tool.py` | +2 | managed build dual-writes legacy surface; unmanaged skips bridge |

## Verification (all in worktree `backend/`)

| Gate | Result |
| --- | --- |
| `pytest -q` | **2698 passed, 2 skipped, 28 deselected** (baseline 2678 → +20) |
| `ruff check app/ tests/ launcher.py` | All checks passed |
| `python -c "import app.main"` | OK |
| uvicorn smoke | `/api/v1/health` ok; `/api/v1/cache/datasets` lists real build entries; unknown dataset → 404 |

## Constraints respected

- Backend only; no frontend, no live network, no new router file (routes stay
  in `app/api/routes.py` per T1 convention).
- V1 artifact surface untouched: no markers written, no V1 pipeline code
  changed; the legacy artifact API fallback is byte-for-byte the previous
  behavior for V1 tasks.
- `docs/TODO.md`: checked off the P0 V2 Dataset Cache item (API portion) and
  the P1 双读双写 item.
