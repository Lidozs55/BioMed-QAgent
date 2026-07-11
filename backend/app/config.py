"""配置 — DashScope (Qwen) OpenAI 兼容模式。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()  # 从 .env 加载


@dataclass(frozen=True)
class Settings:
    # DashScope OpenAI 兼容端点
    dashscope_api_key: str = os.getenv("DASHSCOPE_API_KEY", "")
    dashscope_base_url: str = os.getenv(
        "DASHSCOPE_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    # 默认模型
    model_name: str = os.getenv("MODEL_NAME", "qwen-plus")
    # 后端
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))
    # 数据产物目录
    output_dir: str = os.getenv("OUTPUT_DIR", "data/output")


settings = Settings()
