# Phase 8 Final Verification（legacy Python Runtime 物理退役验收报告）

> 状态：**closed**（2026-08-15；含第二轮最终审计修复 §10 与第三轮 P8-G 封板 §11）
> Baseline commit：`cb2600597525d97fb00538b55dcfb001cb6e7c03`（main）
> 合并提交：`08dc47d`（P8-A→P8-D）；最终审计修复：`6410279`（fix/phase8-final-audit）；
> P8-G 封板：`<merge>`（fix/phase8-final-audit-p8g）
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

---

## 10. 第二轮最终审计（2026-08-14，修复后封板）

第一轮封板后独立审计发现四项封板级问题，已全部修复并在真实 GitHub Actions
上验证：

### 10.1 P0 — Windows CI 红灯（存量，非 Phase 8 回归）

现象：`Windows build-lock + dataset core + bridge gates` 在 fresh checkout 上失败：
`Failed to resolve entry for package "@biomed/contracts"`。

根因：Windows job 直接 `npx vitest run`（精选测试清单），绕过了 server 包的
`pretest`（`pnpm --filter @biomed/contracts build`），fresh checkout 下
`packages/contracts/dist` 不存在。该问题在 phase7 合并时已存在，但必须修绿。

修复：Windows job 在 vitest 前显式 `pnpm --filter @biomed/contracts build`
（`.github/workflows/ci.yml`）。

### 10.2 P0/P1 — Release bundle 不完整 + 无冒烟

原 bundle 缺 `packages/`（`@biomed/contracts` 是 `workspace:*` 依赖）、
`server/tsconfig.json`、根 `tsconfig.base.json`（server `start` 用 `tsc -p
server/tsconfig.json`，其 extends 根 base），且会删除 `server/src/dev`（生产
static host）。`package.yml` 另有存量 bug：staging 引用 checkout 中不存在的
`frontend/dist`（gitignored），release flow 自 v0.1.0 起从未绿过。

修复（`.github/workflows/package.yml` + `server/package.json`）：

- staging 补 `packages/`（排除 node_modules）、`tsconfig.base.json`、
  `server/tsconfig.json`；`frontend/dist`、`server/dist` 由 build job 的
  artifact 提供（删除错误的 `cp frontend/dist`）；
- server 增加 `prestart`（`pnpm --filter @biomed/contracts build`），bundle 内
  `pnpm start` 自包含（prestart → tsc → node --static）；
- 新增 `release-smoke` job：unpack → `pnpm install --frozen-lockfile` →
  `uv sync --frozen` → bridge self-test → `pnpm start` → curl
  `/api/v1/health`、`/`、`/api/v1/databases`；
- artifact 名用 run step 计算（`ref_name` 含 `/` 时 sanitize 为 `-`）。

### 10.3 P1 — cache commit 原子性漏洞

原 `commit_dataset` 顺序为 `os.replace(manifest_tmp, manifest_path)` 后
`os.replace(main_data_tmp, main_data_path)`；若第二步失败，manifest 已是新
版本而 CSV 是旧版本（或缺失），异常处理只清理 `.tmp`，不回滚已替换文件。

修复（`database/cache_store.py`）：发布前把既有最终文件原子重命名为 `.bak`
快照；manifest 最后发布 = commit point；任何失败回滚全部快照（或删除新发布
文件）并清理 `.tmp`；下次 commit 幂等恢复崩溃遗留的 `.bak`（未过 commit
point 则还原，已过则清理）。新增 6 个故障注入/崩溃恢复测试
（`database/tests/test_cache_store.py`，cache 套件 29 → 35 用例，全库 71 → 77）。

### 10.4 P2 — docs/TODO.md 顶部自相矛盾

总进度表 Phase 8 标记为“⬜ 待开始”、仍声称默认 profile 为
`APP_HOST=ts / AGENT_RUNTIME=pi / DATASET_CORE=ts / PI_EXPERIMENTAL=0` 且
FastAPI rollback 存在。已改为“✅ 完成（2026-08-14）”，profile 描述替换为
当前唯一拓扑说明，并注明下文各 Phase 正文为迁移期历史记录。

### 10.5 真实 CI 证据（合并前分支头 `6ec22f0`）

| 运行 | 结果 |
| --- | --- |
| CI pull_request（`31821864011`） | ✅ workspace / database / **windows** 全绿 |
| package workflow_dispatch（`31821861231`） | ✅ build×2 / package / **release smoke** 全绿；
  “Create Release”按预期跳过（无 tag） |

### 10.6 本机重跑门禁（修复后）

`uv run pytest database/tests` 77 passed + ruff clean + bridge self-test OK；
server 701 passed / 11 skipped；frontend 723 passed；contracts 14 passed；
lint / typecheck / build 0 问题；本地模拟 bundle（staging →
`pnpm install --frozen-lockfile` → `uv sync --frozen` → `pnpm start`）health /
root / SPA fallback / databases=9 全部 200。

> 已知非阻塞遗留项（§8）继续有效；新增一条：release bundle 的“Create
> Release”步骤仅在 tag 推送（`v*`）时执行，branch dispatch 下按预期失败。

---

## 11. 第三轮 P8-G 封板（2026-08-15，最终审计后）

独立复审结论：架构迁移本体完成（Pi / TS Dataset Core / bridge / legacy 删除
全部确认），但封板前还有 2 个 P1 边角问题 + 1 个工程卫生问题。四项处理
结果如下，全部附真实 GitHub Actions 证据。

### 11.1 cache crash recovery 剩余窗口（P1，已修）

上一轮修复后仍有一个未覆盖崩溃点：**两次快照重命名之间** crash（`csv →
csv.bak` 成功、manifest 快照未执行）。此时状态为：`csv.bak` 存在、CSV
缺失、`manifest.json`（旧）存在、`json.bak` 缺失。原 `_recover_leftover_backups`
将“仅 csv_bak 存在”判为不可能并落入清理分支**删除唯一旧 CSV 副本**——
数据从暂时不可读变成永久丢失（如随后写盘失败）。

修复（`database/cache_store.py`）：`json_bak` 缺失但 `csv_bak` 存在 → 快照未
完成，**还原** `csv.bak → main_data.csv` 而非删除；结构上先处理 `json_bak`
分支（发布未完成回退 / 越过 commit point 清理），再处理仅 `csv_bak` 分支。
新增 2 个回归测试（`database/tests/test_cache_store.py`）：

- 崩溃窗口 + 下次 commit 写盘失败 → 旧 dataset 完整可读、无残留
  （该测试在旧逻辑下确实失败：`assert result is not None` 红）；
- 同一窗口 + 下次 commit 成功 → 正常发布新版本。

全库 `uv run pytest database/tests`：79 passed（77 → 79）；ruff clean；
bridge self-test OK。

### 11.2 release bundle staging 嵌套（P1/P2，已修）

`package.yml` 的 download 步骤先创建 `staging/frontend/dist`，随后
`cp -r frontend staging/frontend` 因目标目录已存在而把源目录**嵌套**成
`staging/frontend/frontend/`，bundle 内 `frontend` workspace 结构被破坏
（`pnpm-workspace.yaml` 的 `frontend` 不再对应正常 package）。

修复：改为 `cp -r frontend/. staging/frontend/`（合并内容；本地模拟验证
嵌套消除）。server 行 `cp -r server/src staging/server/src` 目标路径尚不
存在、语义正确，未改动。

**真实 GitHub Actions 验收**（此前该 workflow 从未实际运行过）：

- `workflow_dispatch`（branch ref，run `31858398801`）：
  Build Frontend ✅ / Build TS Application Host ✅ / Package ✅ /
  **Release bundle smoke ✅**（unpack → `pnpm install --frozen-lockfile` →
  `uv sync --frozen` → bridge self-test → `pnpm start` → GET health/`/`/databases
  全 200）；Create Release 无 tag 按预期失败；
- 下载 artifact 直接查验 zip：`frontend/package.json` + `frontend/src/`
  （202 文件）+ `frontend/dist/` 同级、**无 `frontend/frontend` 嵌套**；
  `server/{package.json,tsconfig.json,src,dist}`、`packages/contracts/src`
  （prestart 构建 dist）、`tsconfig.base.json` 全部就位。

### 11.3 `server/data/` 来源与错误 ignore（P2，已修）

真相：根 `.env` 写 `OUTPUT_DIR=data/output`（相对路径），而旧 `index.ts`
用 `path.resolve(OUTPUT_DIR)` **按进程 cwd 解析**——在 `server/` 目录下运行
server 包 dev/start 脚本（其设计上读 `../.env`）时，运行时数据落到
`server/data/`（cache + settings）。`server/data/settings/` 内是**真实用户
配置（含 API key）**，未删除、未跟踪。

修复：`server/src/config.ts` 新增 `resolveOutputDir(repositoryRoot, raw)`——
相对 `OUTPUT_DIR` **锚定 repositoryRoot** 而非 cwd（绝对路径行为不变，
空值默认 `<repo>/data/output`）；`index.ts` 改用之；`config.test.ts` 新增
3 个测试（默认值 / 绝对路径 / 相对路径锚定回归）。

`.gitignore`：删除错误的 `server/data/` 条目（隐藏了上述问题）与失效的
`backend/tmp-*/`、`!backend/app/datasets/build/` 残留；保留正式运行时数据根
`<repo>/data/` 的既有忽略规则。

### 11.4 最终封板结论

| 项目 | 状态 |
| --- | --- |
| Phase 8 架构迁移本体（Pi / TS Core / bridge / legacy 删除） | ✅ |
| Windows CI（`uv sync` + bridge self-test + contracts build + 测试） | ✅ |
| database CI / workspace CI | ✅ |
| cache 普通异常 rollback + 完整 crash recovery（含快照间窗口） | ✅ |
| release bundle workflow（真实 Actions run + smoke + 布局查验） | ✅ |
| `OUTPUT_DIR` cwd 敏感 / `server/data/` 泄漏 | ✅ |
| docs（TODO / ARCHITECTURE / 本报告） | ✅ |

Phase 0–8 Pi 迁移主线：**sealed**。后续变更按常规开发流程走。
