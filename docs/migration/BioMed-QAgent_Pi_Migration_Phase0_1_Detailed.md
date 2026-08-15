# BioMed-QAgent → Pi Agent 大框架迁移执行计划

> 文档范围：详细展开现有迁移方案中的 **Phase 0 / Phase 1**  
> 基线仓库：`modenicheng/BioMed-QAgent` / `main`  
> 编写日期：2026-08-11  
> 上位原则：**删除自制 Agent Runtime，不删除 BioMed 确定性业务语义。**

---

## 1. 本文解决什么问题

现有 Pi 迁移方案已经确定最终方向，但 Phase 0、Phase 1 仍偏目标清单，尚不足以直接指导代码迁移。当前仓库并非简单的“FastAPI + Agent”项目：`backend/app/main.py` 的 lifespan 同时持有 TaskRepository、TaskManager、EventHub、AssistantStreamHub、SkillCatalog、模型配置、WorkflowRecipe、BrowserPool、Crawler、Subagent、Cache 等资源；`backend/app/pipeline/dataset_build_tool.py` 又已成为 V2 正式 DatasetBuild 的 Agent-facing 入口。若直接“接入 Pi，然后逐个删 Python 模块”，很容易同时改动 Agent loop、Task 生命周期、事件、Pipeline、前端协议和 Workspace 权限，形成一次不可回滚的 Big Bang rewrite。

因此 Phase 0 / 1 要承担的真正任务是：

```text
Phase 0
= 建立迁移地基
= 冻结现有正确语义 + 建立统一 Node Workspace + 划清新旧边界

Phase 1
= 建立第一条 Pi 垂直切片
= UI/TS Host → Pi → Workspace/Tool → 旧 Python V2 Dataset Core → 事件/UI
```

Phase 1 完成后，Pi 必须已经证明可以替换“Agent 层”；但 Python Dataset Core、旧 Task Runtime、完整 Skill 迁移、模型设置迁移、生产级持久事件仍不能在此阶段一并重写。

---

## 2. Phase 0 / 1 的硬边界

### 2.1 Phase 0 / 1 必须提前落实的架构约束

1. 仓库根目录成为唯一 pnpm Workspace 根。
2. 最终只保留一个 `pnpm-lock.yaml`。
3. `frontend/`、`server/`、`packages/` 属于同一 Node 环境。
4. 开发者最终只执行 `pnpm dev`，浏览器只访问一个应用端口。
5. 开发期 Vite 以 middleware 方式嵌入 TS Host，而不是继续作为独立用户入口。
6. `frontend/` 与 `server/` 仍保持代码职责分离。
7. 前后端共享 wire contract 放入 `packages/contracts/`。
8. Pi 依赖只能经过 `server/agent/pi-adapter.ts` 或等价 adapter，不允许业务代码大面积直接引用 Pi 内部类型。
9. `Pi Session != BioMed Task != Run != DatasetBuild`。
10. Phase 1 中 Dataset Core 仍为 Python V2 实现，正式 publication 仍只能经现有 Validation / Publisher 路径产生。
11. Pipeline 继续作为受信任 Tool/Core，不改成纯 Skill。
12. Phase 1 不迁现有 SubagentSupervisor，不建立新的多 Agent 编排框架。

### 2.2 Phase 0 / 1 明确不做

以下工作推迟到后续阶段：

- 不迁完整 `.pi/skills` 业务 Skill 集；Phase 1 只放一个 smoke-test Skill 和最小 dataset-construction 指令。
- 不迁 Python Dataset Deterministic Core 到 TypeScript。
- 不迁浏览器、Crawler、GEO/GDC/Xena、PDF、统计计算到 Node。
- 不迁 Provider/Model Registry 和 Settings API。
- 不把现有 durable Task/Event Store 重写到 TS。
- 不保证旧历史 Task 已由 TS Runtime 原生加载；Phase 3 再处理。
- 不删除 `backend/app/agent_loop/`、`runtime/`、`skills/`、`subagents/`。
- 不在 Phase 1 暴露无限制 production shell。
- 不改前端 ResultsViewer 的 DatasetPublication 语义。

---

## 3. 当前仓库状态与迁移含义

### 3.1 当前前后端仍是两个独立运行入口

当前 `frontend/package.json` 自己持有 pnpm 版本、Vite/React/TypeScript scripts；`frontend/` 目录还有自己的 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`，仓库根目录没有 `package.json`。当前 `vite.config.ts` 固定监听 5173，并将 `/api`、`/api/v1/ws` 代理到默认 `127.0.0.1:8000`。

这意味着“单 Workspace + 单 Host”不能只增加一个 `concurrently`。Phase 0 必须先搬 Workspace 根，Phase 1 再让 TS Host 真正接管浏览器入口。

### 3.2 当前 FastAPI lifespan 是一个大型 Composition Root

`backend/app/main.py` 当前启动并持有：

```text
TaskIndex
TaskRepository
TaskManager
EventHub
AssistantStreamHub
SkillCatalog / UserSkillStore
ModelSettingsStore / ProviderModelStore
WorkflowRecipeStore / RecipeExecutor
BrowserPool / CrawlerFacade
SubagentSupervisor / InputBroker / EventSink
CacheStore
```

因此 Phase 1 不应“翻译 `main.py`”。正确方法是新建 TS Composition Root，只接管 Phase 1 真正新增职责；旧 FastAPI 暂时继续持有旧系统资源。

### 3.3 V2 DatasetBuild 已经形成可靠边界

当前 `backend/app/pipeline/dataset_build_tool.py` 明确将 `execute_dataset_build` 定义为 V1 退役后的正式产物入口，并继续执行：

```text
parse
→ canonicalize
→ compatibility
→ integrate
→ validation profile
→ publish
```

同时已有 `validate_dataset_build_spec`、Schema Registry、SourceAsset、BuildResult、Publication supersedes 等语义。

因此 Phase 1 的临时桥必须对接 **V2 DatasetBuild service**，而不是重新调用 V1 PipelineRunner，也不能让 Pi 自己通过 shell 拼正式 CSV。

### 3.4 当前 Workspace 工具已经存在安全语义

`backend/app/tools/io.py` 当前已经规定：

- read/list 可访问 Task workspace；
- write 只能进入 `staging/agent/`；
- 拒绝 absolute path；
- 拒绝 `..` escape；
- 拒绝 symlink 指向 workspace 外。

Pi 引入通用 `read/write/edit/exec` 后，功能可以更通用，但这些安全不变量不能丢。尤其 `artifacts/`、publication state 仍不能由 Agent 修改。

### 3.5 当前 EventEnvelope 已经是前端稳定接口

前端 `frontend/src/runtime/contracts.ts` 已包含：

```text
EventEnvelope
sequence
assistant_delta
assistant_reasoning_delta
tool_started
tool_called
tool_completed
operation_started/progress/completed/failed
publication_created
run_* / task_*
```

WebSocket 仍使用：

```text
subscribe(task_id, after_sequence)
unsubscribe(task_id)
ping
```

Phase 1 可以复用这套“事件语义”，但不应提前重写 durable replay。Phase 1 的 Pi 实验链路只验证映射正确；真正 durable Event Store 迁移留给 Phase 3。

---

# 4. Phase 0：冻结边界、建立迁移地基

## 4.1 Phase 0 目标

Phase 0 不追求“跑 Pi”，而是让后续每一次迁移都有明确输入、输出、边界和回滚点。

完成后应具备：

```text
root pnpm workspace
+ server skeleton
+ shared contract package
+ migration ADR
+ frozen contract fixtures
+ golden E2E baseline
+ Pi version pin
+ legacy bridge protocol
+ workspace security policy
+ feature flags
```

同时现有产品行为不得变化。

---

## 4.2 Phase 0.0：冻结迁移基线

### 工作

在开始结构迁移前记录：

- `main` 对应 commit SHA；
- Python 版本与 `backend/uv.lock`；
- pnpm 版本；
- Node 版本；
- `frontend/pnpm-lock.yaml` digest；
- 当前前端构建结果；
- 当前 Python 非 live 测试结果；
- 当前前端 Vitest / TypeScript / ESLint 结果；
- 四类 DatasetBuild golden outcome；
- 当前主要 API 与 WS contract snapshot。

建议新增：

```text
docs/migration/baseline-2026-08-11.md
tests/migration/baseline/
```

`baseline-2026-08-11.md` 至少记录：

```text
repo_commit
python_version
uv_lock_sha256
node_version
pnpm_version
frontend_lock_sha256
pi_package/version/commit
legacy_test_commands
known_failures
```

### Golden fixture

最低保存：

```text
SUCCESS
PARTIAL_SUCCESS
NO_DATA
SPEC_REJECTED
```

每个 fixture 保存：

```text
request/spec
source fixture references
BuildResult
ValidationResult
DatasetManifest
DatasetPublication（若存在）
artifact hashes
stable EventEnvelope sample
```

比较时忽略：

```text
timestamp
random UUID
日志自然语言
LLM 自然语言输出
```

### 验收

- 基线可在另一台开发机复现；
- 四种 outcome 都有 fixture；
- 如果当前测试存在已知失败，必须登记，而不是为了 Phase 0 临时修改断言。

---

## 4.3 Phase 0.1：将 Node Workspace 根迁到仓库根目录

### 当前问题

当前 Node 工程根位于 `frontend/`，不利于新增 `server/` 与共享 package。

### 目标结构

```text
BioMed-QAgent/
├── frontend/
├── server/
├── packages/
│   └── contracts/
├── .pi/
├── backend/                 # Phase 0/1 仍保留
├── database/                # 后续 DB bridge 目标目录，可先不迁数据
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
└── ...
```

### 具体动作

#### A. 新建根 `package.json`

只放 Workspace 级脚本和统一工具链约束，不把前端依赖全部提升到根。

Phase 0 建议先提供：

```text
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Phase 0 暂不强行将 `pnpm dev` 切到新 Host；Phase 1 完成 TS Host bootstrap 后再将 `pnpm dev` 设为正式唯一开发入口。

#### B. 新建根 `pnpm-workspace.yaml`

```yaml
packages:
  - frontend
  - server
  - packages/*
```

#### C. 将 lockfile 移到根

不能保留：

```text
/root/pnpm-lock.yaml
/frontend/pnpm-lock.yaml
```

两份 lockfile 长期并存。

迁移完成后删除：

```text
frontend/pnpm-lock.yaml
frontend/pnpm-workspace.yaml
```

#### D. 新建 `server/package.json`

Phase 0 仅创建最小包，不接管现有 API：

```text
@biomed/server
```

#### E. 新建 `packages/contracts/package.json`

```text
@biomed/contracts
```

#### F. 统一 TypeScript 基础配置

新增：

```text
tsconfig.base.json
```

`frontend/`、`server/`、`packages/contracts/` 继承基础编译选项，各自保留 browser/node 差异。

#### G. Node/pnpm 版本固定在根

`packageManager` 只在根目录作为主约束。Node 版本也必须进入仓库中的明确版本文件或 engines 约束。

### 验收

```text
pnpm install --frozen-lockfile
pnpm --filter @biomed/frontend build
pnpm --filter @biomed/frontend test
pnpm --filter @biomed/frontend lint
pnpm --filter @biomed/frontend typecheck
```

结果与迁移前一致。

---

## 4.4 Phase 0.2：建立共享 Contract Package，但不改变 wire schema

### 原则

Phase 0 只改变“类型存放位置”，不改变 API 语义。

首批迁入 `packages/contracts/`：

```text
TaskMode
RunStatus
TaskSummary
RunRecord
TaskSnapshot
BuildResult
DatasetManifest
DatasetPublication
ArtifactRole
EventEnvelope
EventPayload
WebSocketCommand
assistant stream frames
```

推荐目录：

```text
packages/contracts/src/
├── task.ts
├── run.ts
├── event.ts
├── dataset-build.ts
├── artifact.ts
├── websocket.ts
└── index.ts
```

### 前端迁移

当前 `frontend/src/runtime/contracts.ts` 不应继续作为长期唯一 contract 定义。

Phase 0 可采用：

```text
packages/contracts = canonical TS wire DTO
frontend/src/runtime/contracts.ts = re-export + frontend-only view types
```

先避免大面积改 import path。

### Python 兼容

Phase 0 / 1 期间 Python Pydantic 仍是旧服务运行时实现，因此必须增加 contract parity test：

```text
Python JSON fixture
↔ @biomed/contracts validator/type fixture
```

至少冻结：

```text
EventEnvelope.schema_version
EventEnvelope.sequence
BuildResult.status
DatasetManifest.artifacts
DatasetPublication.supersedes_publication_id
Task/Run status enum
```

### 验收

- 前端行为无变化；
- TS server 可以直接引用 `@biomed/contracts`；
- 同一 fixture 在 Python 与 TS 两侧解释一致；
- Phase 0 不借此机会重命名事件或删 legacy 字段。

---

## 4.5 Phase 0.3：建立 ADR 集，冻结所有权边界

建议至少新增以下 ADR：

```text
docs/adr/
├── 00x-pi-agent-runtime.md
├── 00x-single-ts-application-host.md
├── 00x-session-task-run-build-boundary.md
├── 00x-dataset-core-remains-deterministic.md
├── 00x-pi-adapter-boundary.md
├── 00x-phase1-legacy-core-bridge.md
├── 00x-workspace-policy.md
└── 00x-contract-source-of-truth.md
```

### ADR 必须回答

#### Pi Runtime

```text
Pi 接管什么？
旧 Agent Runtime 哪些部分最终删除？
哪些行为必须保留？
```

#### State boundary

明确：

```text
Pi Session
= conversation/model/tool trace

Task
= 产品长期对象

Run
= 一次用户输入引发的执行

DatasetBuild
= 可恢复的确定性数据构建
```

任何一层都不能替代其他层。

#### Single Host

最终：

```text
browser
  ↓ one public port
TS Host
  ├ API
  ├ WS
  ├ Pi
  ├ Vite middleware / static frontend
  └ Dataset Core
```

Phase 1 的过渡期允许旧 FastAPI 存在，但只能作为 loopback-only legacy implementation，不再作为浏览器直接访问的正式入口。

#### Dataset Core

明确：

```text
Skill = instructions
Tool = trusted callable boundary
Core = deterministic implementation
```

禁止将 Validation / Publication 降级成提示词约束。

---

## 4.6 Phase 0.4：现有 Runtime 生命周期清点

必须针对 `backend/app/main.py` 做资源所有权矩阵，而不是只看目录名。

建议新增：

```text
docs/migration/runtime-ownership-matrix.md
```

格式：

| 当前资源 | 当前 Owner | Phase 1 Owner | 后续目标 | Phase 1 动作 |
| --- | --- | --- | --- | --- |
| Agent loop | Python `ModeDispatchRunExecutor` | Pi experimental session | Pi | 并行引入，不删除旧实现 |
| TaskManager | FastAPI lifespan | legacy | TS Runtime | 不迁 |
| TaskRepository | FastAPI lifespan | legacy | TS persistence | 不迁 |
| EventHub | FastAPI lifespan | legacy | TS event projection | 不迁 durable 部分 |
| SkillCatalog | FastAPI lifespan | legacy | Pi Skills | 不迁完整系统 |
| Dataset Core | Python V2 | Python V2 | TS Core | 只建桥 |
| Browser/Crawler | Python lifespan | legacy | Node | 不迁 |
| WorkflowRecipe | Python lifespan | legacy | TS acquisition | 不迁 |
| Subagent | Python lifespan | legacy | optional Pi child session | 不迁 |
| Model registry | Python | legacy | Pi/TS settings | 不迁 |
| Frontend dev server | Vite | TS Host middleware | TS Host | Phase 1 接管 |

### 验收

任意一个 Phase 1 PR 都能回答：

> “这个资源现在由谁创建、谁关闭、失败时谁回收？”

如果回答不出来，该资源不得迁移。

---

## 4.7 Phase 0.5：冻结 Agent Tool/Prompt 迁移清单

当前 Main Agent 同时使用：

```text
find_skill / invoke_skill
validate_dataset_build_spec
execute_dataset_build
request_human_correction
read_file / read_file_head / search_file / write_file / list_files
review_query_strategy / compress_query_log
subagent tools
```

Phase 0 必须给每项标状态：

```text
Phase 1 native Pi
Phase 1 legacy bridge
Phase 2 migrate
later/optional
remove
```

建议 Phase 1 只覆盖：

```text
read
write
edit
exec (development only)
validate_dataset_build_spec (legacy bridge)
execute_dataset_build (legacy bridge)
```

一个最小测试 Skill 只负责验证 Pi Skill discovery/load，不迁 `find_skill/invoke_skill` 整套自制网关。

当前长 system prompt 也不要整体复制。Phase 1 最小 prompt 只保留硬约束：

1. 正式 artifact 只能来自 Dataset Core；
2. Agent 只写 staging；
3. spec 先 validate 再 execute；
4. 不得把无数据包装成成功；
5. 使用 Workspace 工具处理临时文件。

完整科研策略、数据源 SOP、GEO vetting 等进入 Phase 2 Skills 迁移。

---

## 4.8 Phase 0.6：定义 Phase 1 Legacy Dataset Core Bridge

### 为什么要单独设计桥

当前 `dataset_build_tool.py` 同时混合：

```text
OpenAI Agents SDK wrapper
RunContext
DatasetBuild service logic
SourceAsset preparation
V2 Core invocation
```

Pi 不应该继续依赖 OpenAI Agents SDK 的 `RunContextWrapper`。

### Phase 0 决策

在 Python 内先抽一层 **Agent-SDK-independent service boundary**：

```text
legacy agent FunctionTool wrapper
             │
             ▼
Python DatasetBuild Service
             ▲
             │
Pi migration bridge
```

目标形态：

```text
backend/app/datasets/service.py          # 或等价位置
backend/app/pipeline/dataset_build_tool.py
backend/app/compat/pi_dataset_bridge.py
```

`dataset_build_tool.py` 继续保留旧 Agent decorator，只变成薄 wrapper。

### Bridge 只允许命名操作

```text
validate_dataset_build_spec
execute_dataset_build
get_build_result
```

禁止：

```text
arbitrary_python
arbitrary_sql
arbitrary_path_write
```

### 协议

建议统一 request envelope：

```json
{
  "version": 1,
  "request_id": "...",
  "task_id": "...",
  "run_id": "...",
  "op": "validate_dataset_build_spec",
  "args": {}
}
```

response：

```json
{
  "version": 1,
  "request_id": "...",
  "ok": true,
  "data": {},
  "error": null
}
```

### Transport

Phase 1 推荐优先复用仍在运行的 legacy FastAPI 进程，以 loopback-only migration endpoint 暴露该 service，例如：

```text
/internal/migration/pi/dataset/validate
/internal/migration/pi/dataset/execute
```

TS Host **不向浏览器代理 `/internal/migration/*`**。这样旧 lifespan 中已有的 Task workspace、Recipe、Browser、Cache 等资源仍能复用，避免为了 PoC 再搭一套 Python runtime。

若实现时确认 Core Service 可完全脱离 FastAPI lifespan，再改为 JSONL subprocess；二者对 TS 侧都必须隐藏在：

```text
server/legacy/dataset-core-client.ts
```

### 验收

- Pi 侧完全不知道 `agents.RunContextWrapper`；
- 同一 spec 通过 legacy FunctionTool 和 bridge 得到一致 validate 结果；
- build publication 仍由 V2 Core 产生；
- Agent 无法通过 bridge 写 `artifacts/`。

---

## 4.9 Phase 0.7：定义 Workspace Policy

### Task workspace

```text
task/<task_id>/
├── source_assets/
├── parsed/
├── normalized/
├── staging/
│   └── agent/
├── artifacts/
├── state/
└── logs/
```

### Phase 1 权限矩阵

| 目录 | read | write/edit | exec 产生文件 |
| --- | ---: | ---: | ---: |
| `source_assets/` | yes | no | no |
| `parsed/` | yes | no | no |
| `normalized/` | yes | no | no |
| `staging/agent/` | yes | yes | yes |
| `artifacts/` | yes | **no** | **no** |
| `state/` | limited read | **no** | **no** |
| `logs/` | read | host only | host only |

Phase 1 的 `write/edit/exec` 即使比旧 `io.py` 更通用，也必须保持 publication 边界。

### exec 两种模式

#### Development

```text
cwd = task workspace
allow generic command execution
```

仍需要：

- timeout；
- stdout/stderr size limit；
- cancellation；
- child process cleanup；
- command audit；
- workspace path check。

#### Product

Phase 1 只实现 `workspace_exec` policy prototype，不正式开放无限 shell。

### 必测安全案例

```text
../ escape
absolute path
Windows drive path
UNC/path edge case
symlink escape
write artifacts
write state
command timeout
stdout flood
spawn child then cancel
background process leak
```

Linux 与 Windows 都要跑。

---

## 4.10 Phase 0.8：定义 Pi Event Adapter Contract

Pi 原生事件不能直接传前端。

增加：

```text
Pi Event
  ↓
server/agent/event-adapter.ts
  ↓
BioMed-compatible event
  ↓
experimental WS
```

Phase 1 最低映射：

```text
assistant text delta
assistant reasoning delta（若 Pi 暴露）
tool start
tool arguments/tool call
tool completion
tool error
run/session start
run/session cancel
run/session failure
```

映射目标优先复用现有：

```text
assistant_delta
assistant_reasoning_delta
tool_started
tool_called
tool_completed
run_started
run_cancel_requested
run_cancelled
run_failed
```

### 重要限制

Phase 1 只验证 event shape 和 UI 兼容，不在此阶段实现完整 durable sequence/replay。

因此：

```text
Phase 1 experimental WS event
≠ 新的权威 durable event store
```

真正 `after_sequence → replay → realtime` 迁移留给 Phase 3。

---

## 4.11 Phase 0.9：确定过渡期单入口拓扑

为了不违背“一个应用端口”的新架构约束，同时避免 Phase 1 一次性重写 FastAPI，建议从 Phase 1 开始采用：

```text
Browser
  │
  │ one public port
  ▼
TS Application Host
  ├── /experimental/pi/*  → Pi runtime
  ├── /api/v1/*           → legacy FastAPI proxy
  ├── /api/v1/ws          → legacy WS proxy
  └── /*                   → Vite middleware
                               │
                               └ React HMR

legacy FastAPI
= loopback-only private port
= 过渡实现
= 不再直接提供浏览器入口
```

这一步不是“最终把 FastAPI 留在后面做代理”，而是 strangler migration 的第一层外壳。

### 生命周期

`pnpm dev`：

```text
TS Host start
  ↓
start/attach legacy backend on private loopback port
  ↓
start Pi runtime
  ↓
create Vite middleware
  ↓
listen public app port
```

退出：

```text
stop accepting new work
→ cancel experimental Pi sessions
→ close Vite
→ terminate managed legacy backend
→ exit
```

Phase 1 只要求开发模式实现这个模型；生产正式切换仍在 Phase 7。

---

## 4.12 Phase 0.10：固定 feature flags 与回滚面

建议统一：

```text
AGENT_RUNTIME=legacy|pi
DATASET_CORE=python|ts
APP_HOST=fastapi|ts
PI_EXPERIMENTAL=0|1
```

Phase 1 的正常组合：

```text
APP_HOST=ts
PI_EXPERIMENTAL=1
DATASET_CORE=python
```

旧产品路径：

```text
/api/v1/*
→ legacy FastAPI
→ legacy Agent
→ Python V2 Core
```

Pi 实验路径：

```text
/experimental/pi/*
→ Pi Agent
→ Python V2 Core bridge
```

两条链可同时存在，便于 A/B 与回滚。

---

## 4.13 Phase 0 PR 拆分

不建议把 Phase 0 做成一个超大 PR。

### PR 0A — `chore/workspace-root`

- 根 `package.json`；
- 根 `pnpm-workspace.yaml`；
- lockfile 迁根；
- `tsconfig.base.json`；
- `server/` skeleton；
- `packages/contracts/` skeleton；
- 原前端 build/test 不变。

### PR 0B — `refactor/shared-wire-contracts`

- 抽取 TS wire contracts；
- frontend re-export；
- contract fixture tests；
- 不改 API payload。

### PR 0C — `docs/pi-migration-boundaries`

- ADR；
- runtime ownership matrix；
- tool migration matrix；
- workspace policy；
- bridge protocol；
- event mapping表。

### PR 0D — `test/migration-golden-baseline`

- 四类 outcome fixture；
- artifact digest snapshot；
- contract snapshot；
- baseline capture script。

### PR 0E — `refactor/python-dataset-service-boundary`

- 将 DatasetBuild domain service 从 OpenAI Agent decorator 中抽出；
- legacy FunctionTool 行为保持一致；
- 为 Phase 1 bridge 留稳定入口。

---

## 4.14 Phase 0 Definition of Done

The checked items below are backed by the committed Phase 0/1 implementation and
Task 5–11 focused/golden/E2E evidence. Phase 1G's current-machine full rerun remains
separately recorded as infrastructure-blocked where Node/Python runtimes are absent.

只有全部满足才进入 Phase 1：

- [x] 根目录是唯一 pnpm Workspace 根。
- [x] 仓库只有一个 `pnpm-lock.yaml`。
- [x] `frontend`、`server`、`packages/contracts` 能由根 pnpm 识别。
- [x] 前端 build/test/lint/typecheck 不退化。
- [x] Python baseline 已记录。
- [x] SUCCESS / PARTIAL_SUCCESS / NO_DATA / SPEC_REJECTED fixture 完整。
- [x] DatasetBuild/Publication/Validation/EventEnvelope 不变量写入 ADR。
- [x] Pi package/version/commit 固定。
- [x] `server/agent/pi-adapter.ts` 边界写入 ADR。
- [x] Workspace 权限矩阵确定。
- [x] Phase 1 bridge protocol 确定。
- [x] Python DatasetBuild service 不再只能通过 OpenAI `FunctionTool` 才可调用。
- [x] feature flag 与回滚组合有自动测试或 smoke test。

---

# 5. Phase 1：引入 Pi Main Agent，跑通第一条垂直切片

## 5.1 Phase 1 目标

Phase 1 要证明：

> 不迁 Dataset Core、不迁完整 Runtime 的前提下，Pi 已能作为 Main Agent，拥有可用 Workspace，并能通过受信任 Tool 调现有 V2 DatasetBuild，前端能看到 Agent 与 Tool 流。

Phase 1 成功链：

```text
React
  ↓
TS Host
  ↓
Pi Session
  ├ read
  ├ write
  ├ edit
  ├ exec (dev)
  └ validate/execute DatasetBuild Tool
           ↓
    Legacy Dataset Core Client
           ↓
    Python V2 Dataset Core
           ↓
    Validation / Publication

Pi events
  ↓
Event Adapter
  ↓
experimental WS
  ↓
React
```

---

## 5.2 Phase 1.0：实现 TS Application Host shell

建议目录：

```text
server/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── app/
    │   ├── create-app.ts
    │   └── lifecycle.ts
    ├── dev/
    │   └── vite-middleware.ts
    ├── legacy/
    │   ├── backend-process.ts
    │   └── proxy.ts
    └── experimental/
        └── ...
```

### 责任

TS Host 首批只负责：

- 创建 HTTP server；
- 管理应用生命周期；
- 内嵌 Vite middleware；
- 代理旧 `/api/v1/*` 和 `/api/v1/ws`；
- 暴露 `/experimental/pi/*`；
- 关闭时回收子进程和 Pi session。

### 不负责

- 不实现新的 TaskRepository；
- 不实现新的 durable Event Store；
- 不实现 Dataset Core；
- 不实现模型设置数据库；
- 不实现 Skill Store。

### 验收

执行：

```text
pnpm dev
```

后：

- 浏览器只访问一个端口；
- React HMR 正常；
- 旧 `/api/v1/*` 功能仍正常；
- 旧 WS 仍正常；
- 开发者不需要手动分别启动 Vite 和 FastAPI。

---

## 5.3 Phase 1.1：Pi Integration Adapter

### 核心规则

Pi API 只允许在 adapter 目录出现：

```text
server/src/agent/pi-adapter.ts
```

业务层只能依赖项目自己的接口。

建议接口：

```ts
interface BioMedAgentSession {
  id: string;
  run(input: string, options?: RunOptions): AsyncIterable<BioMedAgentEvent>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

interface PiAgentAdapter {
  createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession>;
}
```

### Adapter 负责

- Pi AgentSession 构造；
- model/provider 注入；
- resource loader / Skill root；
- Tool registration；
- workspace cwd；
- Pi event normalization；
- cancel/dispose；
- Pi 上游异常转成项目错误。

### Adapter 不负责

- Task persistence；
- Build persistence；
- Publication；
- Event sequence durable storage；
- UI state。

### Session Registry

Phase 1 可用内存 registry：

```text
run_id → BioMedAgentSession
```

但必须明确：

```text
SessionRegistry ≠ TaskRepository
```

进程重启后实验 session 丢失可以接受；durable session mapping 以后再做。

### 验收

- 项目其他文件不直接 import Pi 内部包；
- fake adapter 可替换真实 Pi 做单元测试；
- cancel 可终止当前 Pi run；
- dispose 不遗留 process/listener。

---

## 5.4 Phase 1.2：建立 Pi Task Workspace

建议目录：

```text
server/src/agent/workspace/
├── create-workspace.ts
├── path-policy.ts
├── read.ts
├── write.ts
├── edit.ts
├── exec.ts
└── audit.ts
```

### Workspace ID

实验 Task 仍使用 BioMed 风格 ID：

```text
task_id
run_id
```

同时另外保存：

```text
pi_session_id
```

不要把 `pi_session_id` 当 `task_id`。

### read

支持：

- UTF-8/text；
- bounded read；
- 大文件片段/offset；
- task-relative path。

### write

只能写：

```text
staging/agent/
```

### edit

只允许在 Agent 可写区局部替换，不允许通过 edit 修改正式 artifact。

### exec

开发模式允许：

```text
cwd = task workspace
```

输出结构化：

```text
command
exit_code
stdout
stderr
duration
truncated
```

### 迁移原则

Phase 1 不删除原 `tools/io.py`、`tools/sandbox.py`。两套能力暂时并存：

```text
legacy Agent → old io.py / sandbox.py
Pi Agent     → new TS workspace primitives
```

待 Pi 默认路径稳定后再清理旧实现。

---

## 5.5 Phase 1.3：实现 Experimental Pi API

原迁移方案只写了：

```text
POST /experimental/pi/tasks
WS   /experimental/pi/ws
```

建议扩成一个仍然很小、但足够验证多轮和取消的实验协议。

### 创建实验 Task

```text
POST /experimental/pi/tasks
```

输入：

```json
{
  "input": "...",
  "fixture_profile": null
}
```

返回：

```json
{
  "task_id": "task_...",
  "run_id": "run_...",
  "session_id": "pi_...",
  "status": "running"
}
```

### 继续一轮

```text
POST /experimental/pi/tasks/{task_id}/runs
```

只用于验证 Pi session 多轮能力，不承诺与正式 `/api/v1/tasks/{id}/runs` 完全同构。

### 取消

```text
POST /experimental/pi/tasks/{task_id}/runs/{run_id}/cancel
```

Phase 1 要验证当前 Pi session 与 workspace command 都能取消。

### WebSocket

```text
WS /experimental/pi/ws
```

使用 BioMed-compatible event payload，但标记为 experimental，不写入正式 durable Event Store。

### 原则

```text
/experimental/*
= 迁移验证面
≠ 新正式 API
```

Phase 3 才决定如何把 Pi 接入正式 `/api/v1/tasks`。

---

## 5.6 Phase 1.4：实现 Pi Event Adapter

建议目录：

```text
server/src/agent/event-adapter.ts
server/src/experimental/event-bus.ts
```

### 映射

至少覆盖：

```text
Pi assistant text stream
  → assistant_delta

Pi reasoning stream
  → assistant_reasoning_delta

Pi tool start
  → tool_started

Pi tool invocation metadata
  → tool_called

Pi tool result
  → tool_completed

Pi run cancel
  → run_cancel_requested / run_cancelled

Pi run failure
  → run_failed
```

### Tool result

`tool_completed` 不能只返回自然语言；bridge 类 Tool 还应在 server log 保留：

```text
tool_call_id
tool_name
request_id
build_id
exit/error code
duration
```

### sequence

实验 event 可生成本 session 内单调递增 sequence，方便复用前端 reducer；但必须在代码和文档标明：

```text
experimental sequence
= live stream ordering
≠ durable replay authority
```

### 测试

使用 fake Pi event stream 固定输入，snapshot 比较 BioMed event shape。

---

## 5.7 Phase 1.5：注册最小 Pi Skills 与系统提示

Phase 1 不迁现有完整 Skill Catalog。

建议：

```text
.pi/
├── skills/
│   ├── migration-smoke/
│   │   └── SKILL.md
│   └── dataset-construction/
│       └── SKILL.md        # 只保留最小执行协议
└── prompts/
    └── phase1-system.md
```

### `migration-smoke`

只验证：

- Skill 能被发现；
- Skill 能加载；
- Agent 能根据说明调用一个简单工具；
- Skill 缺失时 Agent/Host 不崩溃。

### `dataset-construction`

Phase 1 只写：

```text
1. 准备 DatasetBuildSpec
2. 必须先 validate
3. 修复结构化错误
4. 再 execute
5. 只有 Publication 成功才有正式 artifact
6. 不得直接修改 artifacts/
```

GEO/GDC/Xena 详细科研 SOP 暂不迁，留给 Phase 2。

---

## 5.8 Phase 1.6：建立 Pi → Legacy V2 DatasetBuild Tool

建议 TS 目录：

```text
server/src/agent/tools/
├── dataset-build.ts
└── workspace.ts

server/src/legacy/
└── dataset-core-client.ts
```

### Tool 1：`validate_dataset_build`

输入直接使用冻结 `DatasetBuildSpec` wire contract。

调用：

```text
Pi Extension Tool
→ dataset-core-client
→ Python DatasetBuild Service
→ SpecValidator
```

返回：

```text
valid
reason_codes
reasons
```

### Tool 2：`execute_dataset_build`

调用：

```text
Pi Extension Tool
→ dataset-core-client
→ Python DatasetBuild Service
→ DatasetBuildExecutor
→ Validation
→ Publication
```

### Phase 1 数据范围

为了证明边界而不是顺便迁 acquisition，验收优先使用已存在的本地 fixture/source file：

```text
source file already in task workspace
→ SourceAsset wrapping
→ V2 build
```

不要求 Phase 1 通过 Pi 迁完整 GEO/GDC/Xena 下载工具。

### 正式产物保护

Pi Tool 只能得到 Core 返回的：

```text
BuildResult
publication_id
manifest/artifact references
```

Pi 不能拿一个绝对 artifacts 路径再自行覆盖。

### Error taxonomy

bridge 至少区分：

```text
invalid_input
spec_rejected
no_data
partial_success
core_execution_error
bridge_unavailable
cancelled
```

不要所有异常统一成 500 + string。

### cancel

Phase 1 必须至少打通：

```text
user cancel
→ Pi session abort
→ active Tool abort signal
→ legacy bridge cancel/request cancellation
```

如果某个 Python operation 暂时不能立即响应 cancel，必须在测试/文档登记，不得假装已完成取消。

---

## 5.9 Phase 1.7：建立第一条可演示垂直切片

建议固定 smoke scenario，不依赖 live network。

### Scenario

```text
用户输入
→ Pi 理解任务
→ read source fixture
→ 必要时 write/edit staging note/script
→ exec 一个受控检查命令
→ 构造 DatasetBuildSpec
→ validate_dataset_build
→ execute_dataset_build
→ Python V2 Core publication
→ Pi 收到 BuildResult
→ 最终回复引用真实 publication/artifact
```

### UI 必须看见

```text
assistant text delta
tool started
tool completed
DatasetBuild result
publication/artifact reference
final assistant response
```

### UI 暂不要求

- durable reconnect replay；
- 历史 Task 恢复；
- 正式 settings/model management；
- subagent visualization。

---

## 5.10 Phase 1.8：将 `pnpm dev` 切成唯一开发入口

当 TS Host + Pi experimental path 稳定后，再正式修改 root script：

```text
pnpm dev
→ @biomed/server dev
```

Server 负责：

```text
Vite middleware
Pi runtime
experimental API/WS
legacy FastAPI lifecycle/proxy
```

此时开发者不再执行：

```text
cd frontend && pnpm dev
cd backend && uv run uvicorn ...
```

可保留临时诊断命令：

```text
pnpm dev:legacy-backend
pnpm dev:frontend-standalone
```

但明确标记 migration/debug only，不写进正常开发说明。

---

## 5.11 Phase 1.9：更新 AGENTS/开发文档

根 `AGENTS.md` 与 README 至少更新：

```text
pnpm install
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

同时写清：

- Python 仍存在只是迁移期 legacy runtime；
- 不能在新 TS 代码增加对 `backend/app/agent_loop` 的新依赖；
- 不能绕过 `server/agent/pi-adapter.ts` 直接使用 Pi；
- 不能在 Phase 1 新建另一套 TaskManager；
- 不能用 Pi shell 直接写 publication；
- 新 wire contract 必须先进入 `packages/contracts`。

---

# 6. Phase 1 推荐目录落点

Phase 1 结束时建议达到：

```text
BioMed-QAgent/
├── frontend/
│   └── ...
│
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── app/
│       │   ├── create-app.ts
│       │   └── lifecycle.ts
│       ├── agent/
│       │   ├── pi-adapter.ts
│       │   ├── create-session.ts
│       │   ├── session-registry.ts
│       │   ├── event-adapter.ts
│       │   ├── system-prompt.ts
│       │   ├── workspace/
│       │   │   ├── path-policy.ts
│       │   │   ├── read.ts
│       │   │   ├── write.ts
│       │   │   ├── edit.ts
│       │   │   ├── exec.ts
│       │   │   └── audit.ts
│       │   └── tools/
│       │       └── dataset-build.ts
│       ├── experimental/
│       │   ├── routes.ts
│       │   ├── websocket.ts
│       │   └── event-bus.ts
│       ├── legacy/
│       │   ├── backend-process.ts
│       │   ├── proxy.ts
│       │   └── dataset-core-client.ts
│       └── dev/
│           └── vite-middleware.ts
│
├── packages/
│   └── contracts/
│       ├── package.json
│       └── src/
│           ├── task.ts
│           ├── run.ts
│           ├── event.ts
│           ├── websocket.ts
│           ├── dataset-build.ts
│           ├── artifact.ts
│           └── index.ts
│
├── .pi/
│   ├── skills/
│   │   ├── migration-smoke/
│   │   └── dataset-construction/
│   └── prompts/
│
├── backend/                       # 仍存在
│   └── app/
│       ├── compat/
│       │   └── pi_dataset_bridge.py
│       ├── datasets/
│       │   └── service.py         # 若 Phase 0 抽出
│       └── ...
│
├── tests/
│   └── migration/
│       ├── contracts/
│       ├── golden/
│       ├── pi-adapter/
│       ├── workspace/
│       └── e2e/
│
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── tsconfig.base.json
```

---

# 7. Phase 1 测试矩阵

## 7.1 Workspace

必须自动化覆盖：

```text
read normal file
read large file partial
write staging
edit staging
reject absolute path
reject ../
reject symlink escape
reject artifacts write
reject state write
exec cwd correct
exec stdout/stderr
exec timeout
exec cancellation
stdout truncation
child process cleanup
Windows path behavior
Linux path behavior
```

## 7.2 Pi Adapter

使用 fake adapter/fake event stream：

```text
create session
one turn
multiple turns
assistant streaming
tool streaming
tool error
model error
cancel
dispose
listener cleanup
```

并增加静态检查：

```text
除 pi-adapter.ts 外禁止 import Pi internal package
```

## 7.3 Event Adapter

固定 Pi event fixture，检查：

```text
assistant_delta shape
tool_started/tool_called/tool_completed order
run failure mapping
cancel mapping
experimental sequence monotonic
unknown Pi event fail-safe behavior
```

## 7.4 Legacy Dataset bridge

```text
valid spec
invalid JSON
unknown schema
family mismatch
spec rejected
successful build
partial success
no data
core exception
bridge unavailable
cancel during build
publication path protection
```

最关键 parity：

```text
legacy FunctionTool path
vs
Pi bridge path
```

同一 fixture 比较稳定业务字段。

## 7.5 Single Host

```text
pnpm dev starts all required development resources
frontend HMR works
/api/v1 legacy HTTP works
/api/v1/ws legacy WS works
/experimental/pi/* works
only one browser-facing port
legacy child exits with host
host reports child startup failure clearly
Ctrl+C leaves no orphan process
```

Windows 与 Linux 都需要至少一次 CI/local smoke。

## 7.6 Vertical E2E

最低两条：

### E2E-A：Workspace

```text
Pi reads fixture
→ writes staging file
→ edits it
→ executes command
→ returns observed result
```

### E2E-B：DatasetBuild

```text
Pi reads source fixture
→ validates spec
→ executes V2 build
→ receives publication
→ UI shows tool flow
→ final response references actual artifact
```

再增加一个失败案例：

### E2E-C：Spec rejected

```text
invalid spec
→ validator reason code
→ no publication
→ Agent explains failure
→ artifacts unchanged
```

---

# 8. Phase 1 可观测性

每个跨层调用统一携带：

```text
request_id
task_id
run_id
pi_session_id
tool_call_id
build_id（若有）
```

建议 TS structured log 至少包含：

```text
host.lifecycle
legacy.backend.lifecycle
pi.session.lifecycle
pi.event.adapter
workspace.operation
workspace.command
tool.dataset_build
legacy.bridge.request
legacy.bridge.response
```

对 bridge 记录：

```text
op
duration
status
error_code
```

但不在普通日志输出完整 API key、敏感 provider credential 或巨大 Tool payload。

---

# 9. Phase 1 PR 拆分

## PR 1A — `feat/ts-host-shell`

- TS HTTP Host；
- lifecycle；
- legacy FastAPI managed child；
- HTTP/WS proxy；
- Vite middleware；
- 单公开端口。

验收：旧产品功能通过新入口无明显变化。

## PR 1B — `feat/pi-runtime-adapter`

- Pi package pin；
- `pi-adapter.ts`；
- session registry；
- fake adapter tests；
- experimental session creation。

验收：Pi 能完成最小一轮对话。

## PR 1C — `feat/pi-workspace`

- read/write/edit；
- development exec；
- path policy；
- audit；
- security tests。

验收：Workspace smoke E2E 通过。

## PR 1D — `feat/pi-event-adapter`

- Pi event normalization；
- experimental event bus；
- `/experimental/pi/ws`；
- frontend dev toggle/experimental renderer。

验收：文本流和 Tool 事件可见。

## PR 1E — `feat/pi-dataset-build-bridge`

- Python migration bridge；
- TS legacy dataset client；
- Pi Extension Tools；
- validate/execute parity tests。

验收：同一 fixture 经 Pi Tool 可得到 V2 publication。

## PR 1F — `feat/pi-phase1-vertical-slice`

- minimal system prompt；
- migration smoke Skill；
- dataset construction minimal Skill；
- Workspace + DatasetBuild E2E；
- cancel；
- lifecycle cleanup。

验收：完整垂直切片通过。

## PR 1G — `chore/default-dev-entrypoint`

- `pnpm dev` 切 TS Host；
- 更新 README/AGENTS；
- legacy standalone 命令降为 debug only。

---

# 10. Phase 1 Definition of Done

### Host / Workspace

- [x] `pnpm dev` 是正常开发唯一启动命令。
- [x] 浏览器只访问一个端口。
- [x] Vite HMR 由 TS Host 内嵌提供。
- [x] 旧 API/WS 经 TS Host 仍可工作。
- [x] Host 退出后无遗留 legacy/Pi/command 子进程。

### Pi

- [x] Main experimental Agent 使用 Pi。
- [x] Pi 上游依赖封装在 `pi-adapter.ts`。
- [x] 支持 read。
- [x] 支持 write。
- [x] 支持 edit。
- [x] 支持 development command execution。
- [x] 支持 cancel/dispose。
- [x] 一个测试 Skill 可被发现并加载。

### DatasetBuild

- [x] Pi 能调用 `validate_dataset_build`。
- [x] Pi 能调用 `execute_dataset_build`。
- [x] Tool 走 Python V2 Core bridge，不走 V1 Pipeline。
- [x] Publication/Validation/Provenance 语义未降低。
- [x] Agent 无法直接改 `artifacts/`。
- [x] SUCCESS 与 SPEC_REJECTED 至少完成 bridge parity；四类 outcome 已全覆盖。

### Events / UI

- [x] Pi assistant stream 可显示。
- [x] Pi Tool start/completion/error 可显示。
- [x] experimental event shape 兼容现有前端 EventEnvelope 语义。
- [x] 不宣称 experimental sequence 已具备 durable replay。

### Scope control

- [x] 旧 Python Agent Runtime 仍可通过 feature flag 使用。
- [x] 没有创建新的 TS TaskManager 超级类。
- [x] 没有迁完整 Skill Runtime。
- [x] 没有迁 Dataset Core 到 TS。
- [x] 没有迁 SubagentSupervisor。
- [x] 没有提前重写 Settings/model registry。

---

# 11. Phase 0 / 1 完成后的架构状态

```text
                         ┌──────────────────────┐
                         │       Browser        │
                         └──────────┬───────────┘
                                    │ one port
                                    ▼
                    ┌───────────────────────────────┐
                    │      TS Application Host      │
                    │                               │
                    │ Vite middleware               │
                    │ /experimental/pi/*            │
                    │ Pi Agent Adapter              │
                    │ Workspace Policy              │
                    │ Pi Event Adapter              │
                    │ Legacy Dataset Core Client    │
                    │ /api/v1/* legacy proxy        │
                    └──────────┬───────────┬────────┘
                               │           │
                Pi path        │           │ legacy product path
                               ▼           ▼
                  ┌─────────────────┐   ┌────────────────────┐
                  │ Pi AgentSession │   │ Legacy FastAPI     │
                  │                 │   │ private loopback   │
                  │ Skills(minimal) │   │ TaskManager        │
                  │ read/write/edit │   │ EventStore         │
                  │ exec(dev)       │   │ Skills/Subagents   │
                  └────────┬────────┘   └─────────┬──────────┘
                           │ Tool                   │
                           └──────────┬─────────────┘
                                      ▼
                         ┌────────────────────────┐
                         │ Python V2 Dataset Core │
                         │                        │
                         │ Spec Validator         │
                         │ Compatibility Gate     │
                         │ Validation Profile     │
                         │ Publication            │
                         └────────────────────────┘
```

这是刻意的过渡态：

- 浏览器入口已经完成 Node 化；
- Pi Agent 垂直切片已经跑通；
- 旧 FastAPI 仍承载 legacy product runtime；
- Dataset Core 仍保持 Python；
- 后续 Phase 2/3/4 可以分别替换 Skills、Runtime、Core，而不是再做一次全量切换。

---

# 12. Phase 2 的明确交接点

Phase 1 结束后，Phase 2 只从以下已经稳定的边界继续：

```text
.pi/skills/
server/agent/pi-adapter.ts
server/agent/tools/
packages/contracts/
```

此时再逐步迁：

```text
backend/app/skills/builtin/*
→ .pi/skills/*
```

并删除/停用：

```text
SkillCatalog
SkillGateway
SkillRegistry
LLM reranking skill search
UserSkillStore（按产品需求决定是否留 UI adapter）
```

Phase 2 不应反过来修改 Phase 1 已建立的 Pi Adapter、Workspace Policy、Dataset Tool boundary。

---

# 13. 实施顺序总览

推荐严格按以下顺序：

```text
0A root workspace
 ↓
0B shared contracts
 ↓
0C ADR + ownership matrix
 ↓
0D golden baseline
 ↓
0E Python DatasetBuild service boundary
 ↓
1A TS Host + Vite + legacy proxy
 ↓
1B Pi adapter
 ↓
1C Workspace primitives
 ↓
1D event adapter + experimental WS
 ↓
1E DatasetBuild bridge
 ↓
1F vertical E2E
 ↓
1G pnpm dev becomes default
```

关键禁止项：

```text
不要先删 Python Agent
不要先迁完整 Skill
不要先重写 TaskManager
不要先迁 Dataset Core
不要让 Pi event 直连前端
不要让 Pi shell 写 artifacts
不要同时切 Agent + Core + Host + Frontend contract
```

Phase 0/1 的成功标准不是“Python 少了多少”，而是 **新架构边界已经真实运行，后续旧模块可以逐层拔除而无需再次改变整体拓扑**。

---

## 14. 依据

本计划基于：

- 当前仓库 `main` 结构与 `backend/app/main.py`、`backend/app/agent_loop/agent.py`、`backend/app/pipeline/dataset_build_tool.py`、`backend/app/tools/io.py`、`backend/app/tools/sandbox.py`；
- 当前前端 `frontend/package.json`、`frontend/vite.config.ts`、`frontend/src/runtime/contracts.ts`；
- 《BioMed-QAgent → Pi Agent 迁移方案》最新版本；
- 《BioMed-QAgent 数据集构建 Pipeline 重构设计 V2》；
- 最近补充的“单 pnpm Workspace + 单 TS Host + Vite middleware + 单应用端口”迁移约束。
