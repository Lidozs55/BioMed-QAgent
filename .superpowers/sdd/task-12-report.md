# Task 12 — Phase 1G default entrypoint, docs, and final gates report

Status: implementation and Node-free static checks complete; executable final gates are
infrastructure-blocked because this machine no longer exposes the pinned Node/pnpm or
uv-managed Python runtimes.

Branch/worktree: `migration/pi-runtime-phase0-1` in the assigned migration worktree.

Starting HEAD: `2c28e88`

Commit: the commit containing this report, `chore: make TypeScript Host the default
entrypoint` (resolve with `git rev-parse HEAD`; no push was performed).

## Genuine RED → GREEN evidence

The first Node-free static contract failed before implementation with:

```text
RED: expected root pnpm dev to start @biomed/server; actual=''
```

`backend/tests/test_phase1g_default_entrypoint.py` was added first to freeze the root
default/debug scripts, normal Phase 1 profile, cross-platform launcher, and documented
root environment loading. A second focused RED showed that the existing server command
did not load root `.env`:

```text
RED: documented root .env is not loaded by server dev;
actual='tsc -p tsconfig.json && node dist/index.js'
```

The final PowerShell-equivalent static contract passed after the minimal implementation.
The pytest file remains part of the backend suite for repeatable execution once Python is
restored; it could not be collected on this machine for the infrastructure reason below.

## Entrypoint and rollback result

- Root `pnpm dev` now delegates to `@biomed/server`; the server loads optional root `.env`
  and owns managed private FastAPI, the explicit Pi experimental composition, Vite
  middleware, and the one browser-facing port.
- The default profile is `APP_HOST=ts`, `AGENT_RUNTIME=legacy`,
  `DATASET_CORE=python`, `PI_EXPERIMENTAL=1`. This keeps formal `/api/v1` authority on
  private legacy FastAPI while exposing Pi only under `/experimental/pi/*`. Invalid
  combinations continue to fail in `parseHostConfig` before listening.
- `dev:frontend-standalone`, `dev:legacy-backend`, `dev:host-proxy-only`, and
  `dev:legacy-rollback` are explicitly named migration/debug scripts.
- `scripts/dev-profile.mjs` avoids platform-specific inline environment syntax, starts
  direct `pnpm`/`uv` children, propagates the accepted profiles, and cleans owned process
  trees on signals or sibling failure (`taskkill /T /F` on Windows; process-group SIGTERM
  on POSIX).
- Workspace ownership remains one root `pnpm-workspace.yaml` and one root
  `pnpm-lock.yaml`.

## Documentation and status

Updated `.env.example`, root README, root/frontend AGENTS, Developer Quickstart,
ARCHITECTURE §2/§18.4, TODO, the migration boundary index, and the detailed Phase 0/1
plan. They now document:

- one-port TS Host composition and the private legacy formal/durable authority;
- the explicit live-only, non-durable Pi surface and Python V2 Core bridge;
- Workspace/publication authority, lifecycle/cancellation limitation, and rollback;
- public/private ports, bridge secret, Pi provider/model credentials, explicit fixture
  selection, development exec gate, and readiness/shutdown timeouts;
- normal root commands versus standalone/debug commands and Windows child cleanup;
- Phase 0/1 Definition-of-Done items supported by Task 5–11 focused, parity, and E2E
  evidence. Later phases were not changed.

## Final gate record

No missing runtime was installed, repaired, or reconfigured. After the known Task 11
runtime loss, the current preflight again found no `node` or `pnpm` command. Directly
starting `backend/.venv/Scripts/python.exe` failed before pytest collection with:

```text
No Python at
"C:\Users\cheng\AppData\Roaming\uv\python\cpython-3.12.11-windows-x86_64-none\python.exe"
```

An `uv --directory backend run ...` preflight also failed before Python execution while
accessing the external uv cache (`os error 183`). Per task instruction, no further runtime
attempt or system mutation was made.

| Gate | Current result |
| --- | --- |
| Root frozen `pnpm install` | infrastructure-blocked; pnpm/Node absent, no install executed |
| Root test/lint/typecheck/build | infrastructure-blocked; zero tests/checks executed |
| Backend Ruff | infrastructure-blocked; Python did not start |
| Backend full non-live pytest | infrastructure-blocked; zero files collected/executed, so no aggregate pass is claimed |
| Backend `__pycache__` cleanup + direct Uvicorn smoke | not run; no test-generated cache was removed and missing venv Python could not start |
| Normal root `pnpm dev` Windows smoke | infrastructure-blocked; no current startup/process claim is made |
| Golden verifier/parity/E2E executable suites | infrastructure-blocked; no current pass is claimed |
| JSON/package/static entrypoint contract | passed |
| Single root lockfile/workspace ownership | passed |
| Pi package import confinement | passed; only `server/src/agent/pi-adapter.ts` imports Pi |
| Internal bridge public exclusion | passed statically; explicit 404 guard and no-proxy assertion are present |
| Relative Markdown links in eight changed docs | passed; corrected the stale archived V1 architecture path |
| `git diff --check` / unmerged check | passed before report and repeated before commit |

The last executable evidence before the external runtimes disappeared remains Task 11's
server vertical/regression 56-test pass, frontend focused 7-test pass, backend bridge/golden
24-test pass, package lint/typecheck/build passes, and explicit zero-resource/child E2E
cleanup. Those results support the checked Phase 1 DoD but do not replace this task's
blocked final rerun.

## Files

- Entrypoint/config: `package.json`, `server/package.json`, `server/src/config.ts`,
  `scripts/dev-profile.mjs`.
- Contracts/tests: `scripts/check-workspace-foundation.mjs`,
  `server/tests/config.test.ts`, `backend/tests/test_phase1g_default_entrypoint.py`.
- Environment/docs/status: `.env.example`, `README.md`, `AGENTS.md`,
  `frontend/AGENTS.md`, `docs/DEVELOPER_QUICKSTART.md`, `docs/ARCHITECTURE.md`,
  `docs/TODO.md`, `docs/migration/README.md`, and
  `docs/BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md`.

## Handoff

No broad whole-branch review, merge, or push was performed. Commonly remained explicitly
out of scope. The implementation and static boundaries are ready for the one independent
whole-branch review; the reviewer/parent must rerun every infrastructure-blocked executable
gate after the external Node and Python runtimes are restored before claiming final gate
completion.
