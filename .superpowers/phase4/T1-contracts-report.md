# Pi Migration Phase 4 — T1 Report: Dataset Deterministic Core contracts (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 1 (contracts).
Branch: none yet — uncommitted on shared `main` (worktree creation blocked by the approval-channel outage, see Constraints).

## Summary

Ported the Dataset Deterministic Core contract surface to TypeScript with strict runtime
parsers that accept exactly the JSON Python V2 serializes (golden fixtures) and reproduce the
Pydantic invariants (`extra="forbid"`, safe-path ids, uniqueness/consistency checks, defaults,
`schema_version="1.0"`). Wire DTOs are re-exported from `@biomed/contracts`; the domain
contracts + parsers live in `server/src/dataset/contracts/`.

## What was built

| Area | Files |
| --- | --- |
| Contract module | `server/src/dataset/contracts/{primitives,enums,schema,source,data,profiles,validation,result,manifest,spec,index}.ts` |
| Parity checks (vitest-free, reusable) | `server/tests/contract-parity.ts` |
| Vitest suite | `server/tests/dataset-contracts.test.ts` (26 tests) |
| Wire-contract drift fix | `packages/contracts/src/dataset-build.ts`, `packages/contracts/src/artifacts.ts`: added optional `schema_version?: "1.0"` to `BindingFailureDetail`, `BuildResult`, `DatasetManifest`, `DatasetPublication`, `ManifestArtifactEntry` (Python `ContractModel` serializes `schema_version` on every nested object) |

## Verification evidence

- Strict typecheck (`noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`): exit 0.
- `tsc` compile (contracts + parity module): exit 0.
- Runtime parity vs `tests/migration/golden/{succeeded,partial_success,no_data,spec_rejected}/fixture.json` plus `succeeded/artifacts/schema.json` (22 fields): all round-trip, exit 0.
- 18 negative + 2 positive invariant checks: all pass.
- Real vitest 3.2.7 run of `dataset-contracts.test.ts`: 26/26 pass.
- ESLint (server config, type-aware) on all new files: 0 warnings.
- `packages/contracts` `tsc` build: exit 0.

Note: full workspace gates (`pnpm test`/`lint`/`build`) could not run because dependencies are
not installed (network sandbox + approval reviewer unavailable); the offline checks above are
the same compilers/runners the workspace gates use.

## Review findings resolved this round

1. **BOM hygiene**: all 15 new/modified `.ts` files had been written with a UTF-8 BOM by the
   previous round's PowerShell `Set-Content`. Stripped to UTF-8 no BOM (CRLF preserved).
2. **`spec.ts` acceptance drift**: `provider_id` / `recipe_id` accepted `""`, but Python
   declares `Field(min_length=1)`. Added `assertOptionalNonEmptyString` in `primitives.ts` and
   used it for both fields; `accession` / `normalization_profile_ref` stay on plain
   `assertOptionalString` (Python has no min_length there). New vitest case covers the empty
   `provider_id` rejection.
3. **Incomplete test**: the "DatasetBuildSpec normalizes missing schema_version" test had no
   assertion; it now asserts `parseDatasetBuildSpec(...).schema_version === "1.0"`.

## Known deviations (intentional, non-blocking)

- `assertRelativePath` is stricter than Python `_validate_relative_path`: it rejects any `..`
  substring (Python rejects only a `..` path segment) and does not normalize via
  `PurePosixPath.as_posix()`. Kept deliberately — traversal protection is a security property
  and the deterministic core generates its own relative paths. Revisit if a real asset name
  ever needs it.
- Several Python fields with defaults (`artifacts`, `review_status`, `required`,
  `description`, ...) are required keys in the TS parsers because Python always serializes
  them; omitted-key input is therefore stricter than Python for those fields. Intended: the
  parsers target Python-serialized JSON.

## Constraints (environment / approval)

- `pnpm install` blocked (network sandbox + approval reviewer 503): real workspace gates must
  be re-run once installs are possible.
- Git worktree/branch for this change is pending (approval channel down); the diff is
  uncommitted on shared `main`. Stray untracked `packages/contracts/src/*.js` (11-byte
  `export {};` stubs plus one full `dataset-bridge.js`) are leftovers from the previous
  round's accidental compile into `src/` and must be deleted before commit (deletion is also
  blocked by the approval outage).
- Commonly `[TASK]`/`[DONE]` check-in not posted: Commonly MCP currently returns 503. Pod
  `6a520e34f4baa9b280bba195`.

## Next steps (Phase 4 step 2)

Schema Registry (TS) with the same golden-fixture parity discipline; then SourceAsset
(step 3) using the `FileAsset`/`SourceLocator` base already ported here.