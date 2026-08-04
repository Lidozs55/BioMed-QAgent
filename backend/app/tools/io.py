"""文件读写工具 — Agent 可读写本地产物文件。

安全要求（ARCHITECTURE.md §10 + TODO §3.2）：
  - 拒绝绝对路径
  - 拒绝 .. 路径穿越
  - 拒绝工作目录外的符号链接

读取和列出操作限制在任务工作目录 data/output/tasks/<task_id>/ 内，覆盖
source_assets/、parsed/、normalized/、staging/、artifacts/、state/、logs/
等全部子目录。写入操作仅允许在 staging/agent/ 内。
context 参数为 RunContextWrapper，由 SDK 自动注入，不暴露给 LLM。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from agents import RunContextWrapper, function_tool


class WorkDirLike(Protocol):
    """Structural protocol for a task working directory.

    Decouples ``io.py`` (tools layer) from ``agent_loop.context.RunContext``
    (agent layer).  ``TaskWorkDir`` satisfies this structurally.
    """

    root: Path

    def agent_staging_file(self, path: str) -> Path: ...


def _resolve_safe_path(path: str, work_dir: WorkDirLike) -> Path:
    """将用户提供的路径解析为任务目录内的安全路径。

    安全策略：
      1. 拒绝绝对路径
      2. 拒绝 .. 路径穿越（resolve 后不在任务根目录内）
      3. 拒绝任务根目录外的符号链接（real 目标不在任务根目录内）

    沙箱边界为 ``work_dir.root``，覆盖全部子目录（source_assets、
    parsed、normalized、staging、artifacts、state、logs 等），让 Agent 能
    直接读取 skill 下载/解析的中间产物。
    """
    p = Path(path)

    # 安全检查 1：拒绝绝对路径
    if p.is_absolute():
        raise ValueError(f"不允许使用绝对路径: {path}")

    # 拼接任务根目录并解析（规范化 .. 和 . 等）
    task_root = work_dir.root.resolve()
    resolved = (task_root / p).resolve()

    # 安全检查 2：拒绝 .. 路径穿越
    try:
        resolved.relative_to(task_root)
    except ValueError:
        raise ValueError(f"路径穿越被拒绝: {path}（目标在任务根目录之外）") from None

    # 安全检查 3：如果路径存在且是符号链接，检查 real 目标
    if resolved.exists() and resolved.is_symlink():
        real_target = resolved.resolve()
        try:
            real_target.relative_to(task_root)
        except ValueError:
            raise ValueError(
                f"符号链接指向任务根目录外被拒绝: {path} -> {real_target}"
            ) from None

    return resolved


def _resolve_safe_write_path(path: str, work_dir: WorkDirLike) -> Path:
    """将 Agent 写入路径限制在任务的专用 staging/agent 目录内。"""
    if Path(path).is_absolute():
        raise ValueError(f"不允许使用绝对路径: {path}")
    try:
        return work_dir.agent_staging_file(path)
    except ValueError:
        raise ValueError(f"路径穿越被拒绝: {path}（目标在 Agent 暂存目录之外）") from None


_READ_FILE_MAX_BYTES = 1024 * 1024  # 1 MB — 覆盖中等文件;超大文件用 read_file_head/search_file
_READ_FILE_HEAD_DEFAULT_LINES = 50
_READ_FILE_HEAD_MAX_LINE_CHARS = 200
_SEARCH_FILE_DEFAULT_MAX_RESULTS = 20
_SEARCH_FILE_MAX_LINE_CHARS = 300
_IO_LINE_HARD_LIMIT = 64 * 1024  # 64 KB：单行内存硬上限，防超长行 OOM


def _read_line_bounded(f: Any, limit: int = _IO_LINE_HARD_LIMIT) -> str | None:
    """流式读取一个逻辑行，但限制该行在内存中保留的字符数。

    超长行只保留前 ``limit`` 个字符，其余部分被读取后丢弃，使后续读取
    仍从下一行开始。返回 ``None`` 表示 EOF。
    """
    chunk = f.readline(limit + 1)
    if not chunk:
        return None
    if chunk.endswith(("\n", "\r")) or len(chunk) <= limit:
        return chunk
    while True:
        rest = f.readline(limit + 1)
        if not rest:
            break
        if rest.endswith(("\n", "\r")) or len(rest) <= limit:
            break
    return chunk[:limit] + "…"


@function_tool
def read_file(ctx: RunContextWrapper[Any], path: str) -> str:
    """读取任务工作目录内的文件内容。path 为相对于任务根目录的相对路径。"""
    work_dir: WorkDirLike = ctx.context.work_dir
    try:
        safe_path = _resolve_safe_path(path, work_dir)
    except ValueError as e:
        return f"路径错误: {e}"

    if not safe_path.exists():
        return f"文件不存在: {safe_path}"
    file_size = safe_path.stat().st_size
    if file_size > _READ_FILE_MAX_BYTES:
        return (
            f"文件过大（{file_size:,} 字节，上限 {_READ_FILE_MAX_BYTES:,} 字节）。"
            f"大文件请用 read_file_head 查看前 N 行结构，或用 search_file 按关键词"
            f"（基因名/样本 ID/条目名）定位具体行——两者均流式读取，不加载全文。"
        )
    return safe_path.read_text(encoding="utf-8")


@function_tool
def read_file_head(
    ctx: RunContextWrapper[Any],
    path: str,
    max_lines: int = _READ_FILE_HEAD_DEFAULT_LINES,
) -> str:
    """读取大文件的前 N 行（默认 50 行），用于查看表头/结构，不会加载整个文件。

    path 为相对于任务根目录的相对路径；max_lines 为要读取的行数上限。
    """
    work_dir: WorkDirLike = ctx.context.work_dir
    try:
        safe_path = _resolve_safe_path(path, work_dir)
    except ValueError as e:
        return f"路径错误: {e}"

    if not safe_path.exists():
        return f"文件不存在: {safe_path}"
    if max_lines <= 0:
        return "参数错误: max_lines 必须大于 0"
    file_size = safe_path.stat().st_size
    lines: list[str] = []
    with safe_path.open(encoding="utf-8-sig", errors="replace") as f:
        while len(lines) < max_lines:
            line = _read_line_bounded(f)
            if line is None:
                break
            rendered = line.rstrip("\n").rstrip("\r")
            if len(rendered) > _READ_FILE_HEAD_MAX_LINE_CHARS:
                rendered = rendered[:_READ_FILE_HEAD_MAX_LINE_CHARS] + "…"
            lines.append(f"{len(lines) + 1:>6} | {rendered}")
    truncated = len(lines) == max_lines
    size_hint = f"{file_size:,} 字节"
    note = f"（仅前 {max_lines} 行，文件更大，如需更多请调大 max_lines）" if truncated else ""
    return (
        f"文件: {path}\n大小: {size_hint}\n"
        f"前 {len(lines)} 行{note}:\n" + "\n".join(lines)
    )


@function_tool
def search_file(
    ctx: RunContextWrapper[Any],
    path: str,
    query: str,
    max_results: int = _SEARCH_FILE_DEFAULT_MAX_RESULTS,
    case_sensitive: bool = False,
) -> str:
    """在文件中按关键词检索（grep 式），返回匹配行的行号与内容片段。

    适合在超大文件（如 parsed/ 下的大型 CSV）中定位特定基因/样本/条目，
    逐行流式扫描，不会把整个文件加载到内存。path 为相对任务根目录的路径；
    query 为要检索的关键词；max_results 限制返回条数（默认 20）；
    case_sensitive 为 True 时区分大小写。
    """
    work_dir: WorkDirLike = ctx.context.work_dir
    try:
        safe_path = _resolve_safe_path(path, work_dir)
    except ValueError as e:
        return f"路径错误: {e}"

    if not safe_path.exists():
        return f"文件不存在: {safe_path}"
    if not query:
        return "参数错误: query 不能为空"
    if max_results <= 0:
        return "参数错误: max_results 必须大于 0"
    needle = query if case_sensitive else query.casefold()
    matches: list[str] = []
    scanned = 0
    with safe_path.open(encoding="utf-8-sig", errors="replace") as f:
        while True:
            line = _read_line_bounded(f)
            if line is None:
                break
            scanned += 1
            haystack = line if case_sensitive else line.casefold()
            if needle in haystack:
                rendered = line.rstrip("\n").rstrip("\r")
                if len(rendered) > _SEARCH_FILE_MAX_LINE_CHARS:
                    rendered = rendered[:_SEARCH_FILE_MAX_LINE_CHARS] + "…"
                matches.append(f"{scanned:>7} | {rendered}")
                if len(matches) >= max_results:
                    break
    hit_note = f"{len(matches)} 条匹配（已达上限，可缩小关键词或调大 max_results）" if (
        len(matches) >= max_results
    ) else f"{len(matches)} 条匹配"
    return (
        f"文件: {path}\n检索: {query!r}（共扫描 {scanned:,} 行，{hit_note}）:\n"
        + "\n".join(matches)
        + ("\n（未找到匹配）" if not matches else "")
    )


@function_tool
def write_file(ctx: RunContextWrapper[Any], path: str, content: str) -> str:
    """将内容写入任务 staging/agent 目录。path 为相对路径。"""
    work_dir: WorkDirLike = ctx.context.work_dir
    try:
        safe_path = _resolve_safe_write_path(path, work_dir)
    except ValueError as e:
        return f"路径错误: {e}"

    safe_path.parent.mkdir(parents=True, exist_ok=True)
    safe_path.write_text(content, encoding="utf-8")
    return f"已写入: {safe_path}"


@function_tool
def list_files(ctx: RunContextWrapper[Any], subdir: str = "") -> str:
    """列出任务工作目录下的文件。subdir 为可选子目录（相对路径）。"""
    work_dir: WorkDirLike = ctx.context.work_dir
    try:
        d = _resolve_safe_path(subdir, work_dir) if subdir else work_dir.root.resolve()
    except ValueError as e:
        return f"路径错误: {e}"

    if not d.exists():
        return f"目录不存在: {d}"
    task_root = work_dir.root.resolve()
    files = [str(f.relative_to(task_root)) for f in d.rglob("*") if f.is_file()]
    return "\n".join(files) if files else "（空目录）"
