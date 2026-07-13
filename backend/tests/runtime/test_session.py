from __future__ import annotations

import json

import pytest
from agents.memory.session import Session

from app.runtime import session as session_module
from app.runtime.session import DurableTaskSession, SessionCorruptionError


def user_item(content: str) -> dict[str, str]:
    return {"role": "user", "content": content}


def assistant_item(content: str) -> dict[str, str]:
    return {"role": "assistant", "content": content}


@pytest.mark.asyncio
async def test_durable_session_implements_sdk_add_get_pop_and_clear(
    tmp_path,
) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    first = user_item("question")
    second = assistant_item("answer")

    assert isinstance(session, Session)
    await session.add_items([first, second])
    assert await session.get_items() == [first, second]
    assert await session.get_items(limit=1) == [second]

    assert await session.pop_item() == second
    assert await session.get_items() == [first]

    await session.clear_session()
    assert await session.get_items() == []
    assert await session.pop_item() is None

    persisted = session.path.read_text("utf-8")
    assert '"content":"question"' in persisted
    assert '"content":"answer"' in persisted
    assert '"op":"pop"' in persisted
    assert '"op":"clear"' in persisted


@pytest.mark.asyncio
async def test_session_recovers_a_malformed_trailing_jsonl_record(
    tmp_path,
) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    first = user_item("question")
    second = assistant_item("answer")
    await session.add_items([first])
    with session.path.open("ab") as stream:
        stream.write(b'{"op":"add"')

    assert await session.get_items() == [first]

    await session.add_items([second])

    assert await session.get_items() == [first, second]
    for line in session.path.read_text("utf-8").splitlines():
        assert isinstance(json.loads(line), dict)


@pytest.mark.asyncio
async def test_session_rejects_a_newline_terminated_malformed_final_record(
    tmp_path,
) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    await session.add_items([user_item("question")])
    with session.path.open("ab") as stream:
        stream.write(b"{bad}\n")

    with pytest.raises(SessionCorruptionError, match="line 2"):
        await session.get_items()


@pytest.mark.asyncio
async def test_session_rejects_an_incomplete_committed_operation(tmp_path) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    await session.add_items([user_item("question")])
    with session.path.open("ab") as stream:
        stream.write(b'{"op":"clear"}\n')

    with pytest.raises(SessionCorruptionError, match="schema_version|through_ordinal"):
        await session.get_items()


@pytest.mark.asyncio
async def test_message_pages_use_immutable_ordinals_and_opaque_cursors(
    tmp_path,
) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    await session.add_items([user_item(f"message {index}") for index in range(1, 206)])

    latest = await session.get_message_page()
    middle = await session.get_message_page(cursor=latest.next_cursor)
    oldest = await session.get_message_page(cursor=middle.next_cursor)

    assert [message.ordinal for message in latest.messages] == list(range(106, 206))
    assert [message.ordinal for message in middle.messages] == list(range(6, 106))
    assert [message.ordinal for message in oldest.messages] == list(range(1, 6))
    assert latest.next_cursor is not None
    assert not latest.next_cursor.isdigit()
    assert middle.next_cursor is not None
    assert oldest.next_cursor is None

    reopened = DurableTaskSession("task_123", tmp_path / "tasks")
    assert await reopened.get_message_page() == latest


@pytest.mark.asyncio
async def test_pop_and_clear_do_not_reuse_message_ordinals(tmp_path) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    await session.add_items([user_item("one"), assistant_item("two")])
    await session.pop_item()
    await session.add_items([assistant_item("three")])
    assert [
        message.ordinal for message in (await session.get_message_page()).messages
    ] == [1, 3]

    await session.clear_session()
    await session.add_items([user_item("four")])

    page = await session.get_message_page()
    assert [message.ordinal for message in page.messages] == [4]
    assert page.messages[0].content == "four"


@pytest.mark.asyncio
async def test_message_cursor_is_bound_to_its_task(tmp_path) -> None:
    first = DurableTaskSession("task_first", tmp_path / "tasks")
    second = DurableTaskSession("task_second", tmp_path / "tasks")
    await first.add_items([user_item(str(index)) for index in range(101)])
    cursor = (await first.get_message_page()).next_cursor

    with pytest.raises(ValueError, match="cursor"):
        await second.get_message_page(cursor=cursor)


@pytest.mark.asyncio
async def test_session_preserves_a_complete_final_record_without_newline(
    tmp_path,
) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    first = user_item("question")
    second = assistant_item("answer")
    await session.add_items([first])
    session.path.write_bytes(session.path.read_bytes().removesuffix(b"\n"))

    await session.add_items([second])

    assert await session.get_items() == [first, second]
    assert len(session.path.read_text("utf-8").splitlines()) == 2


@pytest.mark.parametrize("session_id", [".", ".."])
def test_session_rejects_reserved_path_components(tmp_path, session_id) -> None:
    with pytest.raises(ValueError, match="session_id"):
        DurableTaskSession(session_id, tmp_path / "tasks")


@pytest.mark.asyncio
async def test_session_appends_do_not_replay_the_full_journal_each_time(
    tmp_path,
    monkeypatch,
) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    real_read_jsonl = session_module.read_jsonl
    full_scans = 0

    def count_full_scans(path):
        nonlocal full_scans
        full_scans += 1
        return real_read_jsonl(path)

    monkeypatch.setattr(session_module, "read_jsonl", count_full_scans)

    for number in range(25):
        await session.add_items([user_item(f"message {number}")])

    assert full_scans == 1
    assert await session.get_items(limit=2) == [
        user_item("message 23"),
        user_item("message 24"),
    ]
    assert full_scans == 1


@pytest.mark.asyncio
async def test_session_cache_does_not_expose_mutable_items(tmp_path) -> None:
    session = DurableTaskSession("task_123", tmp_path / "tasks")
    original = user_item("question")
    await session.add_items([original])

    loaded = await session.get_items()
    loaded[0]["content"] = "mutated"

    assert await session.get_items() == [original]
