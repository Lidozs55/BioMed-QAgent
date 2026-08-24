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

The V2 dynamic tool is strict by default. The explicit `requirePreflight: false`
option remains only for legacy direct unit adapters that exercise the low-level
submit function; phase3 production composition always uses the strict path. The
prepare tool is included in the Dataset Core skill mapping and is marked
task/run-scoped unavailable in the generic business bundle until phase3 injects
its authoritative context.

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
- Strict factory default: the new receipt-only test failed when the factory default was permissive; the default is now strict and the legacy bypass is explicit.

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

The serialized full-gate slot was granted before the following commands were
run, and every command completed successfully in sequence. The recursive test
invocation passed 118 contract tests, 1,594 server tests with 11 intentional
skips, and 836 frontend tests. Every full Vitest invocation used
`--maxWorkers=2`:

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

## Commit and remote state

- Implementation commit: `d014afcbf7d8639ba7091aa01adda3f1b6bffdf6`
  (`feat(server): add dynamic family preflight receipt protocol`).
- The finalized report update is committed next and the resulting branch is
  pushed to `origin/feat/family-host-dynamic-preflight` without force-push.
