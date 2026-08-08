# T3 Report — GEO acquisition/platform provider + platform→sample association

**Phase**: 5 (GEO migration) · **Task**: T3 (D1 provider boundary, D8 platform→sample association)
**Branch**: `feat/phase5-geo-migration` (base = T1 `0cd7179`)
**Status**: DONE — all gates green

## Deliverables

1. **`geo.series.v1` / `geo.platform.v1` provider layer** — new module
   `backend/app/pipeline/processing/geo_provider.py` (ordinary module functions +
   explicit `resolve_provider(provider_id)` dispatcher; **no plugin registry**):
   - Accession validation (`normalize_series_accession` / `normalize_platform_accession`)
   - Series + platform URL construction mirroring the verified V1 NCBI layouts
   - `acquire_series_asset(...)` — fail-closed download wrapper (max-bytes,
     expected sha256 / size) over `integrations.acquisition.acquire_source`
   - `acquire_platform_annotation(...)` — GPL annotation acquisition with a
     `max_bytes` cap + content cache (fixture mode reads
     `{fixture_dir}/platforms/{gpl}_annot.txt.gz`, no network)
   - `select_series_fixture_assets` / `select_platform_fixture_asset` fixture selection
   - `build_platform_record` / `platform_not_attempted_record` — D3 `PlatformRecord`
     construction per GPL attempt

2. **D8 platform→sample association** — new module
   `backend/app/pipeline/processing/geo_association.py`:
   - `parse_series_matrix_platform_evidence` / `parse_soft_platform_evidence`
     (per-GSM `!Sample_platform_id` evidence; both gated on `GSM\d+`/`GPL\d+`)
   - `associate_platforms(...)` → `PlatformAssociation` with modes:
     `SINGLE_PLATFORM` (unanimous evidence or the narrow series-level fallback),
     `PER_PLATFORM_SPLIT` (per-sample maps), `FAIL_CLOSED_NO_EVIDENCE`
     (multi-GPL with zero per-sample evidence → no map, status
     `multi_platform_fail_closed`), `NO_PLATFORM` (→ `not_attempted`)
   - `sample_platform_evidence` audit rows (deterministic, sorted)

3. **`_load_geo_gene_map` convergence** (`processing.py`) — now returns a
   `GeoGeneMapResult` (gene_map / sample_gene_maps / probe_gene_mapping /
   platform_records / sample_platform_evidence). Iterates GPLs per the D8
   association evidence, records one `PlatformRecord` per GPL attempt
   (mapped/unmapped/no_gene_annotation/annotation_unavailable/not_attempted),
   and never applies GPL A's annotation to GPL B samples. Declared-but-
   unattributed GPLs are recorded `not_attempted` (no guessing).

4. **Parser per-sample mapping** (`geo_tximport.py`) —
   `process_geo_series_matrix_expression` gained `sample_gene_maps`; when
   provided it takes precedence over `gene_map` and each row uses only its
   sample's GPL annotation.

5. **Audit into artifacts** — `ProcessingOutput` carries `platform_records` +
   `sample_platform_evidence`; the artifact build writes
   `platform_audit.csv` + `sample_platform_evidence.csv` **only when** a live
   GEO run produced them (historic artifact sets unchanged; both default to
   `ArtifactRole.AUDIT_REPORT`). Runner threads the fields.

6. **V1 refactor** (`acquisition.py`) — URL builders + `_run_acquisition_fixture`
   delegate to the provider; **V1 fallback ORDER unchanged** (counts → soft →
   matrix → suppl). `_try_acquire` keeps calling `acquire_source` directly to
   preserve the existing test seam.

## Fixture strategy

- Tests copy-directory the shared `tests/fixtures/ncbi/gse178352/` into a tmp
  dir (`shutil.copytree`), then add a minimal platform-annotation asset under
  `platforms/{gpl}_annot.txt.gz` and a synthetic two-GPL series matrix —
  the shared fixture is never modified, and no test touches the live network.
- Synthetic matrix: GSM9000001-2 declare GPL90001, GSM9000003-4 declare
  GPL90002; GPL90001 maps PROBE1→GENE_AB, GPL90002 maps PROBE1→GENE_XY
  (same probe, different genes) to prove cross-application is impossible.

## Red-first tests (30 new)

`tests/pipeline/test_geo_provider.py` (11) — provider ids resolve; unknown id
rejected; series/platform URL prefixes; accession validation; fixture asset
selection (series + platform); checksum mismatch / size limit / expected-size
mismatch fail closed; success forms a SourceAsset; V1 fixture
acquisition→processing regression.

`tests/pipeline/test_geo_platform_association.py` (19) — evidence parsing
(series matrix + SOFT), all association modes, per-sample evidence wins over
declared, GPL A mapping NEVER applied to GPL B samples (loader + parser
end-to-end), multi-GPL without evidence → `multi_platform_fail_closed`,
single-platform whole-series fallback, SOFT unanimous evidence, all platforms
unavailable → `annotation_unavailable`, no GPL → `not_attempted`,
PlatformRecord cross-field contract round-trip, run_processing live-mode
wiring (mocked annotation), artifact-build audit CSVs.

## Verification

- `pytest -q` (backend): **2518 passed**, 2 skipped, 28 deselected (baseline
  2458; +30 new, +28 existing GEO/e2e regressions re-verified).
- `ruff check app/ tests/ launcher.py`: clean.
- `python -c "import app.main"`: OK.
- Frontend untouched. T2-owned files (`adapters.py`, `expression_runner.py`,
  `chain.py`, `canonicalizer.py`) untouched.

## Notes / seams for later tasks

- **T2 seam (not modified)**: V2's `GeoExpressionAdapter` may want to reuse
  `geo_provider`'s URL/fixture/download helpers and the D8 association; the
  provider module is import-safe (no V2 deps). The `sample_gene_maps`
  per-sample parser semantics are the V1 analog of the per-platform binding
  split T7 needs.
- **`mapping_source_url` is None in fixture mode** (bytes come from a local
  fixture, not a fetched URL); live mode records the real annotation URL.
- **`annotation_asset_id` is None in V1** — V1 keeps annotations in the
  content cache and does not publish them as SourceAssets; asset-id wiring is
  V2/ProbeMappingSummary territory (T7).
- **Non-symbol gene columns** (e.g. REFSEQ/GB_ACC fallbacks in
  `_GENE_COLUMN_PRIORITY`) are recorded with `target_namespace="gene_symbol"`
  because V1's parser labels every mapped row `gene_id_namespace="gene_symbol"`
  (documented legacy behavior; V2 canonicalization owns honest namespaces).
- **`multi_platform_fail_closed`** is a new aggregate status recorded in
  `processing_parameters["probe_gene_mapping"]`; it triggers the same
  `geo_probe_unmapped` artifact warning as the other no-mapping statuses.
- The tximport-counts topology (fixture + live success paths) never calls
  `_load_geo_gene_map` — ENSG ids need no GPL annotation; PlatformRecords are
  produced only on the live series-matrix / SOFT-fallback paths.

## Commits

- T3 (this task): see commit message below.
