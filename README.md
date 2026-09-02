# BioMed-QAgent

BioMed-QAgent 面向生物医学开放数据，把自然语言需求转化为可追溯、可验证、可下载的标准化数据集。Pi Agent 负责意图理解、来源发现和规格生成，确定性的 TypeScript Dataset Core 负责获取、解析、整合、验证和不可变发布。

## 核心能力

- **自然语言 → 数据集**：描述需求即可启动任务；Agent 生成计划与受控规格，Dataset Core 确定性执行获取、解析、整合与验证。
- **可追溯**：每个发布行都能追溯到采集回执与来源定位；SourceAsset、内容 hash、兼容性门、Validation Profile、provenance closure 与原子发布由 Core 强制执行。
- **不可变发布**：正式产物只由 manifest 声明，经 hash/验证门后发布；workspace 中间文件不能绕过 Core 成为 Publication。
- **持久化任务运行**：事件溯源（`events.jsonl`）+ 可重建快照；WebSocket 实时事件，断线后以 HTTP replay 补齐。
- **Web 控制台**：任务对话、发布浏览、模型设置（密钥掩码存储，不上传）。
- **内置领域技能**：`.pi/skills/` 内置 UniProt、PubChem、ChEMBL、GEO、GDC、ClinVar、Reactome 等生物医学数据源技能与数据构建规范。

## 快速开始

### 方式一：下载自包含部署包（推荐）

前往 [GitHub Releases](https://github.com/Lidozs55/BioMed-QAgent/releases) 下载对应平台的部署包。包内自包含内嵌 Node.js 与 CPython（预装 numpy/scipy），目标机无需预装任何环境：

1. 解压后启动：
   - Windows：双击 `start.bat`
   - Linux/macOS：`chmod +x start.sh` 后执行 `./start.sh`
2. 访问 `http://127.0.0.1:5173`，在「设置 → 模型」中添加 Provider 和 API key 并激活主模型；图形任务需另选具备图像能力的视觉模型。模型凭据不会从环境变量自动引导。
3. 如需修改端口，在包目录下创建 `.env` 并设置 `PORT`（默认 5173）。

Agent 浏览器工具基于 Playwright，浏览器内核不随包分发，需要时执行：
`runtime/node/bin/node server/node_modules/playwright/cli.js install chromium`（Windows 为 `runtime\node\node.exe`）。

### 方式二：从源码运行

要求：Node.js 22.19+、[pnpm](https://pnpm.io/) 11.14、Python 3.12+、[uv](https://docs.astral.sh/uv/)、Git。

```bash
git clone https://github.com/Lidozs55/BioMed-QAgent.git
cd BioMedQAgent
pnpm install --frozen-lockfile
uv sync
pnpm dev
```

首次打开页面后在「设置 → 模型」完成模型配置；配置只写入本机 `data/settings/`，不会从环境变量自动引导。Host 首选 `http://127.0.0.1:5173`，端口被占用时由操作系统分配可用端口，实际地址以启动输出 `BIOMED_QAGENT_URL=...` 为准。Windows 终端建议先执行 `. .\scripts\utf8-init.ps1`（或 `call scripts\utf8-init.cmd`）初始化 UTF-8 环境，避免中文内容被系统代码页损坏。

生产构建与启动：

```bash
pnpm build
pnpm start
```

生产静态入口按当前 OS 用户禁止多开；已有实例时第二次 `pnpm start` 会提示已在运行并正常退出。

## 架构一览

单一 TypeScript Application Host 拓扑：同一端口提供 React/Vite 前端、`/api/v1` HTTP、durable WebSocket、Pi Agent、Dataset Core 与设置 API；Python 仅保留 stdlib 持久化桥。

| 目录                   | 职责                                         |
| ---------------------- | -------------------------------------------- |
| `packages/contracts/`  | TypeScript wire DTO 的唯一来源               |
| `server/`              | TS Host、Pi adapter、durable runtime、Dataset Core |
| `frontend/`            | React 19 + Vite + Tailwind v4 + shadcn/ui    |
| `database/`            | stdlib Python JSONL/SQLite persistence bridge |
| `.pi/skills/`          | Agent 领域技能（数据源、分析、数据构建规范） |
| `examples/families/`   | 非生产 family 示例                           |

## 运行数据

默认数据根位于 `data/`（运行期生成，不入库）：

```text
data/
├── settings/                    # 模型注册与凭据（权限收紧）
├── workspaces/<task_id>/        # Agent staging workspace
└── output/tasks/<task_id>/
    ├── events.jsonl             # 追加写入的权威任务事实
    ├── snapshot.json            # 可由事件重建
    └── dataset_runs/<run_id>/<requirement_id>/
        └── publish/             # 不可变 Publication
```

Agent workspace 与 Core publication 物理分离；API 只暴露经 manifest 注册并通过 hash/验证门的正式 artifact。

## API 概览

- `GET /api/v1/health`：健康检查。
- `/api/v1/tasks`：创建、读取、续跑和删除终态任务。
- `/api/v1/tasks/{taskId}/events`：durable 事件重放。
- `/api/v1/ws`：实时事件；断线后仍以 HTTP replay 补齐。
- `/api/v1/publications`：发布与产品评估；artifact 经 `/api/v1/publications/{id}/artifacts/{artifactId}` 下载。
- `/api/v1/settings`：模型与应用设置，密钥始终掩码返回。

## 分支与开发

- `main` 是公开发布分支：承载面向使用者的 README 与 release tag，受分支保护，仅通过来自 `dev` 的 PR 更新。
- `dev` 是开发集成分支：所有功能开发在此进行；架构文档、ADR、开发指南与任务规划也在 `dev` 上维护，见 [dev 分支 docs/ 目录](https://github.com/Lidozs55/BioMed-QAgent/tree/dev/docs)。

开发环境的常见质量门命令：

```bash
pnpm lint          # workspace lint
pnpm typecheck     # TypeScript 检查
pnpm build         # 生产构建
pnpm test          # 全量测试
pnpm run pack      # 打自包含部署包到 target/
```

## 安全

不要提交 `.env`、API key 或真实凭据；模型凭据只保存在本机 `data/settings/`。Agent 对 workspace 外的文件和命令访问经过 `allow / ask / deny` 权限系统；权限批准不改变 Core 的发布信任边界。

## License

见仓库分发包中的许可证文件（如适用）。
