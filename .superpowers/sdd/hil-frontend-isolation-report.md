# HIL frontend Run isolation report

## Result

Implemented the binding brief on `codex/agent-runtime-concurrency-merge` with no backend, dependency, registry, R5, MessageScroller, or sequence-dedup changes.

## RED / GREEN evidence

| Behavior | RED observed | GREEN observed |
| --- | --- | --- |
| Pending prompt owns `envelope.run_id` | reducer test failed because `runId` was absent | focused test passed after adding `PendingUserInput.runId` and projecting it |
| Wrong-Run resume isolation | reducer test received `null` instead of Run A's prompt | prompt now clears only when Run ID and request ID both match |
| Terminal ownership | all four terminal cases retained the owning prompt | `run_completed`, `run_failed`, `run_cancelled`, and `run_interrupted` clear only their Run's prompt |
| New Run isolation | queued and REST-accepted Run tests retained the old prompt | `run_queued` and `addAcceptedTask` clear older pending input |
| Fixture required + automatic resume | pre-fix projection failed on missing fixture `runId` | required event projects `awaiting_user_input`; matching automatic resume clears it and returns to `running` at sequence 2 |
| Dialog A -> B isolation | B's confirm button remained disabled while A was in flight | B is immediately enabled; rejecting A adds no B error; B submits `pending.runId` and its request ID |
| Sidebar occupancy | test could not find `运行中 4 / 4` with one paused Run | `awaiting_user_input` counts as an occupied slot |
| Production build | first `tsc -b` exposed a missing `resumeRun` test mock and an optional test callback parameter | minimal test typing corrections made `tsc -b` and Vite build pass; no runtime behavior changed |

The Codex pnpm wrapper aborted on its no-TTY modules-purge guard (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Per the task brief, tests and quality gates used the existing local Node runtime and installed project entry points; no reinstall was allowed.

## Final verification

- Focused Vitest: `runtime-reducer`, `store`, `user-input-dialog`, `session-sidebar` — 4 files, 60 tests passed.
- ESLint: `eslint . --max-warnings 0` — exit 0.
- TypeScript: `tsc --noEmit` — exit 0.
- Full Vitest: 14 files, 173 tests passed.
- Production build: `tsc -b` — exit 0; `vite build` — exit 0 (existing large-chunk advisory only).
- `git diff --check` — exit 0.
- Generated `frontend/tsconfig.app.tsbuildinfo` restored after build.

## Review finding follow-up

- RED: `& 'C:\Users\cheng\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'D:\coding\BioMed-QAgent\frontend\node_modules\vitest\vitest.mjs' run src/test/user-input-dialog.test.tsx` — 1 failed; after A rejected while B was visible, returning to A left `确认执行` disabled.
- GREEN: the same command — 1 file, 1 test passed after resetting `SubmissionState` on prompt identity changes.
- Focused GREEN: the same local Node/Vitest entry with `run src/test/runtime-reducer.test.ts src/test/store.test.ts src/test/user-input-dialog.test.tsx src/test/session-sidebar.test.tsx` — 4 files, 60 tests passed.
- Lint GREEN: the same local Node entry with `frontend/node_modules/eslint/bin/eslint.js . --max-warnings 0` — exit 0.
- TypeScript GREEN: the same local Node entry with `frontend/node_modules/typescript/bin/tsc --noEmit` — exit 0.

## Files changed

- `frontend/src/runtime/types.ts`
- `frontend/src/runtime/reducer.ts`
- `frontend/src/stores/agentStore.ts`
- `frontend/src/components/UserInputDialog.tsx`
- `frontend/src/components/SessionSidebar.tsx`
- `frontend/src/test/runtime-reducer.test.ts`
- `frontend/src/test/store.test.ts`
- `frontend/src/test/user-input-dialog.test.tsx`
- `frontend/src/test/session-sidebar.test.tsx`
- `frontend/src/test/background-task-notifications.test.tsx` (build-only API mock completeness)
- `frontend/src/test/runtime-controller.test.ts` (build-only optional parameter narrowing)
- `.superpowers/sdd/hil-frontend-isolation-report.md`
