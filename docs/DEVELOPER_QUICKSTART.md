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
copy .env.example .env       # Windows
# cp .env.example .env       # POSIX
```

编辑 `.env`，至少提供一个可用模型的 key：

```dotenv
DASHSCOPE_API_KEY=your-api-key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen3.7-plus
HOST=127.0.0.1
PORT=5173
```

Pi 可用 `PI_PROVIDER`、`PI_MODEL`、`PI_API_KEY`、`PI_BASE_URL` 单独覆盖。使用 NCBI E-utilities 时还要配置有效的 `NCBI_EMAIL` 和 `NCBI_TOOL`。其余并发、分页、日志和路径选项以 [`.env.example`](../.env.example) 为准，不在本文复制完整清单。

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

确认 `.env` 位于仓库根，变量名与 provider 对应，并重启 Host。不要把 key 粘贴进日志、截图或 issue。

### 页面正常但 API/WS 失败

确认从仓库根运行 `pnpm dev` 并访问同一 `HOST:PORT`。若单独启动了 frontend dev server，停止它后回到单端口入口。

### database bridge 启动失败

先运行 `uv run python database/bridge.py --self-test`。Host 按 `BIOMED_PYTHON_BIN`、仓库 `.venv`、PATH 顺序探测解释器；自定义解释器应使用 Python 3.12+ 的绝对路径。

### 测试在高负载下不稳定

先按 [`architecture/test-concurrency.md`](architecture/test-concurrency.md) 降低 worker 预算并复跑失败文件，不要直接扩大所有 timeout。已知问题见 [`ISSUES.md`](ISSUES.md)。

### Git hook 拒绝提交

修复 hook 报告的问题，并使用 `type(scope): subject` 或 `[TASK-123] type: subject`。除非明确说明原因，不使用 `--no-verify`。
