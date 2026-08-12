# Pi Migration Phase 4 — T6 Report: Compatibility Gate (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 6 (compatibility).
Branch: none yet — uncommitted on shared `main` (see Constraints).

## Summary

Ported the Expression Compatibility Gate to TypeScript
(`backend/app/datasets/build/compat_gate.py`): the deterministic, state-free
decision that canonicalized sources may be merged into one primary dataset.
All fail-closed rules and stable reason codes are mirrored, including the
Phase 5 D4 matrix (measurement identity / unknown-scale / namespace rules) and
the no-source and formal-mapping-evidence checks.

## What was built / changed

| Area | Files |
| --- | --- |
| Gate module | `server/src/dataset/compat/compat_gate.ts` — `CompatibilityReport`, `checkExpressionCompatibility`, `sourceHasUnknownScale`, `hasFormalMappingEvidence`; `index.ts` |
| Parity checks (vitest-free) | `server/tests/compat-gate-parity.ts` — contract-level gate rules + fixture-driven GDC/Xena/probe gate matrix |
| Vitest suite | `server/tests/dataset-compat-gate.test.ts` (3 tests) |
| Harness | `runner-compat.mjs`, `invariants-compat.mjs`; tsconfig typecheck/compile/test + `vitest.config.mjs` extended to all 6 suites |

## Invariants mirrored

- **Per-source rules** (all results, including empty ones): `family_mismatch`,
  `granularity_mismatch`, `schema_mismatch`, `missing_mapping_evidence`
  (empty mappings, `string_similarity` mappings, or blank evidence all fail;
  formal `adapter_declared` mappings with evidence pass).
- **Merge rules** (2+ results with ≥1 non-empty): a single measurement identity
  triple `(semantics, scale, unit)` is required — unit/semantics/scale
  divergence blocks with `measurement_identity_mismatch`; an *unknown* scale
  never merges cross-source (including unknown×unknown) per D4; a single
  gene-id namespace is required — divergence blocks with `namespace_mismatch`.
- **Empty sources** never forge identity: an empty source (row_count 0)
  contributes no identities/namespaces to a merge; all-empty sources report no
  identity/namespace reasons.
- **No sources** → `no_sources`, incompatible.
- Reasons are deduplicated preserving first-occurrence order (Python
  `dict.fromkeys`).
- `unknown` scale detection covers both per-row `measurement_identities`
  (decoded via `MeasurementIdentity.deserialize`, undecodable triples ignored
  fail-open — the canonicalizer always emits decodable triples) and the
  batch-level `value_scale` fallback.

## Verification evidence

- Strict typecheck (`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`): exit 0.
- `tsc` compile: exit 0.
- `runner-compat.mjs`: all parity checks pass (contract + fixture).
- `invariants-compat.mjs`: 9 positive/negative cases — all pass.
- Regression: T1–T5 runners and invariants (contracts, schema, source, adapters,
  canonicalizer) all still pass.
- Real vitest 3.2.7: **45/45** (26 contracts + 6 schema registry + 3 source asset + 3 adapters + 4 canonicalizer + 3 compat gate).
- ESLint (server config, type-aware) on `src/dataset/**` + all new tests: 0 warnings.
- All new files UTF-8 no BOM, CRLF line endings.

## Known deviations (intentional, non-blocking)

- The Python probe scenarios parse via `GeoExpressionAdapter`; here they run
  through the probe-schema canonicalizer path (hand-built source-long batches),
  which is a superset — the gate consumes real canonical statistics.  The
  Python suite wraps parsed batches instead because the Python canonicalizer
  could not consume the probe schema at the time; the TS port's canonicalizer
  already supports it (T5).
- `CompatibilityReport.reasons` is `string[]` rather than a tuple; the tests
  compare arrays, and the wire serialization is identical.

## Self-review of T5 (performed before T6)

- Re-verified `NORMALIZATION_LOG_COLUMNS` / `FIELD_MAPPING_COLUMNS` /
  `REJECTED_COLUMNS` constants, normalization-profile allowed sets, and the
  20-entry `SYMBOL_TO_ENSEMBL` map against Python — all identical.
- Re-confirmed empty-source behavior (header-only canonical output), identity
  dedup/sort, and rejection-detail handling; no critical or important issues
  found.  Only known deviations (GEO-adapter substitution, log-text quoting)
  were already documented in the T5 report.

## Constraints (unchanged from T1–T5)

- `pnpm install` still blocked (network + approval reviewer); real workspace gates pending.
- Worktree/branch + commit pending (approval outage); diff uncommitted on shared `main`.
- Stray untracked `packages/contracts/src/*.js` artifacts still to delete before commit.
- Commonly `[TASK]`/`[DONE]` still not posted (Commonly MCP 503).

## Next steps (Phase 4 step 7)

Integration: sources of truth
`backend/app/datasets/build/runner.py` /
`backend/app/datasets/build/expression_runner.py` (ExpressionBuildRunner +
DatasetBuildExecutor) + their tests; consumes the canonicalizer + compat gate
outputs to orchestrate the build chain.  Keep the same golden-fixture +
Python-invariant parity discipline.