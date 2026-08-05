# Chat Message Deduplication Design

**Date:** 2026-07-24
**Status:** Accepted and implemented
**Scope:** TASK-028

## 1. Problem

The chat transcript can render the same user prompt and assistant output more
than once. The observed task
`task_95c86a38-6898-4c5f-b31c-4fd9c60a5fa3` contained both persistent
duplicates and duplicate frontend projections:

- the original user message appeared at durable message ordinals 1 and 57;
- assistant messages appeared in repeated pairs at ordinals 35/90, 39/94,
  46/101, 50/105, and 54/109;
- the repeated durable records were created when the run reached its turn
  limit, emitted `user_input_required` at event sequence 2258, and resumed
  after approval at sequence 2259;
- after reload, the frontend also projected hydrated `MessageRecord` objects
  and replayed `assistant_delta` events as separate conversation items.

This is one visible symptom with two independent causes. Fixing only one layer
would leave either newly persisted duplicates or duplicates in existing task
history.

## 2. Existing Identities

The system already has useful IDs, but they do not currently form one
reconciliation contract:

- `MessageRecord.message_id` is a UUID generated for each persistence write.
  Two writes of the same logical message therefore have different IDs.
- `MessageRecord.run_id` identifies the user turn that owns a message.
- `assistant_delta.stream_id` identifies one streamed assistant segment.
- live user items use `user:${runId}`;
- replayed assistant items use `assistant:${streamId}`;
- hydrated items currently use `msg:${messageId}`, and hydrated assistant
  segments use a synthetic `hydrate:${messageId}` stream ID.

`message_id` remains the durable record identity. It is not suitable by itself
for logical deduplication.

## 3. Decision

Apply a dual-layer, ID-based fix:

1. Stop the backend from appending the completed prior turn as new SDK input
   when a max-turn pause is approved.
2. Reconcile frontend event and message projections using the stable `run_id`
   and `stream_id` identities that already exist.

Do not use message content as an identity and do not rewrite historical event
or session files.

## 4. Backend Change

`AgentLoopRunner` continues to reuse the same durable task session after a
`MaxTurnsExceeded` pause. After approval, the next SDK invocation must receive
an empty new-input list:

```python
agent_input = []
```

The durable session already contains the prior user input, assistant outputs,
tool calls, and tool outputs. Passing `result.to_input_list()` again tells the
Agents SDK to append that complete history as new input, even if the SDK can
deduplicate the model-facing prompt. That second append is what creates new
`MessageRecord` IDs and repeated history.

The existing preflight budget calculation continues to account for the
session's stored history. The runner therefore preserves context without
re-submitting it as new input.

### Backend invariants

- The original user input is added to the durable session once.
- Approving a max-turn continuation creates another SDK invocation but adds no
  copied prior input.
- New assistant/tool output from the resumed invocation is still persisted.
- Rejecting or cancelling the continuation retains current behavior.
- Multiple approved continuations remain supported.

## 5. Frontend Reconciliation

The task projection keeps the complete paginated `messages` collection for
transport and audit purposes. Deduplication applies only to rendered
conversation `items`.

### 5.1 User messages

A rendered user turn has the canonical item ID `user:${runId}`.

When hydrated messages contain more than one user record for the same run, the
reducer renders one user item. The lowest-ordinal durable record is retained as
the authoritative content and timestamp. Hydration updates or replaces the
live optimistic item with the same canonical ID.

### 5.2 Assistant messages

Event-backed assistant segments are authoritative for a run whenever at least
one `assistant:${streamId}` item exists for that run.

- If events are replayed before messages are hydrated, hydrated assistant
  records for that run are not projected.
- If messages are hydrated before an assistant event arrives, the first
  event-backed assistant segment removes all `hydrate:${messageId}` assistant
  items for that run before applying the delta.
- Further hydrated pages must not reintroduce fallback assistant items for a
  run that already has event-backed assistant segments.
- If a legacy task has no assistant events for a run, its hydrated assistant
  records continue to render using `msg:${messageId}` item IDs and
  `hydrate:${messageId}` stream IDs.

This rule does not attempt to match assistant text. One run may legitimately
contain multiple event-backed assistant segments, each distinguished by its
`stream_id`.

### 5.3 Ordering

The reducer must converge to the same rendered items for both supported
arrival orders:

1. replay events, then hydrate the snapshot and message pages;
2. hydrate messages, then receive live or replayed events.

No controller ordering assumption is required for correctness.

## 6. Compatibility and Non-Goals

- Existing contaminated tasks display correctly after reload without modifying
  their stored JSONL data.
- Older tasks that have messages but no assistant events remain readable.
- `MessageRecord` and public API schemas do not change in this fix.
- Introducing a future `logical_message_id` or `source_stream_id` field remains
  possible, but is not required to repair the current invariant.
- This change does not globally collapse equal text. Repeated text in different
  runs is legitimate and must remain visible.
- This change does not delete duplicate durable records already on disk.

## 7. Test Strategy

### Backend regression

Extend the max-turn continuation test with a session-aware fake SDK runner:

1. persist the original user input and first assistant output;
2. raise `MaxTurnsExceeded`;
3. approve continuation;
4. capture the second SDK invocation input and persist its new assistant
   output;
5. assert that the second input is `[]`;
6. assert the durable message page contains the logical user and prior
   assistant output once.

The test must fail against the current `result.to_input_list()` behavior before
the production change is made.

### Frontend regressions

Add reducer tests for:

1. duplicate hydrated user records with one `run_id` produce one
   `user:${runId}` item;
2. event-first hydration keeps event assistant items and omits hydrated
   assistant fallbacks;
3. hydration-first event arrival removes hydrated assistant fallbacks;
4. a legacy message-only assistant record remains visible.

The new cases must fail before reducer changes and pass afterward.

## 8. Alternatives Rejected

### Backend-only fix

It prevents future durable corruption but does not repair already persisted
tasks or the separate event/message double projection.

### Deduplicate by `message_id`

Duplicate persistence writes generate new UUIDs, so record identity cannot
represent logical identity.

### Deduplicate by content

Equal text can be legitimate across separate turns or assistant segments.
Content matching would hide valid conversation data and remains sensitive to
stream chunking.

### Migrate historical JSONL

A migration would be destructive, harder to validate, and unnecessary because
the frontend can reconcile historical records without changing the source log.

## 9. Risks and Verification

The main risk is hiding legacy assistant messages when event coverage is
partial. The rule is intentionally scoped per run: only runs with at least one
event-backed assistant segment suppress hydrated assistant fallbacks. Tests
cover both event/message arrival orders and the no-event compatibility path.

Verification requires:

- targeted backend and frontend regression suites;
- full backend pytest and Ruff checks;
- backend startup smoke;
- frontend lint, type check, build, and tests;
- browser verification against the reproduced task using services started from
  the fixed worktree or an equivalent build.
