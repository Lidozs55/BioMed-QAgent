"""Deterministic Chat Completions prompt-estimation tests — Task 2."""

from __future__ import annotations

import app.model_config.token_estimation as token_estimation
from app.model_config.context_budget import ContextBudget

# ---------------------------------------------------------------------------
# Scenario 2: Dict key order does not affect canonical JSON
# ---------------------------------------------------------------------------


def test_canonical_json_sorts_dict_keys_and_remains_compact() -> None:
    # Given
    first = {"z": [3, 2], "a": {"y": "\u4e2d", "x": "English"}}
    second = {"a": {"x": "English", "y": "\u4e2d"}, "z": [3, 2]}

    # When
    first_json = token_estimation.canonical_json(first)
    second_json = token_estimation.canonical_json(second)

    # Then
    assert first_json == '{"a":{"x":"English","y":"中"},"z":[3,2]}'
    assert second_json == first_json


# ---------------------------------------------------------------------------
# Scenario 1: Injected counters determine exact language-specific counts
# ---------------------------------------------------------------------------


class _WordCounter:
    """Counts English words for ASCII text, UTF-8 bytes for non-ASCII."""

    def count(self, text: str) -> int:
        if not text:
            return 0
        if text.isascii():
            return len(text.split())
        return len(text.encode("utf-8"))


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


def test_injected_counter_determines_exact_english_count() -> None:
    # Given
    counter = _WordCounter()
    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="You are a helper",
            serialized_tool_schemas=(),
            policy=token_estimation.ChatCompletionsStructuralPolicy(
                message_wrapper_tokens=0,
                assistant_priming_tokens=0,
                tool_envelope_tokens=0,
            ),
        ),
        session_items=({"role": "user", "content": "hello world"},),
        current_input="what answer",
    )

    # When
    estimate = token_estimation.PromptTokenEstimator(counter).estimate(prompt, _budget())

    # Then
    assert estimate.instruction_tokens == 4  # "You are a helper" -> 4 words
    assert estimate.current_input_tokens == 2  # "what answer" -> 2 words


def test_injected_counter_determines_exact_chinese_count() -> None:
    # Given
    counter = _WordCounter()
    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="你好世界",
            serialized_tool_schemas=(),
            policy=token_estimation.ChatCompletionsStructuralPolicy(
                message_wrapper_tokens=0,
                assistant_priming_tokens=0,
                tool_envelope_tokens=0,
            ),
        ),
        session_items=({"role": "user", "content": "中文测试"},),
        current_input="回答问题",
    )

    # When
    estimate = token_estimation.PromptTokenEstimator(counter).estimate(prompt, _budget())

    # Then
    assert estimate.instruction_tokens == len("你好世界".encode())


# ---------------------------------------------------------------------------
# Scenario 3: Components separately observable; total is their sum
# ---------------------------------------------------------------------------


class _CharCounter:
    def count(self, text: str) -> int:
        return len(text)


def test_estimator_keeps_chat_prompt_components_observable() -> None:
    # Given
    policy = token_estimation.ChatCompletionsStructuralPolicy()
    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="AB",
            serialized_tool_schemas=('{"name":"t"}',),
            policy=policy,
        ),
        session_items=(
            {"role": "user", "content": "English"},
            {"role": "assistant", "content": "中文"},
        ),
        current_input="mixed",
    )
    budget = ContextBudget(
        context_window=32_768,
        max_output_tokens=4096,
        safety_reserve_tokens=16_384,
        trigger_tokens=10_445,
        target_tokens=7_373,
        provider_origin="https://provider.example",
        model_name="model-a",
        tokenizer_kind="conservative",
        calibration_margin_tokens=7,
    )

    # When
    estimate = token_estimation.PromptTokenEstimator(_CharCounter()).estimate(prompt, budget)

    # Then
    assert policy.version == "chat_completions_v1"
    assert estimate.content_tokens == 70
    assert estimate.message_wrapper_tokens == 21
    assert estimate.instruction_tokens == 2
    assert estimate.tool_schema_tokens == 12
    assert estimate.current_input_tokens == 5
    assert estimate.calibration_margin_tokens == 7
    assert estimate.total == (70 + 21 + 2 + 12 + 5 + 7)


# ---------------------------------------------------------------------------
# Scenario 4: Conservative fallback equals UTF-8 byte count
# ---------------------------------------------------------------------------


def test_conservative_fallback_keeps_utf8_content_and_structure_separate() -> None:
    # Given
    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="指令",
            serialized_tool_schemas=(),
            policy=token_estimation.ChatCompletionsStructuralPolicy(),
        ),
        session_items=({"content": "A中", "role": "user"},),
        current_input="中",
    )
    budget = ContextBudget(
        context_window=1000,
        max_output_tokens=100,
        safety_reserve_tokens=100,
        trigger_tokens=680,
        target_tokens=480,
        provider_origin="https://provider.example",
        model_name="model-a",
        tokenizer_kind="conservative",
        calibration_margin_tokens=0,
    )

    # When
    estimate = token_estimation.PromptTokenEstimator(
        token_estimation.ConservativeUtf8TokenCounter()
    ).estimate(prompt, budget)

    # Then
    assert estimate.content_tokens == len('{"content":"A中","role":"user"}'.encode())
    assert estimate.instruction_tokens == len("指令".encode())
    assert estimate.current_input_tokens == len("中".encode())
    assert estimate.message_wrapper_tokens == 14
    assert estimate.tool_schema_tokens == 0


# ---------------------------------------------------------------------------
# Scenario 5: Safety reserve absent from estimate
# ---------------------------------------------------------------------------


def test_estimate_excludes_the_budget_safety_reserve() -> None:
    # Given
    prompt = token_estimation.CandidateChatCompletionsPrompt(
        shape=token_estimation.ChatCompletionsPromptShape(
            instructions="a",
            serialized_tool_schemas=(),
            policy=token_estimation.ChatCompletionsStructuralPolicy(
                message_wrapper_tokens=0,
                assistant_priming_tokens=0,
                tool_envelope_tokens=0,
            ),
        ),
        session_items=(),
        current_input="b",
    )
    budget = ContextBudget(
        context_window=1000,
        max_output_tokens=100,
        safety_reserve_tokens=100,
        trigger_tokens=680,
        target_tokens=480,
        provider_origin="https://provider.example",
        model_name="model-a",
        tokenizer_kind="conservative",
        calibration_margin_tokens=0,
    )

    # When
    estimate = token_estimation.PromptTokenEstimator(_CharCounter()).estimate(prompt, budget)

    # Then
    assert estimate.total == 2  # "a" + "b" only; no safety reserve


# ---------------------------------------------------------------------------
# Scenario 6: Provider origins normalize without collapsing distinct hosts
# ---------------------------------------------------------------------------


def test_normalize_provider_origin_collapses_case_preserves_distinct_hosts() -> None:
    from app.model_config.context_budget import normalize_provider_origin as norm

    assert norm("https://DashScope.Aliyuncs.COM") == "https://dashscope.aliyuncs.com"
    assert norm("HTTPS://DASHSCOPE.ALIYUNCS.COM/v1") == "https://dashscope.aliyuncs.com"
    assert norm("https://api.OpenAI.com") == "https://api.openai.com"
    assert norm("https://api.anthropic.com") == "https://api.anthropic.com"


def test_normalize_provider_origin_handles_ports() -> None:
    from app.model_config.context_budget import normalize_provider_origin as norm

    assert norm("http://localhost:8080/v1") == "http://localhost:8080"
    assert norm("http://example.com:80") == "http://example.com"
    assert norm("https://example.com:443") == "https://example.com"
