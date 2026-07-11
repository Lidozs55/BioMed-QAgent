"""工具注册中心 — 汇总所有 function_tool 供 Agent 装载。

数据获取相关工具（search/parse/analyze）暂为占位，接口后续实现。
"""

from __future__ import annotations

from agents import function_tool

from app.tools.io import read_file, write_file, list_files
from app.tools.search import search_literature
from app.tools.parse import parse_pdf
from app.tools.analyze import analyze_records


def get_all_tools() -> list:
    """返回所有已注册的 function_tool，供主 Agent 装载。"""
    return [
        # IO 工具（已实现，Agent 可读写本地文件）
        read_file,
        write_file,
        list_files,
        # 数据获取工具（占位，接口暂缓）
        search_literature,
        parse_pdf,
        analyze_records,
    ]
