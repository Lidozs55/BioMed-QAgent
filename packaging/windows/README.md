# Windows 桌面启动器（pywebview）

`biomed_launcher` 是 Windows 便携包的默认启动入口：一个 PyInstaller 打包的
`--onefile --windowed` exe（`BioMed-QAgent.exe`，带 logo 图标）。双击后：

1. 用内嵌 Node 运行时拉起与 `start.bat` 完全相同的生产入口
   （`node server/dist/index.js --static`，`CREATE_NO_WINDOW`，全程无控制台）；
2. 从子进程 stdout 解析真实服务地址（`BIOMED_QAGENT_URL=` 行，端口被占时
   服务器会改用 OS 分配端口，以该行为准），并轮询 `/api/v1/health` 直到 200；
3. 打开 pywebview 桌面窗口（WebView2 后端）——这是**默认 UI 形态**；
4. 桌面窗口无法启动（缺 WebView2 / .NET 等）时**自动回退**：`webbrowser`
   打开系统默认浏览器，并弹出一个对话框说明服务在后台运行，点「确定」停止
   服务退出；
5. 正常关闭桌面窗口 → taskkill 树杀服务进程（durable runtime 会在下次启动时
   把未完成 run 标记为 interrupted，不会丢已完成结果）。

诊断日志写在包根 `launcher.log`（每次启动截断）。设置环境变量
`BIOMED_FORCE_BROWSER=1` 可跳过桌面窗口（排障用，已有测试覆盖该开关）。

`start.bat` 原样保留，作为命令行方式与排障入口；业务源码零改动——唯一的
集成点仍是 `BIOMED_PYTHON_BIN`（见 `server/src/persistence/db-client.ts`
的 `probePythonBin()`）。

## 布局

```
packaging/windows/
├── pyproject.toml        # 项目定义；pywebview 由 uv.lock 钉版本
├── .python-version       # 3.12
├── launcher_entry.py     # PyInstaller 入口脚本
├── biomed_launcher/
│   ├── __main__.py       # python -m biomed_launcher
│   ├── config.py         # bundle 布局、.env 解析、日志
│   ├── server.py         # node 子进程管理、URL 解析、健康等待、树杀
│   └── app.py            # GUI/回退编排、对话框
└── tests/                # pytest（不依赖 pywebview，webview 为惰性导入）
```

## 开发与测试

```bash
uv sync --project packaging/windows --locked   # 按 uv.lock 建环境
uv run --project packaging/windows pytest packaging/windows/tests
uv run --project packaging/windows ruff check packaging/windows
```

手动构建 exe（等价于打包器内嵌步骤，产物在当前目录 dist/）：

```bash
uv run --project packaging/windows pyinstaller --noconfirm --onefile --windowed \
  --name BioMed-QAgent --icon assets/logo/biomed-qagent.ico \
  --add-binary "assets/logo/biomed-qagent.ico;." \
  --collect-all webview --collect-all pythonnet --collect-all clr_loader \
  --paths packaging/windows packaging/windows/launcher_entry.py
```

## 与打包器的关系

`scripts/pack-release.mjs` 仅在 win 平台追加一步：在 git archive 快照里
`uv sync --locked` 后用 PyInstaller 把 exe 直接产出到 bundle 根目录，并把
图标（`assets/logo/biomed-qagent.ico`，由 `assets/logo/biomed-qagent-icon.png`
派生的多尺寸 ico）一并嵌入。要求打包机 PATH 上有 uv。

图标再生成（需 Pillow）：

```bash
uv run --with pillow --no-project python -c "
from PIL import Image
img = Image.open('assets/logo/biomed-qagent-icon.png').convert('RGBA')
img.resize((256, 256), Image.LANCZOS).save(
    'assets/logo/biomed-qagent.ico', format='ICO',
    sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)])
"
```

## 已知边界

- exe 未签名：目标机首次运行会遇到 SmartScreen（README 已注明「仍要运行」）。
- `--windowed` 下无控制台，stdout/stderr 不可见：所有诊断走 `launcher.log`。
- 浏览器回退模式下停止服务的唯一可见入口是回退对话框的「确定」按钮；
  若用户不点，服务与 exe 进程会一直在后台运行（可用任务管理器结束
  `BioMed-QAgent.exe`，node 子进程随之被树杀或自行退出）。
- pywebview 的窗口/任务栏图标为 best-effort（运行期经 pythonnet 设置 Form
  Icon，失败只记 debug 日志）；exe 文件本身的图标由 PyInstaller `--icon`
  保证。
