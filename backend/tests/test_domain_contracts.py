from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.domain.events import EventFactory, EventType
from app.domain.task import (
    InvalidTaskTransition,
    TaskRecord,
    TaskRequest,
    TaskStateMachine,
    TaskStatus,
)


def test_topic_is_the_only_required_business_input() -> None:
    request = TaskRequest(topic="  pancreatic cancer GEO datasets  ")

    assert request.topic == "pancreatic cancer GEO datasets"
    assert request.preferred_sources == []
    assert request.keywords == []
    assert request.target_fields == []


def test_empty_topic_is_rejected() -> None:
    with pytest.raises(ValidationError):
        TaskRequest(topic="   ")


@pytest.mark.parametrize("task_id", ["../escape", "C:/escape", "with space", "", "a" * 65])
def test_task_id_rejects_unsafe_values(task_id: str) -> None:
    with pytest.raises(ValidationError):
        TaskRecord(task_id=task_id, request=TaskRequest(topic="test"))


def test_state_machine_allows_declared_transition() -> None:
    assert (
        TaskStateMachine.transition(TaskStatus.CREATED, TaskStatus.PLANNING)
        == TaskStatus.PLANNING
    )


def test_state_machine_rejects_invalid_transition() -> None:
    with pytest.raises(InvalidTaskTransition, match="created -> completed"):
        TaskStateMachine.transition(TaskStatus.CREATED, TaskStatus.COMPLETED)


def test_event_factory_increments_sequence() -> None:
    factory = EventFactory(task_id="task-1", run_id="run-1")

    first = factory.create(EventType.TASK_CREATED, {"topic": "test"})
    second = factory.create(EventType.STATUS_CHANGED, {"status": "planning"})

    assert first.schema_version == "1.0"
    assert first.task_id == "task-1"
    assert first.run_id == "run-1"
    assert first.sequence == 1
    assert first.event_type == EventType.TASK_CREATED
    assert first.payload == {"topic": "test"}
    assert second.sequence == 2
    assert second.timestamp >= first.timestamp
