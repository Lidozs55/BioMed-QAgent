# BioMed-QAgent — AGENTS.md

> This file defines working rules for all agents. It is a concise guide only —
> architecture and design decisions live in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (authoritative entry, with
> per-topic files under `docs/architecture/`). Do not duplicate architecture
> content here to avoid drift.
>
> Part I: universal rules. Part II: Commonly MCP extensions that stack on top
> when a Commonly connection is present.

---

## Current Architecture Snapshot

- Migration Phase 0–8 completed (2026-08-14): the only formal topology is
  **TS Host + Pi Agent + TS Dataset Core**. Legacy Python Runtime / FastAPI /
  rollback profiles / feature flags are physically removed.
- The TypeScript Application Host owns the single browser-facing port, Vite
  middleware, formal `/api/v1/*` HTTP/WS traffic, Pi `task_ts_*` Task/Run/Event,
  product APIs, settings, and the TypeScript Dataset Core.
- Python exists only as the `database/` persistence bridge
  (`database/bridge.py`, stdlib, JSONL named-op), managed on demand by
  `server/src/persistence/db-client.ts`. There is no Python web server.
- Durable event WebSocket endpoint: `/api/v1/ws` (protocol and `EventEnvelope`
  schema: `docs/architecture/runtime-events.md` and `packages/contracts/src/events.ts`).

## Prerequisites & Secrets

- Tools: Node.js 22.19+, pnpm, Python 3.12+, uv, Git.
- Load API keys from environment variables or a local untracked `.env` file;
  never commit real secrets. The settings API masks keys — do not log or expose
  raw credentials.

---

## Part I: Universal Rules (All Agents Must Follow)

### 1. Tech Stack

| Layer                  | Technology                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| Application Host       | Node.js 22.19+, TypeScript, Vite middleware                      |
| Main Agent             | Pi (adapter-confined via `server/src/agent/pi-adapter.ts`)       |
| Dataset Core           | TypeScript deterministic core (`server/src/dataset/`)            |
| Python Persistence     | `database/` bridge only (Python 3.12+, stdlib, JSONL named-op)   |
| Frontend               | React 19, Vite, Tailwind CSS v4, shadcn/ui                       |
| Package Manager (TS)   | pnpm (**never npm**)                                             |
| Package Manager (Py)   | uv, scoped to the root `pyproject.toml` / `uv.lock` for `database/` only |

### 2. Architecture Overview

The system is a **two-layer structure: Agent + Deterministic Pipeline**. Key
points (details in `docs/ARCHITECTURE.md`):

- Normal development starts from root `pnpm dev`; `pnpm start` serves the
  production bundle. `dev:frontend-standalone` is a migration/debug-only
  diagnostic, not the normal entry.
- The default Main Agent is Pi behind `server/src/agent/pi-adapter.ts`.
- Deterministic dataset execution is the TypeScript Dataset Core in
  `server/src/dataset/` (validate / execute / cancel; operation timeout, build
  lock, event sink).
- The durable runtime is event-sourced in `server/src/runtime/`:
  `TaskRepository` owns the authoritative `<task_id>/events.jsonl` log; snapshots
  are rebuilt by the TypeScript reducer. Pi and TS Dataset Core events enter the
  same task stream.
- Always treat code as the source of truth for skill/tool implementation
  status — do not assume from documentation alone.

### 3. Project Documentation Guidance

Before starting any task, consult:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture entry and index
  (authoritative).
- [PROBLEM.md](PROBLEM.md) — competition background and evaluation criteria.
- [docs/TODO.md](docs/TODO.md) — current development tasks and approved decisions.

### 4. Common Commands

#### Normal development (cwd: repository root)

```bash
pnpm install --frozen-lockfile    # Install the single workspace lockfile
pnpm dev                          # Start TS Host + Pi + TS Core + Vite (only normal entry)
pnpm test                         # Contracts + server + frontend tests (bounded concurrency)
pnpm test:full                    # Full-speed tests (CI, or when you want it fastest)
pnpm lint                         # Workspace lint
pnpm typecheck                    # Workspace TypeScript checks
pnpm build                        # Workspace production builds
```

`pnpm dev` is the only normal development startup command; `pnpm start` serves
the production bundle (`frontend/dist` static hosting). `dev:frontend-standalone`
is a migration/debug-only script (Vite standalone diagnostic proxying to the TS
Host), not the normal entry.

**Test concurrency is bounded by default** (budget and coverage:
[docs/test-concurrency.md](docs/test-concurrency.md)): root `pnpm test` limits
workspace concurrency via `--workspace-concurrency=2`, and each vitest config
caps its worker count (server `forks`/2, frontend `threads`/4, contracts
`threads`/2) so local workers do not saturate the CPU. CI (`CI=true`) lifts the
vitest caps automatically. Use `pnpm test:full` locally for full speed (drops the
workspace-concurrency limit, equivalent to the old `pnpm test`). To throttle,
pass vitest CLI args directly, e.g.
`pnpm --filter @biomed/server test -- --maxWorkers=1`.
#### Python database bridge checks (cwd: repository root)

Python is limited to the `database/` persistence bridge (root `pyproject.toml`):

```bash
uv sync                                  # Install database project deps
uv run python database/bridge.py --self-test   # Bridge self-test
uv run pytest database/tests             # Bridge protocol/persistence tests
uv run ruff check database               # Lint (CI quality gate, zero warnings allowed)
```

Notes:

- The bridge is stdlib-only (argparse/json/sqlite3/pathlib/dataclasses); pytest
  and ruff are dev-only dependencies.
- The bridge process is managed by the TS DatabaseClient
  (`server/src/persistence/db-client.ts`): JSONL stdin/stdout named ops, exit on EOF.
- Do not add Python runtime dependencies, a second Python entrypoint, or turn the
  bridge into an HTTP service.

#### Frontend package checks (cwd: `frontend/`)

All frontend commands must run from the `frontend/` directory.

```bash
pnpm install                               # Install dependencies
pnpm dev                                   # Standalone frontend diagnostic only
pnpm build                                 # Production build (tsc -b && vite build)
pnpm lint                                  # ESLint (--max-warnings 0)
pnpm tsc                                   # TypeScript type check (tsc --noEmit)
pnpm test                                  # Run unit tests once (vitest run)
pnpm test:watch                            # Run unit tests in watch mode (vitest)
```

### 5. Technical Conventions

- **Python**: PEP 8, mandatory type annotations on all function signatures;
  restricted to `database/` (stdlib, no third-party runtime deps).
- **TypeScript / React**: follow shadcn/ui component patterns and Tailwind
  utility classes; use the `@/` path alias.
- **Imports**: `database/` uses flat imports (works in both script and package
  contexts); frontend uses `@/...`.
- **Type safety**: never suppress type errors — no `as any`, `@ts-ignore`, or
  `@ts-expect-error`.
- **Testing**: `database/` uses pytest; server/frontend use vitest. Every new
  feature ships with tests; every bug fix starts with a reproducing test.
- **Frontend components**: use the shadcn skill to discover existing components;
  do not reinvent the wheel (see [frontend/AGENTS.md](frontend/AGENTS.md)).
- **Architecture boundaries**: do not reintroduce legacy Python Runtime,
  FastAPI, rollback feature flags, or `/experimental/pi` (guarded by
  `server/tests/phase8-architecture-guard.test.ts` and
  `database/tests/test_database_store.py::test_no_forbidden_imports_in_database_package`);
  new wire DTOs belong in `@biomed/contracts` first.

### 6. Development Principles

- **Think first, code later**: state assumptions explicitly; when multiple
  interpretations exist, list them and ask before acting; stop and clarify when
  unclear.
- **Minimal implementation**: write only the code necessary to solve the
  problem. Do not add unrequested features, extension points, or "just in case"
  abstractions. Do not handle theoretically impossible errors. If 200 lines can
  be compressed to 50, rewrite immediately.
- **Surgical changes**: touch only the files needed to achieve the goal. Do not
  "incidentally" modify unrelated code, comments, or formatting. Clean up only
  your own orphans (unused imports/variables); do not remove existing dead code
  unless explicitly asked. Match existing style even if it differs from personal
  preference.
- **Goal-driven execution**: break tasks into verifiable checkpoints ("write a
  repro test → fix → test passes"). Use a checklist for multi-step work and
  verify after each step. Advance only when a checkpoint passes, to avoid
  accumulating issues.

### 7. Git Workflow

#### 7.1 Branch Policy

- Prefer a dedicated branch per task, named like `feat/TASK-XXX-summary` or
  `fix/summary`.
- **Single-file small changes** (typos, config tweaks) may be committed directly
  to `main`, but you must:
  - `git pull` to sync first;
  - Confirm no other agent is editing the same file (see Part II §3 when a
    Commonly connection is present).
- Multi-file changes, new features, or changes that may affect other agents
  **must** use a dedicated branch.
- Before creating a new branch, run `git branch -r` to check the remote and
  avoid naming collisions.

#### 7.2 Self-Serve Merge

**Each agent is responsible for merging its own branch**. Before merging, all of
the following must hold:

1. The branch is functionally stable and the target changes are achieved.
2. All checks in **7.3 Quality Gates** pass.
3. The merge represents one complete functional unit (see merge constraints below).

**Merge steps**:

- Choose the sync strategy based on branch scale:
  - **≤5 commits** (single-digit): `git pull --rebase origin main`, keeping a linear history.
  - **>5 commits**: `git fetch origin main && git merge origin/main`, resolving conflicts once instead of per-commit.
  - **Heed conflict scope**: even a ≤5-commit branch that touches files heavily modified in `main`'s recent history may benefit from merge rather than rebase.
- After resolving conflicts, **re-run all Quality Gates**.
- `git merge --no-ff main` to merge the feature branch into local `main`
  (preserving branch topology), or rebase then push.
- Before pushing, confirm local `main` starts cleanly.
- After merging, post a `[DONE]` message summarizing the result (Part II §4 if
  connected to Commonly).

**Merge constraints**:

- **Never force-push to shared branches** (main, dev). If push is rejected, run
  `git pull --rebase` first, then push.
- **Merge granularity**: one merge to `main` must represent one complete
  functional unit. Bundle related `feat` + `fix` + test + doc changes into the
  same branch and merge them together.
- **One feature, one merge**: do not chain multiple merges for sub-steps of the
  same feature. If the feature is not yet complete, keep committing on the
  branch; only merge when the functional unit is whole and self-verifying.

#### 7.3 Quality Gates

The following checks **must all pass** before pushing a branch **and** before
merging to `main`.

- **Node workspace + Python bridge**
  - `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build` pass;
  - `uv run python database/bridge.py --self-test` passes;
  - `uv run pytest database/tests` and `uv run ruff check database` pass.
- **Commit message**
  - Format: `[TASK-XXX] summary` or `feat/fix/chore: summary`. Prefer
    conventional commit message style.

#### 7.4 Parallel Tasks Must Use Separate Worktrees

Multiple agents may work in this repository at the same time and they all share
the **same working directory**. Never `git switch` the shared branch to start a
new task — that changes the files every other agent sees and can clobber their
uncommitted work. Instead, isolate each task in its own worktree:

```bash
# From the repo root: create an isolated workspace for a branch
git worktree add ../BioMed-QAgent-<branch-name> <branch-name>
# Work inside the new directory, commit there, then remove it when done
git -C ../BioMed-QAgent-<branch-name> push -u origin <branch-name>
git worktree remove ../BioMed-QAgent-<branch-name>
```

Rules:

- The main working directory keeps the branch the user/other agents are actively
  using; do not switch it for your own task.
- Scratch files (`_tmp_*`, test artifacts, build output) belong in your task's
  worktree, never in the shared directory.
- Run `git worktree list` before starting and reuse an existing worktree for the
  same branch instead of creating duplicates.

### 8. Documentation First

Proactively capture knowledge under `docs/`:

- Error-prone integration points (API parameter quirks, environment traps).
- Identified but unfixed bugs or tech debt.
- Complex trade-offs or architecture decisions.
- Non-obvious usage patterns or conventions (e.g., internal tool call sequences).

**Principle**: code says "how", docs say "why". Do not make other agents (or
your future self) re-derive your reasoning. Document names are not prescribed;
place content into the most fitting existing document to avoid scattering and
duplication.

---

## Part II: Commonly MCP Extensions (Mandatory When Connected)

When an agent session is connected to the Commonly MCP server, the following
rules **stack on top of** Part I.

### 1. Work Types and Check-In

| Work type         | Check-in required? | Method                                                                                                           |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Coding & fixes    | **Yes**            | `[TASK]` before starting, `[DONE]` upon completion                                                               |
| Research & review | No                 | If **high-risk / high-value** info is found (architecture flaws, risks, etc.), share via `[Q]` or a new `[TASK]` |

### 2. Task Source and Corresponding Workflow

#### 2.1 User Explicitly Assigns a Commonly Board Task

When told to handle a Commonly task, follow the board lifecycle strictly:

1. Sync: `commonly_get_tasks` + `commonly_get_messages`.
2. Claim: `commonly_claim_task` (claim only one task at a time).
3. Work: execute per Part I; open a branch if needed.
4. Verify & commit: after self-check passes, run
   `git commit -m "[TASK-XXX] description" && git push`.
5. Merge the branch to `main` (Part I §7.2), then post `[DONE]` summarizing the
   changes and branch name, then `commonly_complete_task`.
6. Stuck for a full round with no progress → post `[BLOCKED]` and unclaim.

#### 2.2 User Gives a Direct Instruction (Non-Board Task)

When the user gives an immediate request and no board task corresponds, use a
lightweight check-in:

1. Before starting, post:
   `[TASK] brief description, working on branch <branch-name>`
   (for single-file small changes that do not need a branch, write:
   `[TASK] brief description, directly modifying main: <file-path>`).
2. Execute per Part I §7 branch/modification rules.
3. On completion, post:
   `[DONE] change summary, merged to main`
   (or `[DONE] change summary, pushed to main`).

No `claim` / `complete` actions are needed.

#### 2.3 High-Value Findings

If research or review reveals issues worth tracking, start a discussion with
`[Q]`, or create a new task via `commonly_create_task` (prefix the title with
`[P0]` / `[P1]` / `[P2]`, fill in `source` and hard dependencies `dep`).

#### 2.4 Keep the Commonly Board in Sync with `docs/TODO.md`

`docs/TODO.md` is the authoritative plan (tasks + acceptance criteria); the
Commonly board is the execution-status view of that plan. To avoid circular
updates:

- New planned work originates from `docs/TODO.md` entries → create a board task
  with `source` set to `docs/TODO.md`.
- Claim / in-progress / blocked / completed status is maintained on the board
  (`commonly_claim_task`, `commonly_update_task`).
- When a task completes or its priority changes, write the outcome back to the
  matching `docs/TODO.md` checkbox.
- Never edit the same semantic field in both places at once.

Also create board tasks immediately for new bugs / tech debt / uncovered
requirements found during work (prefix `[P0]` / `[P1]` / `[P2]`, fill `dep`).

### 3. Lightweight Coordination and Branch Reporting

- **Pre-check for branchless small changes**: after posting `[TASK]` declaring a
  direct edit to `main`, scan recent Commonly messages (about 10) to confirm no
  other agent is working on the same file. If no conflict, proceed; if a
  conflict is suspected, negotiate via `[Q]` or switch to a branch.
- **After pushing a branch**: always post a `[DONE]` message summarizing the
  changes and impact, and mention the branch name.

### 4. Message Prefix Conventions

| Prefix      | Purpose                                   |
| ----------- | ----------------------------------------- |
| `[TASK]`    | Task start check-in / new task record     |
| `[Q]`       | Question, discussion                      |
| `[DONE]`    | Work completed (must include branch info) |
| `[BLOCKED]` | Blocker announcement                      |

- Use `replyToMessageId` to keep threads.
- Every message must contain substantive information; avoid empty notifications.
- For architecture decisions or uncertain choices, post a `[Q]` first.

### 5. Pod Information

- **Pod ID**: `6a520e34f4baa9b280bba195`
- Task numbers are auto-assigned by Commonly; board and `docs/TODO.md` stay in
  sync per §2.4.

### 6. End-of-Round Self-Check (Mandatory)

**At the end of every work round** — whether the round completed a task, hit a
blocker, or ran out of context — the agent must re-read this `AGENTS.md` in
full and verify the workflow was followed. This is a hard checkpoint, not a
suggestion.

Checklist to run through:

1. **Commonly check-in**: did this round post `[TASK]` at the start and
   `[DONE]` (or `[BLOCKED]`) at the end? If not, post the missing message now.
2. **Branch policy**: were multi-file changes made on a dedicated branch? Were
   single-file tweaks committed to `main` only after the pre-check in §3?
3. **Pre-push verification** (Part I §7.3): did `pnpm test` / `pnpm lint` /
   `pnpm typecheck` / `pnpm build` pass? Did `uv run pytest database/tests` and
   `uv run ruff check database` pass (if `database/` changed)?
4. **Board sync** (§2.4): are the `docs/TODO.md` checkboxes and the Commonly
   board in sync with what was actually done this round?
5. **Documentation** (Part I §8): did this round introduce a non-obvious
   decision, integration quirk, or trade-off that should be captured under
   `docs/`?
6. **Workflow drift**: did any step skip a mandated check (claim, file lock,
   rebase, `[DONE]` summary)? If yes, retroactively fix what is recoverable
   and note what is not.

If any item is missing, complete it before starting the next round. The purpose
is to prevent workflow drift across long multi-round sessions where context is
compressed — this `AGENTS.md` is the stable source of truth that survives
context resets.

---

## Definition of Done

A task is done only when:

- All relevant Quality Gates pass (Part I §7.3);
- Tests cover new behavior / reproduce the fixed bug;
- Changes are merged to `main` (or the branch is pushed with a `[DONE]` report);
- `docs/TODO.md` and the Commonly board (if connected) reflect the outcome;
- Any non-obvious decision is captured under `docs/` (Part I §8).
