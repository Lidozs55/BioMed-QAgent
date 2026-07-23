# BioMed-QAgent

BioMed-QAgent 是一个面向生物医学研究的数据检索、获取、处理与交付系统。用户提交研究主题并选择数据源后，Main Agent 负责理解需求、规划检索和调用 Skill；确定性 Pipeline 负责生成并验证可追溯的数据包。

系统的核心交付物是结构化数据、来源清单、处理记录和质量报告，而不是缺少数据依据的科研或临床结论。

## 核心能力

- **研究任务工作台**：创建研究任务、继续追问、取消 Run、恢复人在回路决策，并查看历史任务。
- **多源数据访问**：内置 PubMed、GEO、GDC、PDB、PubChem、Reactome 和 Xena 数据源。
- **动态 Skill Catalog**：Main Agent 通过 `find_skill` / `invoke_skill` 网关发现和调用 Skill；支持管理用户安装的声明式数据库包和 Python Skill 包。
- **确定性数据闭环**：Pipeline 固定执行 Discovery → Acquisition → Processing → Artifact Build → Validation Gate。
- **可追溯交付**：记录来源、下载尝试、字段映射、处理步骤、警告、质量检查和文件哈希。
- **持久化任务运行时**：任务事件写入 append-only JSONL；支持快照重建、事件回放、断线重连和服务重启后的任务恢复。
- **实时过程展示**：前端按事件序列展示 Assistant 输出、推理、工具调用、Pipeline 阶段、进度、警告和产物。
- **本地文件导入**：上传文件创建 Import Task，将解析和清洗结果写入本地可查询缓存。
- **产物查看与下载**：Artifact 面板支持文件下载及 CSV 前 100 行预览。

> **当前能力边界**：7 个内置数据库均可供 Agent 选择和调用，但目前只有 **PubMed + GEO** 已接入正式的确定性 Pipeline。Live Processing 当前主要完成 GEO 样本元数据恢复；任意数据源的通用清洗、字段对齐和多源合并尚未全部接入 Pipeline 主链。

## 架构概览

```text
React 19 / Vite / Tailwind / shadcn
        |
        | REST：任务控制、快照、历史、回放、产物
        | WebSocket：durable events + realtime assistant stream
        v
FastAPI (app.main:app)
        |
        +-- Durable Runtime
        |     TaskManager / TaskRepository / EventStore
        |     EventHub / AssistantStreamHub / TaskIndex
        |
        +-- OpenAI Agents SDK Main Agent (Qwen)
        |     |
        |     +-- Skill Gateway
        |     |     find_skill / invoke_skill
        |     |
        |     `-- run_research_pipeline
        |             |
        |             v
        |       Deterministic Pipeline
        |       Discovery
        |         -> Acquisition
        |         -> Processing
        |         -> Artifact Build
        |         -> Validation Gate
        |                 |
        |                 v
        |          validated artifacts/
        |
        `-- User Skill / Database Management
```

### Agent 与 Pipeline 的职责边界

**Main Agent** 负责：

- 理解研究主题、数据库限制和用户补充信息；
- 设计检索策略并发现 PMID、GSE 等 accession；
- 通过动态 Skill 网关调用检索、获取、解析和分析能力；
- 调用唯一的 `run_research_pipeline` Function Tool；
- 解释 Pipeline 返回的结构化结果、错误和警告。

**Pipeline** 负责：

- 按固定顺序执行数据阶段并校验阶段契约；
- 保存 checkpoint，按输入、参数和产物摘要决定能否复用阶段结果；
- 在 staging 中构建候选数据包；
- 校验文件存在性、大小、SHA-256、来源与处理记录；
- 仅将通过 Validation Gate 的文件发布到 `artifacts/`。

Main Agent 不直接拼装最终 CSV，也不能绕过 Validation Gate。

## 数据 Pipeline 与产物

### 五个阶段

| 阶段 | 作用 |
| --- | --- |
| Discovery | 根据 topic 或明确 accession 获取 PubMed 与 GEO 来源记录 |
| Acquisition | 下载 GEO 数据，记录下载尝试、来源和 SHA-256 |
| Processing | 将来源资产解析为规范化中间数据；当前 live 路径主要恢复 GEO 样本元数据 |
| Artifact Build | 在 staging 中构建主数据、来源、字段、处理和警告表 |
| Validation Gate | 校验数据包契约与文件完整性，生成质量报告和 manifest，并发布有效产物 |

### 标准交付文件

Artifact Build 生成以下 CSV：

- `main_data.csv`
- `literature.csv`
- `dataset_catalog.csv`
- `sample_metadata.csv`
- `field_descriptions.csv`
- `field_mapping.csv`
- `source_list.csv`
- `source_relations.csv`
- `source_assets.csv`
- `download_log.csv`
- `processing_log.csv`
- `warnings.csv`

Validation Gate 额外生成：

- `quality_report.csv`
- `run_manifest.json`

Artifact API 会复核发布 marker、manifest、文件大小和哈希，不会暴露 staging 中的半成品。

## Durable Task Runtime

任务和 Run 由 FastAPI lifespan 创建的进程级运行时管理。典型成功状态流为：

```text
QUEUED -> RUNNING -> FINALIZING -> COMPLETED
```

运行时还支持 `AWAITING_USER_INPUT`、`CANCEL_REQUESTED`、`FAILED`、`CANCELLED` 和 `INTERRUPTED` 等状态。

每个 Task 的 durable event 都带有单调递增的 `sequence` 并写入 `events.jsonl`。前端使用 Task 级 `lastSequence` 去重：常规 WebSocket 重连通过 `after_sequence` 续订；任务切换等权威衔接场景通过 REST Event API 补齐。服务重启后，排队中的 Run 可重新入队，未完成的运行中 Run 会被标记为中断。

Agent 返回自然语言并不等于任务成功。Agent Run 必须产生新的、可验证的正式 Artifact，否则运行时会将其判为失败。

## 内置数据源与 Skill

| 类别 | 内置能力 |
| --- | --- |
| Discovery | PubMed、Literature Understanding |
| Acquisition | GEO、GDC、PDB、PubChem、Reactome、Xena、Browser Fallback、Web Visual Capture、Local Cache |
| Processing | PDF Extraction、Qwen-VL Chart Extraction、Self Evolution |
| Analysis | 基础统计、差异表达、热图和相关矩阵 |

用户可选择的数据源为 PubMed、GEO、GDC、PDB、PubChem、Reactome 和 Xena。其中 PubMed、GEO 标记为 `pipeline_supported`；其他数据源目前作为 Agent-only Skill 使用。

用户扩展存放在应用包之外的可写目录中。系统支持：

- JSON/YAML 声明式 HTTP 数据库包；
- Python ZIP Skill 包；
- 校验、上传、启用、停用、版本回滚和删除；
- Catalog 不可变快照和 generation 递增的原子热更新。

> Python Skill 包以本地后端进程权限执行，只应安装可信来源的包。

## 快速开始

### 环境要求

| 组件 | 要求 |
| --- | --- |
| Python | 3.12+ |
| Node.js | 18+ |
| 后端包管理 | [uv](https://docs.astral.sh/uv/) |
| 前端包管理 | [pnpm](https://pnpm.io/) |
| 模型 | Qwen / DashScope OpenAI 兼容接口 |

### 1. 启动后端

`.env.example` 位于仓库根目录。PowerShell：

```powershell
Set-Location backend
Copy-Item ..\.env.example .env
uv sync
uv run uvicorn app.main:app --reload
```

Bash：

```bash
cd backend
cp ../.env.example .env
uv sync
uv run uvicorn app.main:app --reload
```

如需运行网页截图 Skill，再安装 Playwright Chromium：

```bash
uv run playwright install chromium
```

后端默认地址：`http://127.0.0.1:8000`。

### 2. 启动前端

另开终端：

```bash
cd frontend
pnpm install
pnpm dev
```

前端默认地址：`http://localhost:5173`。

### 3. 配置模型

真实 Agent、模型发现和 Qwen-VL 调用需要有效的模型凭据。可任选一种方式：

1. 编辑 `backend/.env`，填写 `DASHSCOPE_API_KEY`；
2. 服务启动后，在前端设置面板中配置 Vendor、Base URL、API Key、模型和生成参数。

未配置 API Key 时，后端仍可启动并提供健康检查、任务管理和不调用模型的本地能力。

### 4. 访问入口

- 前端：<http://localhost:5173>
- Swagger：<http://127.0.0.1:8000/docs>
- ReDoc：<http://127.0.0.1:8000/redoc>
- 健康检查：<http://127.0.0.1:8000/api/v1/health>

当前 CORS 和 Trusted Host 配置面向本机开发，仅允许 `localhost` / `127.0.0.1`。只把 `HOST` 改为 `0.0.0.0` 并不会自动开放局域网访问。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 空 | 真实模型调用所需的 API Key |
| `DASHSCOPE_BASE_URL` | DashScope OpenAI 兼容地址 | 模型 API 地址 |
| `MODEL_NAME` | `qwen-plus` | 默认模型 |
| `NCBI_EMAIL` | `biomed-qagent@example.com` | NCBI E-utilities 联系邮箱 |
| `NCBI_TOOL` | `BioMedQAgent` | NCBI 工具标识 |
| `NCBI_API_KEY` | 空 | 可选；提高 NCBI 请求配额 |
| `NCBI_USER_AGENT` | 项目默认 UA | NCBI HTTP User-Agent |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `8000` | 后端监听端口 |
| `OUTPUT_DIR` | `data/output` | 任务和数据输出根目录 |
| `SKILL_DATA_DIR` | 未设置 | 用户 Skill 目录；默认由 `OUTPUT_DIR` 推导 |
| `TASK_PAGE_SIZE` | `30` | 默认任务分页大小 |
| `TASK_PAGE_MAX_SIZE` | `100` | 任务分页上限 |
| `TASK_MESSAGE_PAGE_SIZE` | `100` | 消息分页大小 |
| `RUNTIME_MAX_ACTIVE_RUNS` | `4` | 最大 active Run 数 |
| `RUNTIME_SYNC_WORKER_THREADS` | `4` | 同步工作线程数 |
| `RUNTIME_RUN_QUEUE_SIZE` | `100` | Run 队列容量 |
| `RUNTIME_SUBSCRIBER_QUEUE_SIZE` | `1000` | 实时订阅队列容量 |
| `LOG_LEVEL` | `INFO` | 后端日志等级 |

## API 概览

主要接口均以 `/api/v1` 为前缀。

### 基础与模型设置

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET / PUT | `/settings` | 读取或保存模型设置；敏感字段以掩码返回 |
| GET | `/vendors` | 查询已知模型供应商 |
| POST | `/models` | 从当前模型端点发现模型 |

### 数据库与 Skill

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/databases` | 列出或创建声明式数据库 |
| PUT / DELETE | `/databases/{name}` | 更新或删除用户数据库 |
| GET | `/skills` | 列出 Skill Catalog |
| GET | `/skills/{name}` | 获取 Skill 详情 |
| POST | `/skills/validate` | 校验扩展包 |
| POST | `/skills/upload` | 上传扩展包 |
| POST | `/skills/{name}/enable` | 启用用户 Skill |
| POST | `/skills/{name}/disable` | 停用用户 Skill |
| POST | `/skills/{name}/rollback` | 回滚用户 Skill |
| DELETE | `/skills/{name}` | 删除用户 Skill |

### Task、Run 与 Artifact

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/tasks` | 分页列出 Task，或创建 durable Task 和首个 Run |
| GET / DELETE | `/tasks/{task_id}` | 获取权威快照，或删除终态 Task |
| POST | `/tasks/{task_id}/runs` | 为已有 Agent Task 创建下一轮 Run |
| POST | `/tasks/{task_id}/runs/{run_id}/cancel` | 请求取消 Run |
| POST | `/tasks/{task_id}/runs/{run_id}/resume` | 提交人在回路决策 |
| GET | `/tasks/{task_id}/messages` | 分页读取消息 |
| GET | `/tasks/{task_id}/events` | 按 sequence 回放 durable events |
| GET | `/tasks/{task_id}/artifacts` | 列出已验证产物 |
| GET | `/tasks/{task_id}/artifacts/{artifact_id}` | 下载产物 |
| POST | `/import/tasks` | 上传本地文件并创建 Import Task |
| GET | `/cache/export` | 导出本地缓存 ZIP |

### WebSocket

入口：`ws://127.0.0.1:8000/api/v1/ws`

客户端命令：

```json
{"type":"subscribe","task_id":"...","after_sequence":0}
{"type":"unsubscribe","task_id":"..."}
{"type":"ping"}
```

WebSocket 负责 durable event 和低延迟 Assistant stream；创建 Task 或 Run 必须使用 REST。

## 任务目录

从 `backend/` 使用默认配置启动时，任务通常保存在：

```text
data/output/tasks/<task_id>/
├── events.jsonl              # 权威 append-only 事件日志
├── source_assets/            # 下载或导入的来源资产
├── download_tmp/             # 下载临时文件
├── parsed/                   # 解析结果
├── normalized/               # 规范化中间数据
├── staging/                  # 验证前候选产物
├── artifacts/                # 已验证并正式发布的产物
├── state/                    # Snapshot、Pipeline checkpoint、发布 marker
└── logs/                     # 阶段尝试与任务指标
```

模型设置默认保存在 `data/settings/model.json`，用户扩展默认保存在 `data/skills/`。Pipeline 审计事件另写入进程工作目录下的 `logs/pipeline.jsonl`。

## 项目结构

```text
BioMedQAgent/
├── backend/
│   ├── app/
│   │   ├── agent_loop/       # Main Agent、模型、Reviewer、Run executor
│   │   ├── api/              # REST 与 WebSocket 接口
│   │   ├── domain/           # Task、事件、来源、Pipeline 契约
│   │   ├── integrations/     # NCBI、Europe PMC、Unpaywall 等集成
│   │   ├── pipeline/         # 五阶段确定性 Pipeline、状态与 checkpoint
│   │   ├── runtime/          # Durable Task Runtime 与事件溯源
│   │   ├── skills/           # Builtin/User Skill Catalog、Gateway 与 Store
│   │   └── tools/            # 文件、缓存、解析、清洗、导出与安全工具
│   ├── tests/                # pytest 测试
│   ├── launcher.py           # 打包/静态前端启动入口
│   ├── pyproject.toml
│   └── uv.lock
├── frontend/
│   ├── src/
│   │   ├── components/       # 会话、产物、设置和 shadcn/Base UI 组件
│   │   ├── hooks/            # REST 与 WebSocket Hooks
│   │   ├── runtime/          # Controller、Transport、Reducer 与事件契约
│   │   ├── stores/           # Zustand 运行时投影
│   │   ├── styles/
│   │   └── test/             # Vitest 测试
│   ├── package.json
│   └── pnpm-lock.yaml
├── docs/
│   ├── ARCHITECTURE.md       # 架构与设计决策的权威说明
│   ├── DEVELOPER_QUICKSTART.md
│   └── TODO.md
├── PROBLEM.md                # 赛题背景与评价标准
├── AGENTS.md                 # 工程与 Agent 协作约定
└── .env.example
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| Backend | Python 3.12+、FastAPI、Uvicorn、Pydantic v2、httpx |
| Agent | OpenAI Agents SDK、Qwen / DashScope OpenAI 兼容接口 |
| Data / Document | openpyxl、pdfplumber、PyYAML、Playwright |
| Analysis | SciPy、Matplotlib、Seaborn |
| Frontend | React 19、TypeScript 5.6、Vite 5 |
| UI | Tailwind CSS v4、shadcn、Base UI、Resizable Panels |
| State / Stream | Zustand、durable event reducer、REST + WebSocket |
| Preview | React Markdown、Papa Parse |
| Test / Lint | pytest、pytest-asyncio、Ruff、Vitest、Testing Library、ESLint |
| Package Management | uv、pnpm |

Zustand 只将草稿的数据源选择偏好持久化到 `localStorage`；Task、Run、消息、事件和产物的权威状态均来自后端 durable runtime。

## 开发与校验

### 后端

所有后端命令从 `backend/` 运行：

```bash
uv sync
uv run pytest
uv run pytest -m live
uv run ruff check app/ tests/ launcher.py
uv run uvicorn app.main:app --reload
```

默认测试排除 `@pytest.mark.live` 网络测试，并将警告视为错误。

### 前端

所有前端命令从 `frontend/` 运行，使用 pnpm：

```bash
pnpm install
pnpm lint
pnpm tsc
pnpm test
pnpm build
```

## 打包运行

`backend/launcher.py` 复用与开发服务器相同的 FastAPI lifespan，并在找到 `frontend/dist/` 时挂载静态前端、提供 SPA fallback 和自动打开浏览器。

先构建前端，再从源码运行整合入口：

```bash
cd frontend
pnpm build

cd ../backend
uv run python launcher.py
```

PyInstaller 打包时需要将 `frontend/dist` 作为 `dist` 数据目录加入 bundle；具体构建参数应与目标平台和 CI 配置保持一致。

## 文档

- [系统架构](docs/ARCHITECTURE.md)
- [开发者快速入门](docs/DEVELOPER_QUICKSTART.md)
- [开发任务清单](docs/TODO.md)
- [赛题背景与评价标准](PROBLEM.md)
- [工程协作约定](AGENTS.md)
- [后端说明](backend/README.md)
- [前端说明](frontend/README.md)
- [可复现性指南](backend/REPRODUCIBILITY.md)
