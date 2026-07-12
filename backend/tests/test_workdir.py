"""工作目录工具测试 — 验证任务工作目录创建和路径结构。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.tools.workdir import TaskWorkDir, create_task_workdir


def test_create_task_workdir_creates_all_subdirs(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_001", base_dir=str(tmp_path))

    assert wd.root == tmp_path / "test_task_001"
    assert wd.raw.is_dir()
    assert wd.parsed.is_dir()
    assert wd.normalized.is_dir()
    assert wd.artifacts.is_dir()
    assert wd.logs.is_dir()


def test_create_task_workdir_idempotent(tmp_path: Path) -> None:
    """重复创建同一 task_id 目录不报错。"""
    wd1 = create_task_workdir("test_task_002", base_dir=str(tmp_path))
    wd2 = create_task_workdir("test_task_002", base_dir=str(tmp_path))
    assert wd1.root == wd2.root


def test_different_tasks_have_isolated_dirs(tmp_path: Path) -> None:
    wd1 = create_task_workdir("task_a", base_dir=str(tmp_path))
    wd2 = create_task_workdir("task_b", base_dir=str(tmp_path))
    assert wd1.root != wd2.root
    assert wd1.raw != wd2.raw


def test_raw_file_path(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_003", base_dir=str(tmp_path))
    assert wd.raw_file("data.csv") == wd.raw / "data.csv"


def test_artifact_file_path(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_004", base_dir=str(tmp_path))
    assert wd.artifact_file("result.csv") == wd.artifacts / "result.csv"


def test_workdir_is_frozen(tmp_path: Path) -> None:
    """TaskWorkDir 是 frozen dataclass，不可变。"""
    wd = create_task_workdir("test_task_005", base_dir=str(tmp_path))
    with pytest.raises(Exception):
        wd.root = tmp_path / "other"  # type: ignore[misc]
