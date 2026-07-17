# HIL backend correctness implementation report

Date: 2026-07-17

## Status and scope

- Implemented on `codex/agent-runtime-concurrency-merge`.
- Backend-only scope: Agent/Tool HIL bridge, authoritative resume identity,
  rejection, paused cancellation, fixture exemption, and independent HIL timeout.
- Preserved the R4b deferred publication and abort ownership chain. Agent-side
  Pipeline event bridging suppresses `CancelRequestedPayload`,
  `ArtifactProducedPayload`, and `TaskCompletedPayload`; Manager completion
  remains the only publication/event authority.
- No frontend, CI/CD, packaging, distribution, or R5 files were changed.
- Commonly MCP was not connected, so no Commonly check-in or board mutation
  applied.

## Implemented behavior

- `RunContext` now carries one explicit `ManagedPipelineBridge` bound to the
  authoritative Run ID. The real Agent Function Tool installs its live resume
  submitter before the prompt is observable and clears it in `finally`.
- Live Pipeline audit events cross the Agent Tool boundary through
  `RunExecution.emit`; publication/completion payloads remain owned by R4b.
- The pending HIL request is armed before event publication. Both
  `RunExecution` and `PipelineRunner` require the exact request ID and consume
  at most one decision, preventing wrong-ID and overwrite races.
- Explicit plan rejection emits the durable resumed/rejected and task-failed
  audit, stops before Discovery, aborts managed staging, and installs a
  one-shot managed terminal error. `AgentRunExecutor` rethrows it after SDK
  cleanup/model close so the authoritative Run becomes `FAILED`. Ordinary
  Pipeline validation/stage failures are not promoted through this path.
- `AWAITING_USER_INPUT` is cancellable. The HIL wait races the cooperative
  `asyncio.Event`, then follows the existing manager-owned abort/drain path
  before `run_cancelled`.
- Fixture mode emits `user_input_required(fixture_exempt=true)` followed by an
  automatic `user_input_resumed(approve)` and never blocks.
- HIL requests populate `expires_at`, have a separate configurable timeout,
  and pause/reschedule the active `total_timeout` deadline. A HIL timeout is a
  distinct durable failure and is propagated through the real Agent boundary.

## TDD evidence

All commands ran from `backend/`.

### Baseline

```text
uv run pytest tests/api/test_resume_api.py \
  tests/agent_loop/test_execution.py::test_real_sdk_cancel_after_pipeline_tool_preserves_old_publication \
  tests/agent_loop/test_execution.py::test_real_sdk_managed_pipeline_publishes_once_in_completion_order \
  tests/pipeline/test_pipeline_runner_resilience.py::test_runner_total_timeout_marks_failed \
  tests/pipeline/test_pipeline_e2e.py::test_e2e_full_event_sequence_is_ordered_and_complete -q

13 passed in 8.15s
```

### Real Agent durable pause bridge

RED:

```text
uv run pytest tests/agent_loop/test_execution.py::test_real_sdk_live_pipeline_pauses_durably_before_discovery_and_resumes -q
FAILED while waiting 3s for durable UserInputRequiredPayload
1 failed in 6.26s
```

GREEN after the RunContext bridge and arm-before-visible change:

```text
1 passed in 3.06s
```

### Rejection crosses SDK Tool error handling

After the bridge was green, the next RED isolated rejection semantics:

```text
uv run pytest tests/agent_loop/test_execution.py::test_real_sdk_live_pipeline_rejection_fails_authoritative_run -q
AssertionError: assert 'completed' == 'failed'
1 failed in 2.84s
```

GREEN after the one-shot managed terminal error:

```text
1 passed in 3.39s
```

The test also verifies one durable reject decision, durable Pipeline and Run
failure events, no Discovery stage, no artifacts, and no `run_completed`.

### Paused cancellation

After the bridge was green, the next RED isolated Manager admission:

```text
uv run pytest tests/agent_loop/test_execution.py::test_real_sdk_live_pipeline_pause_is_promptly_cancellable -q
RuntimeError: run <run_id> is not cancellable
1 failed in 3.70s
```

GREEN after allowing `AWAITING_USER_INPUT` and racing the cooperative token:

```text
1 passed in 2.70s
```

The test verifies prompt cancellation, no Discovery, staging cleanup, and
byte-for-byte preservation of the previous artifacts and publication markers.

Combined real Agent boundary:

```text
3 passed in 3.68s
```

### Wrong and duplicate resume decisions

RED:

```text
uv run pytest tests/api/test_resume_api.py::test_resume_wrong_request_id_returns_409_and_keeps_request_pending -q
AssertionError: assert 202 == 409
1 failed in 2.24s

uv run pytest tests/api/test_resume_api.py::test_resume_duplicate_decision_returns_409_without_overwrite -q
AssertionError: assert 202 == 409
1 failed in 2.19s
```

GREEN after RunExecution request identity and one-shot consumption:

```text
2 passed in 2.06s
```

Runner boundary RED while the event sink was still blocked:

```text
uv run pytest tests/pipeline/test_pipeline_runner_resilience.py::test_user_input_submission_matches_request_and_is_one_shot -q
AssertionError: wrong-id submission returned True
1 failed in 0.42s
```

GREEN after matching the armed runner request and rejecting overwrites:

```text
1 passed in 0.30s
```

### Fixture exemption audit

RED:

```text
uv run pytest tests/pipeline/test_pipeline_runner_resilience.py::test_fixture_plan_confirmation_emits_required_and_auto_resume_in_order -q
AssertionError: expected one UserInputRequiredPayload, observed zero
1 failed in 0.60s

uv run pytest tests/runtime/test_fixture_executor.py::test_real_pinned_fixture_first_run_bridges_legacy_events_durably -q
AssertionError: expected required/resumed events, observed []
1 failed in 2.56s
```

GREEN:

```text
2 passed in 2.26s
```

### Independent HIL timeout and active budget

RED:

```text
uv run pytest tests/pipeline/test_pipeline_runner_resilience.py::test_user_input_timeout_is_distinct_and_populates_expiry -q
TypeError: PipelineRunner.__init__() got an unexpected keyword argument 'user_input_timeout'
1 failed in 0.41s

uv run pytest tests/pipeline/test_pipeline_runner_resilience.py::test_user_input_wait_does_not_consume_total_timeout_budget -q
TypeError: PipelineRunner.__init__() got an unexpected keyword argument 'user_input_timeout'
1 failed in 0.37s
```

GREEN after the small reschedulable timeout-scope change:

```text
2 passed in 0.50s
```

The second test spends 80 ms in the HIL event sink with a 50 ms active
Pipeline budget, then completes 20 ms of active work successfully. The real
SDK timeout boundary also passed:

```text
uv run pytest tests/agent_loop/test_execution.py::test_real_sdk_live_pipeline_user_input_timeout_fails_run -q
1 passed in 2.82s
```

## Focused regression and lint

Covering HIL plus existing R4b ownership/runtime suites:

```text
uv run pytest \
  tests/agent_loop/test_context.py \
  tests/pipeline/test_pipeline_tool.py \
  tests/pipeline/test_pipeline_runner_resilience.py \
  tests/agent_loop/test_execution.py \
  tests/runtime/test_fixture_executor.py \
  tests/runtime/test_manager.py \
  tests/api/test_resume_api.py \
  tests/runtime/test_state_reducer_user_input.py -q

164 passed in 36.68s
```

Ruff initially found one import-order issue in the expanded Agent boundary
test. After the manual import reorder:

```text
uv run ruff check app/ tests/ launcher.py
All checks passed!
```

Per the final stop instruction, no additional full-suite, startup, or review
round was started after this focused evidence was complete.

## Files changed

Production:

- `backend/app/agent_loop/context.py`
- `backend/app/agent_loop/runner.py`
- `backend/app/pipeline/runner.py`
- `backend/app/pipeline/tool.py`
- `backend/app/runtime/manager.py`

Tests:

- `backend/tests/agent_loop/test_execution.py`
- `backend/tests/api/test_resume_api.py`
- `backend/tests/pipeline/test_pipeline_runner_resilience.py`
- `backend/tests/runtime/test_fixture_executor.py`

Report:

- `.superpowers/sdd/hil-backend-correctness-report.md`
