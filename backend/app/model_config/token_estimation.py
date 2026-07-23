"""Local-only counting and deterministic Chat Completions prompt estimation."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlsplit

from agents.tool import FunctionTool

if TYPE_CHECKING:
    from app.model_config.context_budget import ContextBudget


class TextTokenCounter(Protocol):
    """Count tokens in one text fragment."""

    def count(self, text: str) -> int:
        """Return the token count for ``text``."""


type JsonScalar = None | bool | int | float | str
type JsonValue = JsonScalar | Mapping[str, "JsonValue"] | Sequence["JsonValue"]


def canonical_json(value: Mapping[str, JsonValue]) -> str:
    """Serialize a structured prompt value with compact deterministic JSON."""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def serialize_function_tool_schemas(tools: Sequence[FunctionTool]) -> tuple[str, ...]:
    """Return canonical Chat Completions schemas for the exact Agent tool list."""

    return tuple(
        json.dumps(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": tool.params_json_schema,
                    "strict": tool.strict_json_schema,
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        for tool in tools
    )


@dataclass(frozen=True, slots=True)
class ChatCompletionsStructuralPolicy:
    """Versioned constants for the complete Chat Completions request shape."""

    version: str = "chat_completions_v1"
    message_wrapper_tokens: int = 4
    assistant_priming_tokens: int = 2
    tool_envelope_tokens: int = 3


@dataclass(frozen=True, slots=True)
class ChatCompletionsPromptShape:
    """Exact resolved instructions and tool schemas supplied to an Agent build."""

    instructions: str
    serialized_tool_schemas: tuple[str, ...]
    policy: ChatCompletionsStructuralPolicy


@dataclass(frozen=True, slots=True)
class CandidateChatCompletionsPrompt:
    """Complete candidate session content and new input before an SDK call."""

    shape: ChatCompletionsPromptShape
    session_items: tuple[Mapping[str, JsonValue], ...]
    current_input: str
    resolved_instructions: str = ""
    """The exact instruction string the Agent will receive for this RunContext.

    Defaults to ``shape.instructions`` when the estimator is used outside
    a managed Run where no dynamic instructions are resolved."""

    def __post_init__(self) -> None:
        if not self.resolved_instructions:
            object.__setattr__(self, "resolved_instructions", self.shape.instructions)


@dataclass(frozen=True, slots=True)
class PromptTokenEstimate:
    """Observable deterministic components of a complete candidate prompt."""

    content_tokens: int
    message_wrapper_tokens: int
    instruction_tokens: int
    tool_schema_tokens: int
    current_input_tokens: int
    calibration_margin_tokens: int

    @property
    def total(self) -> int:
        """Return every prompt component without the ContextBudget safety reserve."""

        return (
            self.content_tokens
            + self.message_wrapper_tokens
            + self.instruction_tokens
            + self.tool_schema_tokens
            + self.current_input_tokens
            + self.calibration_margin_tokens
        )


@dataclass(frozen=True, slots=True)
class PromptTokenEstimator:
    """Estimate one candidate request using an injected local text counter."""

    counter: TextTokenCounter

    def estimate(
        self,
        prompt: CandidateChatCompletionsPrompt,
        budget: ContextBudget,
    ) -> PromptTokenEstimate:
        """Return separately observable Chat Completions prompt components."""

        policy = prompt.shape.policy
        tool_schemas = prompt.shape.serialized_tool_schemas
        tool_envelope_tokens = policy.tool_envelope_tokens if tool_schemas else 0
        return PromptTokenEstimate(
            content_tokens=sum(
                self.counter.count(canonical_json(item)) for item in prompt.session_items
            ),
            message_wrapper_tokens=(
                (len(prompt.session_items) + 2) * policy.message_wrapper_tokens
                + policy.assistant_priming_tokens
                + tool_envelope_tokens
            ),
            instruction_tokens=self.counter.count(prompt.resolved_instructions),
            tool_schema_tokens=sum(self.counter.count(schema) for schema in tool_schemas),
            current_input_tokens=self.counter.count(prompt.current_input),
            calibration_margin_tokens=budget.calibration_margin_tokens,
        )



class LocalTokenizer(Protocol):
    """Local tokenizer subset supplied by the optional DashScope SDK extra."""

    def encode(self, text: str) -> Sequence[int]:
        """Encode text into local token identifiers."""


LocalTokenizerFactory = Callable[[str], LocalTokenizer]


class ConservativeUtf8TokenCounter:
    """Dependency-free conservative counter used for every unsupported model."""

    def count(self, text: str) -> int:
        """Count empty text as zero and all other text by UTF-8 byte length."""

        if not text:
            return 0
        return len(text.encode("utf-8"))


@dataclass(frozen=True, slots=True)
class DashScopeLocalTokenizerAdapter:
    """Adapt DashScope's optional local tokenizer without making network calls."""

    _tokenizer: LocalTokenizer

    @classmethod
    def try_create(
        cls,
        model_name: str,
        tokenizer_factory: LocalTokenizerFactory | None = None,
    ) -> DashScopeLocalTokenizerAdapter | None:
        """Return a local tokenizer adapter when the optional model support exists."""

        if tokenizer_factory is None:
            try:
                from dashscope import get_tokenizer
                from dashscope.common.error import UnsupportedModel
            except ImportError:
                return None
            try:
                return cls(get_tokenizer(model_name))
            except UnsupportedModel:
                return None
            except (ImportError, RuntimeError, ValueError):
                return None
        try:
            return cls(tokenizer_factory(model_name))
        except (ImportError, RuntimeError, ValueError):
            return None

    def count(self, text: str) -> int:
        """Count local Qwen tokens through DashScope's encode interface."""

        return len(self._tokenizer.encode(text))


def select_text_token_counter(
    provider_origin: str,
    model_name: str,
    tokenizer_factory: LocalTokenizerFactory | None = None,
) -> TextTokenCounter:
    """Select a local Qwen counter only for DashScope-compatible Qwen/QwQ models."""

    if _uses_dashscope_compatible_qwen(provider_origin, model_name):
        adapter = DashScopeLocalTokenizerAdapter.try_create(model_name, tokenizer_factory)
        if adapter is not None:
            return adapter
    return ConservativeUtf8TokenCounter()


def _uses_dashscope_compatible_qwen(provider_origin: str, model_name: str) -> bool:
    """Return whether local DashScope Qwen tokenization is applicable."""

    parsed_origin = urlsplit(provider_origin)
    return (
        model_name.casefold().startswith(("qwen", "qwq"))
        and parsed_origin.hostname == "dashscope.aliyuncs.com"
        and parsed_origin.path.rstrip("/") == "/compatible-mode/v1"
    )
