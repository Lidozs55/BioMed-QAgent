# Phase 8 Final Verification（legacy Python Runtime 物理退役验收报告）

> 状态：completed（2026-08-14）
> Baseline commit：`cb2600597525d97fb00538b55dcfb001cb6e7c03`（main）
> Final commit（本分支）：`refactor/phase8-python-runtime-retirement` 上四个提交：
> `e72c90c`（P8-A database bridge 自包含）→ `8a7a30d`（P8-B TS rollback 删除）→
> `28224ac`（P8-C backend 物理删除）→ P8-D（本提交，文档封板）
> 执行计划：`docs/migration/phase8-python-runtime-retirement.md`
> 基线盘点：`docs/migration/phase8-retirement-inventory.md`

---

## 1. 删除清单

### 1.1 删除的 Python 目录/文件（backend/ 整体退役）

```text
backend/  （414 个 tracked 文件全部删除；git ls-files backend = 0）
├── app/agent_loop/         legacy OpenAI Agents SDK runtime
├── app/runtime/            Python TaskManager/Repository/EventHub/TaskIndex
├── app/subagents/          子 Agent supervisor
├── app/skills/             builtin skill 模块（builtin_skill_records）
├── app/pipeline/           Python Dataset Build tool / 状态
├── app/datasets/           Python Dataset Core / V2 kernel / V1 bridge
├── app/tools/              cache_store / browser / pdf / crawler 等
├── app/api/                FastAPI routes / ws / ws_events
├── app/compat/             pi_dataset_bridge.py（Python Core bridge）
├── app/{main,config,model_*,personalization,recipes,integrations}.py 等
├── tests/                  legacy implementation tests（414 文件含 fixtures）
├── launcher.py             PyInstaller 入口
├── pyproject.toml / requirements.txt / uv.lock / README / REPRODUCIBILITY
└── scripts/
```

保留为 golden fixtures（数据，非实现）：`backend/tests/fixtures/**` →
`tests/fixtures/**`（gdc / import / ncbi / pdf 共 20 个文件，`git mv`）。

### 1.2 删除的 TS legacy 模块

```text
server/src/legacy/backend-process.ts        FastAPI spawn（backend/.venv uvicorn）
server/src/legacy/dataset-core-client.ts    Python Dataset Core HTTP client
server/src/legacy/proxy.ts                  HTTP/WS legacy proxy
server/src/agent/experimental-pi.ts         /experimental/pi/* runtime（511 行）
server/src/agent/phase1-composition.ts      Phase 1 组合（105 行）
server/src/agent/fixture-profile.ts         仅 phase1f 使用
server/src/experimental/event-bus.ts        无引用死代码
```

### 1.3 删除的 feature flags / env vars / 脚本

```text
APP_HOST / AGENT_RUNTIME / DATASET_CORE / PI_EXPERIMENTAL（config.ts 不再解析）
LEGACY_BACKEND_PORT / LEGACY_BACKEND_URL / LEGACY_READINESS_TIMEOUT_MS
PI_DATASET_BRIDGE_SECRET
根 package.json: dev:legacy-backend / dev:host-proxy-only / dev:legacy-rollback
scripts/dev-profile.mjs / scripts/test_agent_task.py / scripts/verify_migration_golden.py
server 依赖: http-proxy-3
前端: frontend/src/experimental/（ExperimentalPiApp 等 8 文件）
```

### 1.4 删除的依赖（Python）

FastAPI、uvicorn、openai-agents、httpx、playwright、pdfplumber、matplotlib、
scipy、seaborn、beautifulsoup4、pydantic、python-multipart、pyyaml、websockets、
python-dotenv —— 全部随 backend/pyproject.toml 删除。根 `pyproject.toml` 无任何
runtime 依赖（bridge 纯 stdlib）；dev 依赖仅 pytest + ruff。

---

## 2. 剩余 Python 文件与依赖

```text
database/
├── __init__.py
├── bridge.py           JSONL named-op 入口（--self-test）
├── cache_store.py      schema-neutral 逻辑缓存
├── database_store.py   用户 declarative database + enabled 状态持久化
├── declarative.py      manifest 校验模型（stdlib 重写，无 pydantic）
└── tests/              71 个 pytest 用例
pyproject.toml / uv.lock（根）
```

剩余 Python runtime 依赖：**无**（stdlib：argparse/json/sqlite3/pathlib/dataclasses/tempfile）。
bridge 不 import `backend`、`app.`、`agents`、`fastapi`、`uvicorn`、playwright、
pdfplumber、scipy、matplotlib、seaborn（由
`database/tests/test_database_store.py::test_no_forbidden_imports_in_database_package`
静态钉住）。

---

## 3. DB bridge 协议（不变）

```jsonc
→ {"version":"1","id":"req_1","op":"cache.search","args":{"query":"TP53"}}
← {"version":"1","id":"req_1","ok":true,"data":[...]}
← {"version":"1","id":"req_1","ok":false,"error":{"code":"not_found","message":"..."}}
```

- 协议版本保持 `"1"`；无新增任意 SQL / raw query 入口；
- named ops：`ping`、`cache.{commit,search,list,describe,get}`、
  `database.{list,disabled,get,tool_manifests,save,patch,delete,set_enabled}`
  （新增 `database.disabled` 供 TS builtin 合并使用）；
- `cache.commit` 为 schema-neutral：列 schema 由记录自身 manifest 声明，
  不再有全局 22 列 `CACHE_MAIN_DATA_COLUMNS`；旧记录（无 `columns` 字段）
  从 CSV 表头读兼容；
- builtin database catalogue 移入 TS（`server/src/product/builtin-databases.ts`，
  9 个可选内置库：pubmed/chembl/uniprot/geo/gdc/xena/pdb/pubchem/reactome）；
  Python 只持久化 facts（用户 manifest + enabled/disabled 状态）。

---

## 4. 测试结果（最终门禁，本机 Windows + 本 worktree）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| bridge 自检 | `uv run python database/bridge.py --self-test` | SELF-TEST OK |
| database 测试 | `uv run pytest database/tests -q` | 71 passed |
| database lint | `uv run ruff check database` | All checks passed |
| server 测试 | `npx vitest run --maxWorkers=2`（server/） | 701 passed, 11 skipped (live) |
| frontend 测试 | `npx vitest run --maxWorkers=2`（frontend/） | 723 passed |
| contracts 测试 | `npx vitest run`（packages/contracts/） | 14 passed |
| workspace lint | `pnpm -r lint` | 0 errors / 0 warnings |
| workspace typecheck | `pnpm -r typecheck` | 0 errors |
| workspace build | `pnpm build` | 成功（frontend ✓ + server tsc） |
| workspace foundation | `node scripts/check-workspace-foundation.mjs` | passed |

注：`pnpm test`（根）会在本机并行拉起三个包的 vitest，导致 build-lock /
browser / workspace 等对负载敏感用例偶发超时；按包串行（maxWorkers=2）复跑
全部通过，CI（独立 job/runner）不受影响。日常开发建议使用
`pnpm --filter <pkg> test` 或降低 worker 数。

## 5. 启动 smoke

### 5.1 开发（pnpm dev）

```text
TS Host listening 127.0.0.1:5173
GET /api/v1/health      → {"status":"ok","app_host":"ts","agent_runtime":"pi","dataset_core":"ts"}
GET /                   → 200（Vite HMR）
GET /api/v1/databases   → 9 个 builtin 条目（TS catalogue 合并）
无 uvicorn / FastAPI 进程；DB bridge 按需 spawn（/databases 请求触发），
Host 关闭时 bridge 随 EOF 干净退出
```

### 5.2 生产（pnpm build && pnpm start）

```text
TS Host listening 127.0.0.1:5199（--static）
GET /api/v1/health      → 200（ts/pi/ts）
GET /                   → 200（frontend/dist/index.html）
GET /some/route         → 200（SPA fallback）
GET /api/v1/cache/datasets → {"items":[]}
```

---

## 6. E2E 结果矩阵（自动化测试覆盖）

| # | 场景 | 覆盖 |
| --- | --- | --- |
| 1 | 新建 Task | durable-runtime / durable-agent-runtime tests |
| 2 | Pi 多轮对话 | pi-adapter.test.ts、durable-agent-runtime tests |
| 3 | Tool 调用 | phase5/*.test.ts（acquisition/analysis/processing） |
| 4 | DatasetBuild SUCCESS | tests/phase5/ts-core-e2e.test.ts、dataset-build-tools.test.ts |
| 5 | PARTIAL_SUCCESS | ts-core-e2e（golden fixtures） |
| 6 | NO_DATA | ts-core-e2e（golden fixtures） |
| 7 | SPEC_REJECTED / FAILED | ts-core-e2e、dataset-validation.test.ts |
| 8 | cancel + terminal ack | durable-agent-runtime、core-preemption.test.ts |
| 9 | restart / interrupted recovery | durable-runtime、straggler-safety.test.ts |
| 10 | WS disconnect → replay → live | durable-agent-runtime.test.ts |
| 11 | artifact list/download | product-api.test.ts、durable-agent-runtime.test.ts |
| 12 | settings/model | model-settings.test.ts、product-api.test.ts |
| 13 | 用户 declarative database CRUD | builtin-databases.test.ts、declarative-db.test.ts、product-api.test.ts |
| 14 | local cache | db-bridge.test.ts（真实 bridge 往返）、cache-api 测试 |
| 15 | browser acquisition | phase5/browser.test.ts、crawler.test.ts |
| 16 | HIL approval/resume | approval-gate / declarative-db HIL 测试 |

无任何功能需要恢复 `backend/` 才能通过。

## 7. 静态审计

```bash
git ls-files backend            → 0
rg "AGENT_RUNTIME|DATASET_CORE|APP_HOST|PI_EXPERIMENTAL|LEGACY_BACKEND|PI_DATASET_BRIDGE_SECRET|createLegacyBackend" \
   server/src frontend/src packages scripts package.json .env.example .github
                                → 仅 .env.example 一行说明性注释（说明已退役）
```

新增架构 guard（留在 CI）：
- `server/tests/phase8-architecture-guard.test.ts`：扫描 server/src 不得出现
  createLegacyBackend / legacyTarget / bridgeSecret / uvicorn /
  `/experimental/pi` 等 12 类模式；
- `database/tests/test_database_store.py::test_no_forbidden_imports_in_database_package`：
  database/ import 行不得引用 backend/app/agents/fastapi/科学栈；
- `server/tests/phase5/pi-isolation.test.ts`：业务工具不得 spawn Python / 调
  legacy endpoint，service 层不得引用 legacy client；
- `server/tests/config.test.ts`：legacy env 不再被解析。

## 8. 已知非阻塞遗留项（Known non-blocking leftovers）

1. `server/src/settings/model-settings.ts` 保留 `legacyRegistryPath` /
   `model.json` 一次性导入：这是对旧用户数据（Python 时代的 settings 文件）的
   只读迁移，不启动任何 Python 进程；数据迁移完成后可后续清理。
2. 历史文档（docs/ARCHITECTURE.md §18.4–18.8、docs/migration/phase*.md、
   docs/BioMed-QAgent_Pi_Migration_Plan.md 正文）保留迁移期拓扑描述，已标注
   historical / completed / 非当前启动说明。
3. 代码注释中的 `backend/...` 路径属于历史出处说明（“Port of …”），非运行时引用。
4. `frontend/vite.config.ts` 保留 `/api` 代理（standalone 诊断用），默认目标已
   从 legacy 8000 改为 TS Host 5173。
5. `.env.example` 含一行说明性注释提及已退役 flag 名称。

## 9. Definition of Done 对照

- [x] `database/bridge.py` 不再依赖 `backend/`（P8-A 验收：重命名 backend 后
      bridge self-test 与 db-bridge.test.ts 仍通过）
- [x] Python database persistence 迁至 `database/`（cache_store / database_store / declarative）
- [x] DB bridge 不依赖 Agent/Skill/FastAPI（stdlib-only，guard 钉住）
- [x] active cache 不再硬编码 22 列 schema（schema-neutral + 旧记录读兼容）
- [x] `server/src/config.ts` 不再提供 legacy runtime profile
- [x] TS bootstrap 不再具备 FastAPI spawn/proxy 路径
- [x] Python Dataset Core bridge（legacy/dataset-core-client.ts、app/compat）已删除
- [x] experimental Phase 1 Pi runtime 已删除（server + frontend）
- [x] rollback-only root scripts 已删除（dev:legacy-*、dev-profile.mjs）
- [x] legacy migration env vars 已删除（.env.example、config.ts）
- [x] `backend/` 已物理删除（git ls-files backend = 0）
- [x] FastAPI / Uvicorn / openai-agents / Python Playwright / pdfplumber /
      matplotlib / SciPy / seaborn 已从依赖移除
- [x] Python project 缩成 database-only（根 pyproject.toml + uv.lock）
- [x] legacy Python tests 已删除或转 golden fixtures（tests/fixtures）
- [x] DB bridge tests 已迁移并通过（database/tests，71 passed）
- [x] CI 不再同步/测试整个 Python backend（ci.yml database job + Windows bridge self-test）
- [x] packaging 不再包含 backend（package.yml 改 TS bundle）
- [x] `pnpm test / lint / typecheck / build` 通过（按包串行验证）
- [x] DB bridge self-test / Python tests / lint 通过
- [x] development startup smoke 通过（pnpm dev）
- [x] production startup smoke 通过（pnpm build && pnpm start）
- [x] Windows bridge smoke 通过（本机 Windows 全程执行）
- [x] 核心 E2E 矩阵通过（见 §6）
- [x] active source legacy-reference scan 为零（§7）
- [x] `docs/TODO.md` Phase 8 标记完成
- [x] `PHASE8_FINAL_VERIFICATION.md` 已提交（本文）
