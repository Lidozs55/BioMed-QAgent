# Task 7 — Phase 1B Pi runtime adapter

## Result

Task 7 is complete in the `migration/pi-runtime-phase0-1` worktree. The server
now pins Pi `0.82.1`, confines all Pi-owned imports to one adapter module,
exposes BioMed-owned agent/session/event contracts, and provides an ephemeral
experimental HTTP session path behind `PI_EXPERIMENTAL=true`. The legacy
`/api/v1/*` paths remain owned by the Python backend.

Implementation commit: `c4e10a6` (`feat: add isolated Pi runtime adapter`).
No push was performed.

## Genuine RED evidence

The project-contract, registry, experimental-route, and import-boundary tests
were written before their implementation. The initial focused command was:

```text
pnpm --filter @biomed/server test -- tests/pi-adapter.test.ts tests/session-registry.test.ts tests/experimental-pi.test.ts tests/pi-import-boundary.test.ts
```

Three suites failed because the imports
`src/agent/contracts.js`, `src/agent/session-registry.js`, and
`src/agent/experimental-pi.js` did not exist. The static boundary suite already
passed, proving that the focused command was reaching the intended tests.

The Node compatibility assertion was also tightened before the manifest was
changed:

```text
node scripts/check-workspace-foundation.mjs
```

It failed with root `engines.node` equal to `>=22.0.0`, while the pinned Pi
package requires `>=22.19.0`.

One additional lifecycle case was added during implementation: stopping event
consumption before terminal completion must abort the upstream turn. It failed
with `expected abort count 1, received 0`; the async iterable `finally` path now
awaits upstream abort before releasing the active-turn slot.

## Actual Pi 0.82.1 API used

The implementation was based on the installed
`@earendil-works/pi-coding-agent@0.82.1` declarations and source, not an older
`@mariozechner/*` API. The pinned baseline is upstream tag `v0.82.1`, commit
`b4f293684bba718d59cc1157679bcf6157b3a7f5`.

- `createAgentSession(options)` creates the real session.
- `SessionManager.inMemory(cwd)` and `SettingsManager.inMemory()` avoid durable
  Pi-owned state in this experimental phase.
- `DefaultResourceLoader` owns the validated cwd and optional resource/skill
  roots.
- `ModelRuntime.create`, `registerProvider`, and `getModel` provide lazy model
  injection only when session creation is requested.
- `AgentSession.subscribe`, `prompt`, `abort`, and `dispose` back the project
  session lifecycle.
- `message_update.assistantMessageEvent`, `tool_execution_start`,
  `tool_execution_update`, and `tool_execution_end` are mapped to the bounded
  BioMed event union.

All Pi-owned runtime/type imports occur only in
`server/src/agent/pi-adapter.ts`; an automated source scan enforces the
boundary. Root `engines.node` is now `>=22.19.0`, matching Pi's declaration.

## Dependency installation

`server/package.json` pins the exact version `0.82.1`, and the lockfile records
that exact specifier/version. pnpm 11 identified scripts in two transitives.
The audited scripts are not needed for runtime artifacts, so
`pnpm-workspace.yaml` explicitly denies `@google/genai` and `protobufjs` while
retaining `esbuild: true`. A subsequent frozen install completed successfully:

```text
pnpm install --frozen-lockfile
```

## Files

- `server/src/agent/contracts.ts` — upstream-independent adapter, session,
  config, tool-slot, event, and bounded error contracts.
- `server/src/agent/pi-adapter.ts` — the only Pi import boundary, validated
  configuration, real Pi composition, event mapping, cancellation, and cleanup.
- `server/src/agent/session-registry.ts` — ephemeral race-aware `run_id` session
  registry and aggregate lifecycle cleanup.
- `server/src/agent/experimental-pi.ts` — fake-testable non-durable experimental
  session/turn HTTP composition.
- `server/src/app/create-app.ts`, `server/src/index.ts` — flag-gated Host routing
  and lifecycle closer registration.
- `server/tests/pi-adapter.test.ts`, `server/tests/session-registry.test.ts`,
  `server/tests/experimental-pi.test.ts`, and
  `server/tests/pi-import-boundary.test.ts` — deterministic fake coverage.
- `server/package.json`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, and `scripts/check-workspace-foundation.mjs` — pinned
  dependency, Node floor, install policy, and foundation assertion.

## Verification

All commands used pnpm through the requested Node 24.11.1 Corepack executable
when `node`/`pnpm` were not available on `PATH`.

1. Focused Task 7 tests:

   ```text
   pnpm --filter @biomed/server exec vitest run tests/pi-adapter.test.ts tests/session-registry.test.ts tests/experimental-pi.test.ts tests/pi-import-boundary.test.ts
   ```

   Result: 4 files passed, 15 tests passed.

2. Server finite checks:

   ```text
   pnpm --filter @biomed/server test
   pnpm --filter @biomed/server lint
   pnpm --filter @biomed/server typecheck
   pnpm --filter @biomed/server build
   ```

   Result: test 9 files/33 tests passed; lint, typecheck, and build passed.

3. Root finite checks, once after focused checks:

   ```text
   pnpm test
   pnpm lint
   pnpm typecheck
   pnpm build
   ```

   Result: all passed. The root test included workspace foundation, contracts,
   server 33 tests, and frontend 739 tests. Existing React `act(...)` stderr and
   the existing Vite chunk-size warning were unchanged and non-failing.

4. Lock/install and diff checks:

   ```text
   pnpm install --frozen-lockfile
   git diff --check
   git diff --cached --check
   ```

   Result: all passed. A static source inspection also found the Pi import only
   in `server/src/agent/pi-adapter.ts`.

No live provider/model call was added to CI; the real adapter is compile-checked
and lifecycle behavior is covered through injected deterministic fakes.

## Deliberate limitations for Tasks 8–11

- Task 8 will implement the Workspace capability and connect real project tools
  to the existing registration slot. In Phase 1B the real adapter rejects a
  non-empty tool list explicitly.
- Task 9 will normalize these project events into durable `EventEnvelope`
  records, add experimental WebSocket streaming/replay, and wire the frontend.
  The current HTTP response only returns the events collected for one turn.
- Task 10 will bridge Dataset Core build tools and persistence/publication. This
  adapter owns none of those domains.
- Task 11 will compose project skills/system prompts and run the full E2E/live
  sequence.
- The registry is intentionally single-process and ephemeral. It is not a Task
  repository, has no restart recovery, and makes no durability/replay claim.
