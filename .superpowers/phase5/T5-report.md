# T5 Report — GEO Compatibility Gate matrix + coverage Profile policy + required_entity_level enforcement

> Phase 5 (GEO migration), branch `feat/phase5-geo-migration`
> TDD: red first → fix → green. Backend only; frontend untouched.
> Spec: `docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md` §4 D4/D5, §5 T5.

## Deliverables

### 1. Gate matrix tests (D4 table, every row) — `tests/test_dataset_compat_gate.py`

New D4 matrix tests (11 added, 7 existing rows kept green):

| D4 row | Test |
| --- | --- |
| single GEO, family/granularity/schema/mapping legal | existing `test_single_source_passes`, `test_compatible_gdc_xena_merge_passes` |
| family/granularity/schema mismatch | existing `test_family_mismatch_rejected`, `test_schema_mismatch_rejected` (+ granularity via `test_probe_and_gene_schema_sources_rejected`) |
| missing formal mapping evidence | existing `test_missing_mapping_evidence_rejected` |
| cross-source, identical identity, single namespace | existing compatible merge + `test_probe_level_two_probe_sources_compatible` |
| log2 vs linear / semantics / unit divergence | `test_log2_vs_linear_identity_mismatch` |
| **unknown × unknown cross-source** | `test_unknown_scale_cross_source_merge_rejected` — **red first**: current gate passed (single identity set); fix: `check_expression_compatibility` now rejects any cross-source merge where a non-empty source declares an unknown scale (`measurement_identity_mismatch`) unless a server evidence-backed rule exists (Phase 5 registers none). |
| known × unknown cross-source | `test_known_and_unknown_scale_cross_source_rejected` |
| single source scale unknown | `test_unknown_scale_single_source_passes` (publishable; honest `unknown`) |
| gene-level + residual geo_probe | `test_probe_level_build_mixed_namespace_sources_rejected` (`namespace_mismatch`) |
| probe-level build vs probe-level build, same identity | `test_probe_level_two_probe_sources_compatible` |
| probe-schema source vs gene-schema source | `test_probe_and_gene_schema_sources_rejected` (`schema_mismatch` + `granularity_mismatch`) |
| one source NO_DATA, another non-empty | `test_empty_source_does_not_forge_identity` (empty source contributes no identity; structural checks only) |
| all sources empty | `test_no_results_reports_no_sources` (empty result list → `no_sources`) + `test_all_empty_sources_never_fabricate_identity` (all-empty results: no identity/namespace fabrication; the chain's `source_yielded_no_rows` and the runner's validation-failure NO_DATA path deliver the matrix's "typed NO_DATA" alternative — the gate must NOT hard-fail here because the runner treats gate failure as a retryable error, and `expression_runner.py` is out of T5 seam scope) |
| V1 allowlist unchanged | `test_v1_pipeline_allowlist_unchanged` (pins `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS`; GEO never merges with GDC/Xena in the deterministic pipeline) |

Gate change (`app/datasets/build/compat_gate.py`): new `_source_has_unknown_scale()` helper — reads per-row `measurement_identities` (via `MeasurementIdentity.deserialize`) and falls back to the batch-level `value_scale` statistic; cross-source (`len(results)>1`, non-empty) with any unknown scale → `measurement_identity_mismatch`. Single-source builds untouched.

### 2. Coverage Profile policy — `app/datasets/build/profiles.py` (+ tests)

- `ExpressionValidationProfile.validate()` gains keyword-only `probe_mapping_summaries: list[ProbeMappingSummary] | None = None` (backward compatible; chain/runner callers unchanged).
- Gene profile (`gene_expression.release.v1`, `required_entity_level="gene"`): new stable check **`probe_coverage_required_gene_level`** — coverage must be 1.0 for every binding with probes (from `ProbeMappingSummary.coverage_ratio`) AND zero residual `geo_probe`/ambiguous rows in the primary (ambiguous probes stay `geo_probe` per D2, so one scan covers both). Any violation → FAILED, primary not published. Builds with no probes (GDC/Xena) unaffected.
- Probe profile (`gene_expression.probe_release.v1`): coverage (0 included) is warning-only — `probe_coverage` warning entries (data_confidence-style), never blocks release.
- Red tests: gene-required coverage 0.8 → FAILED; gene-required coverage 0 → FAILED; residual geo_probe row in primary → FAILED; gene profile zero probes → passes; probe profile coverage 0 → PASSED with `probe_coverage` warning.
- Updated `test_valid_primary_passes` check count 9 → 10 (new D4 check).

### 3. SpecValidator — thresholds cannot be smuggled via binding parameters

`tests/test_spec_validator.py`:
- `test_geo_binding_coverage_threshold_rejected` — `coverage_threshold` in AdapterParams → `invalid_adapter_parameters`.
- `test_geo_binding_entity_policy_parameter_rejected` — `required_entity_level` in AdapterParams → `invalid_adapter_parameters`.
(AdapterParams is `extra="forbid"`; these pin the rejection. `target_entity_level` vs profile `required_entity_level` compatibility (`entity_level_profile_mismatch`) was already delivered in T4.)

### 4. Regression
Existing matrix rows (family/granularity/schema/missing-mapping-evidence/unit/namespace), chain/runner/tool NO_DATA paths, and identity tests all stay green.

## Files changed
- `backend/app/datasets/build/compat_gate.py` — unknown-scale cross-source rule
- `backend/app/datasets/build/profiles.py` — coverage check + probe warning policy + validate signature
- `backend/tests/test_dataset_compat_gate.py` — D4 matrix (+11), V1 allowlist pin
- `backend/tests/test_dataset_profiles.py` — coverage policy (+5), check-count update
- `backend/tests/test_spec_validator.py` — threshold-smuggling pins (+2)

## Verification
- `uv run pytest -q`: **2583 passed, 2 skipped, 28 deselected** (baseline 2565 → +18)
- `uv run ruff check app/ tests/ launcher.py`: clean
- `python -c "import app.main"`: OK
- uvicorn startup smoke: `/api/v1/health` 200 OK after `__pycache__` clear
- Frontend untouched.

## Concerns / notes
- The gate deliberately does NOT hard-fail all-empty results with `no_sources`: the runner (`expression_runner.py`, T2/T7-owned, out of T5 seam scope) maps a gate failure to a retryable error, so an all-empty gate rejection would break the existing NO_DATA classification (`test_no_data_classification_is_scoped_to_current_attempt`). The D4 row's "typed NO_DATA" alternative is delivered by the chain (`source_yielded_no_rows`) and the runner's validation-failure NO_DATA path. If T7's per-binding fan-out keeps the gate from ever seeing empty results, a pure gate `no_sources` for all-empty can be added then.
- The V2 build chain does not yet produce `ProbeMappingSummary` objects (mapping stats live in T2 batch statistics / T3 PlatformRecord); the profile's summary-driven branch is exercised directly by tests, and the residual-row scan gives the gene profile a summary-independent ground truth in production. Wiring canonicalizer/runner to emit `ProbeMappingSummary` is T7's seam.
- `git status` shows a pre-existing unstaged `backend/.venv` deletion (tracked blob artifact from an earlier commit); left untouched and excluded from the T5 commit.
