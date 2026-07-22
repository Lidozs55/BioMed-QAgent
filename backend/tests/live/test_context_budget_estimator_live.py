"""Marked live contract for the DashScope context-budget estimator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final, assert_never

import pytest
from agents import function_tool
from app.config import settings
from app.model_config.context_budget import ContextBudget, resolve_context_budget
from app.model_config.token_estimation import (
    CandidateChatCompletionsPrompt,
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    ConservativeUtf8TokenCounter,
    DashScopeLocalTokenizerAdapter,
    LocalTokenizer,
    PromptTokenEstimator,
    canonical_json,
    select_text_token_counter,
    serialize_function_tool_schemas,
)
from app.model_settings import ModelConfiguration, ModelSettingsStore
from openai import AsyncOpenAI

pytestmark = pytest.mark.live

_INSTRUCTIONS: Final = "Return one short confirmation. 请返回简短确认。"
_CURRENT_INPUT: Final = "Confirm the calibration fixture. 请确认校准样例。"
_DASHSCOPE_COMPATIBLE_BASE_URL: Final = "https://dashscope.aliyuncs.com/compatible-mode/v1"
_MODEL_NAME: Final = "qwen-plus"
_MODEL_CONTEXT_WINDOW: Final = 131_072
_SESSION_ITEMS: Final = (
    {"role": "user", "content": "Fixed English fixture. 固定中文样例。"},
    {"role": "assistant", "content": "Acknowledged. 已确认。"},
)


@function_tool(name_override="fixture_lookup")
def _fixture_lookup() -> str:
    """Return a fixed synthetic lookup result."""

    return "fixture"


_TOOL_SCHEMAS: Final = serialize_function_tool_schemas((_fixture_lookup,))


def _probe_optional_local_tokenizer() -> LocalTokenizer | None:
    """Return Qwen's local tokenizer or the documented unavailable result."""

    try:
        from dashscope import get_tokenizer
        from dashscope.common.error import UnsupportedModel
    except ImportError:
        return None
    try:
        return get_tokenizer(_MODEL_NAME)
    except UnsupportedModel:
        return None


def _expected_conservative_total(
    prompt: CandidateChatCompletionsPrompt,
    budget: ContextBudget,
) -> int:
    """Return the exact UTF-8-byte plus Chat Completions structural formula."""

    policy = prompt.shape.policy
    content_tokens = sum(
        len(canonical_json(item).encode("utf-8")) for item in prompt.session_items
    )
    message_wrapper_tokens = (
        (len(prompt.session_items) + 2) * policy.message_wrapper_tokens
        + policy.assistant_priming_tokens
        + policy.tool_envelope_tokens
    )
    instruction_tokens = len(prompt.resolved_instructions.encode("utf-8"))
    tool_schema_tokens = sum(len(schema.encode("utf-8")) for schema in _TOOL_SCHEMAS)
    current_input_tokens = len(prompt.current_input.encode("utf-8"))
    return (
        content_tokens
        + message_wrapper_tokens
        + instruction_tokens
        + tool_schema_tokens
        + current_input_tokens
        + budget.calibration_margin_tokens
    )


@pytest.mark.asyncio
async def test_context_budget_estimator_matches_authoritative_prompt_usage(
    tmp_path: Path,
) -> None:
    """Compare the complete estimator with final streamed provider prompt usage."""

    if not settings.dashscope_api_key:
        pytest.skip("DASHSCOPE_API_KEY is required; no provider request was constructed")

    local_tokenizer = _probe_optional_local_tokenizer()
    configuration = ModelConfiguration(
        base_url=_DASHSCOPE_COMPATIBLE_BASE_URL,
        api_key=settings.dashscope_api_key,
        model_name=_MODEL_NAME,
        max_tokens=1,
    )
    budget = resolve_context_budget(configuration)
    assert budget.context_window == _MODEL_CONTEXT_WINDOW
    counter = select_text_token_counter(
        str(configuration.base_url),
        configuration.model_name,
    )
    prompt = CandidateChatCompletionsPrompt(
        shape=ChatCompletionsPromptShape(
            instructions=_INSTRUCTIONS,
            serialized_tool_schemas=_TOOL_SCHEMAS,
            policy=ChatCompletionsStructuralPolicy(),
        ),
        session_items=_SESSION_ITEMS,
        current_input=_CURRENT_INPUT,
    )
    estimate = PromptTokenEstimator(counter).estimate(prompt, budget)

    match budget.tokenizer_kind:
        case "conservative":
            assert local_tokenizer is None
            assert isinstance(counter, ConservativeUtf8TokenCounter)
            assert estimate.total == _expected_conservative_total(prompt, budget)
        case "qwen_local":
            assert local_tokenizer is not None
            assert isinstance(counter, DashScopeLocalTokenizerAdapter)
            local_tokens = local_tokenizer.encode(_CURRENT_INPUT)
            assert counter.count(_CURRENT_INPUT) == len(local_tokens)
        case unreachable:
            assert_never(unreachable)
    print(f"tokenizer_kind={budget.tokenizer_kind}")

    async with AsyncOpenAI(
        api_key=settings.dashscope_api_key,
        base_url=_DASHSCOPE_COMPATIBLE_BASE_URL,
    ) as client:
        stream = await client.chat.completions.create(
            model=configuration.model_name,
            messages=[
                {"role": "system", "content": prompt.resolved_instructions},
                *prompt.session_items,
                {"role": "user", "content": prompt.current_input},
            ],
            tools=[json.loads(schema) for schema in prompt.shape.serialized_tool_schemas],
            tool_choice="none",
            max_tokens=1,
            stream=True,
            stream_options={"include_usage": True},
        )
        authoritative_prompt_tokens: int | None = None
        async for chunk in stream:
            if chunk.usage is not None:
                authoritative_prompt_tokens = chunk.usage.prompt_tokens

    assert authoritative_prompt_tokens is not None
    assert authoritative_prompt_tokens > 0
    pre_calibration_estimate = estimate.total - budget.calibration_margin_tokens
    residual = max(0, authoritative_prompt_tokens - pre_calibration_estimate)
    calibration_store = ModelSettingsStore(tmp_path / "settings" / "model.json")
    calibration_store.record_calibration_residual(budget, residual)
    assert calibration_store.calibration_margin_for(budget) == min(
        residual,
        budget.context_window // 10,
    )
