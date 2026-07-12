"""工具注册表测试 — 验证 get_all_tools 返回已注册的 function_tool。"""
from __future__ import annotations

from app.tools._registry import get_all_tools


def test_get_all_tools_returns_list() -> None:
    tools = get_all_tools()
    assert isinstance(tools, list)
    assert len(tools) > 0


def test_get_all_tools_has_io_tools() -> None:
    tools = get_all_tools()
    names = [getattr(t, "name", str(t)) for t in tools]
    assert "read_file" in names
    assert "write_file" in names
    assert "list_files" in names


def test_get_all_tools_has_placeholder_tools() -> None:
    """数据获取工具（search/parse/analyze）应为占位但已注册。"""
    tools = get_all_tools()
    names = {getattr(t, "name", str(t)) for t in tools}
    assert "search_literature" in names
    assert "parse_pdf" in names
    assert "analyze_records" in names


def test_all_tools_have_name() -> None:
    """每个 tool 应有 name 属性（function_tool 装饰后自动生成）。"""
    tools = get_all_tools()
    for t in tools:
        assert hasattr(t, "name"), f"工具 {t} 缺少 name 属性"
