# HIL Delta Merge Report

Date: 2026-07-17

## Revisions

- Branch / pre-merge HEAD: `codex/agent-runtime-concurrency-merge` / `45f17a8`
- Merged revision: `origin/main` / `dbab665`
- HIL implementation commit: `9402398`

## Conflict decisions

- `backend/app/agent_loop/runner.py`: retained streamed event deduplication,
  deferred completion publication, and manager-owned abort cleanup; also wired
  `PipelineRunner.submit_user_input` into `RunExecution`.
- `backend/app/pipeline/runner.py`: retained pending-publication and recovery
  ownership while adding plan confirmation through `_await_user_input`.
  Corrected the HIL delta's un-awaited async event emissions for
  `plan_ready`, `user_input_required`, and `user_input_resumed`.
- `backend/app/runtime/manager.py`: kept completion commit/abort and cleanup-only
  state together with `UserInputSubmitter`, `resume_run`, and
  `AWAITING_USER_INPUT` recovery.
- `docs/TODO.md`: accepted main's completed HIL §4.2.1/§4.2.2 status without
  duplicating archived Phase 1F material.

## Scope

- Frontend HIL changes were accepted while the existing controller/reducer
  task-isolation and refresh-race fixes remained in place.
- No R5 UX work was added.
- Per instruction, no tests, lint, typecheck, build, or runtime startup were run.
  Merge verification was limited to unresolved-entry/conflict-marker checks and
  `git diff --check`.
