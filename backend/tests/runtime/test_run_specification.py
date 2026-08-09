"""B1a: reducer 把版本化 TaskSpecification 投影到 RunRecord。

风格对齐 tests/runtime/test_state_reducer.py（empty_snapshot 构造 +
app.domain.contracts.build_event 组装 EventEnvelope）。
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.domain.contracts import (
    RunQueuedPayload,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.domain.contracts.task import TaskSpecification
from app.runtime.state import reduce_task_event

NOW = datetime(2026, 7, 13, tzinfo=UTC)


def empty_snapshot(task_id: str = "task_123") -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title="TP53 datasets",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def test_reducer_projects_specification_onto_run_record() -> None:
    spec = TaskSpecification(topic="TP53 表达差异")
    snapshot = reduce_task_event(
        empty_snapshot("task_spec"),
        build_event(
            task_id="task_spec",
            run_id="run_1",
            sequence=1,
            timestamp=NOW,
            payload=RunQueuedPayload(
                request_id="req_1",
                input="开始",
                specification=spec,
            ),
        ),
    )
    assert snapshot.runs[0].specification == spec
    assert snapshot.runs[0].specification.schema_version == "1.0"


def test_reducer_keeps_specification_none_when_event_lacks_it() -> None:
    snapshot = reduce_task_event(
        empty_snapshot("task_spec"),
        build_event(
            task_id="task_spec",
            run_id="run_1",
            sequence=1,
            timestamp=NOW,
            payload=RunQueuedPayload(request_id="req_1", input="开始"),
        ),
    )
    assert snapshot.runs[0].specification is None
