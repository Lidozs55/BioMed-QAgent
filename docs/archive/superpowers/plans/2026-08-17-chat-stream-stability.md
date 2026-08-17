# Chat Stream Stability and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a live conversation pinned to its newest content and reduce chat-stream CPU, disk-sync, replay, and render work without changing final text or event ordering.

**Architecture:** Coalesce adjacent Pi text/reasoning fragments before the durable runtime, batch cold event replay in one Zustand transaction per page, and memoize stable conversation rows. Keep shadcn `MessageScroller` as the sole scroll owner but remove turn anchoring that conflicts with bottom follow.

**Tech Stack:** Node.js 22.19+, TypeScript, React 19, Zustand, Vitest, shadcn/ui `MessageScroller`, pnpm.

## Global Constraints

- Use pnpm, never npm.
- Do not add dependencies or change wire DTOs.
- Preserve final assistant/reasoning text and event boundary ordering.
- Every production change requires a failing regression test first.
- Do not reintroduce manual scroll math, `ResizeObserver`, or a custom stick-to-bottom hook.

---

### Task 1: Restore live-edge scroll behavior and isolate stable rows

**Files:**
- Modify: `frontend/src/components/conversation/ConversationList.tsx`
- Test: `frontend/src/components/conversation/__tests__/ConversationList.test.tsx`

**Interfaces:**
- Consumes: `MessageScrollerItem`, immutable `ConversationItem` objects.
- Produces: memoized `ConversationListItem` rows with no `scrollAnchor` prop.

- [x] **Step 1: Write failing scroll and render-isolation tests**

Render a user item and assert the scroller item does not receive
`scrollAnchor=true`. Rerender a list after replacing only the active item and
assert a mocked `ConversationStep` renders the historical item once.

- [x] **Step 2: Verify the tests fail**

Run: `pnpm test -- src/components/conversation/__tests__/ConversationList.test.tsx`

Expected: the user row is anchored and the historical row renders twice.

- [x] **Step 3: Implement the minimal row boundary**

Create a local `memo`-wrapped row that renders `MessageScrollerItem` and
`ConversationStep`. Remove `scrollAnchor` from conversation rows.

- [x] **Step 4: Verify the tests pass**

Run: `pnpm test -- src/components/conversation/__tests__/ConversationList.test.tsx`

Expected: all conversation-list tests pass.

### Task 2: Coalesce Pi delta fragments before durable append

**Files:**
- Modify: `server/src/agent/pi-adapter.ts`
- Test: `server/tests/pi-adapter.test.ts`

**Interfaces:**
- Consumes: upstream `message_update` events.
- Produces: ordered `BioMedAgentEvent` values with adjacent same-kind deltas
  joined, maximum event text length 4,096, and maximum timer latency 32 ms.

- [x] **Step 1: Write failing coalescing and boundary tests**

Cover adjacent assistant fragments, adjacent reasoning fragments, timer flush,
type changes, tool start, completion, and cancellation. Assert concatenated
text and exact event order.

- [x] **Step 2: Verify the tests fail**

Run: `pnpm --filter @biomed/server test -- tests/pi-adapter.test.ts`

Expected: adjacent fragments are currently emitted as separate events.

- [x] **Step 3: Implement the bounded buffer**

Add a turn-local pending delta and timer. Flush before non-delta queue items,
on timer expiry, before exceeding 4,096 characters, and from `finish`.

- [x] **Step 4: Verify the tests pass**

Run: `pnpm --filter @biomed/server test -- tests/pi-adapter.test.ts`

Expected: all Pi adapter tests pass with fake timers restored after each test.

### Task 3: Batch cold event replay

**Files:**
- Modify: `frontend/src/stores/agentStore.ts`
- Modify: `frontend/src/runtime/controller.ts`
- Test: `frontend/src/test/runtime-controller.test.ts`
- Test: `frontend/src/test/store.test.ts`

**Interfaces:**
- Produces: `AgentStore.applyEvents(events: readonly EventEnvelope[]): SequenceGapMarker | null`.
- Consumes: ordered REST replay pages from `RuntimeController.replayEventsToSequence`.

- [x] **Step 1: Write failing transaction and replay tests**

Subscribe to the store, apply a three-event page, and require one notification
with the same final projection as three `reduceRuntimeEvent` calls. Require the
controller to call the batch action once per fetched page.

- [x] **Step 2: Verify the tests fail**

Run: `pnpm test -- src/test/store.test.ts src/test/runtime-controller.test.ts`

Expected: `applyEvents` is absent and replay calls `applyEvent` per event.

- [x] **Step 3: Implement batch reduction and page commit**

Reduce the ordered event array inside one Zustand `set`, return the final task
gap marker, and replace the controller's per-event loop with `applyEvents`.

- [x] **Step 4: Verify the tests pass**

Run: `pnpm test -- src/test/store.test.ts src/test/runtime-controller.test.ts`

Expected: all selected frontend tests pass.

### Task 4: Document, validate, commit, and push

**Files:**
- Modify: `docs/architecture/agent-frontend.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Records: live-edge semantics, 32 ms/4,096-character coalescing bounds, and
  page-level replay transactions.

- [x] **Step 1: Update authoritative documentation**

Add the completed work and the reason for each boundary without duplicating
implementation detail outside the frontend architecture section.

- [x] **Step 2: Run targeted performance regression checks**

Run the Pi adapter, conversation-list, store, and controller tests together.
Expected: all selected tests pass.

- [x] **Step 3: Run every quality gate**

Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
`uv run python database/bridge.py --self-test`,
`uv run pytest database/tests`, and `uv run ruff check database`.
Expected: every command exits 0.

- [x] **Step 4: Commit and push the review branch**

Commit with conventional messages, push `fix/chat-scroll-stability`, and leave
the branch unmerged for user review.
