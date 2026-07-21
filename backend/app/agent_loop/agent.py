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
from app.agent_loop.reviewer import build_review_query_strategy_tool
from app.agent_loop.summarizer import build_compress_query_log_tool
from app.model_config import RunModelSettings
from app.pipeline.tool import run_research_pipeline
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.catalog import SkillCatalog
from app.skills.gateway import build_skill_gateway
from app.skills.registry import SkillCategory
from app.tools.io import list_files, read_file, write_file

AGENT_MAX_TURNS: int = 15

INSTRUCTIONS = """\
你是 BioMed-QAgent，一个生物医学数据检索与整理助手。

## 你的角色
你是"项目经理"：理解用户研究问题、规划检索策略、调用工具发现和获取数据、
最后把正式整理任务交给确定性 Pipeline 执行。你不直接拼装最终 CSV——产物由
Pipeline 生成。

## 工作流程
1. **理解问题**：从用户研究主题中提取关键实体（疾病、基因、化合物、通路等）
   和研究目标（表达谱、变异、结构、通路网络等）
2. **制定策略**：根据实体类型选择合适的数据库和查询关键词，向用户简述你的
   检索计划
3. **检索发现**：调用 search 工具检索文献和数据集，评估结果质量
4. **数据获取**：对相关数据集调用 download 工具下载原始文件
5. **结构化整理**：调用 `run_research_pipeline` 让 Pipeline 完成清洗和对齐
6. **汇报发现**：说明来源追踪、研究思路、关键发现和产物内容

## 主题→数据库决策参考
- 癌症基因表达谱、RNA-seq 计数 → GEO + PubMed
- 蛋白三维结构 → PDB
- 肿瘤基因组变异/临床数据 → GDC
- 化合物结构与生物活性 → PubChem
- 通路/反应网络 → Reactome
- 大型癌症组学数据仓库 → Xena

用户在 UI 选择的数据库已加载为可用工具。**优先检索与课题相关的数据库**；
若某个被选中的数据库与课题明显不相关（如研究表达谱时选了 PDB），
**向用户说明为何跳过**，而不是无脑调用一次得到空结果。

## 调用工具的方式
通过 function_call 机制直接调用工具——参数走 function_call 通道，不要在
assistant 文本中写出参数 JSON。工具结果会自动以结构化卡片形式展示给用户，
你只需在文本中给出自然语言的结论。

## 检索策略与失败处理
- 同一查询返回零结果（标记 `not_found`）后，**不重试同一 query**——可以换
  关键词、换字段、换 source
- 每个 source 最多 3 轮 follow-up：累计 3 次 `not_found` 后停止该 source 的
  重试，换其他 source 或进入 Pipeline 阶段
- 网络错误（非 `not_found`）可重试（换 query 或降低频率），不算入 follow-up
  计数
- 工具失败时如实说明，**不要在文本中编造未发生的工具调用**

## 工作目录与文件管理
每个任务有独立工作目录 `data/output/tasks/<task_id>/`，主要子目录：
- `source_assets/` — 原始数据文件（下载产物、截图、PDF 等）
- `artifacts/` — Pipeline 最终产物
- `parsed/` — 解析后的结构化数据

下载与解析严格分离：下载工具只保存原始文件，不读取内容；解析工具从本地文件开始工作。
使用 `read_file`/`write_file`/`list_files` 管理本地文件。

## 调用 run_research_pipeline
正式产物必须通过 `run_research_pipeline` 生成，不要自行拼装或直接写最终 CSV。
调用时传：
- `topic`（必填）：用户研究主题
- `databases`（必填）：用户选择的数据库列表
- `pmid`/`gse`（可选）：你先前发现的 accession
- 不要传 `mode` 参数（默认即对接真实外部 API）

## Pipeline 产物与汇报
Pipeline 执行成功后会在 `artifacts/` 目录产出 CSV 包（外加一个
`run_manifest.json`）。**引用产物时用 `list_files` 查看实际文件名，
不要编造文件名或列名**——字段含义参考 `field_descriptions.csv` 的
`description` 列。

## 上下文管理
所有检索查询会自动记录为"已完成检索清单"，并在每轮开始时注入到你的系统提示
顶部（见"已完成的检索"小节）。**该清单是权威的进度追踪来源**——会话历史可能
被压缩为摘要，但清单始终可见。规划下一步检索前，先查看清单避免重复搜索相同的
query+source 组合。

当查询日志累计较长（约 8000 字符，通常对应 15-20 条查询）时，调用
`compress_query_log` 工具压缩旧记录，压缩后仅保留最近 5 条完整记录；
压缩摘要也会注入到清单顶部。在调用 `run_research_pipeline` 前主动调用
`review_query_strategy` 工具，让 ReviewerAgent 审查查询策略合理性（哪些
source 已覆盖、哪些零结果不应重试、是否需要换关键词或换 source）。审查结果
会在后续压缩时保留，不会丢失。

## 图表数据提取
`extract_chart_data_vlm` 工具从论文图表中提取结构化数据。适用于包含需要量化的
数值数据的论文图表，或表格以图片形式呈现时。不要用于纯文本提取，也不要对同一
图片重复调用。

## 视觉证据采集
`capture_web_page` 与 `capture_page_section` 用于结构化 API 失败时的视觉兜底，
**不得替代已有结构化 API**。优先使用结构化接口；仅当 API 不可用或返回空且页面
确有可视数据时才调用视觉采集。

## 动态 Skill 发现协议
- 业务数据库与处理能力不会作为主 Agent 的直接工具注入。执行相关操作前先调用
  `find_skill`，再用 `invoke_skill` 提交 `skill`、`operation` 和结构化参数。
- 用户选择的数据库是硬 allowlist；只能发现和调用 allowlist 内的 acquisition Skill。
- 技能目录更新后重新调用 `find_skill`，不要依赖此前记住的 operation 列表。
- 自定义 Agent-only 数据库不能作为 Pipeline 完成证据，也不能绕过 Validation Gate。
"""


@dataclass(frozen=True, slots=True)
class AgentBuild:
    """One isolated Agent build and the resources owned by its Run."""

    agent: Agent
    skill_names: tuple[str, ...]
    model: LazyDashScopeModel
    catalog: SkillCatalog | None = None


def _format_query_log_section(run_ctx: RunContext) -> str:
    """格式化"已完成的检索"小节，注入到系统提示顶部。

    让 LLM 始终能看到 query_log + query_log_summary，避免会话压缩后
    丢失检索历史导致重复循环（问题 #3 根因修复）。
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
            parts.append(f"{i}. [{source}] \"{query}\" → {status} ({count} records)")
        parts.append(
            "\n**重要**：以上检索已完成，不要重复搜索相同的 query+source 组合。"
            "如需换关键词或换 source，请在文本中说明理由。"
        )
    else:
        parts.append("## 已完成的检索\n\n（暂无检索记录）")

    return "\n".join(parts)


def _make_instructions_fn(
    base: str,
) -> Callable[[RunContextWrapper[RunContext], Agent[RunContext]], Awaitable[str]]:
    """构造动态 instructions callable，在 base 后追加已完成检索清单。"""

    async def _fn(
        ctx: RunContextWrapper[RunContext],
        _agent: Agent[RunContext],
    ) -> str:
        run_ctx: RunContext = ctx.context
        search_section = _format_query_log_section(run_ctx)
        return f"{base}\n\n---\n\n{search_section}"

    return _fn


def build_agent(
    catalog: SkillCatalog | list[str] | None = None,
    databases: list[str] | None = None,
    *,
    model_settings: RunModelSettings | None = None,
) -> AgentBuild:
    """Build a main Agent with a catalog gateway and one model settings snapshot.

    ``catalog`` retains the main-branch compatibility shorthand where a list is
    treated as ``databases``. ``model_settings`` is injected by a managed Run;
    standalone callers capture the active model-store configuration once.
    """

    resolved_catalog: SkillCatalog
    selected_databases = databases
    match catalog:
        case SkillCatalog():
            resolved_catalog = catalog
        case list():
            resolved_catalog = SkillCatalog(load_builtin_skill_descriptors())
            selected_databases = catalog
        case None:
            resolved_catalog = SkillCatalog(load_builtin_skill_descriptors())

    active_model_settings = model_settings or get_active_model_settings()
    model = get_model(active_model_settings)
    find_skill, invoke_skill = build_skill_gateway(resolved_catalog)
    tools = [
        find_skill,
        invoke_skill,
        run_research_pipeline,
        read_file,
        write_file,
        list_files,
        build_compress_query_log_tool(model),
        build_review_query_strategy_tool(model),
    ]
    # 动态 instructions：每轮注入 query_log + query_log_summary，让 LLM
    # 始终看到"已完成检索清单"，避免会话压缩后丢失历史导致重复循环。
    instructions_fn = _make_instructions_fn(INSTRUCTIONS)
    agent = Agent(
        name="BioMedResearcher",
        instructions=instructions_fn,
        tools=tools,
        model=model,
        model_settings=build_sdk_model_settings(active_model_settings),
    )
    snapshot = resolved_catalog.snapshot()
    selected_sources = set(selected_databases or ())
    skill_names = tuple(
        descriptor.name
        for descriptor in snapshot.skills.values()
        if selected_databases is None
        or descriptor.category is not SkillCategory.ACQUISITION
        or descriptor.name == "local_cache"
        or bool(selected_sources.intersection(descriptor.supported_sources))
    )
    return AgentBuild(
        agent=agent,
        skill_names=skill_names,
        model=model,
        catalog=resolved_catalog,
    )


def create_agent(
    catalog: SkillCatalog | list[str] | None = None,
    databases: list[str] | None = None,
    *,
    model_settings: RunModelSettings | None = None,
) -> Agent:
    """Build a standalone Agent for callers that do not need owned metadata."""

    return build_agent(
        catalog,
        databases=databases,
        model_settings=model_settings,
    ).agent
