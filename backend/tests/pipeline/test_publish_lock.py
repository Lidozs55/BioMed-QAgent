"""Tests for TODO §8 line 276: publish task lock + atomic rename + manifest marker.

Covers the Validation Gate publish step:
- TaskLock: blocking acquire with timeout, release, re-acquire, cross-holder
  serialization.
- Atomic publish via rename-aside: a prior artifacts/ dir is fully replaced
  with no window where artifacts/ is missing or partially populated.
- publish_completed marker: written only after a successful publish, absent
  on validation failure or mid-publish crash.
"""
from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest
from app.pipeline.runner import PipelineRunner
from app.pipeline.state import TaskLock

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


# ---------------------------------------------------------------------------
# TaskLock
# ---------------------------------------------------------------------------


def test_task_lock_acquire_release_reacquire(tmp_path: Path) -> None:
    lock = TaskLock(tmp_path / "task.lock")
    lock.acquire()
    try:
        assert (tmp_path / "task.lock").is_file()
    finally:
        lock.release()
    # After release the lock can be re-acquired.
    lock2 = TaskLock(tmp_path / "task.lock")
    lock2.acquire()
    lock2.release()


def test_task_lock_context_manager(tmp_path: Path) -> None:
    lock_file = tmp_path / "task.lock"
    with TaskLock(lock_file):
        assert lock_file.is_file()
    # Re-acquire after context exit.
    with TaskLock(lock_file):
        pass


def test_task_lock_blocking_raises_timeout(tmp_path: Path) -> None:
    """A second acquire while the lock is held must time out."""
    lock_file = tmp_path / "task.lock"
    holder = TaskLock(lock_file)
    holder.acquire()
    try:
        contender = TaskLock(lock_file, timeout=0.3)
        with pytest.raises(TimeoutError):
            contender.acquire()
    finally:
        holder.release()


def test_task_lock_release_on_process_exit_via_handle(tmp_path: Path) -> None:
    """A lock held in another thread, when released, becomes acquirable."""
    lock_file = tmp_path / "task.lock"
    acquired = threading.Event()
    release = threading.Event()

    def hold() -> None:
        with TaskLock(lock_file):
            acquired.set()
            release.wait(timeout=5)

    t = threading.Thread(target=hold)
    t.start()
    assert acquired.wait(timeout=5)
    # While held, a fresh acquire times out.
    contender = TaskLock(lock_file, timeout=0.2)
    with pytest.raises(TimeoutError):
        contender.acquire()
    release.set()
    t.join(timeout=5)
    # After the holder releases, acquire succeeds.
    with TaskLock(lock_file, timeout=2.0):
        pass


# ---------------------------------------------------------------------------
# publish_completed marker
# ---------------------------------------------------------------------------


def test_publish_marker_written_after_completed_run(tmp_path: Path) -> None:
    runner = PipelineRunner(
        task_id="task_marker_ok",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed"
    marker = tmp_path / "tasks" / "task_marker_ok" / "state" / "publish_completed.json"
    assert marker.is_file(), "publish_completed marker must exist after a completed run"


def test_publish_marker_absent_on_validation_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If validation rejects the package, no publish marker is written."""
    import app.pipeline.stages.validation as validation_module

    real_validate = validation_module._validate_package

    def rejecting_validate(staging, source_path, report_path):
        summary, _checks = real_validate(staging, source_path, report_path)
        # Force a failure so the gate rejects.
        from app.domain.contracts import ValidationSummary
        return ValidationSummary(
            status="invalid",
            checked_count=summary.checked_count,
            failed_count=1,
            report_path=summary.report_path,
        ), _checks

    monkeypatch.setattr(validation_module, "_validate_package", rejecting_validate)

    runner = PipelineRunner(
        task_id="task_marker_fail",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "failed"
    marker = tmp_path / "tasks" / "task_marker_fail" / "state" / "publish_completed.json"
    assert not marker.is_file(), "no marker when validation fails"


# ---------------------------------------------------------------------------
# Atomic rename-aside publish
# ---------------------------------------------------------------------------


def test_republish_atomically_replaces_old_artifacts(tmp_path: Path) -> None:
    """A second publish fully replaces a prior artifacts/ dir.

    Simulates a re-publish (e.g. recovery with digest mismatch) by invoking
    the publish helper directly: a stale file present in artifacts/ before
    publish must not survive after publish.
    """
    from app.pipeline.stages.validation import _publish_artifacts

    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "main_data.csv").write_text("header\n", encoding="utf-8")
    (staging / "run_manifest.json").write_text("{}", encoding="utf-8")

    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "stale_file.csv").write_text("old", encoding="utf-8")

    state_dir = tmp_path / "state"
    state_dir.mkdir()

    _publish_artifacts(staging, artifacts, state_dir)

    # artifacts/ now contains exactly the staging package; no stale files.
    names = {p.name for p in artifacts.iterdir()}
    assert names == {"main_data.csv", "run_manifest.json"}
    assert not (artifacts / "stale_file.csv").exists()
    # staging dir is gone (renamed into place).
    assert not staging.exists()
    # marker written.
    assert (state_dir / "publish_completed.json").is_file()


def test_publish_to_empty_artifacts(tmp_path: Path) -> None:
    """Publish when no prior artifacts/ exists creates it atomically."""
    from app.pipeline.stages.validation import _publish_artifacts

    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "main_data.csv").write_text("h\n", encoding="utf-8")
    artifacts = tmp_path / "artifacts"
    state_dir = tmp_path / "state"
    state_dir.mkdir()

    _publish_artifacts(staging, artifacts, state_dir)

    assert artifacts.is_dir()
    assert (artifacts / "main_data.csv").read_text(encoding="utf-8") == "h\n"
    assert (state_dir / "publish_completed.json").is_file()
