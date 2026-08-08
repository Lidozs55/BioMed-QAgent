# Phase 5 — T2 Report: `geo.expression.v1` adapter + AdapterParams wiring

> Branch: `feat/phase5-geo-migration` · depends on T1 (0cd7179) · TDD red-first.
> Date: 2026-08-08 (Phase 5 spec v3)
> Scope: backend only. Frontend untouched.

## Summary

T2 delivers the `geo.expression.v1` adapter (three explicit formats selected
via typed `AdapterParams`, never inferred from file names), wires
`AdapterParams` through `SourceBinding.parameters` → Spec Validator →
`ExpressionBuildRunner`/`chain.py` → `adapter.parse(parameters=...)`, adds the
per-binding parameter scope to the executor digest (checkpoint invalidation on
format/scale/unit/platform change), and fixes the canonicalizer to consume the
adapter-declared namespace (`gene_id_namespace_declared`) instead of the
symbol-regex shape guess — removing the T1 xfail pin.

All deliverables were implemented test-first (red → green); the dataset/build
regression suites (GDC/Xena adapters, canonicalizer, chain, expression runner,
runtime executor, spec validator, tool) are fully green.

## Deliverables (all implemented + tested)

### 1. `GeoExpressionAdapter` — `backend/app/datasets/build/geo_adapter.py`

- `adapter_id="geo.expression.v1"`, `version="1.0.0"`, `source_database="geo"`;
  registered in `ADAPTER_REGISTRY` (adapters.py, end-of-module import so the
  module graph stays acyclic) and resolvable via `get_adapter`.
- `parse(..., parameters: AdapterParams)` — the base `SourceAdapter.parse`
  signature gained `parameters: AdapterParams | None = None` (threaded into
  `_extract`; GDC/Xena accept and ignore it).
- Formats (dispatched solely by `parameters.format`):
  - `tximport_counts` — TSV; header carries `counts.<sample>` columns (no gene
    column, matching real tximport layout); data rows are `gene + N values`;
    every row declared `ensembl_gene`. Missing/blank/dup `counts.` columns →
    `AdapterError`.
  - `series_matrix` — parses the `!series_matrix_table_begin/end` block;
    streaming `csv.reader`; missing block → `AdapterError`; header-only or
    all-NA block → typed `EmptySourceError`.
  - `supplementary_matrix` — delimiter `"auto"` (CSV/TSV sniff only) or an
    explicit single char; strict column-width check.
- **Scale/semantics/unit/normalized come ONLY from parameters** — never from
  file names (tested: same file parsed with `log2` vs `linear`).
- **Fail-closed**: checksum mismatch (base parse), truncated gzip (wrapped
  `OSError`/`EOFError` → `AdapterError`), bad/duplicate/blank sample headers,
  column-width mismatch, blank probe/gene ids → `AdapterError`; non-finite
  cells → rejected audit (`non_finite_value`); zero valid expression rows →
  typed `EmptySourceError` (reason_code `no_primary_data`). Partial batch
  files are removed on any failure.
- **Namespace declaration**: `gene_id_namespace_declared` per source-long row
  (tximport → `ensembl_gene`; series/supplementary ID_REF → `ensembl_gene`
  only when ENSG-shaped, else `geo_probe`) and `source_gene_id_namespace`
  batch statistic (single value, or `mixed_<sorted>`). The adapter does NOT
  map probes → genes.
- Row granularity derives from the target schema (`probe_long.v1` →
  `probe_sample_measurement`, else `gene_sample_measurement`).

### 2. `AdapterParams` plumbing

- `SourceBinding.parameters` already existed (T1). New
  `adapter_params_for_binding(binding)` helper (adapters.py) builds typed
  `AdapterParams` from a binding's declared parameters; empty → `None`
  (legacy GDC/Xena), invalid → `BuildError` (fail closed).
- **Spec Validator** (`spec_validator.py`): per-binding validation —
  `geo.expression.v1` bindings MUST declare valid `AdapterParams` (missing
  format, unknown format, inapplicable `delimiter`, unknown fields → reason
  code `invalid_adapter_parameters`); non-GEO bindings declaring parameters →
  `invalid_adapter_parameters` (not applicable).
- **`ExpressionBuildRunner._parse`** and **`chain.py`** pass
  `parameters=adapter_params_for_binding(binding)` into `adapter.parse(...)`
  (tested via a real series-matrix run through `run_operation`).

### 3. Per-binding parameter scope → operation digest

- `dataset_build_tool.py` builds `parameter_scope: {binding_id: AdapterParams
  normalized JSON}` and passes it to `DatasetBuildExecutor` (previously the
  ctor accepted `parameter_scope` but no call site populated it).
- `DatasetBuildExecutor._compute_input_digest` now folds `parameter_scope`
  into the input digest (the parameter digest already carried the scope), so
  changing any binding's format/scale/unit/platform_ids invalidates every
  checkpoint.
- Test: same binding — `log2` scope → 10 ops run; same scope again → 0 ops
  run (reuse); `linear` scope → 10 ops run (no reuse).

### 4. Canonicalizer consumes the declared namespace

- `authorize_namespace(gene_id_raw, declared_namespace="")`: when a
  declaration is present it is authoritative (`ensembl_gene` requires the
  ENSG shape + version split; `gene_symbol`/`geo_probe` accepted as declared;
  unknown declarations rejected). Without a declaration (legacy GDC/Xena
  rows) the previous shape heuristic is kept — with Affymetrix control probes
  (`AFFX-...`) excluded from `gene_symbol` — so GDC/Xena canonical output is
  byte-identical.
- `canonicalize()` passes `row["gene_id_namespace_declared"]` into
  `authorize_namespace`.
- The T1 xfail pin `test_probe_id_misclassified_by_symbol_regex_is_regression_target`
  is now green (marker removed, 0 xfail remaining).
- New tests prove consumption end-to-end: a GEO series-matrix batch
  (`AFFX-BioB-5` declared `geo_probe`) canonicalized under the gene schema
  rejects the probe rows as `unauthorized_namespace` (never `gene_symbol`),
  and a tximport batch (declared `ensembl_gene`) canonicalizes cleanly.

## Tests (red-first per deliverable)

New/updated (97 targeted tests green):
- `tests/test_geo_adapter.py` (new, ~20 tests): registry resolution; three
  formats minimal inputs; missing `counts.` columns; missing table block;
  duplicate sample headers; column-width mismatch; non-finite audited;
  zero-valid-rows / header-only `EmptySourceError`; truncated gzip;
  checksum mismatch; supplementary explicit delimiter; scale-from-parameters
  only; missing/unknown/inapplicable AdapterParams rejected; requires-params
  fail-closed.
- `tests/test_spec_validator.py` (+6): valid GEO params pass; missing
  params / unknown format / inapplicable delimiter / unknown field rejected
  with `invalid_adapter_parameters`; non-GEO binding with params rejected.
- `tests/test_dataset_runtime.py` (+1): per-binding AdapterParams scope gates
  reuse (log2→log2 reuse, log2→linear rerun).
- `tests/test_dataset_expression_runner.py` (+1): `run_operation` forwards
  binding.parameters to the GEO adapter (batch carries declared
  format/semantics/scale/unit).
- `tests/test_dataset_canonicalizer.py`: xfail marker removed (now green) +
  2 declared-namespace consumption tests.

## Verification

```
uv run pytest -q                        # my scope + dataset suites: 261 passed (dataset suite)
                                        # full suite (excluding the other agent's broken
                                        # collection file): 2504 passed, 0 xfail
ruff check <my files>                   # All checks passed
python -c "import app.main"             # OK (exit 0)
```

- GDC/Xena regression: `test_dataset_adapters.py` (24 tests incl.
  `test_source_long_carries_declared_namespace_column`) + canonicalizer gene
  schema output unchanged — all green.
- **Zero xfail** remain (T1's single xfail is now a passing test).

## Concerns / notes for downstream tasks

- **Concurrent worktree WIP**: another agent's Phase 5 T3 work is present
  (uncommitted): `app/pipeline/processing/geo_association.py`,
  `geo_provider.py`, modified `base.py`/`processing.py`/`geo_annotation.py`/
  `geo_tximport.py`/`runner.py`/`acquisition.py`/`artifact_build/builder.py`,
  new `tests/pipeline/test_geo_provider.py` +
  `test_geo_platform_association.py`. That WIP currently breaks pytest
  collection of `tests/agent_loop/test_agent_build.py` (circular import:
  `base.py` → `app.datasets.contracts` → `app.datasets/__init__` →
  `schema_registry` → `artifact_build` → `base`) and fails
  `test_pipeline_e2e.py::test_e2e_cancel_before_validation_stops_pipeline`
  (`platform_records` kwarg). None of those files are part of this commit;
  the T3 agent owns those fixes. This commit was staged by explicit path to
  avoid grabbing the other agent's files.
- **Probe-schema canonicalization is not in T2 scope**: `canonicalize()` with
  `gene_expression.probe_long.v1` still writes `gene_id`/`probe_id` via the
  gene-column path (probe_id/platform_id/value mapping and the probe
  normalization profile are T4/T5/T7). No current test exercises that path.
- **SpecValidator is still not wired into `dataset_build_tool.py`**
  (pre-existing state; T5/T7). T2 adds the tool-level fail-closed guard for
  invalid parameters (returns `invalid_input`) and the Spec Validator
  rules + tests.
- **Batch statistics carry `source_gene_id_namespace`** (informational,
  single or `mixed_*`); the canonicalizer consumes the per-row declared
  column (authoritative mechanism), per D1.
- `_compute_input_digest` now includes `parameter_scope` (empty dict for
  builds without parameters) — deterministic, so checkpoint digests remain
  stable within the same parameter scope.
