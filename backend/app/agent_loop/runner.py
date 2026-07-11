"""Runner 封装 — 流式运行 Agent loop，事件分发到 WebSocket。

将 openai-agents-python 的 Runner.run_streamed 事件转换为前端可消费的 WSMessage。
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from agents import Agent, Runner
from agents.stream_events import RawResponsesStreamEvent

from app.agent_loop.agent import create_agent
from app.agent_loop.context import RunContext

logger = logging.getLogger(__name__)


async def run_agent_stream(
    user_input: str,
    task_id: str = "default",
) -> AsyncIterator[dict]:
    """流式运行 Agent loop，yield 前端可消费的事件 dict。

    事件类型：
    - text: LLM 文本增量（delta）
    - tool_call: 工具调用开始（name + arguments）
    - tool_output: 工具调用结果
    - done: Agent loop 结束（final_output）
    - error: 异常
    """
    ctx = RunContext(task_id=task_id)
    agent = create_agent()

    try:
        result = Runner.run_streamed(agent, user_input, context=ctx)
        async for event in result.stream_events():
            # LLM 文本流
            if isinstance(event, RawResponsesStreamEvent):
                data = event.data
                # ChatCompletions delta
                if hasattr(data, "delta") and data.delta:
                    yield {"type": "text", "delta": data.delta}
                continue

            # 工具调用 / 工具输出事件
            event_type = getattr(event, "type", "")
            if event_type == "run_item":
                item = getattr(event, "item", None)
                if item is None:
                    continue
                item_type = getattr(item, "type", "")
                if item_type == "tool_call_item":
                    tool_name = getattr(getattr(item, "raw_item", None), "name", "unknown")
                    args_json = getattr(getattr(item, "raw_item", None), "arguments", "{}")
                    yield {
                        "type": "tool_call",
                        "name": tool_name,
                        "arguments": args_json,
                    }
                elif item_type == "tool_call_output_item":
                    output = getattr(item, "output", "")
                    yield {
                        "type": "tool_output",
                        "output": str(output)[:5000],
                    }

        # 最终输出
        yield {"type": "done", "final_output": result.final_output}

    except Exception as e:
        logger.exception("Agent loop 执行失败")
        yield {"type": "error", "message": str(e)}
