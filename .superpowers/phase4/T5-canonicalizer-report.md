# Pi Migration Phase 4 — T5 Report: Canonicalization (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 5 (canonicalization).
Branch: none yet — uncommitted on shared `main` (see Constraints).

## Summary

Ported the deterministic Canonicalizer to TypeScript: namespace authorization
with adapter-declared namespaces (Phase 5 D1), version-suffix splitting, the
normalization-profile policy gate (allowed units / semantics / scales; `unknown`
is honest and never promoted), gene-symbol → Ensembl mapping, probe → gene
mapping, and the full audit trail (canonical / rejected / normalization-log /
field-mappings CSVs). Measurement-identity statistics, unit-inconsistency
detection, deterministic output and the canonical `DataBatch` all mirror
`backend/app/datasets/build/canonicalizer.py`.

## What was built / changed

| Area | Files |
| --- | --- |
| Canonicalizer module | `server/src/dataset/canonicalizer/` — `canonicalizer.ts` (`authorizeNamespace`, `canonicalize`, `CanonicalizationResult`, audit constants), `identity.ts` (`MeasurementIdentity` order/serialize/deserialize), `gene_maps.ts` (`SYMBOL_TO_ENSEMBL`, resolvers, `validateGeneMap`), `profiles.ts` (`expressionNormalizationV1`, `NORMALIZATION_PROFILES`, `getNormalizationProfile`), `index.ts` |
| Parity checks (vitest-free) | `server/tests/canonicalizer-parity.ts` — namespace/identity/map contract invariants + fixture-driven GDC/Xena canonicalization |
| Vitest suite | `server/tests/dataset-canonicalizer.test.ts` (4 tests) |
| Harness | `runner-canonical.mjs`, `invariants-canonical.mjs`; tsconfig typecheck/compile/test + `vitest.config.mjs` extended to all 5 suites |

## Invariants mirrored

- **Namespace authorization** (`test_authorize_namespace_rules` +
  `test_probe_id_misclassified_by_symbol_regex_is_regression_target`): ENSG
  `ENSG###########(.N)` splits the version; gene symbols authorize only via
  `^[A-Za-z][A-Za-z0-9_.-]*$` **and never** `AFFX-`; `1007_s_at` / `AFFX-BioB-5`
  stay unauthorized by ID shape; the adapter-declared namespace
  (`gene_id_namespace_declared`) is authoritative when present, and an unknown
  declaration fails closed.
- **Per-row rejection codes** (audit CSVs): `unauthorized_namespace`,
  `unknown_unit`, `unknown_semantics`, `unknown_scale` (unparseable `ValueScale`
  **or** outside `allowed_value_scales`; `unknown` accepted only when allowed),
  `non_finite_value`. `reason` = code with `_`→space (+ ` (detail)`).
- **Canonical rows** (`test_canonical_matrix_rows`, `test_canonical_star_ensembl_normalization`):
  exactly the schema-declared columns; `record_id = makeRecordId(dataset_id,
  gene_id_raw, sample_id)`; gene schema → `gene_id`/`gene_id_version`; probe
  schema → `probe_id`/`platform_id`/`value`; always `gene_id_namespace`;
  `source_sample_alias = ""` for `star_counts` else the source column name.
- **Mappings** (`test_gene_symbol_map_resolves_symbols_to_ensembl`,
  `..._keeps_unmapped_symbols`): `gene_symbol_map` re-namespaces to
  `ensembl_gene` with rule/evidence `gene_symbol_map` / `local gene symbol map`;
  unmapped symbols keep their namespace and are never dropped.
- **Statistics / metadata** (`test_canonical_batch_metadata`): `row_count`,
  `rejected_count`, sorted `gene_id_namespaces`, `gene_symbol_mapped_count`,
  `probe_mapped_count`, `expression_units`, `unit_inconsistency_detected`,
  sorted `measurement_identities` `[semantics, scale, unit]`, `schema_ref`;
  canonical batch `batch_id=canon_<binding>`, `file_asset.kind="normalized"`,
  `parser_id="expression.canonicalizer.v1"`, `parser_version="1.0.0"`,
  `column_count = len(schema.fields)`.
- **Unit policy** (`test_unknown_unit_rejected`,
  `test_multi_unit_batch_detected_as_inconsistency`): restricted profile rejects
  out-of-set units; a batch mixing two allowed units is flagged
  (`unit_inconsistency_detected` + warning), never silently merged.
- **Value scale** (T4 D3): `raw_count` is a *semantics*, never a scale — a
  `raw_count` value_scale string is rejected `unknown_scale` (defense in depth);
  `unknown` is rejected unless the profile allows it, and preserved verbatim
  when allowed.
- **Determinism** (`test_canonical_is_deterministic`): identical inputs → byte
  identical canonical CSV and identical `file_asset.sha256`.
- **Probe path** (canonicalizer.py `probe_schema` branch): probe rows carry the
  original probe id + platform id + value; `probe_map` re-namespaces hits with
  rule/evidence `probe_gene_map` / `GPL platform annotation (probe->gene)`;
  unmapped probes stay `geo_probe`.

## Verification evidence

- Strict typecheck (`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`): exit 0.
- `tsc` compile: exit 0.
- `runner-canonical.mjs`: all parity checks pass (contract + fixture).
- `invariants-canonical.mjs`: 10 negative/positive cases — all pass.
- Regression: step-1 golden parity + invariants, schema-registry, source-asset,
  adapters and canonical runners all pass.
- Real vitest 3.2.7: **42/42** (26 contracts + 6 schema registry + 3 source asset + 3 adapters + 4 canonicalizer).
- ESLint (server config, type-aware) on `src/dataset/canonicalizer` + new tests: 0 warnings.
- All new files UTF-8 no BOM, CRLF line endings (repo convention).
- Server-wide `tsc -p tsconfig.test.json` still reports only pre-existing
  missing-dependency errors (`ws`, `vite`, `@earendil-works/pi-coding-agent`,
  `http-proxy-3`) — none in the ported code; the tailored harness is the working gate.

## Known deviations (intentional, non-blocking)

- GEO-adapter scenarios (`GeoExpressionAdapter`) are substituted with
  hand-built source-long batches; the adapter-declared `geo_probe` namespace,
  probe-schema and probe-map paths are exercised directly. GEO acquisition
  lands in Phase 5 per the migration plan.
- Rejection detail strings use single-quoted values (`unit='x'`) matching
  Python `repr`; audit `reason` text is not byte-compared with Python (the plan
  excludes log text from golden parity).
- `MeasurementIdentity` is a class (frozen dataclass equivalent) with an
  explicit `compareTo` ordering; the canonicalizer dedups via a key map and
  sorts identically to Python `sorted(set(...))`.

## Constraints (unchanged from T1–T4)

- `pnpm install` still blocked (network + approval reviewer); real workspace gates pending.
- Worktree/branch + commit pending (approval outage); diff uncommitted on shared `main`.
- Stray untracked `packages/contracts/src/*.js` artifacts still to delete before commit.
- Commonly `[TASK]`/`[DONE]` still not posted (Commonly MCP 503).

## Next steps (Phase 4 step 6)

Compatibility gate (T6): sources of truth
`backend/app/datasets/build/compat_gate.py` +
`backend/tests/test_dataset_compat_gate.py`; consumes `MeasurementIdentity` and
canonical `DataBatch` output from this step to enforce cross-source merge
identity and the release gate. Keep the same golden-fixture + Python-invariant
parity discipline.