# BioMed QAgent

> 题目编号：XH-202619 · 赛道二 - 数据场景 · 方向1 - 科学数据整合与影响力分析应用
> 选题：A. 科学数据查找、解析与整合

面向生物医学研究场景的 AI 多智能体系统。用户输入自然语言研究目标（如「分析健脾散结方对胰腺癌肝转移的影响」），系统通过 LLM 驱动的流水线自动完成 **规划 → 检索 → 解析 → 清洗 → 分析 → 审查 → 报告** 全流程，输出可追溯、可复用的结构化数据与综合研究报告。

强制使用阿里云百炼 DashScope 平台（Qwen 系列模型）。

---

## 核心特性

- **LLM 驱动的 8 阶段流水线**：`Orchestrator` 直接持有 planning / export，将 search / acquire / parse / clean / analyze / review 6 阶段委托给 `AgentRegistry` 注册的 7 个阶段 Agent（`BaseAgent` 子类 + IterationDecisionAgent），LLM 负责规划与审查，原生 Python 模块负责执行
- **15 个数据源并行检索**：PubMed / OpenAlex / Semantic Scholar / arXiv / GEO / STRING / KEGG / PDB / TCMSP / NCBI / ClinicalTrials / TCGA / DrugBank / DisGeNET / PubChem
- **双查询策略**：文献源用研究目标检索，实体源（STRING/TCMSP/DisGeNET 等）按基因/化合物/疾病实体级检索
- **Darwinian Stage Gate**：检索记录不足时，自动用扩展中英文查询（疾病名+基因名）重试
- **全链路数据溯源**：`ProvenanceTracker` 在每个阶段记录操作节点，前端以 ReactFlow DAG 可视化
- **字段对齐 + 单位归一化 + 去重**：基于领域词典（基因/化合物/疾病/单位别名）的清洗三件套
- **生物信息学分析**：PPI 网络（STRING）+ GO/KEGG 富集（Enrichr）+ 药物-靶点（OpenTargets）
- **LLM 综合研究报告**：`LLMReporter` 调用 qwen-max 生成科学叙事式 HTML 报告（非数据罗列），失败即任务失败，不回退模板
- **多源整合 CSV**：按实体类型分组（literature/compound/gene/interaction/pathway/expression），字段对齐，便于后续分析
- **实时进度推送**：WebSocket 推送阶段状态、进度百分比、错误信息

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **后端框架** | FastAPI + Uvicorn + Pydantic v2 |
| **LLM** | 阿里云百炼 DashScope（OpenAI 兼容模式）|
| **文本模型** | qwen-plus（规划/实体识别）/ qwen-max（审查/报告）|
| **多模态** | qwen-vl-max（图表识图，已封装未深度接线）|
| **长文档** | qwen-long（PDF 全文理解，已封装未深度接线）|
| **数据处理** | pandas / numpy / scipy / pdfplumber |
| **网页抓取** | httpx + BeautifulSoup（用于 PDF 下载与轻量解析）|
| **存储** | 内存字典 + JSON 文件持久化（无 SQLite / Redis）|
| **前端** | React 18 + TypeScript + Vite + Ant Design 5 |
| **可视化** | ECharts（图表）+ @xyflow/react（数据血缘图）|
| **状态管理** | Zustand |
| **桌面端** | Electron（可选）|

---

## 项目结构

```
BioMedQAgent/
├── backend/                         # 后端服务
│   ├── app/
│   │   ├── main.py                  # FastAPI 入口 + 生命周期 + 全局异常
│   │   ├── config.py                # 路径 + DashScope 配置 + 模型选型
│   │   ├── api/
│   │   │   ├── __init__.py          # 路由聚合（统一前缀 /api/v1）
│   │   │   ├── routes/
│   │   │   │   ├── tasks.py         # 任务 CRUD + 启动 + 分析结果 + 报告 + 文件列表
│   │   │   │   ├── data.py          # 数据查询 + 导出
│   │   │   │   ├── lineage.py       # 溯源图 + 单记录链路
│   │   │   │   ├── ws.py            # WebSocket 实时推送
│   │   │   │   ├── system.py        # 健康检查 + 工具列表
│   │   │   │   ├── skills.py        # 技能发现面板（只读）
│   │   │   │   └── feedback.py      # 用户反馈（后端已实现，前端未接线）
│   │   │   ├── schemas/             # Pydantic 请求/响应模型（占位）
│   │   │   └── middleware/          # 中间件（占位）
│   │   ├── agents/
│   │   │   ├── base.py              # BaseAgent ABC + 共享辅助方法（_set_stage/_emit/_to_thread/_extract_records/_dedup_by_id）
│   │   │   ├── registry.py          # AgentRegistry + register_all_agents()（7 个阶段 Agent 发现与实例化）
│   │   │   ├── orchestrator.py      # ★ 核心：流水线编排器（planning/export 内联 + 6 阶段委托）
│   │   │   ├── llm_reporter.py      # ★ LLM 综合研究报告生成器
│   │   │   ├── error_decision.py    # ErrorDecisionAgent（错误决策器，非阶段 Agent，Orchestrator 直接持有）
│   │   │   ├── search.py            # SearchAgent（文献+实体+引用追溯+Darwinian fallback）
│   │   │   ├── acquire.py           # AcquireAgent（爬虫信号识别）
│   │   │   ├── parser.py            # ParserAgent（PDF + LLM 提取）
│   │   │   ├── cleaner.py           # CleanerAgent（对齐/归一/去重）
│   │   │   ├── analysis.py          # AnalysisAgent（PPI/富集/药靶/差异表达并行）
│   │   │   └── reviewer.py          # ReviewerAgent（LLM 质量审查）
│   │   ├── tools/
│   │   │   ├── registry.py          # ★ ToolRegistry facade：直接调用模块函数
│   │   │   ├── datasources/         # 15 个活跃数据源模块函数（dormant 体系已移除）
│   │   │   ├── parsers/             # PDF 表格 / PDF 下载 / GEO SOFT / PDB / FASTA / 网络
│   │   │   ├── cleaners/            # 字段对齐 / 单位归一化 / 去重
│   │   │   ├── analysis/            # PPI / 富集 / 药物-靶点 / 差异表达 / Hub 基因 / 生存分析 / 上游调控
│   │   │   ├── export/              # CSV / Excel / Markdown 报告 / 多源整合 CSV（merge_csv）
│   │   │   ├── io/                  # CSV/Excel → JSON / JSON → CSV / JSON 合并
│   │   │   ├── optimization/        # Darwinian Stage Gate 评估器/反思循环/关键词扩展
│   │   │   └── viz/                 # 火山图 / 热图 / 富集气泡 / 网络图 / 图表数据提取
│   │   ├── llm/
│   │   │   ├── client.py            # DashScopeClient：chat / chat_json / chat_vision / chat_document
│   │   │   └── prompts/             # 7 个 Agent 提示词模板（.txt）
│   │   ├── provenance/
│   │   │   └── tracker.py           # ★ ProvenanceTracker + ProvenanceNode（活跃）
│   │   ├── models/
│   │   │   └── task.py              # ★ Task / TaskStatus / StageStatus / TaskCreate（活跃）
│   │   ├── storage/
│   │   │   └── task_store.py        # ★ 内存字典 + JSON 文件持久化
│   │   ├── resources/
│   │   │   ├── dictionaries/        # 基因/化合物/疾病/单位别名/字段别名 YAML
│   │   │   ├── domain_templates/    # 中医药/肿瘤学/药理学 YAML
│   │   │   └── schemas/             # 8 份 JSON Schema 数据契约
│   │   └── utils/paths.py           # 资源目录定位辅助函数
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                        # 前端应用
│   ├── src/
│   │   ├── App.tsx                  # 3 主 Tab 布局
│   │   ├── api/                     # HTTP 客户端 + 类型定义
│   │   ├── components/
│   │   │   ├── task/                # TaskInput / TaskList / PipelineStatus
│   │   │   ├── data/                # DataOverview（含数据记录/统计图表/数据溯源 3 子 Tab）/ DataPreview
│   │   │   ├── charts/              # ChartsView（ECharts 饼图/柱状图）
│   │   │   ├── lineage/             # LineageGraph（ReactFlow DAG）
│   │   │   ├── report/              # ResearchReport（LLM 报告 iframe + 分析结果）
│   │   │   ├── feedback/            # 占位（未实现）
│   │   │   └── layout/              # 占位
│   │   ├── hooks/useTaskWebSocket.ts
│   │   ├── stores/taskStore.ts      # Zustand 状态
│   │   └── styles/global.css
│   ├── electron/                    # Electron 桌面端（可选）
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── data/                            # 运行时数据（.gitignore）
│   └── uploads/  parsed/  output/  cache/
├── docs/
│   ├── api/openapi.yaml             # 占位（实际 API 见 /docs）
│   ├── reflection_loop_design_notes.md  # reflection_loop 设计说明与 LLM 在环反思期望
│   ├── multiomics_network_pharmacology_api_matrix.md
│   └── archive/                     # 已完成/过时的设计文档归档
├── PROBLEM.md                       # 赛题说明
├── ARCHITECTURE.md                  # 架构设计文档（与实际实现同步）
├── AGENT.md                         # Agent 协作工作流规范
└── README.md
```

---

## 快速开始

### 环境要求

- Python ≥ 3.10
- Node.js ≥ 18
- 阿里云百炼 API Key（[获取地址](https://help.aliyun.com/zh/model-studio/get-api-key)）

### 1. 配置环境变量

```bash
# Windows PowerShell
setx DASHSCOPE_API_KEY "sk-xxxxxxxxxxxxxxxx"

# Linux / macOS
export DASHSCOPE_API_KEY="sk-xxxxxxxxxxxxxxxx"
```

### 2. 启动后端

```bash
cd backend
pip install -r requirements.txt
python -m app.main
# 服务启动在 http://localhost:8000
# 交互式 API 文档：http://localhost:8000/docs
```

> 开发模式下推荐 `uvicorn app.main:app --reload`，但需先清理 `__pycache__` 并结束残留 Python 进程，避免加载旧 `.pyc`。

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
# 前端启动在 http://localhost:5173
```

### 4. 可选：Electron 桌面端

```bash
cd frontend
npm run electron:dev
```

---

## 核心 API

统一前缀 `/api/v1`，由 FastAPI 自动生成 Swagger 文档（`/docs`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tasks` | 创建任务（research_goal / domain_hint / max_sources / enable_analysis）|
| GET | `/api/v1/tasks` | 任务列表（按创建时间倒序）|
| GET | `/api/v1/tasks/{id}` | 任务详情 |
| DELETE | `/api/v1/tasks/{id}` | 删除任务（含取消运行）|
| POST | `/api/v1/tasks/{id}/start` | 异步启动流水线（仅 created/failed 可启动）|
| GET | `/api/v1/tasks/{id}/analysis` | 分析结果（PPI/富集/药物-靶点）|
| GET | `/api/v1/tasks/{id}/data` | 数据记录（分页，可按数据源过滤）|
| GET | `/api/v1/tasks/{id}/export/csv` | 导出 CSV（含来源标注列）|
| GET | `/api/v1/tasks/{id}/export/json` | 导出 JSON |
| GET | `/api/v1/tasks/{id}/export/merged/csv` | 多源整合 CSV（按实体类型分组）|
| GET | `/api/v1/tasks/{id}/report` | HTML 综合研究报告 |
| POST | `/api/v1/tasks/{id}/regenerate-report` | 重新生成 LLM 报告 + 整合 CSV |
| GET | `/api/v1/tasks/{id}/lineage` | 完整溯源图（DAG）|
| GET | `/api/v1/tasks/{id}/lineage/{record_id}` | 单条记录溯源链 |
| GET | `/api/v1/tasks/{id}/files` | 任务输出文件列表 |
| POST | `/api/v1/tasks/{id}/feedback` | 提交反馈（refine_entities / retry_stage / general）|
| WS | `/api/v1/ws/tasks/{id}` | 实时状态推送 |
| GET | `/api/v1/health` | 健康检查 |
| GET | `/api/v1/tools` | 可用工具列表（按类别分组）|

### 创建任务示例

```bash
curl -X POST http://localhost:8000/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "research_goal": "分析健脾散结方对胰腺癌肝转移的影响",
    "domain_hint": "tcm",
    "max_sources": 20,
    "enable_analysis": true
  }'
```

---

## 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│              Frontend (React + Antd)                          │
│   流水线状态 │ 数据总览(记录/图表/溯源) │ 研究报告(LLM+分析)   │
└─────────────────────────┬────────────────────────────────────┘
                          │ REST API + WebSocket
┌─────────────────────────▼────────────────────────────────────┐
│              Backend (FastAPI)                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │       Orchestrator（编排器：planning/export 内联        │  │
│  │                  + 6 阶段委托 AgentRegistry）           │  │
│  │  planning → search → acquire → parse → clean           │  │
│  │            → analyze → review → export                 │  │
│  └───┬──────────────────────────────────────┬─────────────┘  │
│      │ LLM 调用（规划/审查/报告）            │ 工具调用       │
│  ┌───▼──────────────────┐  ┌────────────────▼────────────┐  │
│  │  DashScopeClient      │  │  ToolRegistry facade         │  │
│  │  (qwen-plus/max)      │  │  ├─ datasources/ (15 源)     │  │
│  │  + LLMReporter        │  │  ├─ parsers/ (PDF/生物数据)  │  │
│  └───────────────────────┘  │  ├─ cleaners/ (对齐/归一/去重)│  │
│                              │  ├─ analysis/ (PPI/富集/药靶)│  │
│                              │  └─ export/ (CSV/Excel/MD)  │  │
│                              └─────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ProvenanceTracker · TaskStore(内存+JSON) · 词典/Schema │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

> 架构对齐说明：`Orchestrator` 直接持有 planning/export，6 个中间阶段由 `AgentRegistry` 注册的 `BaseAgent` 子类实现（search/acquire/parse/clean/analysis/reviewer）；存储为内存+JSON（无 SQLite），运行时数据记录统一用裸 dict + JSON Schema（无 Pydantic 模型）。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 流水线阶段

`Orchestrator.run()` 顺序执行 8 个阶段，每阶段通过 `progress` 回调推送 WebSocket 事件。

| 阶段 | 实现方式 | 职责 |
|------|---------|------|
| 1. planning | LLM (qwen-plus) | 提取化合物/基因/疾病/通路实体，识别领域，生成检索查询与推荐数据源 |
| 2. search | 原生模块 + 线程池 | 文献源并行检索 + 实体源按基因/化合物/疾病检索；记录不足时 Darwinian 扩展查询重试 |
| 3. acquire | 占位（隔离 stub） | 识别 `requires_crawl` 信号并日志记录，不执行实际爬取，绝不影响后续阶段 |
| 4. parse | 原生模块 | 解析用户上传 PDF + 自动下载开放获取论文 PDF（最多 5 篇），提取表格与 caption |
| 5. clean | 原生模块三件套 | 字段对齐（词典）→ 单位归一化 → 去重；统计平均置信度与质量标记 |
| 6. analyze | 原生模块（可选） | PPI 网络（STRING）+ GO/KEGG 富集（Enrichr）+ 药物-靶点（OpenTargets）|
| 7. review | LLM (qwen-max) | 审查数据完整性、来源覆盖、关键发现、改进建议；输出质量评分 |
| 8. export | 原生模块 + LLMReporter | CSV 导出 + 多源整合 CSV + LLM 综合研究报告（HTML）+ 完整 JSON 数据 |

**任务状态机**：
```
CREATED → PLANNING → SEARCHING → (ACQUIRING) → (PARSING) → CLEANING → (ANALYZING) → REVIEWING → COMPLETED
    │                                                                                              │
    └──────────────────────────────── FAILED（记录错误，可重新 start） ────────────────────────────┘
```

---

## 数据溯源

`ProvenanceTracker` 在 search / parse / clean / analyze 各阶段调用 `prov.record()` 写入 `ProvenanceNode`，形成完整 DAG。每条记录携带 `source_ref`（来源名/URL/DOI/PMID）与 `extraction_confidence`。

CSV 导出自动附加来源标注列：

| compound_name | gene_symbol | log2fc | p_value | source_name | source_url | extraction_method | extraction_confidence | quality_flags |
|---|---|---|---|---|---|---|---|---|
| Quercetin | AKT1 | 2.35 | 0.001 | pubmed | https://... | table | 0.95 | |
| Kaempferol | TP53 | -1.82 | 0.023 | openalex | https://... | api | 0.88 | needs_review |

溯源链示例（通过 `GET /tasks/{id}/lineage/{record_id}` 查询）：
```
字段 "compound_name": "Quercetin"
├─ [clean] clean_agent → field_aligner+unit_normalizer+duplicate_detector
│   └─ [search] search_agent → pubmed (query="...")
│       └─ 原始来源: PubMed (https://pubmed.ncbi.nlm.nih.gov/)
└─ 置信度: 0.95
```

前端 `LineageGraph` 组件以 ReactFlow 渲染 DAG，按操作类型着色。

---

## LLM 综合研究报告

`LLMReporter.generate_report()` 整合多源数据生成科学叙事式 HTML 报告：

- **驱动模型**：qwen-max（强推理）
- **输入上下文**：研究目标 + 数据源统计 + 识别实体 + 代表性记录（前 20 条）+ 分析结果 + 质量审查
- **报告结构**：执行摘要 / 数据来源与分析方法 / 核心发现 / 生物学意义 / 数据质量与局限性 / 结论与建议
- **失败策略**：LLM 调用失败直接抛异常导致任务 FAILED，**不回退到旧模板**（已彻底移除模板代码）
- **异步安全**：用 `asyncio.to_thread` 包装同步 LLM 调用，避免阻塞 FastAPI 事件循环
- **可视化**：报告 HTML 含统计卡片、实体标签、数据源分布、质量审查徽章

支持通过 `POST /tasks/{id}/regenerate-report` 对已完成任务重新生成报告。

---

## 多源整合 CSV

`tools/export/merge_csv.py` 的 `write_merged_csv()` 生成按实体类型分组的整合 CSV，与平铺 `data.csv` 互补（由 Orchestrator 在 export 阶段经 ToolRegistry facade 调用）：

| 分组 | 字段示例 |
|------|---------|
| literature | title / abstract / authors / year / journal / doi / pmid |
| compound | compound_name / herb / ob / dl / smiles / mol_weight |
| gene | gene_symbol / uniprot_id / gene_id / function |
| interaction | compound / target / action / score / evidence |
| pathway | pathway_name / term / kegg_id / p_value / gene_count |
| expression | gene_symbol / log2fc / pvalue / adj_p |

每个分组有独立列头，附加 `source_name` / `confidence` / `source_url` 三列溯源信息。

---

## 可扩展性

| 扩展点 | 扩展方式 | 现状 |
|--------|---------|------|
| 新增数据源 | 在 `tools/datasources/` 添加模块函数，在 `ToolRegistry._get_ds_func` 映射表注册 | 15 个活跃 |
| 新增解析器 | 在 `tools/parsers/` 添加模块 + 在 `ToolRegistry` 添加 facade 方法 | 6 个 |
| 新增清洗器 | 在 `tools/cleaners/` 添加模块 + 在 `ToolRegistry` 添加 facade 方法 | 3 个 |
| 新增分析模板 | 在 `tools/analysis/` 添加模块 + 在 `ToolRegistry` 添加 facade 方法 | 7 个 |
| 新增导出格式 | 在 `tools/export/` 添加模块 | CSV/Excel/MD |
| 新增领域模板 | 在 `resources/domain_templates/` 添加 YAML | 中医药/肿瘤学/药理学 |
| 新增词典 | 在 `resources/dictionaries/` 添加 YAML | 基因/化合物/疾病/单位/字段别名 |

> 注：`BaseAgent` ABC + `AgentRegistry` 已落地，6 个阶段 Agent 已注册并在 PIPELINE 中调度。当前扩展主要通过 `ToolRegistry` facade 添加模块函数。

---

## 文档

- [赛题说明](PROBLEM.md)
- [架构设计](ARCHITECTURE.md)（已与实际实现对齐，代码为准）
- [API 交互文档](http://localhost:8000/docs)（FastAPI 自动生成，最权威）
- `docs/api/openapi.yaml`（占位，待补充）

---

## License

本项目用于参赛提交。
