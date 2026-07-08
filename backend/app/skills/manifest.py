"""技能清单模型 — SkillManifest 及其输入/输出字段规格。

描述系统中注册的所有技能（数据源、解析器、清洗器、分析等）的接口契约，
供 SkillRegistry、前端发现面板和 LLM 工具选择使用。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ── 字段规格 ─────────────────────────────────────────────────────


class SkillInputField(BaseModel):
    """技能输入字段规格。"""
    name: str = Field(..., description="字段名（如 query / max_results / gene_list）")
    type: str = Field("str", description="类型提示（str / int / float / bool / list[str]）")
    required: bool = Field(True, description="是否必填")
    default: Any | None = Field(None, description="默认值（非必填时使用）")
    description: str = Field("", description="字段用途说明")


class SkillOutputField(BaseModel):
    """技能输出字段规格。"""
    name: str = Field(..., description="字段名（如 records / network / p_value）")
    type: str = Field("str", description="类型提示")
    description: str = Field("", description="字段用途说明")


# ── 技能清单 ─────────────────────────────────────────────────────


class SkillManifest(BaseModel):
    """技能清单 — 描述一个可注册技能的完整接口契约。

    与 ToolRegistry 的 categories 对齐：
    datasources / parsers / cleaners / analysis / io / optimization / viz / export
    """

    # ── 标识 ──
    skill_id: str = Field(
        ...,
        description="唯一标识符（如 pubmed / ppi_network / field_aligner）",
    )
    name: str = Field(
        ...,
        description="展示名（如 PubMed Literature Search）",
    )
    description: str = Field(
        "",
        description="一行功能描述",
    )

    # ── 分类 ──
    category: str = Field(
        ...,
        description=(
            "功能类别，与 ToolRegistry categories 对齐："
            "datasources / parsers / cleaners / analysis / io / optimization / viz / export"
        ),
    )
    tags: list[str] = Field(
        default_factory=list,
        description="检索标签（如 ['pubmed', 'literature', 'ncbi']）",
    )

    # ── 接口 ──
    inputs: list[SkillInputField] = Field(
        default_factory=list,
        description="期望输入字段列表",
    )
    outputs: list[SkillOutputField] = Field(
        default_factory=list,
        description="返回输出字段列表",
    )

    # ── 版本 ──
    version: str = Field(
        "active",
        description="状态：active（可用）/ dormant（休眠）",
    )

    # ── 质量 ──
    quality_indicators: dict[str, Any] = Field(
        default_factory=dict,
        description="质量元数据（如 accuracy / coverage / freshness 提示）",
    )

    def __repr__(self) -> str:
        inputs_n = len(self.inputs)
        outputs_n = len(self.outputs)
        return (
            f"SkillManifest({self.skill_id!r}, "
            f"category={self.category!r}, "
            f"version={self.version!r}, "
            f"inputs={inputs_n}, outputs={outputs_n})"
        )
