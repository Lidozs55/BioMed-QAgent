"""Pydantic schemas for model configuration and catalog entries."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .context_budget import ContextBudget, resolve_context_budget


class Capabilities(BaseModel):
    text: bool = True
    image: bool = False
    video: bool = False
    audio: bool = False


class QwenModelEntry(BaseModel):
    id: str
    name: str
    description: str
    context_window: int
    suggested_max_tokens: int
    capabilities: Capabilities
    recommended: bool = False


class AdvancedParams(BaseModel):
    temperature: float = 0.7
    top_p: float = 1.0
    repetition_penalty: float = 1.0
    enable_search: bool = False
    thinking_mode: bool = False


class UserSettings(BaseModel):
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    api_key: str = ""
    model_name: str = "qwen-plus"
    max_tokens: int = 8192
    context_window: int | None = Field(default=None, ge=1)
    safety_reserve_ratio: float = Field(default=0.05, ge=0, le=0.25)
    compaction_trigger_ratio: float = Field(default=0.85, gt=0, lt=1)
    compaction_target_ratio: float = Field(default=0.60, gt=0, lt=1)
    advanced: AdvancedParams = Field(default_factory=AdvancedParams)


class RunModelSettings(BaseModel):
    """Immutable model identity and credentials owned by one Run."""

    model_config = ConfigDict(frozen=True)

    base_url: str
    api_key: str
    model_name: str
    max_tokens: int
    temperature: float
    top_p: float
    repetition_penalty: float
    enable_search: bool
    thinking_mode: bool
    context_budget: ContextBudget

    @classmethod
    def from_user_settings(cls, settings: UserSettings) -> RunModelSettings:
        """Copy the model fields required for one isolated Run."""

        return cls(
            base_url=settings.base_url,
            api_key=settings.api_key,
            model_name=settings.model_name,
            max_tokens=settings.max_tokens,
            temperature=settings.advanced.temperature,
            top_p=settings.advanced.top_p,
            repetition_penalty=settings.advanced.repetition_penalty,
            enable_search=settings.advanced.enable_search,
            thinking_mode=settings.advanced.thinking_mode,
            context_budget=resolve_context_budget(settings),
        )

    @classmethod
    def default(cls) -> RunModelSettings:
        """Return the explicit standalone default without runtime lookup."""

        return cls.from_user_settings(UserSettings())
