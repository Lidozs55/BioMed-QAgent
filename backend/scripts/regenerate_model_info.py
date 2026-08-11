"""Regenerate model_info providers and model_config catalogs.

Run from the repository root with the backend venv:

    backend/.venv/Scripts/python.exe backend/scripts/regenerate_model_info.py

Sources (verified 2026-08-11):
  - OpenAI: developers.openai.com/api/docs/models, /pricing
  - DeepSeek: api-docs.deepseek.com/quick_start/pricing
  - Alibaba Model Studio: help.aliyun.com/zh/model-studio/models (+ per-model pages)
  - Moonshot/Kimi: platform.kimi.com/docs/models.md + pricing/*.md
  - Zhipu: open.bigmodel.cn/pricing
  - MiniMax: platform.minimaxi.com/docs/guides/text-generation
  - Groq: console.groq.com/docs/models
  - xAI: docs.x.ai/developers/models/grok-4.5.md
  - Mistral: docs.mistral.ai + community model tracker
  - Baichuan: platform.baichuan-ai.com/prices
  - Relay standard data: models.dev provider tables
"""

# ruff: noqa: E501  -- data tables intentionally use long lines

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Entry: (id, name, description, vendor, family, ctx, max_out, suggested,
#         caps, cutoff, price_in, price_out, recommended)
# caps: "t"=text, "ti"=text+image, "tiv"=text+image+video,
#       "tiva"=text+image+video+audio, "ta"=text+audio, "a"=audio, "tv"=text+video

DASHSCOPE: list[tuple] = [
    ("qwen3.8-max", "Qwen3.8 Max", "阿里云百炼 Qwen3.8 旗舰模型，1M 上下文，支持文本、图片与视频理解。", "dashscope", "qwen3.8", 1_000_000, 131_072, 64_000, "tiv", None, 2.00, 6.00, True),
    ("qwen3.7-max", "Qwen3.7 Max", "Qwen3.7 系列旗舰文本模型，1M 上下文，面向复杂推理与长程任务。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "t", None, 2.50, 7.50, False),
    ("qwen3.7-max-2026-06-08", "Qwen3.7 Max 2026-06-08", "Qwen3.7 Max 快照版本（2026-06-08）。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "t", None, 2.50, 7.50, False),
    ("qwen3.7-max-2026-05-20", "Qwen3.7 Max 2026-05-20", "Qwen3.7 Max 快照版本（2026-05-20）。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "t", None, 2.50, 7.50, False),
    ("qwen3.7-max-preview", "Qwen3.7 Max Preview", "Qwen3.7 Max 预览版本，1M 上下文。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "t", None, 2.50, 7.50, False),
    ("qwen3.7-max-2026-05-17", "Qwen3.7 Max 2026-05-17", "Qwen3.7 Max 快照版本（2026-05-17）。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "t", None, 2.50, 7.50, False),
    ("qwen3.7-plus", "Qwen3.7 Plus", "Qwen3.7 Plus 多模态智能体模型，1M 上下文，支持文本、图片与视频输入。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "tiv", None, 0.50, 3.00, True),
    ("qwen3.7-plus-2026-05-26", "Qwen3.7 Plus 2026-05-26", "Qwen3.7 Plus 快照版本（2026-05-26）。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "tiv", None, 0.50, 3.00, False),
    ("qwen3.7-flash", "Qwen3.7 Flash", "Qwen3.7 Flash 轻量多模态模型，1M 上下文，低时延高吞吐。", "dashscope", "qwen3.7", 1_000_000, 131_072, 64_000, "tiv", None, 0.03, 0.12, False),
    ("qwen3.6-max-preview", "Qwen3.6 Max Preview", "Qwen3.6 系列预览旗舰模型，262K 上下文。", "dashscope", "qwen3.6", 262_144, 65_536, 64_000, "t", None, 1.30, 7.80, False),
    ("qwen3.6-plus", "Qwen3.6 Plus", "Qwen3.6 Plus 原生视觉语言模型，1M 上下文，支持文本、图片与视频输入。", "dashscope", "qwen3.6", 1_000_000, 65_536, 64_000, "tiv", None, 0.50, 3.00, False),
    ("qwen3.6-plus-2026-04-02", "Qwen3.6 Plus 2026-04-02", "Qwen3.6 Plus 快照版本（2026-04-02）。", "dashscope", "qwen3.6", 1_000_000, 65_536, 64_000, "tiv", None, 0.50, 3.00, False),
    ("qwen3.6-flash", "Qwen3.6 Flash", "Qwen3.6 Flash 轻量视觉语言模型，1M 上下文。", "dashscope", "qwen3.6", 1_000_000, 65_536, 64_000, "tiv", None, 0.19, 1.13, False),
    ("qwen3.6-flash-2026-04-16", "Qwen3.6 Flash 2026-04-16", "Qwen3.6 Flash 快照版本（2026-04-16）。", "dashscope", "qwen3.6", 1_000_000, 65_536, 64_000, "tiv", None, 0.19, 1.13, False),
    ("qwen3.6-27b", "Qwen3.6 27B", "Qwen3.6 开源 27B 文本模型，262K 上下文。", "dashscope", "qwen3.6", 262_144, 65_536, 64_000, "t", None, 0.60, 3.60, False),
    ("qwen3.6-35b-a3b", "Qwen3.6 35B A3B", "Qwen3.6 开源 35B-A3B 视觉语言模型，262K 上下文。", "dashscope", "qwen3.6", 262_144, 65_536, 64_000, "tiv", None, 0.25, 1.49, False),
    ("qwen3.5-plus", "Qwen3.5 Plus", "Qwen3.5 Plus 视觉语言模型，1M 上下文，支持文本、图片与视频输入。", "dashscope", "qwen3.5", 1_000_000, 65_536, 64_000, "tiv", None, 0.40, 2.40, False),
    ("qwen3.5-plus-2026-04-20", "Qwen3.5 Plus 2026-04-20", "Qwen3.5 Plus 快照版本（2026-04-20）。", "dashscope", "qwen3.5", 1_000_000, 65_536, 64_000, "tiv", None, 0.40, 2.40, False),
    ("qwen3.5-plus-2026-02-15", "Qwen3.5 Plus 2026-02-15", "Qwen3.5 Plus 快照版本（2026-02-15）。", "dashscope", "qwen3.5", 1_000_000, 65_536, 64_000, "tiv", None, 0.40, 2.40, False),
    ("qwen3.5-flash", "Qwen3.5 Flash", "Qwen3.5 Flash 轻量视觉语言模型，1M 上下文。", "dashscope", "qwen3.5", 1_000_000, 65_536, 64_000, "tiv", None, None, None, False),
    ("qwen3.5-flash-2026-02-23", "Qwen3.5 Flash 2026-02-23", "Qwen3.5 Flash 快照版本（2026-02-23）。", "dashscope", "qwen3.5", 1_000_000, 65_536, 64_000, "tiv", None, None, None, False),
    ("qwen3.5-397b-a17b", "Qwen3.5 397B A17B", "Qwen3.5 开源 397B-A17B 视觉语言模型，262K 上下文。", "dashscope", "qwen3.5", 262_144, 65_536, 64_000, "tiv", None, 0.60, 3.60, False),
    ("qwen3.5-122b-a10b", "Qwen3.5 122B A10B", "Qwen3.5 开源 122B-A10B 视觉语言模型，262K 上下文。", "dashscope", "qwen3.5", 262_144, 65_536, 64_000, "tiv", None, 0.40, 3.20, False),
    ("qwen3.5-27b", "Qwen3.5 27B", "Qwen3.5 开源 27B 视觉语言模型，262K 上下文。", "dashscope", "qwen3.5", 262_144, 65_536, 64_000, "tiv", None, 0.30, 2.40, False),
    ("qwen3.5-35b-a3b", "Qwen3.5 35B A3B", "Qwen3.5 开源 35B-A3B 视觉语言模型，262K 上下文。", "dashscope", "qwen3.5", 262_144, 65_536, 64_000, "tiv", None, 0.25, 2.00, False),
    ("qwen3.5-omni-plus", "Qwen3.5 Omni Plus", "Qwen3.5 全模态 HTTP 模型（文本+图片+视频+音频），262K 上下文。", "dashscope", "qwen-omni", 262_144, 65_536, 64_000, "tiva", None, None, None, False),
    ("qwen3.5-omni-plus-2026-03-15", "Qwen3.5 Omni Plus (2026-03-15)", "Qwen3.5 Omni Plus 快照版本（2026-03-15）。", "dashscope", "qwen-omni", 262_144, 65_536, 64_000, "tiva", None, None, None, False),
    ("qwen3.5-omni-flash", "Qwen3.5 Omni Flash", "Qwen3.5 全模态轻量模型（文本+图片+视频+音频），262K 上下文。", "dashscope", "qwen-omni", 262_144, 65_536, 64_000, "tiva", None, None, None, False),
    ("qwen3.5-omni-flash-2026-03-15", "Qwen3.5 Omni Flash (2026-03-15)", "Qwen3.5 Omni Flash 快照版本（2026-03-15）。", "dashscope", "qwen-omni", 262_144, 65_536, 64_000, "tiva", None, None, None, False),
    ("qwen3.5-omni-plus-realtime", "Qwen3.5 Omni Plus Realtime", "Qwen3.5 全模态实时对话模型，支持音视频实时交互。", "dashscope", "qwen-omni", 262_144, 65_536, 64_000, "tiva", None, None, None, False),
    ("qwen3-max", "Qwen3 Max", "Qwen3 旗舰文本模型，262K 上下文。", "dashscope", "qwen3", 262_144, 65_536, 64_000, "t", None, 1.20, 6.00, False),
    ("qwen3-max-2026-01-23", "Qwen3 Max 2026-01-23", "Qwen3 Max 快照版本（2026-01-23）。", "dashscope", "qwen3", 262_144, 65_536, 64_000, "t", None, 1.20, 6.00, False),
    ("qwen3-max-preview", "Qwen3 Max Preview", "Qwen3 Max 预览版本，262K 上下文。", "dashscope", "qwen3", 262_144, 65_536, 64_000, "t", None, 1.20, 6.00, False),
    ("qwen3-max-2025-09-23", "Qwen3 Max 2025-09-23", "Qwen3 Max 快照版本（2025-09-23）。", "dashscope", "qwen3", 262_144, 65_536, 64_000, "t", None, 1.20, 6.00, False),
    ("qwen3-coder-plus", "Qwen3 Coder Plus", "Qwen3 编程模型，1M 上下文，适合复杂编程任务。", "dashscope", "qwen-coder", 1_000_000, 65_536, 64_000, "t", None, 1.00, 5.00, False),
    ("qwen3-coder-plus-2025-09-23", "Qwen3 Coder Plus 2025-09-23", "Qwen3 Coder Plus 快照版本（2025-09-23）。", "dashscope", "qwen-coder", 1_000_000, 65_536, 64_000, "t", None, 1.00, 5.00, False),
    ("qwen3-coder-plus-2025-07-22", "Qwen3 Coder Plus 2025-07-22", "Qwen3 Coder Plus 快照版本（2025-07-22）。", "dashscope", "qwen-coder", 1_000_000, 65_536, 64_000, "t", None, 1.00, 5.00, False),
    ("qwen3-coder-flash", "Qwen3 Coder Flash", "Qwen3 高速编程模型，1M 上下文。", "dashscope", "qwen-coder", 1_000_000, 65_536, 64_000, "t", None, 0.30, 1.50, False),
    ("qwen3-coder-flash-2025-07-28", "Qwen3 Coder Flash 2025-07-28", "Qwen3 Coder Flash 快照版本（2025-07-28）。", "dashscope", "qwen-coder", 1_000_000, 65_536, 64_000, "t", None, 0.30, 1.50, False),
    ("qwen3-coder-next", "Qwen3 Coder Next", "Qwen3 下一代编程模型，262K 上下文。", "dashscope", "qwen-coder", 262_144, 65_536, 64_000, "t", None, None, None, False),
    ("qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B A35B Instruct", "Qwen3 Coder 开源 480B-A35B 指令模型，262K 上下文。", "dashscope", "qwen-coder", 262_144, 65_536, 64_000, "t", None, 1.50, 7.50, False),
    ("qwen3-coder-30b-a3b-instruct", "Qwen3 Coder 30B A3B Instruct", "Qwen3 Coder 开源 30B-A3B 指令模型，262K 上下文。", "dashscope", "qwen-coder", 262_144, 65_536, 64_000, "t", None, 0.45, 2.25, False),
    ("qwen3-235b-a22b", "Qwen3 235B A22B", "Qwen3 开源 MoE 模型（235B 总参/22B 激活），131K 上下文。", "dashscope", "qwen3", 131_072, 16_384, 16_000, "t", None, 0.70, 2.80, False),
    ("qwen3-235b-a22b-instruct-2507", "Qwen3 235B A22B Instruct 2507", "Qwen3 235B 指令快照版本（2507），131K 上下文。", "dashscope", "qwen3", 131_072, 32_768, 32_000, "t", None, None, None, False),
    ("qwen3-235b-a22b-thinking-2507", "Qwen3 235B A22B Thinking 2507", "Qwen3 235B 推理快照版本（2507），131K 上下文。", "dashscope", "qwen3", 131_072, 32_768, 32_000, "t", None, None, None, False),
    ("qwen3-next-80b-a3b-thinking", "Qwen3 Next 80B A3B Thinking", "Qwen3 Next 80B 推理模型，131K 上下文。", "dashscope", "qwen3", 131_072, 32_768, 32_000, "t", None, 0.50, 6.00, False),
    ("qwen3-next-80b-a3b-instruct", "Qwen3 Next 80B A3B Instruct", "Qwen3 Next 80B 指令模型，131K 上下文。", "dashscope", "qwen3", 131_072, 32_768, 32_000, "t", None, 0.50, 2.00, False),
    ("qwen3-32b", "Qwen3 32B", "Qwen3 开源 32B 文本模型，131K 上下文。", "dashscope", "qwen3", 131_072, 16_384, 16_000, "t", None, 0.70, 2.80, False),
    ("qwen3-30b-a3b", "Qwen3 30B A3B", "Qwen3 开源 30B-A3B 文本模型，131K 上下文。", "dashscope", "qwen3", 131_072, 16_384, 16_000, "t", None, None, None, False),
    ("qwen3-30b-a3b-instruct-2507", "Qwen3 30B A3B Instruct 2507", "Qwen3 30B-A3B 指令快照版本（2507），131K 上下文。", "dashscope", "qwen3", 131_072, 32_768, 32_000, "t", None, None, None, False),
    ("qwen3-30b-a3b-thinking-2507", "Qwen3 30B A3B Thinking 2507", "Qwen3 30B-A3B 推理快照版本（2507），131K 上下文。", "dashscope", "qwen3", 131_072, 32_768, 32_000, "t", None, None, None, False),
    ("qwen3-14b", "Qwen3 14B", "Qwen3 开源 14B 文本模型，131K 上下文。", "dashscope", "qwen3", 131_072, 8_192, 8_000, "t", None, 0.35, 1.40, False),
    ("qwen3-8b", "Qwen3 8B", "Qwen3 开源 8B 文本模型，131K 上下文。", "dashscope", "qwen3", 131_072, 8_192, 8_000, "t", None, 0.18, 0.70, False),
    ("qwen3-4b", "Qwen3 4B", "Qwen3 开源 4B 文本模型，131K 上下文。", "dashscope", "qwen3", 131_072, 8_192, 8_000, "t", None, None, None, False),
    ("qwen3-1.7b", "Qwen3 1.7B", "Qwen3 开源 1.7B 文本模型，32K 上下文。", "dashscope", "qwen3", 32_768, 8_192, 8_000, "t", None, None, None, False),
    ("qwen3-0.6b", "Qwen3 0.6B", "Qwen3 开源 0.6B 文本模型，32K 上下文。", "dashscope", "qwen3", 32_768, 8_192, 8_000, "t", None, None, None, False),
    ("qwen-flash", "Qwen Flash", "Qwen 高速文本模型，1M 超长上下文，适合低延迟任务。", "dashscope", "qwen", 1_000_000, 32_768, 32_000, "t", None, 0.05, 0.40, False),
    ("qwen-plus", "Qwen Plus", "Qwen 主力文本模型，平衡性能与成本，适合日常研究对话。", "dashscope", "qwen", 1_000_000, 32_768, 32_000, "t", None, 0.40, 1.20, True),
    ("qwen-plus-0419", "Qwen Plus 0419", "Qwen Plus 快照版本（0419），长上下文。", "dashscope", "qwen", 1_000_000, 16_384, 16_384, "t", None, None, None, False),
    ("qwen-max", "Qwen Max", "Qwen 最强文本模型，适合复杂推理、深度分析和长文档理解。", "dashscope", "qwen", 32_768, 8_192, 8_192, "t", None, 1.60, 6.40, False),
    ("qwen-turbo", "Qwen Turbo", "Qwen 轻量快速模型，适合简单问答、摘要、分类等低延迟场景。", "dashscope", "qwen", 1_000_000, 16_384, 4_096, "t", None, 0.05, 0.20, False),
    ("qwen-turbo-0419", "Qwen Turbo 0419", "Qwen Turbo 快照版本（0419），响应极快。", "dashscope", "qwen", 1_000_000, 4_096, 4_096, "t", None, None, None, False),
    ("qwq-plus", "QWQ Plus", "新一代推理模型，更强的思维链与复杂推理能力。", "dashscope", "qwq", 131_072, 8_192, 8_192, "t", None, 0.80, 2.40, False),
    ("qwq-32b", "QWQ 32B", "开源推理增强模型（类 o1），擅长数学、逻辑和多步推理。", "dashscope", "qwq", 131_072, 8_192, 8_192, "t", None, None, None, False),
    ("qwen-vl-max", "Qwen VL Max", "最强视觉语言模型，支持图像理解、图表提取、OCR。", "dashscope", "qwen-vl", 131_072, 8_192, 8_192, "ti", None, 0.80, 3.20, False),
    ("qwen-vl-max-0319", "Qwen VL Max 0319", "Qwen VL Max 快照版本（0319），支持图像与视频理解。", "dashscope", "qwen-vl", 131_072, 8_192, 8_192, "tiv", None, None, None, False),
    ("qwen-vl-plus", "Qwen VL Plus", "视觉语言模型，支持图文理解，性价比高。", "dashscope", "qwen-vl", 131_072, 8_192, 8_192, "ti", None, 0.21, 0.63, False),
    ("qwen-vl-ocr", "Qwen VL OCR", "专注于 OCR 识别和文档数字化的视觉模型。", "dashscope", "qwen-vl", 34_096, 4_096, 4_096, "ti", None, 0.72, 0.72, False),
    ("qwen3-vl-plus", "Qwen3 VL Plus", "Qwen3 视觉语言旗舰模型，支持函数调用与图像视频理解。", "dashscope", "qwen3-vl", 262_144, 32_768, 32_000, "tiv", None, 0.20, 1.60, False),
    ("qwen3-vl-flash", "Qwen3 VL Flash", "Qwen3 高速视觉语言模型，支持函数调用与图像视频理解。", "dashscope", "qwen3-vl", 262_144, 32_768, 32_000, "tiv", None, None, None, False),
    ("qwen3-vl-235b-a22b-instruct", "Qwen3 VL 235B A22B Instruct", "Qwen3 VL 开源 MoE 视觉指令模型，131K 上下文。", "dashscope", "qwen3-vl", 131_072, 32_768, 8_000, "tiv", None, 0.70, 2.80, False),
    ("qwen3-vl-32b-instruct", "Qwen3 VL 32B Instruct", "Qwen3 VL 开源 32B 视觉指令模型，131K 上下文。", "dashscope", "qwen3-vl", 131_072, 32_768, 8_000, "tiv", None, None, None, False),
    ("qwen3-vl-30b-a3b-instruct", "Qwen3 VL 30B A3B Instruct", "Qwen3 VL 开源 30B-A3B 视觉指令模型，131K 上下文。", "dashscope", "qwen3-vl", 131_072, 32_768, 8_000, "tiv", None, 0.20, 0.80, False),
    ("qwen3-vl-8b-instruct", "Qwen3 VL 8B Instruct", "Qwen3 VL 开源 8B 视觉指令模型，轻量部署。", "dashscope", "qwen3-vl", 131_072, 32_768, 8_000, "tiv", None, None, None, False),
    ("qwen2.5-vl-72b-instruct", "Qwen2.5 VL 72B Instruct", "Qwen2.5 VL 开源 72B 视觉语言模型，支持图像与视频理解。", "dashscope", "qwen2.5-vl", 128_000, 8_192, 8_000, "tiv", None, 2.80, 8.40, False),
    ("qwen2.5-vl-32b-instruct", "Qwen2.5 VL 32B Instruct", "Qwen2.5 VL 开源 32B 视觉语言模型，支持图像与视频理解。", "dashscope", "qwen2.5-vl", 128_000, 8_192, 8_000, "tiv", None, None, None, False),
    ("qwen2.5-vl-7b-instruct", "Qwen2.5 VL 7B Instruct", "Qwen2.5 VL 开源 7B 视觉语言模型，轻量部署。", "dashscope", "qwen2.5-vl", 128_000, 8_192, 8_000, "tiv", None, 0.35, 1.05, False),
    ("qwen2.5-vl-3b-instruct", "Qwen2.5 VL 3B Instruct", "Qwen2.5 VL 开源 3B 视觉语言模型，极致轻量。", "dashscope", "qwen2.5-vl", 128_000, 8_192, 8_000, "tiv", None, None, None, False),
    ("qwen2.5-72b-instruct", "Qwen2.5 72B Instruct", "Qwen2.5 开源 72B 文本模型，适合大规模文本生成。", "dashscope", "qwen2.5", 32_768, 8_192, 8_000, "t", None, 1.40, 5.60, False),
    ("qwen2.5-32b-instruct", "Qwen2.5 32B Instruct", "Qwen2.5 开源 32B 文本模型，性能均衡。", "dashscope", "qwen2.5", 32_768, 8_192, 8_000, "t", None, 0.70, 2.80, False),
    ("qwen2.5-14b-instruct", "Qwen2.5 14B Instruct", "Qwen2.5 开源 14B 文本模型，轻量部署首选。", "dashscope", "qwen2.5", 32_768, 8_192, 8_000, "t", None, 0.35, 1.40, False),
    ("qwen2.5-14b-instruct-1m", "Qwen2.5 14B Instruct 1M", "Qwen2.5 14B 长上下文文本模型，1M 上下文。", "dashscope", "qwen2.5", 1_000_000, 8_192, 8_000, "t", None, None, None, False),
    ("qwen2.5-7b-instruct", "Qwen2.5 7B Instruct", "Qwen2.5 开源 7B 文本模型，32K 上下文。", "dashscope", "qwen2.5", 32_768, 8_192, 8_000, "t", None, 0.17, 0.70, False),
    ("qwen2.5-7b-instruct-1m", "Qwen2.5 7B Instruct 1M", "Qwen2.5 7B 长上下文文本模型，1M 上下文。", "dashscope", "qwen2.5", 1_000_000, 8_192, 8_000, "t", None, None, None, False),
    ("qwen-omni-turbo", "Qwen Omni Turbo", "全模态模型（文本+图片+视频+音频），适合多模态交互场景。", "dashscope", "qwen-omni", 32_768, 2_048, 2_048, "tiva", None, 0.07, 0.27, False),
    ("qwen2-audio", "Qwen2 Audio", "语音理解模型，支持语音识别、语音对话与音频分析。", "dashscope", "qwen-audio", 32_768, 4_096, 4_096, "ta", None, None, None, False),
    ("fun-asr", "fun-asr", "阿里云语音识别模型。", "dashscope", "fun-asr", 32_768, 1, 1, "ta", None, None, None, False),
    ("fun-asr-realtime", "fun-asr-realtime", "阿里云实时语音识别模型。", "dashscope", "fun-asr", 32_768, 1, 1, "ta", None, None, None, False),
    ("fun-music-v1", "fun-music-v1", "阿里云 AI 音乐生成模型。", "dashscope", "fun-music", 1, 1, 1, "a", None, None, None, False),
    ("text-embedding-v4", "text-embedding-v4", "阿里云文本向量化模型。", "dashscope", "embedding", 8_192, 1, 1, "t", None, None, None, False),
    ("tongyi-embedding-vision-plus", "tongyi-embedding-vision-plus", "阿里云多模态向量化模型。", "dashscope", "embedding", 16_384, 1, 1, "ti", None, None, None, False),
    ("qwen3-rerank", "qwen3-rerank", "阿里云 Qwen3 重排序模型。", "dashscope", "embedding", 16_384, 1, 1, "t", None, None, None, False),
    ("wan2.7-image-pro", "wan2.7-image-pro", "阿里云万相文生图模型。", "dashscope", "wan", 1, 1, 1, "ti", None, None, None, False),
    ("qwen-image-3.0-pro", "qwen-image-3.0-pro", "阿里云 Qwen 文生图模型（3.0 Pro）。", "dashscope", "wan", 1, 1, 1, "ti", None, None, None, False),
    ("qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-plus", "阿里云 Qwen Audio 3.0 语音合成模型。", "dashscope", "qwen-audio", 1, 1, 1, "ta", None, None, None, False),
    ("qwen-audio-3.0-asr-flash-streaming", "qwen-audio-3.0-asr-flash-streaming", "阿里云 Qwen Audio 3.0 流式语音识别模型。", "dashscope", "qwen-audio", 1, 1, 1, "ta", None, None, None, False),
    ("qwen-audio-3.0-asr-flash-filetrans", "qwen-audio-3.0-asr-flash-filetrans", "阿里云 Qwen Audio 3.0 文件语音识别模型。", "dashscope", "qwen-audio", 1, 1, 1, "ta", None, None, None, False),
    ("qwen-audio-3.0-realtime-plus", "qwen-audio-3.0-realtime-plus", "阿里云 Qwen Audio 3.0 实时语音对话模型。", "dashscope", "qwen-audio", 1, 1, 1, "ta", None, None, None, False),
    # Third-party models served by DashScope (Alibaba Model Studio)
    ("deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", "DeepSeek V4 Flash（0731 检查点），1M 上下文，第三方直供。", "dashscope", "deepseek", 1_000_000, 384_000, 32_768, "t", None, 0.20, 0.40, False),
    ("kimi/kimi-k3", "Kimi K3", "Kimi 旗舰模型，1M 上下文，原生支持视觉理解，第三方直供。", "dashscope", "kimi", 1_048_576, 131_072, 32_768, "tiv", None, 3.00, 15.00, True),
]

OPENAI: list[tuple] = [
    ("gpt-4o", "GPT-4o", "OpenAI 多模态旗舰模型，支持图片、音频输入。", "openai", "gpt-4o", 128_000, 16_384, 16_384, "ti", "2023-10", 2.50, 10.00, False),
    ("gpt-4o-mini", "GPT-4o Mini", "GPT-4o 轻量版，性价比优秀，适合日常任务。", "openai", "gpt-4o", 128_000, 16_384, 16_384, "ti", "2023-10", 0.15, 0.60, False),
    ("gpt-4-turbo", "GPT-4 Turbo", "OpenAI GPT-4 Turbo 模型，支持 128K 上下文。", "openai", "gpt-4", 128_000, 4_096, 4_096, "ti", "2023-12", 10.00, 30.00, False),
    ("gpt-4", "GPT-4", "OpenAI GPT-4 基础模型，稳定可靠（已弃用）。", "openai", "gpt-4", 8_192, 8_192, 4_096, "t", "2023-09", 30.00, 60.00, False),
    ("gpt-4.1", "GPT-4.1", "GPT-4.1 智能非推理模型，1M 上下文。", "openai", "gpt-4", 1_047_576, 32_768, 32_768, "ti", None, 2.00, 8.00, False),
    ("gpt-4.1-mini", "GPT-4.1 Mini", "GPT-4.1 轻量版，更小更快。", "openai", "gpt-4", 1_047_576, 32_768, 32_768, "ti", None, 0.40, 1.60, False),
    ("gpt-4.1-nano", "GPT-4.1 Nano", "GPT-4.1 最快速、最具成本效益的版本。", "openai", "gpt-4", 1_047_576, 32_768, 32_768, "ti", None, 0.10, 0.40, False),
    ("o1", "o1", "OpenAI o1 推理模型，擅长复杂数学、科学推理（已弃用）。", "openai", "o1", 200_000, 100_000, 32_768, "ti", "2023-10", 15.00, 60.00, False),
    ("o3", "o3", "OpenAI o3 推理模型，用于复杂任务。", "openai", "o3", 200_000, 100_000, 32_768, "ti", None, 2.00, 8.00, False),
    ("o3-mini", "o3 Mini", "OpenAI o3 轻量推理模型，支持可调推理力度（已弃用）。", "openai", "o3", 200_000, 100_000, 32_768, "ti", "2023-10", 1.10, 4.40, False),
    ("o3-pro", "o3 Pro", "o3 高算力版本，产生更好响应。", "openai", "o3", 200_000, 100_000, 32_768, "ti", None, 20.00, 80.00, False),
    ("o4-mini", "o4 Mini", "快速、经济的推理模型（已弃用，建议使用 GPT-5 mini）。", "openai", "o3", 200_000, 100_000, 32_768, "ti", None, 1.10, 4.40, False),
    ("gpt-5", "GPT-5", "GPT-5 智能推理模型，支持可配置推理力度。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 1.25, 10.00, False),
    ("gpt-5-mini", "GPT-5 Mini", "接近前沿智能的经济型模型，低延迟高吞吐。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 0.25, 2.00, False),
    ("gpt-5-nano", "GPT-5 Nano", "最快、最具成本效益的 GPT-5 版本。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 0.05, 0.40, False),
    ("gpt-5-pro", "GPT-5 Pro", "GPT-5 高算力版本，产生更精准的响应。", "openai", "gpt-5", 400_000, 272_000, 32_768, "ti", None, 15.00, 120.00, False),
    ("gpt-5.1", "GPT-5.1", "GPT-5.1 编码与智能体任务最佳模型，支持可配置推理力度。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 1.25, 10.00, False),
    ("gpt-5.2", "GPT-5.2", "上一代旗舰模型，支持可配置推理力度。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 1.75, 14.00, False),
    ("gpt-5.2-pro", "GPT-5.2 Pro", "GPT-5.2 高算力版本，产生更精准的响应。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 21.00, 168.00, False),
    ("gpt-5.3-codex", "GPT-5.3 Codex", "最强大的智能体编码模型。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 1.75, 14.00, False),
    ("gpt-5.4", "GPT-5.4", "面向编码与专业工作的平价模型。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", None, 2.50, 15.00, False),
    ("gpt-5.4-pro", "GPT-5.4 Pro", "GPT-5.4 高算力版本，产生更精准的响应。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", None, 30.00, 180.00, False),
    ("gpt-5.4-mini", "GPT-5.4 Mini", "最强的 mini 模型，适合编码、Computer Use 与子代理。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 0.75, 4.50, False),
    ("gpt-5.4-nano", "GPT-5.4 Nano", "最便宜的 GPT-5.4 级模型，适合高吞吐简单任务。", "openai", "gpt-5", 400_000, 128_000, 32_768, "ti", None, 0.20, 1.25, False),
    ("gpt-5.5", "GPT-5.5", "GPT-5.5 前沿模型，适用于最复杂的专业工作。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", "2025-12", 5.00, 30.00, False),
    ("gpt-5.5-pro", "GPT-5.5 Pro", "GPT-5.5 高算力版本，产生更精准的响应。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", "2025-12", 30.00, 180.00, False),
    ("gpt-5.6", "GPT-5.6", "GPT-5.6 旗舰模型别名（指向 GPT-5.6 Sol）。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", "2026-02", 5.00, 30.00, False),
    ("gpt-5.6-luna", "GPT-5.6 Luna", "GPT-5.6 经济型模型，面向高吞吐成本敏感场景。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", "2026-02", 0.20, 1.20, False),
    ("gpt-5.6-terra", "GPT-5.6 Terra", "GPT-5.6 平衡智能与成本的模型。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", "2026-02", 2.00, 12.00, False),
    ("gpt-5.6-sol", "GPT-5.6 Sol", "GPT-5.6 旗舰模型，适用于复杂推理与编码。", "openai", "gpt-5", 1_050_000, 128_000, 32_768, "ti", "2026-02", 5.00, 30.00, True),
]

DEEPSEEK: list[tuple] = [
    ("deepseek-v4-flash", "DeepSeek V4 Flash", "DeepSeek V4 Flash 高速对话模型，1M 上下文，支持思考与非思考模式。", "deepseek", "deepseek", 1_000_000, 384_000, 32_768, "t", None, 0.14, 0.28, True),
    ("deepseek-v4-pro", "DeepSeek V4 Pro", "DeepSeek V4 Pro 旗舰模型，1M 上下文，更强推理能力。", "deepseek", "deepseek", 1_000_000, 384_000, 32_768, "t", None, 0.435, 0.87, False),
    ("deepseek-chat", "DeepSeek Chat", "DeepSeek 对话模型别名（已于 2026-07-24 弃用，路由至 V4 Flash）。", "deepseek", "deepseek", 128_000, 8_192, 8_192, "t", None, 0.14, 0.28, False),
    ("deepseek-reasoner", "DeepSeek Reasoner", "DeepSeek 推理模型别名（已于 2026-07-24 弃用，路由至 V4 Flash 思考模式）。", "deepseek", "deepseek-r1", 128_000, 64_000, 32_768, "t", None, 0.14, 0.28, False),
    ("deepseek-v3", "DeepSeek V3", "DeepSeek V3 开源模型（中转站常用 ID）。", "deepseek", "deepseek", 164_000, 16_384, 8_192, "t", None, 0.25, 1.00, False),
    ("deepseek-r1", "DeepSeek R1", "DeepSeek R1 开源推理模型（中转站常用 ID）。", "deepseek", "deepseek-r1", 164_000, 16_384, 8_192, "t", None, 0.50, 2.18, False),
]

MOONSHOT: list[tuple] = [
    ("moonshot-v1-8k", "Moonshot V1 8K", "月之暗面 Kimi 模型，8K 上下文版本。", "moonshot", "moonshot-v1", 8_192, 4_096, 4_096, "t", None, None, None, False),
    ("moonshot-v1-32k", "Moonshot V1 32K", "月之暗面 Kimi 模型，32K 上下文版本。", "moonshot", "moonshot-v1", 32_768, 8_192, 8_192, "t", None, None, None, False),
    ("moonshot-v1-128k", "Moonshot V1 128K", "月之暗面 Kimi 模型，128K 上下文版本，适合长文档分析。", "moonshot", "moonshot-v1", 131_072, 8_192, 8_192, "t", None, None, None, False),
    ("kimi-k3", "Kimi K3", "Kimi 旗舰模型，1M 上下文，原生支持视觉理解，面向软件工程与深度推理。", "moonshot", "kimi", 1_048_576, 131_072, 32_768, "tiv", None, 3.00, 15.00, True),
    ("kimi-k2.7-code", "Kimi K2.7 Code", "Kimi 编程模型，256K 上下文，长上下文指令遵循更可靠。", "moonshot", "kimi", 262_144, 262_144, 32_768, "tiv", None, 0.95, 4.00, False),
    ("kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", "Kimi K2.7 Code 高速版，输出约 180 Tokens/s。", "moonshot", "kimi", 262_144, 262_144, 32_768, "tiv", None, 1.90, 8.00, False),
    ("kimi-k2.6", "Kimi K2.6", "Kimi 通用模型，256K 上下文，支持思考与非思考模式。", "moonshot", "kimi", 262_144, 262_144, 32_768, "tiv", None, 0.95, 4.00, False),
    ("kimi-k2.5", "Kimi K2.5", "Kimi 多模态模型，256K 上下文（2026-08-31 起停止服务）。", "moonshot", "kimi", 262_144, 262_144, 32_768, "tiv", None, 0.60, 3.00, False),
]

ZHIPU: list[tuple] = [
    ("glm-4-plus", "GLM-4 Plus", "智谱 AI GLM-4 旗舰模型，支持 128K 上下文。", "zhipu", "glm-4", 128_000, 8_192, 8_192, "t", None, None, None, False),
    ("glm-4-flash", "GLM-4 Flash", "智谱 AI GLM-4 轻量快速模型。", "zhipu", "glm-4", 128_000, 4_096, 4_096, "t", None, None, None, False),
    ("glm-4v-plus", "GLM-4V Plus", "智谱 AI GLM-4V 多模态模型，支持图片理解。", "zhipu", "glm-4v", 128_000, 4_096, 4_096, "ti", None, None, None, False),
    ("glm-4-long", "GLM-4 Long", "智谱 AI GLM-4-Long 超长文本模型，支持 1M 上下文。", "zhipu", "glm-4", 1_000_000, 4_096, 4_096, "t", None, None, None, False),
    ("glm-4-flash-250414", "GLM-4 Flash 250414", "智谱 AI GLM-4-Flash-250414 免费模型。", "zhipu", "glm-4", 128_000, 32_768, 32_768, "t", None, 0.0, 0.0, False),
    ("glm-4.5", "GLM-4.5", "智谱 AI GLM-4.5 模型，128K 上下文，支持思考模式与工具调用。", "zhipu", "glm-4.5", 131_072, 98_304, 65_536, "t", None, 0.60, 2.20, True),
    ("glm-4.5-air", "GLM-4.5 Air", "智谱 AI GLM-4.5-Air 轻量版，兼顾性能与成本。", "zhipu", "glm-4.5", 131_072, 98_304, 65_536, "t", None, 0.20, 1.10, False),
    ("glm-4.5-flash", "GLM-4.5 Flash", "智谱 AI GLM-4.5-Flash 免费模型。", "zhipu", "glm-4.5", 131_072, 98_304, 65_536, "t", None, 0.0, 0.0, False),
    ("glm-4.5v", "GLM-4.5V", "智谱 AI GLM-4.5V 视觉推理模型。", "zhipu", "glm-4v", 64_000, 16_384, 16_384, "ti", None, 0.60, 1.80, False),
    ("glm-4.6", "GLM-4.6", "智谱 AI GLM-4.6 高级编码、复杂推理与工具调用模型，200K 上下文。", "zhipu", "glm-4.5", 204_800, 131_072, 65_536, "t", None, 0.60, 2.20, False),
    ("glm-4.6v", "GLM-4.6V", "智谱 AI GLM-4.6V 视觉推理模型，原生支持工具调用与长上下文。", "zhipu", "glm-4v", 128_000, 32_768, 32_768, "ti", None, 0.30, 0.90, False),
    ("glm-4.7", "GLM-4.7", "智谱 AI GLM-4.7 通用对话、推理与智能体能力全面升级，200K 上下文。", "zhipu", "glm-4.5", 204_800, 131_072, 65_536, "t", None, 0.60, 2.20, False),
    ("glm-4.7-flash", "GLM-4.7 Flash", "智谱 AI GLM-4.7-Flash 免费轻量模型，200K 上下文。", "zhipu", "glm-4.5", 200_000, 131_072, 65_536, "t", None, 0.0, 0.0, False),
    ("glm-4.7-flashx", "GLM-4.7 FlashX", "智谱 AI GLM-4.7-FlashX 高速低价模型，200K 上下文。", "zhipu", "glm-4.5", 200_000, 131_072, 65_536, "t", None, 0.07, 0.40, False),
    ("glm-5", "GLM-5", "智谱 AI GLM-5 旗舰模型，200K 上下文，擅长 Agentic 长程规划与执行。", "zhipu", "glm-5", 204_800, 131_072, 65_536, "t", None, 1.00, 3.20, False),
    ("glm-5-turbo", "GLM-5 Turbo", "智谱 AI GLM-5-Turbo 高速版，200K 上下文。", "zhipu", "glm-5", 200_000, 131_072, 65_536, "t", None, 1.20, 4.00, False),
    ("glm-5.1", "GLM-5.1", "智谱 AI GLM-5.1 高性能模型，200K 上下文，擅长复杂代码与长程任务。", "zhipu", "glm-5", 200_000, 131_072, 65_536, "t", None, 1.40, 4.40, False),
    ("glm-5.2", "GLM-5.2", "智谱 AI GLM-5.2 旗舰模型，1M 上下文，专为长程任务设计。", "zhipu", "glm-5", 1_000_000, 131_072, 65_536, "t", None, 1.40, 4.40, True),
    ("glm-5v-turbo", "GLM-5V Turbo", "智谱 AI GLM-5V-Turbo 多模态 Agent 基座模型，支持图像、视频、文本输入。", "zhipu", "glm-4v", 200_000, 131_072, 65_536, "tiv", None, 1.20, 4.00, False),
    ("glm-4.6v-flash", "GLM-4.6V Flash", "智谱 AI GLM-4.6V-Flash 免费视觉模型，128K 上下文。", "zhipu", "glm-4v", 128_000, 32_768, 16_384, "ti", None, 0.0, 0.0, False),
    ("glm-4.6v-flashx", "GLM-4.6V FlashX", "智谱 AI GLM-4.6V-FlashX 轻量高速视觉模型，128K 上下文。", "zhipu", "glm-4v", 128_000, 32_768, 16_384, "ti", None, None, None, False),
    ("glm-4v-flash", "GLM-4V Flash", "智谱 AI GLM-4V-Flash 免费模型，支持基础图像理解。", "zhipu", "glm-4v", 16_000, 1_024, 1_024, "ti", None, None, None, False),
]

BAICHUAN: list[tuple] = [
    ("baichuan4", "Baichuan4", "百川智能旗舰模型，支持 32K 上下文。", "baichuan", "baichuan", 32_768, 4_096, 4_096, "t", None, None, None, False),
    ("baichuan4-turbo", "Baichuan4 Turbo", "百川智能 Baichuan4-Turbo 模型，32K 上下文。", "baichuan", "baichuan", 32_768, 4_096, 4_096, "t", None, None, None, False),
    ("baichuan4-air", "Baichuan4 Air", "百川智能 Baichuan4-Air 经济型模型，32K 上下文。", "baichuan", "baichuan", 32_768, 4_096, 4_096, "t", None, None, None, False),
    ("baichuan3-turbo", "Baichuan3 Turbo", "百川智能轻量快速模型，适合日常对话。", "baichuan", "baichuan", 32_768, 4_096, 4_096, "t", None, None, None, False),
    ("baichuan3-turbo-128k", "Baichuan3 Turbo 128K", "百川智能 Baichuan3-Turbo 长上下文版本，128K。", "baichuan", "baichuan", 131_072, 4_096, 4_096, "t", None, None, None, False),
    ("baichuan-m3-plus", "Baichuan M3 Plus", "百川智能当前主力模型，32K 上下文，自动触发医疗搜索。", "baichuan", "baichuan", 32_768, 4_096, 4_096, "t", None, None, None, True),
    ("baichuan-m3", "Baichuan M3", "百川智能 Baichuan-M3 模型，32K 上下文。", "baichuan", "baichuan", 32_768, 4_096, 4_096, "t", None, None, None, False),
]

GROQ: list[tuple] = [
    ("meta-llama/llama-4-scout-17b-16e-instruct", "Llama 4 Scout", "Groq 托管的 Meta Llama 4 Scout 17B 模型，128K 上下文，支持视觉与工具调用。", "groq", "llama", 131_072, 8_192, 8_192, "ti", "2024-08", 0.11, 0.34, False),
    ("llama-3.3-70b-versatile", "Llama 3.3 70B", "Groq 托管的 Meta Llama 3.3 70B 模型，131K 上下文。", "groq", "llama", 131_072, 32_768, 32_768, "t", None, 0.59, 0.79, True),
    ("llama-3.1-8b-instant", "Llama 3.1 8B", "Groq 托管的 Meta Llama 3.1 8B 模型，131K 上下文。", "groq", "llama", 131_072, 131_072, 32_768, "t", None, 0.05, 0.08, False),
    ("openai/gpt-oss-120b", "GPT OSS 120B", "OpenAI 开源 GPT-OSS 120B 模型，支持推理与工具调用。", "groq", "llama", 131_072, 65_536, 32_768, "t", None, 0.15, 0.60, False),
    ("openai/gpt-oss-20b", "GPT OSS 20B", "OpenAI 开源 GPT-OSS 20B 模型。", "groq", "llama", 131_072, 65_536, 32_768, "t", None, 0.075, 0.30, False),
    ("qwen/qwen3.6-27b", "Qwen3.6 27B", "Groq 托管的 Qwen3.6-27B 模型，131K 上下文。", "groq", "qwen3.6", 131_072, 16_384, 16_384, "t", None, 0.60, 3.00, False),
]

XAI: list[tuple] = [
    ("grok-4.5", "Grok 4.5", "xAI Grok 4.5 旗舰模型，500K 上下文，可配置推理力度，支持图像输入。", "xai", "grok", 500_000, 500_000, 32_768, "ti", None, 2.00, 6.00, True),
    ("grok-4.3", "Grok 4.3", "xAI Grok 4.3 模型，1M 上下文，支持视觉输入与工具调用。", "xai", "grok", 1_000_000, 30_000, 16_384, "ti", None, 1.25, 2.50, False),
]

MISTRAL: list[tuple] = [
    ("mistral-large-latest", "Mistral Large", "Mistral Large 3 旗舰模型，262K 上下文，开源多模态。", "mistral", "mistral", 262_144, 262_144, 32_768, "ti", None, 0.50, 1.50, True),
    ("mistral-medium-latest", "Mistral Medium", "Mistral Medium 3.5 前沿多模态模型，262K 上下文。", "mistral", "mistral", 262_144, 262_144, 32_768, "ti", None, 1.50, 7.50, False),
    ("mistral-small-latest", "Mistral Small", "Mistral Small 4 混合模型，256K 上下文，统一指令、推理与编码。", "mistral", "mistral", 256_000, 256_000, 32_768, "ti", None, 0.15, 0.60, False),
]

MINIMAX: list[tuple] = [
    ("MiniMax-M3", "MiniMax M3", "MiniMax M3 原生多模态模型，1M 上下文，面向 Agent 推理、工具调用与编码。", "minimax", "minimax", 1_000_000, 128_000, 32_768, "tiv", None, 0.30, 1.20, True),
    ("MiniMax-M2.7", "MiniMax M2.7", "MiniMax M2.7 语言模型，205K 上下文。", "minimax", "minimax", 204_800, 131_072, 32_768, "t", None, 0.30, 1.20, False),
    ("MiniMax/speech-2.8-hd", "MiniMax Speech 2.8 HD", "MiniMax 语音合成模型（DashScope 三方直供）。", "minimax", "minimax", 1, 1, 1, "ta", None, None, None, False),
]

KUAISHOU: list[tuple] = [
    ("happyhorse-1.0-video-edit", "HappyHorse 1.0 Video Edit", "快手可灵 AI 视频编辑模型。", "kuaishou", "happyhorse", 1, 1, 1, "tv", None, None, None, False),
    ("happyhorse-1.1-i2v", "HappyHorse 1.1 I2V", "快手可灵 1.1 图生视频模型。", "kuaishou", "happyhorse", 1, 1, 1, "tiv", None, None, None, False),
    ("happyhorse-1.1-r2v", "HappyHorse 1.1 R2V", "快手可灵 1.1 参考视频生成模型。", "kuaishou", "happyhorse", 1, 1, 1, "tv", None, None, None, False),
    ("happyhorse-1.1-t2v", "HappyHorse 1.1 T2V", "快手可灵 1.1 文生视频模型。", "kuaishou", "happyhorse", 1, 1, 1, "tv", None, None, None, False),
    ("mimo-v2.5-pro", "Xiaomi MiMo 2.5 Pro", "小米 MiMo 2.5 Pro 视频生成模型（DashScope 三方直供）。", "kuaishou", "mimo", 1, 1, 1, "tv", None, None, None, False),
]

TRIPO: list[tuple] = [
    ("Tripo/Tripo-H3.1", "Tripo H3.1", "Tripo 3D 生成模型 H3.1（DashScope 三方直供）。", "tripo", "tripo", 1, 1, 1, "t", None, None, None, False),
    ("Tripo/Tripo-P1.0", "Tripo P1.0", "Tripo 3D 生成模型 P1.0（DashScope 三方直供）。", "tripo", "tripo", 1, 1, 1, "t", None, None, None, False),
]


def _caps(code: str) -> tuple[bool, bool, bool, bool]:
    return (
        "t" in code,
        "i" in code,
        "v" in code,
        "a" in code,
    )


def _num(value: int) -> str:
    return f"{value:,}".replace(",", "_")


def _price(value: float | None) -> str:
    if value is None:
        return "None"
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _q(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _caps_code(entry: tuple) -> str:
    text, image, video, audio = _caps(entry[8])
    parts = []
    parts.append(f"text={str(text)}")
    parts.append(f"image={str(image)}")
    parts.append(f"video={str(video)}")
    parts.append(f"audio={str(audio)}")
    return "ModelCapabilities(" + ", ".join(parts) + ")"


def _emit_provider(entries: list[tuple], title: str) -> str:
    lines = [
        f'"""{title} model data provider."""',
        "",
        "from __future__ import annotations",
        "",
        "from app.model_info.schemas import ModelCapabilities, ModelDetail",
        "",
        "MODELS: dict[str, ModelDetail] = {",
    ]
    for entry in entries:
        (
            model_id,
            name,
            description,
            vendor,
            family,
            ctx,
            max_out,
            suggested,
            caps,
            cutoff,
            pin,
            pout,
            recommended,
        ) = entry
        lines.append(f"    {_q(model_id)}: ModelDetail(")
        lines.append(f"        id={_q(model_id)},")
        lines.append(f"        name={_q(name)},")
        lines.append(f"        description={_q(description)},")
        lines.append(f"        vendor_id={_q(vendor)},")
        lines.append(f"        input_context_window={_num(ctx)},")
        lines.append(f"        max_output_tokens={_num(max_out)},")
        lines.append(f"        suggested_max_tokens={_num(suggested)},")
        lines.append(f"        capabilities={_caps_code(entry)},")
        if cutoff is not None:
            lines.append(f"        knowledge_cutoff={_q(cutoff)},")
        if pin is not None or pout is not None:
            lines.append(f"        pricing_input_per_1m={_price(pin)},")
            lines.append(f"        pricing_output_per_1m={_price(pout)},")
        if recommended:
            lines.append("        recommended=True,")
        if family is not None:
            lines.append(f"        model_family={_q(family)},")
        lines.append("    ),")
    lines.append("}")
    lines.append("")
    lines.append("")
    lines.append("def register(target: dict[str, ModelDetail]) -> None:")
    lines.append(f'    """Merge {title} models into the target repository dictionary."""')
    lines.append("    target.update(MODELS)")
    lines.append("")
    return "\n".join(lines)


def _emit_catalog(entries: list[tuple], class_name: str, dict_name: str) -> str:
    lines = [
        f'"""{class_name} catalog entries."""',
        "",
        "from __future__ import annotations",
        "",
        "from .schemas import Capabilities, QwenModelEntry",
        "",
        f"{dict_name}: dict[str, QwenModelEntry] = {{",
    ]
    for entry in entries:
        (
            model_id,
            name,
            description,
            _vendor,
            _family,
            ctx,
            _max_out,
            suggested,
            caps,
            _cutoff,
            _pin,
            _pout,
            recommended,
        ) = entry
        text, image, video, audio = _caps(caps)
        lines.append(f"    {_q(model_id)}: QwenModelEntry(")
        lines.append(f"        id={_q(model_id)},")
        lines.append(f"        name={_q(name)},")
        lines.append(f"        description={_q(description)},")
        lines.append(f"        context_window={_num(ctx)},")
        lines.append(f"        suggested_max_tokens={_num(suggested)},")
        lines.append(
            "        capabilities=Capabilities("
            f"text={str(text)}, image={str(image)}, "
            f"video={str(video)}, audio={str(audio)}),"
        )
        if recommended:
            lines.append("        recommended=True,")
        lines.append("    ),")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> None:
    providers = {
        "openai.py": ("OpenAI", OPENAI),
        "deepseek.py": ("DeepSeek", DEEPSEEK),
        "moonshot.py": ("Moonshot (Kimi)", MOONSHOT),
        "zhipu.py": ("ZhipuAI (GLM)", ZHIPU),
        "baichuan.py": ("Baichuan", BAICHUAN),
        "groq.py": ("Groq", GROQ),
        "xai.py": ("xAI (Grok)", XAI),
        "mistral.py": ("Mistral AI", MISTRAL),
        "minimax.py": ("MiniMax", MINIMAX),
        "kuaishou.py": ("Kuaishou/HappyHorse video", KUAISHOU),
        "tripo.py": ("Tripo 3D", TRIPO),
    }
    for filename, (title, entries) in providers.items():
        (ROOT / "backend" / "app" / "model_info" / "providers" / filename).write_text(
            _emit_provider(entries, title), encoding="utf-8"
        )
    (ROOT / "backend" / "app" / "model_info" / "providers" / "qwen.py").write_text(
        _emit_provider(DASHSCOPE, "Qwen/DashScope"), encoding="utf-8"
    )

    (ROOT / "backend" / "app" / "model_config" / "catalog_qwen.py").write_text(
        _emit_catalog(DASHSCOPE, "Built-in Qwen-family model", "QWEN_MODELS"),
        encoding="utf-8",
    )
    compatible = [
        *OPENAI,
        *DEEPSEEK,
        *MOONSHOT,
        *ZHIPU,
        *BAICHUAN,
        *GROQ,
        *XAI,
        *MISTRAL,
        *MINIMAX,
        *KUAISHOU,
        *TRIPO,
    ]
    (ROOT / "backend" / "app" / "model_config" / "catalog_compatible.py").write_text(
        _emit_catalog(compatible, "OpenAI-compatible provider model", "COMPATIBLE_MODELS"),
        encoding="utf-8",
    )
    print("generated model files")


if __name__ == "__main__":
    main()
