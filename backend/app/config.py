"""全局配置 — 强制使用阿里云百炼 DashScope 平台。"""
from __future__ import annotations

import os
from pathlib import Path
from dataclasses import dataclass, field


# ===== 路径 =====
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # d:\Code\BioMedQAgent
SKILL_DIR = PROJECT_ROOT / "biomed-data-agent"
SCRIPTS_DIR = SKILL_DIR / "scripts"
DATA_DIR = PROJECT_ROOT / "data"
OUTPUT_DIR = DATA_DIR / "output"
UPLOADS_DIR = DATA_DIR / "uploads"
CACHE_DIR = DATA_DIR / "cache"

for d in (OUTPUT_DIR, UPLOADS_DIR, CACHE_DIR):
    d.mkdir(parents=True, exist_ok=True)


# ===== DashScope (阿里云百炼) =====
DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

# 模型配置
MODEL_TEXT = "qwen-plus"        # 文本理解、实体识别、编排决策
MODEL_VISION = "qwen-vl-max"    # 多模态识图（图表数据提取、表格识别）
MODEL_LONG = "qwen-long"        # 长文档理解（PDF 全文）
MODEL_STRONG = "qwen-max"       # 强推理（审查、复杂决策）

# ===== 服务配置 =====
HOST = "0.0.0.0"
PORT = 8000
CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173",
                "http://localhost:8000", "http://127.0.0.1:8000",
                "http://localhost:3000", "http://127.0.0.1:3000"]

# 流水线配置
MAX_SEARCH_RESULTS = 20        # 每个数据源最大返回
MAX_STAGE_ITERATIONS = 3       # Darwinian 最大迭代轮次


def get_api_key() -> str:
    """获取 DashScope API Key，若未设置则给出友好提示。"""
    key = DASHSCOPE_API_KEY
    if not key:
        # Windows 环境变量兼容：%DASHSCOPE_API_KEY%
        key = os.environ.get("DASHSCOPE_API_KEY", "")
    return key


def is_api_key_configured() -> bool:
    return bool(get_api_key())
