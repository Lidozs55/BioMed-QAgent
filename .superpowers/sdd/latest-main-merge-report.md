# Latest Main Semantic Merge Report

Date: 2026-07-17

## Revisions

- Branch / pre-merge HEAD: `codex/agent-runtime-concurrency-merge` / `8cf1caa`
- Merged main / merge base: `092a01e` / `eef0487`
- HEAD contained `b0baff3` and `8cf1caa`; `fe84eb2` was already in `092a01e`.
- `origin/main` later advanced to `dbab665`, but `MERGE_HEAD` stayed at
  `092a01e`; the newer revision is not part of this commit.

## Conflict resolutions

Exactly the three preflight conflicts were resolved:

1. `AGENTS.md`: kept the `092a01e` main version.
2. `backend/app/pipeline/stages/validation.py`: kept the branch compatibility
   wrapper delegating to `_publish_artifacts_core(...)`; no second publication
   algorithm was restored.
3. `frontend/src/components/BackgroundTaskNotifications.tsx`: retained the
   exact `useAgentStore.subscribe` transition observation and local deduplication,
   while using main's `isActiveStatus`. R5 rejected View handling was not added.

## Semantic audit

- `backend/app/runtime/manager.py` retained R4b paired commit/abort ownership,
  sealing, abort-before-terminalization, event ordering, and late-cancel rules.
- `backend/app/runtime/session.py` is unchanged from the pre-merge branch and
  retains legacy SDK input preservation, replay, and deduplication behavior.
- `backend/app/pipeline/stages/artifact_build.py` retains the live/fixture
  `source_asset.relative_path` behavior and main's explanatory comment.
- Main's startup `load_database_skills`, `fileUtils`, `isActiveStatus`, WebSocket
  error toast, docs/TODO, and cleanup changes are present.
- No `awaiting_user_input` runtime/status or R5 behavior was added.

## Merge hygiene

- No unmerged index entries remain.
- `git diff --cached --check` passes.
- Stripped 77 trailing-whitespace lines from main's `docs/TODO.md` without
  semantic changes so `git diff --cached --check` passes.

## Focused verification

Backend commands were run from `backend/`:

```text
uv run pytest tests/agent_loop/test_context.py tests/agent_loop/test_execution.py tests/pipeline/test_pipeline_tool.py tests/pipeline/test_pipeline_runner_resilience.py tests/pipeline/test_pipeline_runner_recovery.py tests/pipeline/test_publish_lock.py tests/pipeline/test_event_coverage.py tests/pipeline/test_task_cancellation.py tests/runtime/test_fixture_executor.py tests/runtime/test_manager.py tests/runtime/test_session.py -q
219 passed in 53.73s

uv run pytest tests/pipeline/test_pinned_pipeline.py tests/pipeline/test_pipeline_e2e.py -q
11 passed in 6.39s
```

Frontend focused tests could not execute because of the local dependency-link
state, not because of a Vitest assertion failure:

```text
pnpm test -- src/test/runtime-controller.test.ts src/test/session-sidebar.test.tsx src/test/agent-stream.test.ts src/test/store.test.ts
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

`CI=true` began recreating `node_modules` and was terminated. Direct local
Vitest execution then failed before collecting tests because internal dependency
links were absent:

```text
ERR_MODULE_NOT_FOUND: Cannot find package '@vitest/utils'
```

No frontend assertions ran. The main thread will restore dependencies offline
and rerun the focused suites. No full build, push, main checkout, or R5 work was
performed.
