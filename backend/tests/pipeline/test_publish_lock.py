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
from typing import BinaryIO

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
    assert (tmp_path / "task.lock").is_file()
    # After release the stable lock file can be re-acquired.
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


def test_task_lock_closes_handle_when_diagnostic_write_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.pipeline.state as state_module

    lock_file = tmp_path / "task.lock"
    lock_file.write_bytes(b"\0")
    real_fdopen = state_module.os.fdopen

    class FailingDiagnosticHandle:
        def __init__(self, handle: BinaryIO) -> None:
            self._handle = handle
            self.closed_by_lock = False

        def fileno(self) -> int:
            return self._handle.fileno()

        def seek(self, offset: int, whence: int = 0) -> int:
            return self._handle.seek(offset, whence)

        def write(self, data: bytes) -> int:
            raise OSError("diagnostic write failed")

        def truncate(self, size: int | None = None) -> int:
            return self._handle.truncate(size)

        def close(self) -> None:
            self.closed_by_lock = True
            self._handle.close()

    observed: dict[str, FailingDiagnosticHandle] = {}

    def failing_fdopen(
        fd: int, mode: str, buffering: int = -1
    ) -> FailingDiagnosticHandle:
        handle = FailingDiagnosticHandle(real_fdopen(fd, mode, buffering))
        observed["handle"] = handle
        return handle

    monkeypatch.setattr(state_module.os, "fdopen", failing_fdopen)
    lock = TaskLock(lock_file)

    with pytest.raises(OSError, match="diagnostic write failed"):
        lock.acquire()

    assert observed["handle"].closed_by_lock
    monkeypatch.setattr(state_module.os, "fdopen", real_fdopen)
    with TaskLock(lock_file, timeout=0.2):
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


def test_pipeline_runner_publish_waits_for_publish_lock(tmp_path: Path) -> None:
    """The real deferred-publication path must serialize on publish.lock."""
    task_id = "task_runner_publish_lock"
    run_id = "run_runner_publish_lock"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed"

    publish_started = threading.Event()
    publish_finished = threading.Event()
    errors: list[BaseException] = []

    def publish() -> None:
        publish_started.set()
        try:
            runner.publish(run_id)
        except BaseException as exc:
            errors.append(exc)
        finally:
            publish_finished.set()

    lock = TaskLock(task_root / "state" / "publish.lock")
    lock.acquire()
    thread = threading.Thread(target=publish)
    thread.start()
    try:
        assert publish_started.wait(timeout=2)
        assert not (
            task_root
            / "staging"
            / run_id
            / ".runtime-publication.json"
        ).exists(), "runtime marker was written before acquiring publish.lock"
        assert not (
            task_root / "artifacts" / ".runtime-publication.json"
        ).exists(), "runtime marker moved before acquiring publish.lock"
        assert not publish_finished.wait(timeout=0.2), (
            "PipelineRunner.publish() bypassed state/publish.lock"
        )
    finally:
        lock.release()
        thread.join(timeout=5)

    assert publish_finished.is_set()
    assert errors == []
    assert (task_root / "artifacts" / "run_manifest.json").is_file()


def test_publish_marker_write_failure_restores_previous_package(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A post-rename marker failure must restore the prior package exactly."""
    task_id = "task_publish_marker_rollback"
    run_id = "run_publish_marker_rollback"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed"

    artifacts = task_root / "artifacts"
    old_files = {
        "run_manifest.json": b'{"old":true}\n',
        "old_data.csv": b"old,value\r\n1,2\r\n",
        ".runtime-publication.json": (
            b'{"schema_version":1,"task_id":"task_publish_marker_rollback",'
            b'"run_id":"run_old","manifest_sha256":"'
            + (b"a" * 64)
            + b'"}\n'
        ),
    }
    for name, contents in old_files.items():
        (artifacts / name).write_bytes(contents)
    state_marker = task_root / "state" / "publish_completed.json"
    old_state_marker = b'{"old_publish":true}\n'
    state_marker.write_bytes(old_state_marker)

    marker_tmp = state_marker.with_suffix(".json.part")
    real_write_text = Path.write_text

    def fail_publish_marker_write(
        path: Path,
        data: str,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ) -> int:
        if path == marker_tmp:
            assert (artifacts / "main_data.csv").is_file()
            assert not (artifacts / "old_data.csv").exists()
            raise OSError("publish marker write failed")
        return real_write_text(
            path,
            data,
            encoding=encoding,
            errors=errors,
            newline=newline,
        )

    monkeypatch.setattr(Path, "write_text", fail_publish_marker_write)

    with pytest.raises(OSError, match="publish marker write failed"):
        runner.publish(run_id)

    restored_files = {
        path.relative_to(artifacts).as_posix(): path.read_bytes()
        for path in artifacts.rglob("*")
        if path.is_file()
    }
    assert restored_files == old_files
    assert state_marker.read_bytes() == old_state_marker
    assert (
        task_root / "staging" / run_id / "run_manifest.json"
    ).is_file()
    assert list(task_root.glob(".artifacts.previous-*")) == []
    assert list((task_root / "state").glob("publish_completed.previous-*")) == []
    assert not marker_tmp.exists()


def test_transient_backup_cleanup_failure_does_not_fail_committed_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Post-commit cleanup retries without reporting a committed publish failed."""
    import app.pipeline.stages.validation as validation_module

    task_id = "task_publish_cleanup_retry"
    run_id = "run_publish_cleanup_retry"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed"
    (task_root / "artifacts" / "old.csv").write_bytes(b"old\n")

    real_rmtree = validation_module.shutil.rmtree
    cleanup_failures = 0

    def fail_backup_cleanup_once(path: Path, *args, **kwargs) -> None:
        nonlocal cleanup_failures
        if Path(path).name.startswith(".artifacts.previous-") and cleanup_failures == 0:
            cleanup_failures += 1
            raise OSError("transient backup cleanup failure")
        real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(
        validation_module.shutil,
        "rmtree",
        fail_backup_cleanup_once,
    )

    runner.publish(run_id)

    assert cleanup_failures == 1
    assert (task_root / "artifacts" / "run_manifest.json").is_file()
    assert not (task_root / "artifacts" / "old.csv").exists()
    assert list(task_root.glob(".artifacts.previous-*")) == []
    assert (task_root / "state" / "publish_completed.json").is_file()


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


# ---------------------------------------------------------------------------
# Task-level runner lock (TODO §4.2 line 127)
# ---------------------------------------------------------------------------


def test_runner_task_lock_created_during_run(tmp_path: Path) -> None:
    """PipelineRunner holds task_running.lock for the duration of run()."""
    lock_file = tmp_path / "tasks" / "task_runner_lock" / "state" / "task_running.lock"
    observed: list[bool] = []

    runner = PipelineRunner(
        task_id="task_runner_lock",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    # Patch _run_inner to observe the lock file mid-execution.
    real_run_inner = runner._run_inner  # noqa: SLF001

    async def patched_run_inner():
        # Observe lock file exists while we are inside _run_inner.
        observed.append(lock_file.is_file())
        return await real_run_inner()

    runner._run_inner = patched_run_inner  # type: ignore[method-assign] # noqa: SLF001

    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed"
    assert observed == [True], "lock file must exist during _run_inner"
    assert lock_file.is_file(), "diagnostic lock file must remain stable"
    with TaskLock(lock_file, timeout=0.2):
        pass


def test_runner_lock_blocks_concurrent_runner(tmp_path: Path) -> None:
    """A second PipelineRunner on the same task_id times out waiting for the lock."""
    lock_file = tmp_path / "tasks" / "task_concurrent" / "state" / "task_running.lock"

    # Hold the lock manually to simulate an in-progress run.
    holder = TaskLock(lock_file, timeout=1.0)
    holder.acquire()
    try:
        runner = PipelineRunner(
            task_id="task_concurrent",
            base_dir=tmp_path / "tasks",
            fixture_dir=FIXTURE_DIR,
        )
        # Reduce total timeout so the test doesn't wait the full 300s.
        runner.total_timeout = 2.0
        # The lock acquisition should time out and the manifest be failed.
        manifest = asyncio.run(runner.run())
        assert manifest.task_state.value == "failed"
        assert manifest.validation.status == "invalid"
        assert manifest.validation.failed_count >= 1
    finally:
        holder.release()


def test_runner_lock_released_on_exception(tmp_path: Path) -> None:
    """If _run_inner raises, the task lock is still released."""
    lock_file = tmp_path / "tasks" / "task_lock_exc" / "state" / "task_running.lock"

    runner = PipelineRunner(
        task_id="task_lock_exc",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    async def raise_inner():
        msg = "simulated inner failure"
        raise ValueError(msg)

    runner._run_inner = raise_inner  # type: ignore[method-assign] # noqa: SLF001

    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "failed"
    assert lock_file.is_file(), "diagnostic lock file must remain stable"
    with TaskLock(lock_file, timeout=0.2):
        pass
