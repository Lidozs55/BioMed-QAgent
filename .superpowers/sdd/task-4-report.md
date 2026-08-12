# Task 4 Report: Phase 0D Golden Migration Baseline

## Status

DONE. The pre-Pi environment and legacy measurements are recorded, and four
executable DatasetBuild golden outcomes are committed under
`tests/migration/`. Production runtime behavior, frontend code, package
topology, and Dataset Core code were not changed.

## Deliverables

- `docs/migration/baseline-2026-08-11.md` records base commit, Python/uv lock,
  Node/pnpm, original and migrated lock hashes/relationship, the exact Pi
  selection, legacy results, limitations, and reproduction commands.
- `tests/migration/golden/{succeeded,partial_success,no_data,spec_rejected}`
  contains current-contract fixture documents. Published outcomes also contain
  the exact manifest-referenced local artifact files.
- `tests/migration/golden/contract-snapshot.json` is generated from current
  Pydantic `model_json_schema()` output for DatasetBuildSpec, BuildResult,
  ValidationResult, DatasetManifest, DatasetPublication, and EventEnvelope.
- `tests/migration/sources/header_only.tsv` is the deterministic local NO_DATA
  source fixture.
- `tests/migration/.gitattributes` preserves hashed artifact/source bytes and
  forces canonical fixture documents to LF, so a Windows capture remains
  reproducible after a fresh checkout.
- `scripts/verify_migration_golden.py` is read-only by default. `--capture` is
  the only write path, and it explicitly rebuilds fixtures with the real local
  ExpressionBuildRunner/DatasetBuildExecutor path.
- `backend/tests/test_migration_golden.py` validates all four fixtures, contract
  and EventEnvelope invariants, artifact/source SHA-256, explicit absent
  outputs, allowed canonicalization, stable-business drift, deterministic
  recapture, and non-rewriting verification.

## TDD RED / GREEN

RED was captured before adding the helper or fixtures:

```powershell
Set-Location backend
uv run pytest tests/test_migration_golden.py -q
```

Result: expected `9 failed`. The first failure listed the six missing required
documents (`scripts/verify_migration_golden.py`, the contract snapshot, and all
four outcome fixture JSON files). The remaining failures were direct missing
file/helper consequences.

GREEN after explicit deterministic capture:

```powershell
uv run python ..\scripts\verify_migration_golden.py --capture
uv run pytest tests/test_migration_golden.py -q
```

Result: `9 passed in 2.06s`. The determinism test performs two fresh in-memory
captures, compares them byte-for-byte, compares the result with every committed
fixture, and never invokes the capture/write entry point.

## Existing authority used

- SUCCESS executor authority:
  `tests/test_dataset_expression_runner.py::test_runner_drives_full_build_single_source`
- PARTIAL_SUCCESS executor authority:
  `tests/test_dataset_expression_runner.py::test_t7_fanout_one_empty_binding_completes_with_other_binding_data`
- PARTIAL_SUCCESS BuildResult authority:
  `tests/test_dataset_build_tool.py::test_execute_dataset_build_multi_binding_geo_failed_gdc_usable_is_partial`
- NO_DATA authority:
  `tests/test_dataset_build_tool.py::test_execute_dataset_build_header_only_source_is_no_data`
- SPEC_REJECTED reason-code authority:
  `tests/test_dataset_build_tool.py::test_validate_dataset_build_spec_rejects_unknown_schema`
- Current DatasetBuild, manifest/artifact-ID, and EventEnvelope contracts:
  `tests/test_dataset_contracts.py`, `tests/test_dataset_manifest.py`, and
  `tests/contracts/test_event_contracts.py`.

Combined focused command result: `127 passed in 16.03s`.

## Verification

- Default verifier: PASS (`Phase 0D migration golden fixtures verified`).
- Focused migration tests: PASS (9/9).
- Authority/contracts/manifest/EventEnvelope set: PASS (127/127).
- Ruff on the new Python helper and tests: PASS, zero findings.
- SHA-256: recomputed for every source and manifest artifact reference.
- Determinism: two fresh captures are byte-identical and match committed files.
- Normal tests are read-only; fixture hashes are unchanged by verification.
- Network: no live acquisition path is used; all sources are committed local
  GDC/Xena/header-only files.
- Scope: implementation paths are limited to `docs/`, `backend/tests/`,
  `tests/`, and `scripts/`; this report is the only `.superpowers/` addition.
- `git diff --check`: PASS.

## Baseline limitations and concerns

- The historical full backend run selected 2,348 tests with 26 deselected but
  exceeded the 15-minute tool limit, so the baseline intentionally records no
  full-suite PASS/FAIL claim.
- Current `SpecValidator` returns `SpecValidationResult`; its module documents
  that this is consumed later by `BuildResult.SPEC_REJECTED`. Phase 0D freezes
  that current validator reason plus the existing BuildResult contract without
  changing runtime wiring. The service-boundary integration belongs to Task 5.
- The pre-existing React `act(...)` stderr and Vite >500 kB chunk warning are
  documented and were not suppressed.
- Pi `0.82.1` is identified exactly but not installed, as required.
