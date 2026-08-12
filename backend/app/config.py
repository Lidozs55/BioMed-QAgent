"""配置 — DashScope (Qwen) OpenAI 兼容模式。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

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
    # NCBI E-utilities identity and optional higher-quota API key
    ncbi_email: str = os.getenv("NCBI_EMAIL", "biomed-qagent@example.com")
    ncbi_tool: str = os.getenv("NCBI_TOOL", "BioMedQAgent")
    ncbi_api_key: str = os.getenv("NCBI_API_KEY", "")
    ncbi_user_agent: str = os.getenv(
        "NCBI_USER_AGENT",
        "BioMed-QAgent/0.1 (biomed-qagent@example.com)",
    )
    # 后端
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))
    # 数据产物目录 — 默认解析为绝对路径，避免 cwd 变化导致输出散落
    output_dir: str = str(
        Path(
            os.getenv(
                "OUTPUT_DIR",
                str(Path.cwd() / "data" / "output"),
            )
        ).expanduser().resolve()
    )
    # Temporary private Host -> Python Dataset Core migration bridge secret.
    pi_dataset_bridge_secret: str | None = (
        os.getenv("PI_DATASET_BRIDGE_SECRET") or None
    )
    # 爬虫行为（原 §5.3）：真实浏览器 UA 与请求间隔限速
    rate_limit_seconds: float = float(os.getenv("RATE_LIMIT_SECONDS", "2.0"))
    # User-installed skills live outside the bundled Python package.  When
    # unset, derive a sibling of OUTPUT_DIR so packaged application upgrades
    # cannot overwrite user data.
    skill_data_dir: str | None = os.getenv("SKILL_DATA_DIR") or None
    # Durable task/session pagination
    task_page_size: int = int(os.getenv("TASK_PAGE_SIZE", "30"))
    task_page_max_size: int = int(os.getenv("TASK_PAGE_MAX_SIZE", "100"))
    task_message_page_size: int = int(os.getenv("TASK_MESSAGE_PAGE_SIZE", "100"))
    # 日志等级 (DEBUG / INFO / WARNING / ERROR / CRITICAL)
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    # Runtime concurrency and live-event backpressure
    runtime_max_active_runs: int = int(os.getenv("RUNTIME_MAX_ACTIVE_RUNS", "4"))
    runtime_sync_worker_threads: int = int(
        os.getenv("RUNTIME_SYNC_WORKER_THREADS", "4")
    )
    runtime_run_queue_size: int = int(os.getenv("RUNTIME_RUN_QUEUE_SIZE", "100"))
    runtime_subscriber_queue_size: int = int(
        os.getenv("RUNTIME_SUBSCRIBER_QUEUE_SIZE", "1000")
    )

    @property
    def skill_data_path(self) -> Path:
        """Return the absolute, test-injectable user skill data directory."""
        if self.skill_data_dir is not None:
            return Path(self.skill_data_dir).expanduser().resolve()
        return (Path(self.output_dir).expanduser().resolve().parent / "skills").resolve()


settings = Settings()
