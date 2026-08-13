"""research_data_guidance skill — topic-routed research-data SOP documents.

Borrowed and adapted from the ``research-data-analysis-workspace`` skill group
(REVIEW_2026-08-09-task-3eb85407 §7.2): the main Agent loads topic-specific
research-data instructions on demand via the direct tool instead of carrying
them all in the system prompt, so guidance stays available without diluting
attention.

Scope is data finding / parsing / cleaning / integration / analyzability —
statistics and visualization are owned by downstream users, NOT this skill
(the pipeline does not run statistical tests or produce figures).
"""

from __future__ import annotations

from pathlib import Path

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.skills.categories import SkillCategory

#: Topic documents served by this skill (path stem -> human label).
_TOPIC_DOCS: dict[str, str] = {
    "index": "科研数据策略指导（索引）",
    "strategy": "研究问题 → 数据策略与设计",
    "expression_omics": "表达谱与多组学数据",
    "clinical": "临床与试验数据",
    "structure_pathway_compound": "结构、通路与化合物",
    "cleaning": "清洗、规范化与可分析性判定",
    "reproducibility": "溯源、复现与报告",
}

#: Allow hyphens/spaces in the wire topic, mapped to the file stem.
_TOPIC_ALIASES: dict[str, str] = {
    "structure-pathway-compound": "structure_pathway_compound",
    "structure_pathways": "structure_pathway_compound",
    "expression-omics": "expression_omics",
    "reproducibility-and-reporting": "reproducibility",
}

_GUIDANCE_DIR = Path(__file__).parent / "research_data_guidance"


def _topic_stem(topic: str) -> str:
    """Normalize an arbitrary topic string to a document stem (or 'index')."""
    key = (topic or "index").strip().lower()
    key = _TOPIC_ALIASES.get(key, key)
    return key if key in _TOPIC_DOCS else "index"


@function_tool(
    name_override="get_research_data_guidance",
    description_override=(
        "Load a topic-specific research-data guidance document for the current "
        "task. Topics: 'strategy' (research question -> data sources & study "
        "design), 'expression_omics' (RNA-seq/microarray/other omics data "
        "acquisition), 'clinical' (cohort/EHR/trial data), "
        "'structure_pathway_compound' (PDB/Reactome/PubChem research-only), "
        "'cleaning' (entity mapping, units, analyzability diagnosis), "
        "'reproducibility' (provenance, multi-source identity, publication). "
        "Pass 'index' or an unknown topic to get the routing table. Read ONLY "
        "the topic(s) relevant to the current task."
    ),
)
def get_research_data_guidance(
    ctx: RunContextWrapper[RunContext],
    topic: str,
) -> str:
    """Return the research-data guidance document for *topic*.

    Args:
        ctx: Run context (injected by the OpenAI Agents SDK).
        topic: One of: index, strategy, expression_omics, clinical,
            structure_pathway_compound, cleaning, reproducibility. Unknown
            topics fall back to the index (routing table).

    Returns:
        The markdown guidance document body for the requested topic.
    """
    stem = _topic_stem(topic)
    path = _GUIDANCE_DIR / f"{stem}.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        # Defensive: the index must always exist; a missing file is a packaging
        # error, so surface the routing table rather than an empty result.
        text = (_GUIDANCE_DIR / "index.md").read_text(encoding="utf-8")
    header = (
        f"# {_TOPIC_DOCS[stem]}（research_data_guidance）\n\n"
        f"> 主题: {stem} —— 如需其它主题，参考索引中的路由表。\n\n"
    )
    return header + text


SKILL_NAME = 'research_data_guidance'
SKILL_CATEGORY = SkillCategory.ANALYSIS
SKILL_DESCRIPTION = (
    'Load topic-specific research-data strategy and SOP guidance for biomedical data tasks: data-'
    'source selection and study design (strategy), expression/omics acquisition, clinical/trial'
    'data, structure/pathway/compound research-only sources, cleaning and analyzability'
    'diagnosis, and provenance/reproducibility. Use when the task involves finding, parsing,'
    'cleaning, integrating, or judging the analyzability of research data.'
)
SKILL_VERSION = '1.0.0'
SUPPORTED_SOURCES = []
SKILL_TOOLS = [
    get_research_data_guidance,
]
