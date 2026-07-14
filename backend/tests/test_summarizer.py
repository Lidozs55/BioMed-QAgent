"""summarizer 与 RunContext 压缩逻辑的最小测试（不依赖 LLM）。"""

import importlib
from types import SimpleNamespace

from app.agent_loop.context import RunContext
from app.agent_loop.summarizer import (
    build_compress_query_log_tool,
    KEEP_RECENT,
    COMPRESS_THRESHOLD_CHARS,
)


def test_compress_log_truncates_and_sets_summary():
    ctx = RunContext(task_id="t1")
    for i in range(20):
        ctx.log_query(f"q{i}", "pubmed", "ok", i)
    compressed = ctx.compress_log(keep_recent=KEEP_RECENT, summary="摘要")
    assert compressed == 15
    assert len(ctx.query_log) == KEEP_RECENT
    assert ctx.query_log_summary == "摘要"
    assert ctx.query_log[0]["query"] == "q15"


def test_compress_log_noop_when_below_threshold():
    ctx = RunContext(task_id="t2")
    ctx.log_query("q0", "geo", "ok", 1)
    compressed = ctx.compress_log(keep_recent=KEEP_RECENT, summary="摘要")
    assert compressed == 0
    assert len(ctx.query_log) == 1
    assert ctx.query_log_summary == ""


def test_compress_log_appends_to_existing_summary():
    ctx = RunContext(task_id="t_append")
    for i in range(20):
        ctx.log_query(f"q{i}", "pubmed", "ok", i)
    ctx.compress_log(keep_recent=KEEP_RECENT, summary="第一轮摘要")
    for i in range(20):
        ctx.log_query(f"r{i}", "geo", "ok", i)
    ctx.compress_log(keep_recent=KEEP_RECENT, summary="第二轮摘要")
    assert "[后续摘要]" in ctx.query_log_summary
    assert "第一轮摘要" in ctx.query_log_summary
    assert "第二轮摘要" in ctx.query_log_summary


def test_build_compress_tool_uses_supplied_model(monkeypatch):
    summarizer_module = importlib.import_module("app.agent_loop.summarizer")
    supplied_model = object()
    captured: dict[str, object] = {}

    class ContextManagerAgent:
        def as_tool(self, *, tool_name, **kwargs):
            return SimpleNamespace(name=tool_name)

    def build_context_manager_agent(**kwargs):
        captured.update(kwargs)
        return ContextManagerAgent()

    monkeypatch.setattr(summarizer_module, "Agent", build_context_manager_agent)

    tool = build_compress_query_log_tool(supplied_model)

    assert captured["model"] is supplied_model
    assert tool.name == "compress_query_log"


def test_query_log_size_grows_with_entries():
    ctx = RunContext(task_id="t3")
    size_before = ctx.query_log_size()
    ctx.log_query("abc", "pdb", "ok", 5)
    assert ctx.query_log_size() > size_before


def test_threshold_is_char_based():
    """确认阈值是基于字符数（8000）而非条数。"""
    assert COMPRESS_THRESHOLD_CHARS == 8000
    assert isinstance(COMPRESS_THRESHOLD_CHARS, int)
