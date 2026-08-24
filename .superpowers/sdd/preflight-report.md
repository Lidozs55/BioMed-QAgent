# Dynamic family build preflight protocol report

## Scope and baseline

- Worktree: `D:/coding/BioMed-QAgent-family-host-dynamic-preflight`
- Branch: `feat/family-host-dynamic-preflight`
- Base: `0d9c0c4e26736e9512e67f82dad051f546cd0544`
- Governing brief: `.superpowers/sdd/preflight-brief.md`
- Shared `README.md`, `AGENTS.md`, `docs/TODO.md`, `docs/ISSUES.md`, and ADR files were not modified.

## Implemented protocol

The dynamic family path now exposes `prepare_dynamic_family_build` and requires a
task/build/generation-bound `preflight_receipt` for V2 submit. The receipt is a
hostile-wire parsed contract DTO with a canonical digest over:

- FamilySpec and Projection digests;
- the Host-compiled transform descriptor digest;
- exact input roles and selected output closure;
- topology diagnostics;
- registered/builtin acquisition plan entries and Core request identity digests;
- a canonical submission-facts digest.

Preparation performs topology/schema/output-role checks, Host compilation and
descriptor admission, and Core provider planning only. It does not resolve source
bytes, create acquisition attempts, execute a transform, create an
`OperationResult`, `ProductAssessment`, `DatasetPublication`, or publication
artifact. Submit validation checks receipt integrity and task/build/generation
identity before acquisition or registered-byte resolution. Production phase3
composition validates the receipt before acquisition, then reuses the same Core
planning seam before execution; generation advances after publication.

The V2 dynamic tool and public submit boundary are strict: there is no
production-facing `requirePreflight: false` option. The prepare tool is included
in the Dataset Core skill mapping and is marked task/run-scoped unavailable in
the generic business bundle until phase3 injects its authoritative context.

## TDD evidence

Initial RED was captured before the preflight production module existed:

```text
pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts --maxWorkers=2
...
Cannot find module '../src/dataset/dynamic-family/preflight.js'
```

Additional regression RED/GREEN cycles captured during implementation:

- Planner identity test: 1 failed of 6 with `dynamic preflight acquisition plan does not match`; after wiring the same Core planner into prepare, validate, and submit, 6/6 passed.
- Skill/tool mapping: 2 failures of 32 when the new prepare tool was not mapped; after adding the mapping and unavailable marker, 32/32 passed.
- Pi prompt compatibility test: 1 failure of 24 because it still asserted the removed descriptor-handshake wording; the assertion now checks the fixed prepare receipt wording and 24/24 passes.
- Strict factory default: the new receipt-only test failed when the factory default was permissive; the default is now strict and legacy direct tests were migrated to prepare first.

## Focused verification

All focused Vitest invocations below used `--maxWorkers=2`:

| Command focus | Result |
| --- | --- |
| `@biomed/contracts` preflight receipt test | 2 tests passed |
| dynamic preflight server test | 6 tests passed |
| dynamic build tool + preflight | 20 tests passed |
| dynamic build, preflight, acquisition-first, Core acquisition | 32 tests passed |
| Core acquisition planning | 9 tests passed |
| dynamic materializer, topology linter, in-process Host | 34 tests passed |
| skill-tool-map + deterministic tool tests | 32 tests passed |
| Pi adapter/prompt tests | 24 tests passed |
| Dataset build tool tests | 16 tests passed |

Server typecheck, lint, and build passed after the implementation changes;
contracts typecheck also passed. `git diff --check` passed.

## Full-gate status

The first serialized full-gate slot was granted before the following
pre-review-fix commands were run, and every command completed successfully in
sequence. That recursive test invocation passed 118 contract tests, 1,594
server tests with 11 intentional skips, and 836 frontend tests. Every full
Vitest invocation used `--maxWorkers=2`:

```text
node scripts/check-workspace-foundation.mjs
node scripts/check-doc-links.mjs
pnpm -r --workspace-concurrency=1 --if-present test -- --maxWorkers=2
pnpm lint
pnpm typecheck
pnpm build
pnpm docs:check
uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database
```

Gate results:

- `node scripts/check-workspace-foundation.mjs`: passed.
- `node scripts/check-doc-links.mjs`: passed.
- `pnpm -r --workspace-concurrency=1 --if-present test -- --maxWorkers=2`:
  contracts 118 passed; server 1,594 passed and 11 skipped; frontend 836
  passed.
- `pnpm lint`: passed for server and frontend with zero warnings.
- `pnpm typecheck`: passed for contracts, server, and frontend.
- `pnpm build`: passed for contracts, server, and frontend. Vite emitted the
  existing large-chunk advisory only.
- `pnpm docs:check`: passed.
- `uv run python database/bridge.py --self-test`: `SELF-TEST OK`.
- `uv run pytest database/tests`: 88 passed.
- `uv run ruff check database`: passed.

## Review fix wave

The review findings were verified against the production composition and closed
with a focused TDD cycle. The first post-fix serialized full-gate attempt passed
the foundation, documentation-link, and contracts/frontend test stages but
stopped at the server test stage when its static generic-Core dispatch guard
flagged a false positive introduced by a local variable named `providerId` in
the new typed-plan parser. The variable was renamed to `plannedProviderId`
without changing the wire field or validation semantics.
The focused guard and affected aggregate now pass; a new serialized slot was
requested before rerunning the remaining full gates and was subsequently
granted.

Exact first post-fix full-gate evidence:

- `node scripts/check-workspace-foundation.mjs`: passed.
- `node scripts/check-doc-links.mjs`: passed.
- `pnpm -r --workspace-concurrency=1 --if-present test -- --maxWorkers=2`:
  contracts 118 passed; frontend 836 passed; server 1 failed, 1,599 passed,
  and 11 skipped (163 files passed, 1 failed, 1 skipped). The remaining full
  lint/typecheck/build/docs/Python gates were not started after this failure.

The parent then granted a new serialized slot. The corrected server suite and
all remaining required gates completed sequentially:

```text
pnpm --filter @biomed/server test -- --maxWorkers=2
pnpm lint
pnpm typecheck
pnpm build
pnpm docs:check
uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database
```

Final post-fix gate results:

- `pnpm --filter @biomed/server test -- --maxWorkers=2`: 164 files passed,
  1 skipped; 1,600 tests passed and 11 skipped.
- `pnpm lint`: passed for server and frontend with zero warnings.
- `pnpm typecheck`: passed for contracts, server, and frontend.
- `pnpm build`: passed for contracts, server, and frontend. Vite emitted the
  existing large-chunk advisory only.
- `pnpm docs:check`: passed (`Documentation links: OK`).
- `uv run python database/bridge.py --self-test`: `SELF-TEST OK`.
- `uv run pytest database/tests`: 88 passed.
- `uv run ruff check database`: passed (`All checks passed!`).

Implemented changes:

- Phase3 now owns per-build generation state. A new prepare synchronously
  supersedes the prior receipt; submit validates, acquires the task/build lock,
  atomically consumes the current receipt before acquisition, and clears the
  reservation on success or failure. The live reservation fence is passed into
  Host execution, so supersession suppresses transform/publication continuation.
- Public `submitDynamicFamilyBuild` and `createDynamicFamilyBuildTool` require
  generation, prepared submission, and receipt; the parser/factory no longer has
  a `requirePreflight: false` bypass. Legacy direct tests now prepare first.
- Every builtin acquisition requires a typed Core `CoreAcquisitionPlan` with a
  valid identity/provider/implementation digest and recipe; missing, malformed,
  or drifted planning is rejected. Acquisition compares its committed identity
  with the receipt before transform execution.
- `.pi/skills/dataset-construction/SKILL.md` now documents prepare, descriptor
  digest binding, unchanged receipt submit, and fresh prepare after fact changes.

Exact RED/GREEN evidence (all Vitest commands explicitly used
`--maxWorkers=2`):

- RED: `pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts tests/skill-manifests.test.ts --maxWorkers=2` — exit 1; 2 files failed, 5 tests failed (13 passed), covering missing coordinator, planner fallback, low-level bypass, and stale skill guidance.
- RED: `pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts -t "rejects missing and malformed Core plans" --maxWorkers=2` — exit 1; 1 failed, 9 skipped because malformed recipe planning was accepted.
- GREEN: same planner command — 1 passed, 9 skipped.
- GREEN: `pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts -t "dynamic family preflight composition fencing" --maxWorkers=2` — 2 passed, 8 skipped.
- GREEN: `pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts tests/dynamic-family-build-tool.test.ts --maxWorkers=2` — 2 files, 24 tests passed.
- GREEN: `pnpm --filter @biomed/server test -- tests/skill-manifests.test.ts --maxWorkers=2` — 8 tests passed.
- GREEN: `pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts --maxWorkers=2` — 11 tests passed, including composition-side-effect and valid re-digested stale-receipt coverage.
- GREEN: affected aggregate — `pnpm --filter @biomed/server test -- tests/dynamic-family-preflight.test.ts tests/dynamic-family-build-tool.test.ts tests/core-owned-acquisition.test.ts tests/acquisition-first-composition.test.ts tests/phase5/tools-deterministic.test.ts tests/skill-tool-map.test.ts tests/skill-manifests.test.ts tests/pi-adapter.test.ts tests/transform-host-in-process-unisolated.test.ts --maxWorkers=2` — 9 files, 114 tests passed.
- GREEN: `pnpm --filter @biomed/server typecheck` and `pnpm --filter @biomed/server lint` — both passed.
- RED: `pnpm --filter @biomed/server test -- tests/family-host-core-dispatch-guard.test.ts --maxWorkers=2` — 1 failed, 2 passed; the guard reported `dynamic-family/preflight.ts` / `providerId string-literal dispatch` from the `typeof providerId !== "string"` check.
- GREEN: same dispatch-guard command after renaming the local variable to `plannedProviderId` — 3 tests passed.
- GREEN: affected aggregate including the dispatch guard — 10 files, 117 tests passed.
- GREEN: `pnpm --filter @biomed/server typecheck` and `pnpm --filter @biomed/server lint` after the guard fix — both passed.

## Self-review and follow-up suggestions

- No sandbox/container/IPC, generic DAG, or new dependency was introduced.
- Contract parsing is exact-field, non-Proxy, descriptor-safe hostile-wire parsing;
  receipt digest verification is performed before fact recomputation.
- Existing Host descriptor, topology, materialization, source provenance, and
  publication checks remain in place; the receipt is an additional proof.
- Suggested follow-up documentation: add the two-call prepare/submit sequence,
  generation lifecycle, and the task-scoped skill-map ownership to the current
  architecture/TODO documentation. Those shared files were intentionally not
  edited in this lane.

## Second review fix wave

The second review findings were verified against the production phase3
composition. Publication previously received only a build-lock check before
entering its async staging/HIL/promotion path; a new prepare could invalidate
the reservation while those writes continued. The publication boundary now
requires an async live-generation fence, checks it before staged mutations,
after B3 and HIL gates, before every final manifest write, and again through
the publisher's immutable-rename fence. Phase3 supplies a fence that combines
the current reservation with build-lock ownership.

The dataset-construction skill no longer switches directly from a failed static
family to submit. Both its normal dynamic path and its failure fallback require
prepare, Host descriptor digest binding, and submit with the unchanged receipt;
fresh prepare is required after committed fact changes.

Exact second-wave RED/GREEN evidence (all Vitest commands used
`--maxWorkers=2`):

- RED: `pnpm --filter @biomed/server test -- tests/skill-manifests.test.ts --maxWorkers=2` — 1 of 9 tests failed (8 passed); the new stale-step assertion found step 5 still switched directly to submit.
- GREEN: same skill-manifest command — 9 tests passed.
- RED: `pnpm --filter @biomed/server test -- tests/dynamic-family-build-tool.test.ts -t "publication fence rejects" --maxWorkers=2` — 1 failed, 14 skipped; publication resolved after the HIL gate even after the generation fence was invalidated.
- GREEN: same publication-fence command — 1 passed, 14 skipped; no publication directory was created.
- GREEN: `pnpm --filter @biomed/server test -- tests/dynamic-family-phase3-composition.test.ts --maxWorkers=2` — 1 production-composition test passed, covering duplicate submit, valid old receipt supersession, real build lock, injected Core acquisition, actual Host transform execution, and publication suppression.
- GREEN: covering aggregate — `pnpm --filter @biomed/server test -- tests/dynamic-family-phase3-composition.test.ts tests/dynamic-family-build-tool.test.ts tests/dynamic-family-preflight.test.ts tests/skill-manifests.test.ts tests/family-host-core-dispatch-guard.test.ts tests/acquisition-first-composition.test.ts --maxWorkers=2` — 6 files, 43 tests passed.
- GREEN: `pnpm --filter @biomed/server typecheck` and `pnpm --filter @biomed/server lint` — both passed.

The phase3 composition now exposes trusted test/fixture seams for the real
acquisition, transform, and publication call chain without replacing the
phase3 runtime. The composition test pauses publication after the valid old
receipt has acquired and transformed, starts a superseding prepare while the
build lock is still held, then releases publication; the live fence rejects
before staging and both duplicate submits return errors. The new skill and
composition tests are in `server/tests/skill-manifests.test.ts` and
`server/tests/dynamic-family-phase3-composition.test.ts`.

## Commit and remote state

- Implementation commit: `d014afcbf7d8639ba7091aa01adda3f1b6bffdf6`
  (`feat(server): add dynamic family preflight receipt protocol`).
- Review fix commit: `4b90ac37253c99837c10ee15aaaae80ae72e336b`
  (`fix(server): fence dynamic family preflight consumption`).
- Guard false-positive fix commit: `c981825d8e75d7f6d22586d520fde152ac280a8a`
  (`fix(server): avoid generic core guard false positive`).
- The first review report is pushed at `8e254dea`; this second review fix wave
  is focused-green but uncommitted and awaits the parent's serialized full-gate
  slot before the next normal commit/push.
