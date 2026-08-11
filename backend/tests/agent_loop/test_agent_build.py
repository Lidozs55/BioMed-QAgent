from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime

import pytest
from agents import RunContextWrapper, function_tool
from agents.tool_context import ToolContext
from app.agent_loop.agent import (
    INSTRUCTIONS,
    AgentBuild,
    _format_progress_briefing_section,
    build_agent,
    resolve_agent_instructions,
)
from app.agent_loop.context import PendingDatasetBuild, RunContext
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus
from app.domain.contracts.enums import Database
from app.domain.contracts.source import SourceRecord
from app.skills.catalog import SkillCatalog, SkillDescriptor
from app.skills.registry import SkillCategory, SkillDef

pytestmark = pytest.mark.usefixtures("runnable_agent_model_settings")


def test_agent_build_owns_immutable_skill_and_model_metadata() -> None:
    build = build_agent(databases=[])

    assert isinstance(build, AgentBuild)
    assert isinstance(build.skill_names, tuple)
    assert build.model is build.agent.model
    with pytest.raises(FrozenInstanceError):
        build.skill_names = ()


@pytest.mark.asyncio
async def test_concurrent_agent_builds_keep_skill_and_model_ownership_isolated() -> None:
    catalog = SkillCatalog()
    geo_build, pdb_build = await asyncio.gather(
        asyncio.to_thread(build_agent, catalog, ["geo"]),
        asyncio.to_thread(build_agent, catalog, ["pdb"]),
    )

    assert geo_build.catalog is catalog
    assert pdb_build.catalog is catalog
    assert geo_build.model is not pdb_build.model


def test_agent_exposes_only_gateway_and_core_runtime_tools() -> None:
    build = build_agent(SkillCatalog(), databases=["pubmed", "geo"])

    assert [tool.name for tool in build.agent.tools] == [
        "find_skill",
        "invoke_skill",
        "validate_dataset_build_spec",
        "request_human_correction",
        "execute_dataset_build",
        "read_file",
        "read_file_head",
        "search_file",
        "write_file",
        "list_files",
        "compress_query_log",
        "review_query_strategy",
        "delegate_research",
        "get_subagent_results",
        "cancel_subagent",
    ]


def test_agent_instructions_require_dynamic_skill_discovery_protocol() -> None:
    # agent.instructions is a dynamic callable (query_log injection); validate
    # the base content via the module-level INSTRUCTIONS constant.
    build_agent(SkillCatalog())

    assert "find_skill" in INSTRUCTIONS
    assert "invoke_skill" in INSTRUCTIONS
    assert "技能目录更新后" in INSTRUCTIONS
    assert "简短 `text` 描述能力" in INSTRUCTIONS
    assert "缩短查询" in INSTRUCTIONS
    assert "优先传 `source`" in INSTRUCTIONS
    assert "每个被选中的数据库必须至少调用一次" not in INSTRUCTIONS


def test_agent_prompt_distinguishes_results_from_capability_gaps() -> None:
    instructions = resolve_agent_instructions(
        INSTRUCTIONS,
        RunContext(preferred_sources=["pubmed"]),
    )

    assert "不等于能力缺失" in instructions
    assert "capability_gap" in instructions
    assert "同一 domain+capability 最多一次" in instructions
    assert "优先检索其中与课题相关的数据库" in instructions
    assert "免登录的来源可自动探索" in instructions


def test_agent_step5_requires_artifact_status_check_before_reporting() -> None:
    """A3: 汇报前必须确认产物状态；输出纪律以产物铁律收尾。

    (docs/REVIEW_2026-08-11-task-25d12608.md §5.4 A3.)"""

    assert "汇报前先确认产物状态" in INSTRUCTIONS
    assert "是否已产出正式产物" in INSTRUCTIONS
    assert "执行\n`execute_dataset_build` 完成至少一次构建再汇报" in INSTRUCTIONS
    assert "产物铁律" in INSTRUCTIONS


def test_progress_briefing_reports_used_unused_sources_and_empty_state() -> None:
    """A1: 简报反映已用/未用数据源、产物状态、构建次数、浏览器工具。"""

    context = RunContext(preferred_sources=["geo", "pubmed", "xena"])
    context.log_query("AD osteoporosis", "pubmed", "success", 10)
    context.log_query("AD brain", "geo", "success", 5)

    briefing = _format_progress_briefing_section(context)

    assert "## 工作进度简报（当前状态，非指令）" in briefing
    assert "正式产物（publication）：无" in briefing
    assert "构建尝试：0 次" in briefing
    assert "已下载原始文件：0 个" in briefing
    assert "已使用数据源：pubmed, geo" in briefing
    assert "未使用数据源（课题相关可继续探索）：xena" in briefing
    assert "浏览器自动化工具：未使用" in briefing


def test_progress_briefing_reports_publication_downloads_and_browser_use() -> None:
    """A1: 有产物、有下载、用过浏览器自动化时，简报如实反映。"""

    context = RunContext(task_id="task_briefing", managed_run_id="run_x")
    context.install_dataset_build_outcome(
        PendingDatasetBuild(
            run_id="run_x",
            build_id="build_x",
            build_result=BuildResult(
                status=BuildResultStatus.SUCCEEDED,
                valid_row_count=42,
                successful_sources=["binding_geo"],
                publication_id="pub_build_x",
            ),
        )
    )
    context.add_raw_asset("source_assets/GSE116925_series_matrix.txt.gz")
    context.add_source(
        SourceRecord(
            source_id="src_browser",
            database=Database.BROWSER,
            accession="supplement.html",
            url="https://example.org/supplement.html",
            title="Browser download supplement.html",
            retrieved_at=datetime.now(UTC),
        )
    )

    briefing = _format_progress_briefing_section(context)

    assert "正式产物（publication）：有" in briefing
    assert "构建尝试：0 次" in briefing
    assert "已下载原始文件：1 个" in briefing
    assert "浏览器自动化工具：已使用" in briefing


@pytest.mark.asyncio
async def test_existing_agent_gateway_observes_catalog_hot_add() -> None:
    @function_tool
    async def fetch_demo(ctx: RunContextWrapper[RunContext]) -> str:
        return "demo"

    catalog = SkillCatalog()
    build = build_agent(catalog, databases=["demo_db"])
    find_skill = next(tool for tool in build.agent.tools if tool.name == "find_skill")
    context = ToolContext(
        context=RunContext(preferred_sources=["demo_db"]),
        tool_name="find_skill",
        tool_call_id="call-find",
        tool_arguments='{"text":"demo_db"}',
    )

    before = await find_skill.on_invoke_tool(
        context,
        '{"text":"demo_db","category":null,"source":null}',
    )
    catalog.register(
        SkillDescriptor.from_skill_def(
            SkillDef(
                name="demo_db",
                category=SkillCategory.ACQUISITION,
                description="Demo DB.",
                tools=[fetch_demo],
                supported_sources=["demo_db"],
            )
        )
    )
    after = await find_skill.on_invoke_tool(
        context,
        '{"text":"demo_db","category":null,"source":null}',
    )

    assert '"skills": []' in before
    assert '"name": "demo_db"' in after


@pytest.mark.asyncio
async def test_concurrent_agent_builds_pass_each_owned_model_to_compress_tool() -> None:
    builds = await asyncio.gather(
        asyncio.to_thread(build_agent, ["geo"]),
        asyncio.to_thread(build_agent, ["pdb"]),
    )
    try:
        context_manager_agents = []
        for build in builds:
            compress_tool = next(
                tool for tool in build.agent.tools if tool.name == "compress_query_log"
            )
            context_manager_agent = compress_tool._agent_instance
            context_manager_agents.append(context_manager_agent)
            assert context_manager_agent.model is build.model
            assert build.agent.model is build.model

        assert builds[0].model is not builds[1].model
        assert context_manager_agents[0] is not context_manager_agents[1]
    finally:
        await asyncio.gather(*(build.model.close() for build in builds))
