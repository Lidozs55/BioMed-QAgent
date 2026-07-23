# BioMed-QAgent 开发者快速入门指南

> **🤖 如果你的电脑上安装了任何 AI Agent 框架（如 Claude Code、Copilot Chat、Cursor、Cline 等），直接把本文件丢给它，让它给你省流 —— 它会自动帮你完成环境配置、依赖安装和项目启动。**

---

## 目录

1. [项目是什么](#1-项目是什么)
2. [第一步：装好工具链](#2-第一步装好工具链)
3. [第二步：克隆并配置](#3-第二步克隆并配置)
4. [第三步：启动后端](#4-第三步启动后端)
5. [第四步：启动前端](#5-第四步启动前端)
6. [第五步：跑起来看看](#6-第五步跑起来看看)
7. [AI-Native 开发指南](#7-ai-native-开发指南)
8. [常用命令速查](#8-常用命令速查)
9. [项目骨架一览](#9-项目骨架一览)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 项目是什么

BioMed-QAgent 是一个**生物医学数据智能检索与整合系统**。你说一个研究主题（比如"我想研究 PD-L1 在非小细胞肺癌中的表达"），它会自动：

1. 检索相关论文（PubMed）
2. 找到论文里提到的数据库编号（GEO、GDC、PDB 等）
3. 下载原始数据
4. 解析、清洗、字段对齐
5. 输出一份整理好的 CSV，附带数据来源和处理记录

技术上是 **Python 后端 + React 前端**，AI 部分基于阿里的**通义千问（Qwen）**大模型。

> 这是"中国高校计算机大赛 — AI Scientist 赛道"的参赛作品（赛题 XH-202619）。

---

## 2. 第一步：装好工具链

### 2.1 你需要装什么

| 工具 | 用途 | 必须？ |
|------|------|--------|
| **Python 3.12+** | 后端语言 | ✅ 必须 |
| **uv** | Python 包管理器（类似 pip 但更快） | ✅ 必须 |
| **Node.js 18+** | 前端运行时 | ✅ 必须 |
| **pnpm** | Node 包管理器（类似 npm 但更快） | ✅ 必须 |
| **DashScope API Key** | 调用千问大模型 | ✅ 必须 |
| Git | 版本控制 | 推荐 |

### 2.2 安装 Python 3.12+

**如果你还没装 Python**，去官网下载：https://www.python.org/downloads/

安装时 **一定要勾选 "Add Python to PATH"**（加到系统环境变量）。

装完后打开终端（PowerShell 或 CMD），验证一下：

```powershell
python --version
# 应该输出类似：Python 3.12.x
```

### 2.3 安装 uv（Python 包管理器）

uv 是新一代 Python 包管理器，比 pip 快 10-100 倍。本项目**必须用 uv**，不要用 pip。

**Windows（PowerShell）：**

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

**macOS / Linux：**

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

装完后**关闭并重新打开终端**，验证：

```powershell
uv --version
# 应该输出类似：uv 0.x.x
```

> 💡 如果提示"找不到 uv"，说明没加到 PATH。重启电脑试试，或者手动把 `%USERPROFILE%\.cargo\bin` 加到系统环境变量 PATH 中。

### 2.4 安装 Node.js 18+

去官网下载 LTS 版本：https://nodejs.org/

装完后验证：

```powershell
node --version
# 应该输出类似：v18.x.x 或 v20.x.x
```

### 2.5 安装 pnpm（Node 包管理器）

pnpm 是高效的 Node 包管理器，本项目**必须用 pnpm**，不要用 npm 或 yarn。

```powershell
npm install -g pnpm
```

装完后验证：

```powershell
pnpm --version
# 应该输出类似：9.x.x
```

### 2.6 获取 DashScope API Key

1. 打开 https://dashscope.aliyun.com/ （阿里云百炼平台）
2. 注册/登录阿里云账号
3. 在控制台找到 "API Key 管理"，创建一个新的 API Key
4. 复制保存好这个 Key（只显示一次！）

> 💡 千问部分模型有免费额度，qwen-plus 对比赛够用了。

---

## 3. 第二步：克隆并配置

### 3.1 克隆仓库

```powershell
git clone <仓库地址> BioMed-QAgent
cd BioMed-QAgent
```

### 3.2 配置环境变量

项目根目录已经有一个 `.env.example` 模板文件。你需要把它复制一份：

```powershell
copy .env.example .env
```

然后编辑 `.env` 文件，**至少填上你的 API Key**：

```ini
# 把这一行改成你自己的 Key
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

其他配置项保持默认即可，后面需要再改。

---

## 4. 第三步：启动后端

```powershell
# 进入后端目录
cd backend

# 安装 Python 依赖（uv 会自动创建虚拟环境）
uv sync

# 启动开发服务器
uv run uvicorn app.main:app --reload
```

看到类似输出就说明启动成功了：

```
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete.
```

> 💡 `--reload` 表示代码改动后自动重启，开发时很方便。

验证后端是否正常：

- 浏览器打开 http://127.0.0.1:8000/docs — 能看到 Swagger API 文档就对了
- 或者 http://127.0.0.1:8000/api/v1/health — 返回 `{"status":"ok"}`

### 4.1 Windows 自动启动 smoke test

自动化脚本需要启动后端、请求 health endpoint，并在结束时可靠关闭进程。请在
`backend/` 目录使用项目虚拟环境的 Python 直接启动 Uvicorn：

```powershell
$process = Start-Process `
  -FilePath ".\.venv\Scripts\python.exe" `
  -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8017") `
  -PassThru

try {
  $deadline = (Get-Date).AddSeconds(30)
  $response = $null

  do {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-RestMethod `
        -Uri "http://127.0.0.1:8017/api/v1/health" `
        -TimeoutSec 2
    } catch {
      if ($process.HasExited) {
        throw "Uvicorn exited early with code $($process.ExitCode)"
      }
    }
  } while (($null -eq $response) -and ((Get-Date) -lt $deadline))

  if ($null -eq $response) {
    throw "Health check timed out"
  }

  $response | ConvertTo-Json -Compress
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit()
  }
}
```

不要在 Windows 自动 smoke test 中使用
`Start-Process uv -ArgumentList "run", "uvicorn", ...`。`uv run` 是包装进程，
Uvicorn 子进程可能在 health 请求成功后继续存活，使脚本卡住并需要手动关闭。
交互式开发仍可正常使用 `uv run uvicorn app.main:app --reload`。

---

## 5. 第四步：启动前端

**另开一个终端**（后端那个不要关）：

```powershell
# 进入前端目录
cd frontend

# 安装 Node 依赖
pnpm install

# 启动开发服务器
pnpm dev
```

看到类似输出就成功了：

```
VITE v5.x.x  ready in xxx ms
➜  Local:   http://localhost:5173/
```

浏览器打开 http://localhost:5173 就能看到界面了。

> 💡 前端自动把 `/api` 请求代理到后端 `http://127.0.0.1:8000`，所以不用担心跨域问题。

---

## 6. 第五步：跑起来看看

### 6.1 跑个 demo 脚本（纯后端）

```powershell
cd backend
uv run python scripts/demo_workflow.py
```

这个脚本会走一遍完整的 Agent 工作流，生成的数据在 `backend/data/output/` 下。

### 6.2 跑测试

```powershell
cd backend
uv run pytest                     # 跑全部测试（跳过联网测试）
uv run pytest -m live             # 跑联网测试（需要 API Key）
uv run pytest -k "skill"          # 只跑名字含"skill"的测试

cd frontend
pnpm test                         # 跑前端单元测试
```

---

## 7. AI-Native 开发指南

这个项目是按照 **AI-Native 开发范式**设计的。什么是 AI-Native？简单说就是：**写代码的时候让 AI 帮你，但你要知道怎么指挥它**。

### 7.1 用 shadcn/ui Skill 做前端

项目前端基于 **shadcn/ui** 组件库（基于 Tailwind CSS v4）。我们已经在仓库里配置了 shadcn skill（见 `skills-lock.json`）。

**核心原则：永远不要自己手写 UI 组件，先用 shadcn skill 搜索有没有现成的。**

当你要加一个前端组件时：

1. **先搜**：在你的 AI 工具中，让 Agent 用 shadcn skill 搜索相关组件
2. **再装**：找到合适的就用 `pnpm shadcn add <组件名>` 安装
3. **最后改**：在已有组件基础上微调，不要从零写

```bash
# 安装 shadcn 组件示例
cd frontend
pnpm shadcn add button     # 按钮
pnpm shadcn add dialog     # 弹窗
pnpm shadcn add table      # 表格
pnpm shadcn add card       # 卡片
```

项目中已有的 shadcn 组件在 `frontend/src/components/ui/`，**先看看有没有类似的再装新的**。

> ⚠️ 前端 `AGENTS.md` 明确写了规则：**必须使用 shadcn 的 skills 进行工作，检索相关组件，而不要自己重复造轮子。**

### 7.2 让 Agent 读 AGENTS.md

项目根目录的 `AGENTS.md` 是给 AI Agent 看的项目守则。里面写了：

- 技术栈约束（Python 3.12+ / React 19 / shadcn / Tailwind v4）
- 架构规则（Agent → Pipeline 两层结构）
- 代码规范（必须类型标注、不允许 `as any` 等）
- 常用命令

**你应该做的**：每次开始一个新任务时，告诉你的 AI 工具"先读一下 AGENTS.md 和 docs/ARCHITECTURE.md"，它就能自动遵守项目规范。

### 7.3 Skill 系统 —— 项目的核心设计

这个项目不仅仅是"调 API 的 chatbot"。它有一套 **Skill 系统**，把各种生物医学数据库的检索、下载、处理能力打包成标准化的 Skill：

```
backend/app/skills/
├── builtin/          # 内置 Skill（团队维护）
│   ├── discovery/    # 文献检索（PubMed 等）
│   ├── acquisition/  # 数据下载（GEO、GDC、PDB 等）
│   ├── processing/   # 数据处理（表格提取、图表识别等）
│   └── analysis/     # 数据分析（统计、可视化）
└── learned/          # AI 自进化 Skill（默认禁用）
```

每个 Skill = 一段 Instructions（告诉 Agent 怎么用）+ 一组 Function Tools（实际执行的代码）。

**如果你想加一个新的数据库来源**：参考 `backend/app/skills/builtin/` 下已有的 Skill（比如 `skill_pubchem.py`），照猫画虎写一个新的就行。

### 7.4 Agent + Pipeline 双层架构

这是项目的关键设计，理解它你就能看懂代码了：

```text
用户输入主题
    │
    ▼
Main Agent（大模型）
    │ 理解意图 → 选 Skill → 生成 TaskSpecification
    │
    ▼
Pipeline Runner（确定性代码）
    │ Discovery → Acquisition → Processing → Artifact → Validation
    │
    ▼
输出：CSV + 来源清单 + 处理记录
```

- **Agent（大模型）**：负责理解用户意图、做决策
- **Pipeline（普通代码）**：负责严格执行数据处理。Agent 不能跳过任何步骤，也不能直接造 CSV

这样设计的原因是：大模型擅长理解，但可能"偷懒"跳过关键步骤。Pipeline 保证了数据处理的可靠性。

### 7.5 用 Playwright 做网页截图（视觉数据提取）

项目中有一个高级功能：用 Playwright 控制无头浏览器对论文页面截图，然后送给 Qwen-VL 视觉模型提取图表数据。代码在 `backend/app/skills/builtin/acquisition/web_visual_capture.py`。

如果你要调试这个功能，需要安装 Playwright 浏览器：

```powershell
cd backend
uv run playwright install chromium
```

### 7.6 推荐的 AI 开发工作流

```text
1. 打开 AGENTS.md + docs/ARCHITECTURE.md → 让 AI 理解项目
2. 描述你要做的功能 → AI 建议改哪些文件
3. AI 写代码 → 你 review → 跑测试验证
4. 提交前让 AI 跑一遍 lint + test
```

> 💡 这个项目已经配好了 `opencode.json`，如果你用 OpenCode 或 Commonly 等 Agent 框架，它们会自动读取项目配置。

---

## 8. 常用命令速查

### 后端（在 `backend/` 目录下执行）

| 命令 | 作用 |
|------|------|
| `uv sync` | 安装/同步 Python 依赖 |
| `uv run uvicorn app.main:app --reload` | 启动开发服务器 |
| `uv run pytest` | 跑测试（跳过联网） |
| `uv run pytest -m live` | 跑联网测试 |
| `uv run pytest -k "关键词"` | 按名称过滤测试 |
| `uv run ruff check app/ tests/` | 代码检查（lint） |

### 前端（在 `frontend/` 目录下执行）

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装 Node 依赖 |
| `pnpm dev` | 启动 Vite 开发服务器 |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 代码检查 |
| `pnpm tsc` | TypeScript 类型检查 |
| `pnpm test` | 跑单元测试 |
| `pnpm shadcn add <组件名>` | 安装 shadcn 组件 |

---

## 9. 项目骨架一览

```
BioMed-QAgent/
├── AGENTS.md              # 🔑 AI Agent 守则（先读这个！）
├── PROBLEM.md             # 赛题说明
├── README.md              # 项目简介
├── .env.example           # 环境变量模板
├── skills-lock.json       # Skill 版本锁定
│
├── backend/               # Python 后端
│   ├── pyproject.toml     # 项目配置 + 依赖
│   ├── uv.lock            # 依赖锁文件
│   └── app/
│       ├── main.py        # FastAPI 入口
│       ├── config.py      # 配置（从 .env 读取）
│       ├── agent_loop/    # Agent 循环（创建、运行、模型适配）
│       ├── api/           # HTTP 路由 + WebSocket
│       ├── core/          # 核心工具
│       ├── domain/        # 数据模型（事件、契约等）
│       ├── pipeline/      # 确定性 Pipeline（5 阶段）
│       ├── skills/        # Skill 仓库
│       │   ├── builtin/   #   内置 Skill
│       │   └── learned/   #   自进化 Skill
│       ├── tools/         # Function Tools
│       └── integrations/  # 外部服务集成（NCBI 等）
│
├── frontend/              # React 前端
│   ├── package.json       # 项目配置 + 依赖
│   ├── vite.config.ts     # Vite 构建配置
│   ├── components.json    # shadcn/ui 配置
│   └── src/
│       ├── components/    # 业务组件 + ui/（shadcn 组件）
│       ├── hooks/         # 自定义 Hook
│       ├── stores/        # Zustand 状态管理
│       ├── styles/        # Tailwind CSS
│       └── lib/           # 工具函数
│
├── docs/                  # 文档
│   ├── ARCHITECTURE.md    # 🔑 架构设计（权威参考）
│   ├── TODO.md            # 开发计划
│   └── superpowers/       # 详细设计文档
│
├── tests/                 # Python 测试
└── scripts/               # 工具脚本
```

---

## 10. 常见问题排查

### Q: `uv sync` 报错 "Python 3.12+ required"

你的 Python 版本太低。装 Python 3.12 或更新版本。用 `python --version` 确认。

### Q: `pnpm install` 报错 "pnpm not found"

你没装 pnpm。回头参考 [2.5 节](#25-安装-pnpmnode-包管理器) 安装。

### Q: 启动后端报 "DASHSCOPE_API_KEY not set"

你没配置 `.env` 文件。参考 [3.2 节](#32-配置环境变量)。

### Q: 前端页面打开了但是空白/报网络错误

1. 确认后端已启动（http://127.0.0.1:8000/docs 能打开）
2. 确认前端代理配置正确（`vite.config.ts` 里的 proxy 指向后端地址）
3. 打开浏览器开发者工具（F12）→ Network 面板看请求状态

### Q: Windows 上运行 `uv run` 报编码错误

在 PowerShell 中先执行：

```powershell
$env:PYTHONUTF8 = "1"
```

或者把 `PYTHONUTF8=1` 加到系统环境变量。

### Q: Playwright 截图功能报 "Executable doesn't exist"

需要安装 Chromium 浏览器：

```powershell
cd backend
uv run playwright install chromium
```

### Q: 提示 `uv` 不是系统命令

关掉终端重新打开。如果还不行，手动把 `%USERPROFILE%\.cargo\bin` 加到 PATH。

---

> **📌 最后提醒：本项目配有完整的 AGENTS.md，你的 AI 工具能自动理解项目规则。遇到问题，先把 AGENTS.md 和 docs/ARCHITECTURE.md 丢给 AI，让它帮你定位。**
