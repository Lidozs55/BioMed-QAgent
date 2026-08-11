"""Durable per-task implementation of the OpenAI Agents Session protocol."""

from __future__ import annotations

import asyncio
import base64
import copy
import functools
import json
from collections.abc import Callable
from concurrent.futures import Executor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

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
_ResultT = TypeVar("_ResultT")


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


def _same_user_input(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return (
        left.get("role") == MessageRole.USER.value
        and right.get("role") == MessageRole.USER.value
        and _content_text(left.get("content", ""))
        == _content_text(right.get("content", ""))
    )


def _valid_function_arguments(value: object) -> bool:
    """Return whether a persisted function call has a JSON object payload."""

    if not isinstance(value, str):
        return False
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return False
    return isinstance(parsed, dict)


def _is_existing_run_input(
    record: dict[str, Any],
    run_id: str,
    item: dict[str, Any],
) -> bool:
    if record.get("op") != "add" or record.get("source_run_id") != run_id:
        return False
    if record.get("manager_run_input") is True:
        return True
    legacy_item = record.get("item")
    return (
        "manager_run_input" not in record
        and isinstance(legacy_item, dict)
        and _same_user_input(legacy_item, item)
    )


def _project_message(
    *,
    task_id: str,
    run_id: str | None,
    ordinal: int,
    item: dict[str, Any],
) -> MessageRecord | None:
    role_value = item.get("role")
    if role_value not in {role.value for role in MessageRole}:
        return None
    return MessageRecord(
        message_id=generate_message_id(),
        task_id=task_id,
        run_id=run_id,
        ordinal=ordinal,
        role=MessageRole(role_value),
        content=_content_text(item.get("content", "")),
        created_at=datetime.now(UTC),
    )


class DurableTaskSession:
    """Store raw SDK items in a recoverable append-only task-local JSONL log."""

    session_settings: SessionSettings | None = None

    def __init__(
        self,
        session_id: str,
        tasks_dir: str | Path,
        *,
        run_id: str | None = None,
        session_settings: SessionSettings | None = None,
        message_page_size: int = MESSAGE_PAGE_LIMIT,
        storage_executor: Executor | None = None,
    ) -> None:
        if (
            not session_id
            or session_id in {".", ".."}
            or Path(session_id).name != session_id
        ):
            raise ValueError("session_id must be a single path-safe component")
        if message_page_size < 1:
            raise ValueError("message_page_size must be positive")
        if run_id is not None and (
            not run_id or run_id in {".", ".."} or Path(run_id).name != run_id
        ):
            raise ValueError("run_id must be a single path-safe component")
        self.session_id = session_id
        self.run_id = run_id
        self.session_settings = session_settings
        self.message_page_size = message_page_size
        self.path = Path(tasks_dir) / session_id / "state" / "session_items.jsonl"
        self._storage_executor = storage_executor
        self._replay_cache: _ReplayCache | None = None

    async def _run_storage(
        self,
        function: Callable[..., _ResultT],
        *args: Any,
    ) -> _ResultT:
        if self._storage_executor is None:
            return await asyncio.to_thread(function, *args)
        call = functools.partial(function, *args)
        return await asyncio.get_running_loop().run_in_executor(
            self._storage_executor,
            call,
        )

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        if limit is not None and limit < 0:
            raise ValueError("limit must be non-negative")
        active, _ = await self._run_storage(self._replay)
        visible = self._sdk_visible_records(active)
        selected = visible if limit is None else visible[-limit:] if limit else []
        return [copy.deepcopy(record["item"]) for record in selected]

    async def add_items(
        self,
        items: list[TResponseInputItem],
        *,
        display_only: bool = False,
    ) -> None:
        if not items:
            return
        normalized = [_json_item(item) for item in items]
        await self._run_storage(self._add_items, normalized, display_only)

    async def add_run_input_once(self, run_id: str, input_value: str) -> bool:
        """Project one manager-owned Run input into history exactly once."""

        if not run_id or run_id in {".", ".."} or Path(run_id).name != run_id:
            raise ValueError("run_id must be a single path-safe component")
        item = _json_item({"role": MessageRole.USER.value, "content": input_value})
        return await self._run_storage(self._add_run_input_once, run_id, item)

    async def pop_item(self) -> TResponseInputItem | None:
        return await self._run_storage(self._pop_item)

    async def discard_invalid_function_calls(self) -> int:
        """Remove malformed function calls and their matching tool outputs.

        Some OpenAI-compatible providers accept a malformed tool call in one
        response, but reject that same call when the Agents SDK sends it back
        in the next request.  The retry path must remove both sides of the
        failed tool exchange while preserving the rest of the conversation.
        """

        return await self._run_storage(self._discard_invalid_function_calls)

    async def clear_session(self) -> None:
        await self._run_storage(self._clear_session)

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
        active, _ = await self._run_storage(self._replay)
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
                            or (
                                message.run_id is not None
                                and message.run_id != record.get("source_run_id")
                            )
                        ):
                            raise SessionCorruptionError(
                                "session message task_id and ordinal must match add"
                            )
                    highest_ordinal = ordinal
                    active.append(record)
                elif operation == "pop":
                    target = record.get("target_ordinal")
                    target_index = next(
                        (
                            index
                            for index, candidate in enumerate(active)
                            if candidate["ordinal"] == target
                        ),
                        None,
                    )
                    if target_index is None or (
                        target_index != len(active) - 1
                        and record.get("sdk_visible_pop") is not True
                    ):
                        raise SessionCorruptionError("session pop target is invalid")
                    active.pop(target_index)
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

    def _add_items(
        self,
        items: list[dict[str, Any]],
        display_only: bool = False,
    ) -> None:
        with path_lock(self.path):
            active, highest_ordinal = self._replay()
            admitted = next(
                (
                    record
                    for record in active
                    if record.get("manager_run_input") is True
                    and record.get("source_run_id") == self.run_id
                ),
                None,
            )
            input_reconciled = any(
                record.get("sdk_input_copy_for") == self.run_id for record in active
            )
            records: list[dict[str, Any]] = []
            for offset, item in enumerate(items, start=1):
                ordinal = highest_ordinal + offset
                reconciles_admitted_input = (
                    not display_only
                    and bool(
                        admitted is not None
                        and not input_reconciled
                        and _same_user_input(item, admitted["item"])
                    )
                )
                message = (
                    None
                    if reconciles_admitted_input
                    else _project_message(
                        task_id=self.session_id,
                        run_id=self.run_id,
                        ordinal=ordinal,
                        item=item,
                    )
                )
                record = {
                    "schema_version": "1.0",
                    "op": "add",
                    "ordinal": ordinal,
                    "item": item,
                    "source_run_id": self.run_id,
                    "message": (
                        message.model_dump(mode="json")
                        if message is not None
                        else None
                    ),
                }
                if display_only:
                    record["display_only"] = True
                if reconciles_admitted_input:
                    record["sdk_input_copy_for"] = self.run_id
                    input_reconciled = True
                records.append(record)
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
                _is_existing_run_input(record, run_id, item)
                for record in self._read_records()
            ):
                return False
            active, highest_ordinal = self._replay()
            ordinal = highest_ordinal + 1
            message = _project_message(
                task_id=self.session_id,
                run_id=run_id,
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
                "manager_run_input": True,
            }
            append_jsonl_records(self.path, [record])
            active.append(record)
            self._remember(active, ordinal)
            return True

    def _sdk_visible_records(
        self,
        active: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        reconciled_run_ids = {
            run_id
            for record in active
            if isinstance(run_id := record.get("sdk_input_copy_for"), str)
        }
        return [
            record
            for record in active
            if record.get("display_only") is not True
            and not (
                record.get("manager_run_input") is True
                and (
                    record.get("source_run_id") == self.run_id
                    or record.get("source_run_id") in reconciled_run_ids
                )
            )
        ]

    def _pop_item(self) -> TResponseInputItem | None:
        with path_lock(self.path):
            active, highest_ordinal = self._replay()
            visible = self._sdk_visible_records(active)
            if not visible:
                return None
            latest = visible[-1]
            target_index = next(
                index
                for index, record in enumerate(active)
                if record["ordinal"] == latest["ordinal"]
            )
            operation = {
                "schema_version": "1.0",
                "op": "pop",
                "target_ordinal": latest["ordinal"],
            }
            if target_index != len(active) - 1:
                operation["sdk_visible_pop"] = True
            append_jsonl_records(
                self.path,
                [operation],
            )
            active.pop(target_index)
            self._remember(active, highest_ordinal)
            return latest["item"]

    def _discard_invalid_function_calls(self) -> int:
        with path_lock(self.path):
            active, highest_ordinal = self._replay()
            invalid_call_ids = {
                item["call_id"]
                for record in active
                if isinstance(item := record.get("item"), dict)
                and item.get("type") == "function_call"
                and isinstance(item.get("call_id"), str)
                and not _valid_function_arguments(item.get("arguments"))
            }
            if not invalid_call_ids:
                return 0

            target_indexes = {
                index
                for index, record in enumerate(active)
                if (
                    isinstance(item := record.get("item"), dict)
                    and (
                        (
                            item.get("type") == "function_call"
                            and item.get("call_id") in invalid_call_ids
                        )
                        or (
                            item.get("type") == "function_call_output"
                            and item.get("call_id") in invalid_call_ids
                        )
                    )
                )
            }
            operations = []
            for index in sorted(target_indexes, reverse=True):
                record = active[index]
                operation = {
                    "schema_version": "1.0",
                    "op": "pop",
                    "target_ordinal": record["ordinal"],
                }
                if index != len(active) - 1:
                    operation["sdk_visible_pop"] = True
                operations.append(operation)
                active.pop(index)
            append_jsonl_records(self.path, operations)
            self._remember(active, highest_ordinal)
            return len(invalid_call_ids)

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
