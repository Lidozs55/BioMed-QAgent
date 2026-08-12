# Pi Migration Phase 4 — T9 Report: Publication (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 9 (publication).
Branch: `codex/phase4-dataset-core-ts`.

## Summary

Ported the publication layer to TypeScript: the architecture-level release
invariants gate (`backend/app/datasets/build/invariants.py`), the role-based
manifest builder and deterministic package digest
(`backend/app/datasets/build/manifest.py`) and atomic publication promotion
(the publish path of `backend/app/datasets/build/expression_runner.py`).

## What was built / changed

| Area | Files |
| --- | --- |
| Publish module | `server/src/dataset/publish/{invariants,manifest,publisher}.ts`, `index.ts` |
| Parity checks (vitest-free) | `server/tests/publication-parity.ts` — invariants, manifest, publisher |
| Vitest suite | `server/tests/dataset-publication.test.ts` (3 tests) |

## Invariants mirrored

- **Release gate** (`checkReleaseInvariants`): provenance closure (document
  present, source count vs manifest declaration, exact source-asset set match
  when `expectedSourceAssetIds` is supplied), profile passed (never promote a
  failed validation), atomic promotion (publish dir writability probe +
  duplicate version refusal), and the B4 artifact inventory (every manifest
  artifact must exist with the exact declared size/SHA-256).
- **Manifest** (`assembleManifest`): role inventory (exactly one
  primary_dataset at `merged/primary.csv`, plus schema/provenance/audit_report),
  deterministic `packageDigest` (sorted by relative path, order independent),
  provenance document backtraces, `computeProvenanceCoverage` (traced/untraced/
  ratio 0.5), `buildConfidenceSummary` (report + missing report), and C3a
  artifact ids that include the relative path (identical bytes at two paths
  never collide; stable per path).
- **Publisher** (`promotePublication`): content-addressed immutable version dir
  (`publish/<build_id>_<digest16>`), staged-temp + rename atomicity, B3
  artifact relative-path preservation, C1d `validation_result_ref` closure
  (validation report copied into the version), build-scoped supersede chain
  (`findLatestPublication` by `published_at`, never lexicographic), duplicate
  version rejection, and the H2 pending-input recheck that refuses promotion
  at the rename boundary without leaving a version or stray staged dir.
- PyFloat coverage ratio serializes as `1.0` under `pythonJsonDumps`, keeping
  the manifest JSON byte-identical to Python's `json.dumps(round(ratio, 4))`.

## Verification evidence

- Strict typecheck: exit 0.
- ESLint (server type-aware config): 0 errors.
- Vitest: T1–T10 dataset suites 53/53 passed.
- All new files UTF-8 no BOM, CRLF line endings.

## Known deviations (intentional, non-blocking)

- `published_at` is injectable for deterministic tests (Python default
  `datetime.now(UTC)`); the default remains Python-ISO compatible.
- Operation timeouts and event sinks are not part of the sync TS executor
  (they land with the TS Host integration; see the T10 report).

## Next steps

Phase 4 step 10 (checkpoint/retry/cancel) — the fixed-skeleton executor with
digest-matched reuse, resume, cancellation and inflight recovery.