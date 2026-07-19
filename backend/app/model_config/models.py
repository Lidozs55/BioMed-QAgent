"""User model settings manager — persistence and Qwen model database.

Provides:
- ``UserSettings`` Pydantic model for base_url / api_key / model_name / max_tokens
- ``get_settings()`` / ``update_settings()`` backed by ``data/user_settings.json``
- Built-in Qwen model capability database with cross-reference helpers
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)

#: Path to the user-settings JSON file (relative to backend root).
_SETTINGS_PATH = Path(__file__).resolve().parent.parent / "data" / "user_settings.json"
_runtime_settings: UserSettings | None = None

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


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
    temperature: float = 0.7; top_p: float = 1.0
    repetition_penalty: float = 1.0; enable_search: bool = False; thinking_mode: bool = False
class UserSettings(BaseModel):
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    api_key: str = ""
    model_name: str = "qwen-plus"
    max_tokens: int = 8192
    advanced: AdvancedParams = AdvancedParams()
    advanced: AdvancedParams = AdvancedParams()


# ---------------------------------------------------------------------------
# Built-in Qwen model database
# ---------------------------------------------------------------------------

QWEN_MODELS_DB: dict[str, QwenModelEntry] = {
    # ── Flagship text models ──────────────────────────────────────────────
    "qwen-plus": QwenModelEntry(
        id="qwen-plus",
        name="Qwen Plus",
        description="Qwen 主力文本模型，平衡性能与成本，适合日常研究对话。",
        context_window=131_072,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
        recommended=True,
    ),
    "qwen-max": QwenModelEntry(
        id="qwen-max",
        name="Qwen Max",
        description="Qwen 最强文本模型，适合复杂推理、深度分析和长文档理解。",
        context_window=32_768,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwen-turbo": QwenModelEntry(
        id="qwen-turbo",
        name="Qwen Turbo",
        description="轻量快速模型，适合简单问答、摘要、分类等低延迟场景。",
        context_window=1_000_000,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True),
    ),
    # ── Vision-Language models ────────────────────────────────────────────
    "qwen-vl-max": QwenModelEntry(
        id="qwen-vl-max",
        name="Qwen VL Max",
        description="最强视觉语言模型，支持图像理解、图表提取、OCR。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True),
    ),
    "qwen-vl-plus": QwenModelEntry(
        id="qwen-vl-plus",
        name="Qwen VL Plus",
        description="视觉语言模型，支持图文理解，性价比高。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True),
    ),
    "qwen2.5-vl-72b-instruct": QwenModelEntry(
        id="qwen2.5-vl-72b-instruct",
        name="Qwen2.5 VL 72B",
        description="Qwen2.5 系列 72B 视觉语言模型，支持图像与视频理解。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True, video=True),
    ),
    "qwen2.5-vl-32b-instruct": QwenModelEntry(
        id="qwen2.5-vl-32b-instruct",
        name="Qwen2.5 VL 32B",
        description="Qwen2.5 系列 32B 视觉语言模型，支持图像与视频理解。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True, video=True),
    ),
    "qwen-vl-ocr": QwenModelEntry(
        id="qwen-vl-ocr",
        name="Qwen VL OCR",
        description="专注于 OCR 识别和文档数字化的视觉模型。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True),
    ),
    # ── Audio models ──────────────────────────────────────────────────────
    "qwen2-audio": QwenModelEntry(
        id="qwen2-audio",
        name="Qwen2 Audio",
        description="语音理解模型，支持语音识别、语音对话与音频分析。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, audio=True),
    ),
    # ── Omni (all modalities) ─────────────────────────────────────────────
    "qwen-omni-turbo": QwenModelEntry(
        id="qwen-omni-turbo",
        name="Qwen Omni Turbo",
        description="全模态模型（文本+图像+视频+音频），适合多模态交互场景。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True, video=True, audio=True),
    ),
    # ── Reasoning models ──────────────────────────────────────────────────
    "qwq-32b": QwenModelEntry(
        id="qwq-32b",
        name="QWQ 32B",
        description="推理增强模型（类 o1），擅长数学、逻辑和多步推理。",
        context_window=32_768,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwq-plus": QwenModelEntry(
        id="qwq-plus",
        name="QWQ Plus",
        description="新一代推理模型，更强的思维链与复杂推理能力。",
        context_window=131_072,
        suggested_max_tokens=16_384,
        capabilities=Capabilities(text=True),
    ),

    # ── Qwen3 models ──────────────────────────────────────────────────
    "qwen3-235b-a22b": QwenModelEntry(
        id="qwen3-235b-a22b",
        name="Qwen3 235B",
        description="Qwen3 系列 MoE 旗舰模型，235B 总参数/22B 激活",
        context_window=32_768, suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True, image=True)),
    "qwen-vl-max-0319": QwenModelEntry(
        id="qwen-vl-max-0319", name="Qwen VL Max 0319",
        description="最新视觉语言模型，支持图像、视频理解",
        context_window=131_072, suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True, image=True, video=True)),
    "qwen-plus-0419": QwenModelEntry(
        id="qwen-plus-0419", name="Qwen Plus 0419",
        description="最新文本主力模型，长上下文",
        context_window=1_000_000, suggested_max_tokens=16_384,
        capabilities=Capabilities(text=True), recommended=True),
    "qwen-turbo-0419": QwenModelEntry(
        id="qwen-turbo-0419", name="Qwen Turbo 0419",
        description="最新轻量文本模型，响应极快",
        context_window=1_000_000, suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True)),

    # ── Qwen3 models ──────────────────────────────────────────────────
    "qwen3-235b-a22b": QwenModelEntry(
        id="qwen3-235b-a22b",
        name="Qwen3 235B",
        description="Qwen3 系列 MoE 旗舰模型，235B 总参数/22B 激活",
        context_window=32_768, suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True, image=True)),
    "qwen-vl-max-0319": QwenModelEntry(
        id="qwen-vl-max-0319", name="Qwen VL Max 0319",
        description="最新视觉语言模型，支持图像、视频理解",
        context_window=131_072, suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True, image=True, video=True)),
    "qwen-plus-0419": QwenModelEntry(
        id="qwen-plus-0419", name="Qwen Plus 0419",
        description="最新文本主力模型，长上下文",
        context_window=1_000_000, suggested_max_tokens=16_384,
        capabilities=Capabilities(text=True), recommended=True),
    "qwen-turbo-0419": QwenModelEntry(
        id="qwen-turbo-0419", name="Qwen Turbo 0419",
        description="最新轻量文本模型，响应极快",
        context_window=1_000_000, suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True)),
    # ── Legacy models ─────────────────────────────────────────────────────
    "qwen2.5-72b-instruct": QwenModelEntry(
        id="qwen2.5-72b-instruct",
        name="Qwen2.5 72B Instruct",
        description="Qwen2.5 系列 72B 文本模型，适合大规模文本生成。",
        context_window=128_000,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwen2.5-32b-instruct": QwenModelEntry(
        id="qwen2.5-32b-instruct",
        name="Qwen2.5 32B Instruct",
        description="Qwen2.5 系列 32B 文本模型，三十二亿参数均衡之选。",
        context_window=128_000,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwen2.5-14b-instruct": QwenModelEntry(
        id="qwen2.5-14b-instruct",
        name="Qwen2.5 14B Instruct",
        description="Qwen2.5 系列 14B 文本模型，轻量部署首选。",
        context_window=128_000,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
}


# ---------------------------------------------------------------------------


# ── Vendor quick-select ──
class Vendor(BaseModel):
    id: str; name: str; base_url: str; description: str; recommended: bool = False

VENDORS = [
    Vendor(id="dashscope", name="DashScope", base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
           description="阿里云 Qwen 官方 API", recommended=True),
    Vendor(id="openai", name="OpenAI", base_url="https://api.openai.com/v1",
           description="OpenAI 官方 API"),
    Vendor(id="deepseek", name="DeepSeek", base_url="https://api.deepseek.com/v1",
           description="DeepSeek 系列模型 API"),
    Vendor(id="siliconflow", name="SiliconFlow", base_url="https://api.siliconflow.cn/v1",
           description="硅基流动，聚合多种模型"),
    Vendor(id="moonshot", name="Moonshot", base_url="https://api.moonshot.cn/v1",
           description="月之暗面 Kimi API"),
    Vendor(id="zhipu", name="ZhipuAI", base_url="https://open.bigmodel.cn/api/paas/v4",
           description="智谱 AI GLM 系列 API"),
    Vendor(id="baichuan", name="Baichuan", base_url="https://api.baichuan-ai.com/v1",
           description="百川智能 API"),
]
def get_vendors(): return list(VENDORS)


def infer_capabilities(mid: str):
    ml = mid.lower()
    if "omni" in ml: return Capabilities(text=True, image=True, video=True, audio=True)
    if "vl" in ml:
        c = Capabilities(text=True, image=True)
        if "2.5" in ml or "3" in ml: c.video = True
        return c
    if "audio" in ml: return Capabilities(text=True, audio=True)
    if ml.startswith("qwq") or "think" in ml: return Capabilities(text=True)
    if ml.startswith("qwen") or ml.startswith("gpt") or ml.startswith("deepseek"):
        return Capabilities(text=True)
    return Capabilities(text=True)

def augment_capabilities(mid, known=None):
    if known is not None: return known.capabilities
    return infer_capabilities(mid) or Capabilities(text=True)

def list_vendors(): return [v.model_dump() for v in VENDORS]
def get_advanced_defaults(): return AdvancedParams().model_dump()


# ── Vendor quick-select ──


def list_known_models() -> list[QwenModelEntry]:
    """Return all models in the built-in Qwen database, with recommended first."""
    models = list(QWEN_MODELS_DB.values())
    models.sort(key=lambda m: (not m.recommended, m.id))
    return models
