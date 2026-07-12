"""Runner 封装 — 流式运行 Agent loop，事件分发到 WebSocket。

将 openai-agents-python 的 Runner.run_streamed 事件转换为前端可消费的 WSMessage。

事件类型：
  - text: LLM 文本增量（仅推送 content delta，不推送工具参数 delta）
  - tool_call: 工具调用开始（name + arguments）
  - tool_output: 工具调用结果
  - done: Agent loop 结束（final_output）
  - error: 异常

SDK 参考：
  RawResponsesStreamEvent(type="raw_response_event") — 底层 LLM 原始流式事件
  RunItemStreamEvent(type="run_item_stream_event") — 包装 RunItem 的高层事件
    name="tool_called" → 工具调用
    name="tool_output" → 工具输出
"""
from __future__ import annotations

import logging
from typing import AsyncIterator

from agents import Agent, Runner
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent

from app.agent_loop.agent import create_agent
from app.agent_loop.context import RunContext

logger = logging.getLogger(__name__)


def _extract_text_delta(data) -> str | None:
    """从 ChatCompletions 原始事件中安全提取文本 delta。

    DashScope/Qwen 走 Chat Completions 路径，原始事件为 ChatCompletionChunk，
    结构为 chunk.choices[0].delta.content。不推送 role 或空 delta。
    """
    choices = getattr(data, "choices", None)
    if not choices:
        return None
    delta = getattr(choices[0], "delta", None)
    if delta is None:
        return None
    content = getattr(delta, "content", None)
    if content:
        return content
    # Responses API 路径（OpenAI 原生模型）可能直接有 delta 属性
    direct_delta = getattr(data, "delta", None)
    if direct_delta:
        return direct_delta
    return None


async def run_agent_stream(
    user_input: str,
    task_id: str = "default",
) -> AsyncIterator[dict]:
    """流式运行 Agent loop，yield 前端可消费的事件 dict。"""
    ctx = RunContext(task_id=task_id)
    agent = create_agent()

    try:
        result = Runner.run_streamed(agent, user_input, context=ctx)
        async for event in result.stream_events():
            # LLM 原始流式事件 — 仅提取文本 delta
            if isinstance(event, RawResponsesStreamEvent):
                text_delta = _extract_text_delta(event.data)
                if text_delta:
                    yield {"type": "text", "delta": text_delta}
                continue

            # RunItem 高层事件 — 工具调用与输出
            if isinstance(event, RunItemStreamEvent):
                if event.name == "tool_called":
                    raw_item = getattr(event.item, "raw_item", None)
                    tool_name = getattr(raw_item, "name", "unknown") if raw_item else "unknown"
                    args_json = getattr(raw_item, "arguments", "{}") if raw_item else "{}"
                    yield {
                        "type": "tool_call",
                        "name": tool_name,
                        "arguments": args_json,
                    }
                elif event.name == "tool_output":
                    output = getattr(event.item, "output", "")
                    yield {
                        "type": "tool_output",
                        "output": str(output)[:5000],
                    }

        # 最终输出
        yield {"type": "done", "final_output": result.final_output}

    except Exception as e:
        logger.exception("Agent loop 执行失败")
        yield {"type": "error", "message": str(e)}
