# Whole-branch review fixes report

Date: 2026-07-17

Branch: `codex/agent-runtime-concurrency-merge`

Starting HEAD: `f86f599b1098359b366a1e3d77aa0028c7c8bedd`

## Scope

Frontend-only fixes for the final whole-branch review:

- reconcile event-only HIL prompt state during snapshot hydration;
- replay an already-hydrated selection gap before advancing to the snapshot watermark;
- start REST replay from the Task projection's current `lastSequence` while preserving summary full replay and incomplete/non-advancing protection;
- sort a continued historical Task among active Tasks by immutable `created_at DESC, task_id DESC`, while keeping immediate brand-new Task prepend behavior.

No backend, package, registry, shadcn component, CI, or project documentation files were changed.

## TDD evidence

All successful `pnpm` invocations used the bundled Codex Node directory on `PATH` and set `pnpm_config_verify_deps_before_run=false` because the bundled non-interactive pnpm wrapper otherwise attempted an unnecessary modules-store reinstall. No package metadata or lockfile changed.

### 1. Snapshot/HIL reconciliation

RED:

```text
pnpm test -- src/test/runtime-reducer.test.ts
```

The run reached Vitest and failed only the new terminal snapshot regression:

```text
clears pending input when a cancellation snapshot terminalizes its Run
expected pendingUserInput to be null
received the prior run_prompt request
Test Files: 1 failed, 13 passed
Tests: 1 failed, 184 passed
```

The paired still-awaiting snapshot guard passed in the same RED run.

GREEN implementation:

- `hydrateTaskSnapshot` now preserves the prior prompt only when the snapshot's `active_run_id` equals the prompt-owned Run and that Run is present with status `awaiting_user_input`.
- Terminal, cancelled, running, missing, or non-active owning Runs clear the prompt.

GREEN:

```text
pnpm test src/test/runtime-reducer.test.ts
Test Files: 1 passed
Tests: 30 passed
```

### 2. Already-hydrated selection gap and replay watermark

RED:

```text
pnpm test src/test/runtime-controller.test.ts
```

The new regression failed because selection made zero REST replay calls:

```text
replays a user-input prompt emitted during an already-hydrated selection handoff
expected fetchEvents(task_hil_gap, { afterSequence: 5, limit: 1000 })
Number of calls: 0
Tests: 1 failed, 48 passed
```

GREEN implementation:

- selection now replays through `snapshot.task.latest_sequence` for every hydration state before snapshot hydration;
- summary hydration still calls `prepareTaskSnapshotReplay`, so its replay starts from zero;
- `replayTaskEvents` starts at the Task's current `lastSequence` and returns immediately when already at the target;
- existing incomplete and non-advancing replay errors remain intact.

The first GREEN attempt made the new regression pass and exposed three older controller doubles whose snapshots advanced without supplying their implied durable events. Those test fixtures were corrected to return the missing events; production replay protection was not weakened.

Final GREEN:

```text
pnpm test src/test/runtime-controller.test.ts
Test Files: 1 passed
Tests: 49 passed
```

The regression asserts the exact order:

```text
barrier -> snapshot -> events:5 -> subscribe:6
```

and verifies the replayed `user_input_required` prompt survives the still-paused snapshot.

### 3. Immutable continuation ordering

RED:

```text
pnpm test src/test/runtime-controller.test.ts src/test/store.test.ts
```

The new continuation regression showed the older Task prepended:

```text
received: [task_older, task_newest, task_peer_b, task_peer_a]
expected: [task_newest, task_peer_b, task_peer_a, task_older]
Test Files: 1 failed, 1 passed
Tests: 1 failed, 71 passed
```

The paired brand-new Task guard passed, proving its immediate prepend behavior remained unchanged.

GREEN implementation:

- existing Task admission reuses the reducer's immutable Task comparator;
- active IDs are deduplicated and sorted after historical continuation admission;
- the brand-new Task branch remains prepended until the backend creation timestamp hydrates.

GREEN:

```text
pnpm test src/test/runtime-controller.test.ts src/test/store.test.ts
Test Files: 2 passed
Tests: 72 passed
```

## Final verification

```text
pnpm test src/test/runtime-reducer.test.ts src/test/store.test.ts src/test/runtime-controller.test.ts
Test Files: 3 passed
Tests: 102 passed

pnpm lint
ESLint exit 0, zero warnings

pnpm tsc
tsc --noEmit exit 0

pnpm test
Test Files: 14 passed
Tests: 188 passed

pnpm build
tsc -b && vite build exit 0
4954 modules transformed; production assets emitted
```

The first production-build attempt caught `TS18048` in the new controller test because the API type permits omitted replay options. An explicit test guard was added, then the controller test, ESLint, `tsc --noEmit`, full Vitest, and production build were all rerun successfully. Vite emitted its existing non-fatal chunk-size warning for the 684.99 kB main bundle.

`git diff --check` exited 0.

## Excluded workspace changes

- `frontend/tsconfig.app.tsbuildinfo` was already dirty generated state before this task and remains unstaged/uncommitted; no restore was attempted.
- `.gitignore` acquired an external unrelated `.codex/config.toml` entry during this task. It was not created, edited, staged, or committed by this work.
