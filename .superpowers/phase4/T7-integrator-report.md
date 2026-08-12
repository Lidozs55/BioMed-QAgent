# Pi Migration Phase 4 — T7 Report: Integrator (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 7 (integration).
Branch: `codex/phase4-dataset-core-ts` (T1–T6 committed; T7+ uncommitted in this round).

## Summary

Ported the deterministic integrator to TypeScript
(`backend/app/datasets/build/integrator.py`): appends canonical sources into
one primary dataset with deterministic dedup (numeric equivalence), first-source
conflict auditing, and typed `IntegratorError`s for unsupported merge strategies
and zero sources. Row identity follows the schema entity identifier (gene_id or
probe_id) and measurement type participates in the identity (T7/D4).

## What was built / changed

| Area | Files |
| --- | --- |
| Integrator module | `server/src/dataset/integrator/integrator.ts`, `index.ts` — `integrate`, `IntegrationResult`, `IntegratorError`, `MERGE_STRATEGY_APPEND`, conflict audit CSV constants |
| Parity checks (vitest-free) | `server/tests/integrator-parity.ts` — 8 scenarios mirroring `test_dataset_integrator.py` |
| Vitest suite | `server/tests/dataset-integrator.test.ts` (1 test) |

## Invariants mirrored

- `append_by_canonical_row` is the only supported merge strategy; anything else
  raises `IntegratorError` ("unsupported merge strategy").
- Zero sources raises `IntegratorError` ("cannot integrate zero sources").
- Numerically-equal values (`1.0` vs `1` vs `1.50`) dedup; different values for
  the same row identity are a conflict and keep the first source's value with a
  structured audit row (first/second value + action `kept_first_source`).
- NaN mirror rows dedup (NaN == NaN numerically) instead of conflicting.
- Measurement type is part of the row identity: changing it yields no dedup.
- The merged primary is written deterministically; `merged/primary.csv` is the
  canonical primary path for downstream manifest assembly.

## Verification evidence

- Strict typecheck (`tsc --noEmit -p tsconfig.phase4.json`, `noUnusedLocals`/
  `noUnusedParameters`/`noFallthroughCasesInSwitch`): exit 0.
- ESLint (server type-aware config) on `src/dataset/**` + all Phase 4 tests: 0 errors.
- Vitest 3.2.7: T1–T10 dataset suites 53/53 passed (T7 integrator suite included).
- All new files UTF-8 no BOM, CRLF line endings.

## Known deviations (intentional, non-blocking)

- None for the integrator semantics; the parity matrix is the Python fixture
  matrix run through the TS adapter/canonicalizer chain.

## Next steps

Phase 4 step 8 (validation) — confidence detectors, release profiles and the
SpecValidator pre-check.