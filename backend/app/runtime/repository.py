"""Repository coordinating authoritative files and the rebuildable task index."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.config import Settings, settings as default_settings
from app.domain.contracts import (
    EventEnvelope,
    MessagePage,
    TaskPage,
    TaskRunAccepted,
    TaskSnapshot,
)
from app.runtime.event_store import CorruptEventLogError, EventStore
from app.runtime.index import TaskIndex
from app.runtime.session import DurableTaskSession
from app.runtime.state import reduce_task_event


class TaskNotFoundError(LookupError):
    """Raised when a task-local repository operation targets no snapshot."""


def atomic_write_text(path: Path, content: str) -> None:
    """Publish a complete file with a same-directory atomic replace."""

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
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


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


class TaskRepository:
    """Provide durable task/session operations over one output directory."""

    def __init__(
        self,
        output_dir: str | Path,
        *,
        index: TaskIndex | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.tasks_dir = self.output_dir / "tasks"
        self.events = EventStore(self.tasks_dir)
        self.settings = settings or (
            index.settings if index is not None else default_settings
        )
        self.index = index or TaskIndex(self.tasks_dir, settings=self.settings)
        self._task_locks: dict[str, asyncio.Lock] = {}

    async def initialize(self) -> None:
        await self.index.initialize()
        await self.index.rebuild()

    async def close(self) -> None:
        await self.index.close()

    async def save_snapshot(self, snapshot: TaskSnapshot) -> None:
        lock = self._task_locks.setdefault(snapshot.task.task_id, asyncio.Lock())
        async with lock:
            persisted = self._snapshot_without_messages(snapshot)
            await asyncio.to_thread(self._save_snapshot_sync, persisted)
            await self.index.upsert_snapshot(persisted)

    async def get_snapshot(self, task_id: str) -> TaskSnapshot | None:
        lock = self._task_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            snapshot = await asyncio.to_thread(self._load_snapshot_sync, task_id)
            if snapshot is None:
                return None
            await self.index.upsert_snapshot(snapshot)
        messages = await self.task_session(task_id).get_message_page()
        return snapshot.model_copy(
            update={
                "messages": messages.messages,
                "older_messages_cursor": messages.next_cursor,
            }
        )

    async def append_event(self, event: EventEnvelope) -> TaskSnapshot:
        lock = self._task_locks.setdefault(event.task_id, asyncio.Lock())
        async with lock:

            async def append_and_index() -> TaskSnapshot:
                snapshot = await asyncio.to_thread(self._append_event_sync, event)
                await self.index.upsert_snapshot(snapshot)
                return snapshot

            append_task = asyncio.create_task(append_and_index())
            try:
                return await asyncio.shield(append_task)
            except asyncio.CancelledError:
                while not append_task.done():
                    try:
                        await asyncio.shield(append_task)
                    except asyncio.CancelledError:
                        continue
                    except BaseException:
                        break
                if not append_task.cancelled():
                    append_task.exception()
                raise

    async def list_events(
        self,
        task_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[EventEnvelope]:
        return await asyncio.to_thread(
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
        return await self.index.list_tasks(limit=limit, cursor=cursor)

    async def list_messages(
        self,
        task_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> MessagePage:
        if await asyncio.to_thread(self._load_snapshot_sync, task_id) is None:
            raise TaskNotFoundError(task_id)
        return await self.task_session(task_id).get_message_page(
            limit=limit,
            cursor=cursor,
        )

    def task_session(self, task_id: str) -> DurableTaskSession:
        return DurableTaskSession(
            task_id,
            self.tasks_dir,
            message_page_size=self.settings.task_message_page_size,
        )

    async def record_request(
        self,
        accepted: TaskRunAccepted,
    ) -> TaskRunAccepted:
        lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
        async with lock:
            snapshot = await asyncio.to_thread(
                self._load_snapshot_sync,
                accepted.task_id,
            )
            if snapshot is None:
                raise TaskNotFoundError(accepted.task_id)
            authoritative = any(
                run.task_id == accepted.task_id
                and run.run_id == accepted.run_id
                and run.request_id == accepted.request_id
                for run in snapshot.runs
            )
            if not authoritative:
                raise ValueError(
                    "request registration must match an authoritative task run"
                )
            registered = await self.index.record_request(accepted)
            if registered != accepted:
                raise ValueError("request_id conflicts with authoritative task run")
            return registered

    async def find_request(self, request_id: str) -> TaskRunAccepted | None:
        return await self.index.find_request(request_id)

    async def save_conversation_summary(
        self,
        task_id: str,
        summary: Mapping[str, Any],
    ) -> None:
        lock = self._task_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            if await asyncio.to_thread(self._load_snapshot_sync, task_id) is None:
                raise TaskNotFoundError(task_id)
            path = self._state_dir(task_id) / "conversation_summary.json"
            await asyncio.to_thread(atomic_write_json, path, summary)

    async def load_conversation_summary(self, task_id: str) -> dict[str, Any]:
        if await asyncio.to_thread(self._load_snapshot_sync, task_id) is None:
            raise TaskNotFoundError(task_id)
        path = self._state_dir(task_id) / "conversation_summary.json"
        return await asyncio.to_thread(self._read_json_object, path)

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
            snapshot,
        )

    def _load_snapshot_sync(self, task_id: str) -> TaskSnapshot | None:
        snapshot_path = self._snapshot_path(task_id)
        if not snapshot_path.is_file():
            return None
        snapshot = TaskSnapshot.model_validate_json(snapshot_path.read_text("utf-8"))
        latest_sequence = self.events.latest_sequence(task_id)
        if snapshot.task.latest_sequence > latest_sequence:
            raise CorruptEventLogError(
                "snapshot latest_sequence exceeds journal latest_sequence "
                f"for task {task_id}: "
                f"{snapshot.task.latest_sequence} > {latest_sequence}"
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
            atomic_write_json(snapshot_path, snapshot)
        return snapshot

    def _append_event_sync(self, event: EventEnvelope) -> TaskSnapshot:
        current = self._load_snapshot_sync(event.task_id)
        if current is None:
            raise TaskNotFoundError(event.task_id)
        updated = reduce_task_event(current, event)
        self.events.append(event)
        persisted = self._snapshot_without_messages(updated)
        atomic_write_json(self._snapshot_path(event.task_id), persisted)
        return persisted

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
