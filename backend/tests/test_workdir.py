"""工作目录工具测试 — 验证任务工作目录创建和路径结构。"""
from __future__ import annotations

from pathlib import Path

import pytest
from app.tools.workdir import create_task_workdir


def test_create_task_workdir_creates_all_subdirs(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_001", base_dir=str(tmp_path))

    assert wd.root == tmp_path / "test_task_001"
    assert wd.source_assets.is_dir()
    assert wd.download_tmp.is_dir()
    assert wd.parsed.is_dir()
    assert wd.normalized.is_dir()
    assert wd.staging.is_dir()
    assert wd.artifacts.is_dir()
    assert wd.state.is_dir()
    assert wd.logs.is_dir()


def test_create_task_workdir_idempotent(tmp_path: Path) -> None:
    """重复创建同一 task_id 目录不报错。"""
    wd1 = create_task_workdir("test_task_002", base_dir=str(tmp_path))
    wd2 = create_task_workdir("test_task_002", base_dir=str(tmp_path))
    assert wd1.root == wd2.root


def test_create_task_workdir_resolves_relative_base_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    wd = create_task_workdir("test_task_relative", base_dir="data/tasks")

    expected_root = (tmp_path / "data" / "tasks" / "test_task_relative").resolve()
    assert wd.root == expected_root
    assert all(
        path.is_absolute()
        for path in (
            wd.root,
            wd.source_assets,
            wd.download_tmp,
            wd.parsed,
            wd.normalized,
            wd.staging,
            wd.artifacts,
            wd.state,
            wd.logs,
        )
    )


def test_different_tasks_have_isolated_dirs(tmp_path: Path) -> None:
    wd1 = create_task_workdir("task_a", base_dir=str(tmp_path))
    wd2 = create_task_workdir("task_b", base_dir=str(tmp_path))
    assert wd1.root != wd2.root
    assert wd1.source_assets != wd2.source_assets


def test_raw_is_a_read_only_compatibility_alias(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_003", base_dir=str(tmp_path))
    assert wd.raw == wd.source_assets
    assert wd.raw_file("data.csv") == wd.source_assets / "data.csv"


def test_staging_run_creates_an_isolated_run_directory(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_003", base_dir=str(tmp_path))

    run_dir = wd.staging_run("run_001")

    assert run_dir == wd.staging / "run_001"
    assert run_dir.is_dir()


def test_artifact_file_path(tmp_path: Path) -> None:
    wd = create_task_workdir("test_task_004", base_dir=str(tmp_path))
    assert wd.artifact_file("result.csv") == wd.artifacts / "result.csv"


def test_workdir_is_frozen(tmp_path: Path) -> None:
    """TaskWorkDir 是 frozen dataclass，不可变。"""
    wd = create_task_workdir("test_task_005", base_dir=str(tmp_path))
    with pytest.raises(AttributeError):
        wd.root = tmp_path / "other"  # type: ignore[misc]


@pytest.mark.parametrize("task_id", ["../escape", "C:/escape", "with space", ""])
def test_create_task_workdir_rejects_unsafe_task_ids(
    tmp_path: Path, task_id: str
) -> None:
    with pytest.raises(ValueError, match="task_id"):
        create_task_workdir(task_id, base_dir=str(tmp_path))


@pytest.mark.parametrize("filename", ["../escape.csv", "/absolute.csv", "C:/escape.csv"])
def test_file_helpers_reject_paths_outside_their_directory(
    tmp_path: Path, filename: str
) -> None:
    wd = create_task_workdir("test_task_006", base_dir=str(tmp_path))

    with pytest.raises(ValueError, match="path"):
        wd.artifact_file(filename)
