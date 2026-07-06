"""Agent 基类。"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Callable

from app.llm.client import DashScopeClient
from app.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

# 进度回调类型：接收一个 dict {type, stage, message, ...}
ProgressCallback = Callable[[dict], None]


class BaseAgent(ABC):
    """所有 Agent 的抽象基类。"""

    name: str = "base"
    description: str = ""

    def __init__(self, llm: DashScopeClient, tools: ToolRegistry):
        self.llm = llm
        self.tools = tools

    @abstractmethod
    async def execute(self, task_id: str, data: list[dict],
                      context: dict, progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        """执行 Agent 逻辑。

        Returns:
            (records, updated_context)
        """
        ...

    def _emit(self, progress: ProgressCallback | None, **kwargs):
        if progress:
            progress(kwargs)
