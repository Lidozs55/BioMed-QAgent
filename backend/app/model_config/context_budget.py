"""Immutable model-aware context budgets resolved before a managed Run starts."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from math import ceil
from typing import Literal, Protocol
from urllib.parse import urlsplit

from .token_estimation import (
    DashScopeLocalTokenizerAdapter,
    LocalTokenizer,
    TextTokenCounter,
    select_text_token_counter,
)

DEFAULT_SAFETY_RESERVE_RATIO = 0.05
DEFAULT_COMPACTION_TRIGGER_RATIO = 0.85
DEFAULT_COMPACTION_TARGET_RATIO = 0.60
MINIMUM_SAFETY_RESERVE_TOKENS = 16_384


class BudgetSettings(Protocol):
    """Persisted settings fields required to resolve one context budget."""

    base_url: str
    model_name: str
    max_tokens: int
    context_window: int | None
    safety_reserve_ratio: float
    compaction_trigger_ratio: float
    compaction_target_ratio: float


class ContextBudgetConfigurationError(Exception):
    """A model configuration cannot produce a usable input budget."""

    reason: str

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason

    def __str__(self) -> str:
        return self.reason


class ContextBudgetOverflowError(ContextBudgetConfigurationError):
    """Raised when one complete prompt cannot fit a captured budget limit."""

    estimated_tokens: int
    limit_tokens: int

    def __init__(self, *, estimated_tokens: int, limit_tokens: int) -> None:
        self.estimated_tokens = estimated_tokens
        self.limit_tokens = limit_tokens
        super().__init__(
            "fixed prompt exceeds available input capacity "
            f"({estimated_tokens} estimated tokens > {limit_tokens} limit)"
        )


@dataclass(frozen=True, slots=True)
class ContextBudget:
    """Fixed context constraints captured by one managed Run."""

    context_window: int
    max_output_tokens: int
    safety_reserve_tokens: int
    trigger_tokens: int
    target_tokens: int
    provider_origin: str
    model_name: str
    tokenizer_kind: Literal["qwen_local", "conservative"]
    calibration_margin_tokens: int

    @property
    def input_capacity(self) -> int:
        """Return the token capacity available to the model input."""

        return self.context_window - self.max_output_tokens - self.safety_reserve_tokens


TokenizerFactory = Callable[[str], LocalTokenizer]


def resolve_context_budget(
    settings: BudgetSettings,
    *,
    tokenizer_factory: TokenizerFactory | None = None,
    calibration_margin_tokens: int = 0,
) -> ContextBudget:
    """Resolve one immutable budget from catalog metadata and explicit settings."""

    _validate_ratios(settings)
    context_window = _resolve_context_window(settings)
    provider_url = str(settings.base_url)
    safety_reserve_tokens = max(
        MINIMUM_SAFETY_RESERVE_TOKENS,
        ceil(context_window * settings.safety_reserve_ratio),
    )
    input_capacity = context_window - settings.max_tokens - safety_reserve_tokens
    if input_capacity <= 0:
        raise ContextBudgetConfigurationError("input capacity must be positive")
    if calibration_margin_tokens < 0:
        raise ContextBudgetConfigurationError("calibration margin must be non-negative")
    counter = select_text_token_counter(
        provider_url,
        settings.model_name,
        tokenizer_factory,
    )
    return ContextBudget(
        context_window=context_window,
        max_output_tokens=settings.max_tokens,
        safety_reserve_tokens=safety_reserve_tokens,
        trigger_tokens=ceil(input_capacity * settings.compaction_trigger_ratio),
        target_tokens=ceil(input_capacity * settings.compaction_target_ratio),
        provider_origin=normalize_provider_origin(provider_url),
        model_name=settings.model_name,
        tokenizer_kind=_tokenizer_kind(counter),
        calibration_margin_tokens=calibration_margin_tokens,
    )


def _resolve_context_window(settings: BudgetSettings) -> int:
    """Prefer a positive explicit override, otherwise preserve the catalog value."""

    if settings.context_window is not None:
        return settings.context_window
    from .catalog import get_known_model

    model = get_known_model(settings.model_name)
    if model is None:
        raise ContextBudgetConfigurationError("a positive context window is required")
    return model.context_window


def _validate_ratios(settings: BudgetSettings) -> None:
    """Validate cross-field context-budget constraints after Pydantic parsing."""

    if not 0 < settings.compaction_target_ratio < settings.compaction_trigger_ratio < 1:
        raise ContextBudgetConfigurationError("target ratio must be below trigger ratio")


def normalize_provider_origin(base_url: str) -> str:
    """Return the scheme-and-authority origin used for stable provider identity."""

    parsed_url = urlsplit(base_url)
    if parsed_url.scheme and parsed_url.hostname:
        port = parsed_url.port
        port_suffix = (
            f":{port}"
            if port is not None
            and (parsed_url.scheme.casefold(), port) not in {("http", 80), ("https", 443)}
            else ""
        )
        return (
            f"{parsed_url.scheme.casefold()}://{parsed_url.hostname.casefold()}"
            f"{port_suffix}"
        )
    return base_url


def _tokenizer_kind(counter: TextTokenCounter) -> Literal["qwen_local", "conservative"]:
    """Return the public tokenizer-kind value without exposing implementation details."""

    if isinstance(counter, DashScopeLocalTokenizerAdapter):
        return "qwen_local"
    return "conservative"
