# R4b — Agent managed publication implementation report

## Status

- Result: implemented from base `7f87bd0` on
  `codex/agent-runtime-concurrency-merge`.
- Scope: TaskManager-owned Agent/Fixture deferred publication, explicit
  completion ownership transfer, one-shot abort cleanup, and completion-event
  durability reconciliation.
- Frontend, documentation under `docs/`, CI/CD, packaging, and R5 were not
  changed.
- Commonly MCP was not connected, so no Commonly check-in or board mutation
  applied.

## Implemented ownership chain

The managed path is now explicit:

```text
PipelineRunner staging/<run_id>
    -> PendingPublication
    -> RunContext reserved pending handle
    -> AgentRunExecutor finally (before model.close)
    -> RunExecution commit/abort pair
    -> TaskManager completion decision
```

Standalone direct Tool calls still use immediate publication and never install
a pending handle.

### RunContext and Tool reservation

- `RunContext.managed_run_id` is keyword-only.
- `TaskManager` binds the accepted authoritative Run ID after every context
  factory call, including custom factories.
- `reserve_pipeline_publication()` is synchronous and therefore executes
  before the Tool's first `await`.
- A managed context permits only one reserved or pending Pipeline publication.
  Parallel/repeated Tool calls fail before a second runner is constructed.
- Failed/cancelled Tool execution aborts its runner in a drained worker thread
  and releases the reservation even if abort itself raises.
- Successful Tool execution installs one `PendingPublication`; standalone
  execution publishes immediately and leaves no pending handle.

### PipelineRunner publication handle

- `PendingPublication` carries the Run ID, validated `RunManifest`, synthetic
  `run_manifest` entry, and publish/abort callbacks bound to the same runner.
- `PipelineRunner.abort()` takes `state/publish.lock`, ignores the cancellation
  token, and idempotently removes only `staging/<runner.run_id>`.
- Abort never reads or mutates `artifacts/` or the prior runtime/state markers.
- Publish still delegates to the R4a rollback-safe core. If publish fails after
  a candidate rename, R4a restores the previous package and candidate staging;
  R4b then aborts the restored candidate staging before `run_failed`.

### Agent and Fixture executors

- Removed `_artifact_manifest_fingerprint`, `_load_artifact_payloads`,
  `_write_artifact_publication_marker`, and every pre/post manifest scan.
- `AgentRunExecutor` transfers a pending handle from its outer `finally` on
  stream success, error, and `CancelledError`.
- Transfer happens before `model.close()`; a transfer failure immediately
  aborts the untransferred handle, then still closes the model.
- Agent completion events come only from the pending manifest:
  `run_manifest` first, then the manifest's stable artifact entries.
- `FixtureRunExecutor` also installs commit and abort together. Its completion
  preserves buffered Pipeline audit events and adds the missing
  `run_manifest` artifact event.
- Synchronous publish/abort callbacks run through drained `asyncio.to_thread`
  tasks. Caller cancellation is re-raised after the worker finishes.

### RunExecution and TaskManager

- `set_completion_operations()` atomically installs the committer and aborter.
- Commit uses a shared one-shot task. Abort uses a separate shared one-shot
  task; all waiters observe the same cleanup, and cancelling one waiter cannot
  cancel or lose cleanup.
- Abort waits for an in-flight commit task. It never invokes the abort callback
  after the committer returned successfully.
- Abort failures remain attached to `RunExecution` so a cancellation waiter
  cannot write `run_cancelled`, even when persisting `run_failed` also fails.
- `RunStatus.CANCEL_REQUESTED -> FAILED` is legal only to represent a durable
  cleanup failure instead of falsely reporting cancellation success.
- Success ordering is:

  ```text
  run_finalizing
      -> cancellation check
      -> seal_completion
      -> publish
      -> artifact events
      -> durable run_completed
      -> discard callbacks
      -> mark drained
  ```

- Executor errors, non-request `CancelledError`, cancellation wins,
  finalization/commit failures, worker cancellation, and manager close all run
  abort before terminalization or `_mark_drained()`.
- Commit/abort dual failures preserve the primary executor/commit message and
  append the cleanup error as `completion abort also failed: ...`.
- Late cancellation after sealing neither sets the cooperative token nor calls
  abort; completion remains authoritative.
- Completion event append/hub projection errors call `_event_is_durable()`.
  If the exact event is durable, execution continues. If an artifact event is
  genuinely not durable after publish, the Run becomes `FAILED`; physical
  artifacts remain hidden because their runtime marker does not reference a
  durable `COMPLETED` Run.

## TDD evidence

All backend commands were run from `backend/`.

### 1. Managed RunContext reservation

RED:

```text
uv run pytest tests/agent_loop/test_context.py -q
FAILED test_managed_run_context_reserves_pipeline_publication_exclusively
TypeError: RunContext.__init__() got an unexpected keyword argument
'managed_run_id'
1 failed, 1 passed
```

GREEN after the keyword-only identity and reservation API:

```text
uv run pytest tests/agent_loop/test_context.py -q
3 passed
```

### 2. Runner-bound pending publication and abort

RED:

```text
uv run pytest \
  tests/pipeline/test_pipeline_runner_resilience.py::test_deferred_runner_exposes_run_bound_abortable_publication -q
AttributeError: 'PipelineRunner' object has no attribute 'pending_publication'
1 failed
```

GREEN:

```text
1 passed
```

The test sets the cancellation token after validation, calls abort twice, and
verifies only the run staging disappears while old artifacts and the old state
marker remain byte-for-byte unchanged.

### 3. Managed Tool selection and reservation release

RED for managed selection:

```text
uv run pytest \
  tests/pipeline/test_pipeline_tool.py::test_pipeline_function_tool_defers_managed_run_publication -q
KeyError: 'run_id'
1 failed
```

GREEN with the authoritative Run ID and `defer_publication=True`:

```text
2 passed
```

RED for abort-failure release:

```text
uv run pytest \
  tests/pipeline/test_pipeline_tool.py::test_pipeline_function_tool_releases_reservation_when_abort_fails -q
RuntimeError: pipeline publication is already reserved
1 failed
```

GREEN:

```text
1 passed
```

Additional coverage proves a parallel managed invocation returns
`already reserved` and constructs only one runner. The standalone fixture Tool
test still publishes `artifacts/run_manifest.json` and asserts no pending
handle.

### 4. Manager authoritative context binding

RED:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_default_context_uses_repository_task_root_for_execution -q
AssertionError: None == accepted.run_id
1 failed
```

GREEN:

```text
1 passed
```

### 5. One-shot abort concurrency

RED:

```text
uv run pytest \
  tests/agent_loop/test_execution.py::test_run_execution_abort_is_shared_and_caller_cancellation_safe -q
AttributeError: 'RunExecution' object has no attribute
'set_completion_operations'
1 failed
```

GREEN:

```text
1 passed
```

The regression starts two abort waiters, cancels one, releases cleanup through
the other, and verifies the abort callback ran exactly once.

### 6. Executor transfer before model close

RED:

```text
uv run pytest \
  tests/agent_loop/test_execution.py::test_executor_transfers_pending_publication_before_model_close -q
AssertionError: execution._completion_aborter is None inside model.close
1 failed
```

GREEN:

```text
1 passed
```

The same transfer assertion passes for stream success, `RuntimeError`, and
`CancelledError`. A separate test forces operation-install failure and verifies
`abort -> model.close` ordering.

### 7. Abort-before-drained and abort-before-terminal

RED for cancellation cleanup ordering:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_running_cancellation_aborts_completion_before_drained -q
TimeoutError waiting for abort_started
1 failed
```

GREEN:

```text
1 passed
```

RED for executor-error ordering:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_executor_error_aborts_completion_before_run_failed -q
abort observed RunStatus.FAILED instead of RunStatus.RUNNING
1 failed
```

GREEN:

```text
2 passed
```

### 8. Abort failure and dual diagnostics

RED for cancellation pretending success after cleanup failure:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_abort_failure_does_not_terminalize_cancellation_as_cancelled -q
Failed: DID NOT RAISE RuntimeError
1 failed
```

GREEN persists `FAILED` and emits no `run_cancelled`:

```text
1 passed
```

RED for preserving executor error:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_executor_and_abort_failures_are_both_durable_diagnostics -q
expected 'executor diagnostic'; durable error contained only abort diagnostic
1 failed
```

RED for preserving commit error:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_commit_and_abort_failures_are_both_durable_diagnostics -q
expected primary commit diagnostic plus abort diagnostic
1 failed
```

GREEN:

```text
4 focused manager failure tests passed
```

An additional RED injects failure of the `run_failed` append itself. The final
behavior keeps the Run at `CANCEL_REQUESTED`, raises `completion abort failed`
to the caller, and still emits no `run_cancelled`.

### 9. Fixture abort ownership

RED:

```text
uv run pytest \
  tests/runtime/test_fixture_executor.py::test_fixture_executor_aborts_validated_runner_on_cancellation -q
assert abort_calls == 1; observed 0
1 failed
```

GREEN:

```text
1 passed
```

Manager close also blocks until the completion aborter finishes, and late
cancel after fixture sealing leaves the token unset and never calls abort.

### 10. Durable completion reconciliation

RED for a durable artifact event whose hub projection fails:

```text
uv run pytest \
  tests/runtime/test_manager.py::test_durable_artifact_event_survives_hub_projection_failure -q
expected COMPLETED, observed FAILED
1 failed
```

GREEN after exact-event durability reconciliation:

```text
1 passed
```

Coverage also includes append-after-durable projection failure and the true
non-durable residual domain: publish succeeds physically, the first artifact
event fails before append, the Run becomes `FAILED`, `run_completed` is absent,
and `_load_validated_manifest()` hides the new package.

### 11. Real SDK Tool-to-final-answer cancellation

The integration uses a real `agents.Agent`, real `Runner.run_streamed`, the real
`run_research_pipeline` Function Tool in fixture mode, and a zero-network
scripted `Model`. The first model round returns a
`ResponseFunctionToolCall`; the second blocks before its final
`ResponseOutputMessage`.

To prove the test catches the original defect, managed reservation was
temporarily disabled for one mutation run.

Mutation RED:

```text
uv run pytest \
  tests/agent_loop/test_execution.py::test_real_sdk_cancel_after_pipeline_tool_preserves_old_publication -q
FAILED: staging/<accepted.run_id>/run_manifest.json did not exist
1 failed
```

Restored GREEN:

```text
1 passed in 2.83s
```

At durable `ToolCompleted`, the test verifies run-specific staging exists and
old artifacts/runtime marker/state marker are unchanged. It cancels before the
second-round final answer, then verifies `CANCELLED`, no artifact or
`run_completed` event, staging removal, one model close, and byte-for-byte old
publication preservation.

A second real SDK success test verifies publish exactly once, no abort callback,
and strict `finalizing < all artifact events < run_completed` order.

## Verification

Focused ownership/runtime regression:

```text
uv run pytest \
  tests/agent_loop/test_context.py \
  tests/pipeline/test_pipeline_tool.py \
  tests/pipeline/test_pipeline_runner_resilience.py \
  tests/agent_loop/test_execution.py \
  tests/runtime/test_fixture_executor.py \
  tests/runtime/test_manager.py -q

136 passed in 32.61s
```

Ruff initially reported one `SIM102` nested-if issue in `pipeline/tool.py`.
After the surgical style fix:

```text
uv run ruff check app/ tests/ launcher.py
All checks passed!
```

Full non-live backend suite:

```text
uv run pytest
840 passed, 18 deselected in 92.96s
```

Uvicorn smoke:

```text
uv run uvicorn app.main:app --host 127.0.0.1 --port 8765
Application startup complete.
Uvicorn running on http://127.0.0.1:8765
Application shutdown complete.
```

## Files changed

Production:

- `backend/app/agent_loop/context.py`
- `backend/app/agent_loop/runner.py`
- `backend/app/pipeline/runner.py`
- `backend/app/pipeline/tool.py`
- `backend/app/runtime/manager.py`
- `backend/app/runtime/state.py`

Tests:

- `backend/tests/agent_loop/test_context.py`
- `backend/tests/agent_loop/test_execution.py`
- `backend/tests/pipeline/test_pipeline_runner_resilience.py`
- `backend/tests/pipeline/test_pipeline_tool.py`
- `backend/tests/runtime/test_fixture_executor.py`
- `backend/tests/runtime/test_manager.py`

Report:

- `.superpowers/sdd/r4b-agent-managed-publication-report.md`

## Self-review

- Every production change maps to an R4b ownership, cleanup, cancellation, or
  durability requirement.
- Agent publication no longer scans or mutates an already published artifact
  directory.
- Managed Tool reservation is synchronous before the first `await` and remains
  occupied until the executor takes the installed handle.
- Publish and abort callbacks are bound to one runner and one authoritative Run
  ID.
- Abort does not inspect the cancellation token and never touches artifacts.
- Model close cannot lose an installed pending handle.
- Cancellation cannot mark drained or durable-cancelled before cleanup.
- A cleanup failure cannot be reported as cancelled or completed, including
  when the failure event itself is unavailable.
- Successful publication occurs exactly once and callbacks are discarded only
  after durable completion; successful abort discards them after cleanup.
- No compatibility `set_completion_committer` remains; every managed owner
  installs commit and abort together.
- Direct Tool immediate publication and existing fixture completion semantics
  remain covered.
- No frontend, CI/CD, packaging, or unrelated cleanup was introduced.
- Independent reviewer dispatch was attempted, but the collaboration runtime
  returned `agent thread limit reached`; parent-agent post-commit review remains
  scheduled.

## Residual risks and deliberate non-goals

- If publish succeeds but a later artifact/`run_completed` event is genuinely
  not durable, R4a cannot restore the old package. The new package remains
  physically present but hidden because the Run is not durably `COMPLETED`.
  This is the accepted residual failure domain; R4b does not add a two-phase
  directory transaction.
- A hard process crash cannot run an in-memory abort callback and may leave an
  isolated `staging/<interrupted_run_id>` directory. Run-ID isolation prevents
  cross-Run overwrite; restart behavior remains `FINALIZING -> INTERRUPTED`.
- If both abort and durable failure recording are unavailable, the live caller
  receives `completion abort failed`, the Run remains `CANCEL_REQUESTED`, and a
  later restart converts it to `INTERRUPTED`; it is never falsely cancelled.
- No changes were made to the approved Artifact API visibility rule, restart
  policy, frontend, or subsequent R5 work.

## Follow-up — pre-transfer cleanup ownership review finding

The independent R4b review found that a failed abort before ownership reached
`RunExecution` was forgotten. The Agent Tool released its `RunContext`
reservation in `finally`, and the Fixture executor propagated the abort error
without attaching cleanup. `TaskManager` then observed no aborter, treated
completion abort as a successful no-op, and could persist `run_cancelled` while
the Run staging directory remained.

The follow-up retains a cleanup-only owner with the authoritative Run ID, the
runner-bound abort callback, and the initial cleanup error. The Agent executor
transfers that owner before model close and re-raises the retained error; the
Fixture executor attaches the cleanup callback directly before re-raising.
`RunExecution` therefore exposes a real abort operation to the Manager without
inventing a committer. The initial failure remains the primary diagnostic, but
only the Manager-owned retry decides cancellation cleanup: a successful retry
allows `CANCELLED`, while another failure produces `FAILED`, prevents
`run_cancelled`, and surfaces `completion abort failed` to the cancellation
caller.

### RED evidence

Real SDK Agent plus real `TaskManager`:

```text
uv run pytest \
  tests/agent_loop/test_execution.py::test_agent_pretransfer_abort_failure_cannot_be_cancelled -q
Failed: DID NOT RAISE RuntimeError
1 failed
```

Fixture executor plus real `TaskManager`:

```text
uv run pytest \
  tests/runtime/test_fixture_executor.py::test_fixture_pretransfer_abort_failure_cannot_be_cancelled -q
Failed: DID NOT RAISE RuntimeError
1 failed in 2.46s
```

Both failures proved the same defect: the cancellation caller returned
success instead of receiving the persistent staging cleanup failure.

### GREEN and boundary coverage

The focused boundary set includes:

- Tool abort failure keeps the reservation occupied until cleanup ownership is
  transferred.
- Persistent Agent and Fixture abort failure retries exactly once under the
  Manager, yields `FAILED`, preserves staging diagnostics, emits no
  `run_cancelled`, and errors the cancellation caller.
- A transient first abort failure followed by a successful Manager retry
  removes staging and permits `CANCELLED`.

```text
uv run pytest \
  tests/pipeline/test_pipeline_tool.py::test_pipeline_function_tool_retains_cleanup_when_abort_fails \
  tests/agent_loop/test_execution.py::test_agent_pretransfer_abort_failure_cannot_be_cancelled \
  tests/runtime/test_fixture_executor.py::test_fixture_pretransfer_abort_failure_cannot_be_cancelled \
  tests/runtime/test_fixture_executor.py::test_fixture_pretransfer_abort_retry_success_can_be_cancelled -q
4 passed in 4.10s
```

Fresh covering ownership/runtime verification:

```text
uv run pytest \
  tests/agent_loop/test_context.py \
  tests/pipeline/test_pipeline_tool.py \
  tests/pipeline/test_pipeline_runner_resilience.py \
  tests/agent_loop/test_execution.py \
  tests/runtime/test_fixture_executor.py \
  tests/runtime/test_manager.py -q
140 passed in 34.70s
```

Fresh full backend verification:

```text
uv run ruff check app/ tests/ launcher.py
All checks passed!

uv run pytest
843 passed, 18 deselected in 73.17s
```
