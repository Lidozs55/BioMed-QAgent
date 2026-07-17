# R5 Frontend UX Fixes Report

## Scope

- Branch: `codex/agent-runtime-concurrency-merge`
- Starting commit: `c6e11ce57f45392ae3fe9507e05e0a05b43a207c`
- Implemented only the four behaviors in `r5-frontend-ux-fixes-brief.md`.
- No backend, HIL behavior, CI/CD, packaging, dependency, registry, or Markdown-rendering changes.

The Codex `pnpm` wrapper attempted an interactive modules purge and stopped with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Per the task instruction, all
Vitest, ESLint, TypeScript, and Vite commands below used the existing local
packages through:

```text
C:\Users\cheng\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

## Behavior 1 — bounded non-chat scrolling

Test-first changes:

- `ChatPanel` setup panel must have `min-h-0` and `overflow-y-auto`, with both
  submission controls inside that panel.
- The chat panel must have a bounded `min-h-0` chain while leaving
  `overflow-y-auto` on `MessageScrollerViewport` only.
- The results tab must bound its internal results layout with `min-h-0` and
  `overflow-hidden`.
- `ResultsViewer` must use `h-full min-h-0`; its artifact `ScrollArea` must be a
  `min-h-0 flex-1` child containing the 14th/final artifact.

RED:

```text
node vitest.mjs run src/test/chat-panel.test.tsx src/test/results-viewer.test.tsx
Test Files  2 failed (2)
Tests       4 failed | 17 passed (21)
```

Expected failures showed the setup, chat, and results tab panels missing their
bounded-height classes and `ResultsViewer` missing `h-full min-h-0`.

GREEN:

```text
Test Files  2 passed (2)
Tests       21 passed (21)
```

Implementation:

- Added the `min-h-0` flex chain to `ChatPanel` and its `Tabs`.
- Made Setup the non-chat `overflow-y-auto` owner.
- Made Results a bounded `overflow-hidden` panel and its existing shadcn
  `ScrollArea` the `min-h-0 flex-1` scroll owner.
- Kept Chat scrolling owned by the existing shadcn `MessageScrollerViewport`.

## Behavior 2 — immutable task ordering after refresh races

Test-first changes:

- Reducer coverage merges duplicated active/history IDs plus preserved local
  IDs and requires `created_at DESC, task_id DESC` for both groups.
- Controller coverage starts a history refresh, terminalizes an older task
  locally while the request is in flight, then resolves a page containing a
  newer task.

RED:

```text
node vitest.mjs run src/test/runtime-reducer.test.ts src/test/runtime-controller.test.ts
Test Files  2 failed (2)
Tests       2 failed | 74 passed (76)
```

Observed failures:

- Active IDs were `task_active_old, task_active_old, task_active_new` instead of
  deduplicated immutable order.
- The refresh race produced `task_older_changed, task_newer_history` instead of
  the newer task first.

GREEN:

```text
node vitest.mjs run src/test/runtime-reducer.test.ts src/test/runtime-controller.test.ts
Test Files  2 passed (2)
Tests       76 passed (76)

node vitest.mjs run src/test/runtime-reducer.test.ts src/test/runtime-controller.test.ts src/test/store.test.ts
Test Files  3 passed (3)
Tests       97 passed (97)
```

Implementation:

- Deduplicated merged active IDs and sorted them with the existing immutable
  task comparator.
- Sorted deduplicated inactive IDs with the same comparator.
- Updated pre-existing controller fixtures whose equal or provisional
  timestamps previously encoded concatenation order rather than the required
  immutable order.

## Behavior 3 — rejected background View action

Test-first change:

- Invoked the actual Sonner `查看` action with a deferred rejecting
  `onViewTask` promise and required the existing `打开任务失败` toast with the
  rejection message.

RED:

```text
node vitest.mjs run src/test/background-task-notifications.test.tsx
Test Files  1 failed (1)
Tests       1 failed | 6 passed (7)
Failure     toast.error received 0 calls
```

GREEN:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

Implementation:

- The action now calls an async helper that awaits `onViewTask`.
- Rejections are caught and shown with `toast.error("打开任务失败", {
  description })`, so the action promise cannot escape as an unhandled
  rejection.

## Behavior 4 — multiline assistant Bubble text

Test-first change:

- Seeded an assistant message containing a blank line, a list line, and
  indented text.
- Required exact newline-preserving `textContent`, the existing
  `Bubble`/`BubbleContent` composition, and `whitespace-pre-wrap`.

The first test attempt used Testing Library's whitespace-normalizing text
matcher and failed before reaching the behavior assertion. The query was
corrected to inspect the existing `BubbleContent` element directly; no
production code was changed before the valid RED run.

RED:

```text
node vitest.mjs run src/test/chat-panel.test.tsx
Test Files  1 failed (1)
Tests       1 failed | 19 passed (20)
Failure     BubbleContent lacked whitespace-pre-wrap
```

GREEN:

```text
Test Files  1 passed (1)
Tests       20 passed (20)
```

Implementation:

- Added `whitespace-pre-wrap` to the existing `BubbleContent` used for message
  text.
- No Markdown parser or unsafe renderer was added.

## Final verification

Combined focused Vitest:

```text
Test Files  6 passed (6)
Tests       126 passed (126)
```

ESLint:

```text
node node_modules/eslint/bin/eslint.js . --max-warnings 0
exit 0; no output
```

TypeScript:

```text
node node_modules/typescript/bin/tsc --noEmit
exit 0; no output
```

Full Vitest:

```text
Test Files  14 passed (14)
Tests       182 passed (182)
```

Production build:

The first `tsc -b` exposed two test-only typing gaps that `tsc --noEmit` did
not include (`querySelector` returning `Element` and a nullable Bubble query).
The tests were given typed selectors and an explicit null guard. The rerun
completed successfully:

```text
vite v5.4.21 building for production...
4954 modules transformed
dist/assets/index-nsHEqMME.css  121.50 kB (gzip 19.44 kB)
dist/assets/index-CerpD8zR.js   684.73 kB (gzip 205.62 kB)
built in 5.65s
```

Vite emitted its existing non-fatal warning that a minified chunk exceeds
500 kB. The build exited successfully.

Build-info restoration:

- Pre-build SHA-256: `26D20B3B04E1893D4B4322D91C507FFDA9C86C81A130954A646A4A52D5E7302B`
- Post-build generated SHA-256: `CDF3922C097C9BFEF2EFAEBEA859D9140D3E189755ACB32D662BA47E42C74EAF`
- Final restoration verification: not completed. Both the worker and parent
  agent were blocked because sandboxed `git restore` could not create
  `.git/index.lock`, while the required escalation auto-review service returned
  503. Policy prohibited an indirect restoration workaround.
- `frontend/tsconfig.app.tsbuildinfo` therefore remains modified in the shared
  working tree and is explicitly excluded from the R5 commit.

## Files changed

- `frontend/src/App.tsx`
- `frontend/src/components/BackgroundTaskNotifications.tsx`
- `frontend/src/components/ChatPanel.tsx`
- `frontend/src/components/ResultsViewer.tsx`
- `frontend/src/runtime/reducer.ts`
- `frontend/src/test/background-task-notifications.test.tsx`
- `frontend/src/test/app.test.tsx`
- `frontend/src/test/chat-panel.test.tsx`
- `frontend/src/test/results-viewer.test.tsx`
- `frontend/src/test/runtime-controller.test.ts`
- `frontend/src/test/runtime-reducer.test.ts`
- `.superpowers/sdd/r5-frontend-ux-fixes-report.md`

## Browser QA follow-up — App viewport boundary

Browser evidence at 1280x720 showed the final artifact at y=2514 and the
artifact `ScrollArea` root at height 2544. The ancestor trace remained 2544–2672
pixels tall through `ResultsViewer`, `TabsContent`, `Tabs`, `ChatPanel`, the App
content wrappers, `SidebarInset`, and the `SidebarProvider` wrapper. The outer
wrapper used only `min-h-svh`, so it grew with content instead of bounding the
workspace to the viewport.

Test-first change:

- Added an App regression test requiring the composed viewport chain:
  `SidebarProvider` wrapper `h-svh min-h-0 overflow-hidden`, `SidebarInset`
  `min-h-0 overflow-hidden`, a shrinkable header boundary, and `min-h-0` on the
  content main and ChatPanel wrapper.

RED:

```text
node vitest.mjs run src/test/app.test.tsx
Test Files  1 failed (1)
Tests       1 failed | 2 passed (3)
Failure     sidebar-wrapper had min-h-svh only; h-svh/min-h-0/overflow-hidden missing
```

GREEN:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

Follow-up verification:

```text
App + ChatPanel + ResultsViewer focused Vitest: 3 files, 25 tests passed
ESLint --max-warnings 0: exit 0
tsc --noEmit: exit 0
```

Implementation:

- Added the viewport-bound classes at the App composition layer only.
- Added `shrink-0` to the App header and `min-h-0` to the remaining content
  chain.
- Did not modify the shadcn sidebar primitive or Chat `MessageScroller`
  ownership.
