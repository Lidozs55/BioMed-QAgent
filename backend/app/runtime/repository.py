"""Repository coordinating authoritative files and the rebuildable task index."""

from __future__ import annotations

import asyncio
import functools
import json
import os
import shutil
import sqlite3
import tempfile
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from concurrent.futures import Executor
from contextlib import ExitStack, asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from app.config import Settings
from app.config import settings as default_settings
from app.domain.contracts import (
    EventEnvelope,
    MessagePage,
    TaskPage,
    TaskRunAccepted,
    TaskSnapshot,
    build_event,
)
from app.domain.contracts.events import EventPayload
from app.runtime.event_store import CorruptEventLogError, EventStore, path_lock
from app.runtime.index import TaskIndex
from app.runtime.session import DurableTaskSession
from app.runtime.state import (
    artifact_identities_from_events,
    count_artifact_produced_events,
    reduce_task_event,
)

_ResultT = TypeVar("_ResultT")
_TRANSIENT_INDEX_ERRORS = (OSError, sqlite3.Error)


class TaskNotFoundError(LookupError):
    """Raised when a task-local repository operation targets no snapshot."""


def atomic_write_text(path: Path, content: str) -> None:
    """Publish a complete file with a same-directory atomic replace.

    On Windows, ``os.replace`` can raise ``PermissionError`` ([WinError 5]) if
    the target file is briefly locked by another process (antivirus, search
    indexer, or a concurrent reader). We retry a few times with short backoff
    before surfacing the error, since the lock is almost always transient.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        _replace_with_retry(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _replace_with_retry(
    src: Path,
    dst: Path,
    *,
    attempts: int = 5,
    delay_seconds: float = 0.05,
) -> None:
    """``os.replace`` with bounded retry on transient PermissionError."""
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError as exc:
            last_exc = exc
            if attempt < attempts - 1:
                time.sleep(delay_seconds * (2 ** attempt))
        except OSError:
            raise
    assert last_exc is not None
    raise last_exc


def atomic_write_json(path: Path, value: BaseModel | Mapping[str, Any]) -> None:
    if isinstance(value, BaseModel):
        content = value.model_dump_json(indent=2) + "\n"
    else:
        content = (
            json.dumps(
                dict(value),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
    atomic_write_text(path, content)


def _snapshot_with_internal(snapshot: TaskSnapshot) -> dict[str, Any]:
    """Serialize a snapshot including its private artifact dedup bookkeeping.

    A8/H6 (Phase 4 review): the seen-artifact identity set and the
    first-occurrence fingerprints live in private attributes (never part of
    the wire contract); they are persisted under private JSON keys so dedup
    and conflicting-duplicate detection survive repository round-trips and
    restarts. ``_load_snapshot_sync`` restores them before reducing events.
    """

    raw = snapshot.model_dump(mode="json")
    raw["_artifact_ids_by_run"] = {
        run_id: sorted(ids) for run_id, ids in snapshot._artifact_ids_by_run.items()
    }
    raw["_artifact_fingerprints_by_run"] = {
        run_id: {
            artifact_id: {"sha256": sha256, "relative_path": relative_path}
            for artifact_id, (sha256, relative_path) in fingerprints.items()
        }
        for run_id, fingerprints in snapshot._artifact_fingerprints_by_run.items()
    }
    return raw


class TaskRepository:
    """Provide durable task/session operations over one output directory."""

    def __init__(
        self,
        output_dir: str | Path,
        *,
        index: TaskIndex | None = None,
        settings: Settings | None = None,
        storage_executor: Executor | None = None,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.tasks_dir = self.output_dir / "tasks"
        self.events = EventStore(self.tasks_dir)
        self.settings = settings or (
            index.settings if index is not None else default_settings
        )
        self.index = index or TaskIndex(self.tasks_dir, settings=self.settings)
        self._storage_executor = storage_executor
        self._task_locks: dict[str, asyncio.Lock] = {}
        self._close_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._active_operations = 0
        self._operations_drained = asyncio.Event()
        self._operations_drained.set()
        self._closing = False
        self._closed = False
        self._index_gate = asyncio.Lock()
        self._index_dirty = False

    async def initialize(self) -> None:
        async with self._operation(), self._index_gate:
            await self.index.initialize()
            await self.index.rebuild()
            self._index_dirty = False

    async def close(self) -> None:
        async with self._close_lock:
            async with self._lifecycle_lock:
                if self._closed:
                    return
                self._closing = True
            try:
                await self._shield_and_drain(self._close_index_when_drained())
            finally:
                async with self._lifecycle_lock:
                    self._closed = True

    @asynccontextmanager
    async def _operation(self) -> AsyncIterator[None]:
        async with self._lifecycle_lock:
            if self._closing or self._closed:
                raise RuntimeError("task repository is closed")
            self._active_operations += 1
            self._operations_drained.clear()
        try:
            yield
        finally:
            async with self._lifecycle_lock:
                self._active_operations -= 1
                if self._active_operations == 0:
                    self._operations_drained.set()

    async def _close_index_when_drained(self) -> None:
        await self._operations_drained.wait()
        await self.index.close()

    async def _shield_and_drain(
        self,
        operation: Awaitable[_ResultT],
    ) -> _ResultT:
        operation_task = asyncio.create_task(operation)
        try:
            return await asyncio.shield(operation_task)
        except asyncio.CancelledError:
            while not operation_task.done():
                try:
                    await asyncio.shield(operation_task)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if not operation_task.cancelled():
                operation_task.exception()
            raise

    async def _run_storage(
        self,
        function: Callable[..., _ResultT],
        *args: Any,
        **kwargs: Any,
    ) -> _ResultT:
        if self._storage_executor is None:
            return await asyncio.to_thread(function, *args, **kwargs)
        call = functools.partial(function, *args, **kwargs)
        return await asyncio.get_running_loop().run_in_executor(
            self._storage_executor,
            call,
        )

    async def save_snapshot(self, snapshot: TaskSnapshot) -> None:
        async with self._operation():
            lock = self._task_locks.setdefault(snapshot.task.task_id, asyncio.Lock())
            async with lock:
                persisted = self._snapshot_without_messages(snapshot)

                async def save_and_project() -> None:
                    async with self._index_gate:
                        await self._run_storage(self._save_snapshot_sync, persisted)
                        await self._project_snapshot_locked(persisted)

                await self._shield_and_drain(save_and_project())

    async def get_snapshot(self, task_id: str) -> TaskSnapshot | None:
        async with self._operation():
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:

                async def load_and_project() -> TaskSnapshot | None:
                    async with self._index_gate:
                        snapshot = await self._run_storage(
                            self._load_snapshot_sync,
                            task_id,
                        )
                        if snapshot is None:
                            return None
                        await self._project_snapshot_locked(snapshot)
                        return snapshot

                snapshot = await self._shield_and_drain(load_and_project())
                if snapshot is None:
                    return None
            messages = await self.task_session(task_id).get_message_page()
            return snapshot.model_copy(
                update={
                    "messages": messages.messages,
                    "older_messages_cursor": messages.next_cursor,
                }
            )

    async def append_event(self, event: EventEnvelope) -> TaskSnapshot:
        async with self._operation():
            lock = self._task_locks.setdefault(event.task_id, asyncio.Lock())
            async with lock:

                async def append_and_index() -> TaskSnapshot:
                    async with self._index_gate:
                        snapshot = await self._run_storage(
                            self._append_event_sync, event
                        )
                        await self._project_snapshot_locked(snapshot)
                        return snapshot

                return await self._shield_and_drain(append_and_index())

    async def append_event_payload(
        self,
        *,
        task_id: str,
        run_id: str,
        payload: EventPayload,
        stage_attempt_id: str | None = None,
        subagent_id: str | None = None,
        parent_tool_call_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> tuple[TaskSnapshot, EventEnvelope]:
        """Allocate a Task-local sequence and append one event atomically."""

        async with self._operation():
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:

                async def build_append_and_index() -> tuple[
                    TaskSnapshot,
                    EventEnvelope,
                ]:
                    async with self._index_gate:
                        snapshot, event = await self._run_storage(
                            self._append_event_payload_sync,
                            task_id,
                            run_id,
                            payload,
                            stage_attempt_id,
                            subagent_id,
                            parent_tool_call_id,
                            timestamp,
                        )
                        await self._project_snapshot_locked(snapshot)
                        return snapshot, event

                return await self._shield_and_drain(build_append_and_index())

    async def find_matching_event(
        self,
        *,
        task_id: str,
        run_id: str,
        payload: EventPayload,
        after_sequence: int = 0,
        stage_attempt_id: str | None = None,
        subagent_id: str | None = None,
        parent_tool_call_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> EventEnvelope | None:
        events = await self.list_events(
            task_id,
            after_sequence=after_sequence,
        )
        return next(
            (
                event
                for event in reversed(events)
                if event.run_id == run_id
                and event.payload == payload
                and event.stage_attempt_id == stage_attempt_id
                and event.subagent_id == subagent_id
                and event.parent_tool_call_id == parent_tool_call_id
                and (timestamp is None or event.timestamp == timestamp)
            ),
            None,
        )

    async def list_events(
        self,
        task_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[EventEnvelope]:
        return await self._run_storage(
            self.events.read,
            task_id,
            after_sequence=after_sequence,
            limit=limit,
        )

    async def list_tasks(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> TaskPage:
        async with self._operation(), self._index_gate:
            await self._ensure_index_current_locked()
            return await self.index.list_tasks(limit=limit, cursor=cursor)

    async def list_messages(
        self,
        task_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> MessagePage:
        async with self._operation():
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:

                async def load_and_project() -> TaskSnapshot | None:
                    async with self._index_gate:
                        snapshot = await self._run_storage(
                            self._load_snapshot_sync,
                            task_id,
                        )
                        if snapshot is not None:
                            await self._project_snapshot_locked(snapshot)
                        return snapshot

                snapshot = await self._shield_and_drain(load_and_project())
                if snapshot is None:
                    raise TaskNotFoundError(task_id)
            return await self.task_session(task_id).get_message_page(
                limit=limit,
                cursor=cursor,
            )

    def task_session(
        self,
        task_id: str,
        *,
        run_id: str | None = None,
    ) -> DurableTaskSession:
        return DurableTaskSession(
            task_id,
            self.tasks_dir,
            run_id=run_id,
            message_page_size=self.settings.task_message_page_size,
            storage_executor=self._storage_executor,
        )

    async def record_request(
        self,
        accepted: TaskRunAccepted,
    ) -> TaskRunAccepted:
        async with self._operation():
            lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
            async with lock:

                async def validate_and_record() -> TaskRunAccepted:
                    async with self._index_gate:
                        snapshot = await self._run_storage(
                            self._load_snapshot_sync,
                            accepted.task_id,
                        )
                        if snapshot is None:
                            raise TaskNotFoundError(accepted.task_id)
                        authoritative = any(
                            run.task_id == accepted.task_id
                            and run.run_id == accepted.run_id
                            and run.request_id == accepted.request_id
                            and run.request_fingerprint
                            == accepted.request_fingerprint
                            for run in snapshot.runs
                        )
                        if not authoritative:
                            raise ValueError(
                                "request registration must match an authoritative "
                                "task run"
                            )
                        return await self._project_request_locked(accepted)

                return await self._shield_and_drain(validate_and_record())

    async def find_request(self, request_id: str) -> TaskRunAccepted | None:
        async with self._operation(), self._index_gate:
            await self._ensure_index_current_locked()
            return await self.index.find_request(request_id)

    async def _ensure_index_current_locked(self) -> None:
        if not self._index_dirty:
            return
        await self.index.rebuild()
        self._index_dirty = False

    async def _project_snapshot_locked(self, snapshot: TaskSnapshot) -> None:
        try:
            await self.index.upsert_snapshot(snapshot)
        except _TRANSIENT_INDEX_ERRORS:
            self._index_dirty = True
            try:
                await self.index.rebuild()
            except ValueError:
                raise
            except _TRANSIENT_INDEX_ERRORS:
                return
            self._index_dirty = False

    async def _project_request_locked(
        self,
        accepted: TaskRunAccepted,
    ) -> TaskRunAccepted:
        try:
            registered = await self.index.record_request(accepted)
        except _TRANSIENT_INDEX_ERRORS:
            self._index_dirty = True
            try:
                await self.index.rebuild()
            except ValueError:
                raise
            except _TRANSIENT_INDEX_ERRORS:
                return accepted
            self._index_dirty = False
            return accepted
        if registered != accepted:
            self._index_dirty = True
            raise ValueError("request_id conflicts with authoritative task run")
        return registered

    async def delete_task(self, task_id: str) -> None:
        async with self._operation():
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:

                async def delete_tree_and_index() -> None:
                    async with self._index_gate:
                        await self._run_storage(self._delete_task_tree_sync, task_id)
                        try:
                            await self.index.delete_task(task_id)
                        except Exception as error:
                            self._index_dirty = True
                            try:
                                await self.index.rebuild()
                            except Exception as rebuild_error:
                                error.add_note(
                                    "task index rebuild also failed: "
                                    f"{type(rebuild_error).__name__}: "
                                    f"{rebuild_error}"
                                )
                            else:
                                self._index_dirty = False
                            raise

                await self._shield_and_drain(delete_tree_and_index())
                # C5d: the task is gone — drop the strong-key entries so a
                # long-lived runtime does not accumulate one lock/checkpoint
                # per deleted task.  Delete runs under the task lock and the
                # caller (TaskManager) only admits terminal tasks, so no
                # concurrent operation can still be using this task's lock.
                self._task_locks.pop(task_id, None)
                self.events.forget(task_id)

    async def save_conversation_summary(
        self,
        task_id: str,
        summary: Mapping[str, Any],
    ) -> None:
        async with self._operation():
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:

                async def load_and_project() -> TaskSnapshot | None:
                    async with self._index_gate:
                        snapshot = await self._run_storage(
                            self._load_snapshot_sync,
                            task_id,
                        )
                        if snapshot is not None:
                            await self._project_snapshot_locked(snapshot)
                        return snapshot

                snapshot = await self._shield_and_drain(load_and_project())
                if snapshot is None:
                    raise TaskNotFoundError(task_id)
                path = self._state_dir(task_id) / "conversation_summary.json"
                await self._shield_and_drain(
                    self._run_storage(atomic_write_json, path, summary)
                )

    async def load_conversation_summary(self, task_id: str) -> dict[str, Any]:
        async with self._operation():
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:

                async def load_and_project() -> TaskSnapshot | None:
                    async with self._index_gate:
                        snapshot = await self._run_storage(
                            self._load_snapshot_sync,
                            task_id,
                        )
                        if snapshot is not None:
                            await self._project_snapshot_locked(snapshot)
                        return snapshot

                snapshot = await self._shield_and_drain(load_and_project())
                if snapshot is None:
                    raise TaskNotFoundError(task_id)
            path = self._state_dir(task_id) / "conversation_summary.json"
            return await self._run_storage(self._read_json_object, path)

    def _task_dir(self, task_id: str) -> Path:
        return self.events.path_for(task_id).parent

    def _state_dir(self, task_id: str) -> Path:
        return self._task_dir(task_id) / "state"

    def _snapshot_path(self, task_id: str) -> Path:
        return self._state_dir(task_id) / "task_snapshot.json"

    def _ensure_layout(self, task_id: str) -> None:
        task_dir = self._task_dir(task_id)
        state_dir = task_dir / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "events.jsonl").touch(exist_ok=True)
        (state_dir / "session_items.jsonl").touch(exist_ok=True)
        summary_path = state_dir / "conversation_summary.json"
        if not summary_path.exists():
            atomic_write_json(summary_path, {})

    def _save_snapshot_sync(self, snapshot: TaskSnapshot) -> None:
        self._ensure_layout(snapshot.task.task_id)
        atomic_write_json(
            self._snapshot_path(snapshot.task.task_id),
            _snapshot_with_internal(snapshot),
        )

    def _load_snapshot_sync(self, task_id: str) -> TaskSnapshot | None:
        snapshot_path = self._snapshot_path(task_id)
        if not snapshot_path.is_file():
            return None
        raw_snapshot = json.loads(snapshot_path.read_text("utf-8"))
        # Snapshots persisted before the no_artifact_failure field was removed
        # still carry it; strict ContractModel (extra="forbid") would reject it.
        raw_snapshot.get("task", {}).pop("no_artifact_failure", None)
        # A8/H6: restore the private artifact dedup bookkeeping (stored under
        # private JSON keys that are never part of the wire contract); when a
        # key is missing (pre-fix snapshot) the state is rebuilt from the
        # artifact_produced events below.
        internal_artifact_ids = raw_snapshot.pop("_artifact_ids_by_run", None)
        internal_fingerprints = raw_snapshot.pop(
            "_artifact_fingerprints_by_run", None
        )
        snapshot = TaskSnapshot.model_validate(raw_snapshot)
        if internal_artifact_ids:
            snapshot._artifact_ids_by_run = {  # noqa: SLF001
                run_id: set(ids) for run_id, ids in internal_artifact_ids.items()
            }
        if internal_fingerprints:
            snapshot._artifact_fingerprints_by_run = {  # noqa: SLF001
                run_id: {
                    artifact_id: (
                        fingerprint["sha256"],
                        fingerprint["relative_path"],
                    )
                    for artifact_id, fingerprint in fingerprints.items()
                }
                for run_id, fingerprints in internal_fingerprints.items()
            }
        latest_sequence = self.events.latest_sequence(task_id)
        if snapshot.task.latest_sequence > latest_sequence:
            raise CorruptEventLogError(
                "snapshot latest_sequence exceeds journal latest_sequence "
                f"for task {task_id}: "
                f"{snapshot.task.latest_sequence} > {latest_sequence}"
            )
        legacy = "artifact_count" not in raw_snapshot.get("task", {})
        # H6: a snapshot whose dedup bookkeeping is missing (e.g. a pre-fix
        # snapshot that already carries artifact_count) must have its identity
        # set reconstructed from the events so replaying an old duplicate
        # after upgrade cannot over-count.
        dedup_state_missing = (
            internal_artifact_ids is None or internal_fingerprints is None
        )
        legacy_artifact_count = 0
        historical_events: list[EventEnvelope] = []
        if legacy or dedup_state_missing:
            historical_events = self.events.read(task_id, after_sequence=0)
        if legacy:
            legacy_artifact_count = count_artifact_produced_events(
                historical_events,
                through_sequence=snapshot.task.latest_sequence,
            )
            if legacy_artifact_count > 0:
                snapshot = snapshot.model_copy(
                    update={
                        "task": snapshot.task.model_copy(
                            update={"artifact_count": legacy_artifact_count}
                        )
                    }
                )
        if dedup_state_missing:
            rebuilt_ids, rebuilt_fingerprints = artifact_identities_from_events(
                historical_events,
                through_sequence=snapshot.task.latest_sequence,
            )
            if internal_artifact_ids is None:
                snapshot._artifact_ids_by_run = rebuilt_ids  # noqa: SLF001
            if internal_fingerprints is None:
                snapshot._artifact_fingerprints_by_run = (  # noqa: SLF001
                    rebuilt_fingerprints
                )
        events = (
            self.events.read(
                task_id,
                after_sequence=snapshot.task.latest_sequence,
            )
            if latest_sequence > snapshot.task.latest_sequence
            else []
        )
        if events:
            for event in events:
                snapshot = reduce_task_event(snapshot, event)
            snapshot = self._snapshot_without_messages(snapshot)
            atomic_write_json(snapshot_path, _snapshot_with_internal(snapshot))
        elif (legacy and legacy_artifact_count > 0) or dedup_state_missing:
            atomic_write_json(
                snapshot_path,
                _snapshot_with_internal(self._snapshot_without_messages(snapshot)),
            )
        return snapshot

    def _append_event_sync(self, event: EventEnvelope) -> TaskSnapshot:
        current = self._load_snapshot_sync(event.task_id)
        if current is None:
            raise TaskNotFoundError(event.task_id)
        updated = reduce_task_event(current, event)
        self.events.append(event)
        persisted = self._snapshot_without_messages(updated)
        atomic_write_json(
            self._snapshot_path(event.task_id),
            _snapshot_with_internal(persisted),
        )
        return persisted

    def _append_event_payload_sync(
        self,
        task_id: str,
        run_id: str,
        payload: EventPayload,
        stage_attempt_id: str | None,
        subagent_id: str | None,
        parent_tool_call_id: str | None,
        timestamp: datetime | None,
    ) -> tuple[TaskSnapshot, EventEnvelope]:
        current = self._load_snapshot_sync(task_id)
        if current is None:
            raise TaskNotFoundError(task_id)
        event = build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=current.task.latest_sequence + 1,
            payload=payload,
            stage_attempt_id=stage_attempt_id,
            subagent_id=subagent_id,
            parent_tool_call_id=parent_tool_call_id,
            timestamp=timestamp,
        )
        updated = reduce_task_event(current, event)
        self.events.append(event)
        persisted = self._snapshot_without_messages(updated)
        atomic_write_json(
            self._snapshot_path(task_id),
            _snapshot_with_internal(persisted),
        )
        return persisted, event

    def _delete_task_tree_sync(self, task_id: str) -> None:
        task_dir = self._validated_task_dir(task_id)
        lock_paths = sorted(
            (
                task_dir / "events.jsonl",
                task_dir / "state" / "session_items.jsonl",
            ),
            key=lambda path: str(path.resolve()).casefold(),
        )
        with ExitStack() as locks:
            for lock_path in lock_paths:
                locks.enter_context(path_lock(lock_path))
            task_dir = self._validated_task_dir(task_id)
            shutil.rmtree(task_dir)

    def _validated_task_dir(self, task_id: str) -> Path:
        if not task_id or task_id in {".", ".."} or Path(task_id).name != task_id:
            raise TaskNotFoundError(task_id)
        tasks_root = self.tasks_dir.resolve()
        candidate = tasks_root / task_id
        if candidate == tasks_root or candidate.parent != tasks_root:
            raise TaskNotFoundError(task_id)
        if candidate.is_symlink() or candidate.is_junction():
            raise TaskNotFoundError(task_id)
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, RuntimeError) as error:
            raise TaskNotFoundError(task_id) from error
        if (
            resolved == tasks_root
            or resolved.parent != tasks_root
            or resolved != candidate
            or not resolved.is_dir()
        ):
            raise TaskNotFoundError(task_id)
        return resolved

    @staticmethod
    def _snapshot_without_messages(snapshot: TaskSnapshot) -> TaskSnapshot:
        return snapshot.model_copy(
            update={"messages": [], "older_messages_cursor": None}
        )

    @staticmethod
    def _read_json_object(path: Path) -> dict[str, Any]:
        value = json.loads(path.read_text("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("conversation summary must be a JSON object")
        return value
