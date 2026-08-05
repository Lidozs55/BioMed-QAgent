# Main Test Suite Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the approved realtime assistant stream implementation without losing reasoning or IMPORT functionality, and update the exhaustive runtime payload test fixture.

**Architecture:** Reconstruct `_AssistantTextBuffer` and its lifecycle calls from the last good implementation immediately before `0f32c50`, then layer the reasoning-delta extraction introduced by that commit back on top. Treat the contract failure separately as a missing exhaustive test sample; production event contracts remain unchanged.

**Tech Stack:** Python 3.12, asyncio, FastAPI runtime contracts, OpenAI Agents SDK stream events, pytest with strict asyncio mode, Ruff, uv.

## Global Constraints

- Modify only `backend/app/agent_loop/runner.py` and `backend/tests/contracts/test_runtime_contracts.py` unless a failing test proves another file is required.
- Do not weaken or delete assertions in `backend/tests/agent_loop/test_execution.py`.
- Preserve `AssistantReasoningDeltaPayload`, `_extract_reasoning_delta`, Responses API text extraction, IMPORT dispatch, attachment parsing, `_build()`, and `_max_turns()`.
- Preserve live-first publication, durable chunk ranges, idempotent segment ends, UTF-8 boundary validation, and cancellation-safe durable writes.
- Every production change must be preceded by a failing test run demonstrating the regression.
- Backend commands run from `backend/` using `uv`.

---

### Task 1: Restore realtime assistant text-buffer semantics

**Files:**
- Modify: `backend/app/agent_loop/runner.py:20-540`
- Test unchanged: `backend/tests/agent_loop/test_execution.py`

**Interfaces:**
- Consumes: `RunExecution.emit(payload)` and `RunExecution.emit_assistant_stream(frame)`.
- Produces: `_AssistantTextBuffer(execution: RunExecution, *, max_bytes: int = 1024, flush_interval: float = 0.1)` with `add`, `flush`, `end`, and `seconds_until_flush`.
- Produces durable `AssistantDeltaPayload(delta, stream_id, from_chunk_index, through_chunk_index)` and live `AssistantStreamDeltaFrame` / `AssistantStreamEndFrame`.

- [ ] **Step 1: Record the existing RED state**

Run:

```powershell
uv run pytest tests/agent_loop/test_execution.py -q
```

Expected: exactly 22 failures showing missing `end()`, incorrect constructor use, absent stream metadata, lost live frames, and cancellation/lifecycle failures.

- [ ] **Step 2: Restore the buffer state model**

Reintroduce these fields from the pre-`0f32c50` implementation:

```python
if max_bytes < 1:
    raise ValueError("max_bytes must be positive")
self._execution = execution
self._base_stream_id = f"assistant:{execution.run_id}"
self._segment_index = 0
self._stream_id = self._base_stream_id
self._next_chunk_index = 0
self._from_chunk_index: int | None = None
self._through_chunk_index: int | None = None
self._segment_active = False
self._has_ended = False
```

Remove the bare `emit` callback field; the buffer needs the complete execution object.

- [ ] **Step 3: Restore UTF-8 chunking and live-first publication**

Implement `_split_delta` so no chunk exceeds `max_bytes`, reject a code point wider than the limit, rotate stream IDs after an ended segment, emit one `AssistantStreamDeltaFrame` per chunk before buffering it, and flush when the durable batch reaches the configured byte limit.

- [ ] **Step 4: Restore durable confirmation semantics**

`flush()` must build an `AssistantDeltaPayload` with exact chunk range, run `execution.emit(...)` in a shielded task, clear the batch only after confirmed success, retain it after ordinary failure, and avoid re-appending after cancellation that arrives after commit.

- [ ] **Step 5: Restore segment end semantics**

Implement:

```python
async def end(self, finish_reason: str) -> None:
    if not self._segment_active and self._has_ended:
        return
    await self.flush()
    await self._execution.emit_assistant_stream(
        AssistantStreamEndFrame(
            task_id=self._execution.task_id,
            run_id=self._execution.run_id,
            stream_id=self._stream_id,
            last_chunk_index=self._next_chunk_index - 1 if self._next_chunk_index else None,
            finish_reason=finish_reason,
        )
    )
    self._segment_active = False
    self._has_ended = True
```

- [ ] **Step 6: Restore lifecycle calls without removing reasoning**

Construct the buffer as `_AssistantTextBuffer(execution)`. In `_consume_events`, retain reasoning extraction, but call `end(finish_reason)` for response completion, `end("tool_call")` before tool events, and `end("stop" | "max_turns" | "error" | "cancelled")` at iterator and exception boundaries. In `__call__`, close the stream for preparation failure/cancellation as well as normal completion.

- [ ] **Step 7: Verify Task 1 GREEN**

Run:

```powershell
uv run pytest tests/agent_loop/test_execution.py -q
```

Expected: all tests pass with no warnings.

- [ ] **Step 8: Commit Task 1**

```powershell
git add backend/app/agent_loop/runner.py
git commit -m "fix: restore realtime assistant stream lifecycle"
```

---

### Task 2: Update exhaustive reasoning payload contract fixture

**Files:**
- Modify: `backend/tests/contracts/test_runtime_contracts.py:1-75`
- Production contract unchanged: `backend/app/domain/contracts/events.py`

**Interfaces:**
- Consumes: exported `AssistantReasoningDeltaPayload(delta: str)`.
- Produces: an exhaustive `RUNTIME_PAYLOADS` fixture containing one instance for every `RuntimeEventType` plus the two accepted pipeline payload types.

- [ ] **Step 1: Record the contract RED state**

Run:

```powershell
uv run pytest tests/contracts/test_runtime_contracts.py::test_all_runtime_payloads_are_discriminated_and_require_run_id -q
```

Expected: failure reports `ASSISTANT_REASONING_DELTA` as the extra enum item not represented by `RUNTIME_PAYLOADS`.

- [ ] **Step 2: Add the missing test fixture sample**

Import `AssistantReasoningDeltaPayload` from `app.domain.contracts` and insert:

```python
AssistantReasoningDeltaPayload(delta="internal reasoning"),
```

immediately after `AssistantDeltaPayload(...)` in `RUNTIME_PAYLOADS`. Do not change production enums or unions.

- [ ] **Step 3: Verify Task 2 GREEN**

Run:

```powershell
uv run pytest tests/contracts/test_runtime_contracts.py -q
```

Expected: all contract tests pass.

- [ ] **Step 4: Commit Task 2**

```powershell
git add backend/tests/contracts/test_runtime_contracts.py
git commit -m "test: cover reasoning runtime payload"
```

---

### Task 3: Full verification and branch completion

**Files:**
- Modify only if verification identifies a regression directly caused by Tasks 1 or 2.

**Interfaces:**
- Produces a backend suite with zero failures and a startable FastAPI application.

- [ ] **Step 1: Run the complete backend suite**

```powershell
uv run pytest
```

Expected: all selected tests pass; no warnings are promoted to errors.

- [ ] **Step 2: Run Ruff**

```powershell
uv run ruff check app/ tests/ launcher.py
```

Expected: `All checks passed!`.

- [ ] **Step 3: Verify application startup**

Clear only `backend/**/__pycache__`, start:

```powershell
uv run uvicorn app.main:app --reload
```

Expected: `Application startup complete.` Then stop the server cleanly.

- [ ] **Step 4: Review final diff**

Confirm `git diff main...HEAD` contains only the design/plan documents, the restored runner behavior, and the one contract test sample. Confirm reasoning and IMPORT code remains present.

- [ ] **Step 5: Prepare integration**

Use `finishing-a-development-branch` only after the full suite, Ruff, and startup checks pass.
