"""Tests for file I/O tool path safety (Sprint 0).

Validates:
  - write_file with relative path succeeds
  - write_file with absolute path returns error string
  - write_file with ".." traversal returns error string
  - read_file with relative path returns file content
  - list_files works with subdirectory

The io tools are decorated with @function_tool, producing FunctionTool objects.
We call them via on_invoke_tool(ctx, json_args) with ToolContext.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.tools.io import list_files, read_file, write_file
from app.tools.workdir import create_task_workdir


def _make_ctx(run_ctx: RunContext, tool_name: str) -> ToolContext:
    """Build a ToolContext for testing tool invocations."""
    return ToolContext(
        context=run_ctx,
        tool_name=tool_name,
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _call(tool, ctx: ToolContext, **kwargs) -> str:
    """Synchronously invoke a FunctionTool's on_invoke_tool."""
    return asyncio.run(tool.on_invoke_tool(ctx, json.dumps(kwargs)))


def _isolated_run_ctx(tmp_path: Path, task_id: str) -> RunContext:
    run_ctx = RunContext(task_id=task_id)
    run_ctx._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return run_ctx


# Platform-specific absolute path: on Windows use a drive letter,
# on Linux/macOS use a root-absolute path.
_ABS_PATH = "C:/foo.txt" if os.name == "nt" else "/foo.txt"
_ABS_PATH_2 = "D:/secret.txt" if os.name == "nt" else "/secret.txt"


# ── write_file tests ────────────────────────────────────────────────


def test_write_file_relative_path_succeeds(tmp_path: Path) -> None:
    """Writing with a relative path should create the file in Agent staging."""
    rc = _isolated_run_ctx(tmp_path, "test_write_rel")
    ctx = _make_ctx(rc, "write_file")

    result = _call(write_file, ctx, path="hello.txt", content="hello world")

    assert "已写入" in result
    written = rc.work_dir.staging / "agent" / "hello.txt"
    assert written.exists()
    assert written.read_text(encoding="utf-8") == "hello world"
    assert not (rc.work_dir.root / "hello.txt").exists()
    assert rc.artifacts == []


def test_write_file_absolute_path_rejected() -> None:
    """Absolute paths must be rejected with a 路径错误 message."""
    rc = RunContext(task_id="test_write_abs")
    ctx = _make_ctx(rc, "write_file")

    result = _call(write_file, ctx, path=_ABS_PATH, content="bad")

    assert "路径错误" in result
    assert "绝对路径" in result


def test_write_file_parent_traversal_rejected() -> None:
    """.. traversal must be rejected."""
    rc = RunContext(task_id="test_write_traversal")
    ctx = _make_ctx(rc, "write_file")

    result = _call(write_file, ctx, path="../state/task.lock", content="bad")

    assert "路径错误" in result
    assert not (rc.work_dir.staging / "state" / "task.lock").exists()


def test_write_file_creates_parent_dirs(tmp_path: Path) -> None:
    """Writing to a nested path should auto-create parent directories."""
    rc = _isolated_run_ctx(tmp_path, "test_write_nested")
    ctx = _make_ctx(rc, "write_file")

    result = _call(
        write_file,
        ctx,
        path="sub/deep/nested.txt",
        content="nested content",
    )

    assert "已写入" in result
    nested = rc.work_dir.staging / "agent" / "sub" / "deep" / "nested.txt"
    assert nested.exists()
    assert nested.read_text(encoding="utf-8") == "nested content"


# ── read_file tests ─────────────────────────────────────────────────


def test_read_file_returns_content(tmp_path: Path) -> None:
    """Reading a file written earlier should return its content."""
    rc = _isolated_run_ctx(tmp_path, "test_read")
    ctx = _make_ctx(rc, "write_file")

    # write first
    _call(write_file, ctx, path="data.txt", content="some content")

    # then read
    read_ctx = _make_ctx(rc, "read_file")
    result = _call(read_file, read_ctx, path="staging/agent/data.txt")

    assert result == "some content"


def test_read_file_from_source_assets() -> None:
    """Reading a file in source_assets/ (downloaded by a skill) should succeed
    now that the sandbox boundary has been widened to the task root."""
    rc = RunContext(task_id="test_read_raw")
    # Simulate a file downloaded by a skill into source_assets/
    raw_file = rc.work_dir.source_assets / "downloaded.csv"
    raw_file.write_text("gene,log2fc\nBRCA1,1.5", encoding="utf-8")

    ctx = _make_ctx(rc, "read_file")
    result = _call(read_file, ctx, path="source_assets/downloaded.csv")

    assert "BRCA1" in result


def test_read_file_from_parsed() -> None:
    """Reading a file in parsed/ (produced by a processing skill) should succeed."""
    rc = RunContext(task_id="test_read_parsed")
    parsed_file = rc.work_dir.parsed / "table1.csv"
    parsed_file.write_text("a,b\n1,2", encoding="utf-8")

    ctx = _make_ctx(rc, "read_file")
    result = _call(read_file, ctx, path="parsed/table1.csv")

    assert "a,b" in result


def test_read_file_not_found() -> None:
    """Reading a non-existent file returns an error message."""
    rc = RunContext(task_id="test_read_missing")
    ctx = _make_ctx(rc, "read_file")

    result = _call(read_file, ctx, path="nonexistent.txt")

    assert "文件不存在" in result


def test_read_file_absolute_rejected() -> None:
    """Absolute path in read_file is also rejected."""
    rc = RunContext(task_id="test_read_abs")
    ctx = _make_ctx(rc, "read_file")

    result = _call(read_file, ctx, path=_ABS_PATH_2)

    assert "路径错误" in result


# ── list_files tests ────────────────────────────────────────────────


def test_list_files_empty_dir() -> None:
    """Listing an empty directory should return 空目录."""
    rc = RunContext(task_id="test_list_empty")
    ctx = _make_ctx(rc, "list_files")

    result = _call(list_files, ctx, subdir="")

    assert "空目录" in result


def test_list_files_with_subdir() -> None:
    """Listing a subdirectory with files should return relative paths."""
    rc = RunContext(task_id="test_list_subdir")

    # Create some files under task root
    (rc.work_dir.root / "sub").mkdir(exist_ok=True)
    (rc.work_dir.root / "sub" / "a.txt").write_text("a")
    (rc.work_dir.root / "sub" / "b.txt").write_text("b")

    ctx = _make_ctx(rc, "list_files")
    result = _call(list_files, ctx, subdir="sub")

    assert "a.txt" in result
    assert "b.txt" in result


def test_list_files_root_dir(tmp_path: Path) -> None:
    """Listing the root includes files from authoritative task stages."""
    rc = _isolated_run_ctx(tmp_path, "test_list_root")
    (rc.work_dir.source_assets / "input.csv").write_text("gene\nBRCA1")
    (rc.work_dir.parsed / "table.csv").write_text("gene,value\nBRCA1,1")

    ctx = _make_ctx(rc, "list_files")
    result = _call(list_files, ctx, subdir="")

    assert str(Path("source_assets") / "input.csv") in result
    assert str(Path("parsed") / "table.csv") in result
