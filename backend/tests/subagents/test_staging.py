from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256
from app.subagents.staging import SubagentStagingWorkspace


def test_staging_commits_asset_atomically_outside_artifacts(tmp_path: Path) -> None:
    task_root = tmp_path / "task"
    workspace = SubagentStagingWorkspace(task_root, "sub_1")
    asset = workspace.stage_bytes(
        content=b"validated source bytes",
        filename="data.csv",
        source_id="src_1",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.METADATA,
        media_type="text/csv",
    )
    staged = workspace.staged_path(asset)

    committed = workspace.commit_source_asset(asset)

    final_path = task_root / committed.relative_path
    assert not staged.exists()
    assert final_path.read_bytes() == b"validated source bytes"
    assert final_path.is_relative_to(task_root / "source_assets")
    assert not (task_root / "artifacts").exists()


def test_staging_rejects_unsafe_subagent_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="subagent_id"):
        SubagentStagingWorkspace(tmp_path / "task", "../outside")


def test_staging_constructor_rejects_preexisting_workspace_symlink(
    tmp_path: Path,
) -> None:
    task_root = tmp_path / "task"
    workspace_parent = task_root / "staging" / "subagents"
    workspace_parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    linked_root = workspace_parent / "sub_1"
    try:
        linked_root.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this platform")

    with pytest.raises(ValueError, match="symlink|reparse|trusted"):
        SubagentStagingWorkspace(task_root, "sub_1")

    assert list(outside.iterdir()) == []


def test_staging_rejects_preexisting_source_assets_symlink(
    tmp_path: Path,
) -> None:
    task_root = tmp_path / "task"
    task_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (task_root / "source_assets").symlink_to(
            outside,
            target_is_directory=True,
        )
    except OSError:
        pytest.skip("directory symlinks are unavailable on this platform")
    workspace = SubagentStagingWorkspace(task_root, "sub_1")
    asset = workspace.stage_bytes(
        content=b"candidate",
        filename="data.bin",
        source_id="src_1",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.METADATA,
        media_type="application/octet-stream",
    )

    with pytest.raises(ValueError, match="symlink|reparse|trusted"):
        workspace.commit_source_asset(asset)

    assert list(outside.iterdir()) == []
    assert workspace.staged_path(asset).is_file()


def test_stage_bytes_rejects_preexisting_staging_source_assets_symlink(
    tmp_path: Path,
) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    outside = tmp_path / "outside"
    outside.mkdir()
    staging_source_assets = workspace.root / "source_assets"
    try:
        staging_source_assets.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this platform")

    with pytest.raises(ValueError, match="symlink|reparse|trusted"):
        workspace.stage_bytes(
            content=b"candidate",
            filename="data.bin",
            source_id="src_1",
            successful_attempt_id="download_attempt_1",
            data_level=DataLevel.METADATA,
            media_type="application/octet-stream",
        )

    assert list(outside.iterdir()) == []


def test_staging_rejects_path_traversal(tmp_path: Path) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")

    with pytest.raises(ValueError, match="staging workspace"):
        workspace.validate_path(workspace.root / ".." / "outside.csv")


def test_staging_rejects_symlink_escape(tmp_path: Path) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    outside = tmp_path / "outside.csv"
    outside.write_bytes(b"outside")
    escaped = workspace.root / "escaped.csv"
    try:
        escaped.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are unavailable on this platform")

    with pytest.raises(ValueError, match="staging workspace"):
        workspace.validate_path(escaped)


def test_staging_rejects_hardlinked_candidate(tmp_path: Path) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    asset = workspace.stage_bytes(
        content=b"hardlink",
        filename="data.bin",
        source_id="src_1",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.METADATA,
        media_type="application/octet-stream",
    )
    link = tmp_path / "outside-link"
    try:
        os.link(workspace.staged_path(asset), link)
    except OSError:
        pytest.skip("hardlinks are unavailable on this platform")

    with pytest.raises(ValueError, match="hardlink"):
        workspace.commit_source_asset(asset)


@pytest.mark.parametrize("mutation", ["size", "checksum", "media_type"])
def test_staging_validates_asset_metadata(tmp_path: Path, mutation: str) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    asset = workspace.stage_bytes(
        content=b"candidate",
        filename="data.bin",
        source_id="src_1",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.METADATA,
        media_type="application/octet-stream",
    )
    updates: dict[str, object]
    if mutation == "size":
        updates = {"size_bytes": asset.size_bytes + 1}
    elif mutation == "checksum":
        checksum = hashlib.sha256(b"different").hexdigest()
        updates = {
            "sha256": checksum,
            "asset_id": asset_id_from_sha256(checksum),
        }
    else:
        updates = {"media_type": "invalid media"}
    invalid = SourceAsset.model_validate({**asset.model_dump(mode="json"), **updates})

    with pytest.raises(ValueError, match="size|checksum|media type"):
        workspace.commit_source_asset(invalid)


def test_failed_commit_leaves_no_partial_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    asset = workspace.stage_bytes(
        content=b"candidate",
        filename="data.bin",
        source_id="src_1",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.METADATA,
        media_type="application/octet-stream",
    )

    def fail_replace(self: Path, target: Path) -> Path:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(Path, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated"):
        workspace.commit_source_asset(asset)

    assert not (tmp_path / "task" / asset.relative_path).exists()
    assert workspace.staged_path(asset).exists()


def test_commit_detects_destination_parent_swap_and_rolls_back(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    asset = workspace.stage_bytes(
        content=b"candidate",
        filename="data.bin",
        source_id="src_1",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.METADATA,
        media_type="application/octet-stream",
    )
    original_replace = Path.replace
    detached_parent = tmp_path / "detached-parent"

    def swap_parent_then_replace(self: Path, target: Path) -> Path:
        original_replace(target.parent, detached_parent)
        target.parent.mkdir(parents=True)
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", swap_parent_then_replace)

    with pytest.raises(ValueError, match="changed during SourceAsset commit"):
        workspace.commit_source_asset(asset)

    assert not (tmp_path / "task" / asset.relative_path).exists()
    assert not (detached_parent / asset.relative_path).exists()
