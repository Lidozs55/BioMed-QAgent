# BioMed-QAgent

BioMed-QAgent 是一个面向生物医学研究数据的 **Agent + 确定性 Pipeline** 应用：用户用自然语言描述研究主题，系统负责检索文献与数据集、获取原始文件、解析和清洗数据、完成字段对齐，并生成带来源、校验信息和处理记录的结构化产物。

项目的目标是让数据处理过程**可追溯、可验证、可恢复**，而不是让大语言模型直接“猜”出一个 CSV。系统可以展示统计结果和可视化数据，但不会在缺少数据证据时生成科研或临床结论。

> 当前正式拓扑为 **TS Host + Pi Agent + TS Dataset Core**：formal `/api/v1`
> HTTP/WS、durable Task/Run/Event、模型设置与 product API 均由 TypeScript 权威
> 实现；Agent 为 Pi（`server/src/agent/pi-adapter.ts`）；数据集执行为 TS
> 确定性核心（`server/src/dataset/`）；Python 仅剩 `database/` persistence
> bridge（JSONL named-op，按需启动）。边界与事件模型详见
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 功能与架构双入口

本仓库按「**功能 / 架构**」分设两套面向协作者的入口，写汇报材料时可分别取材：

| 文档 | 读者与用途 |
| --- | --- |
| [docs/FEATURES.md](docs/FEATURES.md) | **功能 / 能力全景**：系统能做什么，逐项对齐赛题评价维度，含演示视频建议脚本。适合产品、数据、写 PPT 的协作者。 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **技术架构权威**：系统如何组织、边界、事件模型、数据契约、安全。适合工程师与架构评审。 |
| [docs/architecture/roadmap.md](docs/architecture/roadmap.md) + [docs/TODO.md](docs/TODO.md) | **未来规划**：演进方向、待决问题、开放任务与进度。 |

## 核心能力

> 能力全景、逐项说明与赛题映射见 [docs/FEATURES.md](docs/FEATURES.md)，此处为摘要。

- **自然语言研究任务**：从主题、关键词、数据库、目标字段和时间范围生成结构化任务规格。
- **多源检索与获取**：通过可插拔 Skill 访问 PubMed、GEO、GDC、Xena 等生物医学数据源，记录 accession、来源关系、下载尝试和文件校验信息。
- **确定性数据处理**：按受信任 Dataset Core 执行 Acquire → Parse → Canonicalize → Compatibility → Integrate → Validate → Publish。
- **可验证交付物**：只有通过 Validation Gate 的产物才会原子发布并经 API 暴露（`DatasetPublication` + manifest 唯一权威声明）。
- **Durable Task Runtime**：任务、Run、事件和产物状态持久化，支持取消、恢复、事件重放以及人在回路（HITL）暂停/继续与权限批准。
- **实时进度反馈**：前端通过 REST + WebSocket 接收 Agent 文本、工具调用、Pipeline 阶段、进度、警告和产物事件。
- **模型与 curated Skills**：支持通过设置 API / 模型注册表配置 OpenAI 兼容模型；Pi 按任务加载
  `.pi/skills/`，learned skill 概念已退役。
- **视觉证据采集**：可选使用 Playwright 截取网页或论文页面，并使用 Qwen-VL / PDF 解析 / caption 文本组成降级链路提取图表数据。

## 架构概览

```text
┌──────────────────────────────────────────────────────────────┐
│ TypeScript Application Host（唯一公开端口）                  │
│ Vite · native /api/v1 · durable /api/v1/ws                  │
│ Pi Main Agent · Task/Run/Event · settings/builds/cache       │
└───────────────┬───────────────────────────┬──────────────────┘
                │                           │
                ▼                           ▼
┌──────────────────────────────┐   ┌───────────────────────────┐
│ TypeScript Dataset Core      │   │ database/bridge.py       │
│ Acquire → Validate → Publish │   │ named DB operations only │
└───────────────┬──────────────┘   └───────────────────────────┘
                                │ 仅发布通过验证的 Artifact
                                ▼
                    data/output/tasks/<task_id>/artifacts/
```

产品路径只有一个 Node.js 进程（TS Host，Pi 为其进程内依赖）和按需启动的
Python `database/bridge.py` 子进程，不存在 legacy FastAPI / Python Runtime /
experimental Pi 路径。

职责边界如下：

- **Agent** 由 Pi + TS durable runtime 持有（`task_ts_*` Task/Run/Event）。
- **Dataset Core** 负责按照契约执行处理、记录审计信息、检查完整性，并拒绝未经验证的产物；Agent 不能直接制造 publication。
- **Skill** 是 instructions 与 Function Tools 的能力包，按 `discovery/`、`acquisition/`、`processing/`、`analysis/` 分类。
- **Runtime** 负责任务生命周期和事件持久化；前端状态是后端事件的投影，不是事实来源。
- **Python** 仅 `database/bridge.py`：SQLite/文件持久化 named-op，由 TS DatabaseClient 按需管理。

完整设计、状态模型和安全边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 迁移状态

Pi 迁移（Phase 0–8）已于 2026-08-14 全部完成：legacy Python Runtime、FastAPI、
rollback profile 与 feature flags 已物理删除。历史执行记录见
[docs/migration/](docs/migration/)；迁移期间的中间拓扑不再代表当前系统。

## 快速开始

### 环境要求

| 组件            | 要求                                          |
| --------------- | --------------------------------------------- |
| Python          | 3.12+（仅 `database/` persistence bridge 需要） |
| Node.js         | 22.19+                                        |
| Python 包管理器 | [uv](https://docs.astral.sh/uv/)（`uv sync` 安装 database 项目） |
| Node 包管理器   | [pnpm](https://pnpm.io/)（不要使用 npm）       |
| LLM             | DashScope API Key，或其他 OpenAI 兼容模型配置 |
| 可选            | Playwright Chromium，用于网页视觉证据采集     |

### 1. 配置应用

在项目根目录复制环境变量模板，然后编辑根 `.env`；正常 `pnpm dev` 会读取它，
由 TS Host 与 Pi 消费：

**Windows PowerShell**：

```powershell
Copy-Item .env.example .env
notepad .env
```

**macOS / Linux / Git Bash**：

```bash
cp .env.example .env
$EDITOR .env
```

至少配置：

```dotenv
DASHSCOPE_API_KEY=your-api-key-here
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen3.7-plus
```

若使用 NCBI E-utilities，建议同时填写真实的 `NCBI_EMAIL` 和 `NCBI_USER_AGENT`。完整变量说明见 [.env.example](.env.example)。

安装 `database/` bridge 项目（Python 3.12+ 仅 bridge 需要；TS Host 自动探测
`BIOMED_PYTHON_BIN` → 仓库 `.venv` → PATH，规划中改为内置解释器）与根 pnpm
Workspace 依赖：

```bash
uv sync
pnpm install --frozen-lockfile
```

可选：需要网页视觉证据采集时安装 Playwright Chromium：

```bash
pnpm exec playwright install chromium
```

### 2. 启动单端口应用

```bash
pnpm dev
```

浏览器只访问 TypeScript Host 的 `http://127.0.0.1:5173`。Host 内嵌 Vite 并原生
处理正式 HTTP/WS，不启动任何 Python Web Server。
启动后可访问：

- Web 界面：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 健康检查：[http://127.0.0.1:5173/api/v1/health](http://127.0.0.1:5173/api/v1/health)

### 3. 生产启动（可选）

构建产物并静态托管：

```bash
pnpm build
pnpm start
```

`pnpm start` 由 TS Host 直接服务 `frontend/dist`（SPA fallback）与正式 API/WS，
不需要 uvicorn 或第二个应用服务器。

## 任务与数据产物

每个任务使用独立目录保存中间文件、事件和最终产物：

```text
data/output/tasks/<task_id>/
├── source_assets/   # 成功获取并校验的不可变来源文件
├── download_tmp/    # 未完成下载，不能交给 Parser
├── parsed/          # 解析结果
├── normalized/      # 清洗和字段对齐结果
├── staging/         # 按 run_id 隔离的候选产物
├── artifacts/       # 通过 Validation Gate 的公开产物
├── state/           # task snapshot、锁和恢复状态
└── logs/            # 阶段、事件、验证和诊断记录
```

标准产物包可能包含：

- `run_manifest.json`：输入、计划、版本、时间和产物清单；
- `main_data.csv`：统一行粒度的主数据；
- `literature.csv`：文献元数据；
- `dataset_catalog.csv`、`sample_metadata.csv`：数据集和样本元数据；
- `field_descriptions.csv`、`field_mapping.csv`：字段说明与来源字段映射；
- `source_list.csv`、`source_relations.csv`：来源及其证据关系；
- `source_assets.csv`、`download_log.csv`：文件资产、checksum 和下载尝试；
- `processing_log.csv`、`quality_report.csv`、`warnings.csv`：处理审计、质量门禁和警告。

API 只公开通过 manifest 注册并通过验证的 `artifacts/` 文件。任务事件日志 `<task_id>/events.jsonl` 是追加写入的权威事实来源，snapshot 可以从事件重建。

## HTTP API

所有 REST 路由统一使用 `/api/v1` 前缀。常用路由：

| 方法               | 路径                                                | 用途                                      |
| ------------------ | --------------------------------------------------- | ----------------------------------------- |
| `GET`            | `/health`                                         | 健康检查                                  |
| `GET` / `POST`   | `/tasks`、`/import/tasks`                          | 列出任务 / 创建任务（含导入）             |
| `GET` / `DELETE` | `/tasks/{task_id}`                                 | 权威任务快照 / 删除终态任务               |
| `POST`           | `/tasks/{task_id}/runs`                            | 排队下一轮 Run                            |
| `POST`           | `/tasks/{task_id}/runs/{run_id}/resume`            | 提交人在回路（HITL）决策                  |
| `GET`            | `/tasks/{task_id}/events`、`/messages`、`/artifacts` | 重放事件 / 读取消息 / 产物下载          |
| `GET` / `PUT`    | `/settings`、`/personalization`                    | 模型设置（API Key 掩码）/ 个性化设置      |
| `GET`            | `/databases`、`/model-registry/*`                  | 数据库与模型注册表（供应商/模型/激活）    |
| `GET`            | `/builds`、`/cache/*`                              | 构建记录与本地缓存                        |
| WS               | `/ws`                                              | durable events + 实时 assistant 流        |

完整路由与 DTO 定义以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（API 面见
[docs/architecture/runtime-events.md](docs/architecture/runtime-events.md) §15）和
`@biomed/contracts` 为准（README 不重复维护全表）。

### Durable WebSocket

前端连接 `ws://127.0.0.1:5173/api/v1/ws`，由 TS Host 原生服务。

客户端只发送以下命令：

```json
{"type":"subscribe","task_id":"<task-id>","after_sequence":0}
{"type":"unsubscribe","task_id":"<task-id>"}
{"type":"ping"}
```

订阅时服务端先重放 `sequence > after_sequence` 的事件，再切换到实时推送。服务端返回 `EventEnvelope`、`pong` 或 `error`。事件包括 Run 生命周期、工具调用、Agent 文本、Pipeline 阶段、进度、警告、用户输入请求和产物生成等。

WebSocket 不负责创建 Run，也不提供 SSE；创建任务和提交新一轮用户输入通过 REST 完成。前端会自动重连，并用最后的 durable sequence 补齐断线期间的事件。

## 项目结构

```text
BioMed-QAgent/
├── server/                 # TS Host、Pi adapter、TS Dataset Core、durable runtime
├── packages/contracts/     # 前端/Host 共享 wire DTO
├── .pi/skills/             # curated Skills（SKILL.md）
├── database/               # Python persistence bridge（stdlib，named-op JSONL）
├── tests/                  # 共享 golden fixtures（fixtures/）
├── frontend/
│   ├── src/
│   │   ├── components/       # 业务组件与 shadcn/ui 组件
│   │   ├── runtime/           # WebSocket transport、controller、reducer
│   │   ├── stores/            # Zustand 状态管理
│   │   ├── hooks/             # API、实时流和主题 Hook
│   │   └── styles/            # Tailwind CSS v4 样式
│   ├── package.json
│   └── vite.config.ts
├── package.json            # root Workspace 与唯一正常 dev 入口
├── pnpm-workspace.yaml
├── pnpm-lock.yaml          # 唯一 Node lockfile
├── docs/
│   ├── ARCHITECTURE.md        # 权威架构和数据契约
│   ├── FEATURES.md            # 功能/能力全景（对齐赛题评价维度，写汇报用）
│   ├── DEVELOPER_QUICKSTART.md # 开发者快速入门
│   ├── TODO.md                # 开发任务与进度索引（迁移 Phase 0-8 已完成）
│   ├── architecture/          # 架构分层章节（执行、验证、runtime、前端、roadmap 等）
│   └── migration/             # 历史迁移执行记录（Phase 0-8，已归档）
├── AGENTS.md                  # AI Agent 与协作约定
├── PROBLEM.md                 # 赛题背景与评价标准
└── .env.example               # 环境变量模板
```

## 技术栈

| 层级           | 技术                                                   |
| -------------- | ------------------------------------------------------ |
| Application Host | Node.js 22.19+、TypeScript、Vite                     |
| Agent          | Pi（`server/src/agent/pi-adapter.ts`）+ TS durable runtime |
| Dataset Core   | TypeScript deterministic core（`server/src/dataset/`） |
| Python         | 3.12+ stdlib persistence bridge（`database/`）         |
| 前端           | React 19、Vite、TypeScript、Tailwind CSS v4、shadcn/ui |
| 状态与数据展示 | Zustand、React Markdown、PapaParse                     |
| 测试           | Vitest（TS）、pytest（database bridge）                |
| 工具链         | pnpm、ESLint（前端）、uv / ruff（仅 database 项目）    |

## 配置参考

`.env.example` 是配置入口。常用变量如下：

| 变量                   | 默认值                        | 说明                                            |
| ---------------------- | ----------------------------- | ----------------------------------------------- |
| `DASHSCOPE_API_KEY`  | 空                            | DashScope API Key；使用真实 Agent / Qwen 时需要 |
| `DASHSCOPE_BASE_URL` | DashScope OpenAI 兼容地址     | 模型服务的 OpenAI 兼容 base URL                 |
| `MODEL_NAME`         | `qwen3.7-plus`              | 默认模型名                                      |
| `NCBI_EMAIL`         | `biomed-qagent@example.com` | NCBI E-utilities 联系邮箱                       |
| `NCBI_TOOL`          | `BioMedQAgent`              | NCBI E-utilities tool 名称                      |
| `NCBI_API_KEY`       | 空                            | 可选的 NCBI API Key                             |
| `HOST` / `PORT`      | `127.0.0.1` / `5173`        | TS Host 唯一公开监听地址                        |
| `BIOMED_PYTHON_BIN`  | 自动探测                     | database bridge 解释器（默认 repo/.venv 或 PATH）|
| `PI_PROVIDER` / `PI_MODEL` | `dashscope` / `MODEL_NAME` | Pi provider 与模型选择                    |
| `PI_API_KEY` / `PI_BASE_URL` | 回退 DashScope 配置    | Pi credentials；不要提交真实密钥                |
| `AGENT_EXEC_POLICY` | 空（跟随设置）                | 迁移 flag：`deny`/`ask`/`allow` 覆盖命令执行策略  |
| `SHUTDOWN_TIMEOUT_MS` | `10000`                     | 回收超时                                        |
| `OUTPUT_DIR`         | `data/output`               | 覆盖时必须使用绝对路径                          |
| `LOG_LEVEL`          | `INFO`                      | 日志级别                                        |

模型设置通过模型注册表持久化：注册表与供应商/模型条目写入 `data/settings/model-registry.json`，API Key 写入 `data/settings/model-auth.json`（0600，仅保存掩码返回）。首次启动时若环境变量提供了 `DASHSCOPE_API_KEY`（或 `PI_API_KEY`）且尚无任何已配置供应商，会自动注册 DashScope 供应商并激活默认模型。保存的模型快照在 Run 创建时形成不可变配置，避免并发运行中的变更影响已开始的任务。

## 开发与质量检查

### Python database bridge

Python 面只剩 `database/`（bridge 持久化），从仓库根执行：

```bash
uv sync
uv run python database/bridge.py --self-test   # bridge 自检
uv run pytest database/tests                     # bridge 协议/持久化测试
uv run ruff check database                       # lint
```

### Node Workspace

正常质量门从仓库根目录执行：

```bash
pnpm test          # 测试（默认有界并发：workspace ×2、vitest worker 受限）
pnpm test:full     # 全速测试（CI 或明确需要最快完成时；去掉 workspace 并发限制）
pnpm lint
pnpm typecheck
pnpm build
```

测试并发默认有界，避免本机 CPU 撞功耗墙：根 `pnpm test` 限制 workspace 并发为 2，
各 vitest 配置限制 worker 数（server `forks`/2、frontend `threads`/4、contracts
`threads`/2）；CI（`CI=true`）自动放开 vitest worker 上限。预算模型与覆盖方式见
[docs/architecture/test-concurrency.md](docs/architecture/test-concurrency.md)。

### 前端 package（定向诊断）

所有前端命令从 `frontend/` 目录执行：

```bash
cd frontend
pnpm install
pnpm lint       # ESLint，要求 0 warnings
pnpm tsc        # TypeScript 类型检查
pnpm test       # Vitest 单次运行
pnpm build      # tsc -b && vite build
```

前端组件优先复用 `frontend/src/components/ui/` 中已有的 shadcn/ui 组件；开始前端任务前请先阅读 [frontend/AGENTS.md](frontend/AGENTS.md) 和 shadcn 相关约定。

### 开发文档

建议按以下顺序阅读：

1. [docs/FEATURES.md](docs/FEATURES.md)：功能 / 能力全景（写汇报 / 了解能做什么先读）；
2. [docs/DEVELOPER_QUICKSTART.md](docs/DEVELOPER_QUICKSTART.md)：环境配置、启动和常见问题；
3. [AGENTS.md](AGENTS.md)：代码规范、工作流和质量门禁；
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：系统边界、事件模型和数据契约；
5. [docs/TODO.md](docs/TODO.md)：开发任务与进度索引；
6. [PROBLEM.md](PROBLEM.md)：项目背景与评测要求。

## 未来规划

演进方向、待决问题、非目标与被否决方案见
[docs/architecture/roadmap.md](docs/architecture/roadmap.md)；当前开放任务（P0–P3、
Gold 受可信 Publication 验收）见 [docs/TODO.md](docs/TODO.md)。核心方向包括：把
非表达类研究主题（靶点 / 变异 / 结构 / 活性 / 文献 / 图表）接入受信任的多表
Publication（Canonical Evidence Product Layer），以及大型 GEO 矩阵的流式 / 资源上限
处理（均已在 roadmap / TODO 中记录，README 不重复维护）。

## 桌面 / 生产打包

正式分发产物是跨平台源码包（`frontend/dist` + `server/dist` + `database/` +
`.pi/skills`），由 TS Host 静态托管（`pnpm start`）。GitHub Actions 工作流
[`.github/workflows/package.yml`](.github/workflows/package.yml) 会在推送 `v*`
标签或手动触发时构建并上传该 bundle；不再使用 PyInstaller 单文件可执行文件。

## 安全与边界

- 任务文件访问限制在任务工作目录内，拒绝绝对路径、路径穿越和不安全符号链接。
- 下载工具限制协议、目标域名、文件大小和超时时间；未完成或校验失败的文件不会进入解析阶段。
- API Key 在设置 API 的读取响应中会被掩码；模型配置通过受控的设置存储管理。
- learned Skill 概念已退役；curated Skill 只能通过 Pi adapter 边界调用，且不能绕过 Dataset Core 与 Validation Gate。
- 任务终态、事件和 Artifact 校验结果必须由后端持久化状态决定，不能以 mock 成功替代真实流程失败。

## 相关文档

| 文档                                                        | 内容                                    |
| ----------------------------------------------------------- | --------------------------------------- |
| [docs/FEATURES.md](docs/FEATURES.md)                         | 功能 / 能力全景（对齐赛题评价维度，写汇报用） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | 权威架构、数据流、契约、事件和安全模型  |
| [docs/DEVELOPER_QUICKSTART.md](docs/DEVELOPER_QUICKSTART.md) | 开发环境、启动、测试和 AI-Native 工作流 |
| [docs/architecture/roadmap.md](docs/architecture/roadmap.md) | 演进方向、待决问题、非目标、被否决方案  |
| [docs/TODO.md](docs/TODO.md)                                 | 开发任务与进度索引                      |
| [PROBLEM.md](PROBLEM.md)                                     | 赛题背景、目标和评价标准                |
| [frontend/README.md](frontend/README.md)                     | 前端组件、状态管理、数据流与测试        |
| [docs/migration/](docs/migration/)                           | 历史迁移执行记录（Phase 0-8，已完成）   |

## 许可证

仓库当前未声明独立开源许可证。若要对外发布，请先补充许可证文件及第三方依赖声明。
