# Task 2 Report: Durable Runtime Persistence And Pagination

## Status

Implemented durable task events, SDK session history, atomic snapshots and
conversation summaries, a rebuildable SQLite task index, idempotent request
registration, and cursor-based task/message pagination. Review regressions for
JSONL integrity, replay validation, ordering, append complexity, path safety,
and Settings wiring are included.

## Implementation

- Added per-task `events.jsonl` persistence with task-local contiguous sequence
  validation, task identity validation, torn-tail recovery, and durable fsync.
- Added a bounded tail inspector plus file-signature checkpoints. Normal event
  appends do not full-scan the journal; a cold or externally changed journal is
  fully validated once before the checkpoint is trusted.
- Preserved complete JSON records that lack a final newline by inserting the
  missing delimiter before append. Only an unterminated malformed final record
  is recoverable; newline-terminated corruption is rejected.
- Added `DurableTaskSession`, preserving full raw SDK items with add/get/pop/
  clear behavior, immutable message ordinals, opaque task-bound cursors, and
  committed-operation validation.
- Added a signature-invalidated replay cache so repeated session appends avoid
  quadratic full journal replay. Returned SDK items are defensively copied.
- Added atomic task snapshot and conversation-summary replacement, event-based
  snapshot recovery, latest-100 message hydration, and older-message cursors.
- Added a WAL-mode SQLite index on a dedicated single-thread executor for task
  summaries, pagination metadata, and request idempotency.
- Kept every active task on every history page while globally sorting the
  active-plus-inactive union by `(created_at DESC, task_id DESC)`. The cursor
  advances only through inactive history.
- Wired task page default/max and message page size through `Settings`, with
  custom Settings propagated by `TaskRepository` and `TaskIndex`.
- Required `TaskRepository.record_request` to match an already-authoritative
  task/run/request triple in the persisted snapshot before updating SQLite.
  Rebuild can therefore reconstruct accepted requests from task files.

## TDD Evidence

### Baseline

Command:

`uv run pytest tests/runtime/test_event_store.py tests/runtime/test_repository.py tests/runtime/test_index.py tests/runtime/test_session.py`

Observed before new regressions: `20 passed in 1.79s`.

### RED: Integrity, Ordering, Settings, And Complexity

The same focused command collected 33 tests and observed `12 failed, 21 passed`.
The failures reproduced:

- complete newline-less EventStore and Session records being concatenated;
- replay accepting the wrong task ID and start/gap/duplicate sequences;
- 82 full scans for 41 EventStore appends and 25 scans for 25 Session appends;
- active rows being placed ahead of newer inactive history;
- TaskIndex/TaskRepository rejecting injected Settings;
- `..` being accepted as a session ID.

### RED: Cache Isolation

`uv run pytest tests/runtime/test_session.py::test_session_cache_does_not_expose_mutable_items -q`

Observed: `1 failed`; mutating a returned item changed the cached session view.

### RED: Repository Append Complexity

`uv run pytest tests/runtime/test_repository.py::test_repository_event_appends_do_not_replay_a_current_journal -q`

Observed: `1 failed`; 21 current-journal appends caused 21 full scans.

### RED: Review Integrity Regressions

The four focused review regressions observed `4 failed`:

- newline-terminated malformed EventStore record was silently discarded;
- newline-terminated malformed Session record was not reported as JSONL
  corruption;
- an unpublished request reservation disappeared after reopen/rebuild;
- an externally corrupted interior event bypassed the tail checkpoint.

An additional Session regression observed `1 failed` because an incomplete
committed `clear` operation silently cleared history.

The final idempotency authorization regression observed `1 failed` because
`TaskRepository.record_request` accepted a missing task and mismatched run/
request values before checking authoritative state.

### GREEN: Focused Task 2

Command:

`uv run pytest tests/runtime/test_event_store.py tests/runtime/test_repository.py tests/runtime/test_index.py tests/runtime/test_session.py`

Observed: `41 passed in 3.31s`.

### GREEN: Task 1 Compatibility And Config

Command:

`uv run pytest tests/contracts/test_runtime_contracts.py tests/runtime/test_state_reducer.py tests/contracts/test_event_contracts.py tests/test_config.py`

Observed: `71 passed in 0.20s`.

### GREEN: Full Backend

Command: `uv run pytest`

Observed: `334 passed, 1 deselected, 1 warning in 22.39s`. The warning is the
existing Starlette `httpx` deprecation warning from the test environment.

### Static Verification

- Focused Ruff check: `All checks passed!`
- Focused Ruff format check: `9 files already formatted`

## Files

- `backend/app/config.py`
- `backend/app/runtime/event_store.py`
- `backend/app/runtime/index.py`
- `backend/app/runtime/repository.py`
- `backend/app/runtime/session.py`
- `backend/tests/runtime/test_event_store.py`
- `backend/tests/runtime/test_index.py`
- `backend/tests/runtime/test_repository.py`
- `backend/tests/runtime/test_session.py`

## Review And Residual Concerns

- Repository request registration is intentionally rejected until the matching
  task/run/request exists in the authoritative snapshot. This removes the
  pre-publication SQLite-only reservation window and keeps deletion/rebuild of
  the index safe for repository consumers.
- `atomic_write_text` fsyncs file contents before `os.replace`. It does not
  additionally fsync the containing directory on POSIX; Windows is the target
  environment for this worktree.
- The full suite reports one pre-existing Starlette deprecation warning.
