# BioMed-QAgent — AGENTS.md

> This file defines working rules for all **agents**. It is a concise guide only —
> architecture and design decisions live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> (authoritative entry, with per-topic files under `docs/architecture/`); do not
> duplicate architecture content here to avoid drift.
>
> Single, non-conditional logic: **Commonly coordination is a standard part of
> the workflow for every agent**, not a separate extension that only stacks when
> connected.

## Prerequisites & Secrets

- Tools: Node.js 22.19+, pnpm, Python 3.12+, uv, Git. Use the versions pinned in
  `package.json` / `pyproject.toml`.
- API keys: load from environment variables or a local untracked `.env`; never
  commit real secrets. The settings API masks keys — do not log or expose raw
  credentials.
- Package managers: **pnpm** for TypeScript (never `npm`); **uv** for Python,
  scoped to the root `pyproject.toml` / `uv.lock` for `database/` only.
- All **npx**/`npm i -g` installs below are the single exception to the "no npm"
  rule (they are Node package installs, not the repo's dependency manager).

## Architecture

The system is a **two-layer Agent + Deterministic Pipeline** (see
`docs/ARCHITECTURE.md`):

| Layer              | Technology                                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| Application Host   | Node.js 22.19+, TypeScript, Vite middleware                                 |
| Main Agent         | Pi (adapter-confined via `server/src/agent/pi-adapter.ts`)                  |
| Dataset Core       | TypeScript deterministic core (`server/src/dataset/`)                       |
| Python Persistence | `database/` bridge only (Python 3.12+, stdlib, JSONL named-op)              |
| Frontend           | React 19, Vite, Tailwind CSS v4, shadcn/ui                                  |

Key invariants:

- Normal development entry is root `pnpm dev`; `pnpm start` serves the production
  bundle. `dev:frontend-standalone` is a migration/debug-only diagnostic, not the
  normal entry.
- Deterministic dataset execution is the TS Dataset Core: validate / execute /
  cancel, with operation timeout, build lock, and event sink.
- The durable runtime is event-sourced in `server/src/runtime/`: `TaskRepository`
  owns the authoritative `<task_id>/events.jsonl` log; snapshots are rebuilt by
  the TypeScript reducer. Pi and TS Dataset Core events enter the same task
  stream, managed by `server/src/runtime/`.
- Python exists **only** as the `database/` persistence bridge (`database/bridge.py`,
  stdlib, JSONL named-op), managed by the TS DatabaseClient
  (`server/src/persistence/db-client.ts`: stdin/stdout named ops, exit on EOF). No
  Python web server, no second Python entrypoint, no Python runtime deps.
- **Forbidden**: reintroducing legacy Python Runtime, FastAPI, rollback feature
  flags, or `/experimental/pi` (guarded by
  `server/tests/phase8-architecture-guard.test.ts` and
  `database/tests/test_database_store.py::test_no_forbidden_imports_in_database_package`).
- New wire DTOs belong in `@biomed/contracts` first.
- The explicit `in_process_unisolated` Family Host/Core publication chain is a
  stable `main` baseline. Continue recovery/resource/identity hardening, family
  product closure, frontend UX, and release evidence on dedicated branches or
  worktrees; do not reopen sandbox/container/IPC work without a new ADR.
- Always treat code as the source of truth for skill/tool implementation status —
  do not assume from documentation alone.

## Project Documentation Guidance

Before starting any task, consult:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture entry and index
  (authoritative).
- [PROBLEM.md](PROBLEM.md) — competition background and evaluation criteria.
- [docs/TODO.md](docs/TODO.md) — current development tasks and approved decisions.

### Context budget: what to load, what to skip

- **Current sources only**: `docs/ARCHITECTURE.md` + `docs/architecture/*` +
  `docs/adr/README.md` (then the matching `docs/adr/NNN-*.md` as needed),
  `docs/FEATURES.md`, `docs/DEVELOPER_QUICKSTART.md`, `docs/TODO.md`,
  `docs/ISSUES.md`, `README.md`, `AGENTS.md`, `.pi/skills/*/SKILL.md`.
- **Do not load as current evidence**: `docs/archive/**` and `docs/migration/**` are
  historical records (retired Python runtime, Phase 0-8 migration, past reviews and
  plans). **Nothing was deleted** - files were moved or archived, and can be restored
  from git history. For why/history questions, consult them explicitly; never treat
  them as current behavior. Moved paths are indexed in `docs/ARCHITECTURE.md` 文档地图
  (§ 文档位置变更对照).
- **Prefer topic files over whole indexes**: for a specific boundary read the matching
  `docs/adr/NNN-*.md` and `docs/architecture/*.md` chapter instead of loading the
  whole `ARCHITECTURE.md`.
- When searching, `rg` the narrowest directory (e.g. `server/src/dataset/`) before
  opening large docs.

## Common Commands

### Normal development (cwd: repository root)

```bash
pnpm install --frozen-lockfile    # single workspace lockfile
pnpm dev                          # TS Host + Pi + TS Core + Vite (only normal entry)
pnpm test                         # contracts + server + frontend tests
pnpm test:full                    # full-speed tests (fastest local run)
pnpm lint                         # workspace lint
pnpm typecheck                    # workspace TypeScript checks
pnpm build                        # workspace production builds
```

Tests run with bounded concurrency by default; for concurrency, CI behavior, and
throttling options see [docs/architecture/test-concurrency.md](docs/architecture/test-concurrency.md).

### Python database bridge (cwd: repository root)

```bash
uv sync                                     # install database project deps
uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database                  # zero warnings allowed
```

The bridge is stdlib-only (argparse/json/sqlite3/pathlib/dataclasses); pytest and
ruff are dev-only dependencies.

### Frontend (cwd: `frontend/`)

```bash
pnpm install
pnpm build                  # production build (tsc -b && vite build)
pnpm lint                   # ESLint (--max-warnings 0)
pnpm tsc                    # type check (tsc --noEmit)
pnpm test                   # unit tests once (vitest run)
pnpm test:watch             # unit tests watch mode (vitest)
```

`pnpm dev` in `frontend/` is a standalone diagnostic only, not the normal entry.

## Technical Conventions

- **Python**: PEP 8, mandatory type annotations on all function signatures;
  restricted to `database/`; flat imports.
- **TypeScript / React**: follow shadcn/ui component patterns and Tailwind
  utility classes; use the `@/` path alias.
- **Imports**: `database/` uses flat imports; frontend uses `@/...`.
- **Type safety**: never suppress type errors — no `as any`, `@ts-ignore`, or
  `@ts-expect-error`.
- **Testing**: `database/` uses pytest; server/frontend use vitest. Every new
  feature ships with tests; every bug fix starts with a reproducing test.
- **Frontend components**: use the shadcn skill to discover existing components;
  do not reinvent the wheel (see [frontend/AGENTS.md](frontend/AGENTS.md)).

## Development Principles

- **Think first, code later**: state assumptions explicitly; when multiple
  interpretations exist, list them and ask before acting; stop and clarify when
  unclear. Reproduce or clearly understand the problem before writing code.
- **Minimal implementation**: write only the code necessary to solve the problem.
  Do not add unrequested features, extension points, or "just in case"
  abstractions. Do not handle theoretically impossible errors. Prefer simple,
  readable solutions over clever ones; if code can be substantially simplified
  without sacrificing clarity or testability, refactor it and verify with tests.
- **Surgical changes**: read surrounding context before editing. Touch only the
  files needed. Do not "incidentally" modify unrelated code, comments, or
  formatting. Clean up only your own orphans (unused imports/variables); do not
  remove existing dead code unless asked. Match existing style.
- **Dependency discipline**: do not add dependencies unless necessary; prefer
  existing utilities and established patterns.
- **Error handling**: handle expected errors explicitly; propagate or wrap
  unexpected errors with context; never silently swallow exceptions or leave
  empty catch blocks.
- **Avoid premature optimization**: make it correct and clear first; optimize
  only when a measured bottleneck demands it.
- **Goal-driven execution**: break tasks into verifiable checkpoints and verify
  after each step; advance only when a checkpoint passes.

## Commonly Setup

Everyone in the pod runs a local Commonly agent via the **official CLI +
webhook-SDK** (`@commonlyai/cli`), **not** MCP. The `commonly_*` names in this file
are the kernel tool *surface* (tasks, messages, memory, board); under the CLI flow
they are realized in the agent's Python SDK handler, not called as MCP tools.

```bash
npm i -g @commonlyai/cli@latest   # once, per machine (Node 20+)
commonly login                     # interactive, once per machine
bash scripts/commonly-up.sh        # scaffold (1st run) + run the agent; Ctrl+C to stop
```

- **Pod ID**: `6a520e34f4baa9b280bba195`, from the project `.env` / `.env.example`
  via `COMMONLY_POD_ID` (shared by all members; not secret).
- **Agent name**: registry `agentName` must match `^(@<scope>/)?[a-z0-9-]+$`
  (lowercase letters/digits/hyphens only — no quotes, no uppercase). Resolution
  precedence in `scripts/commonly-up.sh`: `$1` (> invocation arg) >
  `COMMONLY_AGENT_NAME` > `$(COMPUTERNAME)-agent`, then sanitized by lowercasing,
  dropping chars outside `[a-z0-9-]`, and trimming edge dashes. On this machine →
  `lidozs55-agent`.
- Runtime token lives in `scripts/commonly-agent/.commonly-env` (**git-ignored,
  never commit**).
- **MCP-unavailable fallback**: MCP is not a prerequisite for this repository.
  When the current runtime does not expose `commonly_*` tools, use the official
  CLI + webhook-SDK path instead of blocking on MCP:
  1. Check authentication with `commonly whoami`; if needed, run
     `commonly login`.
  2. Start the local agent from the repository root with
     `scripts\commonly-up.bat [agent-name]` on Windows, or
     `bash scripts/commonly-up.sh [agent-name]` on POSIX.
  3. Let the webhook-SDK process use
     `scripts/commonly-agent/.commonly-env`; never print or commit the runtime
     token.

  The CLI bootstraps and launches the agent; the webhook-SDK process carries the
  agent identity, polls events, and posts agent replies. Do **not** use a human
  or operator `commonly pod send` session as a substitute for agent check-ins,
  because it misattributes the message. The `[TASK]`, `[DONE]`, and `[BLOCKED]`
  check-in rules and board synchronization requirements remain unchanged. If
  neither MCP nor the CLI/SDK process is available, report `[BLOCKED]` rather
  than claiming that a check-in happened.
- **Known CLI bug (v0.1.11)**: `commonly agent init` copies SDK/bot templates from
  an `@commonlyai/examples` path npm does not ship, so a fresh install fails with
  `ENOENT … examples/sdk/python/commonly.py`. Workaround: fetch the two canonical
  templates into `<npm-root>/node_modules/@commonlyai/examples/{sdk/python/commonly.py,
  hello-world-python/bot.py}`. See official
  [CONNECTING_LOCAL_AGENTS.md](https://github.com/Team-Commonly/commonly/blob/main/docs/agents/CONNECTING_LOCAL_AGENTS.md);
  official docs are authoritative for the full tool surface — keep this section
  minimal and point there instead of duplicating.

## Commonly Workflow

### Work types and check-in

| Work type         | Check-in required? | Method                                                          |
| ----------------- | ------------------ | --------------------------------------------------------------- |
| Coding & fixes    | **Yes**            | `[TASK]` before starting, `[DONE]` upon completion              |
| Research & review | No                 | Share high-risk/high-value findings via `[Q]` or a new `[TASK]` |

### Board task workflow

When told to handle a Commonly board task:

1. **Sync**: load board tasks + latest messages for the pod.
2. **Claim**: claim the task (only one at a time).
3. **Work**: execute per this file; open a branch if needed.
4. **Verify & commit**: after self-check passes,
   `git commit -m "[TASK-XXX] <type>: description" && git push` (conventional
   format enforced by the commit-msg hook; e.g. `[TASK-123] feat: add retry`).
5. **Merge & close**: merge to `main` (see Git Workflow), post `[DONE]`
   (branch info required), then complete the board task.
6. Stuck for a full round with no progress → post `[BLOCKED]` and unclaim.

### Direct-instruction workflow (non-board task)

1. Before starting, post `[TASK] brief description, working on branch <branch-name>`
   (for branchless single-file edits: `[TASK] brief description, directly modifying main: <file-path>`).
2. Execute per Git Workflow.
3. On completion, post `[DONE] change summary, merged to main` (or `… pushed to main`).

No claim/complete actions are needed.

### High-value findings

If research or review reveals issues worth tracking, start a discussion with
`[Q]`, or create a board task (title prefix `[P0]` / `[P1]` / `[P2]`, `source` set,
hard dependencies in `dep`).

### Keep the board in sync with `docs/TODO.md`

`docs/TODO.md` is the authoritative plan (tasks + acceptance criteria); the
Commonly board is the execution-status view. To avoid circular updates:

- New planned work originates from `docs/TODO.md` → create a board task with
  `source` set to `docs/TODO.md`.
- Claim / in-progress / blocked / completed status is maintained on the board.
- When a task completes or its priority changes, write the outcome back to the
  matching `docs/TODO.md` checkbox.
- Never edit the same semantic field in both places at once.
- Create board tasks immediately for new bugs / tech debt / uncovered requirements
  found during work (prefix `[P0]` / `[P1]` / `[P2]`, fill `dep`).

### Coordination & message prefixes

- Before a branchless direct edit to `main`, scan recent messages (~10) to confirm
  no other agent is working on the same file; if a conflict is suspected, negotiate
  via `[Q]` or switch to a branch.
- After pushing/merging a branch, always post `[DONE]` summarizing changes, impact,
  and the branch name.

| Prefix      | Purpose                                   |
| ----------- | ----------------------------------------- |
| `[TASK]`    | Task start check-in / new task record     |
| `[Q]`       | Question, discussion                      |
| `[DONE]`    | Work completed (must include branch info) |
| `[BLOCKED]` | Blocker announcement                      |

- Use `replyToMessageId` to keep threads.
- Every message must contain substantive information; avoid empty notifications.
- For architecture decisions or uncertain choices, post a `[Q]` first.

## Git Workflow

### Branch policy

- Prefer a dedicated branch per task, named like `feat/TASK-XXX-summary` or
  `fix/summary`.
- **Single-file small changes** (typos, config tweaks) may be committed directly
  to `main`, but you must: first `git pull` to sync; and confirm no other agent is
  editing the same file (see Commonly Workflow ✓ coordination).
- Multi-file changes, new features, or changes that may affect other agents
  **must** use a dedicated branch.
- Before creating a new branch, run `git branch -r` to check the remote and avoid
  naming collisions.
- Commit incrementally at logical checkpoints; each commit is a meaningful,
  self-contained change.

### Self-serve merge

Each agent is responsible for merging its own branch. Before merging, **all** must
hold:

1. The branch is functionally stable and the target changes are achieved.
2. All Quality Gates (below) pass.
3. The merge represents one complete functional unit (see constraints).

Merge steps:

- Sync with `main` first: ≤5 commits → `git pull --rebase origin main`; >5 commits
  or conflict-prone → `git fetch origin main && git merge origin/main`.
- After resolving conflicts, **re-run all Quality Gates**.
- Check out local `main`, ensure it is clean and up to date, then merge with
  `git merge --no-ff <branch>`; push `main`.
- After merging, post a `[DONE]` message summarizing the result.

Merge constraints:

- **Never force-push to shared branches** (`main`, `dev`). If push is rejected,
  `git pull --rebase` first, then push.
- One merge to `main` = one complete functional unit; bundle related
  `feat`/`fix`/test/doc changes into the same branch and merge together.
- One feature, one merge: don't chain multiple merges for sub-steps; if not
  complete, keep committing on the branch.

### Quality Gates

All checks in **Common Commands** must pass **before pushing a branch and before
merging to `main`**:

- Root: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`.
- Python bridge: `uv run python database/bridge.py --self-test`,
  `uv run pytest database/tests`, `uv run ruff check database`.

The local pre-commit hook (`.husky/pre-commit`, see `docs/git-hooks.md`) runs
typecheck/lint/test before every commit, plus ruff+pytest when `database/` changes.
Docs-only commits skip these gates automatically; any other bypass needs a stated
reason. Commit messages are enforced by commitlint: `type(scope): subject`
(`feat/fix/docs/chore/test/refactor/...`) with optional task-id prefix
(`[TASK-123] feat: summary`). Do not bypass with `--no-verify` without a stated
reason.

### Optional worktrees

Worktrees are optional. For parallel branches without disturbing the shared
working directory:

```bash
git worktree add ../BioMed-QAgent-<branch-name> <branch-name>
git worktree remove ../BioMed-QAgent-<branch-name>
```

Run `git worktree list` first and reuse an existing worktree for the same branch.

## Documentation First

Proactively capture knowledge under `docs/`:

- Error-prone integration points (API parameter quirks, environment traps).
- Identified but unfixed bugs or tech debt.
- Complex trade-offs or architecture decisions.
- Non-obvious usage patterns or conventions.

**Principle**: code says "how", docs say "why". Do not make other agents (or your
future self) re-derive your reasoning. Place content into the most fitting existing
document to avoid scattering and duplication.

## Definition of Done & End-of-Round Self-Check

At the end of every round, verify all applicable items. When the round completes a
task, all items are mandatory and this checklist is the Definition of Done; if the
round ends with incomplete work, complete the applicable items before starting the
next round.

1. **Quality gates** — all checks in Git Workflow §Quality Gates pass: `pnpm test`,
   `pnpm lint`, `pnpm typecheck`, `pnpm build`; if `database/` changed,
   `uv run pytest database/tests` and `uv run ruff check database` also pass.
2. **Tests** — new behavior is covered by tests, or the fixed bug has a reproducing
   test that now passes.
3. **Branch & merge** — multi-file work used a dedicated branch; single-file `main`
   edits occurred only after the pre-check; merge/push followed Self-Serve Merge; no
   force-push to shared branches.
4. **Commonly check-in** — `[TASK]` was posted at start and `[DONE]` / `[BLOCKED]`
   at end with the required information.
5. **Board & TODO sync** — Commonly board status and `docs/TODO.md` checkboxes
   reflect what was actually done this round.
6. **Documentation** — non-obvious decisions, integration quirks, or trade-offs were
   captured under `docs/`.
7. **Workflow drift** — no mandated step was skipped; if one was, fix what is
   recoverable and note what could not be recovered.

If any item is missing and the task is not complete, resolve it before starting the
next round. If the task is complete, every item must be satisfied before reporting
completion.
