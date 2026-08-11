# Task 11 — Phase 1F offline vertical slice report

Status: complete, with the root recursive gates infrastructure-blocked after
the equivalent package gates passed (details below).

Branch/worktree: `migration/pi-runtime-phase0-1` in the assigned migration
worktree.

Starting HEAD: `64d2c3c`

Commit: the commit containing this report, `test: prove Pi migration vertical
slice` (resolve with `git rev-parse HEAD`; no push was performed).

## Genuine RED evidence

- Prompt/Skills composition first failed collection because
  `src/agent/phase1-prompt.ts` did not exist.
- Explicit fixture selection then failed because the normal adapter was used
  even when `fixture_profile` was supplied.
- Pi prompt/resource injection failed because the upstream session received no
  Phase 1 system prompt.
- The cross-language E2E first failed collection because
  `src/agent/phase1-composition.ts` did not exist. Subsequent RED runs timed out
  waiting for protected-path and cancellation events before those paths were
  implemented.
- Frontend projection first failed because `datasetBuild` was absent from the
  projected run, then the component test failed because the publication status
  card did not exist.

Each production change followed its corresponding focused failure. A final
frontend matcher adjustment only disambiguated the same actual IDs appearing
in both the assistant message and the status card; it did not change production
behavior.

## Prompt, Skills, and fixture boundary

- The minimal system prompt contains only the five frozen authority rules:
  Dataset Core owns formal artifacts; Agent writes are limited to
  `staging/agent/`; validation precedes execution; rejection, `NO_DATA`,
  cancellation, and failure are never success; temporary work and development
  commands use the governed Workspace.
- `.pi/skills/` contains only the migration smoke Skill and the concise
  `dataset-construction` Skill. No GEO, GDC, Xena, research-strategy, or legacy
  long-prompt SOP was migrated.
- `pi-adapter.ts` is the sole Pi resource-composition boundary. Missing optional
  Skill files produce a bounded diagnostic and leave the optional root empty;
  they do not prevent Host startup.
- The deterministic session is selected only by the explicit experimental
  `fixture_profile` allowlist. Null, omitted, and unknown values cannot silently
  select it. Normal requests still use the real Pi adapter.
- The offline session implements the same BioMed adapter/session/tool/workspace
  interfaces as Pi, but it is scripted and makes no provider/model call. The
  real Pi 0.82.1 boundary, prompt injection, import confinement, event mapping,
  cancellation, and lifecycle remain covered separately by the focused Pi
  adapter suite. This task does not claim a live-model E2E.

## Scenario evidence

### A — Workspace

The single public-Host E2E creates an explicit `workspace` task, subscribes via
the experimental WebSocket, and observes the real governed tools read the local
task fixture, write and precondition-edit `staging/agent/note.txt`, and execute
a bounded cross-platform Node command. The final bytes are
`fixture note: observed`, and the command result contains
`fixture-command-ok`.

Attempts to edit both `artifacts/` and `state/` return error tool completions.
The append-only audit contains read, write, edit, and exec records while
excluding the bridge secret and the absolute executable path.

### B — DatasetBuild SUCCESS

The `dataset_success` profile reads a committed local GDC TSV copied into the
task source area, constructs the committed frozen spec, invokes the real
TypeScript validate tool, and then invokes the real execute tool. The tool uses
the loopback private bridge and the lifespan-owned Python V2 Dataset Core. The
Core, not the fixture session or test, publishes the immutable result.

The public event stream returns the actual `golden_succeeded` build identity
and generated publication, manifest, and logical artifact references. The
assistant message repeats those actual identities. The public legacy builds API
observes the same publication and `primary_dataset` role, including stable
schema digest
`a9c62815e6161c13bd2e221e07c9d006372ae67500924e2628f826a04ae8f624`.
A second user turn reuses the same session ID and reports the earlier real
publication rather than constructing another session.

### C — SPEC_REJECTED

The `spec_rejected` profile uses the committed rejected golden spec. Real
validation returns structured `unknown_schema`; the tool completion is an
error and the assistant response says `SPEC_REJECTED` with the same reason.
Execute is not called, no publication is claimed, and no
`artifacts/publication.json` exists.

The frontend projector maps the real success-shaped and rejection-shaped tool
outputs separately. Success retains actual build/publication/manifest/artifact
references. Rejection retains `unknown_schema` with all publication identities
null, so the success card is conditional on `succeeded`; the UI also keeps the
visible live-only/non-durable warning.

### D — cancellation and lifecycle

The `workspace_cancel` profile starts a real governed long-running command. The
public cancel route returns 202, the stream emits `run_cancel_requested` and
then acknowledged `run_cancelled`, and no `run_completed` is observed. Both the
active-run and active-command counters return to zero.

After WebSocket and Host closure, deterministic diagnostics are exactly zero
for tasks, active runs, event listeners, WebSockets, and active commands. The
owned Python health port is unreachable. Temporary output deletion retries for
at most one second to accommodate bounded Windows SQLite handle release; all
teardown remains in `finally`/`afterEach`.

The bridge cancellation limitation remains explicit: TypeScript cancellation
uses the separate side channel but awaits the bounded original Python response;
transport loss or acknowledgement timeout is `bridge_unavailable`, not an
acknowledged cancellation. The focused Python bridge suite exercised the real
Core cancellation path from Task 10. This Phase 1F E2E exercises cancellation
of the active Workspace/run/tool path and does not disguise that bridge
transport limitation.

## Process, port, and network discipline

- The E2E starts the worktree backend venv Python executable directly with
  `-m uvicorn`; it does not wrap the child in `uv` or `Start-Process`.
- Legacy and public ports are loopback ephemeral ports. Python receives an
  isolated temporary `OUTPUT_DIR` and a per-run migration secret.
- The public Host proxies `/api/v1/health` successfully while returning 404 for
  `/internal/migration/pi/dataset/operations`.
- The fixture uses only committed files and loopback HTTP/WebSocket traffic.
  There are no model, provider, registry, npm, or biomedical network calls.
- Host closure owns and terminates the Python child; process, listener, session,
  socket, command, and port cleanup are asserted rather than inferred.

## Exact verification

- Focused Phase 1 composition plus Pi adapter: 2 files, 16 tests passed during
  prompt/fixture GREEN.
- Focused server vertical/regression set: 9 files, 56 tests passed, including
  Phase 1F E2E, Pi adapter, Host/WS lifecycle, Workspace, Workspace tools,
  Dataset Core client, and DatasetBuild tools.
- Focused frontend projection and boundary: 2 files, 7 tests passed.
- Focused backend private bridge plus migration golden: 24 tests passed in
  9.73 seconds.
- No Python file changed in Task 11, so touched-Python Ruff is not applicable.
- Server lint, typecheck, and build: passed.
- Frontend lint, typecheck, and build: passed. The existing Vite chunk-size
  advisory remains non-fatal.
- `git diff --check`: passed before report creation and is repeated before
  commit.

The required root finite commands could not be completed after the package
gates above. At the start of `pnpm test`, PowerShell reported that `pnpm` was no
longer a recognized command; `node` was also absent, and the existing
`C:\nvm4w\nodejs` link no longer resolved to an available runtime in the
permitted environment. The command exited in 1.6 seconds before running any
test. No repository code installed, removed, or reconfigured Node, and this
task did not install or mutate the external runtime. Consequently root
`pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` are recorded as
infrastructure-blocked, not passed. Task 12 must rerun these four finite gates
after the user restores the Node runtime; the already-passed server/frontend
package lint/typecheck/build gates provide partial equivalent coverage but do
not replace the recursive root test gate (including contracts and the full
frontend suite).

## Final-gate notes

- No broad review was performed; Task 12 owns the only whole-branch review and
  the rerun of the infrastructure-blocked root gates.
- Commonly remained out of scope.
- No push was performed.
