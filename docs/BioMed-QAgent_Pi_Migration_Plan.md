# BioMed-QAgent → Pi Agent 迁移方案

> 文档状态：Draft for migration  
> 目标仓库：`modenicheng/BioMed-QAgent`  
> 基线分支：`main`  
> 迁移目标：以 Pi 作为主 Agent Runtime；除数据库桥接外，逐步移除 Python 后端与自制 Agent 基础设施。  
> 核心原则：**删除自制 Agent Runtime，不删除 BioMed 确定性业务语义。**

---

## 0. 执行进度

> 状态快照：2026-08-13（main @ dfa668a）。本表随阶段推进更新；可勾选剩余条目与
> 优先级见 [docs/TODO.md](TODO.md)。

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 0 | 冻结边界与迁移 ADR | ✅ 完成（2026-08-12） |
| 1 | 引入 Pi Main Agent，不动 Dataset Core | ✅ 完成（2026-08-12） |
| 2 | 迁移 Skills 与通用 Agent 工具 | ✅ 完成（2026-08-13） |
| 3 | 拆出 TS Application Runtime | ✅ 完成（opt-in，2026-08-12） |
| 4 | 迁移 Dataset Deterministic Core | ✅ 完成（2026-08-13；运行接线属后续阶段） |
| 5 | 迁外部能力与 Python 数据处理依赖 | ⬜ 下一阶段 |
| 6 | 迁模型设置与 Settings API | ⬜ 待开始 |
| 7 | 正式切换 Frontend → TS Host | ⬜ 待开始 |
| 8 | 删除 Python Runtime | ⬜ 待开始 |

Phase 0/1 执行细节与验收证据见
[BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md](BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md)
与 [migration/README.md](migration/README.md)；Phase 2 设计决策与验收映射见
[migration/phase2-skills-tools-migration.md](migration/phase2-skills-tools-migration.md)；
Phase 3 边界、激活方式与回滚见
[migration/phase3-ts-application-runtime.md](migration/phase3-ts-application-runtime.md)；
Phase 4 逐步实现与 parity 证据见 `.superpowers/phase4/T1-T10-report.md`
（TS 代码在 `server/src/dataset/`，运行接线属 Phase 7 前端切换前的集成工作）。

---

## 1. 背景与结论

当前 BioMed-QAgent 已经形成两层结构：

1. Main Agent：负责理解需求、发现数据源、调用 Skill、准备 `DatasetBuildSpec`；
2. Dataset Construction Runtime：负责 acquisition、parse、canonicalize、compatibility gate、integrate、validate、publish。

当前主 Agent 通过 `validate_dataset_build_spec` 和 `execute_dataset_build` 两个 Function Tool 进入 V2 Dataset Construction Runtime；Pipeline 并不是 Skill 本身。与此同时，项目还自行实现了 Agent loop、context、compaction、task runtime、subagent supervisor、skill catalog/gateway、model registry、WebSocket event hub 等大量基础设施。

本次迁移不做“Python → TypeScript 一比一翻译”，而是重新划分职责：

- Pi 接管通用 Agent Runtime；
- Pi Workspace 提供 `read / write / edit / command execution` 等基础操作；
- Pi Skills 只表达“何时、为何、如何使用能力”；
- Pi Extensions 注册受信任业务 Tool；
- Dataset Construction Core 保留确定性执行、验证、溯源、原子发布等可靠性约束，并迁至 TypeScript；
- Python 最终只保留数据库桥接层；如果未来数据库也迁至 TypeScript，上层接口无需变化；
- React 前端尽量保持现有产品逻辑，通过兼容层逐步切换到新的 TS Host；
- 前后端共享同一个 Node/pnpm Workspace、同一 Node 版本、同一 `pnpm-lock.yaml`；
- 开发和生产都采用单一应用入口：开发时 TS Host 内嵌 Vite middleware，生产时 TS Host 直接托管前端构建产物；
- 开发者只需要执行一次 `pnpm dev`，不再分别启动 frontend 和 backend。

最终目标不是“用 TypeScript 重写现在的 FastAPI 后端”，而是：

```text
BioMed-QAgent
    =
Pi Agent Runtime
    +
BioMed Skills
    +
BioMed Extension Tools
    +
Deterministic Dataset Core
    +
Thin Application Host
    +
Minimal Persistence Bridge
```

---

## 2. 当前架构的主要问题

### 2.1 Agent Runtime 重复建设

当前仓库自行维护：

- `backend/app/agent_loop/`
  - agent construction
  - model adapter
  - context
  - runner
  - summarizer
  - input broker
  - reviewer
- `backend/app/runtime/`
  - TaskManager
  - Repository
  - EventHub
  - session
  - compaction
  - state reducer
  - event store
- `backend/app/subagents/`
  - supervisor
  - input broker
  - event sink
  - staging
  - child agent lifecycle
- `backend/app/skills/`
  - catalog
  - gateway
  - registry
  - package/store
  - search/reranking
- `backend/app/model_registry/`
  - provider registry
  - model registry
  - parameter profiles

这些模块中相当一部分属于通用 Agent Runtime，而不是 BioMed-QAgent 核心业务。

迁移后，不再继续维护这些通用设施。

### 2.2 当前主 Agent 缺少通用 Workspace 能力

当前主 Agent已经有：

```text
read_file
read_file_head
search_file
write_file
list_files
```

但这些工具主要面向任务产物目录。

其中：

- 读取范围限制在 `data/output/tasks/<task_id>/`；
- `read_file` 有完整读取大小限制；
- `write_file` 只能写入 `staging/agent/`；
- 没有通用局部 `edit`；
- 主 Agent 没有通用命令执行；
- `run_python_script` 是特制数据处理沙箱，不等于 shell/command primitive。

因此当前 Agent 更像“拥有一组业务 API”，而不是“拥有一个可操作 Workspace”。

Pi 默认 Agent 工作方式以 `read / write / edit / bash` 为核心，并可以通过 SDK 嵌入应用。项目迁移后应优先补齐这一层，而不是继续为每种文件操作开发专用 Function Tool。

### 2.3 不能因迁 Pi 删除确定性内核

当前 V2 已明确保留：

- `DatasetBuildSpec`
- Schema Registry
- SourceAsset
- content hash / digest
- Operation / Attempt
- checkpoint
- timeout / cancel
- compatibility gate
- Validation Profile
- provenance
- immutable Publication
- staging → publish
- BuildResult / ValidationResult
- durable build state

这些不是 Agent Runtime 的重复建设，而是 BioMed-QAgent 的可信业务内核。

迁移原则：

```text
Agent orchestration  → Pi
业务不变量           → 保留并迁 TS
```

不能改成：

```text
Agent 自由调用若干 Skill
→ 自己决定是否验证
→ 自己写 artifacts
```

正式产物仍必须经过受信任 Core 发布。

---

## 3. 迁移目标

### 3.1 必须实现

1. Pi 成为 Main Agent Runtime。
2. 主 Agent 获得通用 Workspace 能力：
   - read
   - write
   - edit
   - command execution
3. 当前 Python `agent_loop` 全部退役。
4. 当前 Python Skill Catalog / Gateway / Store 等基础设施退役。
5. Dataset Construction Runtime 迁为 TypeScript deterministic core。
6. Pipeline 继续作为 Main Agent 可调用的受信任 Tool，而不是改造成纯 Skill。
7. React 前端继续保留 Task / Run / Build / Artifact 产品语义。
8. Pi Session 与 BioMed Task/Build 状态严格分离。
9. FastAPI 最终退役。
10. 除数据库 bridge 外，不再保留 Python 业务后端。

### 3.2 明确不做

本次迁移不应：

- 一比一把 `runner.py` 翻译成 `runner.ts`；
- 一比一把 `TaskManager` 翻译成 TS 超级管理器；
- 让 Skill 取代 Validation Gate；
- 让 Pi Session 取代 DatasetBuild；
- 让 Agent 直接生成正式 publication；
- 为兼容旧结构长期保留两套 Runtime；
- 为每个简单文件操作继续开发专用 Tool；
- 在第一阶段同时重写前端、Pipeline、数据库和 Agent Runtime。

---

## 4. 目标架构

```text
┌────────────────────────────────────────────────────────────┐
│ React Frontend                                             │
│                                                            │
│ Chat / Tasks / Runs / Builds / Artifacts / Settings       │
└───────────────────────┬────────────────────────────────────┘
                        │ HTTP + WS
                        ▼
┌────────────────────────────────────────────────────────────┐
│ Thin TypeScript Application Host                           │
│                                                            │
│ API compatibility │ task/build state │ event projection    │
└───────────────┬───────────────────────────┬────────────────┘
                │                           │
                ▼                           ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│ Pi AgentSession              │   │ BioMed Deterministic Core│
│                              │   │                          │
│ Session / model / context    │   │ DatasetBuildSpec         │
│ read / write / edit / exec   │   │ acquire                  │
│ Skills                       │   │ parse                    │
│ Extensions                   │   │ canonicalize             │
└──────────────┬───────────────┘   │ compatibility            │
               │                   │ integrate                │
               │ Tool call         │ validate                 │
               └──────────────────►│ publish                  │
                                   └───────────┬──────────────┘
                                               │
                                               ▼
                                   ┌──────────────────────────┐
                                   │ Persistence              │
                                   │                          │
                                   │ artifact filesystem      │
                                   │ task/build metadata      │
                                   │ cache index              │
                                   └───────────┬──────────────┘
                                               │ optional
                                               ▼
                                   ┌──────────────────────────┐
                                   │ Python DB Bridge         │
                                   │ JSONL stdin/stdout        │
                                   │ named DB operations      │
                                   └──────────────────────────┘
```

---

## 5. 五层职责边界

### 5.1 Pi Agent Runtime

Pi 负责：

- model/provider 调用；
- Agent loop；
- conversation context；
- session persistence/恢复；
- context compaction；
- tool calling；
- streaming assistant events；
- Skills 发现与加载；
- Extensions 生命周期；
-基础 Workspace 工具。

Pi 不负责：

- DatasetBuild 权威状态；
- Validation Profile；
- Publication；
- provenance；
- cache consistency；
- BioMed Schema compatibility。

### 5.2 Skill

Skill 负责告诉 Agent：

- 什么时候使用某种能力；
- 如何选择数据源；
- 如何准备输入；
- 失败后如何调整；
- 有哪些业务限制；
- 什么时候必须调用受信任 Tool。

例如：

```text
.pi/skills/dataset-construction/SKILL.md
```

描述：

```text
完成来源发现和 vetting 后：
1. 构造 DatasetBuildSpec；
2. 调 validate_dataset_build；
3. 修复全部结构化错误；
4. 调 execute_dataset_build；
5. 只有 Publication 成功才算正式产物完成。
```

Skill 不负责真正执行 DatasetBuild。

### 5.3 Extension Tool

Extension Tool 提供确定性程序接口，例如：

```text
validate_dataset_build
execute_dataset_build
query_cache
register_source_asset
get_build_status
```

这些工具拥有稳定参数 Schema，可由 Pi Agent 调用。

### 5.4 Deterministic Core

Core 负责不能交给 LLM 自由判断的业务不变量：

```text
acquire[*]
→ parse[*]
→ canonicalize[*]
→ compatibility gate
→ integrate
→ validate
→ publish
```

其中：

- Agent 可以决定“提交什么 spec”；
- Core 决定“spec 是否允许执行”；
- Agent 可以选择候选来源；
- Core 决定数据是否兼容；
- Agent 可以解释失败；
- Core 决定 Publication 是否产生。

### 5.5 Persistence

持久化层只保存事实，不参与 Agent 推理。

需要区分：

```text
Pi Session
= 对话事实

BioMed Task / Run / Build
= 应用业务事实

Artifact filesystem
= 数据产物事实
```

三个概念不能重新合并成一个大型 TaskManager。

---

## 6. Pipeline 如何接入 Pi Main Agent

迁移后 Pipeline 仍然不应成为纯 Skill。

推荐结构：

```text
Pi Main Agent
│
├── read
├── write
├── edit
├── command execution
│
├── Skills
│   ├── research-data-guidance
│   ├── pubmed-search
│   ├── geo-discovery
│   ├── dataset-construction
│   └── ...
│
└── Extension Tools
    ├── validate_dataset_build
    ├── execute_dataset_build
    ├── query_cache
    └── ...
             │
             ▼
      Deterministic Core
```

准确职责是：

```text
Skill
= Pipeline 使用协议

Tool
= Pipeline API

Pipeline/Core
= 可信执行实现
```

因此旧：

```python
validate_dataset_build_spec
execute_dataset_build
```

迁移后仍保留相同概念，只改变实现和注册方式。

---

## 7. Workspace 基础能力设计

### 7.1 基础能力

Main Agent 应至少拥有：

```text
read
write
edit
exec
```

其中 `exec` 可以在开发模式直接对应 Pi `bash`，产品模式建议经过 Workspace Policy 包装。

辅助能力：

```text
ls
find
grep
```

不一定需要独立 Tool；多数情况下可由 shell/command 完成。

### 7.2 为什么不继续保留当前 io.py 模式

当前 `io.py` 适合“受控业务文件工具”，但不适合作为通用 Agent Workspace。

迁移后改为：

```text
Workspace Root
└── task/<task_id>/
    ├── source_assets/
    ├── parsed/
    ├── normalized/
    ├── staging/
    ├── artifacts/
    ├── state/
    └── logs/
```

Agent 在 Workspace 内可：

- 读；
- 新建；
- 局部修改；
- 执行临时处理；
- 查看命令输出；
- 根据错误继续修改。

正式 `artifacts/` 仍禁止 Agent 直接写，由 Publisher 生成。

### 7.3 产品模式不应直接暴露无限制 shell

Pi 本身追求 minimal core，不替产品提供完整权限沙箱。因此 BioMed-QAgent 不能简单将无限制 shell 暴露给最终用户任务。

建议两个模式：

#### Development Mode

```text
Pi built-in bash
cwd = developer workspace
```

用于开发和调试。

#### Product Mode

```text
workspace_exec
```

由 Extension 注册，至少限制：

- cwd 固定在 task workspace；
- 超时；
- stdout/stderr 大小；
- 子进程数量；
- 禁止后台常驻进程；
- 禁止访问 workspace 外敏感路径；
- 禁止修改正式 publication；
- 网络命令按项目网络策略限制；
- 所有执行记录进入 audit log。

如果最终仍决定暴露 Pi `bash`，必须通过 Extension/tool interception 或进程级沙箱建立等价边界。

---

## 8. 当前模块迁移矩阵

| 当前模块 | 目标 | 处理方式 |
| --- | --- | --- |
| `backend/app/agent_loop/` | Pi AgentSession | 删除 |
| `agent_loop/agent.py` | Pi session + prompt/context | 重建，不翻译 |
| `agent_loop/context.py` | Pi Session + BioMed task context | 拆分 |
| `agent_loop/runner.py` | Pi agent loop | 删除 |
| `agent_loop/model.py` | Pi model/provider | 删除或极薄 adapter |
| `agent_loop/summarizer.py` | Pi compaction | 删除 |
| `agent_loop/reviewer.py` | Skill / child session（可选） | 重构 |
| `runtime/compaction*` | Pi compaction | 删除 |
| `runtime/session.py` | Pi Session | 删除 |
| `runtime/manager.py` | TS app task coordinator | 大幅收缩 |
| `runtime/event_store.py` | TS durable event store | 重写 |
| `runtime/repository.py` | TS persistence | 重写 |
| `runtime/hub.py` | TS WS/event projection | 重写 |
| `runtime/state.py` | TS reducer/domain state | 保留语义迁移 |
| `subagents/` | Pi extension child sessions（若需要） | 默认先删除 |
| `skills/catalog.py` | Pi ResourceLoader | 删除 |
| `skills/gateway.py` | Pi Skills + direct tools | 删除 |
| `skills/registry.py` | `.pi/skills` discovery | 删除 |
| `skills/packages.py` | Pi Packages/普通项目资源 | 删除 |
| `skills/store.py` | filesystem / project config | 删除或极薄 UI adapter |
| `skills/builtin/` | `.pi/skills/` + TS tools | 内容迁移 |
| `pipeline/dataset_build_tool.py` | Pi Extension Tool | 重写 TS wrapper |
| `datasets/` | deterministic TS core | 语义迁移 |
| `tools/io.py` | Pi Workspace primitives | 删除 |
| `tools/sandbox.py` | exec/bash + policy | 删除 |
| `tools/browser_pool.py` | Node Playwright | 重写 TS |
| `tools/crawler.py` | TS HTTP/browser acquisition | 重写 TS |
| `recipes/` | TS Acquisition subsystem | 保留语义迁移 |
| `model_registry/` | Pi ModelRegistry + TS UI metadata | 删除 Python 实现 |
| `model_settings.py` | TS settings/model adapter | 重写 |
| `api/` | Thin TS Host | 重写 |
| `main.py` | TS application bootstrap | 删除 |
| FastAPI/Uvicorn | TS HTTP/WS server | 删除 |
| cache SQLite / DB | Python DB bridge 或后续 TS DB | 暂保留 |
| artifact filesystem | filesystem | 保留 |

---

## 9. Skill 迁移方案

### 9.1 不迁移 Python Skill Runtime

当前 Skill 系统包含大量运行时基础设施：

```text
catalog
gateway
registry
store
packages
search
llm_search
```

迁 Pi 后这些组件不再维护。

### 9.2 Skill 目录

建议：

```text
.pi/
├── skills/
│   ├── research-data-guidance/
│   │   └── SKILL.md
│   ├── pubmed-search/
│   │   └── SKILL.md
│   ├── geo-discovery/
│   │   └── SKILL.md
│   ├── gdc-acquisition/
│   │   └── SKILL.md
│   ├── xena-acquisition/
│   │   └── SKILL.md
│   ├── dataset-construction/
│   │   └── SKILL.md
│   └── evidence-evaluation/
│       └── SKILL.md
└── extensions/
    ├── dataset-build.ts
    ├── acquisition.ts
    ├── cache.ts
    ├── browser.ts
    └── workspace-policy.ts
```

### 9.3 哪些内容应该成为 Skill

适合 Skill：

- 数据源选择 SOP；
- GEO vetting 规则；
- PubMed 查询策略；
- 多数据源覆盖原则；
- 数据质量检查步骤；
- DatasetBuildSpec 准备流程；
- 何时请求人工修正；
- 如何解释 Validation failure。

不适合 Skill：

- SQL transaction；
- hash 校验；
-原子 rename；
- Publication；
- compatibility gate；
- Schema validation；
- SourceAsset 注册；
-权限检查。

---

## 10. Deterministic Core 迁移方案

### 10.1 需要原样保留的语义

以下概念应保持稳定：

```text
DatasetBuildSpec
DatasetSchema
Schema Registry
SourceBinding
SourceAsset
DataBatch
FieldMapping
ProvenanceRecord
ConfidenceRecord
BuildResult
ValidationResult
DatasetManifest
DatasetPublication
```

迁移时允许 TypeScript 类型形态变化，但 JSON contract 和业务语义不能无理由漂移。

### 10.2 执行骨架

继续使用：

```text
acquire[*]
→ parse[*]
→ canonicalize[*]
→ compatibility
→ integrate
→ validate
→ publish
```

不应改成 Agent DAG。

### 10.3 Core API

建议 Core 暴露纯 TS 接口：

```ts
validateDatasetBuildSpec(spec)
executeDatasetBuild(spec, context)
getBuild(buildId)
listBuildArtifacts(buildId)
```

Pi Extension 只负责把这些接口注册成 LLM Tool。

即：

```text
Pi Extension
≠ Core

Pi Extension
= Core 的 Agent-facing adapter
```

### 10.4 Publication 边界

Agent Workspace 中：

```text
staging/
```

允许 Agent 工作。

但：

```text
artifacts/
publications/
```

只允许 Core Publisher 写。

任何 `write/edit/exec` 都不能绕过 Publication Gate。

---

## 11. Task、Run、Session、Build 状态重新划分

当前很多复杂度来自多个状态概念集中进 Python Runtime。

迁移后明确：

### Pi Session

负责：

- messages；
- context；
- model；
- compaction；
- Agent tool trace。

### BioMed Task

负责：

- 用户在 UI 看见的一项长期任务；
- 关联一个或多个 Pi Session；
- 关联多个 Run；
- 关联多个 Build。

### Run

负责：

- 一次用户输入触发的执行周期；
- queued/running/completed/failed/cancelled；
- 将 Pi events 投影为产品事件。

### DatasetBuild

负责：

- 数据构建状态；
- validation；
- publication；
- artifact。

关系：

```text
Task
├── Pi Session
├── Run 1
│   └── Build A
├── Run 2
│   ├── Build B
│   └── Build C
└── ...
```

Pi Session 不能成为 Build 的数据库。

---

## 12. Durable Event 与前端兼容

当前前端已依赖：

```text
HTTP
+
/api/v1/ws
+
EventEnvelope(sequence)
```

并支持断线后：

```text
after_sequence
→ replay
→ realtime
```

迁移初期不建议同时改前端协议。

### 12.1 第一阶段保持现有 API 外形

TS Host 先实现兼容：

```text
POST /api/v1/tasks
POST /api/v1/tasks/{task_id}/runs
POST /api/v1/tasks/{task_id}/runs/{run_id}/cancel
GET  /api/v1/tasks/{task_id}
GET  /api/v1/tasks/{task_id}/events
GET  /api/v1/builds/{build_id}
GET  /api/v1/builds/{build_id}/artifacts/{artifact_id}
WS   /api/v1/ws
```

### 12.2 Event Source

新的事件来源分成：

```text
Pi session events
+
BioMed core events
+
application lifecycle events
```

统一转换为：

```text
EventEnvelope
```

再交给现有前端 reducer。

### 12.3 不直接把 Pi event schema 暴露给前端

否则前端将和 Pi 上游内部 event schema 强耦合。

应该增加：

```text
Pi Event
   ↓
BioMed Event Adapter
   ↓
Stable EventEnvelope
   ↓
Frontend
```

---

## 13. 模型配置迁移

当前仓库刚建立 Provider Management + Model List，并用 Python SQLite 保存 provider/model/parameter profile。

迁移时不建议继续维护一套完全独立的 Python model runtime。

目标：

```text
Settings UI
   ↓
TS Model Settings Adapter
   ↓
Pi ModelRegistry / AuthStorage / custom model config
```

BioMed-QAgent 可以继续拥有 UI 所需附加元数据，例如：

- display name；
- description；
-推荐参数；
-能力标签；
-模型用途。

但真正模型执行配置应尽量转换为 Pi 可消费结构。

需要在 Phase 0 单独冻结：

1. provider credentials 存储方式；
2. custom OpenAI-compatible provider 映射；
3. 参数 profile 哪些属于 UI metadata；
4.哪些参数真实传给 provider；
5.旧 `model_registry.db` 的迁移方式。

旧 Python model registry 不应成为长期兼容层。

---

## 14. Python 退役计划

目标是最终：

```text
Python
└── database/
    └── bridge.py
```

### 14.1 可直接删除的 Python 依赖职责

| 当前依赖/用途 | 迁移 |
| --- | --- |
| FastAPI | TS Host |
| uvicorn | TS Host |
| openai-agents | Pi |
| Python Agent context/runner | Pi |
| skill runtime | Pi |
| Python WebSocket runtime | TS |
| Python model runtime | Pi/TS |

### 14.2 需要功能替代后才能删除

| 当前用途 | 目标 |
| --- | --- |
| Playwright | Node Playwright |
| HTTP acquisition | TS HTTP client |
| BeautifulSoup | TS HTML parser |
| pdfplumber | 选择并验证 TS/CLI PDF 解析方案 |
| pandas/numpy sandbox | TS/CLI 数据处理方案 |
| matplotlib/seaborn | 前端可视化或 TS 图表输出 |
| SciPy | 逐项确认实际调用，再选择 TS 实现或移除 |

原则：

> 不因“想删 Python”而更换科研语义。

每一项都必须通过 fixture parity test 后退役。

---

## 15. Python DB Bridge

如果数据库暂时继续使用 Python，不再启动 FastAPI 子服务。

推荐：

```text
TS
 ↓ stdin/stdout JSONL
database/bridge.py
 ↓
SQLite / local DB
```

协议示例：

```json
{"id":"req_1","op":"cache.search","args":{"query":"TP53"}}
{"id":"req_1","ok":true,"data":[...]}
```

### 15.1 只允许 named operations

Agent 不应该直接生成任意 SQL。

允许：

```text
cache.search
cache.get
cache.put
task.get_metadata
task.save_metadata
model.migrate_legacy
```

不允许：

```text
db.exec_arbitrary_sql
```

### 15.2 DB Bridge 不等于 Skill

正确分层：

```text
Skill
→ 告诉 Agent 何时查缓存

Tool
→ query_cache(...)

TS DB Adapter
→ 调 bridge

Python bridge
→ SQLite
```

Pipeline/Core 自身需要数据库时，可以直接调用 TS DB Adapter，不需要让 Agent 先调用 Skill。

### 15.3 进程模型

建议先使用单个长期 JSONL 子进程：

- 减少反复启动 Python 的开销；
- 可维持连接池/transaction；
- TS 侧用 request id 对应响应；
- stderr 单独进入 app log；
- bridge 崩溃后可重启；
-协议带 `version` 字段。

如果 DB 操作极少，可先用 per-call subprocess 简化 Phase 1，后续再持久化。

---

## 16. WorkflowRecipe 处理

当前 WorkflowRecipe 已限定只服务 Acquisition，并只能产出 SourceAsset。

这条边界应该继续保留。

迁移后可以：

```text
WorkflowRecipe definition
      ↓
TS Recipe Executor
      ↓
SourceAsset
      ↓
Dataset Core
```

不要直接把 Recipe 变成“Agent 任意执行脚本”。

Recipe 和 Skill 的区别：

```text
Skill
= Agent instructions

WorkflowRecipe
= 受控 Acquisition 描述

Tool
= 执行 Recipe 的程序入口
```

如果某个 Recipe 最终仅剩简单 CLI 操作，可以后续再评估是否转成 Skill + controlled exec。

---

## 17. Subagent 处理

Pi 核心刻意不内建固定 subagent orchestration，因此不应把当前 `subagents/` 一比一移植。

建议：

### Phase 1-5

不迁现有 SubagentSupervisor。

Main Agent + Skills + Tools 先完成完整主流程。

### 后续确有收益时

通过 Extension 创建 child AgentSession：

```text
Main Session
   ↓ delegate
Child Session
   ↓ result
Main Session
```

只实现项目真正需要的：

- reviewer；
-并行文献调研；
-独立数据源探索。

不要恢复一个新的大型 Supervisor Framework。

---

## 18. Node Workspace 与单入口开发模式

### 18.1 单一 pnpm Workspace

迁移后项目根目录成为唯一 Node Workspace 根：

```text
BioMed-QAgent/
├── frontend/
├── server/
├── packages/
├── .pi/
├── database/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── tsconfig.base.json
```

原则：

- 根目录只保留一个 `pnpm-lock.yaml`；
- 前端和 TS Host 使用同一个 Node 版本；
- 根 `package.json` 提供项目唯一开发/构建/启动入口；
- `frontend/` 与 `server/` 可以继续拥有各自 `package.json`，但都属于同一 pnpm workspace；
- 通用 TypeScript 类型、事件契约和 Dataset contract 可以放在 `packages/`，避免前后端复制类型；
- 不使用 frontend/backend 两套独立 `node_modules` 管理流程；
- Python 的 `uv` 环境只服务最终保留的 `database/` bridge，不参与应用主进程启动。

建议 `pnpm-workspace.yaml`：

```yaml
packages:
  - frontend
  - server
  - packages/*
```

建议根 `package.json` 提供：

```json
{
  "private": true,
  "scripts": {
    "dev": "pnpm --filter @biomed/server dev",
    "build": "pnpm --filter @biomed/frontend build && pnpm --filter @biomed/server build",
    "start": "pnpm --filter @biomed/server start",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck"
  }
}
```

这里 `dev` 只启动 TS Host，因为 Vite 由 TS Host 自己创建，不需要再运行独立 `pnpm --filter frontend dev`。

### 18.2 开发环境：TS Host 内嵌 Vite

推荐开发拓扑：

```text
pnpm dev
   │
   ▼
TS Application Host
   │
   ├── /api/*        → BioMed API
   ├── /api/v1/ws    → WebSocket
   ├── Pi AgentSession
   ├── Dataset Core
   │
   └── Vite middleware
          │
          ├── React dev assets
          └── HMR WebSocket
```

浏览器只访问：

```text
http://localhost:<app-port>
```

而不是：

```text
localhost:5173  frontend
localhost:8000  backend
```

应用启动逻辑示意：

```ts
import { createServer as createViteServer } from "vite";

async function createApp() {
  const app = createHttpApplication();

  registerApiRoutes(app);
  registerWebSocketRoutes(app);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: "spa",
    });

    app.use(vite.middlewares);
  } else {
    registerFrontendStaticAssets(app);
  }

  return app;
}
```

这样仍然保留 Vite HMR，但开发者只启动一个 Node 应用。

### 18.3 生产环境：同一个 Host 托管前端

构建：

```text
pnpm build
```

产生：

```text
frontend/dist/
server/dist/
```

启动：

```text
pnpm start
```

只有：

```text
server/dist/index.js
```

一个应用进程。

TS Host：

```text
/api/*          → API
/api/v1/ws      → WS
/assets/*       → frontend/dist/assets
/*              → frontend/dist/index.html
```

因此项目不会在生产环境再维护“前端服务器 + 后端服务器”两个独立进程。

### 18.4 开发时仍保持代码层前后端分离

“单入口”不等于将前端和后端代码混在一起。

继续保留：

```text
frontend/
server/
packages/
```

只是：

```text
运行环境统一
依赖管理统一
启动入口统一
端口统一
```

而代码职责仍然清晰：

```text
frontend
= UI

server
= Pi + API + Dataset Core host

packages/contracts
= 前后端共享契约
```

### 18.5 推荐共享 package

建议增加：

```text
packages/
├── contracts/
│   ├── task.ts
│   ├── run.ts
│   ├── event.ts
│   ├── dataset-build.ts
│   └── artifact.ts
│
├── config/
│   └── ...
│
└── test-utils/
    └── ...
```

其中 `contracts` 同时由 frontend 和 server 引用。

这样可直接消除当前：

```text
Python Pydantic contract
↔
Frontend TypeScript type
```

两边手工同步导致的漂移。

迁移后目标变成：

```text
packages/contracts
        │
        ├── frontend
        └── server
```

对于数据库 bridge 所需 contract，再通过 JSON Schema 或协议版本导出，不让 Python 成为主契约来源。

### 18.6 一键启动要求

开发环境 Definition of Done 增加：

```text
pnpm install
pnpm dev
```

之后即可完整使用：

- React UI；
- Pi Main Agent；
- API；
- WebSocket；
- Dataset Core；
- DB bridge（若需要，由 TS Host 自动拉起并管理）；
- Vite HMR。

开发者不应再执行：

```text
cd frontend && pnpm dev
cd backend && uv run uvicorn ...
```

如果 Python DB bridge 仍存在，其生命周期由 TS Host 管理：

```text
pnpm dev
   ↓
TS Host
   └── spawn database bridge when needed
```

应用退出时同步关闭 bridge。

开发者无需单独启动 Python。

### 18.7 Node 版本与工具链统一

项目根目录固定：

```text
packageManager
Node engine/version
pnpm-lock.yaml
tsconfig.base.json
eslint config
```

前端、server、共享 package 统一继承。

建议所有主工程命令都从仓库根目录执行：

```text
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm lint
pnpm typecheck
```

这也应成为新的 `AGENTS.md` 开发约定。

---

## 19. 推荐目录结构

```text
BioMed-QAgent/
├── frontend/
│   └── ...
│
├── server/
│   ├── index.ts
│   ├── api/
│   │   ├── tasks.ts
│   │   ├── builds.ts
│   │   ├── artifacts.ts
│   │   ├── settings.ts
│   │   └── websocket.ts
│   │
│   ├── agent/
│   │   ├── create-session.ts
│   │   ├── session-registry.ts
│   │   ├── event-adapter.ts
│   │   └── workspace.ts
│   │
│   ├── domain/
│   │   ├── task.ts
│   │   ├── run.ts
│   │   ├── event.ts
│   │   └── artifact.ts
│   │
│   ├── dataset/
│   │   ├── contracts/
│   │   ├── schema/
│   │   ├── acquisition/
│   │   ├── adapters/
│   │   ├── canonicalization/
│   │   ├── compatibility/
│   │   ├── integration/
│   │   ├── validation/
│   │   ├── provenance/
│   │   └── publication/
│   │
│   └── persistence/
│       ├── event-store.ts
│       ├── artifact-store.ts
│       └── db-client.ts
│
├── .pi/
│   ├── skills/
│   ├── extensions/
│   ├── prompts/
│   └── settings.json
│
├── database/
│   ├── bridge.py
│   ├── schema.sql
│   └── migrations/
│
├── tests/
│   ├── fixtures/
│   ├── parity/
│   ├── e2e/
│   └── security/
│
├── package.json
├── pnpm-lock.yaml
└── pyproject.toml
```

最终 `pyproject.toml` 只服务 `database/`。

---

## 20. 分阶段迁移计划

## Phase 0：冻结边界与迁移 ADR

目标：先决定“什么必须保留”，避免迁移中重新设计科研语义。

完成：

- 新增 `docs/PI_MIGRATION.md`；
- 新增 ADR：Pi 成为 Agent Runtime；
- 冻结 DatasetBuild JSON contract；
- 冻结 Publication/Validation 不变量；
- 冻结前端 EventEnvelope；
- 记录当前 E2E fixtures；
- 固定 Pi 版本/commit；
-确定 production command policy；
-确定 DB bridge 协议。

验收：

- 现有 Python tests 全绿；
- 现有前端 tests 全绿；
-保存至少 4 种 E2E fixture：
  - SUCCESS
  - PARTIAL_SUCCESS
  - NO_DATA
  - FAILED/SPEC_REJECTED

---

## Phase 1：引入 Pi Main Agent，不动 Dataset Core

目标：先验证 Pi 能否替换 Agent 层。

新增 TS Host 最小路径：

```text
POST /experimental/pi/tasks
WS   /experimental/pi/ws
```

实现：

- `createAgentSession()`；
- task workspace；
- read/write/edit；
- development command execution；
- Pi streaming → BioMed event adapter；
-最小 system prompt；
-一个测试 Skill。

此阶段仍调用旧 Python Pipeline，可通过临时 adapter：

```text
Pi Tool
→ legacy Python execute_dataset_build
```

这只是过渡桥，不能长期存在。

验收：

- Agent 可以读文件；
- Agent 可以创建文件；
- Agent 可以局部 edit；
- Agent 可以执行命令并读取 stdout/stderr；
- Agent 可以调用旧 DatasetBuild；
- 前端能显示 Pi 文本流和 Tool 事件。

---

## Phase 2：迁移 Skills 与通用 Agent 工具

迁移：

```text
backend/app/skills/builtin/*
→ .pi/skills/*
```

同时删除或停止使用：

```text
SkillCatalog
SkillGateway
SkillRegistry
LLMRerankingSkillSearchStrategy
UserSkillStore
```

业务 Tool 改成 Pi Extensions。

验收：

- Main Agent 不再调用 `find_skill/invoke_skill` 自制网关；
- Pi 能按任务加载相关 Skill；
- Skill 缺失不会导致 Runtime 崩溃；
- Skill 与 Tool 名称有稳定映射；
- learned skill 默认禁用规则有替代方案或明确删除。

---

## Phase 3：拆出 TS Application Runtime

目标：去掉 Python TaskManager 对 Agent Runtime 的控制。

实现：

- TS Task/Run domain；
- TS EventEnvelope；
- TS durable event store；
- Pi event adapter；
- run cancel；
- replay；
- WebSocket reconnect；
- artifact API compatibility。

注意：

- 不复制当前 `runtime/manager.py`；
- 将 Task、Run、Session、Build 分拆为独立对象；
- Pi Session 自己管理 conversation；
- TS Runtime 只管理产品生命周期。

验收：

- 现有前端无需大改即可连接 TS Host；
- sequence replay 正常；
-重连不丢消息；
- cancel 能终止 Agent 和当前 Core operation；
-历史 task 可以读取。

---

## Phase 4：迁移 Dataset Deterministic Core

迁移顺序：

1. contracts；
2. Schema Registry；
3. SourceAsset；
4. adapters；
5. canonicalization；
6. compatibility；
7. integration；
8. validation；
9. publication；
10. checkpoint/retry/cancel。

每迁一个 operation 都运行：

```text
Python V2 fixture
vs
TypeScript fixture
```

比较：

- BuildResult；
- row count；
- Schema version；
- artifact role；
- manifest；
- validation codes；
- provenance；
- content hash；
- publication eligibility。

验收：

- 4 类主结果与 Python V2 一致；
-正式 artifact 仍只能经 Publisher；
-失败不会留下“伪成功”产物；
-旧 publication 不被覆盖；
- rerun/resume 语义符合原 V2 不变量。

---

## Phase 5：迁外部能力与 Python 数据处理依赖

依次迁：

- Playwright；
- crawler；
- HTTP acquisition；
- GEO；
- GDC；
- Xena；
- PubMed；
- PDF；
-表格解析；
-统计/绘图。

每项必须有 live/fixture 双测试。

不允许一次删掉所有 Python scientific dependencies 后再调试。

验收：

```text
backend Python 不再承担 acquisition / parsing / analysis
```

只允许 DB bridge。

---

## Phase 6：迁模型设置与 Settings API

实现：

- TS model settings；
- Pi model registry adapter；
- provider credentials；
- custom provider；
-模型参数 UI adapter；
-旧 model_registry 数据迁移。

验收：

-现有设置页能创建 provider；
-能导入模型；
-能设 active model；
-不同模型参数正确传给 Pi/provider；

- API Key 不以明文返回前端；
-旧数据库可一次性迁移。

---

## Phase 7：正式切换 Frontend → TS Host

切换：

```text
frontend
  X FastAPI
  ✓ TS Host
```

保持 API 兼容一轮发布。

此阶段 Python FastAPI 仍可通过 feature flag 启动作为回滚路径，但默认关闭。

验收：

-完整 E2E；
-多轮对话；
-取消；
-恢复；
-断线重连；
-构建；
-下载 artifact；
-cache；
-settings；
-浏览器能力；
-异常恢复。

---

## Phase 8：删除 Python Runtime

删除：

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

前提是对应职责已经迁移。

最终 Python 只留：

```text
database/
```

同时清理：

- FastAPI；
- uvicorn；
- openai-agents；
- httpx（若 DB 不用）；
- Playwright Python；
- pdfplumber；
- matplotlib；
- scipy；
- seaborn；
-旧 Python tests。

验收：

```text
pnpm test
pnpm lint
pnpm tsc
pnpm build
```

以及：

```text
uv run python database/bridge.py --self-test
```

整个产品启动不再需要 Python Web Server。

---

## 21. 测试策略

### 20.1 Contract Tests

重点冻结：

```text
DatasetBuildSpec
BuildResult
ValidationResult
DatasetManifest
DatasetPublication
EventEnvelope
```

### 20.2 Golden Fixture Parity

同一输入：

```text
Python old core
TS new core
```

比较稳定业务字段，不比较：

- timestamp；
-随机 UUID；
-日志文本；
-模型自然语言。

### 20.3 Workspace Security Tests

必须覆盖：

- `../` path traversal；
- absolute path；
- symlink escape；
- command timeout；
- stdout flood；
- subprocess explosion；
-写正式 artifacts；
-删除 publication；
- shell 访问 workspace 外；
- Windows 路径；
- Linux 路径。

### 20.4 Event Tests

覆盖：

- sequence monotonic；
- replay；
- reconnect；
- duplicate delivery；
- cancel；
- interrupted recovery；
- Pi tool event 映射；
- Dataset Core operation event 映射。

### 20.5 Scientific Correctness

迁 TS 不以“程序能跑”作为完成标准。

至少比较：

-输入行数；
-拒绝行；
-字段映射；
-单位；
-值尺度；
-ID namespace；
-dedup；
-provenance closure；
-validation result。

---

## 22. 安全边界

### 21.1 Agent 不可直接发布

必须保持：

```text
Agent
→ staging

Core
→ validate
→ publication
```

### 21.2 Command Execution

生产环境所有命令执行必须：

-绑定 task/run；
-记录 command + exit code；
-限制 cwd；
-限制时间；
-限制输出；
-支持 cancel；
-阻止后台进程泄漏。

### 21.3 数据库

Agent-facing tool 使用 named operation，不开放任意 SQL。

### 21.4 网络

浏览器和 HTTP acquisition 继续保留：

- URL allow/deny policy；
- redirect 检查；
-下载大小；
- timeout；
- rate limit；
-来源日志。

---

## 23. 主要风险

### 22.1 把 Pi Session 当 Task Runtime

风险最高。

Pi Session 解决 conversation，不解决 Dataset Publication。

必须保持：

```text
Pi Session != BioMed Task != DatasetBuild
```

### 22.2 把 Pipeline 变成 Skill

会让 Validation Gate 从程序约束退化为提示词约束。

禁止。

### 22.3 无限 shell 权限

开发阶段方便，但产品阶段可能访问整台个人电脑。

必须有 Workspace Policy。

### 22.4 TypeScript scientific library 语义漂移

不能只比较 API 是否返回。

必须做 golden fixture parity。

### 22.5 一次性 Big Bang rewrite

会同时失去：

-现有 E2E；

- V2 可靠性；
-前端兼容；
-故障定位能力。

因此必须采用 strangler migration。

### 22.6 Pi 上游变化

迁移开始前固定：

- package version；
- lockfile；
-必要时 commit/tag；
- Integration API adapter。

项目业务代码不要大面积直接依赖 Pi 内部类型；统一经过：

```text
server/agent/pi-adapter.ts
```

---

## 24. 回滚策略

每个阶段必须可回滚。

推荐 feature flag：

```text
AGENT_RUNTIME=legacy|pi
DATASET_CORE=python|ts
APP_HOST=fastapi|ts
```

只用于迁移期。

切换顺序：

```text
legacy agent + python core
→
pi agent + python core
→
pi agent + ts core
→
ts host + pi agent + ts core
```

不要出现：

```text
new host + new agent + new core + new frontend
```

一次全部切换。

Phase 8 后删除 feature flag 和 legacy code。

---

## 25. 优先级建议

实际执行顺序建议：

### P0

1. Pi AgentSession PoC；
2. Workspace `read/write/edit/exec`；
3. DatasetBuild Tool adapter；
4. Event adapter；
5. TS Task/Run 最小模型。

### P1

1. Skills 迁移；
2. Dataset Core TS parity；
3. WebSocket/API compatibility；
4. model settings。

### P2

 1. browser/crawler/PDF/statistics；
 2. cache/DB bridge；
 3. subagent（只有证明需要时）。

---

## 26. 最终 Definition of Done

迁移完成必须同时满足：

### Agent

- [ ] Main Agent 使用 Pi；
- [ ] 支持 read；
- [ ] 支持 write；
- [ ] 支持 edit；
- [ ] 支持 command execution；
- [ ] 不再使用 OpenAI Agents SDK；
- [ ] 不再维护 Python agent loop。

### Skill

- [ ] 核心业务指导迁至 `.pi/skills/`；
- [ ] 不再维护自制 Skill Catalog/Gateway；
- [ ] Skill 不承担确定性数据发布职责。

### Pipeline/Core

- [ ] DatasetBuildSpec 保持；
- [ ] compatibility gate 保持；
- [ ] validation 保持；
- [ ] provenance 保持；
- [ ] immutable publication 保持；
- [ ] Pipeline 通过 Extension Tool 暴露给 Main Agent。

### Runtime

- [ ] Pi Session 与 Task/Build 分离；
- [ ] durable EventEnvelope 保持；
- [ ] replay/reconnect 保持；
- [ ] cancel/recovery 保持。

### Workspace / Developer Experience

- [ ] 前后端属于同一 pnpm workspace；
- [ ] 仓库只有一个 `pnpm-lock.yaml`；
- [ ] 前后端使用同一 Node 版本；
- [ ] `pnpm dev` 一条命令启动完整开发环境；
- [ ] 开发时 TS Host 内嵌 Vite middleware；
- [ ] 生产环境只启动一个 TS Host 进程；
- [ ] Python DB bridge 如仍存在，由 TS Host 自动管理生命周期；
- [ ] 浏览器只需要访问一个应用端口。

### Backend

- [ ] FastAPI 删除；
- [ ] Uvicorn 删除；
- [ ] Python Playwright 删除；
- [ ] Python scientific processing 删除；
- [ ] Python 只剩 DB bridge。

### Frontend

- [ ] 原任务/构建/产物 UI 可继续使用；
- [ ] Settings 可配置 Pi model/provider；
- [ ] Tool/operation stream 正常；
- [ ] artifact 下载正常。

### Quality

- [ ] SUCCESS fixture parity；
- [ ] PARTIAL_SUCCESS fixture parity；
- [ ] NO_DATA fixture parity；
- [ ] FAILED/SPEC_REJECTED fixture parity；
- [ ] workspace security tests 通过；
- [ ] TS lint/typecheck/test/build 全通过；
- [ ] DB bridge self-test 通过。

---

## 27. 建议先执行的第一个 PR

第一个 PR 不应删除 Python。

建议范围：

```text
feat/pi-runtime-bootstrap
```

只做：

1. 增加 TS server workspace；
2. 引入并锁定 Pi；
3.创建一个 `AgentSession`；
4.建立 task workspace；
5.接通 read/write/edit/exec；
6.注册一个假的 `execute_dataset_build` extension tool；
7.把 Pi event 转成最小 EventEnvelope；
8.写基础集成测试。

完成后再做第二个 PR：

```text
feat/pi-dataset-build-bridge
```

让 Pi 真正调用当前 Python V2 `execute_dataset_build`。

这样可以先证明：

> Pi 是否能完整替代当前 Agent Runtime。

证明成立后，才值得继续迁 Dataset Core。

---

## 28. 最终架构判断

本次迁移应遵循一句话：

> **用 Pi 替换通用 Agent 基础设施，用 TypeScript 重建应用外壳和确定性 Core，用 Skill 表达工作方法，用 Extension Tool 暴露可信业务能力，Python 最终只承担必要数据库桥接。**

最终关系应稳定为：

```text
Pi
├── Workspace primitives
├── Skills
└── Extensions
       │
       ▼
BioMed Deterministic Core
       │
       ▼
Persistence / Artifacts
       │
       └── optional Python DB bridge
```

而不是：

```text
Pi
└── 一堆把旧 Python Runtime 翻译成 TS 的新 Runtime
```

只有前一种迁移方式能真正减少项目复杂度。
