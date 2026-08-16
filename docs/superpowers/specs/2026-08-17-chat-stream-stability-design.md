# Chat Stream Stability and Performance Design

## Problem and evidence

The reference task `task_ts_ba33c72a-0e28-4617-a18a-3bdd9321a1c2`
contains 10,661 durable events in a 3.85 MB `events.jsonl`. Of those,
5,453 are `assistant_delta` and 5,070 are `assistant_reasoning_delta`, while
the assistant deltas contain only 11,775 characters in total. Most durable
events therefore carry one or two characters.

Three independent costs compound:

1. `ConversationList` marks every user message as a `scrollAnchor`.
   `@shadcn/react` intentionally switches from `following-bottom` to
   `anchored-to-message` when a new anchored turn appears. Content resize then
   keeps restoring that user message instead of following the growing answer.
2. `PiBioMedAgentSession` forwards every upstream text/thinking fragment.
   `consumeRun` awaits `DurableTaskRepository.appendRunEvents` for each fragment,
   and every append opens, writes, syncs, and closes `events.jsonl`. This delays
   delivery and creates thousands of WebSocket frames and reducer updates.
3. Cold replay fetches events in pages but calls the Zustand `applyEvent`
   action once per event. A 3,000-event replay window can notify React 3,000
   times before hydration completes. Unchanged historical rows also render
   again whenever the active item changes.

## Decisions

### Bottom-follow semantics

The live conversation follows the newest content while the user remains at the
bottom. Explicit wheel, touch, or keyboard scrolling continues to release
auto-follow and exposes the existing jump-to-latest button. User messages are
not scroller anchors; anchoring a turn conflicts with the requested live-edge
behavior. Prepending older history remains protected by
`preserveScrollOnPrepend` in `MessageScrollerViewport`.

### Delta coalescing

The Pi adapter coalesces only adjacent deltas of the same kind. A buffer flushes
after 32 ms, before any non-delta boundary, when changing between reasoning and
assistant text, or before the 4,096-character event limit would be exceeded.
Completion, failure, cancellation, tool, and compaction boundaries always flush
first, preserving visible order and durable final text. This caps normal UI
updates near display refresh cadence without changing contracts or adding a
second source of truth.

The buffer lives in the Pi adapter rather than the repository. Repository
append ordering and durability remain general-purpose; deterministic core,
permission, HIL, progress, and terminal events retain immediate append behavior.

### Batched replay and render isolation

The store gains `applyEvents(events)` and reduces a page sequentially inside one
Zustand transaction. Sequence-gap semantics are identical to repeated
`applyEvent`, but React receives one notification per replay page. Live durable
events keep the existing single-event path.

Conversation rows are memoized at the `MessageScrollerItem` boundary. Existing
item objects are immutable and retain identity in the reducers, so historical
Markdown trees can be reused while only the changed live row renders.

## Alternatives rejected

- Replacing streaming Markdown with plain text would lower parsing cost but
  creates a visible format switch and does not address fsync or replay costs.
- Adding a separate realtime server protocol would duplicate a path already
  represented in frontend contracts and substantially expand this bug fix.
  Source coalescing delivers bounded latency with fewer durable events.
- Disabling `content-visibility` or browser scroll anchoring treats layout
  symptoms while leaving the explicit `scrollAnchor` mode conflict intact.

## Verification

- Unit tests prove adjacent deltas coalesce, the 32 ms timer flushes, and tool
  and terminal boundaries preserve ordering and full text.
- Store/controller tests prove page replay performs one store notification and
  converges to the same projection as individual reduction.
- Conversation tests prove user messages are not anchors and unchanged rows do
  not render when only the active row changes.
- Full workspace test, lint, typecheck, build, and database bridge gates run
  before the branch is pushed.

