# Phase 5 — T1 Report: GEO contracts + entity-level columns

> Branch: `feat/phase5-geo-migration` · DAG root (T1 has no dependencies) · TDD red-first.
> Date: 2026-08-08 (Phase 5 spec v3)
> Scope: backend only. Frontend untouched.

## Summary

T1 delivers the contract layer and entity-level column groundwork required by
every downstream Phase 5 task (T2–T7 all depend on T1). All deliverables were
implemented test-first (red → green) and the full backend gate is green.

## Deliverables (all implemented + tested)

### 1. Contracts — `backend/app/datasets/contracts.py`

| Contract | Details |
| --- | --- |
| `ValueScale` (StrEnum) | `linear \| log2 \| log10 \| unknown` (spec D3). `unknown` is a legitimate honest value; `raw_count` is a semantics, not a scale. |
| `AdapterParams` (ContractModel, extra=forbid) | `format` Literal (tximport_counts/series_matrix/supplementary_matrix), `value_semantics`, `value_scale`, `expression_unit`, `is_normalized=False`, `platform_ids` (`^GPL\d+$` each), `delimiter="auto"`. Validators: GPL pattern per platform_id; delimiter is `"auto"` or single-char; delimiter only for `supplementary_matrix`. |
| `AnnotationStatus` (StrEnum) | `mapped \| unmapped \| no_gene_annotation \| annotation_unavailable \| not_attempted`. |
| `PlatformRecord` (ContractModel) | Per spec D3 field table + cross-field validators: `not_attempted` ⇒ asset/url/sha all None; asset present ⇒ sha present + 64-hex + status ∈ {mapped, unmapped, no_gene_annotation}; `mapped` ⇒ `target_namespace` + `gene_id_field` non-None; `platform_id` `^GPL\d+$`; `target_namespace` restricted to `gene_symbol\|ensembl_gene`. |
| `ProbeMappingStatus` (StrEnum) | `mapped \| partial \| unmapped \| no_gene_annotation \| annotation_unavailable \| not_attempted`. |
| `ProbeMappingSummary` (ContractModel) | Per spec D3: `mapped+unmapped==total`; `ambiguous<=unmapped`; `0<=mapped<=total`; `coverage_ratio==mapped/total` (total=0→0.0, tol 1e-9); status↔count consistency (mapped⇒1.0, partial⇒0<cov<1, unmapped⇒0.0, not_attempted⇒counts 0 + asset/rule None); mapped/partial ⇒ `mapping_asset_id` non-None; `source_namespace` fixed `geo_probe`. |
| Serialization invariants | `model_dump → model_validate` round-trip fidelity (extra=forbid ⇒ no field loss/gain); JSON round-trip preserves `coverage_ratio` precision (1e-9); empty/all-zero objects serialize. |

The `annotation_asset_id` ↔ `SourceAsset.sha256` bidirectional consistency
invariant (spec D3) is intentionally NOT enforced inside `ProbeMappingSummary`
(T1 has no asset handle); it is enforced where the asset is available (T3/T7).

### 2. Schema Registry — `backend/app/datasets/schema_registry.py`

- `build_probe_expression_schema()` registers `gene_expression.probe_long.v1`:
  - `dataset_family="gene_expression"`, `row_granularity="probe_sample_measurement"`,
    `primary_key=["probe_id", "platform_id", "sample_id"]`.
  - Field list per spec D2 (entity-level mirror of the 22-column gene schema):
    `probe_id`, `platform_id`, `sample_id`, `value`, `gene_id_namespace`
    (geo_probe + gene namespaces), `value_semantics`, `value_scale`,
    `expression_unit`, `is_normalized`, plus source-long provenance columns
    (`record_id`, `dataset_id`, `source_id`, `asset_id`, `is_integer_expected`,
    `source_sample_alias`, `measurement_type`, `source_*`, and the internal
    `gene_id_namespace_declared`).
  - No `gene_id`/`gene_symbol`/`ensembl_gene` primary column (gene-level concept).
  - Registered the same way as `gene_expression.long.v1` (builder function +
    `SchemaRegistry([...])`); also re-exported from `app/datasets/__init__.py`.
- `DatasetBuildSpec.target_entity_level: Literal["gene","probe"] | None = None`
  (D2). Spec Validator maps registered row_granularity → entity level
  (`gene_sample_measurement`→gene, `probe_sample_measurement`→probe); a set
  `target_entity_level` inconsistent with the selected schema is rejected with
  reason code `entity_level_schema_mismatch` (spec error / invalid_input).

### 3. Source-long declared namespace — `backend/app/datasets/build/adapters.py`

- `SOURCE_LONG_COLUMNS` now carries the internal `gene_id_namespace_declared`
  column (after `gene_id_raw`). Canonical schema output keeps
  `gene_id_namespace` authoritative.
- Canonicalizer fix (required by the new column, test-driven): canonical rows
  are now filtered to the schema's column set before writing, so internal
  source-long columns that the schema does not declare (e.g.
  `gene_id_namespace_declared`) never leak into the published contract.
  Behavior for the gene schema is unchanged (row keys were a subset of schema
  columns before; only the new internal column is now filtered out).
- **Canonicalizer namespace inference is NOT fixed in T1** (that is T2). The
  current shape heuristic (`authorize_namespace`, canonicalizer.py:88-96) is
  pinned by an xfail regression test:

  `test_probe_id_misclassified_by_symbol_regex_is_regression_target`
  (test_dataset_canonicalizer.py) — proves `AFFX-BioB-5` is currently
  misclassified as `gene_symbol` and `1007_s_at` is wrongly rejected; marked
  `xfail(reason="T2 fix target")` so the gate stays green until T2 replaces
  the heuristic with the declared column.

## Tests (red-first per deliverable)

New tests added (36 passing + 1 xfail):
- `tests/test_dataset_contracts.py` (+29): ValueScale members; AdapterParams
  (minimal valid, unknown scale, bad format, non-GPL platform, multi-char
  delimiter, delimiter outside supplementary, extra-field rejection, empty
  semantics/unit); PlatformRecord (GPL pattern, not_attempted forbids
  asset/url/sha, asset⇒sha+64hex+mappable status, mapped⇒target+gene field,
  target_namespace allowlist); ProbeMappingSummary (count balance, ambiguous⊆
  unmapped, mapped≤total, coverage consistency, status↔count matrix,
  not_attempted zero-state, mapped/partial⇒asset, geo_probe source_namespace);
  serialization invariants (dict + JSON round trips, precision, all-zero
  legal); `target_entity_level` field accept/reject.
- `tests/test_schema_registry.py` (+3): probe schema registered with
  granularity/PK/field list, gene+probe coexist, PK fields required +
  `value.unit_policy`.
- `tests/test_spec_validator.py` (+3): probe schema selectable by Spec
  Validator; entity-level/schema mismatch rejected in both directions;
  unset target_entity_level always consistent.
- `tests/test_dataset_adapters.py` (+1): `gene_id_namespace_declared` in
  `SOURCE_LONG_COLUMNS`.
- `tests/test_dataset_canonicalizer.py` (+1 xfail): probe-ID misclassification
  regression pin (T2 target).

## Verification (final gate, from `backend/`)

```
uv run pytest -q        # 2458 passed, 2 skipped, 28 deselected (live), 1 xfailed
ruff check app/ tests/ launcher.py   # All checks passed
python -c "import app.main"          # OK
```

Baseline before T1: 2412 passed → +46 passing tests (incl. 36 new T1 tests;
the remaining delta comes from deselection arithmetic on live markers) and the
single intended T1 xfail. GDC/Xena regression suites (adapters, canonicalizer,
integrator, manifest, chain, expression runner) all green.

## Concerns / notes for downstream tasks

- **T2 must remove the xfail marker** and fix `authorize_namespace` to consume
  `gene_id_namespace_declared` (plus consume `source_gene_id_namespace` in
  batch statistics). T2 should also decide whether the adapter writes the
  declared column value (GDC/Xena rows currently write it empty — valid, since
  their IDs are gene IDs, but T2 should populate it for GEO).
- **T4 owns `NormalizationProfile.allowed_value_scales`** — T1 deliberately
  only adds the `ValueScale` enum (spec §4 D3 / task boundary); the profile
  field is a T4 deliverable.
- **T5 owns `required_entity_level` on ValidationProfile** — T1 adds the
  spec-level `target_entity_level` and its schema-consistency check only;
  profile compatibility (`gene` build + `probe` profile → invalid_input) is T5.
- **SpecValidator is not yet wired into `dataset_build_tool.py`** (pre-existing
  state); T1 extends the validator + tests but does not change tool wiring,
  which the runtime adopts in T5/T7 along with `SchemaRegistry` including the
  probe schema.
- `delimiter` on `AdapterParams` is validated as `"auto"` or single-char;
  "auto" only recognizes CSV/TSV (T2 adapter), never infers scale/semantics.
- `SOURCE_LONG_COLUMNS` column-count consumers (`column_count`,
  header assertions) all derive from the tuple dynamically — verified green.
