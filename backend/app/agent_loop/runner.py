"""Runner 封装 — 流式运行 Agent loop，事件分发到 WebSocket。
 
将 openai-agents-python 的 Runner.run_streamed 事件转换为前端可消费的 WSMessage。
 
事件类型：
  - text: LLM 文本增量（仅推送 content delta，不推送工具参数 delta）
  - skill_loaded: 技能加载通知（name + category）
  - tool_call: 工具调用开始（name + arguments）
  - tool_output: 工具调用结果
  - confirm: 质量/HITL 确认提醒（tool 输出包含 quality_issues 或 needs_confirmation 时触发）
  - done: Agent loop 结束（final_output）
  - file_downloaded: 下载完成的文件（name + path + size）
  - artifact_produced: 生成的产物文件（name + path + size）
  - error: 异常
 
SDK 参考：
  RawResponsesStreamEvent(type="raw_response_event") — 底层 LLM 原始流式事件
  RunItemStreamEvent(type="run_item_stream_event") — 包装 RunItem 的高层事件
    name="tool_called" → 工具调用
    name="tool_output" → 工具输出
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import AsyncIterator

from agents import Agent, Runner
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent

from app.agent_loop.agent import create_agent, get_loaded_skill_names
from app.agent_loop.context import RunContext
from app.agent_loop.model import ModelConfigurationError, require_model_credentials
from app.config import settings

logger = logging.getLogger(__name__)


def _check_for_confirmation(output: object) -> str | None:
    """检测 tool 输出中的质量/确认标记，返回确认消息或 None。

    支持的标记：
      - 顶层 dict 包含 "quality_issues" 或 "needs_confirmation" 键
      - JSON 字符串解析后包含上述键
    """
    if output is None:
        return None
    if isinstance(output, dict):
        if "needs_confirmation" in output:
            return str(output["needs_confirmation"])
        if "quality_issues" in output:
            issues = output["quality_issues"]
            if isinstance(issues, list):
                return "Quality issues detected: " + "; ".join(str(i) for i in issues)
            return str(issues)
        return None
    if isinstance(output, str):
        import json
        try:
            parsed = json.loads(output)
        except (json.JSONDecodeError, TypeError):
            return None
        if isinstance(parsed, dict):
            if "needs_confirmation" in parsed:
                return str(parsed["needs_confirmation"])
            if "quality_issues" in parsed:
                issues = parsed["quality_issues"]
                if isinstance(issues, list):
                    return "Quality issues detected: " + "; ".join(str(i) for i in issues)
                return str(issues)
    return None


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
    databases: list[str] | None = None,
) -> AsyncIterator[dict]:
    """流式运行 Agent loop，yield 前端可消费的事件 dict。"""
    ctx = RunContext(task_id=task_id)

    try:
        require_model_credentials()
        agent = create_agent(databases=databases)

        # ── skill_loaded 事件 ──
        skill_names = get_loaded_skill_names()
        for name in skill_names:
            category = "unknown"
            # Derive category from name.  The skill registry is already loaded;
            # we import the registry here for a lightweight lookup.
            from app.skills.registry import skill_registry as _reg
            skill_def = _reg.get(name)
            if skill_def is not None:
                category = skill_def.category.value
            yield {
                "type": "skill_loaded",
                "name": name,
                "category": category,
            }

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
                    confirm_msg = _check_for_confirmation(output)
                    if confirm_msg:
                        yield {
                            "type": "confirm",
                            "content": confirm_msg,
                        }

        # 最终输出
        yield {"type": "done", "final_output": result.final_output}

        # ── 扫描产物目录，yield file_downloaded / artifact_produced 事件 ──
        tasks_base = Path(settings.output_dir) / "tasks" / task_id
        for sub, event_type in [
            ("source_assets", "file_downloaded"),
            ("artifacts", "artifact_produced"),
        ]:
            sub_dir = tasks_base / sub
            if sub_dir.exists():
                for file_path in sorted(sub_dir.rglob("*")):
                    if file_path.is_file():
                        try:
                            size = file_path.stat().st_size
                        except OSError:
                            size = 0
                        try:
                            rel = file_path.relative_to(tasks_base)
                        except ValueError:
                            rel = file_path
                        yield {
                            "type": event_type,
                            "name": file_path.name,
                            "path": str(rel).replace("\\", "/"),
                            "size": size,
                        }

    except ModelConfigurationError as error:
        yield {
            "type": "error",
            "code": error.code,
            "message": str(error),
        }
    except Exception as e:
        logger.exception("Agent loop 执行失败")
        yield {"type": "error", "message": str(e)}
