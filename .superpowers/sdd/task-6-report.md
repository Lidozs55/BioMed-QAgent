# Task 6 Report: Phase 1A TypeScript Application Host Shell

## Status

DONE. `@biomed/server` now provides the Phase 1A one-port TypeScript
Application Host shell. It validates the migration flags, starts or attaches a
loopback-only legacy FastAPI backend, waits for legacy health before listening,
embeds Vite middleware/HMR on the Host HTTP server, proxies the unchanged legacy
HTTP and WebSocket surfaces, and rejects the internal migration namespace.

Legacy FastAPI remains the only authority for `/api/v1/*` and `/api/v1/ws`.
This task adds no Pi dependency or implementation, durable repository/runtime,
Dataset Core, settings store, experimental state, frontend change, backend
change, or root `dev` script.

## TDD RED evidence

The five Host test suites were added before `server/src/` existed:

```powershell
& 'C:\Users\cheng\AppData\Local\nvm\v24.11.1\corepack.cmd' pnpm --filter @biomed/server test
```

Expected RED result: five failed suites, zero tests collected. Each suite failed
because its required production module was missing:

```text
../src/config.js
../src/app/create-app.js
../src/app/lifecycle.js
../src/legacy/backend-process.js
../src/dev/vite-middleware.js
```

This was the intended missing Phase 1A implementation, not a syntax, fixture,
or environment failure. After the minimal implementation, the same command
passed: 5 files and 18 tests.

## Files changed

- `server/src/config.ts`
  - Parses the four documented flags once, recognizes exactly the four Phase
    0/1 profiles, and requires `APP_HOST=ts` for this server entry.
  - Validates explicit public/legacy ports and bounded readiness/shutdown
    timeouts; the current shell defaults to the TS proxy-only profile.
- `server/src/app/lifecycle.ts`
  - Adds an idempotent reverse-order closer registry with a bounded timeout per
    closer and aggregated cleanup errors.
- `server/src/app/create-app.ts`
  - Composes one Node HTTP server, legacy readiness, the injectable future Pi
    lifecycle seam, proxy, Vite middleware, public listen, route ownership, WS
    upgrades, and partial-startup cleanup.
  - Opens the public listener only after required private resources are ready.
- `server/src/legacy/backend-process.ts`
  - Supports loopback-only attach mode without external-process ownership.
  - Otherwise starts `backend/.venv` Python directly from `backend/` with
    `-m uvicorn app.main:app --host 127.0.0.1 --port <private-port>`, waits for
    `/api/v1/health`, and terminates the owned child exactly once.
- `server/src/legacy/proxy.ts`
  - Uses the maintained, typed `http-proxy-3` package for transparent legacy
    HTTP/WS forwarding and closes proxied sockets during shutdown.
- `server/src/dev/vite-middleware.ts`
  - Creates Vite in middleware mode rooted at `frontend/` and binds HMR to the
    same Host HTTP server.
- `server/src/index.ts`
  - Supplies the package-local composition root and converges `SIGINT` and
    `SIGTERM` on the same idempotent shutdown path.
- `server/tests/*.test.ts`
  - Covers the flag matrix, attach/managed ownership, exact child command and
    loopback binding, readiness failure, HTTP/WS proxy fidelity, internal-route
    rejection, Vite fallback/HMR wiring, public/private listener topology, and
    reverse/idempotent bounded shutdown.
- `server/package.json`, TypeScript/ESLint configs, and `pnpm-lock.yaml`
  - Add finite `test`, `lint`, `typecheck`, and `build` scripts plus the
    package-local `dev` start script. Root recursive scripts include the server;
    root `dev` remains absent.

## Exact checks and results

Toolchain and frozen install:

```text
Node v24.11.1
pnpm 11.14.0
pnpm install --frozen-lockfile
PASS — all four workspace projects already up to date
```

Server package:

```text
pnpm --filter @biomed/server test
PASS — 5 files, 18 tests

pnpm --filter @biomed/server lint
PASS — 0 errors, 0 warnings

pnpm --filter @biomed/server typecheck
PASS

pnpm --filter @biomed/server build
PASS
```

Root acceptance:

```text
node scripts/check-workspace-foundation.mjs
PASS

pnpm test
PASS — server 18, contracts 3, frontend 739 tests

pnpm lint
PASS

pnpm typecheck
PASS

pnpm build
PASS
```

The root test retained the already-recorded frontend React `act(...)` stderr;
the root build retained the already-recorded Vite chunk-size warning. Neither
originates in Task 6. No backend command was rerun because Task 6 changes no
Python/backend file and the brief requested the finite Node acceptance above.

Authority/scope inspection found no server import or construction of
`TaskRepository`, `TaskManager`, `EventStore`, Dataset Core, Pi adapter/runtime,
settings storage, or experimental durable state. `git diff --check` and
`git diff --cached --check` passed.

## Commit

Implementation commit: `1d1a223` (`feat: add TypeScript application host shell`).

No push, merge, worktree cleanup, Commonly action, or broad review was
performed, as requested.

## Later-stage integration notes

- Task 7 should register Pi session cleanup through
  `ApplicationHostOptions.initializeLifecycle`; it must keep all Pi imports
  behind the planned adapter and must not replace the legacy formal API proxy.
- Task 10 must keep `/internal/migration/*` loopback-only. The Host deliberately
  rejects that namespace instead of forwarding it publicly; a later bridge
  client should call the private legacy target directly.
- Task 12 may make the existing package-local `@biomed/server dev` command the
  root default only after the experimental Pi path is ready. Task 6 intentionally
  leaves the repository-root `dev` entry absent.
- Attach mode is diagnostic/external ownership: Host shutdown never kills it.
  Managed mode owns only the direct virtualenv Python child and keeps the
  private bind fixed at `127.0.0.1`.
