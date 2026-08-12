# Phase 0/1 Environment Migration

This guide migrates an existing BioMed-QAgent checkout from the legacy split
frontend/FastAPI development environment to the Phase 1 root pnpm Workspace and
single TypeScript Host. It covers development environments and local data only; it does
not migrate durable Python Task/Event storage into a TypeScript runtime.

## 1. Required runtimes

Install these tools before copying configuration or data:

```powershell
node --version
pnpm --version
uv --version
```

Required versions:

- Node.js `>=22.19.0`;
- pnpm `11.14.0`, pinned by the root `packageManager` field;
- Python `3.12+`, managed through `uv` and `backend/uv.lock`.

On Windows with nvm-windows, activate the project Node version before installing:

```powershell
nvm use 24.11.1
node --version
pnpm --version
```

Do not copy `node_modules/`, `frontend/node_modules/`, or `backend/.venv/` between
machines, users, drives, or worktrees. These directories contain platform-specific
links and launchers. Recreate them from the committed lockfiles.

## 2. Create a clean checkout environment

Run Node setup from the repository root:

```powershell
pnpm install --frozen-lockfile
```

There is one authoritative `pnpm-lock.yaml` and one `pnpm-workspace.yaml`, both at the
repository root. Do not run a second install from `frontend/` and do not recreate
`frontend/pnpm-lock.yaml`. The server `dev` and `test` lifecycle scripts build the
`@biomed/contracts` runtime package automatically, so a clean checkout does not require
a manual build before either command.

Run Python setup from `backend/`:

```powershell
Set-Location backend
uv sync --frozen
Set-Location ..
```

If an old copied `.venv` reports `No Python at ...`, remove or archive only that
checkout's `backend/.venv`, then run `uv sync --frozen` again. Do not edit the launcher
or copy a Python executable into the environment.

## 3. Migrate environment variables

Start from the current root example, not an old frontend or backend example:

```powershell
Copy-Item .env.example .env
```

Move the existing provider credentials and model selection into the root `.env`:

```dotenv
DASHSCOPE_API_KEY=...
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
```

The normal Phase 1 topology is:

```dotenv
HOST=127.0.0.1
PORT=5173
APP_HOST=ts
AGENT_RUNTIME=legacy
DATASET_CORE=python
PI_EXPERIMENTAL=1
LEGACY_BACKEND_PORT=0
WORKSPACE_DEV_EXEC=0
```

`LEGACY_BACKEND_PORT=0` lets the Host allocate an unused private loopback port. This
avoids treating an unrelated service on a fixed port as the managed backend. The Host
generates a per-process bridge secret and verifies the new child through the protected
internal bridge before opening the public listener.

Do not set `PI_DATASET_BRIDGE_SECRET` for normal managed mode. Set it only when attaching
to a separately started diagnostic backend, and configure the same non-empty value on
both processes:

```dotenv
LEGACY_BACKEND_URL=http://127.0.0.1:8000
PI_DATASET_BRIDGE_SECRET=<random-local-secret>
```

The bridge fails closed without a secret. `/internal/migration/*` remains private and is
never proxied through the public Host.

## 4. Migrate local data

The Phase 1 Host still uses the Python durable runtime and V2 Dataset Core. Existing
task history and publications therefore remain under the Python output root; they are
not converted to a new TypeScript format.

If `OUTPUT_DIR` was previously configured, keep the same directory and convert it to an
absolute path:

```dotenv
OUTPUT_DIR=D:\data\BioMed-QAgent\output
```

When `OUTPUT_DIR` is omitted, both the Host and managed FastAPI use
`backend/data/output`. Preserve the full directory tree, including `tasks/`,
`datasets_build/`, publications, manifests, event logs, cache records, and user skill
data. Do not copy only CSV artifacts: manifests and provenance files are authoritative.

Before moving data between machines:

1. Stop the old frontend, FastAPI process, and all workers.
2. Copy the output directory while no process is writing to it.
3. Preserve filenames, relative paths, and file contents exactly.
4. Point the new root `.env` at the copied absolute `OUTPUT_DIR`.
5. Start the new Host and verify old `/api/v1` task/build endpoints before accepting new
   writes.

## 5. Validate the migrated environment

Run all repository gates from the root:

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Run backend gates from `backend/`:

```powershell
Set-Location backend
uv run pytest
uv run ruff check app/ tests/ launcher.py
Set-Location ..
```

Then start the normal application:

```powershell
pnpm dev
```

Verify:

- the browser uses only `http://127.0.0.1:5173`;
- `GET /api/v1/health` succeeds through the TypeScript Host;
- `/experimental/pi/*` is available only when `PI_EXPERIMENTAL=1`;
- public `/internal/migration/*` requests return 404;
- stopping `pnpm dev` removes the managed FastAPI and command process trees.

## 6. Rollback

Rollback changes the development entrypoint, not the data format. Stop the TypeScript
Host first, keep `OUTPUT_DIR` unchanged, then use the explicit diagnostic profile:

```powershell
pnpm dev:legacy-rollback
```

Other diagnostic commands are:

```powershell
pnpm dev:legacy-backend
pnpm dev:frontend-standalone
pnpm dev:host-proxy-only
```

These commands are migration/debug surfaces, not the normal development topology. Do
not run them concurrently on the same ports or output directory unless the profile
explicitly owns both processes.

## 7. Common migration failures

| Symptom | Cause | Action |
| --- | --- | --- |
| `pnpm` is not recognized | Project Node version is not active in the shell | Activate the pinned Node installation, then verify `node` and `pnpm` paths |
| Multiple or stale lockfiles | Install was run from the old frontend root | Delete generated frontend lock/workspace files and rerun root `pnpm install --frozen-lockfile` |
| `No Python at ...` | `.venv` was copied or its uv-managed base interpreter moved | Recreate only `backend/.venv` with `uv sync --frozen` |
| Host rejects attach mode | `PI_DATASET_BRIDGE_SECRET` is missing or differs | Set the same non-empty secret on Host and external backend |
| Host reports child exit before readiness | Python failed, port is occupied, or identity probe was rejected | Read the child startup error; do not accept an existing health endpoint as the new child |
| Old tasks are missing | `OUTPUT_DIR` changed or was left relative | Restore the original absolute output path and restart |
