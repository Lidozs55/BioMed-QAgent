# BioMed QAgent

> 题目编号：XH-202619 · 赛道二 - 数据场景 · 方向1 - 科学数据整合与影响力分析应用
> 选题：A. 科学数据查找、解析与整合

面向生物医学研究场景的 AI 多智能体系统。用户输入自然语言研究目标（如「分析健脾散结方对胰腺癌肝转移的影响」），系统通过 LLM 驱动的流水线自动完成 **规划 → 检索 → 解析 → 清洗 → 分析 → 审查 → 报告** 全流程，输出可追溯、可复用的结构化数据与综合研究报告。

强制使用阿里云百炼 DashScope 平台（Qwen 系列模型）。

---

## 核心特性

- **LLM 驱动的 8 阶段流水线**：`Orchestrator` 直接持有 planning / export，将 search / acquire / parse / clean / analyze / review 6 阶段委托给 `AgentRegistry` 注册的 7 个阶段 Agent（`BaseAgent` 子类 + IterationDecisionAgent），LLM 负责规划与审查，原生 Python 模块负责执行
- **多轮迭代收敛**：`IterationDecisionAgent` 通过量化 Stage Gate 指标（新记录数 / 覆盖率 / 冲突率 / 去重率）+ LLM 空白分析，决定是否需要补充检索，最多 3 轮
- **人在回路确认检查点**：当记录为空 / 审查质量为 low / 平均置信度 < 0.5 时，任务暂停至 `AWAITING_CONFIRMATION`，等待用户 approve（直接导出）或 reject（从指定阶段重试）
- **智能错误决策**：`ErrorDecisionAgent` 规则优先（瞬态→重试 / 永久→失败 / 模糊→升级），LLM 兜底，硬回退策略（核心阶段重试 / acquire 跳过 / review 升级）
- **16 个数据源并行检索**：PubMed / EuropePMC / OpenAlex / Semantic Scholar / arXiv / GEO / STRING / KEGG / PDB / TCMSP / NCBI / ClinicalTrials / TCGA / DrugBank / DisGeNET / PubChem
- **引用追溯**：通过 OpenAlex 的 `referenced_works` 与 `cited_by_count` 自动扩展参考文献链
- **浏览器代理**：Playwright 驱动的 `browser_agent` 处理 JS 重度渲染网站（CNKI / 万方 / ChEMBL 等），`AcquireAgent` 自动路由
- **双查询策略**：文献源用研究目标检索，实体源（STRING/TCMSP/DisGeNET 等）按基因/化合物/疾病实体级检索
- **Darwinian Stage Gate**：检索记录不足时，自动用扩展中英文查询（疾病名+基因名）重试
- **全链路数据溯源**：`ProvenanceTracker` 在每个阶段记录操作节点，前端以 ReactFlow DAG 可视化
- **字段对齐 + 单位归一化 + 去重**：基于领域词典（基因/化合物/疾病/单位别名）的清洗三件套
- **生物信息学分析**：PPI 网络（STRING）+ GO/KEGG 富集（Enrichr）+ 药物-靶点（OpenTargets）+ Hub 基因 + 上游调控 + 生存分析（TCGA）
- **LLM 综合研究报告**：`LLMReporter` 调用 qwen-max 生成科学叙事式 HTML 报告（非数据罗列），失败即任务失败，不回退模板
- **多源整合 CSV**：按实体类型分组（literature/compound/gene/interaction/pathway/expression），字段对齐，便于后续分析
- **技能发现面板**：`SkillRegistry` 自动从 `ToolRegistry` 元数据生成技能清单，支持关键词 + 可选 LLM 重排序检索
- **文件上传**：支持 PDF / 图表图片 / GEO SOFT / PDB / FASTA / 网络文件上传，parse 阶段自动处理
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
| **网页抓取** | httpx + BeautifulSoup + Playwright（浏览器代理，用于 JS 重度渲染网站）|
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
│   │   │   └── routes/
│   │   │       ├── tasks.py         # 任务 CRUD + 启动 + 上传 + 确认 + 分析结果 + 报告
│   │   │       ├── data.py          # 数据查询 + CSV/JSON/整合 CSV 导出
│   │   │       ├── lineage.py       # 溯源图 + 单记录链路
│   │   │       ├── ws.py            # WebSocket 实时推送
│   │   │       ├── system.py        # 健康检查 + 工具列表
│   │   │       ├── skills.py        # 技能发现面板（列表/分类/详情/语义检索）
│   │   │       └── feedback.py      # 用户反馈（后端已实现，前端未接线）
│   │   ├── agents/
│   │   │   ├── base.py              # BaseAgent ABC + 共享辅助方法
│   │   │   ├── registry.py          # AgentRegistry + register_all_agents()（7 个阶段 Agent）
│   │   │   ├── orchestrator.py      # ★ 核心：流水线编排器（planning/export 内联 + 6 阶段委托 + 多轮迭代）
│   │   │   ├── llm_reporter.py      # ★ LLM 综合研究报告生成器
│   │   │   ├── llm_extractor.py     # LLM 原始爬取记录提取器
│   │   │   ├── error_decision.py    # ErrorDecisionAgent（错误决策器，Orchestrator 直接持有）
│   │   │   ├── iteration_decision.py # IterationDecisionAgent（Stage Gate + LLM 空白分析，收敛决策）
│   │   │   ├── search.py            # SearchAgent（文献+实体+引用追溯+Darwinian fallback）
│   │   │   ├── acquire.py           # AcquireAgent（浏览器代理路由 + 爬虫信号隔离）
│   │   │   ├── parser.py            # ParserAgent（PDF + LLM 提取 + Qwen-VL 图表）
│   │   │   ├── cleaner.py           # CleanerAgent（对齐/归一/去重）
│   │   │   ├── analysis.py          # AnalysisAgent（PPI/富集/药靶/差异表达/Hub/上游/生存并行）
│   │   │   └── reviewer.py          # ReviewerAgent（LLM 质量审查）
│   │   ├── tools/
│   │   │   ├── registry.py          # ★ ToolRegistry facade：直接调用模块函数
│   │   │   ├── browser_agent.py     # Playwright 浏览器代理（JS 重度渲染网站）
│   │   │   ├── datasources/         # 16 个活跃数据源 + 引用追溯 + Web 爬虫
│   │   │   ├── parsers/             # PDF 表格 / PDF 下载 / GEO SOFT / PDB / FASTA / 网络
│   │   │   ├── cleaners/            # 字段对齐 / 单位归一化 / 去重
│   │   │   ├── analysis/            # PPI / 富集 / 药物-靶点 / 差异表达 / Hub 基因 / 上游调控 / 生存分析
│   │   │   ├── export/              # CSV / Excel / Markdown 报告 / 多源整合 CSV（merge_csv）
│   │   │   ├── io/                  # CSV/Excel → JSON / JSON → CSV / JSON 合并
│   │   │   ├── optimization/        # Darwinian Stage Gate 评估器/反思循环/关键词扩展
│   │   │   └── viz/                 # 火山图 / 热图 / 富集气泡 / 网络图 / 图表数据提取
│   │   ├── skills/                  # 技能发现层（只读，自动从 ToolRegistry 生成）
│   │   │   ├── __init__.py          # register_all_skills + exports
│   │   │   ├── manifest.py          # SkillManifest 数据模型
│   │   │   ├── registry.py          # SkillRegistry（类注册，静态方法）
│   │   │   ├── definitions.py       # 从 ToolRegistry._TOOLS_METADATA 自动生成技能清单
│   │   │   └── retriever.py         # SkillRetriever（关键词 + 可选 LLM 重排序）
│   │   ├── llm/
│   │   │   ├── client.py            # DashScopeClient：chat / chat_json / chat_vision / chat_document / chat_stream
│   │   │   └── prompts/             # Agent 提示词模板（占位，实际 prompt 内联在代码中）
│   │   ├── provenance/
│   │   │   └── tracker.py           # ★ ProvenanceTracker + ProvenanceNode（活跃）
│   │   ├── models/
│   │   │   └── task.py              # ★ Task / TaskStatus / StageStatus / StageInfo / TaskCreate
│   │   ├── storage/
│   │   │   └── task_store.py        # ★ 内存字典 + JSON 文件持久化
│   │   ├── resources/
│   │   │   ├── dictionaries/        # 基因/化合物/疾病/单位别名/字段别名 YAML
│   │   │   ├── domain_templates/    # 中医药/肿瘤学/药理学 YAML
│   │   │   └── schemas/             # JSON Schema 数据契约
│   │   └── utils/paths.py           # 资源目录定位辅助函数
│   ├── tests/                       # pytest 测试（API / E2E / 错误决策 / 技能）
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                        # 前端应用
│   ├── src/
│   │   ├── App.tsx                  # 布局：侧栏（TaskInput + TaskList）+ 4 Tab 内容区
│   │   ├── api/                     # HTTP 客户端 + 类型定义
│   │   ├── components/
│   │   │   ├── task/                # TaskInput / TaskList / PipelineStatus / IterationPanel
│   │   │   ├── data/                # DataOverview（记录/图表/溯源 3 子 Tab）/ DataPreview
│   │   │   ├── charts/              # ChartsView（ECharts 饼图/柱状图）
│   │   │   ├── lineage/             # LineageGraph（ReactFlow DAG）
│   │   │   ├── report/              # ResearchReport（LLM 报告 iframe + 分析结果）
│   │   │   ├── analysis/            # AnalysisView（PPI/富集/药靶/生存分析可视化）
│   │   │   ├── feedback/            # FeedbackPanel（用户反馈面板）
│   │   │   └── layout/              # 占位
│   │   ├── hooks/useTaskWebSocket.ts # WebSocket 订阅 + 自动重连 + 心跳
│   │   ├── stores/taskStore.ts      # Zustand 状态（含迭代决策 + Stage Gate 指标）
│   │   └── styles/global.css
│   ├── electron/                    # Electron 桌面端（可选）
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── data/                            # 运行时数据（.gitignore）
│   └── uploads/  parsed/  output/  cache/
├── docs/
│   ├── reflection_loop_design_notes.md
│   ├── multiomics_network_pharmacology_api_matrix.md
│   ├── pipeline_dispatch_trace.md
│   ├── 20260708-review-optimization.md
│   ├── api/                         # OpenAPI 规范导出
│   └── archive/                     # 已完成/过时的设计文档归档
├── _validate.py                     # AST + import 链 + 工具/Agent 计数验证脚本
├── .env.example                     # DASHSCOPE_API_KEY 占位
├── opencode.json                    # MCP 配置（Commonly agent）
├── PROBLEM.md                       # 赛题说明
├── ARCHITECTURE.md                  # 架构设计文档（与实际实现同步）
├── AGENTS.md                        # Agent 协作工作流规范（Commonly pod）
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
| GET | `/api/v1/tasks/{id}` | 任务详情（含 is_running 状态）|
| DELETE | `/api/v1/tasks/{id}` | 删除任务（含取消运行）|
| POST | `/api/v1/tasks/{id}/start` | 异步启动流水线（可选 `from_stage` 从指定阶段重试）|
| POST | `/api/v1/tasks/{id}/upload` | 上传 PDF / 图表图片 / 生物数据文件 |
| POST | `/api/v1/tasks/{id}/confirm` | 人工确认检查点（approve → 导出 / reject → 从指定阶段重试）|
| GET | `/api/v1/tasks/{id}/analysis` | 分析结果（PPI/富集/药物-靶点/Hub 基因/上游调控/生存）|
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
| GET | `/api/v1/skills` | 技能列表（可按类别过滤）|
| GET | `/api/v1/skills/categories` | 技能类别列表 |
| GET | `/api/v1/skills/count` | 技能总数 |
| GET | `/api/v1/skills/{skill_id}` | 技能详情 |
| POST | `/api/v1/skills/search` | 语义检索技能（关键词 + 可选 LLM 重排序）|

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
│   流水线状态 │ 迭代面板 │ 数据总览 │ 研究报告 │ 分析视图    │
└─────────────────────────┬────────────────────────────────────┘
                          │ REST API + WebSocket
┌─────────────────────────▼────────────────────────────────────┐
│              Backend (FastAPI)                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Orchestrator（planning/export 内联 + 6 阶段委托       │  │
│  │    + 多轮迭代 + 人在回路确认 + ErrorDecisionAgent）     │  │
│  │  planning → [search → acquire → parse → clean          │  │
│  │              → analyze → review] ×N → confirm? → export│  │
│  └───┬──────────────────────────────────────┬─────────────┘  │
│      │ LLM 调用（规划/审查/报告/迭代决策）   │ 工具调用       │
│  ┌───▼──────────────────┐  ┌────────────────▼────────────┐  │
│  │  DashScopeClient      │  │  ToolRegistry facade         │  │
│  │  (qwen-plus/max)      │  │  ├─ datasources/ (16 源)     │  │
│  │  + LLMReporter        │  │  ├─ browser_agent (Playwright)│ │
│  │  + IterationDecision   │  │  ├─ parsers/ (PDF/生物数据)  │  │
│  └───────────────────────┘  │  ├─ cleaners/ (对齐/归一/去重)│  │
│                              │  ├─ analysis/ (PPI/富集/药靶  │  │
│                              │  │   /Hub/上游/生存)          │  │
│                              │  └─ export/ (CSV/Excel/MD)   │  │
│                              └──────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  SkillRegistry · ProvenanceTracker · TaskStore · 词典    │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

> 架构对齐说明：`Orchestrator` 直接持有 planning/export，6 个中间阶段由 `AgentRegistry` 注册的 `BaseAgent` 子类实现；多轮迭代由 `IterationDecisionAgent` 驱动（Stage Gate + LLM 空白分析），人在回路确认检查点处理低质量场景，`ErrorDecisionAgent` 处理运行时错误。存储为内存+JSON（无 SQLite）。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 流水线阶段

`Orchestrator.run()` 执行 planning + 多轮迭代（最多 3 轮）+ export，每阶段通过 `progress` 回调推送 WebSocket 事件。

| 阶段 | 实现方式 | 职责 |
|------|---------|------|
| 1. planning | LLM (qwen-plus) | 提取化合物/基因/疾病/通路实体，识别领域，生成检索查询与推荐数据源 |
| 2. search | 原生模块 + 线程池 | 文献源并行检索 + 实体源按基因/化合物/疾病检索 + 引用追溯（OpenAlex）；记录不足时 Darwinian 扩展查询重试 |
| 3. acquire | Playwright 浏览器代理 | 识别 `requires_crawl` 信号，自动路由至 `WebCrawlerSource`（轻量）或 `browser_agent`（JS 重度渲染），失败隔离不影响后续 |
| 4. parse | 原生模块 + LLM | 解析用户上传 PDF/图片/生物数据文件 + 自动下载 OA 论文 PDF + LLM 提取原始爬取记录 + Qwen-VL 图表提取 |
| 5. clean | 原生模块三件套 | 字段对齐（词典）→ 单位归一化 → 去重；统计平均置信度与质量标记；聚合字段级溯源 |
| 6. analyze | 原生模块（可选） | PPI（STRING）+ GO/KEGG 富集（Enrichr）+ 药物-靶点（OpenTargets）+ Hub 基因 + 上游调控 + 生存分析（TCGA）|
| 7. review | LLM (qwen-max) | 审查数据完整性、来源覆盖、关键发现、改进建议；输出质量评分 |
| → 迭代决策 | IterationDecisionAgent | Stage Gate 量化指标 + LLM 空白分析，决定继续迭代或收敛 |
| → 人在回路确认 | Orchestrator | 记录为空 / 质量 low / 置信度 < 0.5 时暂停，等待用户 approve 或 reject |
| 8. export | 原生模块 + LLMReporter | CSV 导出 + 多源整合 CSV + LLM 综合研究报告（HTML）+ 完整 JSON 数据 |

**任务状态机**：
```
CREATED → PLANNING → SEARCHING → (ACQUIRING) → (PARSING) → CLEANING → (ANALYZING) → REVIEWING
              │                                                                    │
              │    ┌─── 迭代（最多 3 轮）───┐                                      │
              └──→ │ search → ... → review  │←─ IterationDecisionAgent 决定继续    │
                   └───────────────────────┘                                      │
                                                                                  ▼
                                                                    ┌─── AWAITING_CONFIRMATION
                                                                    │    （用户 approve / reject）
                                                                    ▼
                                                                 COMPLETED
    │                                                                                              │
    └──────────────────────────────── FAILED（记录错误，可重新 start / from_stage 重试） ──────────┘
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
| 新增数据源 | 在 `tools/datasources/` 添加模块函数，在 `ToolRegistry._get_ds_func` 映射表注册 | 16 个活跃 |
| 新增解析器 | 在 `tools/parsers/` 添加模块 + 在 `ToolRegistry` 添加 facade 方法 | 6 个 |
| 新增清洗器 | 在 `tools/cleaners/` 添加模块 + 在 `ToolRegistry` 添加 facade 方法 | 3 个 |
| 新增分析模板 | 在 `tools/analysis/` 添加模块 + 在 `ToolRegistry` 添加 facade 方法 | 7 个 |
| 新增导出格式 | 在 `tools/export/` 添加模块 | CSV/Excel/MD |
| 新增领域模板 | 在 `resources/domain_templates/` 添加 YAML | 中医药/肿瘤学/药理学 |
| 新增词典 | 在 `resources/dictionaries/` 添加 YAML | 基因/化合物/疾病/单位/字段别名 |

> 注：`BaseAgent` ABC + `AgentRegistry` 已落地，7 个阶段 Agent（search/acquire/parse/clean/analysis/reviewer/iteration_decision）已注册并在流水线中调度；`ErrorDecisionAgent` 由 Orchestrator 直接持有。当前扩展主要通过 `ToolRegistry` facade 添加模块函数。

---

## 文档

- [赛题说明](PROBLEM.md)
- [架构设计](ARCHITECTURE.md)（已与实际实现对齐，代码为准）
- [Agent 协作规范](AGENTS.md)（Commonly pod 工作流 / 文件锁 / Git 规范）
- [API 交互文档](http://localhost:8000/docs)（FastAPI 自动生成，最权威）
- [Reflection Loop 设计说明](docs/reflection_loop_design_notes.md)
- [多组学网络药理学 API 矩阵](docs/multiomics_network_pharmacology_api_matrix.md)

---

## License

本项目用于参赛提交。
