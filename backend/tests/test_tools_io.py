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
from app.tools.io import (
    list_files,
    read_file,
    read_file_head,
    search_file,
    write_file,
)
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


def test_read_file_rejects_oversized_file(tmp_path: Path) -> None:
    """read_file must reject files larger than the 1MB guard with guidance."""
    rc = _isolated_run_ctx(tmp_path, "test_read_large")
    big_file = rc.work_dir.parsed / "big.csv"
    big_file.write_text("x" * (1024 * 1024 + 1), encoding="utf-8")

    ctx = _make_ctx(rc, "read_file")
    result = _call(read_file, ctx, path="parsed/big.csv")

    assert "文件过大" in result
    assert "read_file_head" in result
    assert "search_file" in result


def test_read_file_allows_exactly_at_limit(tmp_path: Path) -> None:
    """A file at or under the 1MB limit should still be readable."""
    rc = _isolated_run_ctx(tmp_path, "test_read_at_limit")
    ok_file = rc.work_dir.parsed / "ok.csv"
    ok_file.write_text("a,b\n1,2", encoding="utf-8")

    ctx = _make_ctx(rc, "read_file")
    result = _call(read_file, ctx, path="parsed/ok.csv")

    assert result == "a,b\n1,2"


# ── read_file_head tests ────────────────────────────────────────────


def test_read_file_head_returns_first_lines(tmp_path: Path) -> None:
    """read_file_head returns the first N lines with line numbers."""
    rc = _isolated_run_ctx(tmp_path, "test_head")
    f = rc.work_dir.parsed / "big.csv"
    f.write_text(
        "gene,sample,value\nBRCA1,S1,1.5\nTP53,S1,2.0\n",
        encoding="utf-8",
    )

    ctx = _make_ctx(rc, "read_file_head")
    result = _call(read_file_head, ctx, path="parsed/big.csv")

    assert "文件: parsed/big.csv" in result
    assert "gene,sample,value" in result
    assert "BRCA1" in result
    assert "TP53" in result
    assert "| " in result  # line numbers rendered


def test_read_file_head_respects_max_lines(tmp_path: Path) -> None:
    """read_file_head must stop after max_lines and note truncation."""
    rc = _isolated_run_ctx(tmp_path, "test_head_limit")
    f = rc.work_dir.parsed / "big.csv"
    f.write_text("\n".join(f"row{i}" for i in range(100)), encoding="utf-8")

    ctx = _make_ctx(rc, "read_file_head")
    result = _call(read_file_head, ctx, path="parsed/big.csv", max_lines=3)

    assert "row0" in result
    assert "row2" in result
    assert "row3" not in result
    assert "仅前 3 行" in result


def test_read_file_head_truncates_long_lines(tmp_path: Path) -> None:
    """read_file_head truncates over-long lines to protect context size."""
    rc = _isolated_run_ctx(tmp_path, "test_head_trunc")
    f = rc.work_dir.parsed / "long.csv"
    f.write_text("x" * 500, encoding="utf-8")

    ctx = _make_ctx(rc, "read_file_head")
    result = _call(read_file_head, ctx, path="parsed/long.csv", max_lines=1)

    assert len(result) < 500
    assert "…" in result


def test_read_file_head_rejects_bad_args(tmp_path: Path) -> None:
    """read_file_head validates max_lines and missing files."""
    rc = _isolated_run_ctx(tmp_path, "test_head_bad")
    (rc.work_dir.parsed / "whatever.csv").write_text("a,b", encoding="utf-8")
    ctx = _make_ctx(rc, "read_file_head")

    assert "参数错误" in _call(
        read_file_head, ctx, path="parsed/whatever.csv", max_lines=0
    )
    assert "文件不存在" in _call(read_file_head, ctx, path="nope.csv")


# ── search_file tests ───────────────────────────────────────────────


def test_search_file_finds_matching_rows(tmp_path: Path) -> None:
    """search_file locates rows containing the query with line numbers."""
    rc = _isolated_run_ctx(tmp_path, "test_search")
    f = rc.work_dir.parsed / "big.csv"
    f.write_text(
        "gene,sample,value\nBRCA1,S1,1.5\nTP53,S1,2.0\nBRCA1,S2,3.5\n",
        encoding="utf-8",
    )

    ctx = _make_ctx(rc, "search_file")
    result = _call(search_file, ctx, path="parsed/big.csv", query="BRCA1")

    assert "2 条匹配" in result
    assert "BRCA1,S1,1.5" in result
    assert "BRCA1,S2,3.5" in result
    assert "TP53" not in result


def test_search_file_case_insensitive_by_default(tmp_path: Path) -> None:
    """search_file is case-insensitive unless case_sensitive=True."""
    rc = _isolated_run_ctx(tmp_path, "test_search_case")
    f = rc.work_dir.parsed / "big.csv"
    f.write_text("BRCA1\nbrca1\nBrCa1\n", encoding="utf-8")

    ctx = _make_ctx(rc, "search_file")
    insensitive = _call(search_file, ctx, path="parsed/big.csv", query="brca1")
    sensitive = _call(
        search_file, ctx, path="parsed/big.csv", query="brca1", case_sensitive=True
    )

    assert "3 条匹配" in insensitive
    assert "1 条匹配" in sensitive


def test_search_file_no_match(tmp_path: Path) -> None:
    """search_file reports no matches without erroring."""
    rc = _isolated_run_ctx(tmp_path, "test_search_none")
    f = rc.work_dir.parsed / "big.csv"
    f.write_text("BRCA1\nTP53\n", encoding="utf-8")

    ctx = _make_ctx(rc, "search_file")
    result = _call(search_file, ctx, path="parsed/big.csv", query="NOTHING")

    assert "0 条匹配" in result
    assert "未找到匹配" in result


def test_search_file_respects_max_results(tmp_path: Path) -> None:
    """search_file stops after max_results and reports the cap."""
    rc = _isolated_run_ctx(tmp_path, "test_search_cap")
    f = rc.work_dir.parsed / "big.csv"
    f.write_text("\n".join(f"row{i}" for i in range(50)), encoding="utf-8")

    ctx = _make_ctx(rc, "search_file")
    result = _call(search_file, ctx, path="parsed/big.csv", query="row", max_results=5)

    assert "5 条匹配（已达上限" in result
    assert "row4" in result
    assert "row5" not in result


def test_search_file_rejects_bad_args(tmp_path: Path) -> None:
    """search_file validates query/max_results and missing files."""
    rc = _isolated_run_ctx(tmp_path, "test_search_bad")
    (rc.work_dir.parsed / "x.csv").write_text("a\nb\n", encoding="utf-8")
    ctx = _make_ctx(rc, "search_file")

    assert "query 不能为空" in _call(search_file, ctx, path="parsed/x.csv", query="")
    assert "max_results 必须大于 0" in _call(
        search_file, ctx, path="parsed/x.csv", query="a", max_results=0
    )
    assert "文件不存在" in _call(search_file, ctx, path="nope.csv", query="a")


def test_search_file_handles_bom_csv(tmp_path: Path) -> None:
    """search_file decodes UTF-8 BOM so header search works."""
    rc = _isolated_run_ctx(tmp_path, "test_search_bom")
    f = rc.work_dir.parsed / "big.csv"
    f.write_bytes("\ufeffgene,sample\nBRCA1,S1\n".encode("utf-8"))

    ctx = _make_ctx(rc, "search_file")
    result = _call(search_file, ctx, path="parsed/big.csv", query="gene")

    assert "1 条匹配" in result


def test_search_file_handles_oversized_line(tmp_path: Path) -> None:
    """A single over-long line (e.g. a giant JSONL record) must not OOM the tool.

    Line numbers must remain correct after the oversized line is skipped.
    """
    rc = _isolated_run_ctx(tmp_path, "test_search_huge_line")
    f = rc.work_dir.parsed / "huge.jsonl"
    f.write_text("x" * (200 * 1024) + "\nBRCA1_hit\n", encoding="utf-8")

    ctx = _make_ctx(rc, "search_file")
    result = _call(search_file, ctx, path="parsed/huge.jsonl", query="BRCA1_hit")

    assert "1 条匹配" in result
    assert "2 | BRCA1_hit" in result


def test_read_file_head_handles_oversized_line(tmp_path: Path) -> None:
    """read_file_head must not load an over-long line fully into memory."""
    rc = _isolated_run_ctx(tmp_path, "test_head_huge_line")
    f = rc.work_dir.parsed / "huge.jsonl"
    f.write_text("y" * (200 * 1024) + "\nsecond line\n", encoding="utf-8")

    ctx = _make_ctx(rc, "read_file_head")
    result = _call(read_file_head, ctx, path="parsed/huge.jsonl", max_lines=2)

    assert "2 | second line" in result
    assert "…" in result
    assert len(result) < 100 * 1024  # never materialized the full 200KB line


def test_read_file_head_decompresses_gzip(tmp_path: Path) -> None:
    """read_file_head must transparently decompress gzip files.

    GEO series matrices are gzip-compressed; reading them raw yields binary
    garbage.  The tool must show real table headers so the agent can preview
    structure (e.g. ``!series_matrix_table_begin``) before building.
    (See docs/REVIEW_2026-08-10-task-9ce0124f.md §5.1 T3.)
    """
    import gzip

    rc = _isolated_run_ctx(tmp_path, "test_head_gzip")
    raw = (
        '!Series_title = "Test"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM1"\t"GSM2"\n'
    )
    (rc.work_dir.source_assets / "GSE1_series_matrix.txt.gz").write_bytes(
        gzip.compress(raw.encode("utf-8"))
    )

    ctx = _make_ctx(rc, "read_file_head")
    result = _call(
        read_file_head,
        ctx,
        path="source_assets/GSE1_series_matrix.txt.gz",
        max_lines=5,
    )

    assert "!Series_title" in result
    assert "!series_matrix_table_begin" in result
    assert '"ID_REF"' in result


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
