# BioMed-QAgent

BioMed-QAgent 面向生物医学开放数据，把自然语言需求转化为可追溯、可验证、可下载的标准化数据集。Pi Agent 负责意图、来源发现和规格生成，确定性的 TypeScript Dataset Core 负责获取、解析、整合、验证和不可变发布。

当前正式拓扑是单个 TypeScript Application Host：同一端口提供 React/Vite、`/api/v1` HTTP、durable WebSocket、Pi Agent、Dataset Core 和设置 API。Python 只保留 `database/bridge.py` 持久化桥；不存在 FastAPI、Python Dataset Core、`/experimental/pi` 或 rollback feature flags。

## 项目状态

- **工程基线：** TypeScript Host、Pi adapter、durable runtime、Dataset Core、React 前端和 Python persistence bridge 已形成单一主线拓扑。
- **当前阶段：** Family Host/Core 的显式 `in_process_unisolated` publication chain 已进入稳定基线；仍在进行 release evidence、identity/recovery hardening 和产品闭包。
- **发布判断：** 稳定主线不等于 release gate 已通过。当前开放项与验收条件只在 [`docs/TODO.md`](docs/TODO.md) 维护，已知缺陷只在 [`docs/ISSUES.md`](docs/ISSUES.md) 维护。
- **历史边界：** `docs/archive/` 与 `docs/migration/` 仅供追溯，不代表当前行为。

## 项目与文档入口

本 README 是仓库的统一首入口。下面直接导航到各类权威信息；更细的文档职责、生命周期和归档规则见 [`docs/README.md`](docs/README.md)。

| 想了解                  | 入口                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| 产品目标与评分要求      | [`PROBLEM.md`](PROBLEM.md)                                           |
| 现行技术架构            | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                       |
| 功能与能力全景          | [`docs/FEATURES.md`](docs/FEATURES.md)                               |
| 本地开发                | [`docs/DEVELOPER_QUICKSTART.md`](docs/DEVELOPER_QUICKSTART.md)       |
| 当前任务 / 已知问题     | [`docs/TODO.md`](docs/TODO.md) / [`docs/ISSUES.md`](docs/ISSUES.md) |
| Agent API 调用          | [`docs/AGENT_API_QUICKSTART.md`](docs/AGENT_API_QUICKSTART.md)       |
| ADR、专题章节及历史归档 | [`docs/README.md`](docs/README.md)                                   |

## 核心边界

- 一个 dataset requirement 只有一个主数据 family 和一种 row granularity；复合需求拆为多个 requirement。
- Agent 提交计划和受控规格，不直接制造科研值，也不能决定发布阈值。
- SourceAsset、内容 hash、兼容性门、Validation Profile、provenance closure 和原子发布由 Core 强制执行。
- `RunStatus`、`OperationResult`、`ValidationResult`、`ProductAssessment` 与 `DatasetPublication` 各有独立职责。
- 正式产物只由 manifest 声明；workspace 文件、Transform output 或历史 artifact 不能绕过 Core 成为 Publication。
- 动态 Family Host 仅支持显式 `in_process_unisolated` 路线。它不是 sandbox 或安全边界；`node:vm` 只提供同步 timeout。

完整定义和决策依据见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/adr/README.md`](docs/adr/README.md)。

## 快速开始

要求：Node.js 22.19+、pnpm 11.14、Python 3.12+、uv、Git。

### 环境要求

| 组件            | 要求                                                              |
| --------------- | ----------------------------------------------------------------- |
| Python          | 3.12+（仅`database/` persistence bridge 需要）                  |
| Node.js         | 22.19+                                                            |
| Python 包管理器 | [uv](https://docs.astral.sh/uv/)（`uv sync` 安装 database 项目） |
| Node 包管理器   | [pnpm](https://pnpm.io/)（不要使用 npm）                           |
| LLM             | DashScope API Key，或其他 OpenAI 兼容模型配置                     |
| 可选            | Playwright Chromium，用于网页视觉证据采集                         |

### 1. 配置应用

Windows 首次打开终端时先初始化 UTF-8 环境，避免 PowerShell/cmd/Git Bash 的系统代码页（常见为 GBK）损坏中文 JSON、Python 输出或 Agent steer 文本：

**PowerShell（仅当前终端）：**

```powershell
. .\scripts\utf8-init.ps1
```

**cmd（仅当前终端）：**

```bat
call scripts\utf8-init.cmd
```

脚本设置 code page 65001、`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`LANG/LC_ALL=C.UTF-8`。`pnpm dev` 本身仍使用 Node UTF-8 API；服务端还会拒绝包含 U+FFFD 或非法 surrogate 的 task/steer 文本，防止损坏指令继续执行。

完成上述初始化后直接安装并启动：

```bash
git clone <repository-url>
cd BioMedQAgent
pnpm install --frozen-lockfile
uv sync
pnpm dev
```

首次打开页面后，在右上角 **设置 → 模型** 中添加 Provider 和 API key、添加并激活主模型，并为 Gold6 等视觉任务选择具备图像能力的视觉模型。模型配置只写入本机 `data/settings/model-registry.json` 与权限收紧的 `model-auth.json`，不会从环境变量自动引导；不要提交这两个运行期文件或打印其中凭据。

Host 首选 `http://127.0.0.1:5173`；若端口已被占用，则由操作系统分配可用端口，实际地址以启动输出 `BIOMED_QAGENT_URL=...` 为准。根 `.env` 不是必需项，只用于 `HOST`、`PORT`、`BIOMED_PYTHON_BIN` 等可选部署覆盖，不用于模型凭据。`pnpm dev` 是唯一正常开发入口，`dev:frontend-standalone` 只用于迁移/诊断。

生产构建与启动：

```bash
pnpm build
pnpm start
```

生产静态入口按当前 OS 用户禁止多开；已有实例时第二次 `pnpm start` 会提示已在运行并正常退出，不启动第二个 Host。

详细安装、Windows smoke test 和故障排查见 [`docs/DEVELOPER_QUICKSTART.md`](docs/DEVELOPER_QUICKSTART.md)。

## 质量门

默认**定向测试**：只测改动涉及的区域，不要每次提交都跑全量。

```bash
# 定向测试（按改动区域选择）
pnpm --filter @biomed/server test     # server/ 改动
pnpm --filter @biomed/frontend test   # frontend/ 改动
uv run python database/bridge.py --self-test   # database/ 改动时，连同下面两条
uv run pytest database/tests
uv run ruff check database

# 通用门（push / merge 前，workspace 级）
pnpm lint
pnpm typecheck
pnpm build

# 全量测试（仅跨共享边界改动：packages/contracts、根配置、scripts/；CI 会自动跑）
pnpm test
```

有失败测试时先只重跑失败用例（`pnpm --filter <pkg> test -- <test-file>` 或 `pytest <file>::<case>`），全部通过后再跑一次该区域定向测试确认。完整策略见 [`AGENTS.md`](AGENTS.md) § Quality Gates。

仓库使用单一 pnpm workspace lockfile。TypeScript 依赖只用 pnpm；Python 只服务根 `pyproject.toml` 下的 `database/` bridge，并用 uv 管理。测试并发策略见 [`docs/architecture/test-concurrency.md`](docs/architecture/test-concurrency.md)。

## 运行数据

默认数据根位于 `data/output/`：

```text
data/
├── workspaces/<task_id>/       # Agent staging workspace
└── output/tasks/<task_id>/
    ├── events.jsonl            # 追加写入的权威任务事实
    ├── snapshot.json           # 可由事件重建
    └── dataset_runs/<run_id>/<requirement_id>/
        └── publish/             # 不可变 Publication
```

Agent workspace 与 Core publication 物理分离。API 只暴露经 manifest 注册并通过 hash/验证门的正式 artifact。

## API 概览

- `GET /api/v1/health`：健康检查。
- `/api/v1/tasks`：创建、读取、续跑和删除终态任务。
- `/api/v1/tasks/{taskId}/events`：durable 事件重放。
- `/api/v1/ws`：实时事件；断线后仍以 HTTP replay 补齐。
- `/api/v1/publications`：发布与产品评估（ProductAssessment 在详情内，artifact 经 `/api/v1/publications/{id}/artifacts/{artifactId}` 下载）；任务产物另有 `/api/v1/tasks/{taskId}/artifacts`。
- `/api/v1/settings`：模型与应用设置，密钥始终掩码返回。

可执行调用示例、HIL 和终态处理见 [`docs/AGENT_API_QUICKSTART.md`](docs/AGENT_API_QUICKSTART.md)。

## 目录

```text
packages/contracts/    TypeScript wire DTO 的唯一来源
server/                TS Host、Pi adapter、durable runtime、Dataset Core
frontend/              React 19 + Vite + Tailwind v4 + shadcn/ui
database/              stdlib Python JSONL/SQLite persistence bridge
.pi/skills/            Agent curated skills
examples/families/     非生产 family 示例
docs/                  架构、指南、证据与历史记录
```

贡献前先阅读 [`AGENTS.md`](AGENTS.md)；前端改动还需阅读 [`frontend/AGENTS.md`](frontend/AGENTS.md)。

## 安全

不要提交 `.env`、API key、Commonly runtime token 或真实凭据。Agent 对 workspace 外的文件和命令访问经过 `allow / ask / deny` 权限系统；权限批准不改变 Core 的发布信任边界。

## License

见仓库分发包中的许可证文件（如适用）。
