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
