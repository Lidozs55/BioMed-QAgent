"""Rebuildable SQLite index for task history and request idempotency."""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, TypeVar

from app.config import Settings, settings as default_settings
from app.domain.contracts import (
    RunStatus,
    TaskPage,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
)
from app.runtime.event_store import CorruptEventLogError, EventStore
from app.runtime.state import reduce_task_event


DEFAULT_TASK_PAGE_LIMIT = default_settings.task_page_size
MAX_TASK_PAGE_LIMIT = default_settings.task_page_max_size

_ACTIVE_STATUSES = (
    RunStatus.QUEUED.value,
    RunStatus.RUNNING.value,
    RunStatus.FINALIZING.value,
    RunStatus.CANCEL_REQUESTED.value,
)

_T = TypeVar("_T")


class SingleThreadExecutor:
    """Async facade over one dedicated worker thread."""

    def __init__(self, name: str = "task-index") -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=name)
        self._closed = False

    async def run(self, function: Callable[..., _T], *args: Any) -> _T:
        if self._closed:
            raise RuntimeError("single-thread executor is closed")
        loop = asyncio.get_running_loop()
        call = functools.partial(function, *args)
        return await loop.run_in_executor(self._executor, call)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await asyncio.to_thread(self._executor.shutdown, True)


def _utc_text(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _encode_cursor(created_at: str, task_id: str) -> str:
    payload = json.dumps(
        {"v": 1, "created_at": created_at, "task_id": task_id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if (
            not isinstance(value, dict)
            or value.get("v") != 1
            or not isinstance(value.get("created_at"), str)
            or not isinstance(value.get("task_id"), str)
            or not value["task_id"]
        ):
            raise ValueError
        datetime.fromisoformat(value["created_at"])
        return value["created_at"], value["task_id"]
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("invalid task cursor") from error


class TaskIndex:
    """Serve task summaries from a disposable SQLite projection."""

    def __init__(
        self,
        tasks_dir: str | Path,
        *,
        executor: SingleThreadExecutor | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.tasks_dir = Path(tasks_dir)
        self.path = self.tasks_dir / "task_index.sqlite3"
        self.executor = executor or SingleThreadExecutor()
        self.settings = settings or default_settings
        self._owns_executor = executor is None
        self._connection: sqlite3.Connection | None = None
        self._thread_id: int | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._closing = False
        self._closed = False

    async def initialize(self) -> None:
        await self._run(self._initialize_sync)

    async def close(self) -> None:
        async with self._lifecycle_lock:
            if self._closed:
                return
            self._closing = True
            try:
                await self.executor.run(self._close_sync)
            finally:
                try:
                    if self._owns_executor:
                        await self.executor.close()
                finally:
                    self._closing = False
                    self._closed = True

    async def upsert_snapshot(self, snapshot: TaskSnapshot) -> None:
        await self._run(self._upsert_snapshot_sync, snapshot)

    async def record_request(self, accepted: TaskRunAccepted) -> TaskRunAccepted:
        return await self._run(self._record_request_sync, accepted)

    async def find_request(self, request_id: str) -> TaskRunAccepted | None:
        if not request_id:
            raise ValueError("request_id must not be blank")
        return await self._run(self._find_request_sync, request_id)

    async def list_tasks(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> TaskPage:
        page_limit = self.settings.task_page_size if limit is None else limit
        maximum = self.settings.task_page_max_size
        if page_limit < 1 or page_limit > maximum:
            raise ValueError(f"limit must be between 1 and {maximum}")
        boundary = _decode_cursor(cursor) if cursor else None
        return await self._run(self._list_tasks_sync, page_limit, boundary)

    async def rebuild(self) -> None:
        await self._run(self._rebuild_sync)

    async def _run(self, function: Callable[..., _T], *args: Any) -> _T:
        async with self._lifecycle_lock:
            if self._closing or self._closed:
                raise RuntimeError("task index is closed")
            return await self.executor.run(function, *args)

    def _initialize_sync(self) -> None:
        self.tasks_dir.mkdir(parents=True, exist_ok=True)
        connection = self._get_connection()
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS task_summaries (
                task_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                active_run_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                latest_sequence INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_task_summaries_history
                ON task_summaries(created_at DESC, task_id DESC);
            CREATE INDEX IF NOT EXISTS idx_task_summaries_status
                ON task_summaries(status);
            CREATE TABLE IF NOT EXISTS request_ids (
                request_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                run_id TEXT NOT NULL
            );
            """
        )
        connection.commit()

    def _get_connection(self) -> sqlite3.Connection:
        current_thread = threading.get_ident()
        if self._connection is None:
            self._connection = sqlite3.connect(self.path)
            self._connection.row_factory = sqlite3.Row
            self._thread_id = current_thread
        elif self._thread_id != current_thread:
            raise RuntimeError("SQLite index accessed outside its dedicated thread")
        return self._connection

    def _close_sync(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None
            self._thread_id = None

    def _upsert_snapshot_sync(self, snapshot: TaskSnapshot) -> None:
        connection = self._get_connection()
        with connection:
            self._write_snapshot(connection, snapshot)

    @staticmethod
    def _write_snapshot(
        connection: sqlite3.Connection,
        snapshot: TaskSnapshot,
        *,
        include_requests: bool = True,
    ) -> None:
        task = snapshot.task
        connection.execute(
            """
            INSERT INTO task_summaries (
                task_id, mode, title, status, active_run_id,
                created_at, updated_at, latest_sequence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
                mode = excluded.mode,
                title = excluded.title,
                status = excluded.status,
                active_run_id = excluded.active_run_id,
                updated_at = excluded.updated_at,
                latest_sequence = excluded.latest_sequence
            """,
            (
                task.task_id,
                task.mode.value,
                task.title,
                task.status.value,
                task.active_run_id,
                _utc_text(task.created_at),
                _utc_text(task.updated_at),
                task.latest_sequence,
            ),
        )
        if include_requests:
            connection.executemany(
                """
                INSERT OR IGNORE INTO request_ids (request_id, task_id, run_id)
                VALUES (?, ?, ?)
                """,
                [
                    (run.request_id, snapshot.task.task_id, run.run_id)
                    for run in snapshot.runs
                ],
            )

    def _record_request_sync(
        self,
        accepted: TaskRunAccepted,
    ) -> TaskRunAccepted:
        connection = self._get_connection()
        with connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO request_ids (request_id, task_id, run_id)
                VALUES (?, ?, ?)
                """,
                (accepted.request_id, accepted.task_id, accepted.run_id),
            )
        existing = self._find_request_sync(accepted.request_id)
        if existing is None:
            raise RuntimeError("request id was not persisted")
        return existing

    def _find_request_sync(self, request_id: str) -> TaskRunAccepted | None:
        row = (
            self._get_connection()
            .execute(
                """
            SELECT request_id, task_id, run_id
            FROM request_ids
            WHERE request_id = ?
            """,
                (request_id,),
            )
            .fetchone()
        )
        return TaskRunAccepted.model_validate(dict(row)) if row is not None else None

    def _list_tasks_sync(
        self,
        limit: int,
        boundary: tuple[str, str] | None,
    ) -> TaskPage:
        connection = self._get_connection()
        placeholders = ", ".join("?" for _ in _ACTIVE_STATUSES)
        active_rows = connection.execute(
            f"""
            SELECT * FROM task_summaries
            WHERE status IN ({placeholders})
            ORDER BY created_at DESC, task_id DESC
            """,
            _ACTIVE_STATUSES,
        ).fetchall()

        parameters: list[Any] = [*_ACTIVE_STATUSES]
        boundary_clause = ""
        if boundary is not None:
            created_at, task_id = boundary
            boundary_clause = "AND (created_at < ? OR (created_at = ? AND task_id < ?))"
            parameters.extend([created_at, created_at, task_id])
        parameters.append(limit + 1)
        inactive_rows = connection.execute(
            f"""
            SELECT * FROM task_summaries
            WHERE status NOT IN ({placeholders})
            {boundary_clause}
            ORDER BY created_at DESC, task_id DESC
            LIMIT ?
            """,
            parameters,
        ).fetchall()
        has_more = len(inactive_rows) > limit
        selected_inactive = inactive_rows[:limit]
        next_cursor = None
        if has_more and selected_inactive:
            last = selected_inactive[-1]
            next_cursor = _encode_cursor(last["created_at"], last["task_id"])
        selected_rows = [*active_rows, *selected_inactive]
        selected_rows.sort(
            key=lambda row: (row["created_at"], row["task_id"]),
            reverse=True,
        )
        tasks = [self._summary_from_row(row) for row in selected_rows]
        return TaskPage(tasks=tasks, next_cursor=next_cursor)

    @staticmethod
    def _summary_from_row(row: sqlite3.Row) -> TaskSummary:
        return TaskSummary(
            task_id=row["task_id"],
            mode=row["mode"],
            title=row["title"],
            status=row["status"],
            active_run_id=row["active_run_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            latest_sequence=row["latest_sequence"],
        )

    def _rebuild_sync(self) -> None:
        snapshots: list[TaskSnapshot] = []
        authoritative_requests: dict[str, tuple[str, str]] = {}
        event_store = EventStore(self.tasks_dir)
        if self.tasks_dir.exists():
            for task_dir in sorted(self.tasks_dir.iterdir()):
                if not task_dir.is_dir():
                    continue
                snapshot_path = task_dir / "state" / "task_snapshot.json"
                if not snapshot_path.is_file():
                    continue
                snapshot = TaskSnapshot.model_validate_json(
                    snapshot_path.read_text("utf-8")
                )
                if task_dir.name != snapshot.task.task_id:
                    raise ValueError(
                        "task directory name does not match snapshot task_id: "
                        f"{task_dir.name} != {snapshot.task.task_id}"
                    )
                events = event_store.read(
                    snapshot.task.task_id,
                    after_sequence=snapshot.task.latest_sequence,
                )
                journal_latest = event_store.latest_sequence(snapshot.task.task_id)
                if snapshot.task.latest_sequence > journal_latest:
                    raise CorruptEventLogError(
                        "snapshot latest_sequence exceeds journal latest_sequence "
                        f"for task {snapshot.task.task_id}: "
                        f"{snapshot.task.latest_sequence} > {journal_latest}"
                    )
                for event in events:
                    snapshot = reduce_task_event(snapshot, event)
                snapshots.append(snapshot)
                for run in snapshot.runs:
                    mapping = (snapshot.task.task_id, run.run_id)
                    existing = authoritative_requests.get(run.request_id)
                    if existing is not None and existing != mapping:
                        raise ValueError(
                            "conflicting authoritative request_id mapping: "
                            f"{run.request_id}"
                        )
                    authoritative_requests[run.request_id] = mapping

        connection = self._get_connection()
        with connection:
            connection.execute("DELETE FROM task_summaries")
            connection.execute("DELETE FROM request_ids")
            for snapshot in snapshots:
                self._write_snapshot(
                    connection,
                    snapshot,
                    include_requests=False,
                )
            connection.executemany(
                """
                INSERT INTO request_ids (request_id, task_id, run_id)
                VALUES (?, ?, ?)
                """,
                [
                    (request_id, task_id, run_id)
                    for request_id, (task_id, run_id) in authoritative_requests.items()
                ],
            )
