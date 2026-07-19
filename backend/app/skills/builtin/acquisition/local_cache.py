"""local_cache acquisition skill — 从本地缓存查询已导入/已缓存的数据集。

与 GEO/PubMed 等外部数据库同级，作为可选数据来源（D2 决策）。
出现在 ``SkillCategory.ACQUISITION`` 但 ``supported_sources`` 为
``["local_cache"]``，因此**不会**出现在 ``GET /api/v1/databases``
的数据库选择列表中（``routes.py:get_databases`` 过滤条件要求
``supported_sources`` 与用户选择的外部数据库匹配）。

主 Agent 通过 ``search_local_cache`` / ``describe_local_cache`` /
``get_cache_dataset`` 三个工具查询缓存，与 ``search_pubmed`` /
``search_geo`` 同形。

IMPORT Agent 通过 ``commit_to_cache`` 工具将清洗后的数据写入缓存。
``commit_to_cache`` 不在本 skill 的 tools 列表中（只供 IMPORT agent 使用），
而是作为独立 function_tool 由 ``build_attachment_parsing_agent`` 直接装载。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import QueryStatus, StageName
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.cache_store import get_cache_store

logger = logging.getLogger(__name__)


@function_tool(
    name_override="search_local_cache",
    description_override=(
        "Search the local cache for previously imported or cached datasets. "
        "Returns dataset manifests matching the query via FTS5 full-text "
        "search (matches topic, description, and keywords). Use this BEFORE "
        "searching external databases (PubMed/GEO/...) to reuse already-"
        "cleaned data. The cache is populated by IMPORT tasks or by previous "
        "research runs. Query by any entity: gene names, drug names, "
        "diseases, pathways, sample types, etc."
    ),
)
async def search_local_cache(
    ctx: RunContextWrapper[Any],
    query: str,
    max_results: int = 10,
) -> str:
    """搜索本地缓存中已导入/已缓存的数据集。

    Args:
        query: 搜索关键词（FTS5 全文匹配 topic/description/keywords）。
            支持任意实体：基因名、药物名、疾病、通路、样本类型等。
        max_results: 最多返回的结果数。
    """
    run_ctx: RunContext = ctx.context
    try:
        store = get_cache_store()
    except RuntimeError as exc:
        run_ctx.log_query(
            query=query,
            source="local_cache",
            status=QueryStatus.FAILED,
            records_count=0,
        )
        return f"本地缓存未初始化: {exc}"

    manifests = store.search_datasets(query, limit=max_results)
    if manifests:
        run_ctx.log_query(
            query=query,
            source="local_cache",
            status=QueryStatus.SUCCESS,
            records_count=len(manifests),
        )
    else:
        run_ctx.log_query(
            query=query,
            source="local_cache",
            status=QueryStatus.NOT_FOUND,
            records_count=0,
        )
    if not manifests:
        return json.dumps(
            {"source": "local_cache", "query": query, "results": []},
            ensure_ascii=False,
        )
    results = [
        {
            "dataset_id": m.dataset_id,
            "source_namespace": m.source_namespace,
            "topic": m.topic,
            "description": m.description,
            "keywords": m.keywords or [],
            "row_count": m.row_count,
            "created_at": m.created_at,
            "created_by_task_id": m.created_by_task_id,
            "source_files": m.source_files,
        }
        for m in manifests
    ]
    return json.dumps(
        {"source": "local_cache", "query": query, "results": results},
        ensure_ascii=False,
        indent=2,
    )


@function_tool(
    name_override="describe_local_cache",
    description_override=(
        "Describe one cached dataset's manifest (without reading its data rows). "
        "Use after search_local_cache to inspect a dataset's metadata before "
        "deciding whether to load its full content via get_cache_dataset."
    ),
)
async def describe_local_cache(
    ctx: RunContextWrapper[Any],
    source_namespace: str,
    dataset_id: str,
) -> str:
    """读取一个缓存数据集的 manifest（不读 main_data.csv）。"""
    # ctx.context is reserved for future emit_progress / log_query hooks;
    # currently unused to keep describe_local_cache pure-metadata.
    try:
        store = get_cache_store()
    except RuntimeError as exc:
        return f"本地缓存未初始化: {exc}"

    manifest = store.describe_dataset(source_namespace, dataset_id)
    if manifest is None:
        return json.dumps(
            {
                "source": "local_cache",
                "source_namespace": source_namespace,
                "dataset_id": dataset_id,
                "error": "dataset not found",
            },
            ensure_ascii=False,
        )
    return json.dumps(
        {
            "source": "local_cache",
            "dataset_id": manifest.dataset_id,
            "source_namespace": manifest.source_namespace,
            "topic": manifest.topic,
            "description": manifest.description,
            "keywords": manifest.keywords or [],
            "row_count": manifest.row_count,
            "column_count": manifest.column_count,
            "created_at": manifest.created_at,
            "created_by_task_id": manifest.created_by_task_id,
            "source_files": manifest.source_files,
            "extra": manifest.extra,
        },
        ensure_ascii=False,
        indent=2,
    )


@function_tool(
    name_override="get_cache_dataset",
    description_override=(
        "Load the full main_data.csv rows of one cached dataset. "
        "Returns rows in the 22-column long format (same schema as "
        "Pipeline-produced main_data.csv). Use after describe_local_cache "
        "to confirm the dataset is what you need."
    ),
)
async def get_cache_dataset(
    ctx: RunContextWrapper[Any],
    source_namespace: str,
    dataset_id: str,
    max_rows: int = 1000,
) -> str:
    """读取一个缓存数据集的完整 main_data.csv 行。

    Args:
        source_namespace: 数据集命名空间（如 ``user_import``）。
        dataset_id: 数据集 ID。
        max_rows: 最多返回的行数（防止巨量数据撑爆 LLM 上下文）。
    """
    run_ctx: RunContext = ctx.context
    try:
        store = get_cache_store()
    except RuntimeError as exc:
        return f"本地缓存未初始化: {exc}"

    result = store.get_dataset(source_namespace, dataset_id)
    if result is None:
        return json.dumps(
            {
                "source": "local_cache",
                "source_namespace": source_namespace,
                "dataset_id": dataset_id,
                "error": "dataset not found",
            },
            ensure_ascii=False,
        )
    manifest, rows = result
    truncated = len(rows) > max_rows
    returned_rows = rows[:max_rows]
    await run_ctx.emit_progress(
        stage=StageName.ACQUISITION,
        kind="cache_dataset_loaded",
        current=len(returned_rows),
        total=len(rows),
        detail={
            "source_namespace": source_namespace,
            "dataset_id": dataset_id,
            "truncated": truncated,
        },
    )
    return json.dumps(
        {
            "source": "local_cache",
            "dataset_id": manifest.dataset_id,
            "source_namespace": manifest.source_namespace,
            "topic": manifest.topic,
            "row_count": manifest.row_count,
            "returned_rows": len(returned_rows),
            "truncated": truncated,
            "columns": [
                "record_id", "dataset_id", "source_id", "asset_id",
                "gene_id_raw", "gene_id", "gene_id_namespace",
                "gene_id_version", "sample_id", "source_sample_alias",
                "measurement_type", "value_semantics", "value_scale",
                "is_normalized", "is_integer_expected", "expression_value",
                "expression_unit", "source_logical_file",
                "source_line_number", "source_column_index",
                "source_column_name", "source_raw_value",
            ],
            "rows": returned_rows,
        },
        ensure_ascii=False,
    )


local_cache_skill = SkillDef(
    name="local_cache",
    category=SkillCategory.ACQUISITION,
    description=(
        "Query the local cache for previously imported or cached datasets. "
        "Use search_local_cache before searching external databases to reuse "
        "already-cleaned data. Cache is populated by IMPORT tasks."
    ),
    instructions=(
        "## 本地缓存使用指南\n"
        "本地缓存存储已清洗的 22 列长格式数据（与 main_data.csv 同 schema），"
        "来源于用户导入文件或既往研究任务的产物。\n\n"
        "### 何时使用\n"
        "1. **优先查询** — 在调用 search_pubmed/search_geo 等外部 API 前，"
        "先调 search_local_cache 检查是否已有匹配的缓存数据\n"
        "2. **补充查询** — 外部 API 无结果或结果不全时，可作为补充来源\n"
        "3. **复用清洗成果** — 既往任务的 main_data.csv 已缓存，避免重复清洗\n\n"
        "### 工具链\n"
        "- ``search_local_cache(query, max_results)`` — 关键词搜索数据集 manifest\n"
        "- ``describe_local_cache(source_namespace, dataset_id)`` — 查看单个数据集详情\n"
        "- ``get_cache_dataset(source_namespace, dataset_id, max_rows)`` — "
        "读取数据行（22 列长格式）\n\n"
        "### 命名空间约定\n"
        "- ``user_import`` — 用户通过文件上传导入的数据\n"
        "- ``pipeline_artifact`` — 既往研究任务自动缓存的产物（暂未实现）\n"
    ),
    tools=[search_local_cache, describe_local_cache, get_cache_dataset],
    supported_sources=["local_cache"],
    version="0.1.0",
)

skill_registry.register(local_cache_skill)
