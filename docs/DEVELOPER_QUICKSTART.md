# BioMed-QAgent 开发者快速入门指南

> **🤖 如果你的电脑上安装了任何 AI Agent 框架（如 Claude Code、Copilot Chat、Cursor、Cline 等），直接把本文件丢给它，让它给你省流 —— 它会自动帮你完成环境配置、依赖安装和项目启动。**

---

## 目录

1. [项目是什么](#1-项目是什么)
2. [第一步：装好工具链](#2-第一步装好工具链)
3. [第二步：克隆并配置](#3-第二步克隆并配置)
4. [第三步：安装依赖](#4-第三步安装依赖)
5. [第四步：启动单端口应用](#5-第四步启动单端口应用)
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

技术上是 **TypeScript 单端口 Host + Pi durable runtime + TS Dataset Core + React 前端**。
formal Agent、Task/Run/Event、产品 API 与 Dataset Core 全部由 TypeScript 权威
实现；Python 只承担 DB bridge（`database/bridge.py`，JSONL named-op 持久化），
由 TS Host 按需管理。

> 想系统了解"能做什么"（功能全景、赛题评价维度映射、演示脚本），见
> [FEATURES.md](FEATURES.md)；想了解技术架构与约束，见
> [ARCHITECTURE.md](ARCHITECTURE.md)。其他Agent或自动化脚本调用HTTP/WS时，见
> [AGENT_API_QUICKSTART.md](AGENT_API_QUICKSTART.md)。

> 这是"中国高校计算机大赛 — AI Scientist 赛道"的参赛作品（赛题 XH-202619）。

---

## 2. 第一步：装好工具链

### 2.1 你需要装什么

| 工具 | 用途 | 必须？ |
|------|------|--------|
| **Node.js 22.19+** | TypeScript Host 与前端运行时 | ✅ 必须 |
| **pnpm** | Node 包管理器（类似 npm 但更快） | ✅ 必须 |
| **Python 3.12+** | 仅 `database/` persistence bridge（stdlib，**不是后端语言**） | 仅开发/测试 bridge 时需要 |
| **uv** | Python 包管理器（仅管理根 `database/` 项目） | 仅开发/测试 bridge 时需要 |
| **DashScope API Key** | 调用千问大模型 | ✅ 必须 |
| Git | 版本控制 | 推荐 |

> **关于 Python**：运行主应用时由 TS Host 自动探测 Python 解释器
> （`BIOMED_PYTHON_BIN` → 仓库 `.venv` → PATH），不需要你手动指定。规划中后续
> 将改为**内置 Python 解释器**（随应用打包分发），届时完全无需自行安装 Python。

### 2.2 安装 Python 3.12+（仅 database/ 开发/测试需要）

Python 只承担 `database/` persistence bridge（`database/bridge.py`，stdlib、
JSONL named-op），**不是后端语言，不提供任何 Web 服务**。只运行主应用时通常
不需要装 Python（除非要跑 `database/` 测试或自托管 bridge）。

如果你还没装 Python，去官网下载：https://www.python.org/downloads/

安装时 **一定要勾选 "Add Python to PATH"**（加到系统环境变量）。

装完后打开终端（PowerShell 或 CMD），验证一下：

```powershell
python --version
# 应该输出类似：Python 3.12.x
```

### 2.3 安装 uv（仅 database/ 项目使用）

uv 是新一代 Python 包管理器，比 pip 快 10-100 倍。本项目**只用于 `database/`
项目（根 `pyproject.toml`）**，TS/Node 侧统一用 pnpm，不要用 npm 或 pip。

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

### 2.4 安装 Node.js 22.19+

去官网下载 LTS 版本：https://nodejs.org/

装完后验证：

```powershell
node --version
# 应输出 v22.19.0 或更高版本
```

### 2.5 安装 pnpm（Node 包管理器）

pnpm 是高效的 Node 包管理器，本项目**必须用 pnpm**，不要用 npm 或 yarn。

```powershell
npm install -g pnpm
```

装完后验证：

```powershell
pnpm --version
# 应输出 11.14.x
```

### 2.6 获取 DashScope API Key

1. 打开 https://dashscope.aliyun.com/ （阿里云百炼平台）
2. 注册/登录阿里云账号
3. 在控制台找到 "API Key 管理"，创建一个新的 API Key
4. 复制保存好这个 Key（只显示一次！）

> 💡 千问部分模型有免费额度，qwen3.7-plus 对比赛够用了。

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

正常 `pnpm dev` 会读取根 `.env`。

---

## 4. 第三步：安装依赖

```powershell
# 安装 Python database bridge 项目依赖（根 pyproject.toml）
uv sync

# 从唯一 pnpm Workspace 根安装 Node 依赖
pnpm install --frozen-lockfile
```

仓库根持有唯一 `pnpm-lock.yaml` 与 `uv.lock`。不要在 `frontend/` 或 `server/`
创建独立 lockfile，也不要使用 npm。

### 4.1 应用 smoke test（Windows）

自动化 smoke 应直接启动 root `pnpm dev`，等待 health endpoint 就绪（初始化期间
返回 503，需带重试），并在 `finally` 中终止 Host 进程（记录其直接子 PID）。
Host 会统一回收 Pi session、DB bridge、browser pool 与 Workspace command；不启动
任何 Python Web Server，不需要 Uvicorn 模板。

## 5. 第四步：启动单端口应用

在仓库根目录执行唯一正常启动命令：

```powershell
pnpm dev
```

dev 模式直接以 `tsx watch` 执行 `server/src/index.ts`（不做全量 tsc 编译，源码
改动自动重启；`@biomed/contracts` 由 `predev` 轻量预构建）。TypeScript Host
**先绑定端口、再初始化**共享 DB/browser 资源、Pi durable runtime（含
`recoverActiveRuns`）与 TS Dataset Core，然后挂载 Vite middleware 并切换正式
handler。初始化期间（通常几百毫秒）端口已经可访问，所有请求返回
`503 {"status":"starting"}`；自动化 smoke 等待 health 就绪时需容忍 503 重试。

启动完成以 **READY banner** 为准（不是 listen）：

```text
BioMed-QAgent starting...
  ➜ Host:  http://127.0.0.1:5173/
  ➜ State: initializing runtime...

  BioMed-QAgent ready in 540 ms
  ➜ Local: http://127.0.0.1:5173/
  ➜ API:   http://127.0.0.1:5173/api/v1
  ➜ WS:    ws://127.0.0.1:5173/api/v1/ws
```

浏览器访问 http://127.0.0.1:5173；健康检查也走同一端口：

```text
http://127.0.0.1:5173/api/v1/health
```

正式 `/api/v1/*` 与 `/api/v1/ws` 由 TS Host 权威实现；Vite HMR WebSocket 走
专属路径 `/__vite_hmr`（Host 的 upgrade 监听器只接管 `/api/v1/ws`，其余放行）。
开发重启（SIGTERM，tsx watch 触发）直接退出进程，未终结的 run 由 durable
repository 在下次启动时恢复；`Ctrl+C`（SIGINT）仍由 Host 优雅关闭所有资源。

生产模式（构建后静态托管）：

```powershell
pnpm build
pnpm start
```

`pnpm dev:frontend-standalone` 仍可用于 Vite 独立诊断（代理到 TS Host）。

---

## 6. 第五步：跑起来看看

### 6.1 跑测试

```powershell
pnpm test                         # 根 Workspace：contracts/server/frontend（有界并发）
pnpm test:full                    # 全速测试（去掉 workspace 并发限制；CI 或明确需要时）
pnpm lint
pnpm typecheck
pnpm build

uv run python database/bridge.py --self-test   # Python bridge 自检
uv run pytest database/tests                   # bridge 协议/持久化测试
uv run ruff check database                     # bridge lint
```

测试并发默认**有界**，避免本机 CPU 撞功耗墙：根 `pnpm test` 限制 workspace 并发为
2，各 vitest 配置限制 worker 数（server `forks`/2、frontend `threads`/4、contracts
`threads`/2）；CI（`CI=true`）自动放开 vitest worker 上限。预算模型与覆盖方式见
[docs/architecture/test-concurrency.md](architecture/test-concurrency.md)。

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

- 技术栈约束（Node.js 22 / React 19 / shadcn / Tailwind v4）
- 架构规则（Agent + Dataset Core 两层）
- 代码规范（必须类型标注、不允许 `as any` 等）
- 常用命令

**你应该做的**：每次开始一个新任务时，告诉你的 AI 工具"先读一下 AGENTS.md 和 docs/ARCHITECTURE.md"，它就能自动遵守项目规范。

### 7.3 Skill 系统 —— 项目的核心设计

这个项目把生物医学数据库的检索、下载、处理能力组织为 **Skill 知识 + 直接工具**：

```
.pi/skills/<name>/SKILL.md          # SOP 知识（Pi 按任务加载）
server/src/agent/tools/             # TS 业务工具实现
server/src/agent/skills/skill-tool-map.ts   # Skill ↔ Tool 稳定名称映射
server/src/product/builtin-databases.ts     # 内置数据库目录
```

**如果你想加一个新的数据库来源**：
1. 在 `.pi/skills/<name>/SKILL.md` 写 SOP 知识；
2. 在 `server/src/agent/tools/` 实现 TS 工具并登记到 skill-tool-map.ts；
3. 补 `server/tests/skill-tool-map.test.ts` 等断言钉住映射。

### 7.4 Agent + Dataset Core 双层架构

这是项目的关键设计，理解它你就能看懂代码了：

```text
用户输入主题
    │
    ▼
Pi Main Agent（大模型，TS Host 进程内）
    │ 理解意图 → 检索/获取 → 生成 DatasetBuildSpec
    │
    ▼
TS Dataset Core（确定性代码，server/src/dataset/）
    │ Acquire → Parse → Canonicalize → Compat → Integrate
    │ → Validate → Publish（服务端固定骨架）
    │
    ▼
输出：Manifest 注册的 Artifact（CSV + 来源清单 + 处理记录）
```

- **Agent（Pi）**：负责理解用户意图、做决策、检索来源，通过
  `server/src/agent/pi-adapter.ts` 边界接入；Agent 不能直接制造正式产物。
- **Dataset Core（确定性代码）**：负责严格执行数据处理。任何路径都不能绕过
  validate/publish，也不能直接写 `artifacts/`。

这样设计的原因是：大模型擅长理解，但可能"偷懒"跳过关键步骤。确定性 Core
保证了数据处理的可靠性。

### 7.5 用 Playwright 做网页截图（视觉数据提取）

项目中有一个高级功能：用 Playwright 控制无头浏览器对论文页面截图，然后送给 Qwen-VL 视觉模型提取图表数据。代码在 `server/src/external/` 与 `server/src/processing/`。

如果你要调试这个功能，需要安装 Playwright 浏览器：

```powershell
pnpm --filter @biomed/server exec playwright install chromium
```

### 7.6 推荐的 AI 开发工作流

```text
1. 打开 AGENTS.md + docs/ARCHITECTURE.md → 让 AI 理解项目
2. 描述你要做的功能 → AI 建议改哪些文件
3. AI 写代码 → 你 review → 跑测试验证
4. 提交前让 AI 跑一遍 lint + test
```

> 💡 仓库根配有 `AGENTS.md` 与 `.claude/`、`.agents/` 等目录，主流 AI 编码工具（Claude Code、Copilot、Cursor、Cline 等）会自动读取并遵守项目约定。

---

## 8. 常用命令速查

### 正常 Node Workspace（在仓库根执行）

| 命令 | 作用 |
|------|------|
| `pnpm install --frozen-lockfile` | 安装唯一 Workspace lockfile |
| `pnpm dev` | 启动单端口 TS Host（正常入口） |
| `pnpm test` | 运行 contracts/server/frontend 测试（默认有界并发，见 [test-concurrency.md](architecture/test-concurrency.md)） |
| `pnpm test:full` | 全速测试（去掉 workspace 并发限制；CI 或明确需要最快完成时） |
| `pnpm lint` | Workspace lint |
| `pnpm typecheck` | Workspace TypeScript 检查 |
| `pnpm build` | Workspace 构建 |

### 前端（在 `frontend/` 目录下执行，仅定向检查/诊断）

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装 Node 依赖 |
| `pnpm dev` | standalone Vite diagnostic |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 代码检查 |
| `pnpm tsc` | TypeScript 类型检查 |
| `pnpm test` | 跑单元测试 |
| `pnpm shadcn add <组件名>` | 安装 shadcn 组件 |

---

## 9. 项目骨架一览

目录结构与各目录职责以 [README.md](../README.md)「项目结构」一节为准，此处不重复维护。

---

## 10. 常见问题排查

### Q: `pnpm install` 报错 "pnpm not found"

你没装 pnpm。回头参考 [2.5 节](#25-安装-pnpmnode-包管理器) 安装。

### Q: 启动后端报 "DASHSCOPE_API_KEY not set"

你没配置 `.env` 文件。参考 [3.2 节](#32-配置环境变量)。

### Q: 前端页面打开了但是空白/报网络错误

1. 确认 root `pnpm dev` 仍在运行
2. 确认 http://127.0.0.1:5173/api/v1/health 可访问
3. 打开浏览器开发者工具（F12）→ Network 面板看请求状态

### Q: Playwright 截图功能报 "Executable doesn't exist"

需要安装 Chromium 浏览器：

```powershell
pnpm --filter @biomed/server exec playwright install chromium
```

---

> **📌 最后提醒：本项目配有完整的 AGENTS.md，你的 AI 工具能自动理解项目规则。遇到问题，先把 AGENTS.md 和 docs/ARCHITECTURE.md 丢给 AI，让它帮你定位。**
