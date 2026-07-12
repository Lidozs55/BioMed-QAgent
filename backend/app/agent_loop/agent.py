"""主 Agent 定义 — Agent loop 核心。

管理者模式：主 Agent 配备全部工具，LLM 自主决定调用顺序与循环。
替代 v0 的 Orchestrator 固定流水线。
"""
from __future__ import annotations

from agents import Agent

from app.agent_loop.model import get_model
from app.agent_loop.summarizer import build_compress_query_log_tool
from app.skills.registry import (
    SkillCategory,
    build_agent_config,
    skill_registry,
)
from app.tools.io import read_file, write_file, list_files

try:
    from app.skills.builtin.acquisition.browser import browser_fallback_skill  # noqa: F401
except ImportError:
    browser_fallback_skill = None
try:
    from app.skills.builtin.processing.self_evolution import self_evolution_skill  # noqa: F401
except ImportError:
    self_evolution_skill = None

INSTRUCTIONS = """\
你是一个生物医学数据检索与整理助手（BioMed-QAgent），服务于赛题 XH-202619。

## 你的核心职责
根据用户的研究主题，自主规划并执行以下环节（顺序由你决定，可反复迭代）：
1. 文献检索 — 调用 search_pubmed 等工具发现相关文献与数据来源线索
2. 数据识别 — 从文献中识别数据库名称、accession、补充材料链接等
3. 数据获取 — 从允许的数据库中检索并下载原始数据文件
4. 数据解析与整理 — 解析文件，完成清洗、字段对齐和合并
5. 文件管理 — 调用 read_file/write_file/list_files 管理本地任务目录

## 工作方式
- 你在一个 Agent loop 中运行：每次工具调用后，结果会回传给你，你决定下一步
- 每个任务有独立的工作目录 data/tasks/<task_id>/，分为 raw/（原始文件）、
  parsed/（解析结果）、normalized/（清洗后数据）、artifacts/（最终产物）、logs/（记录）
- 下载与解析严格分离：下载工具只保存原始文件，不读取内容；解析工具从本地文件开始工作

## 输出要求（核心产物）
优先产出以下结构化产物，而非自然语言研究报告：
1. **主数据 CSV** — 合并、清洗后的表格数据
2. **字段说明** — 每个列的含义、单位和来源
3. **来源清单** — 每条数据最终追溯到原始数据源和本地 raw 文件
4. **下载记录** — 每个文件的来源 URL、accession、下载时间和校验信息
5. **处理记录** — 清洗步骤、字段映射、异常和警告

分析（统计、可视化等）为可选加分项，不生成缺少数据依据的科研或临床结论。

如果你的工具链尚不完整，优先完成已有工具能产出的部分，并在 artifacts/ 目录保存阶段性成果。

## 上下文管理
- 所有检索查询会记录到 RunContext.query_log
- 当查询日志累计较长（约 8000 字符，通常对应 15-20 条查询）时，调用 compress_query_log 工具压缩旧记录
- 压缩后仅保留最近 5 条完整记录，更早的记录转为摘要
- 上下文管理子 Agent 后续会扩展更多能力（如压缩 records、注入背景等）
"""


# Module-level store for skill names loaded in the most recent create_agent() call.
_loaded_skill_names: list[str] = []


def get_loaded_skill_names() -> list[str]:
    """Return skill names loaded in the last create_agent() invocation."""
    return list(_loaded_skill_names)


def _import_skill_modules() -> None:
    """尝试导入技能模块，失败时不阻塞。"""
    try:
        import app.skills.builtin.discovery.pubmed  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.discovery.understanding  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.acquisition.geo  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.acquisition.pdb  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.acquisition.gdc  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.acquisition.xena  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.acquisition.browser  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.processing.self_evolution  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.processing.extract_tables  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.analysis.stats  # noqa: F401
    except ImportError:
        pass


def create_agent(databases: list[str] | None = None) -> Agent:
    """构造主 Agent。

    Args:
        databases: 用户选择的数据库列表。None 时加载所有已启用的技能；
                   给定列表时，仅加载匹配的 acquisition 技能 + 全部非 acquisition 技能。
    """
    global _loaded_skill_names
    _import_skill_modules()

    if databases is not None:
        acq_skills = skill_registry.get_acquisition_skills(databases)
        all_enabled = skill_registry.list_enabled()
        non_acq_skills = [
            s for s in all_enabled
            if s.category != SkillCategory.ACQUISITION
        ]
        skills: list = acq_skills + non_acq_skills
    else:
        skills = skill_registry.list_enabled()

    if browser_fallback_skill is not None:
        skills.append(browser_fallback_skill)
    if self_evolution_skill is not None:
        skills.append(self_evolution_skill)

    _loaded_skill_names = [s.name for s in skills]

    instructions_suffix, tools = build_agent_config(skills)
    tools.extend([read_file, write_file, list_files])
    tools.append(build_compress_query_log_tool())
    seen: set[str] = set()
    unique_tools: list = []
    for t in tools:
        name = getattr(t, "name", str(t))
        if name not in seen:
            seen.add(name)
            unique_tools.append(t)
    merged_instructions = (
        INSTRUCTIONS + "\n\n## 已加载技能的说明\n\n" + instructions_suffix
        if instructions_suffix
        else INSTRUCTIONS
    )
    return Agent(
        name="BioMedResearcher",
        instructions=merged_instructions,
        tools=unique_tools,
        model=get_model(),
    )
