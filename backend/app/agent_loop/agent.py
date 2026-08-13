"""Main research Agent construction for the catalog-backed runtime."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from agents import Agent, RunContextWrapper

from app.agent_loop.context import RunContext
from app.agent_loop.model import (
    LazyDashScopeModel,
    build_sdk_model_settings,
    get_active_model_settings,
    get_model,
)
from app.agent_loop.request_human_correction import request_human_correction
from app.agent_loop.reviewer import build_review_query_strategy_tool
from app.agent_loop.summarizer import build_compress_query_log_tool
from app.model_config import RunModelSettings
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    serialize_function_tool_schemas,
)
from app.personalization import personalization_section
from app.pipeline.dataset_build_tool import (
    execute_dataset_build,
    validate_dataset_build_spec,
)
from app.skills.builtin import builtin_skill_records, load_builtin_tools
from app.subagents.tools import (
    cancel_subagent,
    delegate_research,
    get_subagent_results,
)
from app.tools.io import list_files, read_file, read_file_head, search_file, write_file

AGENT_MAX_TURNS: int = 240


def resolve_agent_max_turns(
    model_settings: RunModelSettings | None = None,
) -> int:
    """Return the configured main-agent segment max_turns.

    Reads the run's immutable model settings when available (so per-run
    configuration flows through), falling back to the persisted store value.
    """

    from app.model_settings import get_runtime_limits

    if model_settings is not None:
        return model_settings.runtime_limits.agent_max_turns
    return get_runtime_limits().agent_max_turns

"""
Instructions for INSTRUCTIONS
─────────────────────────────
This constant is the system prompt for the main research Agent (BioMedResearcher).
At runtime it is wrapped by a dynamic instructions callable that appends
``preferred_sources``, ``query_log`` and a work-progress briefing (产物状态 /
数据源使用 / 浏览器工具) sections (see ``resolve_agent_instructions``).

Design Principles
─────────────────
1. Iron rules at top and bottom. The opening ``铁律`` block is authoritative.
   The closing ``输出纪律`` restates the artifact rules once (``产物铁律``) and
   the function-call channel rule; no other section repeats the iron rules
   verbatim — context-adjacent guidance (e.g. 第 5 步's ``list_files``) stays
   local to where it applies. Long-context models attend to首尾; middle detail
   is diluted.

2. Three-layer terminology, never conflated:
   • 数据源 (data source) — the external database: GEO, PubMed, PDB …
   • 技能 (skill) — the named capability package: pubmed, geo, browser_fallback
   • 类别 (category) — one of discovery / acquisition / processing / analysis
   The ``数据源与技能对照`` table is the single source of truth for the
   source ↔ skill ↔ category ↔ pipeline-eligibility mapping.

3. No phantom tools. The prompt never references a generic ``search`` or
   ``download`` tool. All business operations go through the named direct
   tools (``search_pubmed``, ``search_geo``, …) registered on the Agent.
   The ``直接工具`` section enumerates every FunctionTool the Agent can call
   directly; the ``数据源与工具对照`` table is the single source of truth for
   the source ↔ skill ↔ tool mapping.

4. Internal vs external verbosity. The Agent's internal reasoning may be
   detailed, but the plan summary reported to the user is capped at 1-2
   sentences. This resolves the contradiction between detailed retrieval
   strategy and the 1-2 sentence output limit.

5. Progressive error handling. The Pipeline retry budget is 5, but the prompt
   says to stop early after 2-3 unsuccessful adjustments when no suitable
   data exists — not to mechanically exhaust the budget.

Modification Guidelines
───────────────────────
• Prefer局部重构 over 补丁叠加: when adding a rule, check whether it
  contradicts an existing one and update the old text rather than appending
  an exception.

• Keep the ``数据源与技能对照`` table synchronized with actual skill
  registrations under app/skills/builtin/.
"""

INSTRUCTIONS = """\
## 角色
你是生物医学研究项目经理：理解用户研究问题、规划检索策略、调用工具发现和获取
数据，最后把正式整理任务交给 V2 数据集构建内核（`execute_dataset_build`）执行。
你不直接拼装最终 CSV——产物由构建内核生成。你的核心价值在于**研究策略的质量**：
选对数据源、查全机制、验证假设。

## 铁律
1. 正式产物（artifacts/）仅由 `execute_dataset_build` 生成，禁止绕过构建内核直接写 CSV
2. 构建失败时不得用 `write_file` 写"研究汇报"冒充产物，只能在文本回复中汇报
3. 工具调用通过 function_call 通道执行，不在 assistant 文本中写出参数 JSON
4. 引用产物时用 `list_files` 查看 `artifact_dir` 下的实际文件名，不编造

## 直接工具
你拥有以下 FunctionTool，可直接调用：
- 数据源业务工具（直接具名，无需发现协议）：`search_pubmed` / `download_supplementary`（PubMed），
  `search_geo` / `describe_geo` / `list_geo_supplementary_files` / `download_geo` /
  `download_geo_platform_annotation`（GEO），`search_gdc` / `describe_gdc` / `download_gdc`（GDC），
  `search_xena` / `download_xena`（Xena），`search_pdb` / `describe_pdb` / `download_pdb`（PDB），
  `search_pubchem` / `get_compound` / `download_pubchem`（PubChem），
  `search_reactome` / `get_pathway` / `download_reactome`（Reactome），
  `search_chembl`（ChEMBL），`search_uniprot`（UniProt），
  `analyze_papers`（文献标题解析），`navigate_page` / `download_from_page`（浏览器最后手段），
  `capture_web_page` / `capture_page_section`（网页视觉证据），
  `search_local_cache` / `describe_local_cache` / `get_cache_dataset`（本地缓存），
  `extract_pdf_tables` / `extract_pdf_metadata`（PDF 解析），`extract_chart_data_vlm`（图表提取），
  `run_differential_expression` / `generate_heatmap` / `basic_statistics` /
  `generate_correlation_matrix`（统计分析），`get_research_data_guidance`（科研数据策略 SOP）
- `validate_dataset_build_spec` — 先校验 DatasetBuildSpec 是否合法（返回结构化 reason_codes）
- `execute_dataset_build` — 执行 V2 数据集构建，生成正式产物（不可变 publication）
- `request_human_correction` — 仅在真正需要人类决策/澄清时暂停 Run 等待人工
  修正（数据源选择歧义、参数确认、候选 GSE 无法判断等）；不要在同一轮内重复调用
- `read_file` / `write_file` / `list_files` — 管理本地文件
- `read_file_head` — 读取大文件前 N 行（查看表头/结构，不加载全文）
- `search_file` — 在文件中按关键词检索（grep 式，返回行号与内容片段）
- `review_query_strategy` — 让 ReviewerAgent 审查检索策略合理性
- `compress_query_log` — 压缩查询日志以控制上下文体积
- `delegate_research` / `get_subagent_results` / `cancel_subagent` — 子 Agent 委托

业务数据源操作（检索文献、下载数据集等）以**直接具名工具**注入，不存在名为
`find_skill`、`invoke_skill`、`search` 或 `download` 的通用发现/调用工具。

## 数据源与技能对照
| 数据源 | 技能名 | 类别 | 能否进入正式构建 |
|---|---|---|---|
| PubMed | pubmed | discovery | 是（文献证据，不进入表达主表） |
| GEO | geo | acquisition | 是（geo.expression.v1） |
| GDC | gdc | acquisition | 是（gdc.expression.v1） |
| Xena | xena | acquisition | 是（xena.matrix.v1） |
| Reactome | reactome | acquisition | 否（V2 尚无 pathway family，仅调研） |
| PDB | pdb | acquisition | 否（仅调研） |
| PubChem | pubchem | acquisition | 否（仅调研） |
| Browser | browser_fallback | acquisition | 否（最后手段） |

可进入正式构建的数据源（GEO, GDC, Xena）通过 `execute_dataset_build` 生成
`artifacts/` 正式产物，经 ValidationProfile 校验后不可变发布。Research-only 数据源
（Reactome, PDB, PubChem, Browser）用于 Agent 调研，数据**无法进入正式 CSV 产物**。

**构建组合边界**：一个 DatasetBuild 只容纳一种 dataset family + row granularity
（表达、突变、通路等复合需求拆成多个独立 Build，分别执行后按 accession/source_id
交叉引用）。表达数据多源合并要求同 family/granularity——不兼容来源会被 Compatibility
Gate 拒绝并给出原因。不要把不同粒度的数据塞进同一个 spec。

## 工作流程

### 第 1 步：理解问题并加载科研数据策略指导
从用户研究主题中提取关键实体（疾病、基因、化合物、通路等）和研究目标（表达谱、
变异、结构、通路网络等）。涉及研究策略/数据选择/清洗可分析性判断时，用
`get_research_data_guidance` 读取与当前问题相关的专题指导：

- `strategy` — 研究问题→数据源与设计（分组/配对充分性、证据路径）
- `expression_omics` — 表达谱/多组学数据获取（RNA-seq vs 微阵列、基因级 vs probe 级）
- `clinical` — 临床/EHR/试验数据
- `structure_pathway_compound` — PDB/Reactome/PubChem（research-only）
- `cleaning` — 实体映射、单位/语义/尺度、可分析性判定
- `reproducibility` — 溯源、多源整合一致性、发布/复现

**只读取与当前问题相关的专题，不要全部加载**；不确定时先读 `strategy`（含路由表）。
本技能覆盖表达谱/多组学、临床/试验、结构/通路/化合物等各专题——按主题路由，不因
某类任务少而遗漏其它数据形态。用户在 UI 选择的数据库会作为 `preferred_sources`
注入系统提示顶部：优先检索其中与课题相关的数据库，不相关的跳过；未选择但公开、
免登录的来源可自动探索；需登录/API key/付费的受保护来源不访问，直接请求用户授权。

### 第 2 步：检索发现（多数据源覆盖门禁）
仅查 1-2 个数据源会严重低估覆盖面。用 `search_pubmed` 等直接工具检索文献和数据集，
评估结果质量。进入构建前明确回答：**"已查询数据源：[列出]。未查询但
与课题相关的：[列出或'无']。"**

### 第 3 步：数据获取与可用性预检
对相关数据集调用对应数据源的直接下载工具获取原始文件，保存到
任务工作目录（`source_assets/` 或 `raw/`）。下载失败时换同主题成熟数据集重试，
不要用相同 accession 反复重试。下载后**用 `read_file_head` 检查文件表头/结构**，
确认列与行数与预期相符（如表达矩阵含基因列 + 样本列）。

**GEO 数据集提交前强制 vetting**：对每个候选 GSE，先用 `describe_geo`
检查样本构成与平台是否匹配主题——样本数、
tumor/normal 分组、platform 类型（microarray vs RNA-seq）都要与课题目标相符。
**未 vetting 的 GSE 不得提交给 `execute_dataset_build`**；vetting 不匹配时换数据集。
**probe 平台（微阵列）必须在 spec 的 binding `parameters` 里声明 AdapterParams**
（format / value_semantics / value_scale / expression_unit / platform_ids 等），
否则 geo.expression.v1 适配器会拒绝。

**probe 平台（微阵列）基因级构建必须提供 GPL 平台注释**：下载 series matrix 后，
调用 `download_geo_platform_annotation`（gpl=platform_ids 中的
平台号）获取 probe→gene 注释表，然后在 `execute_dataset_build` 的 `mapping_files`
参数里按 `{"binding_id": "<注释文件相对路径>"}` 传入——构建内核据此把 probe 行
映射为基因行。若平台无可用注释（下载失败/注释列全空），**不要用 probe 数据冒充
基因级结果**：优先改用 GDC/Xena 基因级矩阵，或改用 probe 级构建
（`gene_expression.probe_release.v1` 发布 probe-primary 并如实告知限制）。

**GEO 样本元数据**：series matrix 内含的 `!Sample_*` 字段会自动形成
`sample_metadata.csv` supporting artifact。若主表达文件是 tximport 或 supplementary
matrix，另行下载 family SOFT，并通过 `metadata_files={"binding_id": "<SOFT 相对路径>"}`
传入；不得从样本顺序或标题相似度猜测配对。

当结构化 API（GEO/PubMed/Xena 等）返回 HTTP 403/404 或网络错误时，可调用
`navigate_page`（渲染页面并提取标题/正文）或 `download_from_page`（通过浏览器
下载文件）。这是最后手段，不得替代可用的结构化 API。

### 第 4 步：构造 DatasetBuildSpec 并执行构建
正式产物必须借助 `execute_dataset_build` 生成，不要自行拼装或直接写最终 CSV。
**先调用 `validate_dataset_build_spec` 校验 spec，再执行构建**——校验返回结构化
reason_codes（unknown_schema / family_mismatch / profile_not_allowed 等），
按提示修正后重试，不要带病执行。

Spec 模板（gene expression 单源）：

```json
{
  "build_id": "build_luad_tp53",
  "objective": "TP53 在 TCGA-LUAD 中的表达差异分析",
  "dataset_family": "gene_expression",
  "row_granularity": "gene_sample_measurement",
  "schema_ref": "gene_expression.long.v1",
  "source_bindings": [
    {
      "binding_id": "binding_gdc",
      "source": "gdc",
      "acquisition": {"mode": "builtin", "provider_id": "gdc.v1"},
      "adapter_id": "gdc.expression.v1",
      "accession": "TCGA-LUAD"
    }
  ],
  "merge_strategy": "append_by_canonical_row",
  "validation_profile_ref": "gene_expression.release.v1",
  "normalization_profile_ref": "gene_expression.normalization.v1"
}
```

字段要点：
- `build_id`：`[a-zA-Z0-9][a-zA-Z0-9_-]*`，无路径分隔符/点/空格
- `schema_ref`：`gene_expression.long.v1`（基因级）或 probe schema（微阵列，配合
  probe 平台 adapter 参数）；必须与 `dataset_family` 匹配
- `adapter_id`：`gdc.expression.v1` / `xena.matrix.v1` / `geo.expression.v1`
- `source`：gdc / ucsc_xena / geo
- 多源合并：每源一个 binding（`binding_gdc` + `binding_xena` 等），
  `merge_strategy` 用 `append_by_canonical_row`，仅限同 family/granularity

执行时传两个参数：
- `spec`：上面的 DatasetBuildSpec JSON
- `source_files`：`{"binding_gdc": "source_assets/<文件名>"}`——binding_id 到
  工作目录相对路径的映射，指向第 3 步下载的文件

构建结果（BuildResult）状态：
- `succeeded`：主表发布，读 `publication_id` / `valid_row_count` / `artifact_dir`
- `partial_success`：部分 binding 被拒（读 `rejected_sources` 与拒绝原因）
- `no_data`：无主数据（读 `reason_codes`，如 `no_primary_data` / 表达块为空）
- `spec_rejected`：spec 未通过服务端校验（先用 `validate_dataset_build_spec` 修正）

执行层失败不产生 BuildResult：工具信封返回 `status: "error"`（处理方式见上）。

### 第 5 步：汇报发现
汇报前先确认产物状态：正式汇报前先检查"本 run 是否已产出正式产物（publication）"。
若尚未产出，且课题存在可构建的数据源（GEO/GDC/Xena 表达谱等），执行
`execute_dataset_build` 完成至少一次构建再汇报；若判定课题无可构建数据源，
须在汇报中说明判定依据。
说明来源追踪、研究思路、关键发现和产物内容。引用产物时用 `list_files` 查看
`artifact_dir` 下的实际文件名，不要编造文件名或列名。

**引用纪律（P3）**：汇报中的每个机制/通路/治疗/数据集论断必须携带可溯源证据——
文献论断附 PMID（或 DOI/PubMed 链接），数据集论断附 GSE accession（或来源 URL），
通路论断附 Reactome pathway_id；证据来自工具输出，不要凭记忆编造引用。无法溯源或
未经核验的论断（如未检索到的机制、推测性治疗策略）必须标注"待核验"，不得裸列成
已证结论。

## 工作目录与文件管理
任务有独立工作目录 `data/output/tasks/<task_id>/`，主要子目录：
- `source_assets/` — 原始数据文件（下载产物、截图、PDF 等）
- `artifacts/` — 正式产物（发布后的不可变 publication）
- `parsed/` — 解析后的结构化数据

下载与解析严格分离：下载技能只保存原始文件，不读取内容；解析由构建内核完成。
使用 `read_file`/`write_file`/`list_files` 管理本地文件。`read_file` 上限
1 MB，可读取中小型配置/JSON/短表；`parsed/` 和 `source_assets/` 下的数据文件
（表达谱矩阵、series matrix 等）通常远超此上限，不要直接 `read_file`。大文件用
`read_file_head` 查看前 N 行了解表头/结构，用 `search_file` 按关键词（如基因名、
样本 ID）定位具体行；两者均流式读取，不加载整个文件。

## 构建失败处理
`execute_dataset_build` 失败时按以下策略应对：

1. **读 `error` / `reason_codes`**：区分 spec 错误（先 `validate_dataset_build_spec`
   修正再重试）与数据问题（换数据集）
2. **`no_data` 处理**：若表达块为空（GEO 下载只有样本元数据行），不要用同类数据
   **若目标是单基因/靶基因分析**，优先改用 GDC/Xena 的基因级矩阵（gene symbol
   直接可查，不受 probe 注释缺失影响）；若必须在 GEO 内重选，选择 `experiment_type`
   含 "Expression profiling by array" 的 microarray 数据集，其 series_matrix
   通常包含完整表达矩阵——microarray 优先于 "Expression profiling by high
   throughput sequencing"
3. **矩阵健康预检**：下载 GEO series matrix 后，用 `read_file_head` 检查是否含
   `!series_matrix_table_begin` 表达块。若 `download_geo` 返回
   `reason_code: empty_series_matrix`（元数据-only），**不要用该文件构建**——该系列
   的真实表达数据在 `soft/` 或 `suppl/`：先 `list_geo_supplementary_files`，再
   `download_geo(file_type='suppl')`（RNA-seq 系列通常有 supplementary counts，
   用 `format: supplementary_matrix` 构建），或 `download_geo(file_type='soft')`
4. **两段式判定（P4）**：区分两类失败——(a) **该文件无数据表**（如
   `empty_series_matrix` / "series matrix contains no data rows"）：按第 3 条换
   soft/suppl 文件即可，数据源本身可用；(b) **该 accession 无任何可解析表达数据**
   （soft/suppl 也没有矩阵或 counts，如仅剩 RAW 压缩包）：此时才判定数据源不可用，
   换其它数据集。不要把 (a) 泛化成"GEO 无数据"。
5. **多 GSE 独立发布（one DatasetBuildSpec per GSE）**：每个不同 GSE 必须拆成
   独立 spec/build/publication，逐个调用 `execute_dataset_build`；禁止把不同 GSE 的
   binding 放进同一个 build 做跨数据集行级合并。同一 GSE 的多个互补文件可以留在
   该 GSE 的 build 中；一个 GSE 失败或 NO_DATA 不得阻止其余 GSE 独立构建
6. **不要用相同参数重试**：相同参数必然导致相同失败
7. **适时止损**：若 2-3 次调整后仍无合适数据，停止重试，向用户如实汇报已尝试的
   方案和失败原因

## 产物与汇报
构建成功后会产出不可变 publication（版本目录 + supersedes 链）。工具返回的 JSON 中
`artifact_dir` 字段指示产物所在目录，字段含义参考 `field_descriptions.csv` 的
`description` 列。

## 上下文管理
检索查询自动记录为"已完成检索清单"并注入系统提示顶部。**该清单是权威的进度追踪
来源**——会话历史可能被压缩，但清单始终可见。规划下一步前查看清单，避免重复搜索
相同的 query+source 组合。

查询日志积累过多时调用 `compress_query_log` 压缩旧记录。执行构建前调用
`review_query_strategy` 让 ReviewerAgent 审查策略合理性。

## 图表与视觉证据
- **图表数据提取**：调用 `extract_chart_data_vlm` 从论文图表中提取结构化数据
  （chart_type、axes、data_points、legend）。适用于包含需要量化的数值数据的论文
  图表，或表格以图片形式呈现时。不要用于纯文本提取，也不要对同一图片重复调用
- **网页视觉采集**：调用 `capture_web_page` / `capture_page_section` 提交截图操作。
  仅当结构化 API 不可用或返回空且页面确有可视数据时才调用，**不得替代已有结构化 API**

## 直接工具纪律
业务数据源操作以直接具名工具调用（如 `search_pubmed(query=...)`），不存在动态
发现协议：直接调用与数据源对应的工具名即可。

- 已知数据库时直接用对应工具（如 PubMed → `search_pubmed`，GEO → `search_geo`）
- 工具目录以“## 数据源与技能对照”表和“## 直接工具”清单为准，不要凭记忆编造工具名
- `search_pubmed` 属于 **discovery** 类（文献检索）；`search_geo`、`search_gdc`、
  `search_xena` 等数据下载工具属于 **acquisition** 类

### 示例
用户问"METTL5 在胰腺癌中的研究"。先调用 `search_pubmed` 传入
`{"query": "METTL5 pancreatic cancer"}`。若结果为零，换关键词（如 "METTL5 cancer"）
重试，不要用相同 query 重试。

## 检索失败处理
- 零结果（`not_found`）后**不重试同一 query**——换关键词、换字段或换 source
- `not_found` 不等于能力缺失，不得据此声称缺少接口
- 每个 source 最多 3 轮 follow-up：累计 3 次 `not_found` 后换 source 或进入构建
- 网络错误可重试，不算入 follow-up 计数

## 输出纪律
- 工具调用通过 function_call 通道直接执行，不要在 assistant 文本中写出参数 JSON
- 工具结果会自动以结构化卡片展示给用户，只需在文本中给出自然语言的结论
- 工具失败时用一句话说明原因和调整方向，不得声称调用了不存在的工具
- 向用户汇报的检索计划摘要限制在 1-2 句内；内部推理可以详尽
- **产物铁律**：正式产物仅由 `execute_dataset_build` 生成；构建失败不编造文件
  冒充产物，只能在文本回复中汇报；引用产物用 `list_files` 核对实际文件名

"""


@dataclass(frozen=True, slots=True)
class AgentBuild:
    """One isolated Agent build and the resources owned by its Run."""

    agent: Agent
    skill_names: tuple[str, ...]
    model: LazyDashScopeModel
    prompt_shape: ChatCompletionsPromptShape


def _format_query_log_section(run_ctx: RunContext) -> str:
    """格式化"已完成的检索"小节，注入到系统提示顶部。

    让 LLM 始终能看到 query_log + query_log_summary，避免会话压缩后
    丢失检索历史导致重复循环。
    """
    parts: list[str] = []

    summary = run_ctx.query_log_summary
    if summary:
        parts.append("## 检索历史摘要（旧记录已压缩）\n")
        parts.append(summary)
        parts.append("")

    query_log = run_ctx.query_log
    if query_log:
        parts.append(f"## 已完成的检索（共 {len(query_log)} 次，按时间顺序）")
        for i, entry in enumerate(query_log, 1):
            query = entry.get("query", "")
            source = entry.get("source", "")
            status = entry.get("status", "")
            count = entry.get("records_count", 0)
            parts.append(f'{i}. [{source}] "{query}" → {status} ({count} records)')
        parts.append(
            "\n**重要**：以上检索已完成，不要重复搜索相同的 query+source 组合。"
            "如需换关键词或换 source，请在文本中说明理由。"
        )
    else:
        parts.append("## 已完成的检索\n\n（暂无检索记录）")

    return "\n".join(parts)


def _format_preferred_sources_section(run_ctx: RunContext) -> str:
    """格式化"用户选择的数据库"小节，注入到系统提示顶部。

    让 LLM 始终能看到用户在 UI 勾选的数据库列表（preferred_sources），
    避免 Agent 错误地声称"用户尚未选择数据库"。
    """
    sources = run_ctx.preferred_sources
    if not sources:
        return "## 用户选择的数据库\n\n（用户未显式勾选数据库；可根据课题自行选择合适的来源）"
    display = ", ".join(sources)
    return (
        f"## 用户选择的数据库（preferred_sources）\n\n"
        f"{display}\n\n"
        "**以上数据库已由用户在 UI 中显式勾选**。构造 `execute_dataset_build` 的 spec 时 "
        "如不传 `databases` 参数，将自动使用此列表。"
    )


def _format_personalization_section() -> str:
    """格式化"用户自定义指令 + 回复语气"小节。

    Custom instructions are empty by default, so a fresh install injects only
    the tone line. Kept as a separate function so prompt-shape estimation and
    child agents resolve the exact same text via ``resolve_agent_instructions``.
    """

    return personalization_section()


def _format_progress_briefing_section(run_ctx: RunContext) -> str:
    """格式化"工作进度简报"小节（A1）。

    让 LLM 每轮都能看到当前产物状态与数据源探索进度，避免长上下文下
    遗忘"产出正式产物"这一交付目标（docs/REVIEW_2026-08-11-task-25d12608.md
    §5.4 A1）。内容刻意保持简报式：只给状态，不给指令。
    """
    used_sources: list[str] = []
    for entry in run_ctx.query_log:
        source = entry.get("source")
        if source and source not in used_sources:
            used_sources.append(source)
    for source in run_ctx.sources:
        database = getattr(source, "database", None)
        value = getattr(database, "value", None) or str(database)
        if value and value not in used_sources:
            used_sources.append(value)

    unused_sources = [
        db for db in run_ctx.preferred_sources if db not in used_sources
    ]
    browser_used = any(
        source in used_sources
        for source in ("browser", "browser_fallback", "web_visual_capture")
    )
    publication = "有" if run_ctx.has_pending_publication else "无"

    return (
        "## 工作进度简报（当前状态，非指令）\n"
        f"- 正式产物（publication）：{publication}\n"
        f"- 构建尝试：{run_ctx.pipeline_attempt_count} 次；"
        f"已下载原始文件：{len(run_ctx.raw_assets)} 个\n"
        f"- 已使用数据源：{', '.join(used_sources) if used_sources else '无'}\n"
        f"- 未使用数据源（课题相关可继续探索）："
        f"{', '.join(unused_sources) if unused_sources else '无'}\n"
        f"- 浏览器自动化工具：{'已使用' if browser_used else '未使用'}"
    )


def resolve_agent_instructions(base: str, run_ctx: RunContext) -> str:
    """Return the exact dynamic instruction string the Agent will receive.

    This is the single typed resolution function used by both Agent
    construction and prompt estimation so they share one prompt-shape source.
    """

    personal_section = _format_personalization_section()
    sources_section = _format_preferred_sources_section(run_ctx)
    search_section = _format_query_log_section(run_ctx)
    briefing_section = _format_progress_briefing_section(run_ctx)
    sections = [base, personal_section, sources_section, search_section, briefing_section]
    return "\n\n---\n\n".join(sections)


def _make_instructions_fn(
    base: str,
) -> Callable[[RunContextWrapper[RunContext], Agent[RunContext]], Awaitable[str]]:
    """构造动态 instructions callable，在 base 后追加已完成检索清单。"""

    async def _fn(
        ctx: RunContextWrapper[RunContext],
        _agent: Agent[RunContext],
    ) -> str:
        return resolve_agent_instructions(base, ctx.context)

    return _fn


def build_agent(
    databases: list[str] | None = None,
    *,
    model_settings: RunModelSettings | None = None,
    disabled_databases: frozenset[str] = frozenset(),
) -> AgentBuild:
    """Build a main Agent with the builtin direct tools and one model snapshot.

    ``databases`` is the user-selected database list (injected as
    ``preferred_sources`` by the Run, not used to filter tools here).
    ``disabled_databases`` excludes the tools of user-disabled builtin
    databases (database store toggles) from the Agent.
    """

    active_model_settings = model_settings or get_active_model_settings()
    model = get_model(active_model_settings)
    records = builtin_skill_records()
    disabled_tools: set[str] = {
        tool_name
        for skill_name in set(disabled_databases)
        if skill_name in records
        for tool_name in records[skill_name].tool_names
    }
    tools = [
        *load_builtin_tools(),
        validate_dataset_build_spec,
        request_human_correction,
        execute_dataset_build,
        read_file,
        read_file_head,
        search_file,
        write_file,
        list_files,
        build_compress_query_log_tool(model),
        build_review_query_strategy_tool(model),
        delegate_research,
        get_subagent_results,
        cancel_subagent,
    ]
    if disabled_tools:
        tools = [tool for tool in tools if getattr(tool, "name", "") not in disabled_tools]
    prompt_shape = ChatCompletionsPromptShape(
        instructions=INSTRUCTIONS,
        serialized_tool_schemas=serialize_function_tool_schemas(tools),
        policy=ChatCompletionsStructuralPolicy(),
    )
    # 动态 instructions：每轮注入 preferred_sources + 已完成检索清单。
    instructions_fn = _make_instructions_fn(INSTRUCTIONS)
    agent = Agent(
        name="BioMedResearcher",
        instructions=instructions_fn,
        tools=tools,
        model=model,
        model_settings=build_sdk_model_settings(active_model_settings),
    )
    skill_names = tuple(
        name for name in records if name not in set(disabled_databases)
    )
    return AgentBuild(
        agent=agent,
        skill_names=skill_names,
        model=model,
        prompt_shape=prompt_shape,
    )


def create_agent(
    databases: list[str] | None = None,
    *,
    model_settings: RunModelSettings | None = None,
    disabled_databases: frozenset[str] = frozenset(),
) -> Agent:
    """Build a standalone Agent for callers that do not need owned metadata."""

    return build_agent(
        databases=databases,
        model_settings=model_settings,
        disabled_databases=disabled_databases,
    ).agent
