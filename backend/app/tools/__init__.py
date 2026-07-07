"""工具层 — backend 原生模块函数的统一 facade。

所有脚本已从 biomed-data-agent-skill 迁入 backend/app/tools/ 各子模块，
通过 ToolRegistry 提供直接函数调用（无 subprocess）。
"""
from app.tools.registry import ToolRegistry, ToolResult, get_registry

__all__ = ["ToolRegistry", "ToolResult", "get_registry"]
