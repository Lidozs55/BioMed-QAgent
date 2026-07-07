"""Agent 基类 — 所有阶段 Agent 的抽象基础。

提供各 Agent 共享的能力：
- LLM 客户端 / ToolRegistry / TaskStore 注入
- 阶段状态设置（_set_stage）、进度推送（_emit）
- 同步阻塞函数在线程池执行（_to_thread）
- 记录持久化（_write_records）

execute 统一签名：接收 task 对象（便于设置阶段状态/追加错误），
返回 (records, updated_context)，由 Orchestrator 按 PIPELINE 调度。
"""
from __future__ import annotations

import asyncio
import json
import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable

from app.llm.client import DashScopeClient
from app.models.task import Task, TaskStatus, StageStatus
from app.storage.task_store import TaskStore, get_task_store
from app.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

# 进度回调类型：接收一个 dict {type, stage, message, ...}
ProgressCallback = Callable[[dict], None]


class BaseAgent(ABC):
    """所有阶段 Agent 的抽象基类。"""

    name: str = "base"
    description: str = ""

    def __init__(self, llm: DashScopeClient | None = None,
                 tools: ToolRegistry | None = None,
                 store: TaskStore | None = None):
        self.llm = llm or DashScopeClient()
        self.tools = tools or self._default_tools()
        self.store = store or get_task_store()

    @staticmethod
    def _default_tools() -> ToolRegistry:
        from app.tools.registry import get_registry
        return get_registry()

    @abstractmethod
    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        """执行 Agent 逻辑。

        Args:
            task: 任务对象（可设置阶段状态、追加错误）
            records: 上游传入的数据记录列表
            context: 共享上下文 dict（entities/analysis/review 等）
            progress: 可选进度回调
        Returns:
            (updated_records, updated_context)
        """
        ...

    # ========== 共享辅助方法（从 Orchestrator 迁入） ==========

    def _set_stage(self, task: Task, name: str, status: StageStatus,
                   message: str = "", **kwargs):
        """设置任务阶段状态，并同步任务顶层状态。"""
        task.set_stage(name, status, message, **kwargs)
        if status == StageStatus.RUNNING:
            status_map = {
                "planning": TaskStatus.PLANNING,
                "search": TaskStatus.SEARCHING,
                "acquire": TaskStatus.ACQUIRING,
                "parse": TaskStatus.PARSING,
                "clean": TaskStatus.CLEANING,
                "analyze": TaskStatus.ANALYZING,
                "review": TaskStatus.REVIEWING,
            }
            if name in status_map:
                task.status = status_map[name]

    def _emit(self, progress: ProgressCallback | None, **kwargs):
        """推送进度事件到 WebSocket。"""
        if progress:
            progress(kwargs)

    @staticmethod
    async def _to_thread(func, *args, **kwargs):
        """在线程池中运行同步阻塞函数，避免阻塞事件循环。"""
        return await asyncio.to_thread(func, *args, **kwargs)

    @staticmethod
    def _write_records(path: Path, records: list[dict]) -> None:
        """持久化记录到 JSON 文件（供溯源/调试）。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, default=str)
