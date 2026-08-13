# Pi Migration Phase 4 — T8 Report: Validation (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 8 (validation).
Branch: `codex/phase4-dataset-core-ts`.

## Summary

Ported the validation layer to TypeScript: deterministic confidence detectors
(`backend/app/datasets/build/confidence.py`), the gene/probe release validation
profiles (`backend/app/datasets/build/profiles.py`) and the SpecValidator
pre-check (`backend/app/datasets/build/spec_validator.py`).

## What was built / changed

| Area | Files |
| --- | --- |
| Validation module | `server/src/dataset/validation/{confidence,profile,spec_validator}.ts`, `index.ts` |
| Parity checks (vitest-free) | `server/tests/validation-parity.ts` — confidence detectors, profile release gate, spec validator |
| Vitest suite | `server/tests/dataset-validation.test.ts` (3 tests) |

## Invariants mirrored

- **Confidence detectors**: `isBenfordApplicable`, `benfordDistance`,
  `lastDigitChi2`, `detectConstantColumn`, `detectArithmeticProgression`,
  `aggregateConfidenceMetrics`, `writeConfidenceReport`, thresholds —
  deterministic PRNG-seeded suites mirror `test_dataset_confidence.py`.
- **Profiles**: the gene and probe release profiles mirror
  `test_dataset_profiles.py` — required columns, minimum row counts, entity
  level, value-scale/semantics rules, probe mapping coverage; the profile
  writes `validation_report.json` and a valid report carries status `passed`.
- **SpecValidator**: schema/profile/granularity consistency, entity-level
  mismatch codes, and the GEO binding adapter-parameter rules (Phase 5 D1)
  mirror `test_spec_validator.py`.

## Verification evidence

- Strict typecheck: exit 0.
- ESLint (server type-aware config): 0 errors on `src/dataset/**` + tests.
- Vitest: T1–T10 dataset suites 53/53 passed.
- All new files UTF-8 no BOM, CRLF line endings.

## Known deviations (intentional, non-blocking)

- The parity tests assert the report-file output for the empty-primary profile
  case (`minimum_valid_rows` in `validation_report.json`) rather than a
  `status` field that the report does not carry; the underlying profile
  behavior matches Python.
- Geo valid binding `value_semantics` is `"normalized_expression"` (the value
  the canonicalizer actually emits), matching the fixture-driven expectation
  rather than a stale literal.

## Next steps

Phase 4 step 9 (publication) — release invariants, manifest assembly and
atomic promotion.