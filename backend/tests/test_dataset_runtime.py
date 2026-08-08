"""Runtime executor tests: skeleton plan, idempotent reuse, cancel, recovery."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.datasets.contracts import (
    AcquisitionMode,
    AdapterParams,
    DatasetBuildSpec,
    SourceBinding,
    SourceBindingAcquisition,
    ValueScale,
)
from app.datasets.runtime import (
    DatasetBuildExecutor,
    OperationAttempt,
    OperationKind,
    OperationOutput,
    build_operation_plan,
)
from app.datasets.runtime.checkpoint import BuildState, save_build_state
from app.domain.contracts import (
    EventEnvelope,
    OperationCompletedPayload,
    OperationFailedPayload,
    OperationStartedPayload,
)
from app.domain.contracts.enums import AttemptStatus
from pydantic import ValidationError


def _spec() -> DatasetBuildSpec:
    def binding(binding_id: str, source: str) -> SourceBinding:
        return SourceBinding(
            binding_id=binding_id,
            source=source,
            acquisition=SourceBindingAcquisition(
                mode=AcquisitionMode.BUILTIN, provider_id=f"{source}.files.v1"
            ),
            adapter_id=f"{source}.expression.v1",
            accession="ACC-1",
        )

    return DatasetBuildSpec(
        build_id="build_test",
        objective="compare expression",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        source_bindings=[binding("srcbind_gdc", "gdc"), binding("srcbind_xena", "xena")],
        validation_profile_ref="gene_expression.release.v1",
    )


class _CancelToken:
    def __init__(self) -> None:
        self._set = False

    def is_set(self) -> bool:
        return self._set

    def set(self) -> None:
        self._set = True


class _Runner:
    """Injectable operation runner that records calls and can fail or cancel."""

    def __init__(
        self,
        *,
        fail_on: str | None = None,
        cancel_after: int | None = None,
        delay: float = 0.0,
        token: _CancelToken | None = None,
    ) -> None:
        self.calls: list[str] = []
        self._fail_on = fail_on
        self._cancel_after = cancel_after
        self._delay = delay
        self._token = token

    async def run(
        self, op, upstream: dict[str, object]
    ) -> OperationOutput:
        self.calls.append(op.operation_id)
        if self._fail_on == op.operation_id:
            raise RuntimeError("boom")
        if self._cancel_after is not None and len(self.calls) >= self._cancel_after:
            assert self._token is not None
            self._token.set()
        if self._delay:
            await asyncio.sleep(self._delay)
        return OperationOutput(
            output={
                "operation_id": op.operation_id,
                "kind": op.kind.value,
                "upstream": sorted(upstream),
            }
        )


class _ChangingRunner(_Runner):
    """Re-runs of the target operation produce a different output digest."""

    def __init__(self, *, change_on: str) -> None:
        super().__init__()
        self._change_on = change_on
        self._calls = 0

    async def run(
        self, op, upstream: dict[str, object]
    ) -> OperationOutput:
        self._calls += 1
        self.calls.append(op.operation_id)
        if op.operation_id == self._change_on:
            return OperationOutput(
                output={
                    "operation_id": op.operation_id,
                    "change": self._calls,
                }
            )
        return OperationOutput(
            output={
                "operation_id": op.operation_id,
                "upstream": sorted(upstream),
            }
        )


def _make_executor(
    tmp_path: Path,
    runner: _Runner,
    *,
    token: _CancelToken | None = None,
    scope: dict[str, object] | None = None,
    operation_timeout: float = 120.0,
    events: list[EventEnvelope] | None = None,
    resume_from: str | None = None,
    implementation_versions: dict[str, str] | None = None,
) -> DatasetBuildExecutor:
    spec = _spec()

    async def sink(event: EventEnvelope) -> None:
        if events is not None:
            events.append(event)

    return DatasetBuildExecutor(
        task_id="task_1",
        build_id=spec.build_id,
        run_id="run_1",
        state_dir=tmp_path / "state",
        lock_path=tmp_path / "build.lock",
        task_root=tmp_path,
        plan=build_operation_plan(spec),
        run_operation=runner.run,
        event_sink=sink,
        cancellation_requested=token,
        parameter_scope=scope,
        implementation_versions=implementation_versions,
        operation_timeout=operation_timeout,
        resume_from=resume_from,
    )


def test_operation_plan_fan_out_fan_in() -> None:
    plan = build_operation_plan(_spec())
    ids = [op.operation_id for op in plan]
    assert len(plan) == 10
    assert ids == [
        "acquire:srcbind_gdc",
        "acquire:srcbind_xena",
        "parse:srcbind_gdc",
        "parse:srcbind_xena",
        "canonicalize:srcbind_gdc",
        "canonicalize:srcbind_xena",
        "compatibility_gate",
        "integrate",
        "validate_profile",
        "publish",
    ]
    by_id = {op.operation_id: op for op in plan}
    assert by_id["acquire:srcbind_gdc"].upstream == ()
    assert by_id["parse:srcbind_gdc"].upstream == ("acquire:srcbind_gdc",)
    assert by_id["compatibility_gate"].upstream == (
        "canonicalize:srcbind_gdc",
        "canonicalize:srcbind_xena",
    )
    assert by_id["publish"].upstream == ("validate_profile",)
    assert by_id["publish"].kind is OperationKind.PUBLISH


def test_executor_runs_all_operations(tmp_path: Path) -> None:
    events: list[EventEnvelope] = []
    runner = _Runner()
    outcome = asyncio.run(_make_executor(tmp_path, runner, events=events).run())

    assert outcome.status == "completed"
    assert outcome.error is None
    assert len(outcome.completed_operation_ids) == 10
    assert len(runner.calls) == 10

    started = [e for e in events if isinstance(e.payload, OperationStartedPayload)]
    completed = [e for e in events if isinstance(e.payload, OperationCompletedPayload)]
    assert len(started) == 10
    assert len(completed) == 10
    assert all(e.schema_version == "2.0" for e in events)
    assert all(e.run_id == "run_1" for e in events)

    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    succeeded = [a for a in state.operation_attempts if a.status is AttemptStatus.SUCCEEDED]
    assert len(succeeded) == 10


def test_executor_reuses_digest_matched_operations(tmp_path: Path) -> None:
    runner = _Runner()
    executor = _make_executor(tmp_path, runner)
    first = asyncio.run(executor.run())
    assert first.status == "completed"
    assert len(runner.calls) == 10

    # Second executor instance over the same state dir must reuse everything.
    runner2 = _Runner()
    second = asyncio.run(_make_executor(tmp_path, runner2).run())
    assert second.status == "completed"
    assert runner2.calls == []  # every operation was reused, none re-executed

    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    skipped = [a for a in state.operation_attempts if a.status is AttemptStatus.SKIPPED]
    assert len(skipped) == 10


def test_executor_reruns_when_parameters_change(tmp_path: Path) -> None:
    runner = _Runner()
    asyncio.run(_make_executor(tmp_path, runner, scope={"v": 1}).run())
    assert len(runner.calls) == 10

    runner2 = _Runner()
    asyncio.run(_make_executor(tmp_path, runner2, scope={"v": 2}).run())
    assert len(runner2.calls) == 10  # parameter scope change invalidates reuse


def test_executor_per_binding_adapter_params_gate_reuse(tmp_path: Path) -> None:
    """Phase 5 D1: per-binding AdapterParams are part of the operation digest.

    The parameter scope is keyed by binding_id and holds the binding's
    normalized ``AdapterParams`` JSON.  Changing one parameter (scale
    log2 -> linear) must invalidate every checkpoint; restoring the same
    parameters must reuse them.
    """

    def params(scale: ValueScale) -> dict[str, object]:
        return AdapterParams(
            format="series_matrix",
            value_semantics="normalized_expression_value",
            value_scale=scale,
            expression_unit="normalized_expression_value",
            platform_ids=["GPL570"],
        ).model_dump(mode="json")

    log2_scope = {"srcbind_gdc": params(ValueScale.LOG2)}
    linear_scope = {"srcbind_gdc": params(ValueScale.LINEAR)}

    runner = _Runner()
    asyncio.run(_make_executor(tmp_path, runner, scope=log2_scope).run())
    assert len(runner.calls) == 10

    # Same normalized parameters again: every operation is reused.
    runner2 = _Runner()
    asyncio.run(_make_executor(tmp_path, runner2, scope=log2_scope).run())
    assert runner2.calls == []

    # scale change log2 -> linear: nothing may be reused.
    runner3 = _Runner()
    asyncio.run(_make_executor(tmp_path, runner3, scope=linear_scope).run())
    assert len(runner3.calls) == 10


def test_executor_reruns_when_implementation_version_changes(tmp_path: Path) -> None:
    """An upgraded operation implementation must not serve stale output.

    Regression for the review finding: the parameter digest used to exclude
    the implementation version, so an upgraded adapter/parser could reuse a
    SUCCEEDED attempt produced by an older implementation (ARCHITECTURE §5.2).
    """
    versions = {"parse:srcbind_gdc": "1.0.0", "parse:srcbind_xena": "1.0.0"}
    runner = _Runner()
    asyncio.run(_make_executor(tmp_path, runner, implementation_versions=versions).run())
    assert len(runner.calls) == 10

    # Upgrade only the parse implementation; its digest changes -> re-run.
    upgraded = dict(versions)
    upgraded["parse:srcbind_gdc"] = "1.1.0"
    runner2 = _Runner()
    asyncio.run(
        _make_executor(tmp_path, runner2, implementation_versions=upgraded).run()
    )
    assert runner2.calls == ["parse:srcbind_gdc"]

    # Recorded attempts carry the version that produced them.
    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    parse_attempts = [
        a for a in state.operation_attempts if a.operation_id == "parse:srcbind_gdc"
    ]
    assert {a.implementation_version for a in parse_attempts} == {
        "1.0.0",
        "1.1.0",
    }


def test_executor_rerun_from_forces_target_and_reuses_upstream(tmp_path: Path) -> None:
    runner = _Runner()
    asyncio.run(_make_executor(tmp_path, runner).run())
    assert len(runner.calls) == 10

    # resume_from re-executes the named operation; identical output lets
    # downstream operations reuse their digest-matched attempts.
    runner2 = _Runner()
    second = asyncio.run(_make_executor(tmp_path, runner2, resume_from="integrate").run())
    assert second.status == "completed"
    assert len(second.completed_operation_ids) == 10
    assert runner2.calls == ["integrate"]

    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    integrate = [a for a in state.operation_attempts if a.operation_id == "integrate"]
    assert [a.status for a in integrate] == [
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
    ]
    assert [a.attempt for a in integrate] == [1, 2]


def test_executor_rerun_from_invalidates_downstream_when_output_changes(
    tmp_path: Path,
) -> None:
    runner = _Runner()
    asyncio.run(_make_executor(tmp_path, runner).run())
    assert len(runner.calls) == 10

    # Forced re-run changes the canonicalize output digest, so the
    # compatibility gate and every downstream operation must re-execute.
    runner2 = _ChangingRunner(change_on="canonicalize:srcbind_gdc")
    second = asyncio.run(
        _make_executor(
            tmp_path, runner2, resume_from="canonicalize:srcbind_gdc"
        ).run()
    )
    assert second.status == "completed"
    assert len(second.completed_operation_ids) == 10
    assert runner2.calls == [
        "canonicalize:srcbind_gdc",
        "compatibility_gate",
        "integrate",
        "validate_profile",
        "publish",
    ]

    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    # The unchanged upstream (parse/acquire) and the sibling canonicalize were
    # reused; everything downstream of the changed digest was re-executed.
    assert sum(
        1
        for a in state.operation_attempts
        if a.status is AttemptStatus.SKIPPED
    ) == 5


def test_executor_rerun_from_rejects_unknown_operation(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="resume_from"):
        _make_executor(tmp_path, _Runner(), resume_from="no_such_operation")


def test_executor_rerun_from_fresh_state_executes_everything(tmp_path: Path) -> None:
    runner = _Runner()
    outcome = asyncio.run(
        _make_executor(tmp_path, runner, resume_from="integrate").run()
    )
    assert outcome.status == "completed"
    assert len(runner.calls) == 10  # no prior attempts exist to reuse


def test_executor_cancel_stops_build(tmp_path: Path) -> None:
    token = _CancelToken()
    runner = _Runner(cancel_after=1, token=token)
    outcome = asyncio.run(
        _make_executor(tmp_path, runner, token=token).run()
    )
    assert outcome.status == "cancelled"

    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    # The operation that completed after the cancel request is CANCELLED.
    cancelled = [a for a in state.operation_attempts if a.status is AttemptStatus.CANCELLED]
    assert len(cancelled) == 1
    assert outcome.completed_operation_ids == ()


def test_executor_recovers_inflight_on_restart(tmp_path: Path) -> None:
    state_dir = tmp_path / "state"
    # Simulate a crash: an inflight RUNNING attempt with no terminal record.
    inflight = OperationAttempt(
        operation_attempt_id="operation_attempt_crashed",
        task_id="task_1",
        build_id="build_test",
        operation_id="parse:srcbind_gdc",
        attempt=1,
        input_digest="a" * 64,
        parameter_digest="b" * 64,
        status=AttemptStatus.RUNNING,
        started_at=datetime.now(UTC),
    )
    save_build_state(state_dir, BuildState(task_id="task_1", build_id="build_test", inflight_attempt=inflight))

    runner = _Runner()
    outcome = asyncio.run(_make_executor(tmp_path, runner).run())
    assert outcome.status == "completed"
    assert len(runner.calls) == 10  # crashed op re-executed, everything ran

    state = BuildState.model_validate_json(
        (state_dir / "build_state.json").read_text("utf-8")
    )
    statuses = [a.status for a in state.operation_attempts]
    assert AttemptStatus.CANCELLED in statuses  # recovered inflight
    assert statuses.count(AttemptStatus.SUCCEEDED) == 10


def test_executor_failure_marks_attempt_failed(tmp_path: Path) -> None:
    events: list[EventEnvelope] = []
    runner = _Runner(fail_on="integrate")
    outcome = asyncio.run(_make_executor(tmp_path, runner, events=events).run())

    assert outcome.status == "failed"
    assert outcome.error is not None
    failed_events = [e for e in events if isinstance(e.payload, OperationFailedPayload)]
    assert len(failed_events) == 1
    assert failed_events[0].payload.operation_id == "integrate"

    state = BuildState.model_validate_json(
        (tmp_path / "state" / "build_state.json").read_text("utf-8")
    )
    failed = [a for a in state.operation_attempts if a.status is AttemptStatus.FAILED]
    assert len(failed) == 1
    assert failed[0].operation_id == "integrate"
    assert failed[0].error is not None


def test_executor_operation_timeout(tmp_path: Path) -> None:
    runner = _Runner(delay=0.3)
    outcome = asyncio.run(
        _make_executor(tmp_path, runner, operation_timeout=0.05).run()
    )
    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.code.value == "timeout"


def test_operation_attempt_state_machine() -> None:
    base = dict(
        operation_attempt_id="operation_attempt_1",
        task_id="task_1",
        build_id="build_1",
        operation_id="acquire:src",
        attempt=1,
        input_digest="a" * 64,
        parameter_digest="b" * 64,
    )
    with pytest.raises(ValidationError, match="output_digest"):
        OperationAttempt(**base, status=AttemptStatus.SUCCEEDED)
    with pytest.raises(ValidationError, match="error"):
        OperationAttempt(**base, status=AttemptStatus.FAILED)
    with pytest.raises(ValidationError, match="reused_operation_attempt_id"):
        OperationAttempt(
            **base,
            status=AttemptStatus.SKIPPED,
            output_digest="c" * 64,
        )


def test_build_state_rejects_diverged_attempt_log(tmp_path: Path) -> None:
    from app.datasets.runtime.checkpoint import validate_attempt_log_prefix
    from app.runtime.event_store import append_jsonl_records

    state_dir = tmp_path / "state"
    save_build_state(state_dir, BuildState(task_id="task_1", build_id="build_1"))
    # Write a log record that does not exist in state -> prefix violation.
    append_jsonl_records(
        state_dir / "operation_attempts.jsonl",
        [
            {
                "operation_attempt_id": "operation_attempt_x",
                "task_id": "task_1",
                "build_id": "build_1",
                "operation_id": "acquire:src",
                "attempt": 1,
                "input_digest": "a" * 64,
                "parameter_digest": "b" * 64,
                "output_digest": None,
                "status": "running",
                "started_at": None,
                "finished_at": None,
                "error": None,
                "reused_operation_attempt_id": None,
            }
        ],
    )
    state = BuildState.model_validate_json(
        (state_dir / "build_state.json").read_text("utf-8")
    )
    with pytest.raises(ValueError, match="ahead of durable state"):
        validate_attempt_log_prefix(state, state_dir / "operation_attempts.jsonl")


def test_executor_corrupt_state_returns_failed_outcome(tmp_path: Path) -> None:
    """run() must return a structured outcome on corrupt state, not raise.

    Regression for the review finding: a build_state.json that fails to load
    (mismatched task/build or corrupted JSON) used to escape a bare
    AssertionError/AttributeError from the finalizers instead of returning a
    BuildRunOutcome.
    """
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "build_state.json").write_text("{not valid json", encoding="utf-8")
    outcome = asyncio.run(_make_executor(tmp_path, _Runner()).run())
    assert outcome.status == "failed"
    assert outcome.error is not None
    assert outcome.error.code.value == "internal_error"
    assert "could not be loaded or recovered" in outcome.error.message
