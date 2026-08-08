# Phase 5 Final Whole-Phase Review — GEO Migration

> Reviewer: final whole-phase reviewer (read-only; no files modified)
> Branch: `feat/phase5-geo-migration` (18 commits: spec v1→v3 + T1–T8)
> Spec: `docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md` (v3)
> Evidence: task reports T1–T8, code seam inspection (file:line cited), spot test runs
> (135 + 181 targeted Phase 5 tests green), controller-verified full gate
> (2631 passed, ruff clean, import OK, uvicorn smoke OK).

---

## A. §6.1 Design §16 — VERIFIED

| Criterion | Evidence |
| --- | --- |
| gene/probe 清楚区分 | `schema_registry.py:174-230` probe_long.v1 with `probe_sample_measurement` + PK `(probe_id, platform_id, sample_id)`; `contracts.py:264-268` `target_entity_level`; `geo_adapter.py:60-63` per-row `gene_id_namespace_declared` (ENSG-shape only → `ensembl_gene`, else `geo_probe`); `canonicalizer.py:95-125` `authorize_namespace` consumes the declaration (never shape-guesses probes into `gene_symbol`); `compat_gate.py:76-80` granularity/schema reasons split probe vs gene |
| 无映射发布策略明确 | D5 four rows E2E: `test_dataset_build_tool.py` — empty tximport → NO_DATA `no_primary_data`, corrupted → NO_DATA `parse_error:binding_geo`, probe-level coverage 0 → SUCCEEDED + `probe_coverage` warning + audits, gene-required coverage 0 → NO_DATA `probe_mapping_unavailable_required_gene_level`, multi-binding failed-GEO/usable-GDC → PARTIAL_SUCCESS |
| 尺度不兼容不合并 | `compat_gate.py:51-66` unknown×unknown (and known×unknown) cross-source → `measurement_identity_mismatch` via `_source_has_unknown_scale` (compat_gate.py:82-98); identity fixed triple `(semantics, scale, unit)` in `identity.py`; `canonicalizer.py:219-233` scale validated against `allowed_value_scales` (contracts.py:496-510, T4); single-source unknown stays publishable (honest) |

## B. §6.2 TODO six items — VERIFIED (all mapped + tested)

| TODO | Tasks | Evidence |
| --- | --- | --- |
| Provider + Adapter 拆分 | T2, T3 | `geo_adapter.py` (adapter, registry via `adapters.py:739-750`); `geo_provider.py` (`resolve_provider` dispatcher, **no plugin registry**); `geo_association.py` |
| platform/probe/value scale/normalization | T1, T2, T3, T4 | `contracts.py` PlatformRecord/ProbeMappingSummary/ValueScale/AdapterParams (+ validators); `geo_provider.py:454-489` PlatformRecord per GPL; `profiles.py` allowed_value_scales + probe_release.v1 |
| 多 GSE 独立发布/双侧 relation | T6 | `multi_build.py` (isolation + no-cross-build-supersede assertion); `relations.py:82-222` inverse rows (`article_describes_dataset`/`dataset_described_by_article`, `geo_references_pubmed`/`pubmed_referenced_by_geo`); tests `test_relations_bidirectional.py`, `test_dataset_multi_build.py` |
| Gate 后才整合，mapping failure audit/NO_DATA | T5, T7 | `compat_gate.py` D4 matrix (11 new tests); `executor.py:399-433` per-binding fan-out; `dataset_build_tool.py:458-540` classifier |
| `_resolve_gse` 不截断 | T6 | `geo_accession.py` finditer/uppercase/dedupe + explicit ValueError; `discovery.py:341-369` full candidate set (query + dataset); `acquisition.py:58-65` |
| tumor/normal 与 pairing | T8 | `geo_tximport.py` extractors + `validate_pairings`; `samples.py:19-30` conditional artifact columns; `test_geo_sample_grouping.py` (26 tests) |

## C. §6.3 终态断言 — VERIFIED

| Assertion | Evidence |
| --- | --- |
| geo.expression.v1 through fixed V2 plan + checkpoint reuse with per-binding param digest | `executor.py:1011-1028` `_compute_input_digest` folds `parameter_scope`; `executor.py:1045-1061` parameter digest; test `test_executor_per_binding_adapter_params_gate_reuse` (log2→reuse, linear→rerun) |
| Multi-GSE publications don't supersede | `invariants.py:237-262` build-scoped `find_latest_publication`; `expression_runner.py:684-701` scoped supersede lookup; `multi_build.py:126-148` no-cross-build assertion; test `test_publish_does_not_supersede_across_build_ids` |
| Primary `gene_id_namespace` consistent with entity level; `geo_probe` only under probe contract | gene profile residual-scan `profiles.py:290-320` (`probe_coverage_required_gene_level` fails any `geo_probe` row under gene schema before publish); probe rows publish only under `probe_long.v1` (spec validator tests `entity_level_schema_mismatch`); manifest records per-binding actual namespaces + `entity_level` (`expression_runner.py:848-874`) |
| No filename/title/probe-shape inference | scale/semantics/unit from `AdapterParams` only (tested `test_scale_from_parameters_only`); namespace from declared column; pairing from explicit keys only (T8 point 6); `delimiter` sniff = CSV/TSV only |
| unknown×unknown not merged | `compat_gate.py:51-66` + test `test_unknown_scale_cross_source_merge_rejected` (red-first: previously passed) |

## D. Cross-task coherence — PASS with 1 Important gap

- T1 contracts ↔ T2 adapter ↔ T5 gate ↔ T6 orchestrator ↔ T7 fan-out/classifier ↔ T8 grouping: no dead contracts; every new contract is consumed somewhere in production (AdapterParams → runner/chain, PlatformRecord → T3/T1 validators, ProbeMappingSummary → T5 profile + T7 emission, ValueScale → canonicalizer/gate/identity).
- ProbeMappingSummary emission ↔ T5 coverage check: runner passes real summaries into `profile.validate(probe_mapping_summaries=...)` (`expression_runner.py:571-603`) — live seam, tested.
- **Gap (F1)**: `SpecValidator` (T1/T4 entity-level compatibility) is **not wired into any production entry** — see findings.

## E. Regression risk — LOW, all churn documented

No test files deleted (`git diff --diff-filter=D` empty). Modified tests map 1:1 to documented Phase 5 behavior changes:

| Changed test | Reason (task report) |
| --- | --- |
| `test_artifact_metadata_correctness.py` | T6 bidirectional relations (3 rows → 6 rows) |
| `test_pipeline_e2e.py` | T3 new `platform_records`/`sample_platform_evidence` kwargs |
| `test_dataset_build_tool.py` `...mixed_empty_and_usable...` renamed `..._is_partial_success` | T7 per-binding fan-out replaces abort-at-first-empty NO_DATA |
| `test_dataset_build_tool.py` `test_no_data_classification_is_scoped_to_current_attempt` | T7 classification driven by per-binding outcomes (attempt-scoped by construction) |
| `test_dataset_expression_runner.py` `test_publish_supersedes_previous_version` → 2 tests | T6 build-scoped supersede semantics |
| `test_dataset_canonicalizer.py` (xfail → green; 1 assertion updated) | T2 declared-namespace fix; T7 `geo_probe` namespace allowed at canonicalization, entity policy moved to validation profile |

V1 user-visible behavior changes are exactly the documented two: (1) multi-GSE raise-not-truncate (spec §2.1: "本阶段唯一主动改变 V1 行为的部分"), (2) bidirectional `source_relations.csv` rows (T6). Both covered by regression tests. The digest change (parameter_scope folded into input digest) causes a one-time checkpoint invalidation for pre-existing builds — benign.

## F. Spec deltas — 6 (all documented; 1 Important)

1. **T7 corrupted-source NO_DATA envelopes** (parse_error:binding) instead of generic retryable error — intended, matches D5 E2E (a) and 4b fixture semantics.
2. **T7 `geo_probe` becomes an allowed canonicalization namespace**; entity-level enforcement moved into the validation profile (T5 gate) — required by D2/D5; updates one T1-era canonicalizer assertion (documented).
3. **T5 gate does not hard-fail all-empty with `no_sources`** — the D4 row is delivered via the fan-out/chain NO_DATA path (documented; runner maps gate failure to retryable error).
4. **T7 partial-coverage multi-binding**: gene-required build fails the WHOLE build when a binding has residual probe rows, even if another binding fully satisfies gene-level — spec D5 row-3 "多 binding 中仍有满足要求的来源 → partial policy" is interpreted as phase-A rejections only (documented in T7 report). Consistent with wave-7 (aborted mixed build never PARTIAL_SUCCESS). Not covered by a test.
5. **PlatformRecord not emitted by the V2 chain** (D5 row 2 lists it in probe-primary publication) — ProbeMappingSummary + mapping-detail CSV + summaries CSV are published; PlatformRecord stays V1/T3. Documented by T7 as Phase 7 item.
6. **SpecValidator not wired into the tool/runtime entry** (D1 "dataset_build_tool.py 入口" + D4 "Spec Validator 兼容检查") — see F1; the tool comment at `dataset_build_tool.py:288` claims "wired into the runtime in T5/T7", which did not happen.

---

## Findings

| ID | Severity | file:line | Issue | One-line fix |
| --- | --- | --- | --- | --- |
| F1 | **Important** | `dataset_build_tool.py:288` (comment claims "wired into the runtime in T5/T7"); `spec_validator.py:95-114` (entity-level codes) | `SpecValidator` is never instantiated in production (`grep "SpecValidator(" backend/app` → only the module itself + tests; no `allowed_validation_profiles` consumer). D4's `invalid_input` for `gene build + probe profile` / `probe build + gene profile` (`entity_level_profile_mismatch`, `entity_level_schema_mismatch`) is unit-test-only. Profiles are schema-driven (`profiles.py` `validate()` never checks entity level — T4 report), so a fully-mapped probe-schema build submitted with the GENE profile can pass validation and publish probe rows labeled as a gene release. | Call `SpecValidator(...).validate(spec)` at the `dataset_build_tool.py` entry (and/or the runner) and return `invalid_input` on codes — or add a runner-level `required_entity_level` vs schema-granularity guard. |
| F2 | Minor | `probe_mapping.py:200-223` (`build_probe_mapping` receives only `source_asset_id`); `contracts.py:590-695` | D3 MUST-FIX-8 bidirectional invariant (`mapping_asset_id` ↔ `SourceAsset.sha256` must match) is not enforced in the V2 chain; T1 deferred it to "T3/T7", T3 only enforces PlatformRecord-internal consistency, T7 never verifies the asset digest against the mapping audit. | Pass the `SourceAsset` into `build_probe_mapping` and reject when its `sha256` is missing or mismatches the mapping asset used. |
| F3 | Minor | `probe_mapping.py:169-170` (`mapping[probe] = gene` last-wins); `probe_mapping.py:214` (`ambiguous_probe_count=0`) | D2 says ambiguous probes (multi-gene, no explicit resolution rule) stay `geo_probe`; V2 silently collapses duplicates last-wins and always reports `ambiguous=0`, which can inflate coverage toward the gene gate's 1.0 requirement. | Detect probes with multiple distinct gene targets; keep them unmapped/`geo_probe`, populate `ambiguous_probe_count`. |
| F4 | Minor | `expression_runner.py:571-582` (summaries CSV + mapping detail only) | D5 row 2 lists `PlatformRecord` in the probe-primary publication set; the V2 chain emits ProbeMappingSummary + audits but no PlatformRecord (documented as Phase 7 item). Acceptance criteria are still met via T3/V1. | Emit one `PlatformRecord` per probe binding in `_validate_profile` (or accept as documented deviation). |
| F5 | Minor | `expression_runner.py:462-471` (per-binding rejection only for zero-gene-rows); `profiles.py:290-320` (whole-build FAILED on residual rows) | D5 row-3 "多 binding 中仍有满足要求的来源 → partial" is not implemented for the coverage<1.0 case: a surviving fully-gene sibling does not rescue the build (whole-build NO_DATA). Defensible under wave-7, documented, but untested as a scenario. | Add a test pinning the interpretation, or implement per-binding exclusion of partial-coverage rows. |
| F6 | Minor | `geo_tximport.py:187-226` (warnings in return value only); `samples.py:19-30` (artifact columns only) | T8 conflict warnings (`unknown` + warning) are exposed at the extraction layer but never written to `warnings.csv` (documented T8 boundary note); audit trail is only via `sample_group=unknown` + `sample_group_raw`. | Persist `extract_sample_group`/`validate_pairings` warnings into the artifact warnings channel. |

### Verified-non-issues (checked, no finding)

- `value_scale` statistic vs per-row identities: `_source_has_unknown_scale` (compat_gate.py:82-98) reads identities first, batch statistic as fallback — no drift.
- tximport hardcodes `ensembl_gene` declaration without ENSG-shape check (`geo_adapter.py` `_extract_tximport`); non-ENSG rows fail closed in the canonicalizer (`unauthorized_namespace`) — honest, no shape promotion.
- Manifest entity_level/namespaces are recorded per-binding in `source_summary` (`expression_runner.py:848-874`) — satisfies D2 point 3 ("list all actual namespaces"); per-binding is a superset of the spec's aggregate wording.
- Orchestrator is decoupled via injected `RunBuildFn` (D6 Phase-7 seam); `execute_dataset_build` keeps single-build semantics.
- V1 allowlist untouched (`SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` pinned by `test_v1_pipeline_allowlist_unchanged`).

---

## Overall: PASS

All §6.1 (3 criteria), §6.2 (6 TODO items) and §6.3 (5 终态断言) acceptance criteria are met with red-first tests and live enforcement; regression churn is fully documented; spec deltas are intentional and reported. 2631 backend tests, ruff, import and uvicorn smoke green (controller-verified; 316 Phase 5 tests re-run green in this review).

**MUST-FIX (before merge or as an immediate follow-up commit):**
- **F1** — Wire `SpecValidator` into the `dataset_build_tool.py` entry (or add an equivalent runner-level entity-level guard) so `gene build + probe profile` and `probe build + gene profile` are rejected `invalid_input` in production, not only in unit tests; remove/update the stale "wired into the runtime in T5/T7" comment at `dataset_build_tool.py:288`.

**Recommended (non-blocking):** F2 (asset-sha bidirectional invariant), F3 (ambiguous probe counting), F4 (V2 PlatformRecord), F5 (multi-binding partial-coverage test), F6 (T8 warnings channel).

---

## Fix wave (final review F1, F2, F3, F6) — TDD, all green

> Implementer: fix-wave executor (branch `feat/phase5-geo-migration`, same branch).
> Method: red-first per finding (`pytest` repro → fix → green), full gate re-run
> after the wave.  Full suite: **2638 passed** (baseline 2631 + 7 new tests),
> `ruff check app/ tests/ launcher.py` clean, `python -c "import app.main"` OK.
> Frontend untouched (diff is backend-only).  F4/F5 kept as documented
> deviations (not in this wave).

### F1 (Important) — SpecValidator wired into the production tool entry

- `app/pipeline/dataset_build_tool.py:203-228` — `SpecValidator` is now
  instantiated at the `execute_dataset_build` entry (right after the
  `build_id` gate, before any source file is resolved or any build workspace
  is created), with the server's registered profiles as the allowlist
  (`frozenset(VALIDATION_PROFILES)`).  Failures map to the existing
  `invalid_input` envelope (retryable False) with the validator's structured
  reason codes + reasons in the message, so `gene build + probe schema` /
  `probe build + gene profile` (`entity_level_schema_mismatch`,
  `entity_level_profile_mismatch`) are rejected before a build can publish
  probe rows under the gene release gate.
- Stale comment at `dataset_build_tool.py:312-316` (was `:288` claiming
  "wired into the runtime in T5/T7") corrected — the D1 comment now records
  that the SpecValidator runs at the tool entry and this block is the
  remaining binding-level `AdapterParams` digest guard.
- Red tests: `tests/test_dataset_build_tool.py`
  `test_execute_dataset_build_rejects_probe_schema_with_gene_profile_as_invalid_input`
  (staged matrix file + probe schema + gene profile → `invalid_input`,
  `assert not datasets_build.exists()`) and
  `test_execute_dataset_build_rejects_target_entity_level_mismatch_as_invalid_input`
  (explicit `target_entity_level="probe"` on a gene-schema spec → `invalid_input`).
  Existing 23 tool tests stay green unchanged (their specs are validator-valid).

### F2 — mapping_asset_id ↔ SourceAsset.sha256 bidirectional invariant

- `app/datasets/build/errors.py:52-63` — new typed error
  `ProbeMappingAssetMismatchError(BuildError)`.
- `app/datasets/build/probe_mapping.py:178,191-199` — `build_probe_mapping`
  now takes the annotation `SourceAsset` (`annotation_asset`) instead of a
  bare `source_asset_id`; when supplied, the asset's declared `sha256` must
  equal the digest of the file actually parsed, else the typed error is
  raised.  `ProbeMappingSummary.mapping_asset_id` is recorded from
  `annotation_asset.asset_id` only after that check (D3 MUST-FIX-8
  bidirectional consistency: asset 缺 sha 或 sha 不匹配均拒绝 — the sha-missing
  case is unreachable via the FileAsset contract, which pins
  `asset_id == asset_<sha256>`).
- Call site `app/datasets/build/expression_runner.py:409` passes
  `annotation_asset=mapping_asset`.
- Red test: `tests/test_dataset_probe_mapping.py`
  `test_build_probe_mapping_rejects_annotation_asset_sha_mismatch` (asset with
  a wrong sha256 → `ProbeMappingAssetMismatchError`).

### F3 — ambiguous probes stay geo_probe, counted, excluded from coverage

- `app/datasets/build/probe_mapping.py:137-153` — `parse_platform_table`
  now returns a 4th element `ambiguous_probes: frozenset[str]`; multi-DISTINCT
  target probes are excluded from the returned map (duplicate rows mapping to
  the SAME target remain mapped), so the canonicalizer keeps them `geo_probe`.
- `app/datasets/build/probe_mapping.py:206-260` — `build_probe_mapping`
  populates `ambiguous_probe_count` from the batch's ambiguous probes
  (ambiguous ⊆ unmapped by construction), the audit CSV marks them
  `status="ambiguous"` (D2: 未命中与 ambiguous 行保持 geo_probe), and
  `coverage_ratio` excludes them — a batch with an ambiguous probe can no
  longer hit coverage 1.0 against the gene gate.
- Red tests: `test_build_probe_mapping_multi_target_probe_is_ambiguous`
  (PROBE1→{TP53,BRCA1} → `probe_to_gene == {"PROBE2": "TP53"}`,
  `ambiguous_probe_count == 1`, coverage 0.5, audit `PROBE1,,,ambiguous`) and
  `test_build_probe_mapping_duplicate_same_target_is_not_ambiguous`.
  The 4 existing `parse_platform_table` unit tests were updated for the
  documented 4-tuple contract (unpack `_ambiguous`).

### F6 — T8 conflict/one-sided warnings persisted into warnings.csv

- `app/pipeline/stages/artifact_build/warnings.py:47-105` — new
  `_build_sample_group_warnings` mirroring the cell-line pattern: a sample
  with `sample_group == "unknown"` and non-empty `sample_group_raw` is exactly
  the extractor's conflict case (raw evidence is only retained for a
  classified/conflicting hit) → `code="sample_group_conflict"`; one-sided
  pairings are re-derived with the same `validate_pairings` the extraction
  layer exposes → `code="pairing_one_sided"`.  `_build_warnings_rows` gained
  an optional `sample_group_warnings` param (default `None`, keeps the
  `test_cleaning_truncation` direct calls unchanged).
- `app/pipeline/stages/artifact_build/builder.py:423-428` — computed next to
  `cell_line_warnings` and folded into `all_warnings` before
  `_build_processing_log_rows`, so `warnings_metrics_consistency` stays
  satisfied (warnings.csv rows == processing_log warnings arrays).
- Red tests: `tests/pipeline/test_geo_sample_grouping.py`
  `test_artifact_warnings_persist_group_conflict_and_one_sided_pairing`
  (conflict + one-sided pairing samples → both codes in warnings.csv) and
  `test_artifact_warnings_skip_clean_group_evidence` (clean tumor/normal
  pair → no T8 codes).  Cell-line fixture (GSE178352) stays
  unknown/empty/no-pairing, so historic artifact tests are byte-identical.
