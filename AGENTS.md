# BioMed-QAgent

> Biomedical Question-Answering Agent with multi-agent orchestration.

## Commonly Pod

- **Pod ID**: `6a520e34f4baa9b280bba195`
- Todo tasks synced from `TODO.md` → commonly as `TASK-001` through `TASK-017`.
- Keep `.claude/TODO.md` and commonly task board in sync.

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python 3.12+, FastAPI, OpenAI Agents SDK, Qwen (DashScope) |
| **Frontend** | React 19, Vite, Tailwind CSS v4, shadcn/ui |
| **Package (FE)** | pnpm (primary) — **do not use npm** |
| **Package (BE)** | uv (uv.lock) |

## Architecture

```
Frontend (React/Vite)
   │
   ▼  WebSocket  (/ws)
FastAPI (app.server)
   │
   ▼  asgi / lifespan
Runner (Agents SDK Runner)
   │
   ▼
Main Agent (multi-tool orchestration)
   ├── search_literature  (stub — returns mock JSON)
   ├── parse_pdf          (stub — returns mock JSON)
   ├── analyze_records    (stub — returns mock JSON)
   ├── read_file          (functional)
   ├── write_file         (functional)
   └── list_files         (functional)
```

### Agent Loop (WebSocket)

1. Client connects to `ws://<host>:8000/ws`
2. FastAPI `websocket_endpoint` in `app.server` accepts
3. Messages dispatched to `app.core.runner.AgentRunner`
4. Runner executes configured tools, streams back responses
5. Frontend renders markdown/tool-call results

## Critical State

### Domain Models (`app.domain.*`)

- Tests (`tests/test_domain_contracts.py`) reference `app.domain` models but the package **does not exist on disk**.
- **Must be built before tests can pass or domain-dependent features work.**
- Appears to be the next major unit of work.

### Data Tools Are Placeholders

`search_literature`, `parse_pdf`, `analyze_records` are **dummy stubs** returning hardcoded JSON. They need real implementations (PubMed API, PDF parser, etc.).

### Build / Lint

- Frontend builds with `pnpm dev` / `pnpm build` (use pnpm, not npm).
- Backend uses `uv sync` / `uv run uvicorn app.server:app --reload`.
- Both `package-lock.json` and `pnpm-lock.yaml` existed — use pnpm-lock.yaml as canonical. Delete package-lock.json if it reappears.

### Branches

- `codex/core-architecture-foundation` — core backend architecture
- `feat/skill-library` — skill/plugin system
- Check `git branch -r` for remote tracking before creating new branches.

## Developer Commands

```bash
# Backend
uv sync                          # install deps
uv run uvicorn app.server:app    # run server
uv run pytest                    # run tests

# Frontend
pnpm install                     # install deps
pnpm dev                         # dev server
pnpm build                       # production build
pnpm lint                        # lint
```

## Conventions

- Python: PEP 8, type hints expected, pydantic v2 for models.
- TypeScript/React: shadcn component patterns, Tailwind utility classes.
- Imports: backend uses `from app.<module>`, frontend uses `@/` alias.
- Tests: pytest for backend, currently minimal coverage.
- NEVER suppress type errors (`as any`, `@ts-ignore`, `@ts-expect-error`).
- Prefer small focused changes over large refactors unless explicitly requested.
