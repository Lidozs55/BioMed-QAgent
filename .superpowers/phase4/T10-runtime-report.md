# Pi Migration Phase 4 — T10 Report: Checkpoint / Retry / Cancel (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 10
(checkpoint/retry/cancel).
Branch: `codex/phase4-dataset-core-ts`.

## Summary

Ported the fixed-skeleton build executor to TypeScript
(`backend/app/datasets/runtime/`): the deterministic `buildOperationPlan`,
append-only `OperationAttempt` history with digest-matched idempotent reuse,
attempt-bound output checkpoints, cooperative cancellation, inflight recovery,
resume-from semantics and append-only attempt-log prefix validation.

## What was built / changed

| Area | Files |
| --- | --- |
| Runtime module | `server/src/dataset/runtime/{operations,plan,digests,checkpoint,executor}.ts`, `index.ts` |
| Parity checks (vitest-free) | `server/tests/runtime-parity.ts` — plan, reuse, parameter/impl-version invalidation, resume, cancel, recovery, failure, state machine, diverged log, corrupt state |
| Vitest suite | `server/tests/dataset-runtime.test.ts` (1 test) |

## Invariants mirrored

- **Plan**: 10-operation fan-out/fan-in skeleton (acquire/parse/canonicalize per
  binding, then compatibility_gate -> integrate -> validate_profile -> publish)
  with exact upstream order.
- **Reuse contract** (ARCHITECTURE §5.2): a SUCCEEDED attempt is reused only
  when input, parameter **and implementation-version** digests all match;
  changing the parameter scope or upgrading one parse implementation re-runs
  exactly the affected operation (never stale output).
- **Resume**: `resume_from` forces the target operation and reuses upstream;
  a changed target output digest invalidates every downstream operation
  (compatibility gate onward re-execute); unknown resume targets are rejected;
  a fresh state executes everything.
- **Cancel**: cooperative cancel stops the skeleton; an operation that
  completed after the cancel request is recorded CANCELLED (never a fake
  success) and its outputs are discarded (K1).
- **Recovery**: a RUNNING inflight attempt on restart is marked CANCELLED and
  re-executed; corrupt `build_state.json` returns a structured failed outcome
  (never a bare raise).
- **Failure**: a phase-B failure marks the inflight attempt FAILED with a
  structured error; per-binding phase-A failures become typed rejections
  (BindingRejectedError/EmptySourceError/AdapterError paths).
- **Append-only log**: `validateAttemptLogPrefix` rejects a diverged
  `operation_attempts.jsonl` (record ahead of durable state).
- **State machine**: `parseOperationAttempt` enforces Pydantic invariants —
  SUCCEEDED requires `output_digest`, FAILED requires `error`, SKIPPED
  requires `reused_operation_attempt_id`.

## Verification evidence

- Strict typecheck: exit 0.
- ESLint (server type-aware config): 0 errors.
- Vitest: T1–T10 dataset suites 53/53 passed (runtime suite included).
- All new files UTF-8 no BOM, CRLF line endings.

## Known deviations (intentional, non-blocking)

- The TS executor is synchronous; Python asyncio worker threads, operation
  timeouts, build locks, straggler markers and the event sink are runtime
  infrastructure that land with the TS Host integration (documented in the
  executor module header). The operation-timeout Python test is therefore not
  mirrored.
- Event-envelope assertions (started/completed payloads) are not mirrored;
  the TS executor has no event sink yet.

## Next steps

Phase 4 is functionally complete (steps 1–10). Remaining: full workspace
verification (`pnpm install` + `pnpm test`/`lint`/`typecheck` once the
pnpm-store gate clears), Phase 4 acceptance review against the plan, then
merge to `main` per AGENTS.md §7.