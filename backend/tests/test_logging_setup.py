"""结构化 JSON 日志模块测试（REVIEW 2026-07-18 §9.3 P1）。

覆盖：JsonFormatter 输出可解析 JSON 行；set_log_context 注入
task_id/run_id/stage 且退出恢复；异常记录带 exception 字段；
configure_logging 幂等 + 轮转文件 handler。
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import sys

import pytest
from app import logging_setup


def _reset_root_logging() -> None:
    """清理根 logger handler 并重置配置标志，保证测试相互独立。"""
    logging_setup._configured = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        # pytest 的 LogCaptureHandler 由 caplog 拥有，不要 close
        if handler.__class__.__name__ != "LogCaptureHandler":
            handler.close()


@pytest.fixture(autouse=True)
def _clean_root_logging() -> None:
    _reset_root_logging()
    yield
    _reset_root_logging()


def _make_record(
    message: str = "hello %s",
    args: tuple[object, ...] = ("world",),
    level: int = logging.INFO,
    *,
    exc_info: bool = False,
) -> logging.LogRecord:
    return logging.LogRecord(
        "app.test", level, "test_logging_setup.py", 1, message, args, exc_info
    )


def test_json_formatter_emits_parseable_line() -> None:
    formatter = logging_setup.JsonFormatter()
    payload = json.loads(formatter.format(_make_record()))
    assert payload["level"] == "INFO"
    assert payload["logger"] == "app.test"
    assert payload["message"] == "hello world"
    assert "ts" in payload


def test_json_formatter_omits_context_when_unset() -> None:
    formatter = logging_setup.JsonFormatter()
    payload = json.loads(formatter.format(_make_record()))
    assert "task_id" not in payload
    assert "run_id" not in payload
    assert "stage" not in payload


@pytest.mark.asyncio
async def test_set_log_context_injects_and_restores_fields() -> None:
    formatter = logging_setup.JsonFormatter()
    record = _make_record()

    async with logging_setup.set_log_context(
        task_id="task-1", run_id="run-1", stage="discovery"
    ):
        payload = json.loads(formatter.format(record))
        assert payload["task_id"] == "task-1"
        assert payload["run_id"] == "run-1"
        assert payload["stage"] == "discovery"

    # 退出 async with 后上下文恢复为空
    payload = json.loads(formatter.format(record))
    assert "task_id" not in payload
    assert "stage" not in payload


@pytest.mark.asyncio
async def test_set_log_context_restores_previous_value() -> None:
    formatter = logging_setup.JsonFormatter()
    record = _make_record()

    token = logging_setup._STAGE.set("acquisition")
    async with logging_setup.set_log_context(stage="processing"):
        payload = json.loads(formatter.format(record))
        assert payload["stage"] == "processing"
    assert logging_setup._STAGE.get() == "acquisition"
    logging_setup._STAGE.reset(token)


def test_json_formatter_includes_exception() -> None:
    formatter = logging_setup.JsonFormatter()
    try:
        raise ValueError("boom")
    except ValueError:
        record = _make_record(
            "stage failed", args=(), level=logging.ERROR, exc_info=sys.exc_info()
        )
    payload = json.loads(formatter.format(record))
    assert "boom" in payload["exception"]


def test_configure_logging_is_idempotent_and_rotating(tmp_path) -> None:
    configure_logging = logging_setup.configure_logging
    configure_logging(level="INFO", log_dir=tmp_path)
    configure_logging(level="INFO", log_dir=tmp_path)  # 第二次调用不重复挂 handler

    root = logging.getLogger()
    file_handlers = [
        handler
        for handler in root.handlers
        if isinstance(handler, logging.handlers.RotatingFileHandler)
    ]
    # pytest 的 LogCaptureHandler 也继承 StreamHandler，只统计我们自己挂的
    console_handlers = [
        handler
        for handler in root.handlers
        if isinstance(handler, logging.StreamHandler)
        and not isinstance(handler, logging.handlers.RotatingFileHandler)
        and handler.__class__.__name__ != "LogCaptureHandler"
    ]
    assert len(file_handlers) == 1
    assert len(console_handlers) == 1
    assert file_handlers[0].maxBytes == 1_000_000
    assert file_handlers[0].backupCount == 5
    assert str(file_handlers[0].baseFilename).endswith("app.jsonl")


def test_configure_logging_writes_json_line(tmp_path) -> None:
    logging_setup.configure_logging(level="INFO", log_dir=tmp_path)
    logging.getLogger("app.test").info("hello %s", "structured")

    log_path = tmp_path / "app.jsonl"
    assert log_path.exists()
    lines = [line for line in log_path.read_text(encoding="utf-8").splitlines() if line]
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["logger"] == "app.test"
    assert payload["message"] == "hello structured"
