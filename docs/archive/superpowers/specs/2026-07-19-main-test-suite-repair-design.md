# Main Test Suite Repair Design

## Problem

`main` has 23 deterministic backend test failures:

- 22 failures in `backend/tests/agent_loop/test_execution.py`.
- 1 failure in `backend/tests/contracts/test_runtime_contracts.py`.

The failures appeared after commit `0f32c50` added folded reasoning events.
That commit correctly introduced `AssistantReasoningDeltaPayload`, but it also
replaced the established realtime assistant-stream buffer with an older,
simpler implementation.

## Root-cause classification

### Production-code regression

The 22 execution failures are implementation regressions. The tests describe
the realtime stream protocol implemented by earlier commits
`3f6338c`, `710a345`, `83d5955`, `a176f44`, and `826b842`:

- live chunks are published before their durable batch;
- chunks have stable stream IDs and monotonically increasing indexes;
- durable deltas identify the exact confirmed chunk range;
- stream segments end at finish, tool, exhaustion, error, cancellation, and
  compaction boundaries;
- failed or cancelled durable writes retain unconfirmed buffered text;
- a later text segment rotates to a new stream ID;
- buffer size validation respects UTF-8 code-point boundaries.

`0f32c50` removed those behaviors from production while leaving the approved
tests and surrounding runtime consumers intact. The tests must not be weakened
to match the regression.

### Stale test fixture

The runtime-contract failure is a test maintenance issue. Production defines,
exports, emits, discriminates, and consumes `AssistantReasoningDeltaPayload`.
The exhaustive `RUNTIME_PAYLOADS` fixture simply omitted one instance, so its
set no longer equals `RuntimeEventType`.

## Repair design

Restore the pre-`0f32c50` `_AssistantTextBuffer` and assistant-stream lifecycle
inside `backend/app/agent_loop/runner.py`, while retaining all later features:

- `AssistantReasoningDeltaPayload` extraction and durable emission;
- Responses API text-delta extraction;
- `AgentRunExecutor._build()` and `_max_turns()` extension points;
- IMPORT mode dispatch and attachment parsing behavior;
- current Qwen retry, compaction, cancellation, and pipeline integration.

The repaired buffer accepts a `RunExecution`, not a bare emitter, because it
needs both durable `execution.emit(...)` and live
`execution.emit_assistant_stream(...)` channels. `_consume_events` ends active
segments at every existing test-defined boundary. `AgentRunExecutor.__call__`
also closes the stream when failure or cancellation occurs before event
consumption starts, including compaction preparation.

The contract test will import `AssistantReasoningDeltaPayload` and add one
non-empty instance to `RUNTIME_PAYLOADS`. No production contract change is
required for that failure.

## Error and cancellation semantics

- Live-publish ordinary failures are logged without losing the durable answer.
- Live-publish cancellation remains observable and is not swallowed.
- Durable emission is shielded; if caller cancellation arrives after the
  durable commit, the confirmed batch is cleared exactly once.
- If durable emission fails before confirmation, buffered content remains for
  a later retry and no end frame is published prematurely.
- End frames are idempotent per segment and carry `stop`, `tool_call`,
  `max_turns`, `error`, or `cancelled` as appropriate.

## Files

- Modify `backend/app/agent_loop/runner.py` for the production regression.
- Modify `backend/tests/contracts/test_runtime_contracts.py` for the stale
  exhaustive fixture.
- Existing `backend/tests/agent_loop/test_execution.py` is the regression test
  suite and should not be weakened.

## Verification

1. Confirm the 23 failures on the unmodified branch.
2. Restore buffer/lifecycle behavior and run
   `uv run pytest tests/agent_loop/test_execution.py -q`.
3. Update only the contract fixture and run
   `uv run pytest tests/contracts/test_runtime_contracts.py -q`.
4. Run `uv run pytest` with zero failures.
5. Run `uv run ruff check app/ tests/ launcher.py` with zero findings.
6. Start `uv run uvicorn app.main:app --reload` and confirm application startup.

## Non-goals

- Redesigning the realtime protocol.
- Changing frontend stream reducers or WebSocket transport.
- Removing reasoning events.
- Importing unrelated commits wholesale from another branch.
- Refactoring unrelated AgentLoop, compaction, cache, or pipeline code.
