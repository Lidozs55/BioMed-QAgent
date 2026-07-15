"""Durable per-task implementation of the OpenAI Agents Session protocol."""

from __future__ import annotations

import asyncio
import base64
import copy
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agents.items import TResponseInputItem
from agents.memory.session_settings import SessionSettings
from pydantic import ValidationError

from app.config import settings as default_settings
from app.domain.contracts import (
    MessagePage,
    MessageRecord,
    MessageRole,
    generate_message_id,
)
from app.runtime.event_store import (
    CorruptJsonlError,
    append_jsonl_records,
    path_lock,
    read_jsonl,
)


MESSAGE_PAGE_LIMIT = default_settings.task_message_page_size


class SessionCorruptionError(ValueError):
    """Raised when a durable session contains an invalid committed record."""


@dataclass
class _ReplayCache:
    signature: tuple[int, int] | None
    active: list[dict[str, Any]]
    highest_ordinal: int


def _encode_cursor(task_id: str, before_ordinal: int) -> str:
    payload = json.dumps(
        {"v": 1, "task_id": task_id, "before": before_ordinal},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(task_id: str, cursor: str) -> int:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if (
            not isinstance(value, dict)
            or value.get("v") != 1
            or value.get("task_id") != task_id
            or not isinstance(value.get("before"), int)
            or value["before"] < 1
        ):
            raise ValueError
        return value["before"]
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("invalid message cursor") from error


def _json_item(item: TResponseInputItem) -> dict[str, Any]:
    try:
        value = json.loads(json.dumps(item, ensure_ascii=False))
    except (TypeError, ValueError) as error:
        raise TypeError("session items must be JSON-serializable objects") from error
    if not isinstance(value, dict):
        raise TypeError("session items must be JSON objects")
    return value


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
        if parts:
            return "\n".join(parts)
    return json.dumps(content, ensure_ascii=False, separators=(",", ":"))


def _project_message(
    *,
    task_id: str,
    ordinal: int,
    item: dict[str, Any],
) -> MessageRecord | None:
    role_value = item.get("role")
    if role_value not in {role.value for role in MessageRole}:
        return None
    return MessageRecord(
        message_id=generate_message_id(),
        task_id=task_id,
        ordinal=ordinal,
        role=MessageRole(role_value),
        content=_content_text(item.get("content", "")),
        created_at=datetime.now(timezone.utc),
    )


class DurableTaskSession:
    """Store raw SDK items in a recoverable append-only task-local JSONL log."""

    session_settings: SessionSettings | None = None

    def __init__(
        self,
        session_id: str,
        tasks_dir: str | Path,
        *,
        session_settings: SessionSettings | None = None,
        message_page_size: int = MESSAGE_PAGE_LIMIT,
    ) -> None:
        if (
            not session_id
            or session_id in {".", ".."}
            or Path(session_id).name != session_id
        ):
            raise ValueError("session_id must be a single path-safe component")
        if message_page_size < 1:
            raise ValueError("message_page_size must be positive")
        self.session_id = session_id
        self.session_settings = session_settings
        self.message_page_size = message_page_size
        self.path = Path(tasks_dir) / session_id / "state" / "session_items.jsonl"
        self._replay_cache: _ReplayCache | None = None

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        if limit is not None and limit < 0:
            raise ValueError("limit must be non-negative")
        active, _ = await asyncio.to_thread(self._replay)
        selected = active if limit is None else active[-limit:] if limit else []
        return [copy.deepcopy(record["item"]) for record in selected]

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        if not items:
            return
        normalized = [_json_item(item) for item in items]
        await asyncio.to_thread(self._add_items, normalized)

    async def add_run_input_once(self, run_id: str, input_value: str) -> bool:
        """Project one manager-owned Run input into history exactly once."""

        if not run_id or run_id in {".", ".."} or Path(run_id).name != run_id:
            raise ValueError("run_id must be a single path-safe component")
        item = _json_item({"role": MessageRole.USER.value, "content": input_value})
        return await asyncio.to_thread(self._add_run_input_once, run_id, item)

    async def pop_item(self) -> TResponseInputItem | None:
        return await asyncio.to_thread(self._pop_item)

    async def clear_session(self) -> None:
        await asyncio.to_thread(self._clear_session)

    async def get_message_page(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> MessagePage:
        page_limit = self.message_page_size if limit is None else limit
        if page_limit < 1 or page_limit > self.message_page_size:
            raise ValueError(f"limit must be between 1 and {self.message_page_size}")
        before = _decode_cursor(self.session_id, cursor) if cursor else None
        active, _ = await asyncio.to_thread(self._replay)
        messages = [
            MessageRecord.model_validate(record["message"])
            for record in active
            if record.get("message") is not None
            and (before is None or record["ordinal"] < before)
        ]
        has_more = len(messages) > page_limit
        selected = messages[-page_limit:]
        next_cursor = (
            _encode_cursor(self.session_id, selected[0].ordinal)
            if has_more and selected
            else None
        )
        return MessagePage(messages=selected, next_cursor=next_cursor)

    def _read_records(self) -> list[dict[str, Any]]:
        try:
            result = read_jsonl(self.path)
        except CorruptJsonlError as error:
            raise SessionCorruptionError(str(error)) from error
        return [value for _, value in result.records]

    def _replay(self) -> tuple[list[dict[str, Any]], int]:
        with path_lock(self.path):
            signature = self._file_signature()
            if (
                self._replay_cache is not None
                and self._replay_cache.signature == signature
            ):
                return (
                    self._replay_cache.active,
                    self._replay_cache.highest_ordinal,
                )
            active: list[dict[str, Any]] = []
            highest_ordinal = 0
            for record in self._read_records():
                if record.get("schema_version") != "1.0":
                    raise SessionCorruptionError(
                        "session operation requires schema_version 1.0"
                    )
                operation = record.get("op")
                if operation == "add":
                    ordinal = record.get("ordinal")
                    if not isinstance(ordinal, int) or ordinal <= highest_ordinal:
                        raise SessionCorruptionError(
                            "session add ordinals must increase"
                        )
                    if not isinstance(record.get("item"), dict):
                        raise SessionCorruptionError(
                            "session add record requires an item"
                        )
                    if "message" not in record:
                        raise SessionCorruptionError(
                            "session add record requires a message projection"
                        )
                    message_value = record["message"]
                    if message_value is not None:
                        try:
                            message = MessageRecord.model_validate(message_value)
                        except ValidationError as error:
                            raise SessionCorruptionError(
                                "session message projection is invalid"
                            ) from error
                        if (
                            message.task_id != self.session_id
                            or message.ordinal != ordinal
                        ):
                            raise SessionCorruptionError(
                                "session message task_id and ordinal must match add"
                            )
                    highest_ordinal = ordinal
                    active.append(record)
                elif operation == "pop":
                    target = record.get("target_ordinal")
                    if not active or target != active[-1]["ordinal"]:
                        raise SessionCorruptionError("session pop target is invalid")
                    active.pop()
                elif operation == "clear":
                    if record.get("through_ordinal") != highest_ordinal:
                        raise SessionCorruptionError(
                            "session clear through_ordinal is invalid"
                        )
                    active.clear()
                else:
                    raise SessionCorruptionError("unknown session operation")
            self._remember(active, highest_ordinal)
            return active, highest_ordinal

    def _file_signature(self) -> tuple[int, int] | None:
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return None
        return stat.st_size, stat.st_mtime_ns

    def _remember(
        self,
        active: list[dict[str, Any]],
        highest_ordinal: int,
    ) -> None:
        self._replay_cache = _ReplayCache(
            signature=self._file_signature(),
            active=active,
            highest_ordinal=highest_ordinal,
        )

    def _add_items(self, items: list[dict[str, Any]]) -> None:
        with path_lock(self.path):
            active, highest_ordinal = self._replay()
            records: list[dict[str, Any]] = []
            for offset, item in enumerate(items, start=1):
                ordinal = highest_ordinal + offset
                message = _project_message(
                    task_id=self.session_id,
                    ordinal=ordinal,
                    item=item,
                )
                records.append(
                    {
                        "schema_version": "1.0",
                        "op": "add",
                        "ordinal": ordinal,
                        "item": item,
                        "message": (
                            message.model_dump(mode="json")
                            if message is not None
                            else None
                        ),
                    }
                )
            append_jsonl_records(self.path, records)
            active.extend(records)
            self._remember(active, highest_ordinal + len(records))

    def _add_run_input_once(
        self,
        run_id: str,
        item: dict[str, Any],
    ) -> bool:
        with path_lock(self.path):
            if any(
                record.get("op") == "add" and record.get("source_run_id") == run_id
                for record in self._read_records()
            ):
                return False
            active, highest_ordinal = self._replay()
            ordinal = highest_ordinal + 1
            message = _project_message(
                task_id=self.session_id,
                ordinal=ordinal,
                item=item,
            )
            record = {
                "schema_version": "1.0",
                "op": "add",
                "ordinal": ordinal,
                "item": item,
                "message": (
                    message.model_dump(mode="json") if message is not None else None
                ),
                "source_run_id": run_id,
            }
            append_jsonl_records(self.path, [record])
            active.append(record)
            self._remember(active, ordinal)
            return True

    def _pop_item(self) -> TResponseInputItem | None:
        with path_lock(self.path):
            active, highest_ordinal = self._replay()
            if not active:
                return None
            latest = active[-1]
            append_jsonl_records(
                self.path,
                [
                    {
                        "schema_version": "1.0",
                        "op": "pop",
                        "target_ordinal": latest["ordinal"],
                    }
                ],
            )
            active.pop()
            self._remember(active, highest_ordinal)
            return latest["item"]

    def _clear_session(self) -> None:
        with path_lock(self.path):
            active, highest_ordinal = self._replay()
            if not active:
                return
            append_jsonl_records(
                self.path,
                [
                    {
                        "schema_version": "1.0",
                        "op": "clear",
                        "through_ordinal": highest_ordinal,
                    }
                ],
            )
            active.clear()
            self._remember(active, highest_ordinal)
