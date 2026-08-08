"""结构化 JSON 日志 — 标准库实现（零新依赖）。

REVIEW 2026-07-18 §9.3 P1：通用运行时日志以 JSON 行输出到 ``logs/app.jsonl``
（带轮转），并携带 ``task_id`` / ``run_id`` / ``stage`` 执行上下文，便于跨
模块关联诊断。控制台保持人类可读文本。

事件审计（``logs/pipeline.jsonl``，EventEnvelope JSON 表示）仍由
``app.pipeline`` logger 的专用 FileHandler 承担，本模块不接管该通道。
"""

from __future__ import annotations

import contextvars
import json
import logging
import logging.handlers
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

_TASK_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "log_task_id", default=None
)
_RUN_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "log_run_id", default=None
)
_STAGE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "log_stage", default=None
)

_configured = False


@asynccontextmanager
async def set_log_context(
    *,
    task_id: str | None = None,
    run_id: str | None = None,
    stage: str | None = None,
) -> AsyncIterator[None]:
    """在 asyncio 上下文中临时绑定执行上下文，块退出自动恢复。

    供 TaskManager run 循环与 PipelineRunner stage 循环调用。由于
    ``asyncio.to_thread`` 会把调用点 context 复制到工作线程，stage 线程内
    发出的日志也能带上绑定的字段。
    """
    tokens: list[contextvars.Token] = []
    if task_id is not None:
        tokens.append(_TASK_ID.set(task_id))
    if run_id is not None:
        tokens.append(_RUN_ID.set(run_id))
    if stage is not None:
        tokens.append(_STAGE.set(stage))
    try:
        yield
    finally:
        for token in reversed(tokens):
            token.var.reset(token)


class JsonFormatter(logging.Formatter):
    """将每条日志记录格式化为一行 JSON，附加上下文变量字段。"""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        task_id = _TASK_ID.get()
        run_id = _RUN_ID.get()
        stage = _STAGE.get()
        if task_id is not None:
            entry["task_id"] = task_id
        if run_id is not None:
            entry["run_id"] = run_id
        if stage is not None:
            entry["stage"] = stage
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def configure_logging(*, level: str = "INFO", log_dir: str | Path = "logs") -> None:
    """幂等地配置根 logger：人类可读控制台 + 轮转 JSON 文件。

    已配置时直接返回，避免测试/重复启动时重复挂 handler。
    """
    global _configured
    if _configured:
        return
    _configured = True
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    console = logging.StreamHandler()
    console.setFormatter(
        logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s")
    )
    root.addHandler(console)
    path = Path(log_dir)
    path.mkdir(parents=True, exist_ok=True)
    file_handler = logging.handlers.RotatingFileHandler(
        path / "app.jsonl",
        maxBytes=1_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(JsonFormatter())
    root.addHandler(file_handler)
