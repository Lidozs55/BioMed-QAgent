# Pi Migration Phase 4 — T3 Report: SourceAsset (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 3 (SourceAsset).
Branch: none yet — uncommitted on shared `main` (see Constraints).

## Summary

Ported the source-flavoured `FileAsset` subclass to TypeScript, mirroring
`app.domain.contracts.source.SourceAsset` and the contract invariants in
`backend/tests/contracts/test_source_contracts.py`. Also closed a FileAsset
path parity gap found during this step.

## What was built / changed

| Area | Files |
| --- | --- |
| `SourceAsset` + shared FileAsset parser | `server/src/dataset/contracts/source.ts` — `parseSourceAsset`, `SourceAsset` interface, refactored `parseFileAssetFromRecord` shared by `parseFileAsset` / `parseSourceAsset` |
| `DataLevel` enum | `server/src/dataset/contracts/enums.ts` — `DATA_LEVEL`, `assertDataLevel` |
| Windows-absolute path guard | `server/src/dataset/contracts/primitives.ts` — `assertRelativePath` now rejects `C:/...` drive-absolute (Python `PureWindowsPath.is_absolute`) |
| Parity checks (vitest-free) | `server/tests/source-asset-parity.ts` |
| Vitest suite | `server/tests/dataset-source-asset.test.ts` (3 tests) |

## Invariants ported (mirror `test_source_contracts.py`)

- `kind` must be exactly `"source"` (`"parsed"` etc. rejected).
- `relative_path` must live under `source_assets/` (first path segment check).
- Exactly one lineage: either `successful_attempt_id` or `derived_from_asset_id`
  (never both, never neither); empty-string lineages rejected (`min_length=1`).
- Derived assets: may not reference themselves; require `generated_by_step_id`.
- `data_level` must be a known `DataLevel`; `asset_id = asset_<sha256>` and
  64-hex lowercase sha256 carry over from `FileAsset`.
- `parseFileAsset` still rejects unknown fields (`extra="forbid"`) — this was
  accidentally dropped during the shared-parser refactor and is restored, with
  new parity checks for unknown fields on both `FileAsset` and `SourceAsset`.
- `FileAsset` now rejects Windows drive-absolute paths (`C:/file.gz`), matching
  Python; the previous TS port only rejected POSIX absolutes and `..`.
- `SourceLocator` coordinate rules re-verified (line >= 1, column >= 0,
  relative `logical_file`, string `raw_value`).

## Verification evidence

- Strict typecheck: exit 0; compile: exit 0.
- Vitest-free SourceAsset parity runner: all checks pass.
- Schema Registry + step-1 contract parity + invariants: no regression.
- Real vitest 3.2.7: **35/35** (26 contracts + 6 schema registry + 3 source asset).
- ESLint (server config, type-aware) on `src/dataset/**` + all test files: 0 warnings.
- All new/modified files UTF-8 no BOM, CRLF line endings (repo convention).

## Notes

- No golden fixture exists for `SourceAsset` (the golden `source_fixtures` are
  loader descriptors, not assets); parity is asserted via the Python contract
  tests' invariants and full round-trip equality.
- `DownloadAttempt` / `AcquisitionResult` / `SourceRecord` / `SourceRelation`
  remain Python-side; they belong with step 4 (adapters), not step 3.

## Constraints (unchanged)

- `pnpm install` blocked (network + approval 503); real workspace gates pending.
- Worktree/branch + commit pending (approval outage); diff uncommitted on shared `main`.
- Stray untracked `packages/contracts/src/*.js` artifacts still to delete before commit.
- Commonly `[TASK]`/`[DONE]` still not posted (Commonly MCP 503).

## Next steps (Phase 4 step 4)

Adapters: with `SourceAsset` (and later `DownloadAttempt`) ported, step 4 ports
the acquisition/parse adapter seams (`AcquisitionResult`, `DownloadAttempt`,
`DownloadStatus`/`ErrorCode` enums, adapter result contracts).