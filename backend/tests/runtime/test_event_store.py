from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.domain.contracts import RunQueuedPayload, RunStartedPayload, build_event
from app.runtime import event_store as event_store_module
from app.runtime.event_store import (
    CorruptEventLogError,
    EventSequenceError,
    EventStore,
)


NOW = datetime(2026, 7, 13, tzinfo=timezone.utc)


def queued_event(sequence: int = 1):
    return build_event(
        task_id="task_123",
        run_id="run_123",
        sequence=sequence,
        timestamp=NOW,
        payload=RunQueuedPayload(request_id="req_123", input="question"),
    )


def started_event(sequence: int = 2):
    return build_event(
        task_id="task_123",
        run_id="run_123",
        sequence=sequence,
        timestamp=NOW,
        payload=RunStartedPayload(),
    )


def test_event_store_round_trips_v2_envelopes_in_task_local_file(
    tmp_path,
) -> None:
    store = EventStore(tmp_path / "tasks")
    event = queued_event()

    store.append(event)

    assert store.read("task_123") == [event]
    assert (
        store.path_for("task_123") == tmp_path / "tasks" / "task_123" / "events.jsonl"
    )
    persisted = store.path_for("task_123").read_text("utf-8")
    assert '"schema_version":"2.0"' in persisted
    assert '"run_id":"run_123"' in persisted


def test_event_store_requires_contiguous_task_local_sequences(tmp_path) -> None:
    store = EventStore(tmp_path / "tasks")
    store.append(queued_event())

    with pytest.raises(EventSequenceError, match="expected 2"):
        store.append(started_event(sequence=3))
    with pytest.raises(EventSequenceError, match="expected 2"):
        store.append(queued_event(sequence=1))


def test_event_store_ignores_and_repairs_a_malformed_trailing_record(
    tmp_path,
) -> None:
    store = EventStore(tmp_path / "tasks")
    first = queued_event()
    second = started_event()
    store.append(first)
    with store.path_for("task_123").open("ab") as stream:
        stream.write(b'{"schema_version":"2.0"')

    assert store.read("task_123") == [first]

    store.append(second)

    assert store.read("task_123") == [first, second]
    assert len(store.path_for("task_123").read_text("utf-8").splitlines()) == 2


def test_event_store_rejects_corruption_before_the_trailing_record(
    tmp_path,
) -> None:
    store = EventStore(tmp_path / "tasks")
    path = store.path_for("task_123")
    path.parent.mkdir(parents=True)
    path.write_text(
        queued_event().model_dump_json()
        + "\n"
        + "{not-json}\n"
        + started_event().model_dump_json()
        + "\n",
        "utf-8",
    )

    with pytest.raises(CorruptEventLogError, match="line 2"):
        store.read("task_123")


def test_event_store_rejects_a_newline_terminated_malformed_final_record(
    tmp_path,
) -> None:
    store = EventStore(tmp_path / "tasks")
    path = store.path_for("task_123")
    path.parent.mkdir(parents=True)
    path.write_text(queued_event().model_dump_json() + "\n{bad}\n", "utf-8")

    with pytest.raises(CorruptEventLogError, match="line 2"):
        store.read("task_123")


def test_event_store_preserves_a_complete_final_record_without_newline(
    tmp_path,
) -> None:
    store = EventStore(tmp_path / "tasks")
    path = store.path_for("task_123")
    path.parent.mkdir(parents=True)
    first = queued_event()
    second = started_event()
    path.write_bytes(first.model_dump_json().encode("utf-8"))

    store.append(second)

    assert store.read("task_123") == [first, second]
    assert len(path.read_text("utf-8").splitlines()) == 2


def test_event_replay_rejects_an_event_for_another_task(tmp_path) -> None:
    store = EventStore(tmp_path / "tasks")
    path = store.path_for("task_123")
    path.parent.mkdir(parents=True)
    wrong_task = build_event(
        task_id="task_other",
        run_id="run_123",
        sequence=1,
        timestamp=NOW,
        payload=RunQueuedPayload(request_id="req_123", input="question"),
    )
    path.write_text(wrong_task.model_dump_json() + "\n", "utf-8")

    with pytest.raises(CorruptEventLogError, match="task_id"):
        store.read("task_123")


@pytest.mark.parametrize("sequences", [(2,), (1, 3), (1, 1)])
def test_event_replay_rejects_non_contiguous_task_local_sequences(
    tmp_path,
    sequences,
) -> None:
    store = EventStore(tmp_path / "tasks")
    path = store.path_for("task_123")
    path.parent.mkdir(parents=True)
    path.write_text(
        "".join(
            started_event(sequence=sequence).model_dump_json() + "\n"
            for sequence in sequences
        ),
        "utf-8",
    )

    with pytest.raises(CorruptEventLogError, match="sequence"):
        store.read("task_123")


def test_event_appends_do_not_full_scan_the_existing_journal(
    tmp_path,
    monkeypatch,
) -> None:
    store = EventStore(tmp_path / "tasks")
    real_read_jsonl = event_store_module.read_jsonl
    full_scans = 0

    def count_full_scans(path):
        nonlocal full_scans
        full_scans += 1
        return real_read_jsonl(path)

    monkeypatch.setattr(event_store_module, "read_jsonl", count_full_scans)

    persisted = [queued_event()]
    store.append(persisted[0])
    for sequence in range(2, 42):
        event = started_event(sequence=sequence)
        persisted.append(event)
        store.append(event)

    assert full_scans == 0
    assert store.read("task_123", after_sequence=39, limit=2) == persisted[39:41]
    assert full_scans == 1
