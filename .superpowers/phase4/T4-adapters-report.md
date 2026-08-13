# Pi Migration Phase 4 — T4 Report: Adapters (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 4 (adapters).
Branch: none yet — uncommitted on shared `main` (see Constraints).

## Summary

Ported the source-adapter seam to TypeScript: the acquisition/parse contracts
(`DownloadAttempt` / `AcquisitionResult` / `SourceRecord` / `SourceRelation` and
the `Database` / `SourceCapability` / `DownloadStatus` / `ErrorCode` enums), the
`AdapterParams` datasets contract, and the deterministic `SourceAdapter` engine
with the GDC and Xena adapters, registry and fail-closed numeric policy. All
Python contract and adapter-test invariants are mirrored with fixture parity.

## What was built / changed

| Area | Files |
| --- | --- |
| Adapter contracts | `server/src/dataset/contracts/source.ts` — `SourceRecord`, `SourceRelation`, `DownloadAttempt`, `AcquisitionResult` parsers (download status↔error, time ordering, asset↔attempt invariants) |
| Dataset enums | `server/src/dataset/contracts/enums.ts` — `DATABASE`, `SOURCE_CAPABILITY`, `DOWNLOAD_STATUS`, `ERROR_CODE` + asserts, `SOURCE_CAPABILITIES`, `DATABASE_IDENTIFIER_ALIASES`, `resolveDatabaseIdentifier` |
| Datetime primitive | `server/src/dataset/contracts/primitives.ts` — `assertIsoDateTime` / `isoDateTimeMillis` (ISO-8601 wire format `...Z`) |
| `AdapterParams` | `server/src/dataset/contracts/data.ts` — `parseAdapterParams` (GPL platform ids, `auto`/single-char delimiter, supplementary_matrix-only applicability) |
| Adapter engine | `server/src/dataset/adapters/` — `errors.ts` (`BuildError`/`AdapterError`/`EmptySourceError`), `identity.ts` (`assetIdFromSha256`, `makeRecordId`, Python `json.dumps`-compatible `canonicalDigest`), `hashing.ts` (`sha256File`), `text.ts` (gzip-aware `readSourceText`, quote-aware TSV/CSV read/write), `adapters.ts` (`SOURCE_LONG_COLUMNS`, `REJECTED_COLUMNS`, `SourceAdapter.parse`, `GdcExpressionAdapter` matrix+STAR-counts, `XenaMatrixAdapter`, `ADAPTER_REGISTRY`, `getAdapter`, `adapterParamsForBinding`) |
| Parity checks (vitest-free) | `server/tests/adapters-parity.ts` — contract invariants + fixture-driven GDC/Xena runs |
| Vitest suite | `server/tests/dataset-adapters.test.ts` (3 tests) |
| Harness | `runner-adapters.mjs`, `invariants-adapters.mjs`, `vitest-shim.d.ts`; tsconfig typecheck/compile/test + `vitest.config.mjs` extended |

## Invariants mirrored

- **Contract layer** (`test_source_contracts.py`): `SourceRecord`/`SourceRelation`
  preserve explicit evidence; `DownloadAttempt` rejects success-with-error,
  failure-without-error, and `finished_at < started_at`; `AcquisitionResult`
  requires asset ⟺ succeeded and `asset.successful_attempt_id == attempt.attempt_id`.
- **AdapterParams**: `platform_id` must match `^GPL\d+$`, delimiter is `auto` or
  single char and only meaningful for `supplementary_matrix`, `value_scale`
  must be a known `ValueScale`.
- **Fixture parity** (`test_dataset_adapters.py`, 16 scenarios): GDC matrix batch
  shape / declared mappings / source-long rows (incl. `gene_id_namespace_declared`
  empty column and canonical `record_id`), GDC STAR counts (+`__no_feature`
  audit row), Xena matrix, checksum-mismatch fail-closed (no `batches/` dir),
  malformed header, non-finite value auditing (nan/inf/garbage never fatal),
  GDC annotation-column filtering, gzip decompression, unstranded fallback,
  blank-line parity (GDC strict vs Xena skip), unknown-adapter rejection,
  registry entries, `SOURCE_LONG_COLUMNS` carries the declared-namespace column.

## Verification evidence

- Strict typecheck (`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`): exit 0.
- `tsc` compile: exit 0.
- `runner-adapters.mjs`: all parity checks pass (contract + fixture).
- `invariants-adapters.mjs`: 13 negative + 1 positive — all pass.
- Regression: step-1 golden parity, step-1 invariants, schema-registry and
  source-asset runners still pass.
- Real vitest 3.2.7: **38/38** (26 contracts + 6 schema registry + 3 source asset + 3 adapters).
- ESLint (server config, type-aware) on `src/dataset/**` + new tests: 0 warnings.
- All new/modified files UTF-8 no BOM, CRLF line endings (repo convention).

## Known deviations (intentional, non-blocking)

- `sha256File` hashes with one buffered read instead of Python's streaming
  `hashlib.file_digest`; the file-based exchange format is preserved and
  streaming can return at integration time if GB-scale matrices need it.
- Delimited-text parsing is in-memory (whole source text) and does not support
  multi-line quoted fields (Python `csv.reader` does); no current source emits
  them. Header detection, blank-line and quote semantics match Python for the
  supported layouts.
- `isFiniteNumber` uses JS `Number()`: matches Python `float()` for the common
  cases (blank, `nan`, `inf`, `Infinity`, `1e5`, whitespace); Python-only
  numeric literal quirks (`1_000`, hex) are not supported.
- GEO adapter (`geo.expression.v1`) is not ported: Python itself marks that
  sibling import as Phase 5 T2, and the migration plan assigns GEO acquisition
  to Phase 5. `ADAPTER_REGISTRY` currently holds GDC + Xena.

## Constraints (unchanged from T1–T3)

- `pnpm install` still blocked (network + approval reviewer 503); real workspace gates pending.
- Worktree/branch + commit pending (approval outage); diff uncommitted on shared `main`.
- Stray untracked `packages/contracts/src/*.js` artifacts still to delete before commit.
- Commonly `[TASK]`/`[DONE]` still not posted (Commonly MCP 503).

## Next steps (Phase 4 step 5)

Canonicalization: sources of truth `backend/app/datasets/build/canonicalizer.py`
(18.5 KB) + `backend/tests/test_dataset_canonicalizer.py` (27 KB); the
canonicalizer consumes `DataBatch` output produced by this step and applies
entity/namespace/unit policies. Keep the same golden-fixture + Python-invariant
parity discipline.