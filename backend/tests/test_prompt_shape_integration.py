"""Agent prompt-shape integration and tool-schema parity tests — Task 2 reviews."""

from __future__ import annotations

import json

import app.model_config.token_estimation as token_estimation
from app.model_config.context_budget import ContextBudget


# Shared helpers (also in test_token_estimation.py for estimation-only tests)
class _CharCounter:
    def count(self, text: str) -> int:
        return len(text)


def _budget() -> ContextBudget:
    return ContextBudget(
        context_window=10_000,
        max_output_tokens=100,
        safety_reserve_tokens=100,
        trigger_tokens=8_500,
        target_tokens=6_000,
        provider_origin="https://provider.example",
        model_name="model-a",
        tokenizer_kind="conservative",
        calibration_margin_tokens=0,
    )


# ---------------------------------------------------------------------------
# Agent integration: build_agent exposes exact instructions and tool schemas
# ---------------------------------------------------------------------------


def test_agent_build_exposes_prompt_shape_with_exact_instructions_and_tool_schemas() -> None:
    from app.agent_loop.agent import INSTRUCTIONS, build_agent
    from app.model_config import RunModelSettings

    # Given
    build = build_agent(model_settings=RunModelSettings.default())

    # When
    shape = build.prompt_shape

    # Then
    assert isinstance(shape, token_estimation.ChatCompletionsPromptShape)
    assert shape.instructions == INSTRUCTIONS
    serialized_names = {
        json.loads(s)["function"]["name"] for s in shape.serialized_tool_schemas
    }
    assert serialized_names == {tool.name for tool in build.agent.tools}


def test_instructions_guide_single_gene_analysis_to_gene_level_matrix() -> None:
    """REVIEW §3.2 (0805): the Agent prompt must guide single-gene differential
    analysis toward GDC/Xena gene-level matrices (gene symbol directly
    queryable, no probe→gene annotation step) instead of defaulting to
    probe-level GEO arrays.

    0809 §7.2 后：详细策略移入 research_data_guidance 技能（expression_omics
    /cleaning 专题），prompt 保留路由入口 + 兜底纪律。
    """
    from app.agent_loop.agent import INSTRUCTIONS

    # 路由入口（第 1 步）：通过技能加载表达谱/多组学专题指导，点名基因级 vs probe 级。
    assert "research_data_guidance" in INSTRUCTIONS
    assert "RNA-seq vs 微阵列" in INSTRUCTIONS
    assert "基因级 vs probe 级" in INSTRUCTIONS
    # 兜底纪律仍在 prompt：单基因/靶基因目标优先改用 GDC/Xena 基因级矩阵，
    # 不默认落到 probe 级 GEO 阵列。
    assert "若目标是单基因/靶基因分析" in INSTRUCTIONS
    assert "GDC/Xena 的基因级矩阵" in INSTRUCTIONS
    assert "microarray 优先于" in INSTRUCTIONS


def test_describe_geo_is_mandatory_vetting_gate_before_pipeline() -> None:
    """TODO §1.6 (0805 复核, REVIEW §7.2): GEO 候选数据集提交 pipeline 前
    必须强制调用 describe_geo 做相关性 vetting——0804 选错数据集（mitophagy
    聚焦阵列做共病机制）根因是未 vetting 即提交，工具已存在（skill 层），
    需要的是执行纪律的 prompt gate。"""
    from app.agent_loop.agent import INSTRUCTIONS

    # INSTRUCTIONS 必须把 describe_geo 设为 GEO 提交前的强制步骤，
    # 并要求不匹配主题的数据集不得提交（V1 工具已退役，vetting gate 纪律
    # 完全由 prompt 承载）。
    assert "describe_geo" in INSTRUCTIONS
    assert "vetting" in INSTRUCTIONS.lower() or "不匹配" in INSTRUCTIONS
    assert "未 vetting 的 GSE 不得提交给 `execute_dataset_build`" in INSTRUCTIONS
    # probe 平台必须在 spec 声明 AdapterParams（vetting 的 spec 侧纪律）。
    assert "AdapterParams" in INSTRUCTIONS


def test_instructions_require_gpl_annotation_via_mapping_files_for_probe_builds() -> None:
    """REVIEW_2026-08-09 §7.1 P0: probe 平台（微阵列）的基因级构建必须在
    prompt 中要求先下载 GPL 平台注释，并经 execute_dataset_build 的
    mapping_files 参数传入；无注释时不得用 probe 数据冒充基因级结果。"""
    from app.agent_loop.agent import INSTRUCTIONS

    assert "download_geo_platform_annotation" in INSTRUCTIONS
    assert "mapping_files" in INSTRUCTIONS
    assert "probe_release.v1" in INSTRUCTIONS


# ---------------------------------------------------------------------------
# C1/N1: SDK callback → shared resolver → estimator integration
# ---------------------------------------------------------------------------


def test_sdk_callback_and_estimator_consume_same_resolved_instructions() -> None:
    """C1/N1: Invoke the actual Agent SDK instructions callback for a
    RunContext with non-empty query_log and query_log_summary, compare with
    resolve_agent_instructions, then feed the resolved value into the
    estimator and assert instruction token count matches."""
    import asyncio

    from agents import RunContextWrapper
    from app.agent_loop.agent import (
        INSTRUCTIONS,
        build_agent,
        resolve_agent_instructions,
    )
    from app.agent_loop.context import RunContext
    from app.model_config import RunModelSettings

    # Given — RunContext with both query_log and query_log_summary
    ctx = RunContext(task_id="test")
    ctx.query_log_summary = "summary: three queries performed"
    ctx.query_log.append(
        {"query": "term A", "source": "pubmed", "status": "success", "records_count": 10}
    )
    ctx.query_log.append(
        {"query": "term B", "source": "geo", "status": "not_found", "records_count": 0}
    )

    # When — invoke the actual Agent's SDK instructions callback
    build = build_agent(model_settings=RunModelSettings.default())
    wrapper = RunContextWrapper(context=ctx)
    callback_result = asyncio.run(build.agent.instructions(wrapper, build.agent))

    # And resolve independently through the shared function
    resolver_result = resolve_agent_instructions(INSTRUCTIONS, ctx)

    # Then — callback and resolver produce identical strings
    assert callback_result == resolver_result
    assert callback_result.startswith(INSTRUCTIONS)
    assert callback_result != INSTRUCTIONS
    assert len(callback_result) > len(INSTRUCTIONS)

    # Feed the resolved value to the estimator
    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=build.prompt_shape,
        session_items=({"role": "user", "content": "hello"},),
        current_input="test input",
        resolved_instructions=callback_result,
    )
    budget = _budget()
    estimate = token_estimation.PromptTokenEstimator(_CharCounter()).estimate(prompt, budget)

    # The instruction tokens must equal the length of the resolved string
    assert estimate.instruction_tokens == len(callback_result)


# ---------------------------------------------------------------------------
# I1: Tool schemas include strict field and normalized parameters
# ---------------------------------------------------------------------------


def test_serialized_tool_schemas_include_strict_field() -> None:
    """I1: Every serialized function tool schema must include "strict": true
    and the normalised SDK fields (type, function.name, function.description,
    function.parameters)."""
    from agents.tool import FunctionTool

    def _noop(_ctx: object, _input: str) -> str:
        return "ok"

    tool = FunctionTool(
        name="search_pubmed",
        description="Search PubMed for articles",
        params_json_schema={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
        on_invoke_tool=_noop,
    )

    # When
    schemas = token_estimation.serialize_function_tool_schemas([tool])

    # Then
    assert len(schemas) == 1
    parsed = json.loads(schemas[0])
    assert parsed["type"] == "function"
    assert parsed["function"]["name"] == "search_pubmed"
    assert parsed["function"]["description"] == "Search PubMed for articles"
    assert parsed["function"]["strict"] is True
    assert "parameters" in parsed["function"]


# ---------------------------------------------------------------------------
# I3: Mixed ASCII+CJK input with independently known expected component counts
# ---------------------------------------------------------------------------


def test_mixed_ascii_cjk_input_has_independently_known_component_counts() -> None:
    """I3: Mixed English + Chinese content in instructions, session items,
    and current input must produce independently verifiable component counts."""
    counter = _CharCounter()
    policy = token_estimation.ChatCompletionsStructuralPolicy(
        message_wrapper_tokens=3,
        assistant_priming_tokens=1,
        tool_envelope_tokens=0,
    )
    instructions = "Hello 世界 test"
    session = ({"role": "user", "content": "mixed 中文 data"},)
    current = "final 输入"

    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions=instructions,
            serialized_tool_schemas=(),
            policy=policy,
        ),
        session_items=session,
        current_input=current,
        resolved_instructions=instructions,
    )

    # When
    estimate = token_estimation.PromptTokenEstimator(counter).estimate(prompt, _budget())

    # Then — independently verifiable:
    assert estimate.instruction_tokens == len(instructions)  # 16 chars
    assert estimate.current_input_tokens == len(current)     # 9 chars
    assert estimate.content_tokens == len(
        token_estimation.canonical_json(session[0])
    )  # canonical JSON length
    # message_wrapper_tokens = (1 session + 2) * 3 + 1 = 10
    assert estimate.message_wrapper_tokens == 10


# ---------------------------------------------------------------------------
# I4: Structural policy constants individually locked
# ---------------------------------------------------------------------------


def test_structural_policy_constants_are_individually_locked() -> None:
    """I4: The three default constants must be individually observable and
    verifiable, not just tested through an aggregate wrapper count."""
    policy = token_estimation.ChatCompletionsStructuralPolicy()

    # Then
    assert policy.message_wrapper_tokens == 4
    assert policy.assistant_priming_tokens == 2
    assert policy.tool_envelope_tokens == 3


def test_tool_envelope_tokens_only_applied_when_tools_present() -> None:
    """I4: tool_envelope_tokens must contribute zero when no tools are provided."""
    counter = _CharCounter()
    policy = token_estimation.ChatCompletionsStructuralPolicy()
    prompt_no_tools = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="",
            serialized_tool_schemas=(),
            policy=policy,
        ),
        session_items=(),
        current_input="",
        resolved_instructions="",
    )
    prompt_with_tools = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="",
            serialized_tool_schemas=('{"name":"t"}',),
            policy=policy,
        ),
        session_items=(),
        current_input="",
        resolved_instructions="",
    )

    est_no = token_estimation.PromptTokenEstimator(counter).estimate(prompt_no_tools, _budget())
    est_with = token_estimation.PromptTokenEstimator(counter).estimate(prompt_with_tools, _budget())

    # When no tools: 2 * 4 + 2 = 10. When tools: 2 * 4 + 2 + 3 = 13. Diff = 3.
    assert est_with.message_wrapper_tokens - est_no.message_wrapper_tokens == 3


# ---------------------------------------------------------------------------
# I5: Import-agent prompt-shape parity
# ---------------------------------------------------------------------------


def test_import_agent_build_exposes_prompt_shape_with_exact_instructions_and_tool_schemas() -> None:
    """I5: build_attachment_parsing_agent must expose a prompt_shape with
    exact IMPORT_INSTRUCTIONS and complete serialized tool schemas matching
    the actual SDK Agent tools, including strict field parity."""
    from app.agent_loop.import_agent import IMPORT_INSTRUCTIONS, build_attachment_parsing_agent
    from app.model_config import RunModelSettings

    # Given
    build = build_attachment_parsing_agent(model_settings=RunModelSettings.default())

    # When
    shape = build.prompt_shape
    actual_tool_names = {tool.name for tool in build.agent.tools}

    # Then — exact instruction parity from the actual production AgentBuild
    assert isinstance(shape, token_estimation.ChatCompletionsPromptShape)
    assert shape.instructions == IMPORT_INSTRUCTIONS
    assert len(shape.serialized_tool_schemas) == len(build.agent.tools)
    serialized_names: set[str] = set()
    for schema_str in shape.serialized_tool_schemas:
        parsed = json.loads(schema_str)
        serialized_names.add(parsed["function"]["name"])
        # Full schema equality with strict + description + parameters
        assert parsed["type"] == "function"
        assert "strict" in parsed["function"]
        assert "description" in parsed["function"]
        assert "parameters" in parsed["function"]
    assert serialized_names == actual_tool_names
