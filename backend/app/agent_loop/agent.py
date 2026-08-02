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
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    serialize_function_tool_schemas,
)
from app.pipeline.tool import run_research_pipeline
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.catalog import SkillCatalog
from app.skills.gateway import build_skill_gateway
from app.skills.llm_search import LLMRerankingSkillSearchStrategy
from app.skills.registry import SkillCategory
from app.subagents.tools import (
    cancel_subagent,
    delegate_research,
    get_subagent_results,
)
from app.tools.io import list_files, read_file, write_file

AGENT_MAX_TURNS: int = 240


def resolve_agent_max_turns(
    model_settings: RunModelSettings | None = None,
) -> int:
    """Return the configured main-agent segment max_turns.

    Reads the run's immutable model settings when available (so per-run
    configuration flows through), falling back to the standalone default.
    """

    from app.model_config import RuntimeLimitsSettings

    if model_settings is not None:
        return model_settings.runtime_limits.agent_max_turns
    return RuntimeLimitsSettings().agent_max_turns

INSTRUCTIONS = """\
你是 BioMed-QAgent，一个生物医学数据检索与整理助手。

## 你的角色
你是"项目经理"：理解用户研究问题、规划检索策略、调用工具发现和获取数据、
最后把正式整理任务交给确定性 Pipeline 执行。你不直接拼装最终 CSV——产物由
Pipeline 生成。

## 工作流程
1. **理解问题**：从用户研究主题中提取关键实体（疾病、基因、化合物、通路等）
   和研究目标（表达谱、变异、结构、通路网络等）
2. **制定策略**：根据实体类型选择合适的数据库和查询关键词，用 1-2 句说明
   检索方向
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

用户在 UI 选择的数据库会作为 `preferred_sources` 注入到系统提示顶部（见"用户选择的
数据库"小节）。**优先检索用户选择的 preferred_sources 中与课题相关的数据库**；
若某个被选中的数据库与课题明显不相关（如研究表达谱时选了 PDB），则自行跳过。
选择结果不是硬 allowlist：未选择但公开、免登录的来源也可自动探索。
需要登录、API key 或付费的受保护来源，不要尝试访问，直接请求用户授权。

## 调用工具的方式
通过 function_call 机制直接调用工具——参数走 function_call 通道，不要在
assistant 文本中写出参数 JSON。工具结果会自动以结构化卡片形式展示给用户，
你只需在文本中给出自然语言的结论。

## 检索策略与失败处理
- 零结果（`not_found`）后**不重试同一 query**——换关键词、换字段或换 source
- `not_found` 不等于能力缺失，不得据此触发 `create_skill`
- 仅当工具明确缺少所需接口时标记 `capability_gap`，并通过 `find_skill`/`invoke_skill`
  调用 `create_skill`（同一 domain+capability 最多一次）。不得声称调用了不存在的工具
- 每个 source 最多 3 轮 follow-up：累计 3 次 `not_found` 后换 source 或进入 Pipeline
- 网络错误可重试，不算入 follow-up 计数
- 工具失败时如实说明，**不要编造未发生的工具调用**

## 工作目录与文件管理
每个任务有独立工作目录 `data/output/tasks/<task_id>/`，主要子目录：
- `source_assets/` — 原始数据文件（下载产物、截图、PDF 等）
- `artifacts/` — Pipeline 最终产物
- `parsed/` — 解析后的结构化数据

下载与解析严格分离：下载工具只保存原始文件，不读取内容；解析工具从本地文件开始工作。
使用 `read_file`/`write_file`/`list_files` 管理本地文件。

## 调用 run_research_pipeline
正式产物必须通过 `run_research_pipeline` 生成，不要自行拼装或直接写最终 CSV。
自定义 Agent-only 数据库不能作为 Pipeline 完成证据，也不能绕过 Validation Gate。
调用时传：
- `topic`（必填）：用户研究主题
- `databases`（可选）：用户选择的数据库列表；不传时自动使用 `preferred_sources`
- `pmid`/`gse`（强烈建议）：你先前通过 search 工具发现的 accession。**Pipeline 不会
  按 topic 自动搜索 GEO**——如果 databases 包含 GEO，你必须先通过 `search_geo` 发现
  具体的 GSE accession 并传入 `gse` 参数，否则 Pipeline 会在 discovery 阶段失败
- 不要传 `mode` 参数

## Pipeline 失败处理
`run_research_pipeline` 最多允许调用 5 次。如果返回的 `status` 不是 `completed`：
1. **阅读 `error_message`**：错误信息会明确指出缺失的参数或失败原因
2. **调整参数重试**：如错误提示缺少 `gse`，先调用 `search_geo` 发现 GSE，再重试
3. **不要用相同参数重试**：相同参数必然导致相同失败
4. **第 5 次仍失败后停止**：向用户如实汇报失败原因和已尝试的方案，不要卡在重试循环中

## Pipeline 产物与汇报
Pipeline 执行成功后会产出 CSV 包（外加一个 `run_manifest.json`）。工具返回的 JSON 中
`artifact_dir` 字段指示产物所在目录——可能是 `artifacts/`（已发布）或
`staging/run_<id>/artifacts/`（待发布，run 结束后自动迁移到 `artifacts/`）。
**引用产物时用 `list_files` 查看 `artifact_dir` 下的实际文件名，
不要编造文件名或列名**——字段含义参考 `field_descriptions.csv` 的
`description` 列。

## 上下文管理
检索查询自动记录为"已完成检索清单"并注入系统提示顶部。**该清单是权威的进度
追踪来源**——会话历史可能被压缩，但清单始终可见。规划下一步前查看清单，避免
重复搜索相同的 query+source 组合。

查询日志积累过多时调用 `compress_query_log` 压缩旧记录。调用
`run_research_pipeline` 前调用 `review_query_strategy` 让 ReviewerAgent 审查
策略合理性。

## 图表数据提取
`extract_chart_data_vlm` 工具从论文图表中提取结构化数据。适用于包含需要量化的
数值数据的论文图表，或表格以图片形式呈现时。不要用于纯文本提取，也不要对同一
图片重复调用。

## 视觉证据采集
通过 `find_skill(source="web_visual_capture")` 发现视觉采集 Skill，再用
`invoke_skill` 提交截图操作。仅当结构化 API 不可用或返回空且页面确有可视数据时
才调用，**不得替代已有结构化 API**。

## 动态 Skill 发现协议
- 业务数据库操作不作为主 Agent 直接工具注入。先调用 `find_skill`，再用
  `invoke_skill` 提交 `skill`、`operation` 和结构化参数。
- 已知数据库时优先传 `source`；否则用简短 `text` 描述能力，或用 `category` 缩小范围。
- `find_skill` 返回空时缩短查询词或改用 `source`/`category`，不要原样重复。
- 技能目录更新后重新调用 `find_skill`，不要依赖记忆中的 operation 列表。
- 注意：search_geo、search_gdc 等搜索工具属于 **acquisition** 类 Skill，调用
  `find_skill(source="geo")` 即可发现。

## 输出精简指南
- 工具调用直接执行
- 呈现结论和结果摘要
- 工具失败时用一句话说明原因和调整方向
- 检索计划限制在 1-2 句内
"""


@dataclass(frozen=True, slots=True)
class AgentBuild:
    """One isolated Agent build and the resources owned by its Run."""

    agent: Agent
    skill_names: tuple[str, ...]
    model: LazyDashScopeModel
    prompt_shape: ChatCompletionsPromptShape
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
    避免 Agent 错误地声称"用户尚未选择数据库"（问题 #1 根因修复）。
    """
    sources = run_ctx.preferred_sources
    if not sources:
        return "## 用户选择的数据库\n\n（用户未显式勾选数据库；可根据课题自行选择合适的来源）"
    display = ", ".join(sources)
    return (
        f"## 用户选择的数据库（preferred_sources）\n\n"
        f"{display}\n\n"
        "**以上数据库已由用户在 UI 中显式勾选**。调用 `run_research_pipeline` 时 "
        "如不传 `databases` 参数，将自动使用此列表。"
    )


def resolve_agent_instructions(base: str, run_ctx: RunContext) -> str:
    """Return the exact dynamic instruction string the Agent will receive.

    This is the single typed resolution function used by both Agent
    construction and prompt estimation so they share one prompt-shape source.
    """

    sources_section = _format_preferred_sources_section(run_ctx)
    search_section = _format_query_log_section(run_ctx)
    return f"{base}\n\n---\n\n{sources_section}\n\n---\n\n{search_section}"


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
    find_skill, invoke_skill = build_skill_gateway(
        resolved_catalog,
        search_strategy=LLMRerankingSkillSearchStrategy(),
    )
    tools = [
        find_skill,
        invoke_skill,
        run_research_pipeline,
        read_file,
        write_file,
        list_files,
        build_compress_query_log_tool(model),
        build_review_query_strategy_tool(model),
        delegate_research,
        get_subagent_results,
        cancel_subagent,
    ]
    prompt_shape = ChatCompletionsPromptShape(
        instructions=INSTRUCTIONS,
        serialized_tool_schemas=serialize_function_tool_schemas(tools),
        policy=ChatCompletionsStructuralPolicy(),
    )
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
        prompt_shape=prompt_shape,
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
