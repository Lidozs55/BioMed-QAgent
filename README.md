# BioMed-QAgent

生物医学数据检索、下载、整理和呈现系统 —— 基于 Qwen 与 OpenAI Agents SDK 的多 Agent 协作框架。

用户提供研究主题，系统自动检索文献、下载原始数据、完成清洗与字段对齐，输出结构化 CSV 及其来源和处理记录。可选执行数据分析和可视化，但不生成缺少数据依据的科研或临床结论。

## 架构概览

```text
Frontend (React 19 / Vite / shadcn)
   │  WebSocket + REST
   ▼
FastAPI (uvicorn)
   │  Runner.run_streamed()
   ▼
Main Agent (Qwen / OpenAI Agents SDK)
   ├── Discovery Skill     文献检索与理解
   ├── Acquisition Skill   数据库检索与下载
   ├── Processing Skill    解析 → 清洗 → 对齐 → 合并
   └── Analysis Skill      统计与可视化（可选）
          │
          ▼
   任务工作目录
   raw → parsed → normalized → artifacts
```

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 环境要求

| 组件 | 版本要求 |
|------|----------|
| Python | 3.12+ |
| Node.js | 18+ |
| 包管理器 | [uv](https://docs.astral.sh/uv/) + [pnpm](https://pnpm.io/) |
| LLM | DashScope API Key（Qwen 系列） |

### 安装与启动

```bash
# 1. 后端
cd backend
cp .env.example .env          # 编辑 .env，填入 DASHSCOPE_API_KEY
uv sync
uv run uvicorn app.main:app --reload    # http://127.0.0.1:8000

# 2. 前端（另开终端）
cd frontend
pnpm install
pnpm dev                      # http://localhost:5173
```

启动后访问：
- 前端界面：http://localhost:5173
- API 文档 (Swagger)：http://127.0.0.1:8000/docs
- API 文档 (ReDoc)：http://127.0.0.1:8000/redoc

### 运行演示

```bash
cd backend
uv run python scripts/demo_workflow.py
```

## 项目结构

```
BioMed-QAgent/
├── backend/                    # Python 后端
│   ├── app/
│   │   ├── agent_loop/         # Agent 核心（创建、运行、上下文、模型适配）
│   │   ├── api/                # FastAPI 路由（REST + WebSocket）
│   │   ├── core/               # 核心工具（指标追踪等）
│   │   ├── domain/             # 领域模型（任务、事件、产出、处理）
│   │   ├── skills/             # Skill 仓库
│   │   │   ├── registry.py     # SkillRegistry 注册中心
│   │   │   ├── evolution.py    # 自迭代引擎
│   │   │   ├── builtin/        # 内置 Skill（9 个，团队维护）
│   │   │   └── learned/        # 后天 Skill（自迭代生成）
│   │   └── tools/              # Function Tools（I/O、解析、清洗、对齐、导出）
│   ├── tests/                  # pytest 测试（12 个文件）
│   ├── scripts/                # 工具脚本（demo_workflow.py）
│   ├── data/                   # 任务产出目录
│   ├── pyproject.toml          # Python 项目配置
│   └── uv.lock                 # 依赖锁文件
├── frontend/                   # React 前端
│   ├── src/
│   │   ├── components/         # 业务组件 + ui/（28 个 shadcn 组件）
│   │   ├── hooks/              # 自定义 Hook（WebSocket、API、主题）
│   │   ├── stores/             # Zustand 状态管理
│   │   ├── styles/             # Tailwind CSS v4 样式
│   │   └── lib/                # 工具函数
│   ├── package.json            # Node 项目配置
│   ├── pnpm-lock.yaml          # 依赖锁文件（使用 pnpm）
│   ├── vite.config.ts          # Vite 构建配置
│   └── components.json         # shadcn/ui 配置
├── docs/                       # 项目文档
│   ├── ARCHITECTURE.md         # 架构设计（权威参考）
│   └── TODO.md                 # 开发任务清单
├── AGENTS.md                   # AI Agent 工作流约定
└── .env.example                # 环境变量模板
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **后端框架** | Python 3.12+, FastAPI, uvicorn |
| **Agent SDK** | OpenAI Agents SDK（`openai-agents`） |
| **LLM** | Qwen 系列（DashScope OpenAI 兼容接口） |
| **数据模型** | Pydantic v2 + dataclass |
| **生物信息** | Biopython（Entrez/PubMed）、GEOparse |
| **科学计算** | matplotlib, scipy, seaborn |
| **前端框架** | React 19, TypeScript 5.6, Vite 5 |
| **UI 组件** | shadcn/ui (base-nova), Tailwind CSS v4 |
| **状态管理** | Zustand 4（持久化到 localStorage） |
| **图标** | lucide-react, @phosphor-icons/react |
| **测试** | pytest + pytest-asyncio（后端）, Vitest（前端） |
| **包管理** | uv（后端）, pnpm（前端） |

## 开发指南

### 后端开发

```bash
cd backend
uv sync                        # 安装依赖
uv run uvicorn app.main:app --reload  # 启动开发服务器
uv run pytest                  # 运行测试
uv run pytest -v               # 详细输出
```

### 前端开发

```bash
cd frontend
pnpm install                   # 安装依赖
pnpm dev                       # 启动开发服务器（:5173）
pnpm build                     # 构建生产版本
pnpm tsc                       # 类型检查
pnpm test                      # 运行测试
```

### Git 工作流

- 每完成一个任务 `commit + push` 一次
- Commit message 格式：`[TASK-XXX] 简述`
- 不 force push 到主分支
- 详见 [AGENTS.md](AGENTS.md) 中的完整约定

## 配置参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHSCOPE_API_KEY` | (空) | DashScope API Key（**必填**） |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点 |
| `MODEL_NAME` | `qwen-plus` | Qwen 模型名（也支持 qwen3.6-flash 等） |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `8000` | 后端监听端口 |
| `OUTPUT_DIR` | `data/output` | 数据产物输出目录 |

## 打包分发

### 概述

本项目以桌面应用形式分发，用户无需安装 Python、Node.js 或 pnpm。采用 PyInstaller 将后端打包为单个 exe 文件，前端静态文件内嵌于 exe 中。用户双击运行即可，无需配置环境，自动打开浏览器访问界面。

### 打包流程

```
前端构建 (pnpm build) → PyInstaller 打包 → 产出 .exe 文件
```

- 前端执行 `pnpm build`，生成静态文件到 `frontend/dist/`
- PyInstaller 将后端代码与静态文件一起打包为 `--onefile` 单文件 exe
- GitHub Actions 在推送 tag（如 `v1.0.0`）时自动触发打包构建

### 使用方式

1. 从项目的 [GitHub Releases](https://github.com/your-org/BioMed-QAgent/releases) 页面下载最新版本的 exe 文件
2. 双击运行，Windows 可能弹出「Windows 已保护你的电脑」提示，点击「仍要运行」即可
3. 程序自动启动后端服务并打开浏览器，访问 `http://localhost:8000`
4. 如浏览器未自动打开，手动访问 `http://localhost:8000` 即可
5. 关闭终端窗口即可退出程序

### 手动打包

如需在本地手动打包，确保已安装 PyInstaller 并在项目根目录执行：

```bash
# 1. 构建前端
cd frontend
pnpm build

# 2. 返回根目录，执行 PyInstaller
cd ..
pyinstaller --onefile --add-data "frontend/dist;dist" --add-data "backend/app;app" backend/launcher.py
```

打包产物位于 `dist/launcher.exe`。

### 启动参数

启动时支持通过环境变量控制服务参数：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | 监听地址（开发时可改为 `0.0.0.0`） |
| `PORT` | `8000` | 监听端口 |
| `DASHSCOPE_API_KEY` | (空) | API Key（**必填**） |

设置环境变量的方式：

```bash
# 单次运行
set HOST=0.0.0.0 && set PORT=8080 && launcher.exe
```

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整架构设计、Agent/Skill/Tool 体系、数据流、安全模型 |
| [docs/TODO.md](docs/TODO.md) | 开发任务清单（P0/P1/P2 优先级） |
| [AGENTS.md](AGENTS.md) | AI Agent 工作流约定、任务生命周期、文件锁协议 |
| [backend/README.md](backend/README.md) | 后端详细说明（API、Skill、测试、排查） |
| [frontend/README.md](frontend/README.md) | 前端详细说明（组件树、状态管理、数据流） |
| [backend/REPRODUCIBILITY.md](backend/REPRODUCIBILITY.md) | 可复现性指南（环境、演示、已知问题） |

## 待补充的内容建议

以下是在 README 体系中可以考虑补充的模块，当前尚未覆盖：

### 运维相关

- **日志与监控**：当前无结构化日志方案，可考虑添加 loguru 或 structlog
- **健康检查**：已有 `GET /api/v1/health`，可扩展为 readiness/liveness 探针
- **API 限流**：当前无速率限制，生产环境建议添加 slowapi 或 nginx 限流
- **数据备份策略**：`data/` 目录的定期备份方案

### 开发规范

- **代码格式化**：建议添加 ruff / black / isort（后端），ESLint / Prettier（前端）
- **Pre-commit hooks**：建议添加 `.pre-commit-config.yaml` 自动检查
- **类型检查**：前端已有 `tsc --noEmit`，后端可添加 `mypy` 严格模式

### 其他

- **Changelog**：按版本记录重要变更
- **FAQ**：常见问题与排查步骤
- **性能基准**：典型场景下的耗时参考（如 PubMed 检索 + GEO 下载 + 解析的端到端时间）
- **安全审计**：API Key 管理、文件访问控制、依赖漏洞扫描
