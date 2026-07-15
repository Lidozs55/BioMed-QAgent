# BioMed-QAgent Backend

生物医学数据检索、下载、整理和呈现系统 —— 基于 Qwen 与 OpenAI Agents SDK。

## 环境要求

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) 包管理器
- DashScope API Key（[申请地址](https://dashscope.console.aliyun.com/)）

## 安装

```bash
cd backend
uv sync
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
| `MODEL_NAME` | `qwen-plus` | Qwen 模型名（也支持 `qwen3.6-flash` 等） |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `8000` | 后端监听端口 |
| `OUTPUT_DIR` | `data/output` | 数据产物输出目录 |

## 启动

```bash
uv run uvicorn app.main:app --reload
```

启动后访问：
- API 文档 (Swagger)：http://127.0.0.1:8000/docs
- API 文档 (ReDoc)：http://127.0.0.1:8000/redoc
- 健康检查：http://127.0.0.1:8000/api/v1/health

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

通过此流程，每次版本发布均可自动生成可直接运行的桌面应用安装包。

## 项目结构

```
backend/
├── app/
│   ├── main.py                # FastAPI 入口（CORS、路由注册）
│   ├── config.py              # 配置 dataclass（从 .env 加载）
│   ├── agent_loop/            # Agent 运行核心
│   │   ├── agent.py           # create_agent()：构建 Main Agent
│   │   ├── runner.py          # durable Agent/fixture Run 执行 + typed 事件转换
│   │   ├── context.py         # RunContext：任务状态、来源记录、工作目录
│   │   ├── model.py           # 模型适配器（DashScope Qwen / OpenAI 兼容）
│   │   └── summarizer.py      # ContextManager：查询日志压缩（超过 8000 字符时触发）
│   ├── api/                   # HTTP + WebSocket 接口
│   │   ├── routes.py          # REST 端点（databases、tasks、artifacts）
│   │   └── ws.py              # WebSocket 端点（/api/v1/ws）
│   ├── core/
│   │   └── metrics.py         # MetricsTracker：阶段级指标追踪 + 消融报告导出
│   ├── domain/                # 领域模型
│   │   ├── __init__.py        # 公共 API 导出
│   │   ├── task.py            # TaskRequest、TaskRecord、TaskStateMachine
│   │   ├── events.py          # TaskEvent、EventFactory
│   │   ├── output.py          # SourceRecord、DataRecord、OutputBundle
│   │   └── processing.py      # ParsedDataset、CleaningReport
│   ├── skills/                # Skill 仓库
│   │   ├── registry.py        # SkillRegistry + SkillDef + build_agent_config()
│   │   ├── evolution.py       # 自迭代引擎（save_learned_skill、create_evolution_md）
│   │   ├── builtin/           # 内置 Skill（9 个，团队维护）
│   │   │   ├── discovery/     #   pubmed.py、understanding.py（文献检索与理解）
│   │   │   ├── acquisition/   #   geo.py、gdc.py、xena.py、pdb.py、browser.py
│   │   │   ├── processing/    #   extract_tables.py、self_evolution.py
│   │   │   └── analysis/      #   stats.py
│   │   └── learned/           # 后天 Skill（自迭代生成，4 个类别子目录）
│   └── tools/                 # Function Tools
│       ├── _registry.py       # get_all_tools()：从 Skill 收集启用的 Tool
│       ├── io.py              # read_file、write_file、list_files（路径安全检查）
│       ├── workdir.py         # TaskWorkDir、create_task_workdir()
│       ├── search.py          # 文献检索（已迁移至 pubmed Skill，保留占位）
│       ├── parse.py           # PDF 解析（占位 stub）
│       ├── processing.py      # parse_csv/json/html、identify_format、parse_file
│       ├── cleaning.py        # count_missing、detect_duplicates、clean_dataset
│       ├── alignment.py       # normalize_field_names、align_fields、merge_datasets
│       ├── export.py          # 导出 CSV：records、来源清单、字段说明、处理记录
│       ├── parse_excel.py     # Excel 解析器（openpyxl）
│       ├── parse_geo.py       # GEO 格式解析（Series Matrix、SOFT）
│       ├── parse_pdb.py       # PDB/mmCIF 解析器
│       └── analyze.py         # 数据分析（占位 stub）
├── tests/                     # pytest 测试（12 个文件）
│   ├── test_agent.py          # Agent 创建与 Skill 加载
│   ├── test_runner.py         # Runner 流事件
│   ├── test_config.py         # 配置加载
│   ├── test_domain_contracts.py # 领域模型契约
│   ├── test_tool_registry.py  # 工具注册表
│   ├── test_skill_registry.py # Skill 注册表
│   ├── test_tools_io.py       # I/O 工具路径安全
│   ├── test_workdir.py        # 工作目录创建
│   ├── test_processing.py     # 文件解析（CSV/JSON/HTML）
│   ├── test_output.py         # CSV 导出
│   └── test_summarizer.py     # 查询日志压缩
├── scripts/
│   └── demo_workflow.py       # 端到端演示管道（PubMed → GEO → 解析 → 分析）
├── data/                      # 任务数据目录
│   ├── tasks/<task_id>/       # 单任务工作目录
│   │   ├── raw/               # 原始下载文件（只读）
│   │   ├── parsed/            # 解析结果
│   │   ├── normalized/        # 清洗对齐后数据
│   │   ├── artifacts/         # 最终产物（CSV、来源清单）
│   │   └── logs/              # Tool 调用和下载记录
│   └── output/                # 全局输出目录
├── pyproject.toml             # Python 项目配置（依赖、pytest 设定）
├── uv.lock                    # uv 依赖锁文件
├── requirements.txt           # pip 兼容依赖列表
├── .python-version            # Python 3.12 版本锁定
└── REPRODUCIBILITY.md         # 可复现性指南
```

## 架构与数据流

### Agent 运行循环

```text
用户主题 + 数据库限制
        │
        ▼
  REST POST admission
  (/api/v1/tasks 或 /api/v1/tasks/{task_id}/runs)
        │
        ▼
  TaskManager → durable Run queue
        │
        ▼
  AgentRunExecutor + TaskSession
        │
        └── Runner.run_streamed(Main Agent, input, context, session)
        │
        ▼
  TaskRepository 持久化 v2 EventEnvelope
  (Run lifecycle / assistant_delta / tool_started /
   tool_completed / artifact_produced)
        │
        ▼
  WebSocket subscribe + sequence replay/live fan-out
        │
        ▼
  前端按 task_id / run_id / sequence 更新 Task 投影
```

### Skill 体系

4 类 Skill 按管线组织：

| 类别 | 职责 | 内置 Skill |
|------|------|------------|
| **Discovery** | 文献检索、摘要理解、数据来源发现 | `pubmed`、`literature_understanding` |
| **Acquisition** | 数据库检索、元数据获取、原始文件下载 | `geo`、`gdc`、`xena`、`pdb`、`browser_fallback` |
| **Processing** | 文件解析、数据清洗、字段对齐、多源合并 | `pdf_extraction`、`self_evolution` |
| **Analysis** | 统计分析、可视化（可选） | `analysis` |

关键设计原则：
- Skill 是按需加载的能力包，Tool 是实际执行单元
- 一个网站对应多个 Tool（检索、查看元数据、下载是不同操作）
- 同类网站共享一个 Skill（如 `omics_databases` 组织 GEO、GDC、Xena）
- 每个 Skill 建议不超过 20 个 Tool，超过 30 个必须拆分
- 后天 Skill（`learned/`）默认不覆盖同名内置 Skill

### 数据管道

```text
Discovery：论文检索与理解
        │
        ▼
  数据库、查询式、accession 候选
        │
        ▼
Acquisition：API/脚本检索与下载
        │  失败 → Browser Fallback Tool
        ▼
  raw/ 原始文件 + 下载记录
        │
        ▼
Processing：解析 → 清洗 → 对齐 → 合并
        │
        ▼
  artifacts/ CSV + 来源清单 + 字段说明 + 处理记录
        │
        ▼
Analysis：统计与可视化（可选）
```

## API 接口

### REST 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/health` | 健康检查 |
| `GET` | `/api/v1/databases` | 获取可用数据库列表及其分类 |
| `GET` | `/api/v1/tasks/{task_id}` | 查询任务状态与详情 |
| `GET` | `/api/v1/tasks/{task_id}/artifacts` | 列出任务产物文件 |
| `GET` | `/api/v1/tasks/{task_id}/artifacts/{filename:path}` | 下载产物文件 |

### WebSocket

**连接**：`ws://host:8000/api/v1/ws`

任务创建与续跑分别通过 `POST /api/v1/tasks` 和
`POST /api/v1/tasks/{task_id}/runs` 完成。WebSocket 仅接收
`subscribe`、`unsubscribe` 和 `ping` 控制命令。

**订阅任务事件**：
```json
{
  "type": "subscribe",
  "task_id": "task_123",
  "after_sequence": 0
}
```

订阅成功后，服务端按 sequence 推送 durable `EventEnvelope`；`ping` 返回
`pong`，无效或不支持的命令返回稳定的 `error` 控制帧。

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| Web 框架 | FastAPI + uvicorn | 异步 HTTP + WebSocket |
| Agent SDK | openai-agents-python | Agent、Runner、Function Tool、HITL |
| LLM | Qwen（DashScope） | OpenAI 兼容接口接入 |
| 数据模型 | Pydantic v2 + dataclass | 类型安全的数据结构 |
| 生物信息 | Biopython | Entrez/PubMed API 封装 |
| 数据分析 | matplotlib, scipy, seaborn | 统计计算与可视化 |
| HTTP 客户端 | httpx | 异步数据下载 |
| 测试 | pytest + pytest-asyncio | 单元测试 + 异步测试 |

### 依赖列表

```
fastapi, uvicorn[standard], websockets    # Web 框架
openai-agents                             # Agent SDK
pydantic, python-dotenv                   # 数据模型与配置
httpx                                     # HTTP 客户端
biopython                                 # PubMed/Entrez API
matplotlib, scipy, seaborn                # 科学计算与可视化
geoparse                                  # 地理信息解析
```

## 测试

```bash
uv run pytest                    # 运行全部测试
uv run pytest -v                 # 详细输出
uv run pytest tests/test_agent.py  # 运行特定测试文件
uv run pytest -k "skill"         # 按关键字筛选
```

测试覆盖：

| 测试文件 | 覆盖内容 |
|----------|----------|
| `test_agent.py` | Agent 创建、Skill 加载与去重 |
| `test_runner.py` | Runner 流事件转换 |
| `test_config.py` | 配置加载与环境变量 |
| `test_domain_contracts.py` | 领域模型数据契约 |
| `test_tool_registry.py` | 工具注册与发现 |
| `test_skill_registry.py` | Skill 注册、筛选、启用/禁用 |
| `test_tools_io.py` | 文件读写路径安全检查 |
| `test_workdir.py` | 任务工作目录创建 |
| `test_processing.py` | CSV/JSON/HTML 解析 |
| `test_output.py` | CSV 导出完整性 |
| `test_summarizer.py` | 查询日志压缩 |

## 演示工作流

```bash
uv run python scripts/demo_workflow.py
```

演示流程：
1. PubMed 文献检索 → 提取数据库名称与 accession
2. GEO 数据集检索与下载
3. 文件格式检测与解析（CSV/Excel/GEO Matrix）
4. 数据清洗（缺失值、重复、类型检查）
5. 字段对齐与多源合并
6. 导出结构化 CSV + 来源清单 + 字段说明
7. 可选：描述性统计与可视化

预期产出：`data/demo_output/` 下的 6 个产物文件。

## 浏览器降级

当 API 或预置 Tool 失效、用户访问未适配的数据库时，系统使用 `browser_fallback` Skill 降级：

1. 记录原始失败原因
2. 调用通用浏览器自动化 Tool
3. 成功后可选生成后天 Skill 代码，保存到 `skills/learned/`
4. 至少一次重放验证后，人工启用

浏览器 Tool 不绕过登录、付费、验证码或网站明确的访问控制。

## 安全模型

- **文件隔离**：I/O Tool 只能访问当前任务工作目录，拒绝绝对路径、`..` 穿越和符号链接
- **密钥保护**：后天代码不得读取环境变量中的密钥
- **命令沙箱**：后天代码不得执行系统命令
- **下载限制**：限制协议（仅 HTTP/HTTPS）、文件大小和超时
- **用户确认**：敏感操作前通过 HITL 暂停，等待用户批准

## 扩展指南

### 添加新数据库 Skill

1. 在 `app/skills/builtin/acquisition/` 下创建模块
2. 实现 `search_*`、`describe_*`、`download_*` 三个 Tool 函数
3. 使用 `@function_tool` 装饰器注册到 SDK
4. 模块底部调用 `skill_registry.register(SkillDef(...))`
5. 编写对应测试（检索、元数据、下载分离测试）

### 添加新解析器

1. 在 `app/tools/` 下创建解析模块
2. 实现返回 `ParsedDataset` 的解析函数
3. 在 `processing.py` 的 `parse_file()` 中添加格式路由

## 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 后端启动失败 `ModuleNotFoundError` | 依赖未安装 | 运行 `uv sync` |
| DashScope API 返回 401 | API Key 无效 | 检查 `.env` 中的 `DASHSCOPE_API_KEY` |
| PubMed 检索超时 | Biopython Entrez 限速 | 已内置限速（0.34s/请求），若仍超时可增加延迟 |
| GEO 下载失败 | 网络问题或格式不支持 | 系统会自动降级到浏览器方案 |
| WebSocket 连接断开 | 模型输出超长或异常 | 检查后端日志，`summarizer.py` 会自动压缩超长上下文 |
| 产物文件为空 | 解析步骤失败 | 查看 `data/tasks/<id>/logs/` 中的错误记录 |

## 相关文档

- [项目架构设计](../docs/ARCHITECTURE.md)
- [可复现性指南](REPRODUCIBILITY.md)
- [前端 README](../frontend/README.md)
