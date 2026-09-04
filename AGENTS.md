# BioMed-QAgent — AGENTS.md

> This file defines working rules for all **agents**. It is a concise guide only —
> architecture and design decisions live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> (authoritative entry, with per-topic files under `docs/architecture/`); do not
> duplicate architecture content here to avoid drift.
>
> **Commonly coordination is an unconditional, built-in part of the workflow
> for every agent** — not an add-on that applies only when a Commonly
> connection happens to exist.
>
> Terms: a **round** is one continuous agent working session ending in a report
> or check-in; a **pod** is the Commonly group (agents + human) sharing one
> board and message stream.

## Prerequisites & Secrets

- Tools: Node.js 22.19+, pnpm, Python 3.12+, uv, Git. Use the versions pinned in
  `package.json` / `pyproject.toml`.
- API keys: load from environment variables or a local untracked `.env`; never
  commit real secrets, and never log or expose raw credentials (the settings
  surfaces mask stored keys).
- Package managers: **pnpm** for TypeScript (never `npm`); **uv** for Python
  (root `pyproject.toml` / `uv.lock`).
- `npx`/`npm i -g` installs in this file (the Commonly CLI in § Commonly Setup)
  are the single exception to the "no npm" rule — they are Node package
  installs, not the repo's dependency manager.

## Architecture

The system is a **two-layer Agent + Deterministic Pipeline** (see
`docs/ARCHITECTURE.md`):

| Layer              | Technology                                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| Application Host   | Node.js, TypeScript, Vite middleware                                       |
| Main Agent         | Pi (adapter-confined via `server/src/agent/pi-adapter.ts`)                 |
| Dataset Core       | TypeScript deterministic core (`server/src/dataset/`)                      |
| Python Persistence | `database/` bridge only (stdlib, JSONL named-op)                           |
| Frontend           | React 19, Vite, Tailwind CSS v4, shadcn/ui                                 |

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
  stable baseline, not a sandbox or security boundary; do not reopen
  sandbox/container/IPC work without a new ADR. Current-phase work priorities
  live in `docs/TODO.md`.
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
  them as current behavior. Moved paths are documented in `docs/README.md`.
- `PROBLEM.md` is static background (competition problem statement and evaluation
  criteria), not per-task reading — load it when evaluation-relevant decisions
  are involved, not on every task.
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
pnpm test                         # full workspace tests — cross-cutting changes only; per-area commands: see Quality Gates
pnpm lint                         # workspace lint
pnpm typecheck                    # workspace TypeScript checks
pnpm build                        # workspace production builds
pnpm docs:check                   # Markdown local-link validation (skips docs/archive, docs/migration)
```

Tests run with bounded concurrency by default; for concurrency, CI behavior, and
throttling options see [docs/architecture/test-concurrency.md](docs/architecture/test-concurrency.md).

### Python database bridge (cwd: repository root)

```bash
uv sync    # install database project deps
```

Test/lint commands for `database/` (`--self-test`, pytest, ruff) are listed
under Quality Gates.

## Technical Conventions

- **Python**: PEP 8, mandatory type annotations on all function signatures;
  flat imports.
- **TypeScript / React**: follow shadcn/ui component patterns and Tailwind
  utility classes; use the `@/` path alias.
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
webhook-SDK** (`@commonlyai/cli`), **not** MCP — the CLI flow below is the only
path in this repository.

```bash
npm i -g @commonlyai/cli@latest   # once, per machine
commonly login                     # interactive, once per machine (verify: commonly whoami)
bash scripts/commonly-up.sh        # POSIX/Git Bash; Windows-native: scripts\commonly-up.bat
```

`scripts/commonly-up.sh` checks the CLI and login state, scaffolds the
webhook-SDK agent into `scripts/commonly-agent/` on first run (idempotent), then
runs it (Ctrl+C to stop). If the CLI/SDK agent process is not available, report
`[BLOCKED]` rather than claiming that a check-in happened.

- **Pod ID**: `6a520e34f4baa9b280bba195` (default in `scripts/commonly-up.{sh,bat}`;
  override via `COMMONLY_POD_ID` in the project `.env`).
- **Agent name**: first positional arg of `scripts/commonly-up.sh` >
  `COMMONLY_AGENT_NAME` > `<hostname>-agent` (sanitized to `[a-z0-9-]`).
- **Runtime token** lives in `scripts/commonly-agent/.commonly-env`
  (git-ignored); never print or commit it.
- **Check-in integrity**: do **not** use a human or operator `commonly pod send`
  session as a substitute for agent check-ins — it misattributes the message.
- Known CLI/tooling quirks are tracked in [docs/ISSUES.md](docs/ISSUES.md).
  Official docs are authoritative for the full tool surface:
  [CONNECTING_LOCAL_AGENTS.md](https://github.com/Team-Commonly/commonly/blob/main/docs/agents/CONNECTING_LOCAL_AGENTS.md).

## Commonly Workflow

### Work types and check-in

| Work type         | Check-in required? | Method                                                          |
| ----------------- | ------------------ | --------------------------------------------------------------- |
| Coding & fixes    | **Yes**            | `[TASK]` before starting, `[DONE]` upon completion              |
| Research & review | No check-in (report findings — see Method) | Share high-risk/high-value findings via `[Q]` or a new `[TASK]` |

### Board task workflow

When told to handle a Commonly board task:

1. **Sync**: load board tasks + latest messages for the pod (CLI commands: the
   official docs linked in § Commonly Setup).
2. **Claim**: claim the task (only one at a time).
3. **Work**: execute per this file; open a branch if needed.
4. **Verify & commit**: after self-check passes,
   `git commit -m "[TASK-XXX] <type>: description" && git push`
   (message format: § Quality Gates).
5. **Merge & close**: merge to `dev` (see Git Workflow), post `[DONE]`, then
   complete the board task.
6. Stuck for a full round with no progress → post `[BLOCKED]` and unclaim.

### Direct-instruction workflow (non-board task)

1. Before starting, post `[TASK] brief description, working on branch <branch-name>`
   (for branchless single-file edits: `[TASK] brief description, directly modifying dev: <file-path>`).
2. Execute per Git Workflow.
3. On completion, post `[DONE] change summary, merged to dev` (or `… pushed to dev`).

No claim/complete actions are needed.

### High-value findings

If work reveals issues worth tracking — research/review findings, new bugs,
tech debt, uncovered requirements — start a discussion with `[Q]`, or create a
board task immediately (title prefix `[P0]` / `[P1]` / `[P2]`, `source` set,
hard dependencies in `dep`).

### Keep the board in sync with `docs/TODO.md`

`docs/TODO.md` is the authoritative plan (tasks + acceptance criteria); the
Commonly board is the execution-status view. To avoid circular updates:

- New planned work originates from `docs/TODO.md` → create a board task with
  `source` set to `docs/TODO.md`.
- Claim / in-progress / blocked / completed status is maintained on the board.
- When a task completes or its priority changes, write the outcome back to the
  matching `docs/TODO.md` checkbox.
- Never edit the same semantic field (status, priority, claim/assignee, task
  description) in both places at once.

### Coordination & message prefixes

- Before a branchless direct edit to `dev`, scan recent messages (~10) to confirm
  no other agent is working on the same file; if a conflict is suspected, negotiate
  via `[Q]` or switch to a branch.
- After pushing/merging a branch, post `[DONE]` (content: see table).

| Prefix      | Purpose                                               |
| ----------- | ----------------------------------------------------- |
| `[TASK]`    | Task start check-in / new task record                 |
| `[Q]`       | Question, discussion                                  |
| `[DONE]`    | Work completed — branch name, change summary, impact  |
| `[BLOCKED]` | Blocker announcement                                  |

- Use `replyToMessageId` to keep threads.
- Every message must contain substantive information; avoid empty notifications.
- For architecture decisions or uncertain choices, post a `[Q]` first.

## Git Workflow

### Branch policy

- **Branch model**: `dev` is the development integration branch — all feature
  work merges here. `main` is the public release branch: protected, receives
  changes only via release pull requests from `dev`, and carries only public
  content. `main` commits are release-side actions and never merge back into
  `dev`; `dev` must remain a content superset of `main`.
- **Release PRs**: a PR to `main` is a release event, not a sync point — batch
  several completed `dev` merges into one release PR; never open one per merge.
  Every release PR must apply
  [docs/RELEASE_PRUNE_CHECKLIST.md](docs/RELEASE_PRUNE_CHECKLIST.md) — the
  single authority for internal-content pruning, dev-only capability
  exclusion, and must-ship items. The checklist is used only when cutting a
  release PR.
- **Branch per task**: prefer a dedicated branch named like
  `feat/TASK-XXX-{summary}` or `fix/{summary}`; check `git branch -r` before
  creating one to avoid naming collisions. Multi-file changes, new features,
  or changes that may affect other agents **must** use a branch.
- **Direct-to-`dev` changes**: single-file small changes (typos, config
  tweaks, docs) may be committed directly — first `git pull` to sync, and
  confirm no other agent is editing the same file (see Commonly Workflow
  coordination). If unsure, use a branch.
- **Commit** incrementally at logical checkpoints; each commit is
  a **meaningful**, self-contained change.

### Self-serve merge

Each agent is responsible for merging its own branch to `dev`. Before merging, **all** must
hold:

1. The branch is functionally stable and the target changes are achieved.
2. All Quality Gates (below) pass.
3. The merge represents one complete functional unit (see constraints).

Merge steps:

- Sync with `dev` first: if the branch is ≤5 commits behind `dev`, `git pull
  --rebase origin dev`; if it is further behind or a conflict is likely (both
  sides touched the same files), `git fetch origin dev && git merge origin/dev`.
- After resolving conflicts, **re-run targeted tests for the affected areas**.
- Check out local `dev`, ensure it is clean and up to date, then merge with
  `git merge --no-ff <branch>`; push `dev`, then post `[DONE]`.

Merge constraints:

- **Never force-push to shared branches** (`main`, `dev`). If push is rejected,
  `git pull --rebase` first, then push.
- If a merge lands on `dev` and turns out broken: prefer fixing forward on a
  branch; for immediate shared-branch breakage, `git revert -m 1 <merge-commit>`
  is allowed and must be announced (`[DONE]` with the reason, or `[Q]` if
  unsure).
- One merge to `dev` = one complete functional unit: bundle related
  `feat`/`fix`/test/doc changes into the same branch; don't chain multiple
  merges for sub-steps — if not complete, keep committing on the branch.

### Quality Gates

**Targeted testing is the default**: test what your changes touch — do not run
the full suite on every commit or push. All gates below must pass **before
pushing a branch and before merging to `dev`**:

- Workspace-wide: `pnpm lint`, `pnpm typecheck`, `pnpm build`.
- Targeted tests, by changed area:
  - `server/` → `pnpm --filter @biomed/server test`
  - `frontend/` → `pnpm --filter @biomed/frontend test`
  - `database/` → `uv run python database/bridge.py --self-test`,
    `uv run pytest database/tests`, `uv run ruff check database`
  - Cross-cutting sources (`packages/contracts/`, root config files,
    `scripts/`) → full `pnpm test`, because the blast radius spans workspaces
    (contracts-only tweaks may use `pnpm --filter @biomed/contracts test` for
    quick feedback first).

**Failing-test loop**: while tests fail, re-run only the failing tests —
`pnpm --filter <pkg> test -- <test-file>` or
`uv run pytest database/tests/<file>::<case>` — until every failure passes.
If a fix breaks a previously passing test, stop and fix the regression before
proceeding. Then re-run the targeted suite for the changed area once to confirm
no regressions. Avoid full-suite runs inside this loop.

CI runs the full suite plus lint/typecheck/build on every pull request (pushes
to `dev` do not trigger CI; the PR is the gate).

The local pre-commit hook (`.husky/pre-commit`, see `docs/git-hooks.md`) runs
typecheck/lint (plus ruff when `database/` Python sources change) — it does not
run tests, so a green commit is not a green test run; run the targeted tests
yourself before pushing/merging.
Docs-only commits skip these gates automatically; any other bypass needs a stated
reason. Commit messages are enforced by commitlint: `type(scope): subject`
(`feat/fix/docs/chore/test/refactor/...`) with optional task-id prefix
(`[TASK-123] feat: summary`). Do not bypass with `--no-verify` without a stated
reason.

### Optional worktrees

Worktrees exist for parallel development only — running several branches at
once without disturbing the shared working directory. Small or docs-only
changes edit on the task branch or directly on `dev`; do not create a
worktree for them:

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

1. **Quality gates** — all Git Workflow §Quality Gates pass for every changed
   area (failing-test loop completed).
2. **Tests** — new behavior is covered by tests, or the fixed bug has a reproducing
   test that now passes.
3. **Branch & merge** — multi-file work used a dedicated branch; single-file `dev`
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
