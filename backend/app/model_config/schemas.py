"""Pydantic schemas for model configuration and catalog entries."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .context_budget import ContextBudget, resolve_context_budget


class RuntimeLimitsSettings(BaseModel):
    """Configurable agent round/time limits (see docs/REVIEW_2026-07-31 §4)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    #: 主 Agent 单段 max_turns；硬上限 = (max_turns_resume_limit + 1) × agent_max_turns。
    agent_max_turns: int = Field(default=240, ge=1)
    #: 主 Agent max_turns 暂停后的续跑次数上限（默认 3 → 硬上限 4×240=960 轮）。
    max_turns_resume_limit: int = Field(default=3, ge=0)
    #: 子代理（source research / skill builder）max_turns。
    child_agent_max_turns: int = Field(default=30, ge=1)
    #: 子代理墙钟超时（秒）；用户确认默认 1h。
    subagent_timeout_seconds: float = Field(default=3600.0, gt=0)

    #: 无进展检测滑动窗口（秒）；同指纹调用间隔超过窗口 → 先前计数作废。
    no_progress_window_seconds: float = Field(default=300.0, gt=0)
    #: 无进展判定阈值：同 (tool, args) 指纹在窗口内出现次数达到该值触发。
    no_progress_repeat_threshold: int = Field(default=3, ge=2)

    #: 进程内任务锁获取超时（秒）；Pipeline runner 的 TaskLock 使用。
    lock_timeout_seconds: float = Field(default=5.0, gt=0)
    #: 单次 HTTP 请求超时（秒）；acquisition skill 的 urllib 回退路径使用。
    http_timeout_seconds: float = Field(default=30.0, gt=0)
    #: HTTP 文件下载超时（秒）；acquisition skill 的大文件下载使用。
    http_download_timeout_seconds: float = Field(default=60.0, gt=0)
    #: 浏览器自动化超时（秒）；browser skill 的页面操作使用。
    browser_timeout_seconds: float = Field(default=120.0, gt=0)


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
    runtime_limits: RuntimeLimitsSettings = RuntimeLimitsSettings()

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
