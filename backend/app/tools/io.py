"""文件读写工具 — Agent 可读写本地产物文件。

这是 Agent loop 中最先可用的工具：LLM 可将中间结果写入文件、读取已有产物。
context 参数为 RunContextWrapper，由 SDK 自动注入，不暴露给 LLM。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool


@function_tool
def read_file(ctx: RunContextWrapper[Any], path: str) -> str:
    """读取指定文件内容。path 可以是绝对路径或相对于任务输出目录的相对路径。"""
    run_ctx: RunContext = ctx.context
    p = Path(path)
    if not p.is_absolute():
        p = run_ctx.output_dir / path
    if not p.exists():
        return f"文件不存在: {p}"
    return p.read_text(encoding="utf-8")


@function_tool
def write_file(ctx: RunContextWrapper[Any], path: str, content: str) -> str:
    """将内容写入文件。path 为相对于任务输出目录的路径。返回写入的文件路径。"""
    run_ctx: RunContext = ctx.context
    p = Path(path)
    if not p.is_absolute():
        p = run_ctx.output_dir / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    run_ctx.artifacts.append(str(p))
    return f"已写入: {p}"


@function_tool
def list_files(ctx: RunContextWrapper[Any], subdir: str = "") -> str:
    """列出任务输出目录下的文件。subdir 为可选子目录。"""
    run_ctx: RunContext = ctx.context
    d = run_ctx.output_dir / subdir if subdir else run_ctx.output_dir
    if not d.exists():
        return f"目录不存在: {d}"
    files = [str(f.relative_to(run_ctx.output_dir)) for f in d.rglob("*") if f.is_file()]
    return "\n".join(files) if files else "（空目录）"


# 延迟导入避免循环引用
from app.agent_loop.context import RunContext  # noqa: E402
