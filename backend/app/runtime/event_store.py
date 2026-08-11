"""Append-only storage for authoritative task event envelopes."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.domain.contracts import EventEnvelope


class CorruptEventLogError(ValueError):
    """Raised when corruption is found before the recoverable trailing record."""


class EventSequenceError(ValueError):
    """Raised when an appended event would introduce a sequence gap or duplicate."""


class CorruptJsonlError(ValueError):
    """Raised when a JSONL file contains a malformed non-trailing record."""


@dataclass(frozen=True)
class JsonlReadResult:
    records: list[tuple[int, dict[str, Any]]]
    valid_bytes: int
    malformed_tail: bool


@dataclass(frozen=True)
class JsonlTail:
    last_record: dict[str, Any] | None
    valid_bytes: int
    malformed_tail: bool
    needs_delimiter: bool


@dataclass(frozen=True)
class EventLogCheckpoint:
    signature: tuple[int, int, int] | None
    latest_sequence: int


_PATH_LOCKS: dict[Path, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


def path_lock(path: Path) -> threading.RLock:
    resolved = path.resolve()
    with _PATH_LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(resolved, threading.RLock())


def read_jsonl(path: Path) -> JsonlReadResult:
    """Read object records while treating only the final malformed line as torn."""

    if not path.exists():
        return JsonlReadResult(records=[], valid_bytes=0, malformed_tail=False)

    content = path.read_bytes()
    lines = content.splitlines(keepends=True)
    nonempty = [index for index, line in enumerate(lines) if line.strip()]
    last_nonempty = nonempty[-1] if nonempty else -1
    records: list[tuple[int, dict[str, Any]]] = []
    offset = 0
    valid_bytes = 0

    for index, line in enumerate(lines):
        line_number = index + 1
        stripped = line.strip()
        next_offset = offset + len(line)
        if not stripped:
            valid_bytes = next_offset
            offset = next_offset
            continue
        try:
            value = json.loads(stripped)
            if not isinstance(value, dict):
                raise TypeError("JSONL records must be objects")
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as error:
            terminated = line.endswith((b"\n", b"\r"))
            if index == last_nonempty and not terminated:
                return JsonlReadResult(
                    records=records,
                    valid_bytes=offset,
                    malformed_tail=True,
                )
            raise CorruptJsonlError(
                f"malformed JSONL record at line {line_number}"
            ) from error
        records.append((line_number, value))
        valid_bytes = next_offset
        offset = next_offset

    return JsonlReadResult(
        records=records,
        valid_bytes=valid_bytes,
        malformed_tail=False,
    )


def _line_before(stream: Any, end: int) -> tuple[int, bytes, bool] | None:
    if end <= 0:
        return None
    line_end = end
    stream.seek(line_end - 1)
    terminated = stream.read(1) == b"\n"
    if terminated:
        line_end -= 1

    chunks: list[bytes] = []
    scan_end = line_end
    while scan_end > 0:
        scan_start = max(0, scan_end - 8192)
        stream.seek(scan_start)
        chunk = stream.read(scan_end - scan_start)
        delimiter = chunk.rfind(b"\n")
        if delimiter >= 0:
            line_start = scan_start + delimiter + 1
            chunks.append(chunk[delimiter + 1 :])
            return line_start, b"".join(reversed(chunks)), terminated
        chunks.append(chunk)
        scan_end = scan_start
    return 0, b"".join(reversed(chunks)), terminated


def inspect_jsonl_tail(path: Path) -> JsonlTail:
    """Inspect only the final committed/torn records needed for an append."""

    if not path.exists():
        return JsonlTail(None, 0, False, False)
    file_size = path.stat().st_size
    if file_size == 0:
        return JsonlTail(None, 0, False, False)

    malformed_tail = False
    valid_bytes = file_size
    cursor = file_size
    with path.open("rb") as stream:
        stream.seek(file_size - 1)
        ends_with_newline = stream.read(1) == b"\n"
        while cursor > 0:
            previous = _line_before(stream, cursor)
            if previous is None:
                break
            line_start, line, terminated = previous
            cursor = line_start
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
                if not isinstance(value, dict):
                    raise TypeError("JSONL records must be objects")
            except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as error:
                if malformed_tail or terminated:
                    raise CorruptJsonlError(
                        "malformed JSONL record before trailing record"
                    ) from error
                malformed_tail = True
                valid_bytes = line_start
                continue
            return JsonlTail(
                last_record=value,
                valid_bytes=valid_bytes,
                malformed_tail=malformed_tail,
                needs_delimiter=(not malformed_tail and not ends_with_newline),
            )

    return JsonlTail(
        last_record=None,
        valid_bytes=valid_bytes,
        malformed_tail=malformed_tail,
        needs_delimiter=(not malformed_tail and not ends_with_newline),
    )


def append_jsonl_records(
    path: Path,
    values: list[dict[str, Any]],
    *,
    tail: JsonlTail | None = None,
) -> None:
    """Repair a torn final record, then durably append compact JSON lines."""

    if not values:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    inspected = tail or inspect_jsonl_tail(path)
    if inspected.malformed_tail:
        with path.open("r+b") as stream:
            stream.truncate(inspected.valid_bytes)
            stream.flush()
            os.fsync(stream.fileno())
    delimiter = b"\n" if inspected.needs_delimiter else b""
    encoded = delimiter + b"".join(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
        for value in values
    )
    with path.open("ab") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    """Append one JSONL object after repairing a torn final record."""

    append_jsonl_records(path, [value])


class EventStore:
    """Persist and replay task-local event streams."""

    def __init__(self, tasks_dir: str | Path) -> None:
        self.tasks_dir = Path(tasks_dir)
        self._checkpoints: dict[str, EventLogCheckpoint] = {}

    def path_for(self, task_id: str) -> Path:
        if not task_id or Path(task_id).name != task_id or task_id in {".", ".."}:
            raise ValueError("task_id must be a single path-safe component")
        return self.tasks_dir / task_id / "events.jsonl"

    def append(self, event: EventEnvelope) -> None:
        path = self.path_for(event.task_id)
        with path_lock(path):
            try:
                tail = inspect_jsonl_tail(path)
            except CorruptJsonlError as error:
                raise CorruptEventLogError(str(error)) from error
            signature = self._file_signature(path)
            checkpoint = self._checkpoints.get(event.task_id)
            requires_validation = (
                signature is not None
                and signature[0] > 0
                and (checkpoint is None or checkpoint.signature != signature)
            )
            if requires_validation:
                existing = self._read_path(path, event.task_id)
                latest = existing[-1] if existing else None
            else:
                latest = self._validate_event(tail.last_record, event.task_id)
            expected = latest.sequence + 1 if latest is not None else 1
            if event.sequence != expected:
                raise EventSequenceError(
                    f"expected {expected} for task {event.task_id}, got {event.sequence}"
                )
            append_jsonl_records(
                path,
                [event.model_dump(mode="json")],
                tail=tail,
            )
            self._remember_checkpoint(event.task_id, path, event.sequence)

    def read(
        self,
        task_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[EventEnvelope]:
        if after_sequence < 0:
            raise ValueError("after_sequence must be non-negative")
        if limit is not None and limit < 1:
            raise ValueError("limit must be positive")
        path = self.path_for(task_id)
        with path_lock(path):
            all_events = self._read_path(path, task_id)
            self._remember_checkpoint(
                task_id,
                path,
                all_events[-1].sequence if all_events else 0,
            )
            events = [event for event in all_events if event.sequence > after_sequence]
        return events if limit is None else events[:limit]

    def latest_sequence(self, task_id: str) -> int:
        path = self.path_for(task_id)
        with path_lock(path):
            signature = self._file_signature(path)
            checkpoint = self._checkpoints.get(task_id)
            if checkpoint is not None and checkpoint.signature == signature:
                return checkpoint.latest_sequence
            if signature is None or signature[0] == 0:
                self._remember_checkpoint(task_id, path, 0)
                return 0
            events = self._read_path(path, task_id)
            latest_sequence = events[-1].sequence if events else 0
            self._remember_checkpoint(task_id, path, latest_sequence)
            return latest_sequence

    @staticmethod
    def _file_signature(path: Path) -> tuple[int, int, int] | None:
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None
        return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns

    def _remember_checkpoint(
        self,
        task_id: str,
        path: Path,
        latest_sequence: int,
    ) -> None:
        self._checkpoints[task_id] = EventLogCheckpoint(
            signature=self._file_signature(path),
            latest_sequence=latest_sequence,
        )

    def forget(self, task_id: str) -> None:
        """Drop in-memory checkpoint state for a deleted task (C5d hygiene)."""

        self._checkpoints.pop(task_id, None)

    @staticmethod
    def _validate_event(
        value: dict[str, Any] | None,
        task_id: str,
        *,
        line_number: int | None = None,
    ) -> EventEnvelope | None:
        if value is None:
            return None
        location = f" at line {line_number}" if line_number is not None else ""
        try:
            event = EventEnvelope.model_validate(value)
        except ValidationError as error:
            raise CorruptEventLogError(f"invalid event envelope{location}") from error
        if event.task_id != task_id:
            raise CorruptEventLogError(
                f"event task_id mismatch{location}: expected {task_id}, got {event.task_id}"
            )
        return event

    @classmethod
    def _read_path(cls, path: Path, task_id: str) -> list[EventEnvelope]:
        try:
            result = read_jsonl(path)
        except CorruptJsonlError as error:
            raise CorruptEventLogError(str(error)) from error

        events: list[EventEnvelope] = []
        expected_sequence = 1
        for line_number, value in result.records:
            event = cls._validate_event(
                value,
                task_id,
                line_number=line_number,
            )
            if event is None:
                continue
            if event.sequence != expected_sequence:
                raise CorruptEventLogError(
                    "non-contiguous event sequence at line "
                    f"{line_number}: expected {expected_sequence}, got {event.sequence}"
                )
            events.append(event)
            expected_sequence += 1
        return events
