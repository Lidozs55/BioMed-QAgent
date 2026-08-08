# T7 Report — GEO mapping-failure / empty-expression E2E: per-binding fan-out, NO_DATA-with-audit, classifier reason code, ProbeMappingSummary emission

> Phase 5 (GEO migration), branch `feat/phase5-geo-migration`
> TDD: red first → fix → green. Backend only; frontend untouched.
> Spec: `docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md` §4 D5, §5 T7.
> Base: `ba6e779` (T5 + T8). **Phase 5 T6 was merged by the controller while T7 was in flight**
> (commit `887b234`); the final merge (`687e32a`) combines T6 + T7 on
> `feat/phase5-geo-migration` with no conflicts. T7's seams do not overlap
> T6-owned files (`multi_build.py`, `discovery.py`, `acquisition.py`, `relations.py`).

## Deliverables

### 1. Per-binding fan-out (executor + runner) — `executor.py`, `expression_runner.py`

- `DatasetBuildExecutor` gains a shared `per_binding_outcomes: dict[binding_id, BindingRejection]` map (new `BindingRejection`/`BindingRejectionKind` contracts in `contracts.py`, `BindingRejectedError` in `errors.py`).
- `_run_plan` restructured into the two-phase topology: phase A (acquire/parse/canonicalize) executes per binding; a binding's `EmptySourceError` (→ `no_primary_data`), parse/structure failure (`AdapterError` → `parse_error`), `BuildError` (→ `build_error`) or runner-raised rejection is **captured as a per-binding rejection** (`BindingRejection`), the binding's remaining phase-A ops are skipped, and the other bindings continue. Phase B (gate/integrate/validate/publish) receives only phase-A successes; **when every binding is rejected phase B is skipped entirely** and the outcome carries `reason_code` + serialized `per_binding_outcomes` in the error details.
- Red tests: two bindings one empty → build **completes** with the other binding's data; both empty → failed outcome `no_primary_data` with no `merged/primary.csv` (phase B never ran); a parse error in one binding does not abort the other. Existing single-binding GDC/Xena path byte-identical (their tests green).
- Upstream/digest plumbing: `_available_upstream()` skips missing upstream outputs of rejected bindings (gate digest reflects only surviving bindings).

### 2. Pipeline/tool split for gene-required outcomes (D5 rows) — `expression_runner.py` + `dataset_build_tool.py`

- **Runner (pipeline)**: after canonicalization, a binding with **zero valid rows** is rejected per-binding (`no_primary_data`); for **gene-required** profiles a binding with rows but **zero publishable gene rows** (all `geo_probe`) is rejected with the stable reason `probe_mapping_unavailable_required_gene_level`. Rejected bindings' canonical/mapping audits stay on disk (4b audit survival); provenance/closure and source accounting only cover phase-A successes. Rows exist but coverage < 1.0 (partial mapping) flows through integration → gene Profile FAILED → publish refused (primary not published; supporting/audit already staged).
- **Tool (`_classify_failed_outcome`)**: inputs extended to `(outcome_error, per_binding_outcomes, profile_required_entity_level)` (keyword-only; no more reliance on the `no_primary_data` substring alone). Emits:
  - all-rejected → NO_DATA (all-empty keeps `["no_primary_data"]`; all zero-gene-rows keeps `["probe_mapping_unavailable_required_gene_level"]`; mixed reasons are binding-scoped `no_primary_data:<id>` / `parse_error:<id>`);
  - gene-required + validation report `probe_coverage_required_gene_level` failed (rows exist, coverage < 1.0) → NO_DATA with `probe_mapping_unavailable_required_gene_level`;
  - probe-level builds never take the gene branch (they publish the honest probe primary, D5 row 2, no reason code).
- **Success path**: `successful_sources` = phase-A successes, `rejected_sources` = per-binding rejections; status is **PARTIAL_SUCCESS when a genuinely publishable surviving source exists and others were rejected**, SUCCEEDED otherwise (wave-7: an aborted mixed build is never PARTIAL_SUCCESS; only a publishable surviving source yields partial/success).

### 3. ProbeMappingSummary emission — new `probe_mapping.py` + `canonicalizer.py` + `expression_runner.py`

- New pure module `backend/app/datasets/build/probe_mapping.py`: SOFT platform-table parser (mirrors V1 `geo_annotation` gene-column priority + missing-value sentinels), probe→gene map, D3-compliant counts (distinct probes, never gene×sample rows), contract-valid `ProbeMappingSummary` (mapped/partial/unmapped/no_gene_annotation/annotation_unavailable) and the mapping-detail audit CSV (`canonical/<binding_id>_probe_mapping.csv`, D3 columns).
- `ExpressionBuildRunner` accepts optional `mapping_assets`/`mapping_paths`; `_canonicalize` builds the mapping, re-namespaces mapped rows (via `canonicalize(..., probe_map=, probe_target_namespace=)`), and emits a `not_attempted` summary for probe bindings without an asset. `_validate_profile` passes the summaries to `profile.validate(probe_mapping_summaries=...)` (feeding T5's `probe_coverage_required_gene_level` in the real chain) and writes `probe_mapping_summaries.csv` into the audit set.
- **Semantic correction required for D2/D5**: `geo_probe` is now an allowed canonicalization namespace (normalization profile); the entity-level publish policy (residual `geo_probe` rows fail the gene release gate) lives in the validation profile (T5's `probe_coverage_required_gene_level`), not the canonicalizer. The T1-era canonicalizer test pinning "geo_probe rejected as unauthorized_namespace" was updated accordingly.
- Probe-schema support so probe-level builds publish end-to-end: canonicalizer emits `probe_id`/`platform_id`/`value` under `gene_expression.probe_long.v1` (probe_id stays the original probe; mapping flips the namespace only), integrator row identity uses `probe_id`, profile value-column derived from schema metadata (`unit_policy="declared_per_record"` → `value` vs `expression_value`).
- Red tests: real geo build + mapping asset → summary consumed by the profile check (gene profile partial coverage → `coverage_below_1.0=['binding_geo']`; probe profile partial → `probe_coverage` warning 0.5000); probe build publishes mixed namespaces (mapped `gene_symbol` + unmapped `geo_probe`); gene-required full coverage publishes.

### 4. E2E (tool level, copy-dir pattern, no live network) — `test_dataset_build_tool.py`

| D5 row | E2E test | Outcome |
| --- | --- | --- |
| 1 (a) | empty GEO tximport (header-only counts columns) | NO_DATA `no_primary_data`, no primary, `publication_id=None`, no publish dir |
| 1 (a) | corrupted GEO tximport (missing `counts.*` columns) | NO_DATA `parse_error:binding_geo` (never a generic retryable error) |
| 2 (b) | probe-level build, zero mapped coverage | SUCCEEDED probe primary + `probe_coverage` warning + audits, no reason code |
| 3 (c) | gene-required, geo probe source with zero gene rows | NO_DATA `probe_mapping_unavailable_required_gene_level`, audits preserved |
| 3 (d) | gene-required multi-binding: failed GEO binding + usable GDC | PARTIAL_SUCCESS (successful `binding_gdc`, rejected `binding_geo`), GEO canonical audits preserved, manifest lists only the surviving source |
| — | mixed empty + usable (updated B5/K2 test) | PARTIAL_SUCCESS (old abort-at-first-empty NO_DATA semantics replaced by per-binding fan-out) |

## Files changed

- `backend/app/datasets/contracts.py` — `BindingRejectionKind`, `BindingRejection`
- `backend/app/datasets/build/errors.py` — `BindingRejectedError`
- `backend/app/datasets/runtime/executor.py` — per-binding fan-out, `AllBindingsRejectedError`, `_available_upstream`, outcome details
- `backend/app/datasets/build/expression_runner.py` — mapping assets, ProbeMappingSummary emission + audit, per-binding rejection, filtered provenance/sources, summaries→profile
- `backend/app/datasets/build/canonicalizer.py` — `probe_map`/`probe_target_namespace`, probe-schema columns, `probe_mapped_count`
- `backend/app/datasets/build/profiles.py` — `geo_probe` namespace, schema-derived value column
- `backend/app/datasets/build/integrator.py` — probe row identity
- `backend/app/datasets/build/probe_mapping.py` — **new** mapping module
- `backend/app/pipeline/dataset_build_tool.py` — classifier extension, success path PARTIAL_SUCCESS, probe schema registry
- tests: `test_dataset_expression_runner.py` (+7), `test_dataset_build_tool.py` (+5, 2 updated), `test_dataset_canonicalizer.py` (1 updated), `test_dataset_probe_mapping.py` (**new**, +8)

## Verification

- `pytest -q` (backend): **2603 passed, 2 skipped, 28 deselected** (baseline 2583; +20 new)
- `ruff check app/ tests/ launcher.py`: clean
- `python -c "import app.main"`: OK
- uvicorn startup smoke: `/api/v1/health` 200 OK after `__pycache__` clear
- Frontend untouched.

## Concerns / notes

- **T6 merged mid-flight**: Phase 5 T6 (multi-GSE orchestration, inverse relations, raise-not-truncate, `887b234`) was landed by the controller while T7 was in progress; the phase5 branch now carries T6 + T7 together (merge `687e32a`) and the combined suite is green (2631 passed).
- **All-rejected parse failures now NO_DATA**: a structurally-corrupted source (AdapterError) is now a per-binding `parse_error` rejection; when every binding is rejected the tool emits a NO_DATA envelope with the binding-scoped code instead of the old generic retryable-error envelope. This matches the D5 E2E (a) corrupted-asset expectation and the 4b fixture semantics (corrupted asset → no primary). `test_no_data_classification_is_scoped_to_current_attempt` was updated: classification is driven by per-binding outcomes (attempt-scoped by construction), so a stale manifest can never misclassify a later run.
- **Partial-coverage multi-binding nuance**: the partial policy applies when a binding is rejected at phase A (empty/parse/zero-gene-rows) and a surviving source publishes. When two bindings both parse with rows and one carries residual probe rows under a gene-required profile, the gene release gate fails the whole build (residual-row integrity rule, D4/T5) → NO_DATA with the probe code. Excluding a partial-coverage binding's rows from the merged primary is not implementable with the append integrator and is not required by the D5 matrix rows.
- **V2 does not (yet) accept mapping assets through the tool interface**: `mapping_assets`/`mapping_paths` are wired at the `ExpressionBuildRunner` seam (used by the runner-level D3 tests); the Agent-facing tool interface is unchanged (no mapping_files param) per the T7 seam list. A future task can thread mapping assets through `source_files` if live GEO probe builds need them at the tool boundary.
- **`geo_probe` namespace semantics moved to validation**: probe rows now pass canonicalization under any schema; the gene profile fails residual `geo_probe` rows (T5 `probe_coverage_required_gene_level`), the probe profile publishes them. This is the D2/D5 entity-level enforcement point and changes one T1-era canonicalizer assertion (updated).
- **PlatformRecord is not emitted by the V2 chain** (T7 delivers ProbeMappingSummary + mapping-detail audits; PlatformRecord provenance/audit emission remains V1/T3 territory and a possible Phase 7 item for the V2 manifest).
