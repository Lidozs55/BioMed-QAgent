## 一、架构总览

### 1.1 系统定位

BioMed QAgent 是一个面向**生物医学研究**场景的 AI 应用。用户输入自然语言描述的研究目标（如"分析健脾散结方对胰腺癌肝转移的影响"），系统通过多智能体协作自动完成 **数据查找/采集 → 数据解析 → 数据清洗 → 字段对齐 → 数据分析 → 来源标注 → 结构化输出** 的全流程。

系统核心解决生物医学研究中**多源异构数据库无标准 API、前端交互逻辑各异、数据格式多样**的痛点，通过"静态预设爬虫 + 动态浏览器自动化"双轨策略覆盖主流生物医学数据库（TCM、STRING、GEO、PDB、NCBI 等），并支持 Agent 动态生成分析脚本完成差异表达分析、功能富集、分子对接等生物信息学任务。

### 1.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **多智能体协作** | 将复杂科研任务分解为专职 Agent，每个 Agent 负责一个明确阶段 |
| **可追溯性（Provenance）** | 每条最终输出数据均可追溯到原始来源和完整的处理链路 |
| **可扩展性** | Agent、数据源、爬虫、解析器、分析模板、输出格式均可通过注册机制动态扩展 |
| **人在回路** | 关键决策点（爬虫验证、数据合并冲突、低置信度数据）支持人工介入 |
| **前后端分离** | 后端提供 REST API + WebSocket，前端通过 Electron + React 渲染 |

### 1.3 架构全景图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (Electron + React)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ 任务面板  │ │ 数据溯源  │ │ 数据预览  │ │ 图表可视  │ │ 反馈修正  │ │
│  └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬────┘ │
│        └───────────┴────────────┴────────────┴───────────┘       │
│                            │ REST API / WebSocket                 │
└────────────────────────────┼────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────┐
│                         Backend (Python / FastAPI)                │
│                            │                                       │
│  ┌─────────────────────────▼─────────────────────────────────────┐  │
│  │                    API Gateway Layer                         │  │
│  │  (路由分发 / 认证 / 限流 / 请求校验)                          │  │
│  └─────────────────────────┬─────────────────────────────────────┘  │
│                            │                                       │
│  ┌─────────────────────────▼─────────────────────────────────────┐  │
│  │                  Orchestrator Agent (核心)                     │  │
│  │  (任务规划 / Agent 调度 / 结果整合 / 状态管理)                │  │
│  └───┬──────────┬──────────┬──────────┬──────────┬──────────┬────┘  │
│      │          │          │          │          │          │        │
│  ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼────┐  │
│  │Search │ │Acquire│ │ Parse │ │Clean  │ │Analyze│ │Review  │  │
│  │Agent  │ │Agent  │ │Agent  │ │Agent  │ │Agent  │ │Agent   │  │
│  └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ └───┬────┘  │
│      └──────────┴──────────┴──────────┴──────────┴──────────┘       │
│                            │                                       │
│  ┌─────────────────────────▼───────────────────────────────────┐  │
│  │                  Tool Registry (工具注册表)                    │  │
│  │  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────┐   │  │
│  │  │DataSource│ │ Crawler & │ │ Document │ │  Analysis    │   │  │
│  │  │ Plugins  │ │ Browser   │ │ Processors│ │  Templates   │   │  │
│  │  │ (API)    │ │Automation│ │ (PDF/生物)│ │  (生物信息)  │   │  │
│  │  └──────────┘ └───────────┘ └──────────┘ └──────────────┘   │  │
│  │  ┌──────────┐ ┌──────────┐                                  │  │
│  │  │Execution │ │Validation│                                  │  │
│  │  │ Engine   │ │ Rules    │                                  │  │
│  │  └──────────┘ └──────────┘                                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                            │                                       │
│  ┌─────────────────────────▼───────────────────────────────────┐  │
│  │                  Data & Storage Layer                         │  │
│  │  ┌──────────┐ ┌──────────────┐ ┌───────────┐ ┌──────────┐ │  │
│  │  │任务DB    │ │文件存储       │ │Provenance │ │缓存      │ │  │
│  │  │(SQLite)  │ │(本地FS)       │ │(数据血缘) │ │(内存)    │ │  │
│  │  └──────────┘ └──────────────┘ └───────────┘ └──────────┘ │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 二、项目目录结构

```
project-root/
├── README.md
├── PROBLEM.md
├── ARCHITECTURE.md
│
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py              # FastAPI 入口
│   │   ├── config.py            # 全局配置
│   │   │
│   │   ├── api/                 # API 路由层
│   │   │   ├── routes/
│   │   │   │   ├── tasks.py     # 任务 CRUD 与生命周期
│   │   │   │   ├── data.py      # 数据查询、预览、导出
│   │   │   │   ├── lineage.py   # 数据溯源查询
│   │   │   │   ├── ws.py        # WebSocket 实时推送
│   │   │   │   └── feedback.py  # 用户反馈与修正
│   │   │   ├── schemas/         # Pydantic 请求/响应模型
│   │   │   └── middleware/      # 认证、限流、CORS
│   │   │
│   │   ├── agents/              # 多智能体层
│   │   │   ├── base.py          # BaseAgent 抽象基类
│   │   │   ├── orchestrator.py # Orchestrator — 任务规划与调度
│   │   │   ├── search.py        # Search — API 数据源查找
│   │   │   ├── acquire.py       # Acquire — 爬虫与浏览器自动化
│   │   │   ├── parser.py        # Parser — 文献/生物数据解析
│   │   │   ├── cleaner.py       # Cleaner — 数据清洗与字段对齐
│   │   │   ├── analysis.py      # Analysis — 生物信息学分析
│   │   │   ├── reviewer.py      # Reviewer — 质量审查与置信度
│   │   │   └── registry.py      # Agent 注册表
│   │   │
│   │   ├── tools/               # 工具注册表
│   │   │   ├── base.py          # BaseTool 抽象基类
│   │   │   ├── registry.py      # Tool Registry
│   │   │   │
│   │   │   ├── datasources/     # 数据源插件（API）
│   │   │   │   ├── base_ds.py
│   │   │   │   ├── pubmed.py
│   │   │   │   ├── geo.py
│   │   │   │   ├── string_db.py
│   │   │   │   ├── pdb.py
│   │   │   │   ├── ncbi.py
│   │   │   │   ├── tcmsp.py
│   │   │   │   ├── tcm.py
│   │   │   │   ├── kegg.py
│   │   │   │   ├── openalex.py
│   │   │   │   ├── arxiv.py
│   │   │   │   └── semantic_scholar.py
│   │   │   │
│   │   │   ├── crawlers/        # 爬虫与浏览器自动化
│   │   │   │   ├── base_crawler.py
│   │   │   │   ├── playwright_driver.py
│   │   │   │   ├── static_crawlers/
│   │   │   │   │   ├── geo_crawler.py
│   │   │   │   │   ├── string_crawler.py
│   │   │   │   │   ├── tcmsp_crawler.py
│   │   │   │   │   └── tcm_crawler.py
│   │   │   │   └── dynamic_generator.py
│   │   │   │
│   │   │   ├── processors/     # 文档与数据解析
│   │   │   │   ├── base_proc.py
│   │   │   │   ├── pdf_parser.py
│   │   │   │   ├── table_extractor.py
│   │   │   │   ├── chart_extractor.py
│   │   │   │   ├── bio_data_parser.py
│   │   │   │   │   ├── geo_soft_parser.py
│   │   │   │   │   ├── pdb_parser.py
│   │   │   │   │   └── network_parser.py
│   │   │   │   ├── formula_parser.py
│   │   │   │   └── reference_parser.py
│   │   │   │
│   │   │   ├── analysis_templates/  # 生物信息学分析模板
│   │   │   │   ├── base_analysis.py
│   │   │   │   ├── differential_expr.py
│   │   │   │   ├── enrichment.py
│   │   │   │   ├── network_analysis.py
│   │   │   │   └── molecular_docking.py
│   │   │   │
│   │   │   ├── execution/       # 代码执行引擎
│   │   │   │   ├── sandbox.py
│   │   │   │   └── runner.py
│   │   │   │
│   │   │   └── validators/      # 数据校验规则
│   │   │       ├── base_val.py
│   │   │       ├── range_check.py
│   │   │       ├── unit_check.py
│   │   │       └── duplicate_check.py
│   │   │
│   │   ├── llm/                 # LLM 调用层
│   │   │   ├── client.py        # Qwen API 统一客户端
│   │   │   ├── function_calling.py
│   │   │   └── prompts/
│   │   │       ├── orchestrator.txt
│   │   │       ├── search.txt
│   │   │       ├── acquire.txt
│   │   │       ├── parser.txt
│   │   │       ├── cleaner.txt
│   │   │       ├── analysis.txt
│   │   │       └── reviewer.txt
│   │   │
│   │   ├── provenance/          # 数据血缘与溯源
│   │   │   ├── tracker.py
│   │   │   ├── lineage.py
│   │   │   └── models.py
│   │   │
│   │   ├── models/              # 数据模型
│   │   │   ├── task.py
│   │   │   ├── data_record.py
│   │   │   ├── source.py
│   │   │   └── field_mapping.py
│   │   │
│   │   └── utils/
│   │
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/
│   ├── package.json
│   ├── electron/
│   │   ├── main.js
│   │   └── preload.js
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api/                 # API 调用封装
│   │   ├── components/
│   │   │   ├── layout/          # 布局
│   │   │   ├── task/            # 任务面板、状态卡片、时间线
│   │   │   ├── data/            # 数据预览、字段映射、导出、置信度
│   │   │   ├── lineage/         # 数据血缘图（ReactFlow）
│   │   │   ├── charts/          # 图表可视化（ECharts）
│   │   │   └── feedback/        # 反馈修正、冲突解决
│   │   ├── hooks/
│   │   ├── stores/              # Zustand 状态管理
│   │   └── styles/
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── data/                         # 运行时数据（.gitignore）
│   ├── uploads/
│   ├── parsed/
│   ├── output/
│   └── cache/
│
└── docs/
    └── api/openapi.yaml
```

---

## 三、核心模块设计

### 3.1 Agent 层

#### 3.1.1 BaseAgent 抽象基类

所有 Agent 继承 `BaseAgent`，通过注册机制接入系统：

```python
# backend/app/agents/base.py

class AgentInput(BaseModel):
    task_id: str
    context: dict[str, Any]
    data: Optional[list[dict]] = None
    user_feedback: Optional[str] = None

class AgentOutput(BaseModel):
    agent_name: str
    status: str                   # "success" | "partial" | "failed" | "needs_human"
    data: Optional[list[dict]] = None
    metadata: dict[str, Any] = {}
    errors: list[str] = []
    human_requests: list[dict] = []

class BaseAgent(ABC):
    name: str
    description: str              # 供 Orchestrator 路由参考
    version: str = "1.0"

    def __init__(self, llm_client, tool_registry, provenance_tracker): ...

    @abstractmethod
    async def execute(self, agent_input: AgentInput) -> AgentOutput: ...

    @abstractmethod
    def get_capabilities(self) -> list[str]: ...

    async def invoke_tool(self, tool_name: str, params: dict) -> Any:
        """调用工具并自动记录溯源"""
        result = await self.tools.invoke(tool_name, params)
        await self.provenance.record_tool_call(self.name, tool_name, params, result)
        return result
```

#### 3.1.2 Orchestrator Agent — 任务规划与调度

系统核心大脑，负责意图理解、任务分解、Agent 调度、结果整合和异常恢复。

```python
# backend/app/agents/orchestrator.py

class OrchestratorAgent(BaseAgent):
    name = "orchestrator"

    PIPELINE = [
        "search",      # API 数据源查找
        "acquire",     # 爬虫/浏览器自动化采集
        "parser",      # 文献与生物数据解析
        "cleaner",     # 数据清洗与字段对齐
        "analysis",    # 生物信息学分析（可选）
        "reviewer",    # 质量审查
    ]

    async def execute(self, agent_input: AgentInput) -> AgentOutput:
        # 1. 理解研究意图 → 生成执行计划
        plan = await self.plan(research_goal)

        # 2. 按流水线顺序调度各 Agent
        for agent_name in self.PIPELINE:
            agent = self.agent_registry.get(agent_name)
            output = await agent.execute(step_input)

            if output.status == "needs_human":
                # 人在回路：等待用户决策后重试
                human_response = await self.wait_for_human(task_id, output.human_requests)
                output = await agent.execute(step_input_with_feedback)

            aggregated_data.extend(output.data or [])
            context.update(output.metadata)

        return self._build_final_output(aggregated_data, context)
```

**任务状态机**：

```
CREATED → PLANNING → SEARCHING → ACQUIRING → PARSING → CLEANING → ANALYZING → REVIEWING → COMPLETED
    │                                                                                      │
    └──────────────────────────────── FAILED (可从失败点重试) ──────────────────────────────┘
```

#### 3.1.3 Search Agent — API 数据源查找

通过标准 API 检索相关论文、数据库条目和元数据。对于无标准 API 的数据库，标记后转交 Acquire Agent。

```
研究目标输入
    │
    ├─ LLM 分析：识别关键实体、研究领域、数据类型
    │      例："健脾散结方对胰腺癌肝转移的影响"
    │      → 实体：["健脾散结方", "胰腺癌", "肝转移"]
    │      → 领域：中医药/肿瘤学/分子生物学
    │      → 数据需求：[中药成分, 靶点基因, 基因表达, 通路]
    │
    ├─ 数据源路由（按领域匹配最优组合）
    │      中医药 → PubMed + TCMSP + TCM Database
    │      分子靶点 → STRING + KEGG + NCBI Gene
    │      基因表达 → GEO + TCGA
    │
    ├─ 并行检索各 API 数据源
    │
    ├─ 标记无API数据源 → requires_crawl: true
    │
    └─ 输出：SearchResult 列表（含 requires_crawl 标记）
```

#### 3.1.4 Acquire Agent — 爬虫与浏览器自动化

针对无标准 API 的数据库（如 TCMSP、STRING 网页版），通过浏览器自动化采集数据。采用"静态预设 + 动态生成"双轨策略。

```
标记 requires_crawl=true 的结果输入
    │
    ├─ 数据源路由
    │      TCMSP 网页 → tcmsp_crawler（静态预设）
    │      STRING 网页 → string_crawler（静态预设）
    │      未知网站 → dynamic_generator（动态生成）
    │
    ├─ 静态预设爬虫（优先）
    │      Playwright 模拟：导航 → 检索 → 下载
    │      XPath/CSS 提取 → 结构化数据
    │
    ├─ 动态生成爬虫（兜底）
    │      LLM 分析 DOM → 生成脚本 → 测试验证
    │      成功 → 存入知识库复用
    │      失败 → needs_human
    │
    ├─ 文本模式浏览器（轻量备选）
    │      w3m 渲染为文本 → LLM 理解并提取
    │
    └─ 输出：AcquiredDataRecord 列表
```

**爬虫插件接口**：

```python
# backend/app/tools/crawlers/base_crawler.py

class BaseCrawler(BaseModel, ABC):
    name: str
    target_url_pattern: str
    requires_login: bool = False

    @abstractmethod
    async def search_and_extract(self, query: str, browser) -> CrawlerResult: ...

    @abstractmethod
    async def validate_extraction(self, sample: dict) -> bool: ...
```

#### 3.1.5 Parser Agent — 文献与生物数据解析

从搜索结果和采集数据中解析出可用信息，处理 PDF 文献、网页数据、生物数据文件。

```
SearchResult + AcquiredDataRecord 输入
    │
    ├─ 内容获取
    │      PDF → MinerU → Markdown
    │      GEO SOFT → 基因表达矩阵
    │      PDB → 蛋白质结构坐标
    │      STRING TSV → PPI 网络关系
    │
    ├─ 多通道解析（并行）
    │      ├─ 文本解析：LLM 识别中药成分、靶点基因、实验方法
    │      ├─ 表格解析：HTML/PDF 表格 → Pandas DataFrame
    │      ├─ 图表解析：Qwen 视觉理解 → 数据点提取
    │      └─ 生物数据：格式识别 → 结构化存储
    │
    └─ 输出：ParsedDataRecord 列表（统一格式）
```

**统一数据记录模型**：

```python
# backend/app/models/data_record.py

class DataRecord(BaseModel):
    record_id: str
    task_id: str
    fields: dict[str, Any]                # 字段名 → 值
    field_descriptions: dict[str, str] = {}
    source_ref: SourceReference            # 原始来源
    extraction_method: str                # "table" | "text" | "chart" | "api" | "crawl"
    extraction_confidence: float          # [0, 1]
    quality_flags: list[str] = []
    unit_info: dict[str, str] = {}
    processing_log: list[ProcessingStep] = []
```

#### 3.1.6 Cleaner Agent — 数据清洗与字段对齐

处理缺失、重复、格式不一致问题，统一不同来源数据的字段。这是赛题核心考察点。

```
ParsedDataRecord 列表输入
    │
    ├─ Step 1: 质量检测
    │      缺失值 / 重复 / 单位不一致 / 数值范围异常 / 格式不一致
    │
    ├─ Step 2: 字段对齐（核心难点）
    │      语义匹配：LLM + 领域同义词表
    │        "Gene" ↔ "SYMBOL" ↔ "GeneSymbol" → "gene_symbol"
    │        "MolName" ↔ "Ingredient" ↔ "化合物" → "compound_name"
    │      单位统一：logFC ↔ log2FoldChange → "log2fc"
    │      格式统一：日期、基因ID、标识符
    │
    ├─ Step 3: 清洗执行
    │      去重（保留高置信度版本）/ 缺失值标记 / 异常值标记
    │
    ├─ Step 4: 冲突检测
    │      同一实体不同来源值不一致 → 自动或人工解决
    │
    └─ 输出：CleanedDataRecord + 字段映射表 + 冲突报告
```

**字段映射模型**：

```python
# backend/app/models/field_mapping.py

class FieldMapping(BaseModel):
    unified_field_name: str         # "gene_symbol"
    unified_field_label: str        # "基因符号"
    unified_unit: Optional[str]     # "log2"
    source_mappings: list[SourceFieldMap]

class SourceFieldMap(BaseModel):
    source_name: str
    original_field_name: str
    original_unit: Optional[str]
    transform: Optional[str]         # 转换表达式
    confidence: float
```

#### 3.1.7 Analysis Agent — 生物信息学分析

根据研究目标和已整合的数据，动态生成并执行分析脚本（差异表达、功能富集、PPI 网络、分子对接等）。

```
CleanedDataRecord + 研究目标输入
    │
    ├─ 数据类型识别 → 匹配分析策略
    │      基因表达矩阵 → 差异表达分析
    │      化合物-靶点 → 网络药理学分析
    │      蛋白质序列 → 分子对接
    │
    ├─ 模板匹配或动态生成 Python/R 脚本
    │
    ├─ Docker 沙箱执行 → 捕获结果与图表
    │
    └─ 输出：AnalysisResult（统计表 + 可视化 + 解释文本）
```

#### 3.1.8 Reviewer Agent — 质量审查

独立审查数据质量，充当"第二双眼睛"：

| 审查维度 | 内容 |
|---------|------|
| 数据完整性 | 必要字段齐全、数据覆盖率、时间连续性 |
| 引用准确性 | 来源URL有效性、DOI正确性 |
| 数值一致性 | 范围合理性、多来源一致性、物理约束 |
| 爬虫验证 | 网页采集数据与页面内容一致性 |

输出：整体质量评分、逐条置信度、问题清单、修正建议。

#### 3.1.9 Agent 注册表

```python
# backend/app/agents/registry.py

class AgentRegistry:
    _agents: dict[str, type[BaseAgent]] = {}

    @classmethod
    def register(cls, agent_class: type[BaseAgent]):
        """装饰器：注册 Agent，Orchestrator 自动发现"""
        instance = agent_class()
        cls._agents[instance.name] = agent_class

    @classmethod
    def get(cls, name: str) -> BaseAgent: ...
    @classmethod
    def list_agents(cls) -> list[dict]: ...

# 扩展方式：
# @AgentRegistry.register
# class CitationAgent(BaseAgent):
#     name = "citation"
#     ...
```

---

### 3.2 Tool Registry — 工具注册表

```python
# backend/app/tools/registry.py

class ToolRegistry:
    _tools: dict[str, BaseTool] = {}

    def get_definitions_for_agent(self, agent_name: str) -> list[dict]:
        """按 Agent 返回可用工具定义（OpenAI function calling 格式）"""
        ...

    async def invoke(self, tool_name: str, params: dict) -> ToolResult: ...

# Agent → 工具映射
_AGENT_TOOL_MAP = {
    "search":   ["search_pubmed", "search_geo", "search_string",
                 "search_ncbi", "search_openalex", "search_arxiv",
                 "fetch_full_text", "download_file"],
    "acquire":  ["crawl_tcmsp", "crawl_string", "crawl_geo_web",
                 "dynamic_crawl", "playwright_navigate",
                 "screenshot_verify", "cache_lookup"],
    "parser":   ["parse_pdf", "extract_tables", "extract_charts",
                 "parse_bio_data_geo", "parse_bio_data_pdb",
                 "parse_network_string", "parse_references"],
    "cleaner":  ["detect_duplicates", "normalize_units", "align_fields",
                 "fill_missing", "validate_range", "merge_expression_matrix"],
    "analysis": ["differential_expression", "go_kegg_enrichment",
                 "ppi_network_analysis", "molecular_docking",
                 "generate_visualization"],
    "reviewer": ["validate_citation", "check_consistency",
                 "assess_confidence", "validate_crawler_extraction"],
}
```

---

### 3.3 Provenance 层 — 数据溯源

每条最终数据都可追溯到原始来源，这是赛题核心考察点。

```python
# backend/app/provenance/models.py

class ProvenanceNode(BaseModel):
    node_id: str
    operation_type: str             # "search" | "acquire" | "parse" | "clean" | "analysis"
    agent_name: str
    tool_name: Optional[str]
    input_node_ids: list[str]       # 上游依赖
    output_data_ids: list[str]
    parameters: dict
    timestamp: datetime

class DataLineage(BaseModel):
    record_id: str
    root_sources: list[SourceReference]
    processing_chain: list[ProvenanceNode]
    confidence_history: list[float]
```

**溯源链示例**：

```
字段 "compound_name": "Quercetin"
├─ [parse] Parser Agent → extract_tables → source: tcmsp_result 表格1
│   └─ [acquire] Acquire Agent → crawl_tcmsp → Playwright 自动化
│       └─ 原始来源: TCMSP (https://tcmspw.com/tcmsp.php)
└─ [clean] Cleaner Agent → align_fields → "MolName" → "compound_name"
    └─ 置信度: 0.95

字段 "log2fc": 2.35
├─ [parse] Parser Agent → parse_bio_data_geo → GEO SOFT 文件
│   └─ [search] Search Agent → search_geo → GEO 数据集 GSE12345
│       └─ 原始来源: GEO (https://www.ncbi.nlm.nih.gov/geo/)
├─ [analysis] Analysis Agent → differential_expression → DESeq2
│   └─ 参数: padj < 0.05, |log2FC| > 1
└─ [review] Reviewer Agent → 通过统计显著性校验 → 置信度: 0.92
```

---

### 3.4 LLM 层 — DashScope (阿里云百炼) 封装

强制使用阿里云百炼平台，通过 **OpenAI 兼容模式** 接入，API Key 从环境变量 `DASHSCOPE_API_KEY` 读取。

```python
# backend/app/llm/client.py

from openai import OpenAI

class DashScopeClient:
    """阿里云百炼 DashScope 客户端（OpenAI 兼容模式）。

    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    支持模型：qwen-plus / qwen-max / qwen-turbo（文本）
             qwen-vl-max / qwen-vl-plus（多模态识图）
             qwen-long（长文档理解，需先上传文件获取 fileid）
    """

    def __init__(self, config):
        self.client = OpenAI(
            api_key=os.getenv("DASHSCOPE_API_KEY"),
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
        )

    def chat(self, messages, model="qwen-plus", tools=None, **kwargs):
        ...

    def chat_vision(self, messages, model="qwen-vl-max", **kwargs):
        """多模态：图片理解（图表数据提取、表格识别）"""
        ...

    def chat_document(self, messages, file_id, model="qwen-long", **kwargs):
        """长文档理解：传入 fileid:// 协议"""
        ...
```

**模型分层策略**（全部通过 DashScope OpenAI 兼容模式调用）：

| 场景 | 模型 | 理由 |
|------|------|------|
| Orchestrator 规划 / 实体识别 | qwen-plus | 性价比高，速度快 |
| Cleaner 字段对齐 / 语义匹配 | qwen-plus | 语义理解足够 |
| Reviewer 审查 | qwen-max | 强推理 |
| Parser 图表理解 / 表格识别 | qwen-vl-max | 多模态视觉 |
| PDF 全文理解 | qwen-long | 支持长上下文 + fileid 文档理解 |
| Analysis 代码生成（如需） | qwen-max | 复杂代码 |

**关键能力**：
- **Function Calling**：Orchestrator 用 function calling 选择调用哪个工具/脚本
- **联网搜索**：`enable_search=True` 补充实时信息
- **流式输出**：WebSocket 实时推送 LLM 思考过程
- **图片理解**：base64 data URL 传入 qwen-vl-max，用于图表数据提取
- **文档理解**：上传 PDF 到百炼平台获取 fileid，用 qwen-long 理解全文

---

### 3.5 API 层

**核心接口**：

```
POST   /api/v1/tasks                    # 创建任务
GET    /api/v1/tasks/{id}               # 任务详情
POST   /api/v1/tasks/{id}/start         # 启动执行
POST   /api/v1/tasks/{id}/pause         # 暂停
GET    /api/v1/tasks/{id}/data          # 获取输出数据
POST   /api/v1/tasks/{id}/export        # 导出 CSV/JSON/Excel
GET    /api/v1/tasks/{id}/lineage       # 数据血缘
GET    /api/v1/tasks/{id}/agents        # Agent 状态
POST   /api/v1/tasks/{id}/feedback      # 提交反馈
WS     /api/v1/ws/tasks/{id}            # 实时状态推送
```

**创建任务示例**：

```json
{
  "research_goal": "分析健脾散结方对胰腺癌肝转移的影响",
  "domain_hint": "中医药",
  "data_format_preference": ["CSV"],
  "constraints": {
    "date_range": ["2020-01-01", "2026-01-01"],
    "max_sources": 20
  }
}
```

**CSV 导出自动附加来源标注列**：

| compound_name | gene_symbol | log2fc | p_value | source_doi | extraction_method | confidence | quality_flags |
|---|---|---|---|---|---|---|---|
| Quercetin | AKT1 | 2.35 | 0.001 | 10.xxxx | table | 0.95 | |
| Kaempferol | TP53 | -1.82 | 0.023 | GSE12345 | crawl | 0.88 | needs_review |

**WebSocket 推送格式**：

```json
{"type": "agent_status", "agent_name": "search", "status": "running", "progress": 0.6, "message": "检索 PubMed 中 (12/20)"}
{"type": "human_request", "request_type": "conflict_resolve", "options": [...]}
{"type": "task_completed", "summary": {"total_records": 1850, "avg_confidence": 0.89}}
```

---

### 3.6 Frontend 层

**技术栈**：Electron + React + TypeScript + Vite + Zustand + Ant Design + ECharts + ReactFlow + Tailwind CSS

**核心页面布局**：

```
┌──────────────────────────────────────────────────────────────┐
│  SciDataHub                              [新任务] [设置]      │
├──────────┬───────────────────────────────────────────────────┤
│          │  Agent 流水线：[✓搜索] [✓采集] [●解析] [○清洗]    │
│  任务列表 │  ┌────────────────────┬─────────────────────────┐  │
│          │  │  数据预览 (表格)    │  数据血缘图 (ReactFlow) │  │
│  ● 任务1 │  │                    │                         │  │
│  ○ 任务2 │  │  点击行查看血缘详情 │  点击节点查看处理步骤   │  │
│          │  └────────────────────┴─────────────────────────┘  │
│  数据源   │  ┌──────────────────────────────────────────────┐  │
│  ⊙ PubMed│  │ 反馈面板：[⚠ 3条低置信度] [⚠ 1个冲突待解决]  │  │
│  ⊙ GEO   │  └──────────────────────────────────────────────┘  │
│  ⊙ STRING│                                                    │
│  ⊙ TCMSP │                                                    │
├──────────┴───────────────────────────────────────────────────┤
│  总记录: 1850 | 平均置信度: 0.89 | 数据源: 12 个              │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、可扩展性设计

系统在以下维度设计了注册机制，扩展无需修改核心代码：

| 扩展点 | 基类 | 扩展方式 | 示例 |
|--------|------|---------|------|
| **新增 Agent** | BaseAgent | 继承 → 实现 execute() → @register | CitationAgent（引用网络） |
| **新增数据源** | BaseDataSource | 继承 → 实现 search()/fetch_*() | CNKI, ChEMBL |
| **新增爬虫** | BaseCrawler | 继承 → 实现 search_and_extract() | kegg_crawler |
| **新增处理器** | BaseProcessor | 继承 → 实现 process() | HDF5 解析器 |
| **新增分析模板** | BaseAnalysis | 继承 → 实现 generate_script()/execute() | 蛋白质组学分析 |
| **新增校验规则** | BaseValidator | 继承 → 实现 validate() | 天文坐标校验 |
| **新增领域模板** | YAML 配置 | 在 config/domain_templates/ 添加 | 生物医学、中医药 |

**领域模板示例**：

```yaml
# config/domain_templates/tcm.yaml
name: 中医药现代化
datasources:
  - name: tcmsp
    priority: 1
    config: { requires_crawl: true }
  - name: string_db
    priority: 3
  - name: kegg
    priority: 4
field_mappings:
  - unified: "compound_name"
    aliases: ["MolName", "Ingredient", "化合物"]
  - unified: "target_protein"
    aliases: ["Target", "Protein Target", "靶点"]
  - unified: "ob_value"
    aliases: ["OB", "Oral Bioavailability"]
```

---

## 五、端到端数据流示例

以"分析健脾散结方对胰腺癌肝转移的影响"为例：

```
T0  用户      输入"分析健脾散结方对胰腺癌肝转移的影响"
T1  Orchestrator 识别领域=中医药/肿瘤学，规划流水线
T2  Search      PubMed→18篇论文, GEO→6个数据集, STRING→PPI网络
                标记 8 个 requires_crawl 数据源
T3  Acquire     TCMSP爬取→127个中药成分, STRING爬取→2000+节点PPI网络
T4  Parser      PDF解析+GEO SOFT解析+STRING网络解析 → ~2200条记录
T5  Cleaner     去重180条, 基因ID统一, 8种字段别名对齐 → ~1850条
T6  Analysis    DESeq2差异表达 + GO/KEGG富集 + PPI网络分析
T7  Reviewer    一致性评分0.89, 标记34条低置信度, 验证爬虫正确性
T8  输出        CSV(1850×12字段, 每条附来源/置信度) + 分析报告 + 血缘图
T9  前端        展示数据表格 + 火山图 + 通路气泡图 + 反馈面板
```

---

## 六、赛题评分对应

| 评分维度 | 实现方案 |
|---------|---------|
| **数据查找完备性** | Search Agent(API) + Acquire Agent(爬虫) + 领域模板 |
| **来源可追溯性** | Provenance Tracker + 血缘图 + CSV来源列 |
| **清洗整合可靠性** | Cleaner Agent + 字段对齐 + 置信度评估 |
| **输出格式可用性** | 标准化CSV + 字段说明 + 来源清单 + API导出 |

| 加分项 | 实现方案 |
|--------|---------|
| 自动识别缺失/重复/单位不一致 | Cleaner 质量检测 + 置信度评分 |
| 自动识别图表解析错误 | Reviewer 图表审查维度 |
| 修正或寻求人类建议后修正 | 人在回路 + Feedback API + WebSocket |

---

## 七、技术选型

**后端核心**：

| 包 | 用途 |
|---|------|
| `fastapi` + `uvicorn` | Web 框架 |
| `openai` | DashScope（阿里云百炼 OpenAI 兼容模式）|
| `httpx` | 异步 HTTP |
| `pandas` + `numpy` + `scipy` | 数据处理 |
| `pdfplumber` | PDF 表格提取 |
| `beautifulsoup4` + `lxml` | HTML/XML 解析 |
| `aiosqlite` | 任务存储（SQLite） |
| `websockets` | 实时推送 |
| `python-multipart` | 文件上传 |
| `pydantic` | 数据校验 |

> **存储层精简**：使用 SQLite + 本地文件系统 + 内存缓存，不引入 Redis / Milvus / Qdrant。

**前端核心**：

| 包 | 用途 |
|---|------|
| `react` + `vite` + `typescript` | Web 应用（浏览器直访问，Electron 可选） |
| `antd` | UI 组件库 |
| `echarts` | 图表可视化（火山图/富集气泡/热图/网络图） |
| `@xyflow/react` | 数据血缘图 |
| `tailwindcss` | 样式 |

**数据获取与文档理解**：

| 能力 | 实现方式 |
|------|---------|
| 论文检索 | PubMed + OpenAlex + Semantic Scholar |
| 基因/蛋白/化合物 | GEO / STRING / KEGG / PDB / TCMSP / PubChem / DisGeNET / OpenTargets |
| 临床数据 | ClinicalTrials.gov + TCGA/GDC |
| PDF 表格提取 | pdfplumber（结构化表格）+ qwen-long（全文理解）|
| 图表数据提取 | qwen-vl-max（多模态识图，base64 data URL 传入）|
| 网页采集 | httpx + BeautifulSoup（静态）/ Playwright（动态，可选）|

> **不生成 PPT / DOC**：项目输出为 HTML 报告 + 前端页面展示 + CSV/Excel 结构化数据。

---

## 八、开发优先级

```
Phase 1 (第1-2周) — 核心骨架
├─ [P0] FastAPI 骨架 + API 路由
├─ [P0] BaseAgent / BaseTool 抽象基类 + Registry
├─ [P0] QwenClient 封装
├─ [P0] Orchestrator 基本流水线
├─ [P0] 任务状态管理
└─ [P0] Electron + React 骨架 + 任务创建页

Phase 2 (第3-4周) — 数据查找、采集与解析
├─ [P0] Search Agent + PubMed, GEO, STRING, NCBI
├─ [P0] Acquire Agent + TCMSP, STRING 爬虫 + Playwright
├─ [P0] Parser Agent + MinerU PDF + GEO SOFT 解析
├─ [P1] Qwen 图表数据提取
├─ [P1] Provenance Tracker
└─ [P1] 前端数据预览表格

Phase 3 (第5-6周) — 清洗、分析与质量
├─ [P0] Cleaner Agent + 生物医学字段对齐
├─ [P0] Reviewer Agent
├─ [P1] Analysis Agent + 差异表达/富集分析模板
├─ [P1] 置信度评估 + 冲突检测 + 人在回路
└─ [P1] 前端反馈修正界面

Phase 4 (第7-8周) — 完善与打磨
├─ [P0] CSV 导出（带来源标注）
├─ [P0] 数据血缘图前端
├─ [P1] 更多爬虫 + 动态生成能力
├─ [P1] 更多分析模板 + 可视化
├─ [P2] 领域模板（中医药配置）
└─ [P2] 演示视频
```

> P0 = 必须完成 | P1 = 应该完成 | P2 = 锦上添花
