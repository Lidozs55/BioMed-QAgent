# BioMed-QAgent 开发者快速入门

本文只回答“如何在本地可靠地运行和验证仓库”。系统设计见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，能力说明见 [`FEATURES.md`](FEATURES.md)，文档职责见 [`README.md`](README.md)。

## 1. 前置工具

| 工具 | 要求 | 用途 |
| --- | --- | --- |
| Node.js | 22.19+ | Application Host、Dataset Core、前端 |
| pnpm | `package.json` 固定的 11.14 | 唯一 TypeScript 包管理器 |
| Python | 3.12+ | 仅 `database/` bridge |
| uv | 当前稳定版 | Python 环境与 dev tools |
| Git | 当前稳定版 | 版本控制与 hooks |

```bash
node --version
pnpm --version
python --version
uv --version
git --version
```

不要用 `npm install` 修改 workspace，也不要在 `database/` 单独创建第二份 Python 项目。Commonly CLI 的一次性全局安装是仓库规则明确允许的例外。

## 2. 克隆与配置

```bash
git clone <repository-url>
cd BioMedQAgent
```

模型与 API key 不再从环境变量自动引导。首次启动后打开页面右上角 **设置 → 模型**：

1. 添加 OpenAI-compatible Provider 并保存 API key；
2. 添加并激活主模型；
3. Gold6 等图形任务还要选择具备图像能力的视觉模型。

设置分别持久化到本机 `data/settings/model-registry.json` 和权限收紧的 `data/settings/model-auth.json`；后者只掩码返回，禁止提交或输出原始 key。模型行为与任务级运行预算在设置页管理；机器资源预算才使用根目录中未跟踪的 `.env`。仓库不提供可提交的环境模板；不要创建或追踪此类模板，也不要把本机路径、身份或密钥提交入库。

常用 Host/部署变量如下；未设置时使用表中默认值：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 单端口 Host 监听地址 |
| `PORT` | `5173` | 首选监听端口；`0` 表示由 OS 分配 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Host 关闭等待预算（正整数毫秒） |
| `BROWSER_MAX_CONTEXTS` | `4` | 单 Host 的 Playwright BrowserContext 并发预算 |
| `EVENT_CACHE_MAX_BYTES` | `268435456` | durable parsed-event 缓存预算（默认 256 MiB） |
| `OUTPUT_DIR` | `<repo>/data/output` | durable runtime 与正式输出根目录；相对路径锚定仓库根 |
| `BIOMED_PYTHON_BIN` | 仓库 `.venv` / PATH 探测 | database bridge 的 Python 3.12+ 解释器 |

`BROWSER_MAX_CONTEXTS`、`EVENT_CACHE_MAX_BYTES` 与 shutdown timeout 在启动时严格校验为正安全整数。任务级 timeout、下载大小、模型重试、VLM PDF 页/图/DPI 等不从 env 读取，统一由 **设置 → Agent → 运行限制** 管理，语义见 [`architecture/runtime-limits.md`](architecture/runtime-limits.md)。模型与 API key 不再从环境变量自动引导；使用 Commonly 或需要外部工具身份时，按相应脚本文档在本地 `.env` 中设置其专用变量。

## 3. 安装依赖

```bash
pnpm install --frozen-lockfile
uv sync
uv run python database/bridge.py --self-test
```

根 `pnpm-lock.yaml` 是唯一 Node lockfile。`uv sync` 只为 stdlib-only database bridge 安装 pytest/ruff 等开发工具；生产 bridge 本身不依赖第三方 Python 包。

仓库的 pnpm 布局已固定为 `nodeLinker: hoisted` + `packageImportMethod: copy`，并把 `@biomed/contracts` 作为 injected 本地文件快照安装；这是为了让同一条安装命令在 NTFS 与不支持符号链接的 exFAT 工作区都可复现。不要在本机覆盖这些设置，也不要手工复制 contracts 或依赖 `node_modules/.pnpm` 的内部目录。`predev` / `pretest` / `prestart` 共用的 `scripts/build-contracts-if-needed.mjs` 会在构建后同步物理安装副本；普通支持 symlink 的工作区链接则保持原样。

## 4. 启动应用

```bash
pnpm dev
```

Host 首选 `http://127.0.0.1:5173`。若该端口已被占用，Host 会让操作系统分配可用端口；请打开启动输出中 `BIOMED_QAGENT_URL=...` 指向的实际地址。这一个进程/端口同时承载 React/Vite、`/api/v1/*`、`/api/v1/ws`、Pi Agent、durable runtime、TypeScript Dataset Core 和按需启动的 Python database bridge。

`pnpm --dir frontend dev` 或根 `pnpm dev:frontend-standalone` 只用于前端定向诊断。不要启动 legacy Python web server；仓库不存在该拓扑。

健康检查：

```bash
curl http://127.0.0.1:5173/api/v1/health
node scripts/run-driver.mjs health
```

API 创建任务、续跑、事件重放与 HIL 示例见 [`AGENT_API_QUICKSTART.md`](AGENT_API_QUICKSTART.md)。

## 5. 开发循环

开始前阅读 [`../AGENTS.md`](../AGENTS.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md)、[`../PROBLEM.md`](../PROBLEM.md) 和 [`TODO.md`](TODO.md)。前端任务额外阅读 [`../frontend/AGENTS.md`](../frontend/AGENTS.md)，并使用仓库规定的 shadcn 组件工作流。

1. 先复现问题或写出明确验收条件。
2. bug fix 先提交失败测试；新功能与测试同行。
3. 只改必要文件，wire DTO 先进入 `@biomed/contracts`。
4. 跑定向测试（只测改动区域）；失败用例先单独重跑至全部通过，再跑一次该区域定向套件确认。
5. 同步 TODO/ISSUES、必要的架构或操作文档。

常用定向命令：

```bash
pnpm --filter @biomed/server test
pnpm --filter @biomed/frontend test
pnpm --filter @biomed/contracts test
pnpm --dir frontend tsc
```

通用质量门（push / merge 前）：

```bash
pnpm lint
pnpm typecheck
pnpm build
uv run python database/bridge.py --self-test   # database/ 改动时，连同下面两条
uv run pytest database/tests
uv run ruff check database
```

全量 `pnpm test` 仅在改动跨共享边界（`packages/contracts/`、根配置、`scripts/`）或无法定位影响面时本地执行；CI 会在每次 PR 和 main push 时自动跑全量。定向测试策略详见 [`../AGENTS.md`](../AGENTS.md) § Quality Gates。

并发与内存调节见 [`architecture/test-concurrency.md`](architecture/test-concurrency.md)。提交规则见 [`git-hooks.md`](git-hooks.md)。

## 6. 生产构建

```bash
pnpm build
pnpm start
```

`pnpm start` 服务已经生成的生产 bundle，因此应先执行 `pnpm build`（发布 ZIP 已包含构建产物）。静态生产入口按当前 OS 用户持有唯一实例租约：已有实例时第二次启动打印 `BioMed-QAgent is already running.` 并以成功状态退出，不创建第二个 Host。不要把 `pnpm dev` 或 Vite standalone 当成生产部署方式。

## 7. 数据与权限

- Agent staging workspace：`data/workspaces/<taskId>/`。
- durable runtime 与正式输出：`data/output/tasks/<taskId>/`。
- 权威事件：`events.jsonl`。
- 不可变发布：`dataset_runs/<runId>/<requirementId>/publish/`。

workspace 外的文件和命令访问经过 `allow / ask / deny`。即使用户批准访问，Agent 产物仍必须经 registered asset、OperationResult、validation、assessment 和 Publisher 才能成为正式 Publication。

同一 data root 当前只运行一个 Host，尤其在 Gold/evidence run 期间；多 Host 共享事件日志不是受支持拓扑。

## 8. 常见问题

### `pnpm` 或 `node` 找不到

安装满足版本要求的 Node.js，并启用 `package.json` 固定的 pnpm；重开终端后重新检查版本。

### 应用提示模型 key 缺失

打开 **设置 → 模型**，确认 Provider 已保存 API key、主模型已激活；视觉任务还要确认视觉模型已选择且声明图像能力。不要把 key 粘贴进日志、截图或 issue。

### 页面正常但 API/WS 失败

确认从仓库根运行 `pnpm dev` 并访问同一 `HOST:PORT`。若单独启动了 frontend dev server，停止它后回到单端口入口。

### database bridge 启动失败

先运行 `uv run python database/bridge.py --self-test`。Host 按 `BIOMED_PYTHON_BIN`、仓库 `.venv`、PATH 顺序探测解释器；自定义解释器应使用 Python 3.12+ 的绝对路径。

### 测试在高负载下不稳定

先按 [`architecture/test-concurrency.md`](architecture/test-concurrency.md) 降低 worker 预算并复跑失败文件，不要直接扩大所有 timeout。已知问题见 [`ISSUES.md`](ISSUES.md)。

### Git hook 拒绝提交

修复 hook 报告的问题，并使用 `type(scope): subject` 或 `[TASK-123] type: subject`。除非明确说明原因，不使用 `--no-verify`。
