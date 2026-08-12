# Task 2 Report: Phase 0B Shared Wire Contracts

## Status

DONE. Canonical TypeScript wire DTOs now live in `@biomed/contracts`; the
frontend runtime contract module remains a compatibility boundary and retains
only its three frontend input helpers. The HTTP/WebSocket schemas, event names,
literal values, optional fields, DatasetBuild semantics, and frontend behavior
were not changed.

## Recovered Partial Work

The interrupted implementer left intentional RED-side work at `3bec178`:

- modified `packages/contracts/package.json` with a package-local Vitest/typecheck setup;
- untracked `packages/contracts/tests/contracts.test.ts` and `tsconfig.test.json`;
- untracked `tests/migration/contracts/wire-contracts.json`;
- no production DTO extraction.

All recovered work was preserved. The JSON fixture and TypeScript tests were
completed with a backend Pydantic parity test; none of the partial files were
reset or discarded.

## TDD RED / GREEN

### RED

Focused command:

```powershell
& 'C:\Users\cheng\AppData\Local\nvm\v24.11.1\corepack.cmd' pnpm --filter @biomed/contracts test
```

Result: exit 1 at TypeScript compilation for the expected reason. The empty
package exported none of `BuildResult`, `DatasetManifest`,
`DatasetPublication`, `EventEnvelope`, `RunRecord`, `RunStatus`, `TaskMode`, or
`TaskSummary`. The one implicit-`any` diagnostic was downstream of the missing
`DatasetManifest` export. Test setup and syntax were otherwise valid.

An earlier invocation using the suggested `C:\nvm4w\nodejs\corepack.cmd` path
did not start because that shim path is absent in this environment; the
installed Node v24.11.1 Corepack path above was then used for all pnpm commands.

### GREEN

The same focused command passed after the extraction:

```text
1 test file passed; 3 tests passed
```

Python parity command from `backend/`:

```powershell
uv run pytest tests\test_wire_contract_parity.py -q
```

Result: `3 passed`. The first placement of the Python validator at the
repository root could not import `app`; moving the validator into the existing
backend test tree fixed test discovery while the shared fixture remained at
`tests/migration/contracts/`.

## Implementation

- Added focused canonical modules for JSON values, artifacts, dataset builds,
  task/run records, event envelopes/payloads, and WebSocket/realtime frames.
- Re-exported the complete canonical type surface through
  `packages/contracts/src/index.ts`.
- Replaced frontend DTO definitions with type-only re-exports from
  `@biomed/contracts`; retained `StartTaskInput`, `ContinueTaskInput`, and
  `ResumeRunInput` locally.
- Added the frontend workspace dependency using `workspace:*` and exposed the
  package source declarations for workspace consumers while retaining built JS
  as the default package export.
- Added one shared JSON fixture used by both TypeScript and Python tests. It
  freezes EventEnvelope schema/sequence/run linkage, all BuildResult statuses,
  the DatasetManifest artifact-role list shape, publication supersession, and
  TaskMode/RunStatus values.
- Preserved the existing frontend contract export names exactly; a PowerShell
  export-surface comparison reported no missing or additional named types.

## Files Changed

- `packages/contracts/package.json`
- `packages/contracts/tsconfig.test.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/json.ts`
- `packages/contracts/src/artifacts.ts`
- `packages/contracts/src/dataset-build.ts`
- `packages/contracts/src/task-run.ts`
- `packages/contracts/src/events.ts`
- `packages/contracts/src/websocket.ts`
- `packages/contracts/tests/contracts.test.ts`
- `frontend/package.json`
- `frontend/src/runtime/contracts.ts`
- `pnpm-lock.yaml`
- `tests/migration/contracts/wire-contracts.json`
- `backend/tests/test_wire_contract_parity.py`
- `.superpowers/sdd/task-2-report.md`

## Acceptance Results

| Command | Result |
| --- | --- |
| contracts focused test | PASS — 1 file, 3 tests |
| contracts package typecheck | PASS (root recursive gate) |
| contracts package build | PASS (root recursive gate) |
| backend focused parity pytest | PASS — 3 tests |
| backend focused Ruff | PASS |
| frontend focused runtime/API Vitest | PASS — 7 files, 230 tests |
| frontend typecheck | PASS |
| root `pnpm test` | PASS — workspace foundation, contracts 3, frontend 739 |
| root `pnpm lint` | PASS — zero errors/warnings |
| root `pnpm typecheck` | PASS — contracts and frontend |
| root `pnpm build` | PASS — contracts build and frontend production build |

The broad frontend test suite retained its pre-existing React `act(...)`
diagnostics, and the production build retained its pre-existing >500 kB chunk
warning. Both commands exited 0 and neither warning is related to the type-only
contract extraction.

## Self-Review

- Diff scope contains no Pi integration, TS Host, Agent loop, Dataset Core, or
  UI visual/component changes.
- `frontend/src/runtime/contracts.ts` is still the sole compatibility import
  boundary, so no broad frontend import rewrite occurred.
- Event discriminants, payload keys, schema versions, task-level sequence,
  nullability/optionality, status literals, artifact roles, and publication
  supersession match the prior frontend declarations and the shared fixture.
- `BuildResult.available_artifact_roles` remains `string[]`, preserving the
  existing frontend schema rather than opportunistically narrowing it.
- Package imports are type-only and use `.js` specifiers compatible with the
  emitted ESM declarations.
- No TypeScript `any`, `@ts-ignore`, or `@ts-expect-error` was introduced.
- Generated `dist/` and frontend build output did not enter the working diff.
- `git diff --check` and staged whitespace/conflict checks are clean.

## Concerns

No task-specific blocker remains. Full backend pytest and Uvicorn startup were
not rerun because this task changes no Python production code and the brief's
Python acceptance is the focused Pydantic parity test; the branch baseline
already records that the full backend suite exceeds the 15-minute command
limit on this Windows environment.
