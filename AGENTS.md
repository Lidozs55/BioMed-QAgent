# BioMed-QAgent — AGENTS.md

> This document has two parts: universal rules that all agents must follow, and
> Commonly MCP extensions that apply mandatorily when connected.
> 
> The authoritative source for system architecture and design decisions is
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This file is a concise guide
> only — it does not duplicate architecture diagrams, to avoid drift.

---

## Part I: Universal Rules (All Agents Must Follow)

### 1. Tech Stack

| Layer                | Technology                                                 |
| -------------------- | ---------------------------------------------------------- |
| Backend              | Python 3.12+, FastAPI, OpenAI Agents SDK, Qwen (DashScope) |
| Frontend             | React 19, Vite, Tailwind CSS v4, shadcn/ui                 |
| Package Manager (FE) | pnpm (**never npm**)                                       |
| Package Manager (BE) | uv (`uv.lock`)                                             |

### 2. Architecture Overview & Agent Loop

The current architecture is a **dual-layer structure: Agent + Deterministic
Pipeline**. Full details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2.
Key points:

- The frontend (React/Vite) communicates with FastAPI via HTTP + WebSocket.
- The FastAPI entry point is `app.main:app`, with routes registered in
  [app/api/routes.py](backend/app/api/routes.py) (HTTP) and
  [app/api/ws.py](backend/app/api/ws.py) (WebSocket).
- The Main Agent is built on the OpenAI Agents SDK and enters the deterministic
  pipeline through a single `run_research_pipeline` Function Tool
  ([app/pipeline/tool.py](backend/app/pipeline/tool.py)). The Agent never
  assembles the final CSV directly.
- The deterministic Pipeline Runner
  ([app/pipeline/runner.py](backend/app/pipeline/runner.py)) executes five
  stages: **Discovery → Acquisition → Processing → Artifact Build → Validation
  Gate**. Only artifacts that pass the Validation Gate are published to
  `artifacts/`.
- The WebSocket endpoint is `/api/v1/ws`; the streaming entry function is
  `app.agent_loop.runner.run_agent_stream`.
- The skill repository is organized into four categories — discovery,
  acquisition, processing, analysis — under
  [backend/app/skills/builtin/](backend/app/skills/builtin/). Learned skills
  (under `learned/`) are disabled by default.

**HTTP API Routes** (prefix `/api/v1`):

| Method | Path                                              | Purpose                            |
| ------ | ------------------------------------------------- | ---------------------------------- |
| GET    | `/api/v1/health`                                  | Health check                       |
| GET    | `/api/v1/databases`                               | List user-selectable databases     |
| POST   | `/api/v1/tasks`                                   | Create and run a fixture-mode task |
| GET    | `/api/v1/tasks/{task_id}`                         | Task status and summary            |
| POST   | `/api/v1/tasks/{task_id}/cancel`                  | Request cancellation of a running task |
| GET    | `/api/v1/tasks/{task_id}/events`                  | Replay persisted pipeline events (`?since=N`) |
| GET    | `/api/v1/tasks/{task_id}/artifacts`               | List validated artifact files      |
| GET    | `/api/v1/tasks/{task_id}/artifacts/{artifact_id}` | Download a specific artifact       |

**Agent Loop (WebSocket)**

1. The client connects to `ws://<host>:8000/api/v1/ws`.
2. `app/api/ws.py:agent_ws` receives a message:
   `{"type":"run","input":"...","databases":[...],"task_id":"optional"}`.
3. The handler calls `run_agent_stream(user_input, task_id, databases)` to
   stream Agent loop events.
4. The runner converts SDK stream events into WSMessage dicts and pushes them
   back. Event types:
   - `task_started` — sent by `ws.py` immediately after accepting a run
   - `skill_loaded` — a skill was loaded (name + category)
   - `text` — LLM text delta
   - `tool_call` — a tool call started (name + arguments)
   - `tool_output` — a tool call returned (output + truncated flag)
   - `file_downloaded` — a source file was downloaded (name + path + size)
   - `artifact_produced` — a validated artifact was produced (artifact_id + name + size)
   - `confirm` — a quality / human-in-the-loop confirmation prompt (confirm_message)
   - `done` — the Agent loop finished (carries `final_output`)
   - `error` — an exception occurred (message + optional code)
   - `cancel_ack` — a cancel request was accepted or rejected (task_id + cancelled + optional status)
5. The frontend renders Markdown, tool-call traces, and artifact events.

Always treat the code as the source of truth for skill and tool implementation
status — do not assume from documentation alone.

### 3. Project Documentation Guidance

Before starting any task, consult:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture and design
  decisions (authoritative).
- [PROBLEM.md](PROBLEM.md) — competition background and evaluation criteria
  (repository root).
- [docs/TODO.md](docs/TODO.md) — current development TODOs and approved
  architecture decisions.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — phase design specs
  and plans.

### 4. Common Commands

#### Backend (cwd: `backend/`)

All backend commands must be run from the `backend/` directory (where
`pyproject.toml` lives).

```bash
uv sync                                    # Install dependencies
uv run uvicorn app.main:app --reload       # Start dev server (default 127.0.0.1:8000)
uv run pytest                              # Run tests (excludes @pytest.mark.live by default)
uv run pytest -m live                      # Run live network tests only
uv run pytest tests/test_runner.py         # Run a single test file
uv run pytest -k "skill"                   # Filter by keyword
uv run ruff check app/ tests/ launcher.py  # Lint (CI quality gate, zero warnings allowed)
```

Notes:

- The dev server binds to `127.0.0.1:8000` by default. Override with `HOST` and
  `PORT` environment variables.
- CORS allows the Vite dev server origins `http://localhost:5173` and
  `http://127.0.0.1:5173`.
- `pytest` is configured with `asyncio_mode = "strict"` and treats warnings as
  errors.

#### Frontend (cwd: `frontend/`)

All frontend commands must be run from the `frontend/` directory.

```bash
pnpm install                               # Install dependencies
pnpm dev                                   # Start Vite dev server (default :5173)
pnpm build                                 # Production build (tsc -b && vite build)
pnpm lint                                  # ESLint (--max-warnings 0)
pnpm tsc                                   # TypeScript type check (runs tsc --noEmit)
pnpm test                                  # Run unit tests once (vitest run)
pnpm test:watch                            # Run unit tests in watch mode (vitest)
```

### 5. Technical Conventions

- **Python**: PEP 8, mandatory type annotations on all function signatures,
  Pydantic v2 for models.
- **TypeScript / React**: follow shadcn/ui component patterns and Tailwind
  utility classes; use the `@/` path alias.
- **Imports**: backend uses `from app.<module>...`; frontend uses `@/...`.
- **Type safety**: never suppress type errors — no `as any`, `@ts-ignore`, or
  `@ts-expect-error`.
- **Testing**: backend uses pytest; every new feature must ship with tests, and
  every bug fix starts with a test that reproduces the bug. Frontend uses
  vitest with jsdom.
- **Frontend components**: use the shadcn skill to discover existing components;
  do not reinvent the wheel (see [frontend/AGENTS.md](frontend/AGENTS.md)).

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
  - If connected to Commonly, declare the file to be modified in the Pod and
    confirm no conflict (see Part II §3).
- Multi-file changes, new features, or changes that may affect other agents
  **must** use a dedicated branch.
- Before creating a new branch, run `git branch -r` to check the remote and
  avoid naming collisions.

#### 7.2 Self-Serve Merge

**Each agent is responsible for merging its own branch**. Before merging, all of the following must hold:

1. The branch is functionally stable and the target changes are achieved.
2. `uv run pytest` is fully green with no new failures.
3. Frontend changes pass `pnpm lint && pnpm tsc` with 0 errors, and `pnpm build`
   succeeds.
4. The backend has no import errors, AST is intact, and
   `uv run uvicorn app.main:app --reload` starts normally.

**Merge steps**:

- `git pull --rebase origin main` and resolve conflicts.
- After resolving conflicts, re-run tests and frontend/backend verification.
- Prefer `git merge --no-ff` to preserve branch history, or rebase then push.
- Before pushing, confirm local `main` can start.
- After merging, post a `[DONE]` message in Commonly summarizing the result. (If connected to Commonly)

**Constraints**:

- **Never force-push to shared branches** (main, dev). If push is rejected, run
  `git pull --rebase` first, then push.

#### 7.3 Pre-Push Checklist

- Backend: no import errors, AST intact, `uv run pytest` passes, and
  `uv run uvicorn app.main:app --reload` starts after clearing `__pycache__`.
- Frontend: `pnpm lint && pnpm tsc` with 0 errors, `pnpm build` succeeds.
- Commit message format: `[TASK-XXX] summary` or `feat/fix/chore: summary`. Prefer conventional commit message style.

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
| Research & review | No                 | If **high-risk / high-value** info is found (architecture flaws, risks, etc.), share via `[Q]` or a new `[TASK]` |

### 2. Task Source and Corresponding Workflow

#### 2.1 User Explicitly Assigns a Commonly Board Task

When told to handle a Commonly task, follow the board lifecycle strictly:

1. Sync: `commonly_get_tasks` + `commonly_get_messages`.
2. Claim: `commonly_claim_task` (claim only one task at a time).
3. Work: execute per Part I; open a branch if needed.
4. Verify & commit: after self-check passes, run
   `git commit -m "[TASK-XXX] description" && git push`.
5. Complete: `commonly_complete_task`, post `[DONE]` summarizing the changes and
   branch name, then merge.
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

#### 2.4 Proactively Maintain the Commonly Board

The Commonly board is the team's shared task workspace. Agents must not wait
passively for tasks — proactively keep the board in sync with reality.

**When to update**

- **Sync from `docs/TODO.md`**: if a `docs/TODO.md` entry has no corresponding
  board task, create one via `commonly_create_task` with `source` set to
  `docs/TODO.md`.
- **New issues found during work**: when encountering a new bug, tech debt, or
  uncovered requirement, create a board task immediately, prefixing the title
  with `[P0]` / `[P1]` / `[P2]` and filling `dep` with hard dependencies.
- **Status changes**: when a task's completion status or priority changes due to
  code changes or discussion, sync via `commonly_update_task`.

**How to update**

- `commonly_create_task` to create, filling `title` / `source` / `priority` /
  `dep`.
- `commonly_update_task` to modify an existing task's status, description, or
  dependencies.
- Optionally post a `[TASK]` message summarizing the change to help the team
  sync quickly.

**Principle**: the board must never lag behind actual work. Every agent is
responsible for making the board a real-time projection of project progress.

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
- Board tasks sync dynamically with `docs/TODO.md`; task numbers are auto-assigned
  by Commonly.
- Keep `docs/TODO.md` and the board in sync: new `docs/TODO.md` entries should be
  mapped to board tasks, and board status changes should be written back to the
  corresponding `docs/TODO.md` checkboxes.

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
3. **Pre-push verification** (Part I §7.3): did `uv run pytest` pass? Did
   frontend `pnpm lint && pnpm tsc && pnpm build` pass (if FE changed)? Did
   the backend restart cleanly?
4. **Board sync** (§2.4): are the `docs/TODO.md` checkboxes and the Commonly
   board in sync with what was actually done this round?
5. **Documentation** (Part I §8): did this round introduce a non-obvious
   decision, integration quirk, or trade-off that should be captured under
   `docs/`?
6. **Workflow drift**: did any step skip a mandated check (claim, file lock,
   rebase, `[DONE]` summary)? If yes, retroactively fix what is recoverable
   and note what is not.

If any item is missing, complete it before starting the next round. The
purpose is to prevent workflow drift across long multi-round sessions where
context is compressed — the `AGENTS.md` is the stable source of truth that
survives context resets.
