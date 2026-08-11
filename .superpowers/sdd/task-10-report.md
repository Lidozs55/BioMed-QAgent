# Task 10 — Phase 1E trusted DatasetBuild bridge and Pi tools report

Status: complete

Branch/worktree: `migration/pi-runtime-phase0-1` in the assigned migration
worktree.

Starting HEAD: `6454ed7`

Commit: the commit containing this report, `feat: bridge Pi to DatasetBuild core`
(resolve with `git rev-parse HEAD`; no push was performed).

## Genuine RED evidence

- Contracts: the first focused run failed because the versioned bridge request
  and response parsers did not exist in `@biomed/contracts`.
- Python: collection failed with `ModuleNotFoundError: No module named
  'app.compat'` for the absent private bridge.
- Server: focused collection failed to resolve both
  `legacy/dataset-core-client.ts` and `agent/tools/dataset-build.ts`.
- The tests were written before their corresponding production modules. The
  final focused suites pass after the minimal implementation described below.

## Boundary and authority result

- `@biomed/contracts` owns the frozen DatasetBuildSpec shape and strict v1
  request/response/error DTOs. The only operations are validation, execution,
  and safe result lookup; cancellation remains a separate control route.
- The lifespan-created `PiDatasetBridge` reuses the existing task context
  factory and Task 5 service. It does not create another repository, manager,
  event store, runner, output directory, or publication implementation.
- The Python routes accept loopback clients only and, for a Host-spawned
  backend, require a random per-process secret passed only through the child
  environment and the sole TypeScript client. The public Host keeps
  `/internal/migration/*` outside its proxy surface.
- Inputs reject unknown fields/versions/operations, unsafe identities,
  malformed JSON, absolute/traversal/backslash references, and symlink escapes.
  Responses contain only logical build/publication/manifest/artifact identities
  and digests. Core exceptions are mapped to bounded typed errors without
  paths, secrets, rows, or tracebacks.
- `DatasetCoreClient` is the only TypeScript module containing the bridge URL,
  secret header, fetch transport, or cancellation URL. It validates loopback,
  request correlation, and every response before returning it.
- Pi validate/execute tools validate before execute, propagate the run
  AbortSignal, preserve all business outcomes, and emit bounded diagnostics
  containing only tool/request/build identities, typed result code, and
  duration. Pi package imports remain confined to `pi-adapter.ts`.

## Parity matrix

| Phase 0D outcome | Legacy FunctionTool versus bridge | Golden evidence |
| --- | --- | --- |
| `SUCCEEDED` | status, row count, accepted/rejected sources, reason codes, and all non-provenance artifact role/digests match | stable business fields and schema artifact digest match |
| `PARTIAL_SUCCESS` | same stable business fields match; response remains typed `partial_success`; all non-provenance artifact role/digests match | stable business fields and schema artifact digest match |
| `NO_DATA` | same stable business fields match; response remains typed `no_data`; no publication is claimed | all stable business fields match |
| `SPEC_REJECTED` | structured reason codes match (`unknown_schema`) | all rejection reason codes match |

The Phase 0D fixed-runner manifest/publication/provenance and primary bytes are
not asserted byte-for-byte against a fresh Task 5 service run: fresh service
runs intentionally contain generated source/download-attempt identities in
provenance and canonical rows, which changes those content-derived hashes.
For the same live fixture, bridge and legacy non-provenance artifact digests are
compared directly; the identity-independent schema digest is also compared to
the committed golden. Core remains the sole hash and publication authority.

## Cancellation evidence

- Active request IDs map to the exact lifespan task `RunContext` in a bounded
  128-entry registry and are removed in `finally` on every terminal path.
- The real-Core cancellation test holds the real
  `ExpressionBuildRunner._validate_profile` operation after it has completed,
  sends the bridge cancellation side-channel, and then releases the operation.
  `DatasetBuildExecutor` observes the same `cancellation_requested` token before
  publication. The original HTTP call then returns typed `cancelled`, no
  immutable version or `publication.json` exists, and the registry is empty.
- TypeScript cancellation sends the side-channel but awaits the bounded
  original response. A dropped transport or acknowledgement timeout becomes
  `bridge_unavailable`; it is never reported as acknowledged cancellation.

## Exact verification

- Focused contracts: 3 files, 13 tests passed.
- Focused Python bridge: 15 tests passed, including four-outcome parity,
  loopback/auth, malformed/family/entity rejection, result lookup, real-Core
  cancellation, collision cleanup, path/symlink protection, and error bounds.
- Focused backend bridge + Task 5 service + legacy tool + migration goldens:
  73 tests passed.
- Focused backend Ruff on changed backend files: passed.
- Focused server client/tools/Host/process: 4 files, 16 tests passed.
- Focused Pi adapter after its tool-call context assertion update: 11 tests
  passed.
- Server lint, typecheck, and build: passed.
- Root finite `pnpm test`: passed (contracts 13, server 81, frontend 745).
  Existing unrelated React `act(...)` warnings remain.
- Root finite `pnpm lint`: passed.
- Root finite `pnpm typecheck`: passed.
- Root finite `pnpm build`: passed with the existing Vite chunk-size advisory.
- Full backend `uv run pytest -q` was attempted with the agreed finite
  120-second cap and terminated at the cap without an assertion failure; the
  timeout also closed pytest's stdout pipe (`OSError 22`). Task 12 will run the
  backend full gate in finite file shards. No broad suite was rerun afterward.
- `git diff --check`: passed before report creation; repeated before commit.

## Task 11 limitations

- No live provider/model vertical slice was run. Task 11 must exercise the real
  Pi session, validation then execution, multi-turn run identity updates,
  cancellation, feature-profile startup, and Host shutdown.
- The bridge registry and Pi event path remain process-local migration state;
  they do not add durable replay or replace the legacy task/runtime authority.
- Task 11 should verify the private per-process secret across an actual managed
  Python spawn and confirm public browser requests still cannot reach the
  internal bridge.
- Task 12 owns the finite-sharded completion of the backend full test gate noted
  above.
