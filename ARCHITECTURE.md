# ARCHITECTURE.md — 架构设计

> 本文档描述 BioMed QAgent 的实际架构。如与 README 冲突，以代码为准。

---

## 一、系统定位

BioMed QAgent 是面向生物医学研究场景的 AI 应用。用户输入自然语言研究目标（如「分析健脾散结方对胰腺癌肝转移的影响」），系统通过 LLM 驱动的流水线自动完成 **规划 → 检索 → 解析 → 清洗 → 分析 → 审查 → 报告** 全流程，输出可追溯、可复用的结构化数据与综合研究报告。

核心痛点：多源异构生物医学数据库无统一 API、字段格式各异、数据质量控制困难。

### 设计原则

| 原则 | 说明 |
|------|------|
| **Orchestrator + 阶段 Agent** | planning/export 由 Orchestrator 内联，search→acquire→parse→clean→analyze→review 6 阶段委托给 AgentRegistry 注册的阶段 Agent；通过 ToolRegistry 调用原生模块函数，无 subprocess/CLI |
| **可追溯性** | 每条数据携带 `source_ref`，ProvenanceTracker 记录全链路 DAG |
| **LLM 驱动决策** | 规划、审查、报告由 LLM 完成；检索/解析/清洗/分析由确定性 Python 模块完成 |
| **失败即停** | LLM 报告生成失败直接抛异常，任务 FAILED，不回退模板 |
| **前后端分离** | 后端 FastAPI + REST/WebSocket，前端 React + Antd |

---

## 二、架构总览

```
┌──────────────────────────────────────────────────────────────┐
│              Frontend (React + Antd)                          │
│   流水线状态 │ 数据总览(记录/图表/溯源) │ 研究报告(LLM+分析)   │
└─────────────────────────┬────────────────────────────────────┘
                          │ REST API + WebSocket
┌─────────────────────────▼────────────────────────────────────┐
│              Backend (FastAPI)                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │       Orchestrator（单体编排器，8 阶段流水线）          │  │
│  │  planning → search → acquire → parse → clean           │  │
│  │            → analyze → review → export                 │  │
│  └───┬──────────────────────────────────────┬─────────────┘  │
│      │ LLM 调用（规划/审查/报告）            │ 工具调用       │
│  ┌───▼──────────────────┐  ┌────────────────▼────────────┐  │
│  │  DashScopeClient      │  │  ToolRegistry facade         │  │
│  │  (qwen-plus/max/vl)   │  │  ├─ datasources/ (15 源)     │  │
│  │  + LLMReporter        │  │  ├─ parsers/ (PDF/生物数据)  │  │
│  └───────────────────────┘  │  ├─ cleaners/ (对齐/归一/去重)│  │
│                              │  ├─ analysis/ (PPI/富集/药靶)│  │
│                              │  ├─ viz/ (图表+Qwen-VL提取) │  │
│                              │  └─ export/ (CSV/Excel/MD)  │  │
│                              └─────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ProvenanceTracker · TaskStore(内存+JSON) · 词典/Schema │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、目录结构

```
backend/app/
├── main.py                  # FastAPI 入口 + 生命周期 + 全局异常
├── config.py                # 路径 + DashScope 配置 + 模型选型
├── api/
│   ├── __init__.py          # 路由聚合（统一前缀 /api/v1）
│   └── routes/
│       ├── tasks.py         # 任务 CRUD + 启动 + 状态 + 分析结果 + 文件上传
│       ├── data.py          # 数据查询 + 导出 + 报告 + 重生成
│       ├── lineage.py       # 溯源图 + 单记录链路
│       ├── ws.py            # WebSocket 实时推送
│       └── feedback.py      # 用户反馈
├── agents/
│   ├── base.py              # BaseAgent ABC + 共享辅助方法（_set_stage/_emit/_to_thread/_extract_records/_dedup_by_id）
│   ├── registry.py          # AgentRegistry + register_all_agents()（阶段 Agent 发现与实例化）
│   ├── orchestrator.py      # ★ 流水线编排器（planning/export 内联 + 6 阶段委托）
│   ├── llm_reporter.py      # ★ LLM 综合研究报告生成器
│   ├── search.py            # SearchAgent（文献+实体+引用追溯+Darwinian fallback）
│   ├── acquire.py           # AcquireAgent（爬虫采集 fallback，输出 raw crawl record）
│   ├── parser.py            # ParserAgent（PDF + LLM 提取 + 图表 Qwen-VL + 生物数据解析）
│   ├── cleaner.py           # CleanerAgent（对齐/归一/去重）
│   ├── analysis.py          # AnalysisAgent（PPI/富集/药靶/差异表达/Hub/上游 并行+复用）
│   ├── reviewer.py          # ReviewerAgent（LLM 质量审查）
│   └── iteration_decision.py # IterationDecisionAgent（多轮迭代收敛判断，量化 Stage Gate + LLM gap 分析）
├── tools/
│   ├── registry.py          # ★ ToolRegistry facade
│   ├── datasources/         # 15 个数据源模块
│   ├── parsers/             # PDF 表格/下载 + GEO SOFT/PDB/FASTA/网络
│   ├── cleaners/            # 字段对齐/单位归一化/去重
│   ├── analysis/            # PPI/富集/药物-靶点/差异表达/Hub/生存/上游
│   ├── export/              # CSV/Excel/Markdown
│   ├── io/                  # 格式互转
│   ├── viz/                 # 火山图/热图/气泡/网络图 + 图表数据提取(Qwen-VL)
│   └── optimization/        # Darwinian Stage Gate（stage_evaluator 已接线 IterationDecisionAgent；reflection_loop 文件版 dormant）
├── llm/
│   ├── client.py            # DashScopeClient
│   └── prompts/             # 7 个提示词模板
├── provenance/
│   └── tracker.py           # ProvenanceTracker + ProvenanceNode
├── models/
│   ├── task.py              # Task/TaskStatus/StageStatus（活跃）
│   └── data_record.py       # DataRecord Pydantic（dormant，运行时用 dict）
├── storage/
│   └── task_store.py        # 内存字典 + JSON 文件持久化
├── resources/
│   ├── dictionaries/        # 基因/化合物/疾病/单位/字段别名 YAML
│   ├── domain_templates/    # 中医药/肿瘤学/药理学 YAML
│   └── schemas/             # 8 份 JSON Schema
└── utils/paths.py           # 资源目录定位
```

---

## 四、核心模块

### 4.1 Orchestrator — 流水线编排器

[backend/app/agents/orchestrator.py](backend/app/agents/orchestrator.py) 是系统核心。**planning/export 由 Orchestrator 直接持有**（输入解析 + 结果组装，非领域逻辑）；search→acquire→parse→clean→analyze→review 6 阶段委托给 [AgentRegistry](backend/app/agents/registry.py) 注册的阶段 Agent（[base.py](backend/app/agents/base.py) 的 BaseAgent 提供共享辅助方法）。

**多轮迭代结构**（对齐 docs/multi_round_search_iteration.md）：planning → [Round N: search→acquire→parse→clean→analyze→review → IterationDecisionAgent] → export，迭代直到收敛或达到 MAX_ROUNDS（默认 3）。

```python
PIPELINE = ("search", "acquire", "parse", "clean", "analyze", "review")
MAX_ROUNDS = 3

class Orchestrator:
    def __init__(self, ...):
        register_all_agents()          # 触发各 Agent 模块的 @AgentRegistry.register

    async def run(self, task, progress) -> Task:
        context = await self._stage_planning(task, progress)   # Orchestrator 内联：LLM 提取实体
        all_records: list[dict] = []
        for round_idx in range(1, MAX_ROUNDS + 1):
            round_records, context = await self._run_pipeline_round(
                task, context, progress, round_idx)             # 6 阶段委托
            all_records.extend(self._dedup_round(round_records, seen_ids))
            if round_idx >= MAX_ROUNDS:
                break
            # IterationDecisionAgent 判断是否继续（gap 分析 + 趋势收敛）
            _, context = await self._get_agent("iteration_decision").execute(...)
            if not context["iteration_decision"]["should_continue"]:
                break
        await self._stage_export(task, all_records, context, ...)  # Orchestrator 内联
```

**关键设计**：
- 每个阶段 Agent 自管阶段状态、溯源、进度推送，统一签名 `execute(task, records, context, progress) -> (records, updated_context)`
- 同步阻塞函数用 `asyncio.to_thread` 包装（BaseAgent._to_thread），避免阻塞 FastAPI 事件循环
- 异常 → 任务 FAILED，记录到 `task.errors`，可重新 `start`
- Darwinian Stage Gate 在 SearchAgent 内部实现（记录不足或相关性低时扩展查询重试）
- IterationDecisionAgent 收敛条件：新增记录 <5 / 规划实体全验证 / LLM 判断无 gap / 达最大轮数 / 重复率 >80% / **Stage Gate 量化评估通过（coverage≥0.8 且 confidence≥0.8 且 sources≥2 且 conflict≤0.2）** / **冲突率 >40%（需用户介入）**
- IterationDecisionAgent 量化接线：每轮调用 `stage_evaluator.evaluate()`（内存直调，stage="clean" 阈值）获取 coverage/confidence/conflict_rate/source_diversity + gaps + suggestions，注入 LLM prompt；无 LLM 时用 `keyword_expander.expand_keywords()` 基于同义词字典构造下一轮查询

**可重入状态机**（用户反馈后从指定阶段重试，非重跑全流程）：

```python
# POST /tasks/{task_id}/start?from_stage=clean
# 对 completed/failed 任务生效，跳过 planning，从 from_stage 运行到 review 再 export
orchestrator.run_resume(task, from_stage="clean", progress=progress)
```

- 可重入阶段：search / acquire / parse / clean / analyze / review
- 从 `final_data.json` 加载已持久化的 context（entities/search_queries/...）
- 从 `store._records` 加载已持久化的 records（前置阶段产出）
- 从 search 重试时清空已有记录重新检索；其余阶段保留前置产出
- 单轮执行（无多轮迭代），符合"用户显式请求重试"语义

### 4.2 ToolRegistry — 工具 facade

[backend/app/tools/registry.py](backend/app/tools/registry.py) 是薄封装层，**无 subprocess、无 CLI 参数解析**，直接调用 `tools/` 下模块函数。

```python
class ToolRegistry:
    def run_datasource(self, name, query, max_results, task_id, **kwargs) -> ToolResult
    def run_datasources_parallel(self, sources, query, ...) -> dict[str, ToolResult]
    def trace_citations(self, seed_ids, ...) -> ToolResult      # 引用追溯
    def parse_pdf_table(self, pdf_path, output_file) -> ToolResult
    def parse_geo_soft(self, file_path, output_file) -> ToolResult
    def parse_fasta(self, file_path, output_file) -> ToolResult
    def parse_pdb(self, file_path, output_file) -> ToolResult
    def parse_network(self, file_path, fmt, output_file) -> ToolResult
    def extract_chart_data(self, image_path, output_file) -> ToolResult  # Qwen-VL 图表提取
    def download_pdfs(self, records, pdf_dir, ...) -> ToolResult
    def align_fields(self, records, dict_dir) -> ToolResult
    def normalize_units(self, records) -> ToolResult
    def deduplicate(self, records) -> ToolResult
    def run_ppi(self, gene_list, task_id, output_file) -> ToolResult
    def run_enrichment(self, gene_list, task_id, output_file) -> ToolResult
    def run_drug_target(self, compounds, task_id, output_file) -> ToolResult
    def run_diff_expression(self, records, task_id, output_file) -> ToolResult
    def run_hub_gene(self, gene_list, task_id, output_file) -> ToolResult
    def run_upstream_regulator(self, gene_list, task_id, output_file) -> ToolResult
    def export_csv(self, records, output_path) -> ToolResult
```

- 统一返回 `ToolResult(success, data, error, signals)`，**统一工具协议层契约**：
  - `success: bool` — False 时 data 为空，error 必填
  - `data: list[dict] | dict` — 检索/解析/清洗类返回 DataRecord 列表；分析/IO/导出类返回结果摘要 dict
  - `error: str` — 失败信息（含工具名前缀，如 `pubmed: ...`）
  - `signals: dict` — 非记录信号，约定键 `requires_crawl`/`status`/`partial`
  - 置信度由 per-record `extraction_confidence` 承载（非 ToolResult 层）
  - 溯源事件由 Agent 调用 `ProvenanceTracker.record()`（非 ToolResult 层）
- 数据源模块函数惰性加载并缓存
- 并行检索用 `ThreadPoolExecutor`（最多 5 并发）

### 4.3 数据源

15 个数据源模块，函数签名约定 `(query, max_results, task_id) -> list[dict]`：

| 类型 | 数据源 | 查询方式 |
|------|--------|---------|
| 文献 | pubmed / openalex / semantic_scholar / arxiv | 研究目标查询 |
| 基因表达 | geo | 研究目标查询 |
| 蛋白互作 | string | 基因符号 + species 参数 |
| 通路 | kegg | 通路名 + species 参数 |
| 结构 | pdb | 研究目标查询 |
| 中药 | tcmsp | 化合物名（接口不可用则返回 `requires_crawl` 信号）|
| 基因/蛋白 | ncbi / uniprot(hgnc/ensembl) | 实体名 + db 参数 |
| 临床 | clinicaltrials / tcga | 研究目标 / 基因 |
| 药物 | drugbank(opentargets) / pubchem | 实体名 |
| 基因-疾病 | disgenet | 基因/疾病 + mode 参数 |

**双查询策略**：
- 文献源（pubmed/openalex/...）：用 LLM 生成的研究目标查询
- 实体源（string/tcmsp/disgenet）：用 LLM 提取的基因/化合物/疾病实体级查询

**Darwinian Stage Gate**：记录不足 5 条时，用扩展中英文查询（疾病名+基因名+"pancreatic cancer liver metastasis" 等）在核心文献源重试。

> `BaseDataSource` 插件体系与 `DataSourceRegistry` 存在于 [datasources/base_ds.py](backend/app/tools/datasources/base_ds.py) 但 **dormant**，orchestrator 不使用。

### 4.4 清洗三件套

| 步骤 | 模块 | 输入 | 输出 |
|------|------|------|------|
| 字段对齐 | [cleaners/field_aligner.py](backend/app/tools/cleaners/field_aligner.py) | records + 词典目录 | 对齐后 records + mapping |
| 单位归一化 | [cleaners/unit_normalizer.py](backend/app/tools/cleaners/unit_normalizer.py) | records | 归一化后 records |
| 去重 | [cleaners/duplicate_detector.py](backend/app/tools/cleaners/duplicate_detector.py) | records | 去重后 records |

词典来自 [resources/dictionaries/](backend/app/resources/dictionaries/)：
- `gene_symbols.yaml` / `compound_names.yaml` / `disease_names.yaml`
- `unit_aliases.yaml` / `field_aliases.yaml`

### 4.5 生物信息学分析

[tools/analysis/](backend/app/tools/analysis/) 提供 7 个分析模板，AnalysisAgent 按数据类型路由，Phase1 并行 + Phase2 复用 PPI 结果：

| 分析 | 模块 | 接线 | 触发条件 | 服务 |
|------|------|------|---------|------|
| PPI 网络 | ppi_network.py | ✅ Phase1 | 有基因列表 | STRING API |
| GO/KEGG 富集 | enrichment.py | ✅ Phase1 | 有基因列表 | Enrichr API |
| 药物-靶点 | drug_target.py | ✅ Phase1 | 有化合物 | OpenTargets API |
| 差异表达 | differential_expression.py | ✅ Phase1 | 有 log2fc 数据 | 本地计算 |
| Hub 基因 | hub_gene.py | ✅ Phase2 | 有基因列表 | 本地计算（复用 PPI） |
| 上游调控 | upstream_regulator.py | ✅ Phase2 | 有基因列表 | 本地计算（复用 PPI） |
| 生存分析 | survival.py | ✅ Phase3 | 有基因列表 + disease→TCGA cohort 映射 | TCGA GDC API |

**性能优化**：Phase1（PPI/富集/药靶/差异表达）`asyncio.gather` 并行；Phase2（Hub/上游）复用 Phase1 的 PPI 结果，不重复调用 STRING API（原 24 次→1 次）。

### 4.6 LLM 层

[llm/client.py](backend/app/llm/client.py) 封装 DashScopeClient（OpenAI 兼容模式）：

| 方法 | 用途 | 模型 |
|------|------|------|
| `chat` | 文本对话 | qwen-plus（默认）/ qwen-max |
| `chat_json` | 对话返回 JSON | qwen-plus / qwen-max |
| `chat_vision` | 多模态识图 | qwen-vl-max |
| `chat_document` | 长文档理解 | qwen-long |

**模型分工**：
- `MODEL_TEXT` (qwen-plus)：planning 实体识别
- `MODEL_STRONG` (qwen-max)：review 审查 + LLMReporter 报告

**LLMReporter** [agents/llm_reporter.py](backend/app/agents/llm_reporter.py)：
- 整合 records + entities + analysis + review 生成科学叙事式 HTML 报告
- 失败直接抛异常，**不回退模板**
- 用 `asyncio.to_thread` 包装同步调用

### 4.7 Provenance — 数据溯源

[provenance/tracker.py](backend/app/provenance/tracker.py) 在 search/parse/clean/analyze 各阶段记录 `ProvenanceNode`，形成 DAG。

```python
class ProvenanceTracker:
    def record(self, operation_type, agent_name, tool_name,
               input_records, output_records, parameters) -> str
    def get_lineage(self, record_id) -> list[ProvenanceNode]
    def to_graph(self) -> dict  # {nodes, edges, stats}
    def save(self, path) / load(self, path)
```

**字段级溯源**：每条记录携带 `field_provenance` dict，记录各字段的完整变换链路，满足赛题"来源可追溯性"加分项：

```python
# record["field_provenance"] 结构
{
  "compound_name": [
    {"step": "field_align", "from": "MolName", "to": "compound_name",
     "transform": "title", "source": "tcmsp"}
  ],
  "log2fc": [
    {"step": "field_align", "from": "logFC", "to": "log2fc", "transform": "float", "source": "geo"},
    {"step": "unit_normalize", "from_unit": "ln", "to_unit": "log2"}
  ]
}
```

- 字段来源（表格/段落/网页/截图）由记录级 `source_ref.source_type` + `extraction_method` 标识
- 字段名对齐由 [field_aligner.py](backend/app/tools/cleaners/field_aligner.py) 追加 `field_align` 条目
- 单位转换由 [unit_normalizer.py](backend/app/tools/cleaners/unit_normalizer.py) 追加 `unit_normalize` 条目
- clean 阶段 ProvenanceNode.parameters 汇总 `field_align_events` / `unit_normalize_events` / `fields_with_provenance`

API 暴露：
- `GET /tasks/{id}/lineage` — 完整 DAG
- `GET /tasks/{id}/lineage/{record_id}` — 单记录链路
- `GET /tasks/{id}/data` — 返回记录含 `field_provenance` 字段

前端 [LineageGraph.tsx](frontend/src/components/lineage/LineageGraph.tsx) 用 ReactFlow 渲染。

### 4.8 存储层

[storage/task_store.py](backend/app/storage/task_store.py) — **内存字典 + JSON 文件持久化**，无 SQLite/Redis。

```python
class TaskStore:
    _tasks: dict[str, Task]              # 任务
    _provenance: dict[str, ProvenanceTracker]  # 溯源
    _records: dict[str, list[dict]]      # 数据记录
    _reports: dict[str, str]             # HTML 报告
    _analysis: dict[str, dict]           # 分析结果
```

- `save_task_to_file` 持久化 task + lineage + records 到 `data/output/{task_id}/`
- `load_from_disk` 启动时恢复

### 4.9 API 层

统一前缀 `/api/v1`，FastAPI 自动生成 `/docs` Swagger。完整端点见 README。

WebSocket 推送格式：
```json
{"type": "stage_start", "stage": "search", "message": "..."}
{"type": "stage_progress", "stage": "search", "pct": 0.4, "message": "..."}
{"type": "stage_complete", "stage": "search", "records_count": 120}
{"type": "task_complete", "task_id": "...", "summary": {...}}
{"type": "error", "task_id": "...", "message": "..."}
```

---

## 五、流水线阶段

| 阶段 | 实现 | 职责 |
|------|------|------|
| 1. planning | LLM qwen-plus | 提取化合物/基因/疾病/通路实体，识别领域，生成检索查询与推荐数据源 |
| 2. search | 原生模块 + 线程池 | 文献源并行 + 实体源串行；Darwinian 扩展重试 |
| 3. acquire | WebCrawlerSource + BrowserAgent | 读取 search 阶段 `requires_crawl` 信号，爬取目标页面输出 raw crawl record（由 parse 阶段 LLMExtractor 转结构化）；JS 重站点（cnki/wanfang/chembl/...）路由到 Playwright 浏览器爬虫，输出截图供 Qwen-VL 提取；爬虫失败隔离不影响流水线 |
| 4. parse | 原生模块 + Qwen-VL | PDF 表格/caption + OA 下载 + 爬虫 LLM 提取 + 图表 Qwen-VL 提取（上传图片 + 浏览器截图）+ GEO SOFT/PDB/FASTA/网络文件 |
| 5. clean | 三件套 | 字段对齐 → 单位归一化 → 去重 |
| 6. analyze | 原生模块（可选）| Phase1 并行：PPI/富集/药靶/差异表达；Phase2 复用 PPI：Hub/上游；Phase3 生存分析（disease→TCGA cohort 映射）|
| 7. review | LLM qwen-max | 审查完整性/覆盖/发现/建议，输出质量评分 |
| 8. export | 原生 + LLMReporter | CSV + 整合 CSV + LLM 报告 + JSON |

**任务状态机**：
```
CREATED → PLANNING → SEARCHING → (ACQUIRING) → (PARSING) → CLEANING → (ANALYZING) → REVIEWING → COMPLETED
    │                                                                                              │
    └──────────────────────────────── FAILED（记录错误，可重新 start） ────────────────────────────┘
```

---

## 六、数据流示例

以「分析健脾散结方对胰腺癌肝转移的影响」为例：

```
T0  用户输入研究目标
T1  planning: LLM 识别 compounds=[健脾散结方成分...] genes=[AKT1/TP53/...] diseases=[胰腺癌/肝转移] domain=tcm
T2  search:   PubMed→18 / OpenAlex→12 / Semantic Scholar→8 / STRING→PPI / DisGeNET→基因-疾病
              记录不足时扩展查询 "pancreatic cancer liver metastasis" 重试
T3  acquire:  TCMSP 返回 requires_crawl 信号 → WebCrawlerSource 爬取页面 → raw crawl record（待 parse 阶段 LLM 提取）
T4  parse:    下载 5 篇 OA 论文 PDF，pdfplumber 提取表格；爬虫内容 LLM 提取；用户上传图表 Qwen-VL 提取；用户上传生物数据解析
T5  clean:    字段对齐（MolName→compound_name）+ 单位归一化 + 去重
T6  analyze:  STRING PPI 网络 + Enrichr GO/KEGG 富集 + OpenTargets 药物-靶点
T7  review:   qwen-max 审查质量评分 0.89，标记缺失与建议
T8  export:   data.csv + merged_data.csv（按实体分组）+ LLM 综合报告 HTML + final_data.json
T9  前端展示: 流水线状态 + 数据表格 + 统计图表 + 血缘图 + LLM 报告 + 分析结果
```

---

## 七、可扩展性

| 扩展点 | 方式 | 现状 |
|--------|------|------|
| 新增数据源 | `tools/datasources/` 添加模块函数 + `ToolRegistry._get_ds_func` 注册 | 15 活跃 |
| 新增解析器 | `tools/parsers/` 添加模块 + `ToolRegistry` 加 facade + `ParserAgent._BIO_PARSER_MAP` 注册 | 6 个（全接线）|
| 新增清洗器 | `tools/cleaners/` 添加模块 + `ToolRegistry` 加 facade | 3 个 |
| 新增分析模板 | `tools/analysis/` 添加模块 + `ToolRegistry` 加 facade | 7 个（全接线）|
| 新增导出格式 | `tools/export/` 添加模块 | CSV/Excel/MD |
| 新增领域模板 | `resources/domain_templates/` 加 YAML | 中医药/肿瘤学/药理学 |
| 新增词典 | `resources/dictionaries/` 加 YAML | 基因/化合物/疾病/单位/字段别名 |

---

## 八、已知限制与后续方向

| 限制 | 影响 | 优先级 |
|------|------|--------|
| optimization 模块 dormant | ~~stage_evaluator 未接线~~ → 已接线 IterationDecisionAgent（量化指标驱动收敛 + LLM prompt 增强 + keyword_expander fallback）；reflection_loop 文件版仍 dormant（CLI 导向，内存直调 evaluate 已覆盖核心价值） | P2→已解决 |
| DataRecord Pydantic dormant | 运行时用裸 dict，类型安全弱 | P3 |

---

## 九、技术选型

**后端**：FastAPI + Uvicorn + Pydantic v2 + openai（DashScope 兼容）+ httpx + pandas/numpy/scipy + pdfplumber + beautifulsoup4

**前端**：React 18 + TypeScript + Vite + Ant Design 5 + ECharts + @xyflow/react + Zustand

**存储**：内存字典 + JSON 文件（无 SQLite/Redis）

**LLM**：阿里云百炼 DashScope（qwen-plus / qwen-max / qwen-vl-max / qwen-long）
