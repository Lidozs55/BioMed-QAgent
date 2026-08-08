from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import app.pipeline.tool as pipeline_tool_module
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.domain.contracts import Database, StageName, TaskRequest
from app.model_config import RunModelSettings, UserSettings
from app.pipeline.runner import PendingPublicationCleanup
from app.pipeline.tool import (
    _build_tool_specification,
    _stage_timeouts_from_settings,
    run_research_pipeline,
)
from app.tools.workdir import create_task_workdir


def test_stage_timeouts_from_settings_empty_returns_none() -> None:
    """空 STAGE_TIMEOUTS 配置返回 None，runner 使用内置默认。"""
    import app.pipeline.tool as tool_module
    from app.config import Settings as SettingsCls

    tool_module.app_settings = SettingsCls()
    assert _stage_timeouts_from_settings() is None


def test_stage_timeouts_from_settings_maps_known_stages(monkeypatch) -> None:
    """STAGE_TIMEOUTS 映射到 StageName 键，未知 stage 被跳过。"""
    import app.pipeline.tool as tool_module
    from app.config import Settings as SettingsCls

    monkeypatch.setenv(
        "STAGE_TIMEOUTS",
        '{"discovery": 60, "acquisition": 120, "unknown_stage": 999}',
    )
    tool_module.app_settings = SettingsCls()
    try:
        mapped = _stage_timeouts_from_settings()
        assert mapped is not None
        assert mapped[StageName.DISCOVERY] == 60.0
        assert mapped[StageName.ACQUISITION] == 120.0
        assert StageName.PROCESSING not in mapped
    finally:
        monkeypatch.delenv("STAGE_TIMEOUTS")
        tool_module.app_settings = SettingsCls()


def test_tool_specification_adds_explicit_reactome_pathway() -> None:
    specification = _build_tool_specification(
        "reactome topic",
        ["reactome"],
        None,
        None,
        reactome_pathway_id="R-HSA-199420",
    )

    assert specification is not None
    dataset = specification.datasets[0]
    assert dataset.database is Database.REACTOME
    assert dataset.accession == "R-HSA-199420"
    assert dataset.data_type == "pathway-participants"


@pytest.mark.parametrize("reactome_pathway_id", ["", "   "])
def test_empty_reactome_pathway_is_omitted(reactome_pathway_id: str) -> None:
    assert (
        _build_tool_specification(
            "reactome topic",
            ["reactome"],
            None,
            None,
            reactome_pathway_id=reactome_pathway_id,
        )
        is None
    )


def test_reactome_pathway_is_omitted_when_not_selected() -> None:
    assert (
        _build_tool_specification(
            "reactome topic",
            ["pubmed"],
            None,
            None,
            reactome_pathway_id="R-HSA-199420",
        )
        is None
    )


def test_reactome_pathway_coexists_with_other_database_accessions() -> None:
    specification = _build_tool_specification(
        "mixed topic",
        ["reactome", "pubmed"],
        "12345678",
        None,
        reactome_pathway_id="R-HSA-199420",
    )

    assert specification is not None
    assert [dataset.database for dataset in specification.datasets] == [Database.REACTOME]
    assert [query.database for query in specification.queries] == [Database.PUBMED]


def test_tool_specification_keeps_one_reactome_dataset_for_duplicate_selection() -> None:
    specification = _build_tool_specification(
        "reactome topic",
        ["reactome", "reactome"],
        None,
        None,
        reactome_pathway_id="R-HSA-199420",
    )

    assert specification is not None
    assert [dataset.accession for dataset in specification.datasets] == ["R-HSA-199420"]


@pytest.mark.asyncio
@pytest.mark.parametrize("pathway_id", [None, "", "   "])
async def test_pipeline_function_tool_rejects_missing_reactome_pathway_id(
    tmp_path: Path, pathway_id: str | None
) -> None:
    context = RunContext(task_id="task_tool_missing_reactome")
    context._work_dir = create_task_workdir(
        "task_tool_missing_reactome", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_missing_reactome",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps({"topic": "reactome", "databases": ["reactome"], "reactome_pathway_id": pathway_id}),
    )

    payload = json.loads(result)
    assert payload["status"] == "invalid_input"
    assert "reactome_pathway_id" in payload["message"]


@pytest.mark.asyncio
async def test_pipeline_function_tool_rejects_mixed_reactome_sources(tmp_path: Path) -> None:
    context = RunContext(task_id="task_tool_mixed_reactome")
    context._work_dir = create_task_workdir(
        "task_tool_mixed_reactome", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_mixed_reactome",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "mixed",
                "databases": ["reactome", "pubmed"],
                "reactome_pathway_id": "R-HSA-199420",
                "mode": "fixture",
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "unsupported_databases"
    assert payload["unsupported_databases"] == ["reactome_mixed_sources"]


@pytest.mark.asyncio
async def test_pipeline_function_tool_uses_reactome_fixture_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context = RunContext(task_id="task_tool_reactome_fixture")
    context._work_dir = create_task_workdir(
        "task_tool_reactome_fixture", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_reactome_fixture",
        tool_arguments="{}",
    )
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

        async def run(self) -> SimpleNamespace:
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="failed"),
                validation=SimpleNamespace(status="invalid"),
                artifacts=[],
            )

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)
    await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "reactome",
                "databases": ["reactome"],
                "reactome_pathway_id": " R-HSA-199420 ",
                "mode": "fixture",
            }
        ),
    )

    assert captured["fixture_dir"] == (
        Path(pipeline_tool_module.__file__).parents[2] / "tests" / "fixtures" / "reactome"
    )


@pytest.mark.asyncio
async def test_pipeline_function_tool_completes_reactome_only_fixture_run(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_reactome_e2e")
    context._work_dir = create_task_workdir(
        "task_tool_reactome_e2e", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_reactome_e2e",
        tool_arguments="{}",
    )

    payload = json.loads(
        await run_research_pipeline.on_invoke_tool(
            tool_context,
            json.dumps(
                {
                    "topic": "Reactome apoptosis",
                    "databases": ["reactome"],
                    "reactome_pathway_id": " R-HSA-199420 ",
                    "mode": "fixture",
                }
            ),
        )
    )

    assert payload["status"] == "completed"
    assert payload["validation_status"] == "valid"
    assert "pathway_members.csv" in [entry["name"] for entry in payload["artifacts"]]
    assert (
        tmp_path / "tasks" / "task_tool_reactome_e2e" / "artifacts" / "pathway_members.csv"
    ).is_file()


def test_task_request_accepts_optional_reactome_pathway_id() -> None:
    request = TaskRequest(topic="reactome topic", reactome_pathway_id="R-HSA-199420")

    assert request.reactome_pathway_id == "R-HSA-199420"


@pytest.mark.asyncio
async def test_pipeline_function_tool_runs_explicit_fixture_mode(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_1",
        tool_arguments="{}",
    )

    payload = json.loads(
        await run_research_pipeline.on_invoke_tool(
            tool_context,
            json.dumps(
                {
                    "topic": "tool supplied acceptance topic",
                    "databases": ["pubmed", "geo"],
                    "mode": "fixture",
                }
            ),
        )
    )

    assert run_research_pipeline.name == "run_research_pipeline"
    assert payload["task_id"] == "task_tool"
    assert payload["status"] == "completed"
    assert payload["validation_status"] == "valid"
    assert payload["artifact_count"] == 15

    # Tool 必须返回实际 artifact 文件名清单，避免 LLM 在报告中编造文件名
    # (例如把 main_data.csv 编造成 merged_comorbidity_data.csv)。
    # See docs/REVIEW_2026-07-18.md §15.2 / §16.
    assert "artifacts" in payload
    artifact_names = [entry["name"] for entry in payload["artifacts"]]
    assert "main_data.csv" in artifact_names
    assert "literature.csv" in artifact_names
    assert "run_manifest.json" not in artifact_names  # manifest 不在 artifacts 列表
    # 每个 artifact entry 必须包含 name/size_bytes/media_type
    for entry in payload["artifacts"]:
        assert {"name", "size_bytes", "media_type"} <= set(entry.keys())
    # note 字段提示 LLM 不要编造文件名
    assert "do not invent filenames" in payload["note"]

    manifest = json.loads(
        (
            tmp_path / "tasks" / "task_tool" / "artifacts" / "run_manifest.json"
        ).read_text("utf-8")
    )
    assert manifest["request"]["topic"] == ("tool supplied acceptance topic")
    assert context.take_pending_publication() is None


@pytest.mark.asyncio
async def test_pipeline_function_tool_defers_managed_run_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = "run_tool_managed"
    context = RunContext(
        task_id="task_tool_managed",
        base_dir=tmp_path / "tasks",
        managed_run_id=run_id,
        model_settings=RunModelSettings.from_user_settings(
            UserSettings(model_name="run-start-model", context_window=65_536)
        ),
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_managed",
        tool_arguments="{}",
    )
    pending = SimpleNamespace(run_id=run_id)
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        async def run(self):
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

        def pending_publication(self):
            return pending

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "managed publication",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            }
        ),
    )

    assert captured["run_id"] == run_id
    assert captured["defer_publication"] is True
    assert captured["model_name"] == "run-start-model"
    assert context.take_pending_publication() is pending


@pytest.mark.asyncio
async def test_pipeline_function_tool_retains_cleanup_when_abort_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = "run_tool_abort_failure"
    context = RunContext(
        task_id="task_tool_abort_failure",
        base_dir=tmp_path / "tasks",
        managed_run_id=run_id,
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_abort_failure",
        tool_arguments="{}",
    )

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            pass

        async def run(self):
            raise RuntimeError("pipeline failed")

        def abort(self) -> None:
            raise OSError("abort failed")

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "failed managed publication",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            }
        ),
    )

    assert "abort failed" in result
    with pytest.raises(RuntimeError, match="already reserved"):
        context.reserve_pipeline_publication()
    cleanup = context.take_pending_publication()
    assert isinstance(cleanup, PendingPublicationCleanup)
    assert cleanup.run_id == run_id
    assert isinstance(cleanup.error, OSError)
    assert str(cleanup.error) == "abort failed"
    assert context.reserve_pipeline_publication() == run_id


@pytest.mark.asyncio
async def test_pipeline_function_tool_rejects_parallel_managed_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = "run_tool_parallel"
    context = RunContext(
        task_id="task_tool_parallel",
        base_dir=tmp_path / "tasks",
        managed_run_id=run_id,
    )
    started = asyncio.Event()
    release = asyncio.Event()
    constructed = 0
    pending = SimpleNamespace(run_id=run_id)

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            nonlocal constructed
            constructed += 1

        async def run(self):
            started.set()
            await release.wait()
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

        def pending_publication(self):
            return pending

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    def tool_context(call_id: str) -> ToolContext[RunContext]:
        return ToolContext(
            context=context,
            tool_name="run_research_pipeline",
            tool_call_id=call_id,
            tool_arguments="{}",
        )

    arguments = json.dumps(
        {
            "topic": "parallel managed invocation",
            "databases": ["pubmed", "geo"],
            "mode": "fixture",
        }
    )
    first = asyncio.create_task(
        run_research_pipeline.on_invoke_tool(tool_context("call_parallel_1"), arguments)
    )
    await asyncio.wait_for(started.wait(), timeout=1)

    second = await run_research_pipeline.on_invoke_tool(
        tool_context("call_parallel_2"),
        arguments,
    )

    result = json.loads(second)
    assert result["status"] == "already_run"
    assert constructed == 1
    release.set()
    await first
    assert context.take_pending_publication() is pending


@pytest.mark.asyncio
async def test_pipeline_function_tool_rejects_accession_for_unselected_database(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_mismatched_accession")
    context._work_dir = create_task_workdir(
        "task_tool_mismatched_accession", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_mismatched_accession",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "TP53 colorectal cancer",
                "databases": ["gdc"],
                "gse": "GSE256265",
                "gdc_project_id": "TCGA-COAD",
                "gdc_data_type": "gene-expression",
                "mode": "fixture",
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "invalid_input"
    assert payload["mismatched_arguments"] == ["gse"]
    assert context.pipeline_attempt_count == 0


@pytest.mark.asyncio
async def test_pipeline_function_tool_validates_gdc_arguments_before_reservation(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_missing_gdc_type")
    context._work_dir = create_task_workdir(
        "task_tool_missing_gdc_type", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_missing_gdc_type",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "TP53 colorectal cancer",
                "databases": ["gdc"],
                "gdc_project_id": "TCGA-COAD",
                "mode": "fixture",
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "invalid_input"
    assert payload["missing_arguments"] == ["gdc_data_type"]
    assert context.pipeline_attempt_count == 0


@pytest.mark.asyncio
async def test_pipeline_function_tool_reports_gdc_mutation_capability_gap(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_gdc_mutation_gap")
    context._work_dir = create_task_workdir(
        "task_tool_gdc_mutation_gap", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_gdc_mutation_gap",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "TP53 colorectal cancer mutations",
                "databases": ["gdc"],
                "gdc_project_id": "TCGA-COAD",
                "gdc_data_type": "somatic",
                "mode": "live",
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "capability_gap"
    assert payload["requested_data_type"] == "somatic"
    assert context.pipeline_attempt_count == 0


@pytest.mark.asyncio
async def test_pipeline_function_tool_explains_heterogeneous_path_boundary(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_heterogeneous_sources")
    context._work_dir = create_task_workdir(
        "task_tool_heterogeneous_sources", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_heterogeneous_sources",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "TP53 colorectal cancer",
                "databases": ["gdc", "geo", "pubmed"],
                "pmid": "12345678",
                "gse": "GSE256265",
                "gdc_project_id": "TCGA-COAD",
                "gdc_data_type": "gene-expression",
                "mode": "fixture",
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "unsupported_databases"
    assert payload["unsupported_databases"] == ["gdc", "geo", "pubmed"]
    assert payload["retryable"] is False
    assert ["gdc", "ucsc_xena"] in payload["supported_paths"]
    assert "separate evidence runs" in payload["next_step"]
    assert context.pipeline_attempt_count == 0


@pytest.mark.asyncio
async def test_pipeline_function_tool_rejects_unsupported_databases(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_extra_dbs")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool_extra_dbs", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_2",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "unsupported",
                "databases": ["pubmed", "geo", "pdb"],
                "mode": "fixture",
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "unsupported_databases"
    assert payload["unsupported_databases"] == ["pdb"]
    assert payload["retryable"] is False
    # TODO §1.4: Agent-only sources carry a declared capability so the Agent
    # knows the rejection is a capability boundary, not a retryable error.
    assert payload["capabilities"] == [
        {
            "database": "pdb",
            "capability": "research_only",
            "reason": "Agent-only investigation source; not accepted by the Pipeline",
        }
    ]
    assert not (
        tmp_path / "tasks" / "task_tool_extra_dbs" / "artifacts" / "run_manifest.json"
    ).exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("databases", "extra_arguments"),
    [
        (["pubmed"], {"pmid": "34180400"}),
        (
            ["pubmed", "gdc"],
            {
                "pmid": "34180400",
                "gdc_project_id": "TCGA-BRCA",
                "gdc_data_type": "gene-expression",
            },
        ),
    ],
)
async def test_pipeline_function_tool_rejects_unsupported_source_combinations(
    tmp_path: Path,
    databases: list[str],
    extra_arguments: dict[str, str],
) -> None:
    context = RunContext(task_id="task_tool_source_combination")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool_source_combination", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_source_combination",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "unsupported combination",
                "databases": databases,
                "mode": "fixture",
                **extra_arguments,
            }
        ),
    )

    payload = json.loads(result)
    assert payload["status"] == "unsupported_databases"
    assert payload["unsupported_databases"] == databases
    assert payload["retryable"] is False
    assert context.pipeline_attempt_count == 0


@pytest.mark.asyncio
async def test_pipeline_function_tool_accepts_json_string_databases(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Qwen serializes list params as JSON strings; tool must accept both."""
    context = RunContext(task_id="task_tool_str_dbs")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool_str_dbs", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_str_dbs",
        tool_arguments="{}",
    )
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)
            self.state = SimpleNamespace(stage_attempts=[])

        async def run(self):
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)
    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "json string databases",
                "databases": '["geo","pubmed"]',
                "pmid": "39847131",
                "gse": "GSE28735",
                "mode": "fixture",
            }
        ),
    )
    assert json.loads(result)["status"] == "completed"
    assert captured["databases"] == ["geo", "pubmed"]


@pytest.mark.asyncio
async def test_pipeline_function_tool_filters_research_only_from_preferred_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = RunContext(task_id="task_tool_filter_ro")
    context.preferred_sources = ["pdb", "pubchem", "geo", "pubmed"]
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool_filter_ro", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_filter_ro",
        tool_arguments="{}",
    )
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)
            self.state = SimpleNamespace(stage_attempts=[])

        async def run(self):
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)
    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "filter research only",
                "databases": None,
                "pmid": "39847131",
                "gse": "GSE28735",
                "mode": "fixture",
            }
        ),
    )
    assert json.loads(result)["status"] == "completed"
    assert captured["databases"] == ["geo", "pubmed"]


@pytest.mark.asyncio
async def test_pipeline_function_tool_forwards_run_cancellation_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = RunContext(task_id="task_tool_cancel_token")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        context.task_id,
        base_dir=str(tmp_path / "tasks"),
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_cancel",
        tool_arguments="{}",
    )
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        async def run(self):
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "cancellation token",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            }
        ),
    )

    assert captured["cancellation_requested"] is context.cancellation_requested
