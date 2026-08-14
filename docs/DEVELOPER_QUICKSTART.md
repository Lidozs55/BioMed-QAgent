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
Phase 0–8 迁移完成后（2026-08-14），formal Agent、Task/Run/Event、产品 API 与
Dataset Core 全部由 TypeScript 权威实现，不再有 legacy FastAPI / rollback profile。

Python 只承担 DB bridge（`database/bridge.py`，JSONL named-op 持久化），由 TS Host
按需管理。

> 这是"中国高校计算机大赛 — AI Scientist 赛道"的参赛作品（赛题 XH-202619）。

---

## 2. 第一步：装好工具链

### 2.1 你需要装什么

| 工具 | 用途 | 必须？ |
|------|------|--------|
| **Python 3.12+** | 后端语言 | ✅ 必须 |
| **uv** | Python 包管理器（类似 pip 但更快） | ✅ 必须 |
| **Node.js 22.19+** | TypeScript Host 与前端运行时 | ✅ 必须 |
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

自动化 smoke 应直接启动 root `pnpm dev`，等待 health endpoint 就绪，并在
`finally` 中终止 Host 进程（记录其直接子 PID）。Host 会统一回收 Pi session、
DB bridge、browser pool 与 Workspace command；不启动任何 Python Web Server，
不需要 Uvicorn 模板。

## 5. 第四步：启动单端口应用

在仓库根目录执行唯一正常启动命令：

```powershell
pnpm dev
```

TypeScript Host 会初始化共享 DB/browser 资源、Pi durable runtime 与 TS Dataset
Core，挂载 Vite middleware，最后才监听公开端口。看到 Host 监听 `127.0.0.1:5173`
后，浏览器访问 http://127.0.0.1:5173；健康检查也走同一端口：

```text
http://127.0.0.1:5173/api/v1/health
```

正式 `/api/v1/*` 与 `/api/v1/ws` 由 TS Host 权威实现。按 `Ctrl+C` 由 Host 统一
关闭资源。

生产模式（构建后静态托管）：

```powershell
pnpm build
pnpm start
```

`pnpm dev:frontend-standalone` 仍可用于 Vite 独立诊断（代理到 TS Host）。

---

## 6. 第五步：跑起来看看

### 6.2 跑测试

```powershell
pnpm test                         # 根 Workspace：contracts/server/frontend
pnpm lint
pnpm typecheck
pnpm build

cd backend
uv run pytest                     # 跑全部测试（跳过联网测试）
uv run pytest -m live             # 跑联网测试（需要 API Key）
uv run pytest -k "skill"          # 只跑名字含"skill"的测试
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

### 7.3 Skill 系统 —— 项目的核心设计（Phase 2 后形态）

这个项目把生物医学数据库的检索、下载、处理能力组织为 **Skill 知识 + 直接工具**：

```
.pi/skills/<name>/SKILL.md          # SOP 知识（Pi 按任务加载）
server/src/agent/tools/             # TS 业务工具实现（Phase 5 起）
server/src/agent/skills/skill-tool-map.ts   # Skill ↔ Tool 稳定名称映射
server/src/product/builtin-databases.ts     # 内置数据库目录（Phase 8 起）
```

**如果你想加一个新的数据库来源**：
1. 在 `.pi/skills/<name>/SKILL.md` 写 SOP 知识；
2. 在 `server/src/agent/tools/` 实现 TS 工具并登记到 skill-tool-map.ts；
3. 补 `server/tests/skill-tool-map.test.ts` 等断言钉住映射。

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

- **Agent（大模型）**：负责理解用户意图、做决策；formal legacy 与 experimental Pi
  在迁移期并存，但生命周期/持久化权威不同。
- **Dataset Core（确定性代码）**：负责严格执行数据处理。两条 Agent 路径都不能
  绕过 validate/publish，也不能直接写 `artifacts/`。

这样设计的原因是：大模型擅长理解，但可能"偷懒"跳过关键步骤。Pipeline 保证了数据处理的可靠性。

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

> 💡 这个项目已经配好了 `opencode.json`，如果你用 OpenCode 或 Commonly 等 Agent 框架，它们会自动读取项目配置。

---

## 8. 常用命令速查

### 正常 Node Workspace（在仓库根执行）

| 命令 | 作用 |
|------|------|
| `pnpm install --frozen-lockfile` | 安装唯一 Workspace lockfile |
| `pnpm dev` | 启动单端口 TS Host（正常入口） |
| `pnpm test` | 运行 contracts/server/frontend 测试 |
| `pnpm lint` | Workspace lint |
| `pnpm typecheck` | Workspace TypeScript 检查 |
| `pnpm build` | Workspace 构建 |

### Python database bridge（在仓库根执行）

| 命令 | 作用 |
|------|------|
| `uv sync` | 安装/同步 database 项目依赖 |
| `uv run python database/bridge.py --self-test` | bridge 自检 |
| `uv run pytest database/tests` | bridge 协议/持久化测试 |
| `uv run ruff check database` | 代码检查（lint） |

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

```
BioMed-QAgent/
├── AGENTS.md              # 🔑 AI Agent 守则（先读这个！）
├── PROBLEM.md             # 赛题说明
├── README.md              # 项目简介
├── .env.example           # 环境变量模板
├── package.json           # 根 Workspace 脚本（pnpm dev 是正常入口）
├── pnpm-workspace.yaml    # frontend/server/packages/*
├── pnpm-lock.yaml         # 唯一 Node lockfile
├── skills-lock.json       # Skill 版本锁定
│
├── database/              # Python persistence bridge（stdlib，named-op JSONL）
│   ├── bridge.py          # JSONL stdin/stdout 命名操作入口
│   ├── cache_store.py     # 逻辑缓存（schema-neutral，SQLite index + CSV）
│   ├── database_store.py  # 用户 declarative database 持久化
│   ├── declarative.py     # manifest 校验模型（stdlib 重写）
│   └── tests/             # bridge 协议/持久化测试
│       ├── tools/         # Function Tools
│       └── integrations/  # 外部服务集成（NCBI 等）
│
├── server/                # TS Application Host / Pi experimental adapter
├── packages/contracts/    # 共享 wire DTO
├── .pi/skills/            # Phase 1 最小迁移 Skills
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

1. 确认 root `pnpm dev` 仍在运行
2. 确认 http://127.0.0.1:5173/api/v1/health 可访问
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

## 已知陷阱:LLM 序列化未指定可选参数为空字符串

Agent 调用 `function_tool` 时,未指定的可选参数(如 find_skill 的 `source`)会被
LLM 序列化为 `""`(空字符串)而非省略。任何按 `param is not None` 判断"是否提供"
的工具实现都会因此把所有候选过滤掉,表现为工具恒返回空。

处理模式(见 `app/skills/gateway.py:_find_skill`):显式参数用
`param is not None and param.strip()` 判断,空白字符串视为未提供。

受影响面:所有 LLM 直接调用的 Function Tool 都要按此模式处理可选参数。

## 已知陷阱:浏览器子资源拒绝导致整页失败(已修复)

`BrowserPool._route_handler` 曾把所有被拒的子资源请求(脚本/图片/CDN,如
IPv6 地址 2001::1 被 SSRF 防护拒绝)当作致命错误:`route.abort()` + `raise`,
导致页面 close 时抛异常、`navigate_page` 整体失败。修复后仅**主文档导航**
被拒才致命;子资源被拒只 abort(SSRF 防护保留,页面主体仍渲染)。若未来
页面出现"导航失败但主文档正常"的回归,先查 `_route_handler` 的
`is_main_frame` 判断。

## 已知陷阱:SDK strict schema 把带默认值参数标 required

OpenAI Agents SDK 的 `ensure_strict_json_schema` 把所有属性无条件加入
`required`,即使参数有默认值(`default=None` 的键还会被剥离)。表现:Agent
调用缺省可选参数时报 `'X' is a required property`。两层防护:
1. `gateway._invoke_skill` 校验时把 `required` 中带 `default` 的属性视为可选
   (覆盖非 None 默认值,如 `limit: int = 1`);
2. 参数默认值为 `None` 时(`Optional[X] = None`)strict 会剥离 default 键,
   需在 `@function_tool(strict_mode=False)` 显式退出 strict(如
   `search_pubchem.max_results`)。
