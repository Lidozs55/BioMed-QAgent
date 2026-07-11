"""文件解析工具 — 占位，数据获取接口暂缓实现。"""
from __future__ import annotations

from typing import Any

from agents import RunContextWrapper, function_tool


@function_tool
def parse_pdf(ctx: RunContextWrapper[Any], file_path: str) -> str:
    """解析 PDF 文件，提取表格、图表说明和全文文本。返回结构化 JSON 字符串。

    Args:
        file_path: PDF 文件路径
    """
    # 接口暂缓实现
    return '{"records": [], "note": "PDF 解析接口待实现 — 当前为占位返回"}'
