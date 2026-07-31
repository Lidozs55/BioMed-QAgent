# BioMed-QAgent Backend

生物医学数据检索、下载、整理和呈现系统 —— 基于 Qwen 与 OpenAI Agents SDK。

## 环境要求

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) 包管理器
- DashScope API Key（[申请地址](https://dashscope.console.aliyun.com/)）
- 可选：Playwright Chromium（用于 `web_visual_capture` 截图与 JS 重页面降级）

## 安装

```bash
cd backend
uv sync
# 如需视觉证据采集 / JS 重页面爬取：
uv run playwright install chromium
```

## 配置

复制 `.env.example` 为 `.env` 并填写 DashScope API Key：

```bash
cp .env.example .env
```

关键配置项：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHSCOPE_API_KEY` | (空) | DashScope API Key（**必填**） |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点 |
| `MODEL_NAME` | `qwen-plus` | Qwen 主模型名（Agent loop 使用） |
| `NCBI_EMAIL` | `biomed-qagent@example.com` | NCBI E-utilities 身份标识 |
| `NCBI_TOOL` | `BioMedQAgent` | NCBI E-utilities tool name |
| `NCBI_API_KEY` | (空) | NCBI E-utilities API Key（可获更高配额） |
| `NCBI_USER_AGENT` | `BioMed-QAgent/0.1 (...)` | NCBI HTTP User-Agent |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `8000` | 后端监听端口 |
| `OUTPUT_DIR` | `data/output` | 数据产物输出目录 |
| `LOG_LEVEL` | `INFO` | 日志等级（`DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL`） |
| `RUNTIME_MAX_ACTIVE_RUNS` | `4` | 并发 Run slot 上限 |
| `RUNTIME_SUBSCRIBER_QUEUE_SIZE` | `1000` | WebSocket 订阅者背压队列上限 |
| `TASK_PAGE_SIZE` | `30` | 任务历史默认分页 |

> 完整 Settings 定义见 [`app/config.py`](app/config.py)。

## 启动

```bash
uv run uvicorn app.main:app --reload
```

启动后访问：
- API 文档 (Swagger)：http://127.0.0.1:8000/docs
- API 文档 (ReDoc)：http://127.0.0.1:8000/redoc
- 健康检查：http://127.0.0.1:8000/api/v1/health

CORS 允许 Vite dev server 来源 `http://localhost:5173` 与 `http://127.0.0.1:5173`。

## 项目结构

```
backend/
├── app/
│   ├── main.py                       # FastAPI lifespan 入口（TaskManager / Repository / EventHub / TaskIndex）
│   ├── config.py                     # Settings dataclass（含 NCBI + Runtime 配置）
│   ├── model_config/                 # 模型配置 schema + 目录 + 供应商（UserSettings / RunModelSettings / AdvancedParams / QwenModelEntry）
│   ├── settings_manager.py           # 用户设置 CRUD（JSON 持久化 + 环境变量回退）
│   ├── agent_loop/                   # Agent 运行核心
│   │   ├── agent.py                  # build_agent / AGENT_MAX_TURNS=15 / INSTRUCTIONS
│   │   ├── runner.py                 # AgentRunExecutor：durable Run + typed 事件转换 + finish_reason 校验
│   │   ├── context.py                # RunContext：query_log / progress emitter / artifact provenance
│   │   ├── model.py                  # LazyDashScopeModel（OpenAI 兼容）+ max_turns 桥接
│   │   ├── summarizer.py             # ConversationSummarizer（truncation 显式抛异常，禁止静默降级）
│   │   └── vl_model.py               # Qwen-VL (qwen-vl-max) AsyncOpenAI 客户端
│   ├── api/                          # HTTP + WebSocket 接口
│   │   ├── routes.py                 # REST 端点（11 个，详见下方表）
│   │   ├── settings.py               # 模型设置 / 供应商 / 模型预览 REST（GET/PUT /settings、/vendors、POST /models）
│   │   ├── model_info_router.py      # 模型信息仓库 REST（GET /model-info、/model-info/{id}）
│   │   ├── ws.py                     # WebSocket 入口（/api/v1/ws）
│   │   └── ws_events.py              # durable event session（subscribe/replay/ping）
│   ├── core/
│   │   └── metrics.py                # MetricsTracker：阶段级指标追踪 + 消融报告导出
│   ├── domain/                       # 领域模型（Pydantic v2）
│   │   ├── contracts/                # 正式契约（base/ids/enums/events/runtime/task/source/pipeline/discovery）
│   │   ├── events.py / task.py / output.py / processing.py
│   ├── integrations/                 # 外部服务集成
│   │   ├── ncbi/                     # NcbiEutilsClient + parsers + discovery 工厂
│   │   ├── europepmc.py              # EPMC fullTextXML 客户端（PDF fallback Tier 3）
│   │   ├── unpaywall.py              # Unpaywall DOI→pdf_url 客户端（PDF fallback Tier 2）
│   │   └── acquisition.py            # acquire_source() + acquire_publication_with_fallback()（PDF 三级 fallback）
│   ├── pipeline/                     # 确定性 Pipeline Runner
│   │   ├── runner.py / state.py / tool.py
│   │   ├── stages/                   # discovery / acquisition / processing / artifact_build / validation
│   │   └── processing/geo_tximport.py
│   ├── runtime/                      # Durable runtime（事件溯源）
│   │   ├── manager.py                # TaskManager：Run lifecycle + 成功证据校验
│   │   ├── repository.py             # TaskRepository：先持久化再发布
│   │   ├── event_store.py            # append-only events.jsonl（sequence 单调递增）
│   │   ├── hub.py / index.py / session.py / state.py / compaction.py
│   ├── skills/                       # Skill 仓库
│   │   ├── registry.py / evolution.py
│   │   ├── builtin/                  # 14 个内置 Skill（详见下方表）
│   │   │   ├── discovery/            #   pubmed / understanding
│   │   │   ├── acquisition/          #   geo / gdc / pdb / pubchem / reactome / xena / browser / web_visual_capture
│   │   │   ├── processing/           #   extract_tables / extract_chart_data_vlm / self_evolution
│   │   │   └── analysis/             #   stats
│   │   └── learned/                  # 后天 Skill（默认禁用；AST + 路径白名单安全校验）
│   └── tools/                        # Function Tools
│       ├── _registry.py / io.py / workdir.py / crawler.py
│       ├── cleaning.py / alignment.py / processing.py / export.py
│       ├── parse_geo.py / parse_pdb.py / parse_excel.py
│       ├── content_cache.py / network_safety.py
├── tests/                            # pytest（86 文件 / 1025+ 测试，详见下方）
│   ├── agent_loop/ api/ contracts/ integration/ integrations/ live/
│   ├── pipeline/ runtime/ fixtures/ncbi/gse178352/
│   └── conftest.py + 24 个 root-level test_*.py
├── scripts/
│   ├── build_gse178352_fixture.py    # 重新生成 pinned fixture
│   └── demo_workflow.py              # 端到端冒烟演示
├── data/                             # 任务数据目录（gitignored）
│   └── output/tasks/<task_id>/       # source_assets/ download_tmp/ parsed/ normalized/
│                                     # staging/ artifacts/ state/ logs/
├── pyproject.toml                    # 依赖 + pytest + ruff 配置
├── uv.lock                           # uv 锁文件（权威依赖来源）
├── requirements.txt                  # pip 兼容子集（仅核心 6 项，**以 pyproject.toml 为准**）
├── .python-version                   # Python 3.12
├── launcher.py                       # PyInstaller 桌面应用入口
└── REPRODUCIBILITY.md                # 可复现性指南
```

## 架构与数据流

### 双层架构：Agent + 确定性 Pipeline

```text
用户主题 + 数据库限制
        │
        ▼
  REST POST /api/v1/tasks（durable admission）
        │
        ▼
  TaskManager → durable Run queue（4 并发 slot）
        │
        ▼
  AgentRunExecutor + TaskSession
        │
        └── Runner.run_streamed(Main Agent, input, context, session)
        │            │
        │            └── run_research_pipeline Function Tool
        │                    │
        │                    ▼
        │              确定性 Pipeline Runner
        │              (Discovery → Acquisition → Processing → ArtifactBuild → Validation)
        │                    │
        │                    └── 失败/截断/空产出 → warning 或 RunFailed
        │
        ▼
  TaskRepository 持久化 v2 EventEnvelope
  (run_queued / run_started / stage_started / stage_progress /
   tool_started / tool_completed / assistant_delta / artifact_produced /
   user_input_required / user_input_resumed / run_completed / run_failed)
        │
        ▼
  WebSocket subscribe + sequence replay/live fan-out
        │
        ▼
  前端按 task_id / run_id / sequence 更新 Task 投影
```

**Agent 职责**：理解主题 → 调 search_* 工具发现 accession → 生成 `TaskSpecification` → 调用 `run_research_pipeline` → 解释返回的 artifact 清单与 warning。Agent **不**直接拼装最终 CSV，**不**能绕过 Validation Gate。`AGENT_MAX_TURNS=15`，达到上限走 `UserInputRequiredPayload(prompt_kind="max_turns_reached")` 暂停等待用户选择继续或停止。

**Pipeline 职责**：强制执行 Discovery→Acquisition→Processing→ArtifactBuild→Validation 五阶段；每阶段记录 StageAttempt；只发布通过 Validation Gate 的 artifact；失败保证终态事件，不静默伪装成功。

### Skill 体系

14 个内置 Skill 按管线组织（`builtin/`）：

| 类别 | 内置 Skill |
|------|------------|
| **Discovery** | `pubmed`、`understanding` |
| **Acquisition** | `geo`、`gdc`、`pdb`、`pubchem`、`reactome`、`xena`、`browser_fallback`、`web_visual_capture` |
| **Processing** | `extract_tables`、`extract_chart_data_vlm`、`self_evolution` |
| **Analysis** | `stats` |

关键设计原则：
- Skill 是按需加载的能力包，Tool 是实际执行单元
- 一个网站对应多个 Tool（检索、查看元数据、下载是不同操作）
- 每个 Skill 建议不超过 20 个 Tool，超过 30 个必须拆分
- 后天 Skill（`learned/`）默认不覆盖同名内置 Skill；`save_learned_skill` / `load_learned_skill` 实施路径白名单 + AST 白名单双重安全校验（拒绝 `exec/eval/compile/open/__import__` 等）
- `web_visual_capture` 不出现在 `GET /databases`，由 Agent 按需调用
- `extract_chart_data_vlm` 使用 Qwen-VL（`qwen-vl-max`），三级降级链 L1→L2→L3 全部失败抛 `ChartExtractionError`（禁止静默空数据降级）

### PDF 三级 Fallback 链

`integrations/acquisition.py:acquire_publication_with_fallback()` 实现 project_memory 硬约束的"pdf_url → Unpaywall → EPMC"三级 fallback：

| Tier | 来源 | 触发条件 | 失败行为 |
|------|------|----------|----------|
| 1 | `pdf_url` 直接链接 | 元数据已含 pdf_url 且非 landing page | 转 Tier 2 |
| 2 | Unpaywall DOI 查询（5s timeout） | Tier 1 失败且 DOI 可用 | 转 Tier 3 |
| 3 | EuropePMC fullTextXML（PMCID，国内可用） | Tier 2 失败且 PMCID 可用 | 抛异常 |

所有 attempt（含失败）记录到 `download_log.csv`，保证来源可追溯。

### QueryStatus 枚举统一

`domain/contracts/enums.py:QueryStatus` 五态枚举：`success` / `not_found` / `failed` / `skipped` / `page_fallback`。所有 skill 的 `log_query()` 调用统一使用，`tests/test_query_log_status_consistency.py` AST 静态扫描保证迁移完整性。

## API 接口

### REST 端点（统一前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/databases` | 列出用户可选数据库（排除 `browser_fallback` / `web_visual_capture`） |
| `GET` | `/tasks` | 全部 active Task + cursor 分页历史 |
| `POST` | `/tasks` | 创建 durable Task 并排队首个 Run |
| `GET` | `/tasks/{task_id}` | 返回权威 `TaskSnapshot` |
| `DELETE` | `/tasks/{task_id}` | 删除 terminal Task 及其历史 |
| `POST` | `/tasks/{task_id}/runs` | 为 idle Agent Task 排队下一轮 Run |
| `POST` | `/tasks/{task_id}/runs/{run_id}/cancel` | 取消 queued/running/paused/finalizing/cancel-requested Run |
| `POST` | `/tasks/{task_id}/runs/{run_id}/resume` | 提交人在回路决策（计划确认 / max_turns / 数据修正） |
| `GET` | `/tasks/{task_id}/messages` | cursor 分页读取 durable messages |
| `GET` | `/tasks/{task_id}/events` | 按 `after_sequence` 重放 durable events |
| `GET` | `/tasks/{task_id}/artifacts` | 列出 manifest 注册且已验证的 Artifact |
| `GET` | `/tasks/{task_id}/artifacts/{artifact_id}` | 按 Artifact ID 下载并校验文件 |
| `GET` | `/settings` | 获取当前用户模型设置（api_key 掩码返回） |
| `POST` | `/settings` | 更新并持久化用户模型设置 |
| `GET` | `/vendors` | 列出已知模型供应商 |
| `GET` | `/models` | 可用模型列表，支持 `?query=`、`?preview_base_url=`、`?use_current_settings=` |
| `GET` | `/models/{model_id}` | 单个模型详情 |

**模型设置安全语义**

- **Key 掩码**：`GET /settings` 中长度不超过 12 的非空 `api_key` 返回 `****`，更长的 key 返回 `前4...后4`；空 key 返回空串。
- **Key 修改**：`POST /settings` 中 `api_key` 省略或等于掩码值时保留原值；空串清除 key 且重启后仍保持清除；非空字符串替换。只有持久化文件或 `api_key` 字段缺失时才回退到环境变量。
- **无 URL 传参**：`api_key` 仅通过 `POST /settings` body 传递，不存在 URL 查询参数泄漏途径。
- **本地 Host 边界**：应用只接受 `127.0.0.1` 与 `localhost` Host，恶意 Host 在路由执行前返回 400。
- **不安全 URL 拒绝**：供应商 URL 解析结果必须全部为公网地址；模型发现连接已校验 IP，并用原域名作为 Host/SNI，避免 DNS rebinding。校验失败返回 422。
- **带凭据请求要求 HTTPS**：模型发现、Agent 文本模型和 VLM 发送 key 前都要求 `https://`，否则拒绝请求。
- **无重定向**：模型发现 HTTP 客户端配置 `follow_redirects=False`，避免 SSRF 重定向攻击。
- **原子持久化**：设置写入 `data/user_settings.json` 使用 `tempfile.mkstemp` + `os.replace` 原子交换，中间文件在失败时清理。
- **显式客户端所有权**：每个 Agent Run 与 VLM 调用都关闭其创建的 `AsyncOpenAI` 客户端，不依赖 SDK delegate 的默认清理。

### WebSocket

**连接**：`ws://host:8000/api/v1/ws`

任务创建与续跑分别通过 `POST /api/v1/tasks` 和 `POST /api/v1/tasks/{task_id}/runs` 完成。WebSocket 仅接收三类控制命令：

- `{"type":"subscribe","task_id":"...","after_sequence":N}` — 先重放 sequence > N 的 durable events，再进入 live fan-out
- `{"type":"unsubscribe","task_id":"..."}` — 取消该 Task 的订阅
- `{"type":"ping"}` — 返回 `{"type":"pong"}`

服务端按 Task watermark 去重；慢消费者以可重连状态关闭。前端 `runtime/transport.ts` 自动重连并按 `lastSequence` 重新 subscribe。

### Durable Runtime 状态

每个 Task 的 durable 数据保存在后端：

- `<task_id>/events.jsonl` — append-only 事件日志（sequence 从 1 单调递增）
- `<task_id>/state/task_snapshot.json` — 原子写入的权威状态投影
- `<task_id>/state/session_items.jsonl` — OpenAI Agents SDK 原始 Session 历史
- `<task_id>/state/conversation_summary.json` — compaction 摘要
- `task_index.sqlite3` — 分页 + request-id 幂等查询（可重建）

`EventEnvelope` v2 为 managed Run 增加 `run_id`；sequence 是 **Task 级单调递增**，不是每个 Run 重新计数。HIL（人在回路）使用 `user_input_required` / `user_input_resumed` 事件，`POST /resume` 必须匹配 exact `request_id` 且只消费一次。

### 事件 Schema 变更（2026-07-20，向后兼容）

为支持前端 coding-agent 风格对话流展示，`ToolStartedPayload` 与 `ToolCompletedPayload` 增加了可选字段，旧 `events.jsonl` 仍可正常回放：

- `ToolStartedPayload.arguments: dict[str, JsonValue] | None`（默认 `None`）
  — 由 `agent_loop/runner.py:_extract_tool_arguments` 从 SDK `raw_item.arguments`
  解析并经 `_truncate_for_event` 递归截断（depth=3, str=200, list=20）。前端
  据此渲染"检索 PubMed · 查询: 'lung cancer'"等工具标签，无需额外请求。
- `ToolCompletedPayload.output` 现由 `_truncate_tool_output` 截断到 4 KB
  （`TOOL_OUTPUT_MAX_BYTES = 4096`），防止 `events.jsonl` 膨胀。原始 output 仍
  保留在 Run 的 Session 历史中，前端展开 ToolCallStep 详情时显示截断版本。

新增 helper 均为模块级纯函数，单元测试覆盖见
`tests/agent_loop/test_event_arguments.py`（28 项，含字符串/列表/深度截断、
JSON 解析失败、向后兼容、序列化往返）。

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| Web 框架 | FastAPI + uvicorn | 异步 HTTP + WebSocket |
| Agent SDK | openai-agents-python | Agent、Runner、Function Tool、HITL、MaxTurnsExceeded |
| LLM | Qwen（DashScope） | OpenAI 兼容接口（`qwen-plus` 主模型 / `qwen-vl-max` 视觉模型） |
| 数据模型 | Pydantic v2 + dataclass | 类型安全契约（`extra="forbid"`） |
| 生物信息 | Biopython + geoparse | NCBI E-utilities + GEO Series Matrix 解析 |
| PDF 处理 | pdfplumber | 表格提取 + 嵌入图片提取（VLM 降级链 L2） |
| 浏览器自动化 | Playwright Chromium | `web_visual_capture` + `browser_fallback` |
| 数据分析 | matplotlib, scipy, seaborn | 统计计算与可视化（可选） |
| HTTP 客户端 | httpx | 异步数据下载 |
| 测试 | pytest + pytest-asyncio + ruff | 单元 + 异步测试 + 静态检查（warnings as errors） |

### 依赖管理

权威依赖来源是 [`pyproject.toml`](pyproject.toml) 与 [`uv.lock`](uv.lock)。`requirements.txt` 仅为 pip 兼容子集（核心 6 项），**不**包含 `pdfplumber` / `playwright` / `beautifulsoup4` / `geoparse` / `biopython` 等运行时依赖，**不要**用它替代 `uv sync`。

## 测试

```bash
uv run pytest                    # 全部测试（默认排除 @pytest.mark.live）
uv run pytest -m live            # 仅 live 网络测试
uv run pytest tests/test_agent.py  # 单文件
uv run pytest -k "skill"         # 按关键字筛选
uv run ruff check app/ tests/ launcher.py   # CI 质量门禁（0 warnings）
```

测试配置：`asyncio_mode = "strict"`、`filterwarnings = ["error", ...]`（warnings as errors，仅显式忽略 Starlette TestClient 弃用警告）。

### 测试目录与覆盖（86 文件 / 1025+ 测试，2026-07-19）

| 目录 | 覆盖内容 |
|------|----------|
| `tests/test_*.py`（root, 24 文件） | Agent / Runner / Config / Domain contracts / Tool registry / Skill registry / IO / Workdir / Processing / Output / Summarizer / Network safety / Content cache / Demo workflow / Model credentials / Query log status / PDF fallback chain / Skill stats / Skill extract tables / Skill extract chart data VLM / Skill self evolution / Skill browser / Skill pdb / Skill gdc / Skill pubchem / Skill reactome / Skill understanding / Skill xena / Skill web visual capture / Tools crawler |
| `tests/agent_loop/`（8 文件） | Agent build / Agent run e2e / Context / Execution / LLM truncation / Max turns continue / Qwen function args retry / Silent completion |
| `tests/api/`（5 文件） | Artifact API / REST control / Resume API / Task API / WebSocket replay |
| `tests/contracts/`（6 文件） | Base & IDs / Event contracts / Pipeline contracts / Runtime contracts / Source contracts / Task contracts |
| `tests/pipeline/`（13 文件） | Event coverage / Event envelope unified / GEO tximport processing / Mode marking / Pinned pipeline / Pipeline e2e / Pipeline runner recovery / Pipeline runner resilience / Pipeline runner state machine / Pipeline tool / Publish lock / Task cancellation / Validation rules |
| `tests/runtime/`（10 文件） | Compaction / Control executor / Event store / Fixture executor / Hub / Index / Manager / Repository / Session / State reducer (+ user input) |
| `tests/integration/`（2 文件） | GSE178352 fixture / NCBI skill adapters |
| `tests/integrations/`（4 文件） | Acquisition / NCBI client / NCBI discovery / NCBI parsers |
| `tests/live/`（7 文件，`-m live`） | All data sources / Extract chart data VLM / GSE178352 / Pipeline / Qwen task spec / Reactome+PubChem / Web visual capture |

## 打包

后端支持通过 PyInstaller 打包为独立可执行文件（.exe），无需 Python 环境即可运行。

### 桌面应用模式

`launcher.py` 是 PyInstaller 的入口文件。它集成了以下功能：

- 启动 FastAPI 服务（基于 uvicorn）
- 自动挂载前端 `dist/` 目录为静态文件
- 服务就绪后自动打开浏览器

用户只需双击 `BioMed-QAgent.exe`，桌面应用即自动启动并在默认浏览器中打开界面。

### 手动打包命令

```bash
# 1. 构建前端生产版本
cd ../frontend && pnpm build

# 2. 复制前端产物到后端
cd ../backend && cp -r ../frontend/dist ./dist

# 3. 安装 PyInstaller
uv pip install pyinstaller

# 4. 打包为单文件可执行程序
pyinstaller --onefile --name BioMed-QAgent --add-data "dist;dist" --hidden-import app --collect-all app launcher.py

# 5. 输出位置：dist/BioMed-QAgent.exe
```

### 静态文件挂载

`launcher.py` 在启动时自动检测 `dist/` 目录的存在性：

- **打包模式**：PyInstaller 将运行时文件解压到临时目录（`sys._MEIPASS`），`launcher.py` 在该路径下查找 `dist/` 目录
- **源码模式**：直接查找 `launcher.py` 同级目录下的 `dist/` 文件夹

若 `dist/` 目录存在，则自动挂载静态文件服务（StaticFiles）和 SPA 回退路由（所有未匹配路径返回 `index.html`）；若不存在（开发模式），仅提供 API 路由。

### CI/CD 自动打包

项目配置了 GitHub Actions 工作流（`.github/workflows/package.yml`），当推送 `v*` 标签时自动触发：

1. 构建前端并复制产物
2. 使用 PyInstaller 打包为 `.exe` 文件
3. 上传构建产物为 Artifact
4. 创建 GitHub Release 并附加可执行文件

## 安全模型

- **文件隔离**：I/O Tool 只能访问当前任务工作目录，拒绝绝对路径、`..` 穿越和符号链接
- **密钥保护**：后天代码不得读取环境变量中的密钥
- **命令沙箱**：后天代码不得执行系统命令；`save_learned_skill` / `load_learned_skill` 实施路径白名单（`^[a-z][a-z0-9_]*$`）+ AST 白名单（拒绝 `exec/eval/compile/open/__import__/globals/locals/vars/breakpoint` 与 dunder 访问）
- **下载限制**：限制协议（仅 HTTP/HTTPS）、域名白名单（`_ALLOWED_HOSTS`）、文件大小和超时
- **用户确认**：敏感操作前通过 HITL 暂停，等待用户批准（计划确认 / max_turns / 数据修正）

## 扩展指南

### 添加新数据库 Skill

1. 在 `app/skills/builtin/acquisition/` 下创建模块
2. 实现 `search_*`、`describe_*`、`download_*` 三个 Tool 函数
3. 使用 `@function_tool` 装饰器注册到 SDK
4. 模块底部调用 `skill_registry.register(SkillDef(...))`
5. 在 `app/tools/_registry.py:BUILTIN_SKILL_MODULES` 追加模块
6. 若需走 Pipeline 产出 `SourceAsset`，在 `integrations/acquisition.py:_ALLOWED_HOSTS` 添加域名
7. 编写对应测试（检索、元数据、下载分离测试）

### 添加新解析器

1. 在 `app/tools/` 下创建解析模块
2. 实现返回 `ParsedDataset` 的解析函数
3. 在 `processing.py` 的 `parse_file()` 中添加格式路由

## 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 后端启动失败 `ModuleNotFoundError` | 依赖未安装 | 运行 `uv sync`（**勿用** `pip install -r requirements.txt`，子集不全） |
| DashScope API 返回 401 | API Key 无效 | 检查 `.env` 中的 `DASHSCOPE_API_KEY` |
| PubMed 检索超时 | NCBI 限速 | 已内置 0.34s/请求限速 + 429/5xx 重试；可设置 `NCBI_API_KEY` 提高配额 |
| GEO 下载失败 | 网络问题或格式不支持 | 自动降级到浏览器方案 |
| WebSocket 连接断开 | 模型输出超长或异常 | `summarizer.py` 自动压缩；`finish_reason="length"` 时抛异常而非静默 |
| 产物文件为空 | 解析步骤失败 | 查看 `data/output/tasks/<id>/logs/` |
| Qwen 偶发 400（function.arguments 非 JSON） | LLM 返回非法 JSON | `AgentRunExecutor` 自动用原始 input 重跑（`QWEN_FUNCTION_ARGS_RETRY_LIMIT=2`） |
| GitHub push 443 间歇失败 | 网络抖动 | 本地 `main` 已就绪，稍后 `git push origin main` 重试 |

## 相关文档

- [项目架构设计（权威）](../docs/ARCHITECTURE.md)
- [可复现性指南](REPRODUCIBILITY.md)
- [开发 TODO](../docs/TODO.md)
- [2026-07-18 流程审查报告](../docs/REVIEW_2026-07-18.md)
- [前端 README](../frontend/README.md)
- [Skill 接口规范](../docs/skills_interface_spec.md)
