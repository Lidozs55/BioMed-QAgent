"""技能发现与查询 API。

提供技能列表、分类、详情和语义检索接口。
技能在应用启动时通过 register_all_skills() 自动注册。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from app.skills import get_skill_registry, SkillRetriever
from app.skills.manifest import SkillManifest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/skills", tags=["skills"])


def _manifest_to_response(m: SkillManifest) -> dict:
    """将 SkillManifest 转为 API 响应字典。"""
    return m.model_dump()


# ── 列表与分类 ──────────────────────────────────────────────────────

@router.get("", summary="列出所有技能")
async def list_skills(
    category: str | None = Query(
        None,
        description="按类别过滤（如 datasources / parsers / analysis）",
    ),
    version: str | None = Query(
        None,
        description="按版本过滤（active / dormant）",
    ),
) -> list[dict]:
    """列出所有已注册技能，可按类别或版本过滤。"""
    registry = get_skill_registry()
    skills = registry.list_skills(category=category)
    if version is not None:
        skills = [s for s in skills if s.version == version]
    return [_manifest_to_response(s) for s in skills]


@router.get("/categories", summary="列出所有技能类别")
async def list_categories() -> list[str]:
    """列出所有已注册技能的唯一类别。"""
    registry = get_skill_registry()
    return registry.list_categories()


@router.get("/count", summary="已注册技能总数")
async def count_skills(category: str | None = Query(None)) -> dict:
    """返回已注册技能总数，可按类别过滤。"""
    registry = get_skill_registry()
    if category:
        count = len(registry.list_skills(category=category))
    else:
        count = registry.count()
    return {"total": count, "category": category}


# ── 详情 ────────────────────────────────────────────────────────────

@router.get("/{skill_id}", summary="获取技能详情")
async def get_skill(skill_id: str) -> dict:
    """按 skill_id 获取单个技能的完整信息。"""
    registry = get_skill_registry()
    manifest = registry.get(skill_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Skill not found: {skill_id}")
    return _manifest_to_response(manifest)


# ── 语义检索 ────────────────────────────────────────────────────────

@router.post("/search", summary="语义检索技能")
async def search_skills(
    query: str = Query(..., description="自然语言查询（如 'pubmed literature search'）"),
    top_k: int = Query(10, ge=1, le=50, description="返回结果数量"),
    use_llm: bool = Query(False, description="是否启用 LLM 重排序"),
    category: str | None = Query(None, description="可选类别过滤"),
) -> list[dict]:
    """基于关键词 + 可选 LLM 重排序的技能检索。"""
    retriever = SkillRetriever()
    registry = get_skill_registry()
    manifests = retriever.retrieve(
        query=query,
        top_k=top_k,
        registry=registry,
        use_llm=use_llm,
        category=category,
    )
    return [
        {"skill_id": m.skill_id, "manifest": _manifest_to_response(m)}
        for m in manifests
    ]
