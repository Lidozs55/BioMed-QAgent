"""Pydantic schemas for model configuration and catalog entries."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


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
        )

    @classmethod
    def default(cls) -> RunModelSettings:
        """Return the explicit standalone default without runtime lookup."""

        return cls.from_user_settings(UserSettings())
