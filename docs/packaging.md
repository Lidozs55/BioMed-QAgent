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

构建机要求：git、pnpm（锁文件版本）、Node 22、tar、curl。依赖 store 已热时全程可离线；运行时下载见下节。交叉打包（构建非本机平台的 bundle）额外要求 PATH 上有任意带 pip 的 CPython（见"内嵌科学计算栈"）。

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
                             预装 numpy + scipy（见"内嵌科学计算栈"）
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

## 内嵌科学计算栈（numpy / scipy）

内嵌 Python 预装 `PYTHON_EXTRAS` 钉死的科学计算包（当前 numpy 2.5.2、scipy 1.18.1），供目标机上的分析类脚本直接使用。要点：

- **安装方式**：`pip install --platform <目标平台标签> --python-version 3.12.14 --implementation cp --only-binary=:all: --no-deps --target <内嵌 site-packages>`。wheel 按目标平台标签解析与解包，目标平台代码从不在构建机执行，因此交叉打包（如在 Windows 上出 linux 包）同样可用。
- **平台标签**：win → `win_amd64`；linux → `manylinux_2_28_x86_64`（兼容 `manylinux_2_27.manylinux_2_28` 复合标签 wheel）；macOS → `macosx_11_0_arm64` + `macosx_12_0_arm64` 两个标签都传（numpy 用前者、scipy 用后者）。
- **平台约束**：linux 包要求目标机 glibc ≥ 2.28（Ubuntu 20.04+ / Debian 11+ 等）；macOS 包要求 Apple Silicon + macOS 12+。
- **体积影响**：wheel 下载量每平台约 +47 MB（压缩态）；解压进 bundle 约 +180 MB（实测 win：534.8 → 715.1 MiB，scipy 占大头，捆绑 OpenBLAS 二进制）。
- **升级**：改脚本顶部 `PYTHON_EXTRAS` 常量。若新版本在某平台缺 cp312 wheel，打包会在该步显式失败（不会静默产出缺包 bundle）。
- **架构边界不变**：`database/` 与 `pyproject.toml` 仍是纯标准库，numpy/scipy 只存在于分发包的内嵌运行时；bridge 与开发环境均不感知、不受影响。
- **交叉打包前置**：跨平台打包时 pip 进程本身要能跑，要求构建机 PATH 上有任意带 pip 的 CPython（同平台打包直接用内嵌解释器，无额外要求）。

## 跨平台交叉打包（在 Windows 上出 linux / macos 包）

打包器设计为任一宿主 OS 可出全部三平台包：构建产物与平台无关，wheel 按 `--platform` 目标标签解包（目标代码零执行）。已在 Windows 宿主上实测产出 linux/macos 包，并做过如下针对性处理（每一条都来自实测踩坑）：

- **Windows 宿主前置**：PATH 上需要 GNU tar（Git for Windows 自带，脚本会依次探测 `tar` 与两处 Git 安装路径）。System32 的 bsdtar 解不了 posix 运行时 tar 包里的符号链接条目——遇到即硬报错（exit 1）且输出残缺；GNU tar 会优雅降级：真实文件全部落地、无法物化的别名条目跳过（exit 2，打包器对运行时归档容忍该退出码并校验关键入口存在）。
- **内嵌 Python 入口用带版本号的真实二进制**：pbs tar 包里 `bin/python3 -> python3.12` 等别名排在真实文件之前，在 Windows 上解不出来。因此 posix 启动器与 `BIOMED_PYTHON_BIN` 直接指向 `bin/python3.12`（真实文件必然存在），不经符号链接；`README.txt` 的 chmod 指引同步使用该路径。
- **原生绑定（关键）**：`pnpm deploy` 只物化宿主平台的可选原生绑定（如 pdfjs-dist 背后的 `@napi-rs/canvas`、`@mariozechner/clipboard`），交叉打包出的 posix 包启动即崩（实测报 `DOMMatrix is not defined`）。两层修复：① 打包时向快照的 `pnpm-workspace.yaml` 追加 `supportedArchitectures`（**必须是 map 形式** `os:/cpu:/libc:` 列表并包含 `current`；写成数组套对象 YAML 能解析、install 会静默忽略——踩坑实测），使 install 连目标平台变体一起取回（lockfile 本就记录了全部变体）；② deploy 后把 workspace store 里目标平台的绑定包复制进 bundle 的 `server/node_modules/.pnpm/node_modules` 回退目录（Node 解析链会经过该目录；deploy 已物化的条目自动跳过），并通过"零绑定即失败"的 tripwire 防止静默产出起不来的包。
- **CLI 参数转发**：pnpm 11 会把 `--` 分隔符原样转发给脚本，parseArgs 会把它当 positional 边界吞掉其后所有参数（历史上 `--platform=win` "能用"纯属默认值碰巧是 win）。脚本已改为过滤游离的 `--`，`pnpm run pack -- --platform=all` 与 `pnpm run pack --platform=all` 等价。
- **验证情况**：win 包在 Windows 实测独立启动（health ok / 静态 200 / bridge 进程确用内嵌 python）；linux 包在 WSL Ubuntu-22.04 全链路实测通过（health 200 / 静态页 200 / databases 接口返回真实数据 / bridge 进程为内嵌 `python3.12`，内嵌 numpy 2.5.2 / scipy 1.18.1 数值计算通过。注：从 Windows 盘符的 9P 挂载冷启动需约 2 分钟加载模块，属 WSL 跨文件系统开销，原生 ext4 上无此问题）；macos 包未经真机验证（wheel 解析与绑定落位已验证），建议首次使用前在真机跑一次 `start.sh`。
- **分发注意**：从 Windows 分发建议打 tar.gz（zip 会丢执行位）；linux 目标机要求 glibc ≥ 2.28；macOS 目标机要求 Apple Silicon + macOS 12+。

## 边界与已知事项

- Playwright 浏览器不随包（体积原因）；目标机用到浏览器工具时按 `README.txt` 中的命令安装 chromium。
- Linux/macOS 目标机首次运行需按 README 执行一次 `chmod +x`（从 Windows 打 zip 会丢失执行位；跨平台分发建议打 tar.gz）。
- bundle 内 `server/node_modules` 由 `pnpm deploy --prod --legacy` 物化，自包含、可随目录整体搬移；dev 依赖不进包。pnpm ≥10 要求 workspace 配置 `inject-workspace-packages=true` 才能用默认 deploy，本打包器改用 `--legacy`：注入式安装会在 install 时快照 workspace 包（早于 contracts 构建，dist 缺失），而 legacy deploy 在构建之后物化依赖，时序正确。
- CI bundle 现状注记：上游 `package.yml` 已补上 `scripts/build-contracts-if-needed.mjs` 的 staging，并在冒烟测试里显式执行 `pnpm --filter @biomed/server run prestart` 后直接 `node server/dist/index.js --static` 启动（绕开根 `pnpm start` 递归调用不触发钩子的坑），同时新增端口回退与单实例锁验证——解包启动路径已可用，但 CI bundle 仍是"源码+产物"形态，目标机仍需全套构建环境。本打包器产出"便携整机"形态，打包时即构建 contracts 并物化依赖，二者互不影响。
