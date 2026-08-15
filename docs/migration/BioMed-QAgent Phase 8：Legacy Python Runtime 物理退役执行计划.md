# BioMed-QAgent Phase 8：Legacy Python Runtime 物理退役执行计划

> 建议仓库路径：`docs/migration/phase8-python-runtime-retirement.md`  
> 状态：Ready for implementation  
> 基线：`main @ cb2600597525d97fb00538b55dcfb001cb6e7c03`  
> 前置阶段：Phase 0–7 已完成  
> 目标：彻底删除 legacy Python Runtime、FastAPI rollback topology 与迁移期 feature flags；Python 最终只服务 `database/` 持久化 bridge。  
> 原则：**删除旧实现，不重新设计已经稳定的 BioMed 业务语义。**

---

# 1. Phase 8 的任务定义

Phase 8 不再迁移新能力。

Phase 0–7 已经完成：

```text
Frontend
  ↓
TS Application Host
  ├─ Pi Main Agent
  ├─ TS durable Task/Run/Event runtime
  ├─ TS business tools
  ├─ TS external capabilities
  ├─ TS Dataset Deterministic Core
  └─ TS product APIs
       │
       └─ DatabaseClient
             ↓
         database/bridge.py
```

当前默认 profile：

```text
APP_HOST=ts
AGENT_RUNTIME=pi
DATASET_CORE=ts
PI_EXPERIMENTAL=0
```

默认启动已经不需要 FastAPI。

Phase 8 要将此“默认路径”升级成“唯一正式路径”：

```text
React
  ↓
TS Host
  ├─ Pi
  ├─ TS Runtime
  ├─ TS Dataset Core
  ├─ TS Business Tools
  └─ DatabaseClient
        ↓
    database/
```

最终仓库不得继续维护：

```text
legacy Agent Runtime
Python Dataset Core
FastAPI product API
Python Skill Runtime
Python scientific processing
Python acquisition/browser stack
migration-only Python bridge
legacy runtime feature flags
rollback-only startup profiles
```

---

# 2. 当前状态与 Phase 8 硬阻塞

## 2.1 Phase 7 已完成，不允许重新做默认切换

当前 `main` 已完成：

```text
frontend → TS Host
formal API → TS
formal WS → TS
Task/Run/Event → TS
Agent → Pi
Dataset Core → TS
settings/product APIs → TS
```

FastAPI 只在下列显式回滚条件下启动：

```text
AGENT_RUNTIME=legacy
DATASET_CORE=python
PI_EXPERIMENTAL=1
```

Phase 8 不再维护这些回滚组合。

---

## 2.2 DB bridge 尚未真正独立

这是 Phase 8 第一硬阻塞。

当前：

```text
database/bridge.py
  ↓ sys.path += backend/
  ├─ app.tools.cache_store
  └─ app.databases.store
```

因此：

```text
rm -rf backend/app
```

会直接破坏数据库 bridge。

而 `app.databases.store` 目前还依赖：

```text
agents.FunctionTool
app.skills.builtin
app.skills.categories
app.databases.declarative
```

所以不能简单将整个 `store.py` 原封不动搬进 `database/`。

必须先重新切开：

```text
TS
= database 业务语义、builtin metadata、HTTP Tool execution、manifest validation

Python database/
= 文件/SQLite 持久化、named operations
```

Python bridge 不得继续知道 Pi、Skill、Agent Tool 或 Dataset Core。

---

## 2.3 TS Host 仍保留迁移期 rollback topology

当前至少还存在：

```text
server/src/config.ts
  APP_HOST=fastapi|ts
  AGENT_RUNTIME=legacy|pi
  DATASET_CORE=python|ts
  PI_EXPERIMENTAL=0|1

server/src/bootstrap.ts
  createLegacyBackend()
  createPhase1ExperimentalRuntime()
  needsLegacyBackend()

server/src/legacy/
  ...

legacy Python Core client/bridge
experimental Pi Phase 1 composition
```

Phase 8 结束后这些结构不应继续存在。

---

## 2.4 根脚本与 CI 仍把 legacy Python 当受支持产品

当前根 `package.json` 仍有：

```text
dev:legacy-backend
dev:host-proxy-only
dev:legacy-rollback
```

CI 仍执行：

```text
cd backend
uv sync
uv run pytest
uv run ruff ...
```

这意味着仓库在工程层仍把整个 Python backend 当正式维护面。

Phase 8 必须一并清理，否则“代码删除”与“开发模型”仍互相矛盾。

---

# 3. Phase 8 不可破坏约束

整个 Phase 8 必须保持以下不变量：

```text
Pi Session != BioMed Task != Run != DatasetBuild

Skill != Tool != Dataset Core

Agent Workspace != Publication boundary

staging/ 可供 Agent/Tool 工作
artifacts/ / publications/ 仍只能由受信任 Publisher 写

DatasetBuildSpec
BuildResult
ValidationResult
DatasetManifest
DatasetPublication
EventEnvelope
不得因删除 Python 而改变业务语义
```

尤其禁止：

- 为方便删 Python 修改 DatasetBuild contract；
- 降低 Validation Gate；
- 允许 Agent 直接写正式 publication；
- 删除 golden fixture 后失去行为基线；
- 用新的兼容 shim 永久替代旧 shim；
- 将 Python DB bridge 扩张成新的 Python backend；
- 为保留旧测试重新引入 FastAPI/OpenAI Agents SDK；
- 将 rollback profile 换一个名字继续长期保留。

---

# 4. 执行顺序

严格按以下顺序执行：

```text
P8-00  Phase 8 baseline / dependency inventory
   ↓
P8-01  DB bridge 自包含
   ↓
P8-02  DB / cache 业务语义彻底退出 Python
   ↓
P8-03  删除 TS Host 的 legacy/rollback topology
   ↓
P8-04  物理删除 legacy Python Runtime
   ↓
P8-05  重构 Python 环境、CI、开发脚本
   ↓
P8-06  清理历史兼容代码与运行时引用
   ↓
P8-07  Clean-clone / cross-platform 最终验收
   ↓
P8-08  文档封板
```

不得调整为：

```text
先删除 backend/
→ 测试爆炸
→ 再逐个恢复需要的 Python 文件
```

---

# 5. P8-00：冻结 Phase 8 baseline

## 目标

在开始删除前确定：

1. 哪些 Python 文件仍由 TS 正式路径调用；
2. 哪些 TS 模块只为 rollback 服务；
3. 哪些测试仍运行旧实现而不是验证新实现；
4. 哪些 fixture 必须保留；
5. 哪些用户数据需要兼容读取。

## 工作

建立：

```text
docs/migration/phase8-retirement-inventory.md
```

至少记录：

| 类型 | 检查内容 |
|---|---|
| Python imports | `database/` 是否引用 `backend/` |
| TS imports | `server/` 是否引用 `legacy/` |
| child process | 哪些地方还能启动 FastAPI/Uvicorn |
| feature flags | 所有 legacy runtime 环境变量 |
| root scripts | rollback/debug scripts |
| tests | 哪些测试必须删除、迁移或转 fixture |
| CI | 哪些 job 安装整个 backend |
| package | 哪些打包脚本仍复制 backend |
| docs | 哪些当前文档仍指导启动 FastAPI |
| cache | TS 正式路径对 `cache.*` named op 的真实使用 |
| database | builtin database metadata 与 user manifest 的所有权 |

使用 `rg` 建立完整反向引用，不根据目录名猜测。

重点搜索：

```text
backend/
app.
fastapi
uvicorn
openai-agents
AGENT_RUNTIME
DATASET_CORE
APP_HOST
PI_EXPERIMENTAL
LEGACY_BACKEND
PI_DATASET_BRIDGE_SECRET
createLegacyBackend
legacyTarget
bridgeSecret
phase1-composition
python core
```

## 验收

形成明确分类：

```text
DELETE
MOVE_TO_DATABASE
MOVE_TO_TS
KEEP_AS_GOLDEN_FIXTURE
KEEP_AS_ARCHIVED_DOC
```

任何 Python Runtime 文件都不能处于 `UNKNOWN`。

---

# 6. P8-01：让 `database/` 成为真正独立的 Python 边界

## 目标

达到：

```text
database/
  ↓
不 import backend
不 import agents
不 import FastAPI
不 import Pi
不 import Skill Runtime
不 import Dataset Core
```

这是删除 `backend/` 前必须完成的 checkpoint。

## 6.1 拆出 cache persistence

当前：

```text
database/bridge.py
→ app.tools.cache_store
```

改成例如：

```text
database/
├── bridge.py
├── cache_store.py
├── database_store.py
├── io_utils.py
└── tests/
```

`database/cache_store.py` 只负责：

- SQLite index；
- manifest/record 持久化；
- 原子文件写；
- search/list/get/commit；
- path validation；
- transaction/integrity。

不得依赖 Agent 或 Dataset Core。

---

## 6.2 拆出 declarative database persistence

当前 `DatabaseStore` 混合了三种职责：

```text
持久化
+
builtin Skill metadata
+
FunctionTool construction
```

Phase 8 必须拆开。

目标：

```text
TS
├─ builtin database catalogue
├─ declarative manifest schema
├─ HTTP Tool construction
├─ secret/auth handling
└─ business validation

Python database/
├─ state persistence
├─ user manifest JSON persistence
├─ enabled/disabled state
└─ named DB operations
```

Python bridge只存事实。

禁止在 `database/` 中继续出现：

```python
from agents import ...
from app.skills import ...
FunctionTool
SkillCategory
Pi...
```

---

## 6.3 删除 `--backend-root`

当前 `DatabaseClient` 与 bridge 都有：

```text
backendRoot
--backend-root
backend/.venv
```

DB bridge 独立后全部删除。

建议最终：

```ts
defaultBridgePath()
probePythonBin()
```

只解析：

```text
BIOMED_PYTHON_BIN
repo/.venv/Scripts/python.exe
repo/.venv/bin/python
python / python3 fallback
```

不得继续探测：

```text
backend/.venv/
```

---

## 6.4 Bridge protocol 保持兼容

不要因为内部代码移动修改现有 JSONL envelope：

```json
{
  "version": "1",
  "id": "...",
  "op": "...",
  "args": {}
}
```

响应仍保持：

```json
{
  "version": "1",
  "id": "...",
  "ok": true,
  "data": {}
}
```

named operations 仍是唯一入口。

不得新增：

```text
sql.exec
db.raw_query
python.eval
```

---

## P8-01 验收

必须同时满足：

```bash
uv run python database/bridge.py --self-test
pnpm --filter @biomed/server test
```

以及静态检查：

```text
database/**/*.py
```

中不存在：

```text
backend
app.
agents
fastapi
uvicorn
playwright
pdfplumber
scipy
matplotlib
seaborn
```

完成此 checkpoint 后，即使临时将 `backend/` 重命名，DB bridge 与默认 TS 路径仍应工作。

---

# 7. P8-02：清除 DB/cache 中残留的旧 Pipeline 语义

此 checkpoint 不能省略。

当前 legacy cache store 仍硬编码旧 `main_data.csv` 22 列 Schema。早期 Pipeline V2 Phase 8 已要求删除这一旧语义。

Phase 8 不应将这段代码机械搬到 `database/cache_store.py` 后宣称迁移完成。

## 执行规则

先扫描 TS 对：

```text
cache.commit
cache.search
cache.list
cache.describe
cache.get
```

的真实调用。

### 若正式路径仍使用 logical cache

新 persistence 必须改为 schema-neutral。

不得再有全局：

```text
CACHE_MAIN_DATA_COLUMNS
22-column schema
固定 main_data.csv
```

缓存记录至少应由自己的 manifest 描述：

```text
dataset_id
source_namespace
schema/version
primary artifact/reference
row_count
columns/schema metadata
provenance metadata
keywords
created_at
```

具体物理格式可保持 CSV + manifest，但 Schema 必须来自记录自身，而不是 Python 全局常量。

### 若某些 legacy cache operation 已无正式调用者

直接删除对应 named operation，不为“兼容理论用户”继续保留死接口。

### 数据兼容

不得破坏已有用户缓存。

若旧 `data/cache/records/**/main_data.csv` 已存在：

```text
旧记录 → read-compatible importer
新写入 → 新格式
```

或执行一次显式 migration。

禁止静默删除旧缓存。

## 验收

代码搜索不得再发现 active runtime 中的：

```text
CACHE_MAIN_DATA_COLUMNS
固定 22 列 cache gate
```

历史 archive / golden fixture 可保留。

---

# 8. P8-03：删除 TS Host 的 legacy rollback topology

DB bridge 独立后，开始删除 TS 侧 migration scaffold。

## 8.1 Feature flags 收口

当前：

```ts
appHost: "fastapi" | "ts"
agentRuntime: "legacy" | "pi"
datasetCore: "python" | "ts"
piExperimental: boolean
```

Phase 8 后这些已经不是 feature flag。

删除：

```text
APP_HOST
AGENT_RUNTIME
DATASET_CORE
PI_EXPERIMENTAL
```

正式架构直接固定：

```text
Host = TypeScript
Agent = Pi
Dataset Core = TypeScript
Experimental Phase-1 Pi surface = removed
```

配置层只保留真正运行参数，例如：

```text
HOST
PORT
SHUTDOWN_TIMEOUT_MS
WORKSPACE_DEV_EXEC
```

---

## 8.2 删除 legacy backend lifecycle

删除：

```text
createLegacyBackend
needsLegacyBackend
legacy target
legacy bridge secret
private FastAPI lifecycle
legacy readiness timeout
```

并清除：

```text
LEGACY_BACKEND_PORT
LEGACY_BACKEND_URL
LEGACY_READINESS_TIMEOUT_MS
PI_DATASET_BRIDGE_SECRET
```

注意：

```text
PI_DATASET_BRIDGE_SECRET
```

属于旧 Python Dataset Core bridge，不是 `database/bridge.py` JSONL IPC，不得混淆。

---

## 8.3 删除 Python Dataset Core rollback client

删除所有只服务：

```text
DATASET_CORE=python
```

的：

- bridge client；
- HTTP client；
- secret negotiation；
- cancel forwarding；
- legacy target routing；
- Python Core E2E。

`validate_dataset_build` / `execute_dataset_build` 最终只有 TS Core 实现。

---

## 8.4 删除 experimental Phase 1 surface

若以下代码只服务迁移期实验入口：

```text
/experimental/pi/*
createPhase1ExperimentalRuntime
phase1-composition
experimental Pi WS/event path
```

全部删除。

不要长期保留第二套非 durable Pi runtime。

---

## 8.5 简化 bootstrap

目标 bootstrap 应接近：

```text
create DatabaseClient
create NodeBrowserPool
create ModelSettingsService
create ProductApi
create durable Pi Runtime
register lifecycle
start Host
```

不得继续包含：

```text
if legacy
if python core
if experimental pi
proxy fallback
```

---

## P8-03 验收

以下字符串不应存在于 active TS runtime：

```text
agentRuntime === "legacy"
datasetCore === "python"
piExperimental
createLegacyBackend
legacyTarget
LEGACY_BACKEND_
PI_DATASET_BRIDGE_SECRET
```

同时：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

全绿。

---

# 9. P8-04：物理删除 legacy Python Runtime

完成 P8-01～03 后再执行。

按照迁移计划删除：

```text
backend/app/agent_loop/
backend/app/runtime/
backend/app/subagents/
backend/app/skills/
backend/app/pipeline/
backend/app/datasets/
backend/app/tools/
backend/app/api/
backend/app/main.py
```

但不要只删这几个目录。

应继续审计 `backend/` 剩余内容，只要不属于最终 `database/` 边界，就应分类处理：

```text
DELETE
MOVE
ARCHIVE FIXTURE
```

最终目标：

```text
git ls-files backend
```

应为空。

即整个：

```text
backend/
```

退役。

---

# 10. Python 测试退役规则

不能简单删除全部 Python tests 后让覆盖率骤降。

按三类处理。

## A. legacy implementation test

例如：

```text
FastAPI route tests
OpenAI Agents SDK tests
Python Runtime tests
Python Dataset Core implementation tests
Python acquisition/parser/scientific tests
rollback topology tests
```

对应实现已删除，测试一并删除。

## B. parity/reference test

若测试存在目的只是：

```text
Python implementation
vs
TS implementation
```

Phase 8 后不能继续依赖旧 Python 可执行实现。

处理：

```text
Python reference output
→ immutable golden fixture
→ TS contract/golden test
```

保留基线数据，不保留旧 Runtime。

## C. DB bridge persistence test

迁移到：

```text
database/tests/
```

继续验证：

- protocol；
- malformed JSON；
- unknown op；
- cache persistence；
- database manifest persistence；
- atomic write；
- corrupt state；
- path traversal；
- restart；
- concurrent/transaction behavior；
- EOF shutdown。

---

# 11. P8-05：建立最终最小 Python 工程

当前：

```text
backend/pyproject.toml
```

仍声明：

```text
beautifulsoup4
fastapi
httpx
openai-agents
pdfplumber
playwright
pydantic
python-multipart
pyyaml
uvicorn
matplotlib
scipy
seaborn
websockets
...
```

Phase 8 后全部不得继续作为 Python runtime dependencies 存在。

建议根目录改成：

```text
pyproject.toml
uv.lock
database/
```

Python 项目只服务 database bridge。

优先让 bridge 使用 Python stdlib：

```text
argparse
json
sqlite3
pathlib
dataclasses
tempfile
```

若确有不可替代的第三方依赖，必须在 Phase 8 报告中逐项说明原因。

不得为了复用旧 `DatabaseStore` 保留：

```text
openai-agents
FastAPI
pydantic business models
```

---

# 12. P8-06：清理根脚本、环境变量和 CI

## 12.1 根 `package.json`

删除：

```text
dev:legacy-backend
dev:host-proxy-only
dev:legacy-rollback
```

最终日常命令统一为：

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

当前若根目录尚无 `start`，Phase 8 补齐：

```text
pnpm start
→ @biomed/server production Host
```

---

## 12.2 `.env.example`

删除 migration-only 配置：

```text
APP_HOST
AGENT_RUNTIME
DATASET_CORE
PI_EXPERIMENTAL
LEGACY_BACKEND_PORT
LEGACY_BACKEND_URL
LEGACY_READINESS_TIMEOUT_MS
PI_DATASET_BRIDGE_SECRET
```

保留真实产品配置。

---

## 12.3 CI

删除：

```text
Python backend gates
cd backend
uv sync
uv run pytest
uv run ruff check app/ tests/ launcher.py
```

替换为最小 database gate，例如：

```bash
uv sync --frozen
uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database
```

若 bridge 完全采用 stdlib，`pytest/ruff` 只进入 dev dependency。

建议数据库 bridge 至少在：

```text
Ubuntu
Windows
```

各跑一次 self-test，因为该进程属于最终产品边界。

Node workspace gate继续保留：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

现有 Windows Dataset Core / lock gate继续保留。

---

## 12.4 Packaging

检查：

```text
.github/workflows/package.yml
release scripts
installer
ignore files
```

不得：

- 打包 `backend/`；
- 安装 FastAPI/Uvicorn；
- 安装 Python Playwright；
- 假设 `backend/.venv` 存在。

应只携带：

```text
frontend/dist
server/dist
.pi/skills
database/
必要静态资源
```

---

# 13. P8-07：清理迁移期测试和死代码

重点删除/调整：

```text
legacy backend bootstrap tests
legacy proxy tests
Python Core rollback vertical slice
experimental Pi surface tests
feature flag profile matrix tests
FastAPI compatibility tests
```

保留或强化：

```text
default TS Host bootstrap
Pi durable runtime
Task/Run/Event replay
cancel
HIL resume
TS Dataset Core
Publication
artifact security
database bridge
browser/security
workspace security
model/settings
frontend E2E
Windows build-lock
```

新增一个 Phase 8 architecture guard。

例如测试或脚本明确断言：

```text
active source tree 不存在 backend runtime dependency
server 不会 spawn FastAPI
database 不 import backend/app
legacy feature flags 不再被解析
```

这一 guard 以后应留在 CI，防止旧架构死灰复燃。

---

# 14. 文档清理规则

更新当前权威文档：

```text
README.md
AGENTS.md
docs/ARCHITECTURE.md
docs/TODO.md
docs/BioMed-QAgent_Pi_Migration_Plan.md
docs/DEVELOPER_QUICKSTART.md
docs/migration/README.md
.env.example
```

最终统一描述：

```text
Phase 0–8 completed
Default/only application host = TypeScript
Main Agent = Pi
Dataset Core = TypeScript
Python = database persistence bridge only
```

旧迁移文档、Phase 1/5/7 报告和 archive 可以保留历史描述。

但历史文档必须清楚标记：

```text
historical
completed
not current startup instructions
```

不要为了“搜索不到 FastAPI”篡改历史迁移证据。

---

# 15. 推荐 PR / Commit 顺序

不要一个提交完成全部删除。

## P8-A — `refactor/database-bridge-standalone`

完成：

```text
database persistence 自包含
删除 backendRoot
迁 database tests
DB bridge self-test
cache schema cleanup
```

此提交仍暂时保留 legacy backend，方便发现 bridge parity 问题。

验收后再进入下一步。

---

## P8-B — `refactor/remove-legacy-runtime-switches`

完成：

```text
删除 feature flags
删除 createLegacyBackend
删除 Python Core client
删除 experimental Pi runtime
简化 bootstrap/config
删除 rollback scripts
```

此时 legacy Python 代码已经没有调用者，但暂时还在仓库。

---

## P8-C — `chore/remove-python-backend`

完成：

```text
删除 backend/
删除 rollback tests
删除 legacy Python deps
建立 root minimal pyproject
更新 CI/package
```

这是实际物理退役提交。

---

## P8-D — `docs/phase8-final-closure`

只做：

```text
最终审计
文档状态
TODO 勾选
architecture snapshot
verification report
```

不得在这一提交偷偷塞入新的架构改动。

---

# 16. Agent 执行规则

执行 Agent 必须遵守：

1. 从最新 `main` 建工作分支，不以旧 Phase 5/7 文档中的 commit 作为代码基线。
2. 每个 checkpoint 开始前先检查当前代码；目录名与本文不一致时，以实际职责为准。
3. 不向用户询问本文已经确定的架构选择。
4. 测试失败时修复新 TS/DB 边界，不通过恢复 legacy Runtime 绕过。
5. 不降低已有测试断言来获得绿色 CI。
6. Python parity 实现删除前，先保存仍有价值的 golden output。
7. 不修改 DatasetBuild / Publication / EventEnvelope 稳定语义，除非发现现有代码本身违反已冻结 contract；此时单独记录 blocker。
8. 不删除用户持久数据。
9. 不把数据库 bridge 扩张成 HTTP 服务。
10. 不重新引入第二个公开端口。
11. 不新增新的 migration feature flag。
12. 每完成一个 checkpoint 都运行对应局部测试；P8-C、P8-D 必须运行全量最终门禁。

---

# 17. 最终验收

Phase 8 只有同时满足以下条件才可标记完成。

## 17.1 仓库结构

期望：

```text
BioMed-QAgent/
├── frontend/
├── server/
├── packages/
├── .pi/
├── database/
├── docs/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── pyproject.toml
└── uv.lock
```

不存在：

```text
backend/
```

---

## 17.2 Python 边界

Python 代码仅位于：

```text
database/
database/tests/   # 可选测试
```

数据库代码不得 import：

```text
FastAPI
OpenAI Agents SDK
Pi
legacy Skill runtime
Dataset Core
browser
scientific processing
```

---

## 17.3 Node Runtime

不得再存在正式可选组合：

```text
legacy agent
python dataset core
fastapi host
experimental phase1 pi
```

系统只有：

```text
TS Host
+
Pi Agent
+
TS Core
```

---

## 17.4 全量静态扫描

执行类似：

```bash
git ls-files backend

rg -n \
  "AGENT_RUNTIME|DATASET_CORE|APP_HOST|PI_EXPERIMENTAL|LEGACY_BACKEND|PI_DATASET_BRIDGE_SECRET|createLegacyBackend" \
  server frontend packages scripts .github package.json .env.example
```

预期：

```text
backend tracked files = 0
active runtime legacy references = 0
```

历史 docs/archive 中出现旧术语不计失败。

---

## 17.5 最终质量门禁

从 clean clone 执行：

```bash
pnpm install --frozen-lockfile
uv sync --frozen

pnpm test
pnpm lint
pnpm typecheck
pnpm build

uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database
```

若 `database/tests` 不使用 pytest，可相应调整，但必须存在自动化 bridge 测试。

---

## 17.6 启动 smoke

开发：

```bash
pnpm dev
```

必须证明：

```text
TS Host starts
Vite/HMR starts
Pi runtime available
TS Dataset Core available
DB bridge can be started on demand
no FastAPI process
no Uvicorn process
```

生产：

```bash
pnpm build
pnpm start
```

必须证明：

```text
server/dist/index.js
→ formal API
→ WS
→ frontend static assets
→ Pi
→ TS Core
→ DB bridge on demand
```

不需要运行：

```text
uvicorn
python backend/...
pnpm --filter frontend dev
第二个应用服务器
```

---

# 18. 必跑产品 E2E

至少覆盖：

```text
1. 新建 Task
2. Pi 多轮对话
3. Tool 调用
4. DatasetBuild SUCCESS
5. PARTIAL_SUCCESS
6. NO_DATA
7. SPEC_REJECTED / FAILED
8. cancel + terminal acknowledgement
9. restart / interrupted recovery
10. WS disconnect → replay → live
11. artifact list/download
12. settings/model
13. user declarative database CRUD
14. local cache
15. browser acquisition
16. HIL approval/resume
```

其中任一功能若只能通过恢复 `backend/` 才能通过，则 Phase 8 未完成。

---

# 19. Phase 8 Completion Report

最终新增：

```text
docs/migration/PHASE8_FINAL_VERIFICATION.md
```

必须记录：

```text
Baseline commit
Final commit

Removed Python directories
Removed TS legacy modules
Removed feature flags
Removed dependencies
Remaining Python files
Remaining Python dependencies

DB bridge protocol
DB bridge test result

pnpm test
pnpm lint
pnpm typecheck
pnpm build
database self-test
database tests
database lint

development startup smoke
production startup smoke
Windows bridge smoke
Windows Dataset Core/build-lock gate

E2E result matrix

rg legacy-reference audit
git ls-files backend result

Known non-blocking leftovers
```

不得只写：

```text
tests passed
```

必须给出具体命令与结果。

---

# 20. Definition of Done

只有全部勾选后，Phase 8 才能关闭：

- [ ] `database/bridge.py` 不再依赖 `backend/`
- [ ] Python database persistence 已迁至 `database/`
- [ ] DB bridge 不依赖 Agent/Skill/FastAPI
- [ ] active cache 不再硬编码旧 22 列 Pipeline Schema
- [ ] `server/src/config.ts` 不再提供 legacy runtime profile
- [ ] TS bootstrap 不再具备 FastAPI spawn/proxy 路径
- [ ] Python Dataset Core bridge 已删除
- [ ] experimental Phase 1 Pi runtime 已删除
- [ ] rollback-only root scripts 已删除
- [ ] legacy migration env vars 已删除
- [ ] `backend/` 已物理删除
- [ ] FastAPI 已从依赖移除
- [ ] Uvicorn 已从依赖移除
- [ ] `openai-agents` 已从依赖移除
- [ ] Python Playwright 已移除
- [ ] pdfplumber / matplotlib / SciPy / seaborn 已移除
- [ ] Python project 已缩成 database-only
- [ ] legacy Python tests 已删除或转成 golden fixtures
- [ ] DB bridge tests 已迁移并通过
- [ ] CI 不再同步或测试整个 Python backend
- [ ] packaging 不再包含 backend
- [ ] `pnpm test` 通过
- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] DB bridge self-test 通过
- [ ] DB bridge Python tests/lint 通过
- [ ] development startup smoke 通过
- [ ] production startup smoke 通过
- [ ] Windows bridge smoke 通过
- [ ] 全部核心 E2E 通过
- [ ] active source legacy-reference scan 为零
- [ ] `docs/TODO.md` Phase 8 标记完成
- [ ] `PHASE8_FINAL_VERIFICATION.md` 已提交

---

# 21. Phase 8 完成后的最终架构

```text
                         React Frontend
                              │
                              │ HTTP / WS
                              ▼
                 ┌──────────────────────────┐
                 │ TypeScript App Host      │
                 │                          │
                 │ Task / Run / Event       │
                 │ Product API              │
                 │ Settings                 │
                 │ Vite / Static            │
                 └────────────┬─────────────┘
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
         ┌─────────────────┐    ┌─────────────────────┐
         │ Pi Main Agent   │    │ TS Dataset Core     │
         │                 │    │                     │
         │ Skills          │───►│ Validate            │
         │ Tools           │    │ Execute             │
         │ Workspace       │    │ Publish             │
         └────────┬────────┘    └─────────────────────┘
                  │
                  │ named persistence operations
                  ▼
         ┌─────────────────────┐
         │ TS DatabaseClient   │
         └──────────┬──────────┘
                    │ JSONL stdin/stdout
                    ▼
         ┌─────────────────────┐
         │ database/bridge.py  │
         │                     │
         │ SQLite / local data │
         │ persistence only    │
         └─────────────────────┘
```

不存在：

```text
FastAPI
Uvicorn
OpenAI Agents SDK
Python Agent loop
Python Dataset Core
Python Skill Runtime
Python acquisition
Python processing
Python analysis
legacy profile
second application server
```

至此 Pi 大框架迁移才算真正完成。