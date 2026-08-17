# Durable HIL and Confidence Protocol Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task with TDD checkpoints.

**Goal:** Deliver a restart-safe HIL protocol connected to categorical evidence confidence, validation profiles, and a shadcn batch-review/result UI.

**Architecture:** Add wire contracts first, persist HIL requests and immutable reviews beside the task event stream, generalize the approval gate while keeping live waiters non-authoritative, evaluate confidence in Dataset Core before profile validation, and expose the durable state to the existing React runtime.

**Tech Stack:** TypeScript, Vitest, React 19, Vite, Tailwind v4, shadcn/ui, Node application host, JSONL task event store.

---

## Task 1: Formal HIL wire contracts

**Files:**
- Create: `packages/contracts/src/hil.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/tests/hil.test.ts`

1. Write failing parser/shape tests for categories, review types, structured
   decisions, request snapshots, immutable review records, and legacy event
   compatibility.
2. Run the focused contracts test and confirm the intended failure.
3. Add strict contracts and parsers; connect required/resumed events to the new
   payload while preserving safe parsing of historical events.
4. Re-run contracts tests, typecheck, and lint for the package.

## Task 2: Durable request store and restart-safe runtime gate

**Files:**
- Create: `server/src/runtime/hil-store.ts`
- Create: `server/src/runtime/hil-gate.ts`
- Modify: `server/src/runtime/approval-gate.ts`
- Modify: `server/src/runtime/task-repository.ts`
- Modify: `server/src/runtime/durable-agent-runtime.ts`
- Modify: `server/src/api/router.ts`
- Test: `server/tests/hil-store.test.ts`
- Test: `server/tests/durable-hil-runtime.test.ts`

1. Write failing tests for persistence, one blocking request per run, evidence
   binding, idempotent resume, conflicting retry rejection, recovery preservation,
   and resume after a new runtime instance.
2. Implement atomic task-local request/review persistence with canonical evidence
   hashing and request serialization.
3. Generalize the gate so live promises are optional waiters over the durable
   store, and preserve the existing credential authorization API.
4. Make startup retain awaiting runs, make cancellation work without a live Pi
   session, and resume either the live waiter or a reconstructed continuation.
5. Run focused runtime tests, then the server runtime suite.

## Task 3: Evidence confidence contracts and evaluator

**Files:**
- Modify: `server/src/dataset/contracts/data.ts`
- Create: `server/src/dataset/confidence/evaluator.ts`
- Create: `server/src/dataset/confidence/artifact.ts`
- Modify: `server/src/dataset/publish/manifest.ts`
- Test: `server/tests/dataset-confidence-evaluator.test.ts`
- Test: `server/tests/dataset-manifest.test.ts`

1. Write failing tests for enums, derived review requirement, weakest-link
   evaluation, nondeterministic caps, human-acceptance invariance, batch
   inheritance, record overrides, and manifest summaries.
2. Replace free-form confidence component states, remove validation from
   confidence components, and make review requirement derived.
3. Implement the evaluator and confidence audit artifact without changing the
   existing statistical anomaly detector.
4. Generate manifest distribution/reason/review summaries.
5. Run focused Dataset Core tests.

## Task 4: Dataset HIL policy for mapping and unit conversion

**Files:**
- Create: `server/src/dataset/review/hil-policy.ts`
- Modify: `server/src/dataset/service/ts-core.ts`
- Modify: `server/src/dataset/canonicalize/canonicalizer.ts`
- Modify: `server/src/agent/tools/tool-hooks.ts`
- Modify: `server/src/agent/tools/declarative-db.ts`
- Modify: `server/src/runtime/phase3-composition.ts`
- Test: `server/tests/dataset-hil-policy.test.ts`
- Test: `server/tests/ts-core-hil.test.ts`

1. Write failing tests for batched proposed mappings, safe structured unit
   corrections, reject/skip behavior, and the one-blocking-request invariant.
2. Add a policy-owned review adapter to Dataset Core before canonicalization.
3. Convert accepted mapping proposals to explicit human-approved mappings and
   record corrections in provenance.
4. Permit only finite structured linear unit corrections; never execute
   arbitrary formulas.
5. Recompute confidence after review and run focused integration tests.

## Task 5: Categorical VLM extraction confidence and batch review

**Files:**
- Modify: `server/src/processing/vlm/chart-json.ts`
- Modify: `server/src/processing/vlm/chart-extraction.ts`
- Modify: `server/src/agent/tools/chart-data-vlm.ts`
- Test: `server/tests/chart-json.test.ts`
- Test: `server/tests/chart-data-vlm.test.ts`

1. Write failing tests that reject numeric pseudo-probabilities and require
   categorical level, reason, and review state per extracted point.
2. Update the model prompt, normalized CSV schema, and fixtures.
3. Batch low-confidence primary points into one data-review request; apply
   accept/correct/reject/skip deterministically and retain original evidence.
4. Verify that acceptance does not upgrade the evidence level.

## Task 6: Profile-owned confidence validation gates

**Files:**
- Modify: `server/src/dataset/contracts/profiles.ts`
- Modify: `server/src/dataset/validation/profile.ts`
- Modify: `server/src/dataset/profiles/registry.ts`
- Modify: `server/src/dataset/service/ts-core.ts`
- Test: `server/tests/dataset-validation-profile.test.ts`

1. Write failing tests for pending-review blocking, minimum primary confidence,
   low-confidence fraction limits, and required review by channel.
2. Add `ConfidenceGatePolicy` to strict profile contracts and registered
   profiles.
3. Evaluate the persisted confidence artifact during validation, keeping
   evidence evaluation separate from validation outcome.
4. Run validation and publish-path tests.

## Task 7: shadcn batch review and confidence result experience

**Files:**
- Modify: `frontend/src/runtime/contracts.ts`
- Modify: `frontend/src/runtime/reducers/hil.ts`
- Modify: `frontend/src/components/UserInputDialog.tsx`
- Create: `frontend/src/components/HumanReviewBatch.tsx`
- Modify: `frontend/src/components/BuildResultsViewer.tsx`
- Modify: relevant frontend parser and API files
- Test: `frontend/src/__tests__/user-input-dialog.test.tsx`
- Test: `frontend/src/__tests__/hil-data-correction-e2e.test.tsx`
- Test: `frontend/src/__tests__/build-results-viewer.test.tsx`

1. Write failing reducer, wire-parser, dialog action, and results-summary tests.
2. Reuse installed shadcn Dialog, Card, Table, Badge, ToggleGroup, Alert,
   Textarea, ScrollArea, and Button components with semantic tokens.
3. Preserve permission approve/reject; render batched review items with
   accept/correct/reject/skip and evidence-bound submissions.
4. Add confidence distribution, reasons, review state, and audit/provenance
   drill-down to build results.
5. Run frontend test, lint, typecheck, and build checks from `frontend/`.

## Task 8: Architecture records, TODO closure, and complete verification

**Files:**
- Create: `docs/adr/026-durable-hil-confidence-protocol.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/architecture/runtime-events.md`
- Modify: `docs/architecture/result-validation.md`
- Modify: `docs/architecture/dataset-execution.md`
- Modify: `docs/architecture/agent-frontend.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TODO.md`

1. Document the durable protocol, confidence/validation boundary, V1 policy,
   recovery behavior, and UI contract without duplicating implementation detail.
2. Mark the approved TODO items complete only after their acceptance tests pass.
3. Run `git diff --check`, all workspace quality gates, database bridge checks,
   and a production-host startup smoke test.
4. Request code review, address findings, re-run affected and full gates.
5. Re-read `AGENTS.md`, sync with `origin/main`, commit with conventional
   messages, merge the complete feature to local `main`, push, confirm local and
   remote heads match, post the Commonly `[DONE]` report, and remove the worktree.
