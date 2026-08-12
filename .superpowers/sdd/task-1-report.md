# Task 1 Report: Phase 0A Root Workspace Foundation

## Status

DONE. The repository now has one root pnpm workspace, one root lockfile, a shared TypeScript base, and empty `@biomed/server` / `@biomed/contracts` package skeletons. Frontend runtime code, API payloads, Python code, and the Vite development entrypoint were not changed.

## Implementation

- Added a private root package with recursive `test`, `lint`, `typecheck`, and `build` scripts, Node `>=22.0.0`, and the existing integrity-pinned pnpm 11.14.0 declaration.
- Added the root workspace definition for `frontend`, `server`, and `packages/*`; retained the existing `allowBuilds.esbuild` policy at the new owner.
- Mechanically migrated the original frontend lockfile to the root and updated only workspace importers. A line comparison from `packages:` through the end of the lockfile reported `0` differences, so existing dependency resolutions were preserved.
- Renamed the frontend workspace package to `@biomed/frontend`, added the acceptance-facing `typecheck` alias, removed frontend package-manager ownership, and retained `dev: vite` unchanged.
- Added `tsconfig.base.json`; all three frontend TypeScript configs now extend it while retaining browser/Node-specific options and the existing `@/*` path alias.
- Added the non-runtime `@biomed/server` package and TypeScript configuration. It contains no API host or source entrypoint.
- Added the empty, compilable `@biomed/contracts` package. Its `src/index.ts` exports nothing and contains no migrated wire DTOs.
- Added `scripts/check-workspace-foundation.mjs`, a dependency-free automated structural check run by root `pnpm test`.

## Files Changed

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml` (migrated from `frontend/pnpm-lock.yaml`)
- `tsconfig.base.json`
- `scripts/check-workspace-foundation.mjs`
- `frontend/package.json`
- `frontend/tsconfig.json`
- `frontend/tsconfig.app.json`
- `frontend/tsconfig.node.json`
- deleted `frontend/pnpm-workspace.yaml`
- `server/package.json`
- `server/tsconfig.json`
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/index.ts`
- `.superpowers/sdd/task-1-report.md`

## TDD RED / GREEN Evidence

The automated check was added before any package or TypeScript configuration was changed.

RED command:

```powershell
& 'C:\Users\cheng\AppData\Local\nvm\v24.11.1\node.exe' '.\scripts\check-workspace-foundation.mjs'
```

RED result: exit 1 under Node v24.11.1 with the expected first failure:

```text
AssertionError [ERR_ASSERTION]: Missing package.json
```

GREEN command: the same focused command after implementation and the corrected frozen install.

GREEN result: exit 0 in 3.2 seconds:

```text
Workspace foundation checks passed.
```

## Acceptance Results

Every command was run separately from the repository root with a finite timeout.

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS, exit 0, 22.5 s | 4 workspace projects; lockfile up to date; pnpm 11.14.0 |
| `pnpm --filter @biomed/frontend build` | PASS, exit 0, 52.6 s | TypeScript build plus Vite 5.4.21; 7,403 modules transformed |
| `pnpm --filter @biomed/frontend test` | PASS, exit 0, 74.9 s | 54 files and 739 tests passed |
| `pnpm --filter @biomed/frontend lint` | PASS, exit 0, 30.8 s | ESLint completed with `--max-warnings 0` |
| `pnpm --filter @biomed/frontend typecheck` | PASS, exit 0, 5.9 s | `tsc --noEmit` completed |
| root `pnpm test` | PASS, exit 0, 73.5 s | foundation check plus frontend: 54 files and 739 tests passed |
| root `pnpm lint` | PASS, exit 0, 20.1 s | recursive frontend lint completed |
| root `pnpm typecheck` | PASS, exit 0, 8.7 s | frontend and contracts typechecks completed |
| root `pnpm build` | PASS, exit 0, 46.4 s | contracts TypeScript build and frontend Vite build completed |

## Self-Review

- Workspace lockfiles found at known workspace locations: only `pnpm-lock.yaml` at the repository root.
- `packageManager` occurrences across root/frontend/server/contracts manifests: root only.
- Root lockfile importers: `.`, `frontend`, `packages/contracts`, and `server`.
- Original versus migrated resolved lock sections: `0` differences.
- `git diff --check`: clean.
- No changed path under `backend/` or `frontend/src/`; no runtime UI, API, or Python changes.
- Root package has no `dev` script, and the automated check asserts the frontend remains `dev: vite`, so this task does not activate the future TypeScript Host.

## Interruption Diagnosis and Concerns

Two long-lived Node processes observed during closeout were read-only inspected rather than terminated. They were the Commonly MCP launcher (`npx -y @commonlyai/mcp`) and its `@commonlyai/mcp/src/index.js` child, not pnpm, Vitest, or a Task 1 acceptance command. Both full frontend test commands exited normally within their finite timeouts.

The build retains the pre-existing Vite warning for a JavaScript chunk larger than 500 kB. Frontend tests also retain pre-existing React `act(...)` diagnostics on stderr. Neither warning was introduced or changed by this structural task, and all required commands exited 0. Backend gates were not run because no Python/backend file changed and the Task 1 acceptance matrix is Node-only.
