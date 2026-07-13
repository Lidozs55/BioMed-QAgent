"""文件读写工具 — Agent 可读写本地产物文件。

安全要求（ARCHITECTURE.md §10 + TODO §3.2）：
  - 拒绝绝对路径
  - 拒绝 .. 路径穿越
  - 拒绝工作目录外的符号链接

所有文件操作限制在任务工作目录 data/tasks/<task_id>/ 内。
context 参数为 RunContextWrapper，由 SDK 自动注入，不暴露给 LLM。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool


def _resolve_safe_path(path: str, run_ctx: RunContext) -> Path:
    """将用户提供的路径解析为任务目录内的安全路径。

    安全策略：
      1. 拒绝绝对路径
      2. 拒绝 .. 路径穿越（resolve 后不在 output_dir 内）
      3. 拒绝工作目录外的符号链接（real 目标不在 output_dir 内）
    """
    p = Path(path)

    # 安全检查 1：拒绝绝对路径
    if p.is_absolute():
        raise ValueError(f"不允许使用绝对路径: {path}")

    # 拼接任务工作目录并解析（规范化 .. 和 . 等）
    output_dir = run_ctx.output_dir.resolve()
    resolved = (output_dir / p).resolve()

    # 安全检查 2：拒绝 .. 路径穿越
    try:
        resolved.relative_to(output_dir)
    except ValueError:
        raise ValueError(f"路径穿越被拒绝: {path}（目标在工作目录之外）") from None

    # 安全检查 3：如果路径存在且是符号链接，检查 real 目标
    if resolved.exists() and resolved.is_symlink():
        real_target = resolved.resolve()
        try:
            real_target.relative_to(output_dir)
        except ValueError:
            raise ValueError(f"符号链接指向工作目录外被拒绝: {path} -> {real_target}") from None

    return resolved


@function_tool
def read_file(ctx: RunContextWrapper[Any], path: str) -> str:
    """读取任务工作目录内的文件内容。path 为相对于任务输出目录的相对路径。"""
    run_ctx: RunContext = ctx.context
    try:
        safe_path = _resolve_safe_path(path, run_ctx)
    except ValueError as e:
        return f"路径错误: {e}"

    if not safe_path.exists():
        return f"文件不存在: {safe_path}"
    return safe_path.read_text(encoding="utf-8")


@function_tool
def write_file(ctx: RunContextWrapper[Any], path: str, content: str) -> str:
    """将内容写入任务工作目录内的文件。path 为相对路径。返回写入的文件路径。"""
    run_ctx: RunContext = ctx.context
    try:
        safe_path = _resolve_safe_path(path, run_ctx)
    except ValueError as e:
        return f"路径错误: {e}"

    safe_path.parent.mkdir(parents=True, exist_ok=True)
    safe_path.write_text(content, encoding="utf-8")
    run_ctx.artifacts.append(str(safe_path))
    return f"已写入: {safe_path}"


@function_tool
def list_files(ctx: RunContextWrapper[Any], subdir: str = "") -> str:
    """列出任务工作目录下的文件。subdir 为可选子目录（相对路径）。"""
    run_ctx: RunContext = ctx.context
    try:
        d = _resolve_safe_path(subdir, run_ctx) if subdir else run_ctx.output_dir.resolve()
    except ValueError as e:
        return f"路径错误: {e}"

    if not d.exists():
        return f"目录不存在: {d}"
    output_dir = run_ctx.output_dir.resolve()
    files = [str(f.relative_to(output_dir)) for f in d.rglob("*") if f.is_file()]
    return "\n".join(files) if files else "（空目录）"


# 延迟导入避免循环引用
from app.agent_loop.context import RunContext  # noqa: E402
