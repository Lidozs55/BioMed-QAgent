# Runtime Documentation Sync Report

Date: 2026-07-17

## Scope

- Branch/base: `codex/agent-runtime-concurrency-merge` at `3a2da85`.
- Corrected `_await_user_input` to document
  `PipelineUserInputTimeoutError` without changing behavior.
- Synchronized `docs/ARCHITECTURE.md` §8/§9/§12 with the current durable
  REST/WS/event/session authority, HIL semantics, four-slot concurrency,
  Run-scoped frontend projections, and current verification evidence.
- Updated the related `docs/TODO.md` HIL status, archived verification counts,
  and completed review-fix entries while leaving §4.2.3 unchecked.

## Verification

| Command | Result |
| --- | --- |
| `uv run ruff check app/pipeline/runner.py` (from `backend/`) | PASS — `All checks passed!` |
| `git diff --check` | PASS — exit 0 |

The initial documentation task did not rerun broad gates. Final branch evidence
was subsequently refreshed: backend 867 passed / 18 deselected plus Ruff and
startup health; frontend 14 files / 188 tests plus ESLint, TypeScript, and
production build; desktop/mobile browser QA covered backend history startup,
fixture completion, final-artifact reachability, reduced-height setup scrolling,
and long-title control layout.

## Worktree hygiene

The pre-existing generated `frontend/tsconfig.app.tsbuildinfo` modification was
not edited, restored, staged, or included in this work.
