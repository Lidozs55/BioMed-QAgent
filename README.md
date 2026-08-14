# BioMed-QAgent

BioMed-QAgent 是一个面向生物医学研究数据的 **Agent + 确定性 Pipeline** 应用：用户用自然语言描述研究主题，系统负责检索文献与数据集、获取原始文件、解析和清洗数据、完成字段对齐，并生成带来源、校验信息和处理记录的结构化产物。

项目的目标是让数据处理过程**可追溯、可验证、可恢复**，而不是让大语言模型直接“猜”出一个 CSV。系统可以展示统计结果和可视化数据，但不会在缺少数据证据时生成科研或临床结论。

> 项目正依据 [Pi 迁移方案](docs/BioMed-QAgent_Pi_Migration_Plan.md) 执行迁移：
> **Phase 0–8 全部完成（2026-08-14）**。唯一正式拓扑为
> `TS Host + Pi Agent + TS Dataset Core`：正式 `/api/v1`、durable runtime、
> Dataset Core 均由 TypeScript 权威实现；Python 仅剩 `database/` persistence
> bridge（JSONL named-op）。legacy FastAPI / rollback profile / feature flags
> 已全部退役。进度跟踪见 [docs/TODO.md](docs/TODO.md)，实际边界以代码及
> [架构文档](docs/ARCHITECTURE.md) 为准。

## 核心能力

- **自然语言研究任务**：从主题、关键词、数据库、目标字段和时间范围生成结构化任务规格。
- **多源检索与获取**：通过可插拔 Skill 访问 PubMed、GEO 等生物医学数据源，记录 accession、来源关系、下载尝试和文件校验信息。
- **确定性数据处理**：按固定阶段执行 Discovery → Acquisition → Processing → Artifact Build → Validation Gate。
- **可验证交付物**：只有通过 Validation Gate 的文件才会发布到 `artifacts/` 并通过 API 暴露。
- **Durable Task Runtime**：任务、Run、消息、事件和产物状态持久化，支持取消、恢复、事件重放以及人在回路（HITL）暂停/继续。
- **实时进度反馈**：前端通过 REST + WebSocket 接收 Agent 文本、工具调用、Pipeline 阶段、进度、警告和产物事件。
- **模型与 curated Skills**：支持通过设置 API 配置 OpenAI 兼容模型；Pi 按任务加载
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

legacy Agent、Python Core 或 experimental Pi 均已退役：不再有 private
loopback FastAPI，产品路径不启动任何 Python Web Server。

职责边界如下：

- **formal Agent** 由 Pi + TS durable runtime 持有（`task_ts_*` Task/Run/Event）。
- **Dataset Core** 负责按照契约执行处理、记录审计信息、检查完整性，并拒绝未经验证的产物；Agent 不能直接制造 publication。
- **Skill** 是 instructions 与 Function Tools 的能力包，按 `discovery/`、`acquisition/`、`processing/`、`analysis/` 分类。
- **Runtime** 负责任务生命周期和事件持久化；前端状态是后端事件的投影，不是事实来源。
- **Python** 仅 `database/bridge.py`：SQLite/文件持久化 named-op，由 TS DatabaseClient 按需管理。

完整设计、状态模型和安全边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 迁移状态

项目正依据 [Pi 迁移方案](docs/BioMed-QAgent_Pi_Migration_Plan.md) 把 Agent Runtime
迁到 Pi、把 Dataset Core 迁到 TypeScript。当前进度：

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 0 | 冻结边界与迁移 ADR | ✅ 完成 |
| 1 | Pi Main Agent + TS Host + Workspace + Core bridge | ✅ 完成 |
| 2 | Skills 与通用 Agent 工具迁移 | ✅ 完成 |
| 3 | TS Application Runtime（durable Task/Run/Event） | ✅ 完成（Phase 7 已转默认） |
| 4 | Dataset Deterministic Core TS 移植（steps 1-10 + parity） | ✅ 完成（M2 已接入运行路径） |
| 5 | 外部能力与 Python 数据处理依赖迁移 | ✅ 完成（2026-08-14；Python 仅回滚 + DB bridge） |
| 6 | 模型设置与 Settings API | ✅ 完成 |
| 7 | 前端正式切换与 FastAPI 默认关闭 | ✅ 完成（2026-08-14） |
| 8 | 删除 legacy Python Runtime（物理退役） | ✅ 完成（2026-08-14） |

Phase 0/1 执行细节见
[docs/BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md](docs/BioMed-QAgent_Pi_Migration_Phase0_1_Detailed.md)
与 [docs/migration/](docs/migration/)；Phase 3 边界与回滚见
[docs/migration/phase3-ts-application-runtime.md](docs/migration/phase3-ts-application-runtime.md)；
Phase 4 TS 代码在 `server/src/dataset/`，证据见 `.superpowers/phase4/T1-T10-report.md`；
进度与剩余工作跟踪见 [docs/TODO.md](docs/TODO.md)。

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
MODEL_NAME=qwen-plus
```

若使用 NCBI E-utilities，建议同时填写真实的 `NCBI_EMAIL` 和 `NCBI_USER_AGENT`。完整变量说明见 [.env.example](.env.example)。

安装 Python（database bridge 项目）与根 pnpm Workspace 依赖：

```bash
uv sync
pnpm install --frozen-lockfile
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

所有 REST 路由统一使用 `/api/v1` 前缀。

| 方法               | 路径                                                | 用途                                      |
| ------------------ | --------------------------------------------------- | ----------------------------------------- |
| `GET`            | `/api/v1/health`                                  | 健康检查                                  |
| `GET`            | `/api/v1/databases`                               | 列出可选数据库                            |
| `GET` / `POST` | `/api/v1/tasks`                                   | 查询任务 / 创建任务并排队首个 Run         |
| `GET`            | `/api/v1/tasks/{task_id}`                         | 获取权威任务快照                          |
| `DELETE`         | `/api/v1/tasks/{task_id}`                         | 删除终态任务及其历史                      |
| `POST`           | `/api/v1/tasks/{task_id}/runs`                    | 为 idle Agent Task 排队下一轮 Run         |
| `POST`           | `/api/v1/tasks/{task_id}/runs/{run_id}/cancel`    | 请求取消 Run                              |
| `POST`           | `/api/v1/tasks/{task_id}/runs/{run_id}/resume`    | 提交人在回路决策                          |
| `GET`            | `/api/v1/tasks/{task_id}/messages`                | 分页读取任务消息                          |
| `GET`            | `/api/v1/tasks/{task_id}/events`                  | 按 sequence 重放 durable events           |
| `GET`            | `/api/v1/tasks/{task_id}/artifacts`               | 列出已验证产物                            |
| `GET`            | `/api/v1/tasks/{task_id}/artifacts/{artifact_id}` | 下载并校验指定产物                        |
| `GET` / `POST` | `/api/v1/settings`                                | 读取 / 持久化模型设置，返回时掩码 API Key |
| `GET`            | `/api/v1/vendors`                                 | 列出已知模型供应商                        |
| `GET`            | `/api/v1/models`                                  | 发现或筛选可用模型                        |
| `GET`            | `/api/v1/models/{model_id}`                       | 获取单个模型详情                          |
| `GET`            | `/api/v1/skills`                                  | 列出内置和用户 Skill                      |

Skill 管理 API 还提供启用、禁用、上传、校验和删除操作，详见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与代码。

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
├── server/                 # TS Host、Pi adapter、Workspace、durable Phase 3 runtime、legacy proxy
├── packages/contracts/     # 前端/Host 共享 wire DTO
├── .pi/skills/             # curated Skills（SKILL.md）
├── database/               # Python persistence bridge（stdlib，named-op JSONL）
├── tests/                  # 共享 golden fixtures（fixtures/、migration/）
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
│   ├── DEVELOPER_QUICKSTART.md # 开发者快速入门
│   ├── TODO.md                # 迁移主线进度与未完成项
│   └── migration/             # Pi 迁移 Phase 0/1/3 边界与验收文档
├── AGENTS.md                  # AI Agent 与协作约定
├── PROBLEM.md                 # 赛题背景与评价标准
└── .env.example               # 环境变量模板
```

## 技术栈

| 层级           | 技术                                                   |
| -------------- | ------------------------------------------------------ |
| Application Host | Node.js 22.19+、TypeScript、Vite                     |
| Agent          | Pi + TS durable runtime（默认）；OpenAI Agents SDK（回滚） |
| Dataset Core   | TypeScript deterministic core；Python V2（回滚）       |
| Python         | DB bridge；FastAPI/uvicorn legacy rollback             |
| 前端           | React 19、Vite、TypeScript、Tailwind CSS v4、shadcn/ui |
| 状态与数据展示 | Zustand、React Markdown、PapaParse                     |
| 测试           | pytest、pytest-asyncio、Vitest、Testing Library        |
| 工具链         | uv、pnpm、ruff、ESLint                                 |

## 配置参考

`.env.example` 是配置入口。常用变量如下：

| 变量                   | 默认值                        | 说明                                            |
| ---------------------- | ----------------------------- | ----------------------------------------------- |
| `DASHSCOPE_API_KEY`  | 空                            | DashScope API Key；使用真实 Agent / Qwen 时需要 |
| `DASHSCOPE_BASE_URL` | DashScope OpenAI 兼容地址     | 模型服务的 OpenAI 兼容 base URL                 |
| `MODEL_NAME`         | `qwen-plus`                 | 默认模型名                                      |
| `NCBI_EMAIL`         | `biomed-qagent@example.com` | NCBI E-utilities 联系邮箱                       |
| `NCBI_TOOL`          | `BioMedQAgent`              | NCBI E-utilities tool 名称                      |
| `NCBI_API_KEY`       | 空                            | 可选的 NCBI API Key                             |
| `HOST` / `PORT`      | `127.0.0.1` / `5173`        | TS Host 唯一公开监听地址                        |
| `BIOMED_PYTHON_BIN`  | 自动探测                     | database bridge 解释器（默认 repo/.venv 或 PATH）|
| `PI_PROVIDER` / `PI_MODEL` | `dashscope` / `MODEL_NAME` | Pi provider 与模型选择                    |
| `PI_API_KEY` / `PI_BASE_URL` | 回退 DashScope 配置    | Pi credentials；不要提交真实密钥                |
| `WORKSPACE_DEV_EXEC` | `0`                         | 受控开发命令 gate                               |
| `SHUTDOWN_TIMEOUT_MS` | `10000`                     | 回收超时                                        |
| `OUTPUT_DIR`         | `data/output`               | 覆盖时必须使用绝对路径                          |
| `LOG_LEVEL`          | `INFO`                      | 日志级别                                        |

模型设置也可以通过 `/api/v1/settings` 持久化到 `data/user_settings.json`。保存的用户设置会在 Run 创建时形成不可变快照，避免并发运行中的配置变更影响已开始的任务。

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
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

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

1. [docs/DEVELOPER_QUICKSTART.md](docs/DEVELOPER_QUICKSTART.md)：环境配置、启动和常见问题；
2. [docs/migration/ENVIRONMENT_MIGRATION.md](docs/migration/ENVIRONMENT_MIGRATION.md)：从旧双入口环境迁移到 root pnpm Workspace 与单 Host；
3. [AGENTS.md](AGENTS.md)：代码规范、工作流和质量门禁；
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：系统边界、事件模型和数据契约；
5. [docs/TODO.md](docs/TODO.md)：迁移主线进度与未完成工作；
6. [PROBLEM.md](PROBLEM.md)：项目背景与评测要求。

## 桌面 / 生产打包

Phase 8 起不再有 PyInstaller 单文件可执行文件：正式产物是跨平台源码包
（`frontend/dist` + `server/dist` + `database/` + `.pi/skills`），由 TS Host
静态托管（`pnpm start`）。GitHub Actions 工作流
[`.github/workflows/package.yml`](.github/workflows/package.yml) 会在推送 `v*`
标签或手动触发时构建并上传该 bundle。

## 安全与边界

- 任务文件访问限制在任务工作目录内，拒绝绝对路径、路径穿越和不安全符号链接。
- 下载工具限制协议、目标域名、文件大小和超时时间；未完成或校验失败的文件不会进入解析阶段。
- API Key 在设置 API 的读取响应中会被掩码；模型配置通过受控的设置存储管理。
- learned Skill 概念已退役；curated Skill 只能通过 Pi adapter 边界调用，且不能绕过 Dataset Core 与 Validation Gate。
- 任务终态、事件和 Artifact 校验结果必须由后端持久化状态决定，不能以 mock 成功替代真实流程失败。

## 相关文档

| 文档                                                        | 内容                                    |
| ----------------------------------------------------------- | --------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | 权威架构、数据流、契约、事件和安全模型  |
| [docs/BioMed-QAgent_Pi_Migration_Plan.md](docs/BioMed-QAgent_Pi_Migration_Plan.md) | Pi 迁移总体方案（Phase 0-8，已完成） |
| [docs/migration/README.md](docs/migration/README.md)         | 迁移边界文档索引（Phase 8 状态见其中说明） |
| [docs/migration/phase8-python-runtime-retirement.md](docs/migration/phase8-python-runtime-retirement.md) | Phase 8 执行计划（historical） |
| [docs/migration/PHASE8_FINAL_VERIFICATION.md](docs/migration/PHASE8_FINAL_VERIFICATION.md) | Phase 8 最终验证报告 |
| [docs/DEVELOPER_QUICKSTART.md](docs/DEVELOPER_QUICKSTART.md) | 开发环境、启动、测试和 AI-Native 工作流 |
| [docs/TODO.md](docs/TODO.md)                                 | P0/P1/P2 开发任务与架构决策             |
| [PROBLEM.md](PROBLEM.md)                                     | 赛题背景、目标和评价标准                |
| [frontend/README.md](frontend/README.md)                     | 前端组件、状态管理、数据流与测试        |

## 许可证

仓库当前未声明独立开源许可证。若要对外发布，请先补充许可证文件及第三方依赖声明。
