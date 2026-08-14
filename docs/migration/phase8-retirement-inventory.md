# Phase 8 Retirement Inventory（P8-00 基线盘点）

> 状态：completed（Phase 8 执行开始时建立）
> 基线：`main @ cb2600597525d97fb00538b55dcfb001cb6e7c03`
> 本文是 P8-00 的产物：删除前对 legacy Python Runtime / rollback topology /
> feature flags 的完整反向引用分类。分类标准：
> `DELETE` / `MOVE_TO_DATABASE` / `MOVE_TO_TS` / `KEEP_AS_GOLDEN_FIXTURE` /
> `KEEP_AS_ARCHIVED_DOC`。任何 Python Runtime 文件不得处于 `UNKNOWN`。

---

## 1. Python 文件分类（backend/）

### MOVE_TO_DATABASE（迁入 database/，保留语义）

| 文件 | 职责 | Phase 8 处理 |
|---|---|---|
| `database/bridge.py` | JSONL named-op 门面 | 保留；删除 `--backend-root` 与 sys.path 注入 |
| `backend/app/tools/cache_store.py` | 逻辑缓存持久化（SQLite index + CSV/records） | 迁 `database/cache_store.py`；**schema-neutral 化**（删 22 列常量） |
| `backend/app/databases/store.py` | 用户 manifest + enabled 状态持久化 | 迁 `database/database_store.py`；剥离 FunctionTool / builtin skill 依赖 |
| `backend/app/databases/declarative.py` | manifest 校验模型 + HTTP tool builder | 迁 `database/declarative.py`；**stdlib 重写**（去 pydantic/httpx/agents），删除 `DeclarativeHttpToolBuilder` |

### MOVE_TO_TS（业务语义归属 TS）

| 内容 | 原位置 | Phase 8 处理 |
|---|---|---|
| builtin database catalogue（9 个可选内置库的 name/category/description/version/pipeline_supported/user_selectable） | `backend/app/skills/builtin/*`（`builtin_skill_records()`） | `server/src/product/builtin-databases.ts`（数据来自 SKILL_TOOL_MAP + 静态事实表） |
| declarative manifest 业务校验（保存前） | `app.databases.declarative`（pydantic） | `server/src/agent/tools/declarative-db.ts`（已有 `parseDeclarativeManifest`，P5 产物） |
| HTTP Tool construction | `DeclarativeHttpToolBuilder`（agents SDK） | `server/src/agent/tools/declarative-db.ts`（已有） |
| secret/auth handling | Python env 读取 | TS PublicHttpClient + ToolApprovalGate（已有） |

### DELETE（backend/ 整体退役，P8-C 物理删除）

- `backend/app/agent_loop/`、`backend/app/runtime/`、`backend/app/subagents/`、
  `backend/app/skills/`、`backend/app/pipeline/`、`backend/app/datasets/`、
  `backend/app/tools/`、`backend/app/api/`、`backend/app/main.py`
- `backend/app/compat/pi_dataset_bridge.py`（Python Dataset Core bridge，596 行）
- `backend/app/model_config/`、`model_info/`、`model_registry/`、`integrations/`、
  `domain/contracts/`、`recipes/`、`personalization.py`、`settings.py` 等
- `backend/launcher.py`、`backend/scripts/`、`backend/requirements.txt`、
  `backend/pyproject.toml`、`backend/uv.lock`、`backend/README.md`、
  `backend/REPRODUCIBILITY.md`
- `backend/tests/`（legacy implementation tests；有保留价值的 golden 见下）

### KEEP_AS_GOLDEN_FIXTURE（保留数据，不保留实现）

- `tests/migration/golden/`（contract-snapshot + 四类 build fixture）— TS parity 测试继续使用
- `tests/migration/contracts/wire-contracts.json`
- `scripts/verify_migration_golden.py` — 由 TS 侧 golden 校验替代后删除（P8-06 确认）

### KEEP_AS_ARCHIVED_DOC（历史记录，不改写）

- `docs/archive/`、`docs/migration/phase*.md` 历史报告（标记 historical/completed）

---

## 2. TS 侧 legacy/rollback 引用（server/src/）

| 文件 | 行数 | 内容 | Phase 8 处理 |
|---|---|---|---|
| `server/src/config.ts` | 148 | FeatureFlags（APP_HOST/AGENT_RUNTIME/DATASET_CORE/PI_EXPERIMENTAL）+ 6 个 legacy profile | P8-B 删除 flags，仅留运行参数 |
| `server/src/bootstrap.ts` | 163 | createLegacyBackend / needsLegacyBackend / experimentalPi 闭包 | P8-B 简化 |
| `server/src/legacy/backend-process.ts` | 367 | FastAPI spawn（backend/.venv uvicorn）、readiness、进程树终止 | P8-B 删除 |
| `server/src/legacy/dataset-core-client.ts` | 213 | Python Dataset Core HTTP client（bridge secret） | P8-B 删除 |
| `server/src/legacy/proxy.ts` | 37 | HTTP/WS 代理到 private FastAPI | P8-B 删除 |
| `server/src/agent/experimental-pi.ts` | 511 | `/experimental/pi/*` 非 durable runtime | P8-B 删除 |
| `server/src/agent/phase1-composition.ts` | 105 | Phase 1 组合（含 DatasetCoreClient） | P8-B 删除 |
| `server/src/runtime/phase3-composition.ts` | 206 | legacyTarget / bridgeSecret 转发 | P8-B 剥离 legacy 分支 |
| `server/src/app/create-app.ts` | 230 | proxy 路由热路径 + experimentalPi 注入 | P8-B 简化 |
| `server/src/agent/event-adapter.ts`、`session-registry.ts` | — | "Experimental Pi" 错误路径 | P8-B 清理 |
| `server/src/product/product-api.ts` | 323 | profile.datasetCore "python" 类型 | P8-B 简化 |
| `server/src/persistence/db-client.ts` | 241 | backendRoot 探测 | P8-A 已删（repo/.venv 探测） |

### TS 测试（删除/迁移，P8-B/P8-C）

- `tests/backend-process.test.ts`、`tests/backend-process-tree.test.ts`（uvicorn spawn）
- `tests/dataset-core-client.test.ts`（Python Core client）
- `tests/experimental-pi.test.ts`、`tests/experimental-pi-ws.test.ts`、`tests/experimental-pi-bounds.test.ts`
- `tests/phase1f-e2e.test.ts`、`tests/phase1f-composition.test.ts`（Phase 1 组合）
- `tests/config.test.ts`（legacy profile 矩阵）、`tests/bootstrap.test.ts`（rollback provision 分支）
- `tests/host.test.ts`（legacy/bridgeSecret 注入分支）
- `tests/durable-agent-runtime.test.ts` legacy WS 订阅转发段
- `tests/model-settings.test.ts` legacy SQLite 一次性导入段
- `tests/phase5/pi-isolation.test.ts` legacyTarget 断言段
- 保留：`tests/phase5/db-bridge.test.ts`（改 schema-neutral）、`tests/phase5/declarative-db.test.ts`、
  `tests/phase5/builtin-databases.test.ts`（新增）

---

## 3. 根脚本 / CI / 打包 / env

| 内容 | 位置 | 处理 |
|---|---|---|
| `dev:legacy-backend` / `dev:host-proxy-only` / `dev:legacy-rollback` | 根 package.json L6-15 | P8-B 删除；P8-C 加 `start` |
| `scripts/dev-profile.mjs`（legacy 三 profile 编排） | scripts/ | P8-B 删除 |
| `scripts/test_agent_task.py`（8000 端口诊断） | scripts/ | P8-C 删除 |
| `scripts/check-workspace-foundation.mjs` L44-52（断言 3 个 legacy scripts 存在） | scripts/ | P8-B 同步修改 |
| ci.yml job `workspace`（backend uv sync）与 job `python`（pytest/ruff） | .github/workflows/ | P8-C 替换为 database gate |
| package.yml job `package`/`release`（PyInstaller launcher.py） | .github/workflows/ | P8-C 替换为 TS 打包 |
| `.env.example`（APP_HOST/AGENT_RUNTIME/DATASET_CORE/PI_EXPERIMENTAL/LEGACY_*/PI_DATASET_BRIDGE_SECRET） | 根 | P8-B 清理 |

---

## 4. cache named ops 的正式调用方（P8-02 依据）

| op | 调用方 | 保留 |
|---|---|---|
| `cache.commit` | 无正式 TS 调用方（bridge 自测 + 未来 import 流程） | 保留（自测/未来） |
| `cache.search` | `server/src/agent/tools/local-cache.ts:74` | 保留 |
| `cache.list` | `server/src/product/cache-api.ts:153,175,210` | 保留 |
| `cache.describe` | `cache-api.ts:169`、`local-cache.ts:127` | 保留 |
| `cache.get` | `local-cache.ts:188` | 保留 |
| `database.*` 7 个 op | `product-api.ts`、`declarative-db.ts:314`（tool_manifests） | 保留；新增 `database.disabled`（builtin 合并用） |

**22 列 schema 硬编码位置**（P8-02 清理对象）：
- `backend/app/tools/cache_store.py:40-63`（CACHE_MAIN_DATA_COLUMNS）
- `server/src/agent/tools/local-cache.ts:29`（TS 副本）
- `server/tests/phase5/db-bridge.test.ts:14,77,173`（钉 22 列断言）
- 历史 archive / golden fixture 可保留。

---

## 5. 用户数据兼容（不可破坏）

- `data/cache/records/**/main_data.csv` + `manifest.json`：旧 manifest 无 `columns` 字段 → 读取时从 CSV 表头推断（`database/cache_store.py` read-compatible importer）
- `data/databases/*.json` + `state.json`：格式不变（仍是 JSON manifest + disabled 列表）
- 内置库 disabled 开关：继续由 Python `state.json` 持久化（`set_enabled` 接受任意名称）

---

## 6. 验证结果（P8-00 完成时）

- `uv run python database/bridge.py --self-test` → SELF-TEST OK
- server tests：733 passed / 11 skipped（live）
- backend pytest：2334 passed
- frontend tests：730 passed
- 关键验收实验：`mv backend backend-hidden` 后 bridge self-test 与
  `db-bridge.test.ts`（11 用例）仍通过 → DB bridge 已与 backend/ 完全解耦
