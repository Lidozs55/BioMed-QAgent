# 打包与分发（standalone packager）

## 定位

`scripts/pack-release.mjs` 是与 CI（`.github/workflows/package.yml`）**相互独立**的本地打包器：从指定 git ref 快照构建，并把产物组装成"开箱即跑"的自包含 bundle 输出到 `target/`。目标机**无需预装** Node / pnpm / uv / Python。

CI 产出的 bundle 是"源码 + 产物"形态（目标机仍需 `pnpm install`、`uv sync`、Node/pnpm/uv/Python 全套环境）；本打包器产出的是"便携整机"形态。二者服务不同分发场景，互不依赖、互不影响。

## 用法

```bash
pnpm run pack                                # 当前平台 → target/
pnpm run pack -- --platform=all              # win + linux + macos 三平台
pnpm pack:target --out=D:\somewhere          # 别名入口；自定义输出目录
pnpm run pack -- --ref=v0.1.0                # 打包指定 git ref（默认 HEAD）
pnpm run pack -- --keep-temp                 # 保留中间构建目录（调试用）
```

注意：`pnpm pack`（不带 run）是 pnpm 的内置 tarball 命令，与脚本同名会被内置命令抢占，因此务必写 `pnpm run pack`，或使用无冲突的别名 `pnpm pack:target`。

构建机要求：git、pnpm（锁文件版本）、Node 22、tar、curl。依赖 store 已热时全程可离线；运行时下载见下节。

## 产物布局

```
target/biomed-qagent-<version>-<win|linux|macos>/
├── start.bat / start.sh     启动器（首跑自动从 .env.example 生成 .env）
├── README.txt               目标机使用说明
├── server/                  编译后的 Application Host + pnpm deploy 剪枝的生产依赖
├── frontend/dist/           前端产物（host 以 --static 托管）
├── database/                Python 持久化桥（纯标准库）
├── .pi/                     agent skills
├── .env.example             配置模板
└── runtime/
    ├── node/                内嵌 Node.js 便携版
    └── python/              内嵌 CPython（python-build-standalone）
```

## 集成点（为什么不需要改业务源码）

Python 解释器解析链在 `server/src/persistence/db-client.ts` 的 `probePythonBin()`：`BIOMED_PYTHON_BIN` 环境变量 → 仓库根 `.venv` → PATH。启动器把 `BIOMED_PYTHON_BIN` 指到 `runtime/python`，这是唯一的集成点。`database/bridge.py` 是纯标准库实现（`pyproject.toml` 无运行时依赖），因此只需解释器本身，不需要 uv、不需要 pip 安装。

前端托管走既有 `--static` 分支（`server/src/dev/static-middleware.ts`），`pnpm start` 的生产形态与 bundle 启动器等价。

## 运行时版本

下载地址与版本钉死在脚本顶部常量（`NODE_VERSION`、`PYTHON_VERSION`、`PYTHON_PBS_TAG`），升级即改常量。Python 取 python-build-standalone 发行版（uv 同源），按平台取 x64 Windows / x64 Linux / arm64 macOS。

GitHub 不可达时走代理重试：

```bash
https_proxy=http://127.0.0.1:7897 pnpm run pack
```

## 边界与已知事项

- Playwright 浏览器不随包（体积原因）；目标机用到浏览器工具时按 `README.txt` 中的命令安装 chromium。
- Linux/macOS 目标机首次运行需按 README 执行一次 `chmod +x`（从 Windows 打 zip 会丢失执行位；跨平台分发建议打 tar.gz）。
- bundle 内 `server/node_modules` 由 `pnpm deploy --prod --legacy` 物化，自包含、可随目录整体搬移；dev 依赖不进包。pnpm ≥10 要求 workspace 配置 `inject-workspace-packages=true` 才能用默认 deploy，本打包器改用 `--legacy`：注入式安装会在 install 时快照 workspace 包（早于 contracts 构建，dist 缺失），而 legacy deploy 在构建之后物化依赖，时序正确。
- CI bundle 隐患注记：现有 `package.yml` 的 staging 清单不含 `scripts/` 与 `packages/contracts/dist`，而 server 对 `@biomed/contracts` 有大量运行时值导入，且根 `pnpm start`（`pnpm --filter` 递归调用）不会触发 `prestart` 预构建——解包运行大概率 `ERR_MODULE_NOT_FOUND`（流水线自 2026-08-15 修复后未经 tag 验证）。本打包器在打包时构建 contracts 并物化依赖，不受该问题影响；CI 侧修复不在本分支范围。
