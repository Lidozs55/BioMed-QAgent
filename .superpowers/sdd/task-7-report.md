# Task 7 Shadcn Multi-Task Workspace Report

## Scope

Task 7 refactors the frontend workspace around the Task 6 canonical runtime
projection. No backend, CI, or packaging source was changed. The existing
backend DELETE contract (`DELETE /api/v1/tasks/{task_id}` for terminal Tasks)
is consumed by the new frontend API client and controller action.

## Implementation

- Added the approved shadcn `alert-dialog`, `empty`, `field`, `label`, and
  `sonner` components with the project Base UI/Phosphor conventions.
- Removed the CLI-added `next-themes` dependency. The Toaster subscribes to
  the existing document-root `.dark` class, so there is one theme authority.
- Rebuilt `SessionSidebar` with separate active/history groups, canonical
  pagination, status icon/Badge mapping, active-run cancellation, terminal
  AlertDialog deletion, mobile Sheet close behavior, long-title truncation,
  connection status, and worker occupancy (`running X / 4`).
- Added `AgentProgress` for authoritative generic Run lifecycle/tool facts and
  made `ResearchPipeline` a fixture-only five-stage deterministic view.
- Refactored `ChatPanel` to keep the new-research draft independent from the
  selected Task, gate continuation on an idle terminal Agent Task, preserve
  continuation text on errors/409 responses, and retain the full
  MessageScroller/Message/Bubble composition.
- Scoped `ToolTrace` and `ResultsViewer` to active-Task selectors. Trace
  clearing is local hidden-through-sequence state; it never resets projection
  history. Artifact URLs and CSV requests are Task/artifact keyed.
- Added one App-level `Toaster` and `BackgroundTaskNotifications` coordinator
  with initial/foreground suppression, terminal transition deduplication, and
  a canonical View action.
- Added `APIClient.deleteTask`, `RuntimeController.cancelRun/deleteTask`, and
  an authoritative post-success `removeTask` store action. Projection removal
  occurs only after DELETE succeeds.

## TDD Evidence

### Batch A RED/GREEN

- RED: `pnpm test -- session-sidebar.test.tsx api.test.ts runtime-controller.test.ts store.test.ts`
  -> 10 expected failures / 57 passes. Missing behavior was limited to the
  DELETE API/controller/store contract and the new sidebar groups/actions.
- GREEN: the same focused suite -> 4 files / 63 passes, followed by the
  authoritative action and pagination assertions.

### Batch B RED/GREEN

- RED: `pnpm test -- agent-progress.test.tsx research-pipeline.test.tsx`
  -> missing AgentProgress module and three expected null-pipeline failures.
- GREEN: focused progress/pipeline suite -> 13 passes, covering all Run
  statuses, active tool selection, five stable fixture stages, deterministic
  progress, and failed/cancelled attempts.

### Batches C-E

- Chat continuation/draft suite -> 8 passes, including busy/fixture gating and
  409 text/projection preservation.
- Tool/result scope suite -> 10 passes, including quoted CSV parsing and
  selected Task artifact URL behavior.
- Notification suite -> 3 passes, covering background success/error,
  actionable View, duplicate suppression, initial terminal history, and
  foreground suppression.

## Verification

- `pnpm test --run`: 13 files, 121 tests passed.
- `pnpm tsc`: passed.
- `pnpm lint`: passed with `--max-warnings 0`.
- `pnpm build`: passed. Vite emitted only the existing main-chunk advisory
  (>500 kB), which is out of scope for this task.
- `git diff --check`: passed.
- Generated `frontend/tsconfig.app.tsbuildinfo` restored to the committed
  version after build verification.
- No production hits for `as any`, `@ts-ignore`, `@ts-expect-error`, legacy
  WebSocket `run`, or writable session/current-session compatibility usage in
  the changed UI surface.

## Remaining Concerns

- The continuation controller intentionally retains the Task 6 API admission
  contract; durable continuation events are received through the existing
  subscription. It does not add an optimistic Run to the projection.
- The production bundle retains the pre-existing Vite chunk-size advisory.
