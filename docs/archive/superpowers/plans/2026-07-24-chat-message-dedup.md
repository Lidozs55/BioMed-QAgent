# Chat Message Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent max-turn continuation from duplicating durable history and make the frontend render one logical user/assistant projection when durable messages and events overlap.

**Architecture:** Keep the durable session as the backend context owner and resume it with no new copied input. In the frontend reducer, rebuild hydrated message items from the complete ordered message projection, use `user:${runId}` as the user identity, prefer `assistant:${streamId}` event items per run, and retain hydrated assistant items only for runs without events.

**Tech Stack:** Python 3.12, FastAPI runtime, OpenAI Agents SDK, pytest, React 19, TypeScript, Zustand-style pure reducer, Vitest.

## Global Constraints

- Work only in `D:\coding\BioMed-QAgent\.worktrees\fix-chat-message-dedup` on branch `fix/chat-message-dedup`.
- Write and run each regression test before changing its production code.
- Keep complete durable `messages` for pagination and audit; deduplicate only rendered conversation `items`.
- Do not compare message text, rewrite historical JSONL, or change `MessageRecord` and event API schemas.
- Preserve message-only legacy tasks that have no assistant events.
- Use `uv` from `backend/` and `pnpm` from `frontend/`.

---

## File Structure

- Modify `backend/tests/agent_loop/test_max_turns_continue.py`: prove an approved continuation sends no copied prior input to the second SDK invocation.
- Modify `backend/app/agent_loop/runner.py`: resume the existing durable session with an empty new-input list.
- Modify `frontend/src/test/runtime-reducer.test.ts`: cover canonical user identity, both event/hydration arrival orders, and legacy fallback.
- Modify `frontend/src/runtime/reducer.ts`: reconcile rendered items by run and stream identity.
- Modify `docs/superpowers/specs/2026-07-24-chat-message-dedup-design.md`: mark the reviewed design accepted after implementation verification.

### Task 1: Stop max-turn history re-append

**Files:**
- Modify: `backend/tests/agent_loop/test_max_turns_continue.py`
- Modify: `backend/app/agent_loop/runner.py:684-745`

**Interfaces:**
- Consumes: `Runner.run_streamed(agent, input, *, context, session, max_turns)`.
- Produces: the second max-turn continuation invocation receives `[]` while reusing the prepared durable session.

- [ ] **Step 1: Make the approve-path test capture SDK inputs**

Add an `agent_inputs` list next to `call_count`, capture `args[1]`, and assert
the exact two invocation inputs:

```python
    call_count = 0
    agent_inputs: list[str | list[object]] = []

    def run_streamed(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        agent_inputs.append(args[1])
        context = kwargs["context"]
        if call_count == 1:
            return _MaxTurnsResult(context)
        return _SuccessResult(context, output_dir)
```

After `assert call_count == 2`, add:

```python
        assert agent_inputs == ["max_turns approve path", []]
```

Update the module and test docstrings so they describe reuse of the durable
session with empty new input rather than `result.to_input_list()`.

- [ ] **Step 2: Run the backend regression and verify RED**

Run from `backend/`:

```powershell
uv run pytest tests/agent_loop/test_max_turns_continue.py::test_max_turns_exceeded_emits_prompt_and_resumes_on_approve -q
```

Expected: FAIL because the second element is the list returned by
`_MaxTurnsResult.to_input_list()` instead of `[]`.

- [ ] **Step 3: Implement the minimal backend fix**

Replace the continuation assignment and its stale comments:

```python
            # Agent loop: each Runner invocation consumes up to max_turns.
            # A max-turn approval resumes the same durable Session without
            # appending its already-persisted history as new input.
```

```python
                    # The durable Session already owns the completed history.
                    # Passing result.to_input_list() here would append that
                    # history again and create duplicate MessageRecords.
                    agent_input = []
                    continue
```

- [ ] **Step 4: Run the focused backend suite and verify GREEN**

Run from `backend/`:

```powershell
uv run pytest tests/agent_loop/test_max_turns_continue.py -q
```

Expected: `4 passed` after the new assertion is represented as its own test,
or `3 passed` if it remains in the existing approve-path test.

- [ ] **Step 5: Commit the backend invariant**

```powershell
git add backend/app/agent_loop/runner.py backend/tests/agent_loop/test_max_turns_continue.py
git commit -m "fix: avoid replaying session history after max turns"
```

### Task 2: Reconcile hydrated and event-backed conversation items

**Files:**
- Modify: `frontend/src/test/runtime-reducer.test.ts`
- Modify: `frontend/src/runtime/reducer.ts:659-718`
- Modify: `frontend/src/runtime/reducer.ts:1130-1175`

**Interfaces:**
- Consumes: ordered `TaskProjection.messages`, event-backed
  `AssistantSegmentItem.streamId`, `ProjectedMessage.runId`.
- Produces: canonical user item IDs `user:${runId}` and per-run precedence for
  event-backed `assistant:${streamId}` items over hydrated fallbacks.

- [ ] **Step 1: Add four reducer regression cases**

Place the cases next to the existing snapshot/live replacement test.

Duplicate durable users collapse by run while the message records remain:

```typescript
  it("renders duplicate durable user records once per run", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_duplicate_user",
        [
          message("task_duplicate_user", 1, {
            messageId: "user_first",
            runId: "run_duplicate",
            content: "question",
          }),
          message("task_duplicate_user", 57, {
            messageId: "user_replayed",
            runId: "run_duplicate",
            content: "question",
          }),
        ],
        null,
      ),
    );

    const task = state.tasksById.task_duplicate_user;
    expect(task.messages).toHaveLength(2);
    expect(task.items.filter((item) => item.kind === "user_message")).toEqual([
      expect.objectContaining({
        itemId: "user:run_duplicate",
        content: "question",
        sequence: 1,
      }),
    ]);
  });
```

Event replay before hydration keeps only the stream-backed assistant item:

```typescript
  it("prefers event assistant segments when events arrive before hydration", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_event_first", "running")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_event_first", "run_event_first", 1, {
        type: "assistant_delta",
        delta: "answer",
        stream_id: "stream_event_first",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = hydrateTaskSnapshot(
      state,
      taskSnapshot(
        "task_event_first",
        [
          message("task_event_first", 2, {
            messageId: "durable_assistant",
            runId: "run_event_first",
            role: "assistant",
            content: "answer",
          }),
        ],
        null,
        1,
      ),
    );

    expect(
      state.tasksById.task_event_first.items.filter(
        (item) => item.kind === "assistant_segment",
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "assistant:stream_event_first",
        streamId: "stream_event_first",
        content: "answer",
      }),
    ]);
  });
```

Hydration before event replay evicts the fallback:

```typescript
  it("evicts hydrated assistant fallback when its event arrives later", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_hydrate_first",
        [
          message("task_hydrate_first", 2, {
            messageId: "durable_assistant",
            runId: "run_hydrate_first",
            role: "assistant",
            content: "answer",
          }),
        ],
        null,
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_hydrate_first", "run_hydrate_first", 1, {
        type: "assistant_delta",
        delta: "answer",
        stream_id: "stream_hydrate_first",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );

    expect(
      state.tasksById.task_hydrate_first.items.filter(
        (item) => item.kind === "assistant_segment",
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "assistant:stream_hydrate_first",
        streamId: "stream_hydrate_first",
        content: "answer",
      }),
    ]);
  });
```

Message-only legacy history remains visible:

```typescript
  it("keeps hydrated assistant fallback when a run has no assistant events", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_legacy_assistant",
        [
          message("task_legacy_assistant", 2, {
            messageId: "legacy_assistant",
            runId: "run_legacy",
            role: "assistant",
            content: "legacy answer",
          }),
        ],
        null,
      ),
    );

    expect(
      state.tasksById.task_legacy_assistant.items.filter(
        (item) => item.kind === "assistant_segment",
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "msg:legacy_assistant",
        streamId: "hydrate:legacy_assistant",
        content: "legacy answer",
      }),
    ]);
  });
```

- [ ] **Step 2: Run the frontend regressions and verify RED**

Run from `frontend/`, prepending the bundled Node directory to `PATH` when the
desktop shell does not expose `node`:

```powershell
$nodeRuntimeBin = 'C:\Users\cheng\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$env:Path = "$nodeRuntimeBin;$env:Path"
pnpm exec vitest run src/test/runtime-reducer.test.ts
```

Expected: three new reconciliation cases fail. The legacy fallback case passes,
demonstrating backward compatibility before the fix.

- [ ] **Step 3: Canonicalize hydrated user identity and rebuild fallbacks**

Change the user projection:

```typescript
  if (message.role === "user") {
    return {
      kind: "user_message",
      itemId:
        message.runId === null
          ? `msg:${message.messageId}`
          : `user:${message.runId}`,
      runId,
      sequence,
      createdAt: message.createdAt,
      content: message.content,
    };
  }
```

Replace incremental hydrated-item projection with a rebuild from the complete
ordered `task.messages` collection:

```typescript
function mergeMessagesIntoItems(task: TaskProjection): TaskProjection {
  const userRunIds = new Set(
    task.messages
      .filter(
        (message): message is ProjectedMessage & { runId: string } =>
          message.role === "user" && message.runId !== null,
      )
      .map((message) => message.runId),
  );
  const eventAssistantRunIds = new Set(
    task.items
      .filter(
        (item): item is AssistantSegmentItem =>
          item.kind === "assistant_segment" &&
          !item.streamId.startsWith("hydrate:"),
      )
      .map((item) => item.runId),
  );
  const items = task.items.filter((item) => {
    if (item.kind === "user_message" && userRunIds.has(item.runId)) {
      return false;
    }
    return !(
      item.kind === "assistant_segment" &&
      item.streamId.startsWith("hydrate:")
    );
  });
  let next = items.length === task.items.length ? task : { ...task, items };
  const projectedUserRunIds = new Set<string>();

  for (const message of task.messages) {
    if (message.role === "user" && message.runId !== null) {
      if (projectedUserRunIds.has(message.runId)) continue;
      projectedUserRunIds.add(message.runId);
    }
    if (
      message.role === "assistant" &&
      message.runId !== null &&
      eventAssistantRunIds.has(message.runId)
    ) {
      continue;
    }
    const item = projectMessageToItem(message);
    if (item !== null) next = upsertItem(next, item);
  }
  return next;
}
```

Add `AssistantSegmentItem` to the existing type-only import from `./types`.
Change both `mergeMessagesIntoItems` callers to pass only the merged task.

- [ ] **Step 4: Evict hydrated assistant items on event arrival**

Add a focused helper:

```typescript
function withoutHydratedAssistantItems(
  task: TaskProjection,
  runId: string,
): TaskProjection {
  const items = task.items.filter(
    (item) =>
      !(
        item.kind === "assistant_segment" &&
        item.runId === runId &&
        item.streamId.startsWith("hydrate:")
      ),
  );
  return items.length === task.items.length ? task : { ...task, items };
}
```

Apply it before the durable delta core:

```typescript
  const reconciledTask = withoutHydratedAssistantItems(task, runId);
  const nextTask = applyDurableAssistantDeltaCore(
    reconciledTask,
    runId,
    payload,
    envelope,
  );
  if (nextTask === reconciledTask) return reconciledTask;
```

- [ ] **Step 5: Run the focused frontend suite and verify GREEN**

Run from `frontend/`:

```powershell
pnpm exec vitest run src/test/runtime-reducer.test.ts
```

Expected: all reducer tests pass, including the four new cases.

- [ ] **Step 6: Commit frontend reconciliation**

```powershell
git add frontend/src/runtime/reducer.ts frontend/src/test/runtime-reducer.test.ts
git commit -m "fix: reconcile chat items by run and stream ids"
```

### Task 3: Verify the complete fix and close the design

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-chat-message-dedup-design.md`

**Interfaces:**
- Consumes: completed backend and frontend regression behavior.
- Produces: fresh quality-gate evidence and an accepted design status.

- [ ] **Step 1: Run focused regression suites**

From `backend/`:

```powershell
uv run pytest tests/agent_loop/test_max_turns_continue.py -q
```

From `frontend/`:

```powershell
pnpm exec vitest run src/test/runtime-reducer.test.ts
```

Expected: both commands exit 0.

- [ ] **Step 2: Run backend quality gates**

From `backend/`:

```powershell
uv run pytest
uv run ruff check app/ tests/ launcher.py
```

Expected: no failures and no Ruff diagnostics.

- [ ] **Step 3: Run backend startup smoke**

Use the verified Windows template in `docs/DEVELOPER_QUICKSTART.md` §4.1 with
the worktree's `backend\.venv\Scripts\python.exe`, a free non-default port, and
a `finally` block that terminates the exact Uvicorn process.

Expected: `/api/v1/health` returns HTTP 200 before cleanup.

- [ ] **Step 4: Run frontend quality gates**

From `frontend/` with bundled Node on `PATH`:

```powershell
pnpm lint
pnpm tsc
pnpm build
pnpm test
```

Expected for completion: lint, type check, and build exit 0. Compare any full
test failures with the recorded baseline; the targeted reducer suite must
remain green and no new failure may be introduced.

- [ ] **Step 5: Browser-verify the original symptom**

Run or point the already-started frontend/backend services at the fixed
worktree, reload `http://localhost:5173/`, select the reproduced task, and
inspect the message log.

Expected:

- one rendered user prompt for `run_id`;
- one copy of each event-backed assistant stream;
- no duplicated hydrated assistant fallback;
- a legacy message-only task still renders its assistant response.

- [ ] **Step 6: Mark the design accepted and commit verification state**

Change the design header:

```markdown
**Status:** Accepted and implemented
```

Then commit:

```powershell
git add docs/superpowers/specs/2026-07-24-chat-message-dedup-design.md
git commit -m "docs: mark chat deduplication design implemented"
```

- [ ] **Step 7: Rebase, rerun mandatory gates, and merge**

Follow `AGENTS.md` branch workflow: rebase onto `origin/main`, rerun the
mandatory quality gates, merge the complete functional unit to `main`, and
sync TASK-028 plus the Commonly `[DONE]` message with exact verification
counts.
