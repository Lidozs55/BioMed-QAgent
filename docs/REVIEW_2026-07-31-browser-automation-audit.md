# 浏览器自动化接入审计报告（2026-07-31）

> 范围：审计当前浏览器自动化（Playwright / Chrome DevTools / harness `browser` 设备 / MCP）的接入情况，
> 并从**架构**、**代码实现**、**提示词**三层分析"当前模型（deepseek-v4-flash）似乎认为自己无法接入浏览器"的成因。
> 本报告仅审计，**未改动任何代码**。
>
> 全部结论均经实测验证（含一次浏览器端到端探测），非推断。

---

## TL;DR

**浏览器接入能力实际存在且可用**：harness 原生 `browser` 设备（Puppeteer + 系统 Chrome）在本会话中
端到端实测通过（open → navigate → extract → close）。QAgent 仓库内 Playwright 集成（BrowserPool /
crawler_facade / browser_fallback / web_visual_capture）代码完整、运行时接线正确。

**但模型被多层信号误导，容易得出"无法接入浏览器"的结论**。三个最可能的成因：

1. **提示词层（最强）**：本会话注入的 `chrome-devtools`、`troubleshooting`、`a11y-debugging` 三个
   Skill 全部把浏览器自动化描述为"通过 Chrome DevTools **MCP** 实现"，而本会话没有任何浏览器 MCP
   服务器被配置——模型读到这些 Skill 后推断"浏览器 = 需要 MCP = 没有 MCP = 无法访问"。
2. **架构层**：项目与用户级所有 MCP 配置（`.codex/config.toml`、`.vscode/mcp.json`、`opencode.json`、
   `~/.claude.json`、全局 `~/.codex/config.toml`）都**只配置了 `commonly`/`context7`/`unityMCP`**，
   没有任何 `chrome-devtools-mcp` / `playwright-mcp`。模型检查"有没有浏览器 MCP"时得到空结果。
3. **代码层（弱，仅误报）**：`~/.omp/puppeteer/package.json` 是空 `{}` 且目录无 `node_modules`，
   看起来像"Puppeteer 未安装"——实为 harness 的正常副作用（`loadPuppeteer()` 先写 `{}` 再导入
   `puppeteer-core`，后者真实存在）。真正可用的 Chromium 是**系统 Chrome**，与 Playwright 的
   `ms-playwright` 缓存无关。

---

## 一、现状盘点（实测）

### 1.1 Harness 原生 `browser` 设备 —— ✅ 可用

- 工具已挂载（本会话工具清单含 `xd://browser`）。
- **端到端实测通过**（2026-07-31，本会话）：

  | 步骤 | 结果 |
  |---|---|
  | `open https://example.com` | `Opened tab "probe" on headless browser; URL: https://example.com/; Title: Example Domain` |
  | `run tab.extract()` | 返回页面文本（Readability 提取成功） |
  | `close` | `Closed tab "probe"` |

- 依赖链（均已验证存在）：
  - `puppeteer-core` → `C:/Users/cheng/.bun/install/global/node_modules/puppeteer-core` ✅
  - Chromium 可执行文件 → 系统 Chrome `C:/Program Files/Google/Chrome/Application/chrome.exe` ✅
    （harness 启动顺序：检测系统 Chrome → `PUPPETEER_EXECUTABLE_PATH` → 下载；本机走第一条）
  - `~/.omp/puppeteer/package.json` = `{}` 是 **harness 文档化的正常行为**
    （`loadPuppeteer()` 在导入前写空 `package.json` 到安全目录，browser.md Side Effects 明示），
    **不是**未安装的证据。
- 浏览器类型解析：无 `app` 时优先 cmux（`CMUX_SOCKET_PATH`，Windows 无）→ headless。本机走 headless。

### 1.2 Chrome DevTools MCP —— ❌ 未配置（但痕迹存在）

- `mcp-chrome-7649d1e` 目录存在于 `%LOCALAPPDATA%/ms-playwright/` —— 说明 chrome-devtools-mcp
  曾在本机某处运行过（chrome-devtools-mcp 用它作为 Chrome profile）。
- **没有任何当前生效的配置**引用它：
  - 项目级：无 `.mcp.json`；`.codex/config.toml`、`.vscode/mcp.json`、`opencode.json` 均只有 `commonly`。
  - 用户级：`~/.claude.json` 顶层 `mcpServers` 仅 `unityMCP`、`context7`；`~/.codex/config.toml`
    仅 `context7`、`unityMCP`。
- 结论：chrome-devtools MCP 工具（`list_pages`/`navigate_page`/`take_snapshot` 等）在本会话**不存在**。

### 1.3 Playwright MCP —— ⚠️ 半配置

- 仓库根存在 `.playwright-mcp/`（含 `page-*.yml`、`console-*.log`、PNG 截图，最近 2026-07-23），
  是 Playwright MCP server 的**输出目录**（已 gitignore，`*` 通配）。说明它曾被配置使用过。
- 但**当前没有任何配置**（项目或用户级）启动 playwright-mcp server。目录是历史残留，非生效接入。

### 1.4 QAgent 仓库内的 Playwright 集成 —— ✅ 代码完整、接线正确

| 组件 | 状态 | 证据 |
|---|---|---|
| `BrowserPool`（`app/tools/browser_pool.py`） | 完整 | 异步 Playwright 池，lazy launch，每操作独立 context，stealth，限流 |
| `ControlledEgressProxy`（`app/tools/egress_proxy.py`） | 完整 | **进程内** asyncio 代理（`127.0.0.1:0`），无外部依赖；仅放行公网 HTTPS:443 |
| `CrawlerFacade.browser()` | 完整 | 经 shared limiter + BrowserPool 渲染页面 |
| `browser_fallback` Skill | 完整 | `navigate_page` / `download_from_page`，经 `run_ctx.crawler_facade.browser()` |
| `web_visual_capture` Skill | 完整 | `capture_web_page` / `capture_page_section` → `crawler_facade.screenshot` → 真实 Playwright |
| `RunContext.crawler_facade` | 接线正确 | `bind_crawler_facade()` 由 lifespan 注入，子上下文继承（`context.py:331-332`） |
| `main.py` lifespan | 正确 | `BrowserPool.start()` → `manager.start()` → yield → close |

依赖：`playwright>=1.40.0` 在 `pyproject.toml` 与 `requirements.txt`；`%LOCALAPPDATA%/ms-playwright/`
下有 `chromium-1194` / `chromium-1228` 等缓存 ✅。

---

## 二、三层成因分析：模型为何认为自己"无法接入浏览器"

### 2.1 提示词层（最可能的直接原因）

本会话系统提示注入的 Skill 中，浏览器自动化被**反复描述为 MCP 专属**：

| Skill | 描述原文（模型所见） | 误导点 |
|---|---|---|
| `chrome-devtools` | "Uses Chrome DevTools **via MCP**... This skill does not apply to `--slim` mode (**MCP configuration**)" | 模型读到"浏览器自动化 = 需要 chrome-devtools MCP" |
| `troubleshooting` | "Uses Chrome DevTools MCP... Trigger this skill when `list_pages`, `new_page`, or `navigate_page` fail" | 列出的是 **MCP 工具名**，与 harness 原生 `browser` 设备（`open`/`run`）命名完全不同 |
| `a11y-debugging` | "Uses Chrome DevTools **via MCP** for accessibility debugging" | 同上 |

而 `browser` 设备（xd://browser）的提示词（`prompts/tools/browser.md`）确实存在且描述完整，但：
- 它使用完全不同的动词（`open`/`run`/`tab.*`），与 MCP 风格工具名无交集；
- 模型若先读 Skill 列表形成"浏览器 = MCP"的预设，再核对 MCP 配置为空，就完成了"无法接入"的推理闭环，
  不会再去翻 `browser` 设备的提示词。

**这是三层中最强、最直接的成因。**

### 2.2 架构层（可验证的客观事实）

- 所有生效的 MCP 配置（项目级 + 用户级）均无浏览器类 server —— 客观事实，见 §1.2。
- harness 的 `browser` 设备与 MCP 是**两套平行机制**，但提示词层没有说明这一点：
  - MCP 路径：需要配置文件启动 server，本机**没有**。
  - 原生路径：无需任何配置，Puppeteer + 系统 Chrome 直接可用（实测通过）。
- 模型若以"检查 MCP 配置"作为判断浏览器可用性的依据（且无提示词纠偏），结论必然是"不可用"。
- 另：`.playwright-mcp/` 目录历史残留可能进一步误导——模型看到它以为有 Playwright MCP 配置，
  去查配置又找不到，可能归因于"配置损坏/未生效"。

### 2.3 代码层（弱信号 + 一个误报）

| 信号 | 真实性 | 说明 |
|---|---|---|
| `~/.omp/puppeteer/package.json` = `{}`、无 `node_modules` | **误报** | harness 文档化的加载行为，puppeteer-core 真实存在于 Bun 全局 |
| 无 `~/.cache/puppeteer` | 无碍 | headless 优先用系统 Chrome，无需 puppeteer 缓存 |
| QAgent `_NON_SELECTABLE_BUILTINS` 含 `browser_fallback`/`web_visual_capture` | 部分 | 仅影响**前端 UI 可选列表**（`/databases` 过滤 `user_selectable`）；`find_skill`/`invoke_skill` 只过滤 `enabled`，**模型仍可发现和调用**浏览器 Skill |
| QAgent 主代理 INSTRUCTIONS 未提及浏览器 | 弱 | 主代理只注入 `find_skill`/`invoke_skill`，browser 属于可发现的 acquisition Skill；无直接误导 |
| `browser_fallback` Skill 自身 instructions："Use browser_fallback tools **only when API endpoints are unavailable**" | 弱 | 把浏览器定位为 last-resort，可能让 QAgent 侧的 Qwen 模型低估浏览器能力，但对 harness 侧 deepseek 无影响 |

**代码层没有真实的"浏览器不可用"故障。** 唯一的 `{}` package.json 是误报源。

### 2.4 补充：模型模态的间接影响（非阻塞）

- 当前模型 `bifrost/deepseek-v4-flash`：`input: [text]`，无图像。
- 但 harness 配置了 `modelRoles.vision: bifrost/gpt-5.6-luna`，且 `images.describeForTextModels: true`
  （默认）——文本模型收到图片附件时，harness 自动用视觉模型生成文字描述注入会话
  （`agent-session.ts #buildImageDescriptionNotice`），另有 `inspect_image` 工具
  （`loadMode: "discoverable"`）可显式分析截图。
- 结论：截图能力**没有**被模态阻塞，但模型可能误以为"我是文本模型 → 浏览器截图我看不了 → 浏览器没用"。
  这是提示词层的次级诱因。

---

## 三、修复建议（供后续决策，本报告未实施）

按投入产出排序：

1. **提示词层（最高优先）**：在系统提示或 `browser` 设备提示词中显式说明"浏览器自动化由 harness 原生
   `browser` 设备提供（`open`/`run`），**不依赖** chrome-devtools/playwright MCP；若未配置浏览器 MCP，
   原生设备仍完全可用"。并给 `chrome-devtools`/`troubleshooting`/`a11y-debugging` Skill 描述加
   "若未配置 Chrome DevTools MCP，改用原生 `browser` 设备" 的指引。
2. **架构层**：如确实需要 MCP 风格浏览器工具，在 `.codex/config.toml` / `.vscode/mcp.json` 添加
   `chrome-devtools-mcp`（`npx chrome-devtools-mcp@latest`）。若不需要，清理 `.playwright-mcp/`
   历史残留，避免模型误判。
3. **代码层（误报消除）**：在 `~/.omp/puppeteer/` 目录放一个 README 说明 `{}` package.json 是
   harness 正常加载行为（或由 harness 在首次启动时写入说明文件）。
4. **QAgent 侧（可选）**：`browser_fallback` Skill 的 instructions 措辞从"only when API endpoints
   are unavailable"放宽为"API 失败或需要 JS 渲染时优先使用"，并在主代理 INSTRUCTIONS 的
   动态 Skill 发现协议中补一句浏览器能力可用性说明。

---

## 附：证据清单

- 本会话浏览器设备端到端探测：`xd://browser` open/run/close 全部成功（见 §1.1 表）。
- `puppeteer-core` 存在：`C:/Users/cheng/.bun/install/global/node_modules/puppeteer-core`。
- 系统 Chrome 存在：`C:/Program Files/Google/Chrome/Application/chrome.exe`；
  Edge：`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`。
- `~/.omp/puppeteer/package.json` 内容为 `{}`（2 字节），无 `node_modules`。
- harness 源码 `tools/browser.md` Side Effects 明示 `loadPuppeteer()` 写 `{}`。
- MCP 配置清单：`.codex/config.toml`（仅 commonly）、`.vscode/mcp.json`（仅 commonly）、
  `opencode.json`（仅 commonly）、`~/.claude.json`（仅 unityMCP/context7）、
  `~/.codex/config.toml`（仅 context7/unityMCP）；项目无 `.mcp.json`。
- `models.yml`：`bifrost/deepseek-v4-flash input: [text]`；`config.yml`：
  `modelRoles.vision: bifrost/gpt-5.6-luna`；`images.describeForTextModels` 默认 `true`。
- QAgent：`BrowserPool`/`CrawlerFacade`/`browser_fallback`/`web_visual_capture` 均存在且接线正确；
  `/databases` 路由过滤 `user_selectable`（`routes.py:195,201`），`find_skill`/`invoke_skill`
  仅过滤 `enabled`（`gateway.py:79,134`）。
