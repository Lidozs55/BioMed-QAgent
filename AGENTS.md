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

## Agent Workflow

### Task Lifecycle

任务在 Commonly 任务板上流转：`pending → claimed → completed`

**每次会话接手任务：**
1. `commonly_get_tasks`（先查 `pending`，再查 `claimed`）
2. `commonly_get_messages`（limit=20）
3. `commonly_claim_task` — 同一时间只 claim 一个任务
4. 修改文件前发 `[LOCK]` 声明文件锁（最多 5 个文件）
5. 对照 `ARCHITECTURE.md` / `PROBLEM.md` 执行
6. 验证：AST、import 链、前端 `tsc`、后端重启
7. `git commit + push`
8. 发 `[UNLOCK]` 解封文件锁
9. `commonly_complete_task`
10. 发消息通知完成

**创建任务：**
- `commonly_create_task`，title 加 `[P0]`/`[P1]`/`[P2]`
- `source` 填来源文档路径；有硬依赖填 `dep`

**约束：**
- 一个 agent 同时只 claim 一个任务
- 完成前确认：代码已 push、文件锁已解封、相关文档已更新
- 卡住超 1 轮无法推进 → 发 `[BLOCKED]` 并 unclaim

### File Locking

基于消息的轻量协议，避免 git 冲突。

- **加锁：** claim 后、改文件前发 `[LOCK] TASK-XXX: path1, path2`（最多 5 文件）
- **检查：** 改文件前扫最近消息，若有他人未解封的 `[LOCK]` 则等待或 `[Q]` 协商
- **解锁：** push 后立即发 `[UNLOCK] TASK-XXX`

### Messages

| 前缀 | 用途 |
|---|---|
| `[LOCK]` / `[UNLOCK]` | 文件锁定 |
| `[TASK]` | 任务看板更新 |
| `[Q]` | 提问/讨论 |
| `[DONE]` | 完成通知 |
| `[BLOCKED]` | 阻塞提示 |

- 架构决策或不确定选型先发 `[Q]`
- 回复用 `replyToMessageId` 做线程
- 不发无实质内容的消息；`[DONE]` 一条概括改动与影响

### Git

- 每完成一个任务 `commit + push` 一次
- commit message：`[TASK-XXX] 简述`
- push 前确认：AST 通过、import 正常、前端 `tsc` 0 error、后端重启正常
- 后端改动后：清 `__pycache__`、kill Python 进程、`uvicorn app.main:app --reload`
- 绝不 force push 到主分支；失败先 `git pull --rebase`
