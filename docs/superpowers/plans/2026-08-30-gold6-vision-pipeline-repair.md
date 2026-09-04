# Gold6 Vision Pipeline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make frozen Gold6 run from its unchanged prompt and source inventory through governed paper/image extraction, evidence-bound human review, the required six-table bioactivity product, and an immutable Publication whose artifacts are hash-reverified.

**Architecture:** Keep the non-visual main Pi model as the planner and introduce an explicit visual-model role used by a governed Host extraction service. The service accepts only task-owned Core asset IDs, records the actual model and transform provenance, obtains durable review, and registers a rich evidence JSON carrier; Dataset Core remains the only component allowed to parse, validate, assemble, assess, and publish it. Carry the frozen evaluation contract beside the unchanged user prompt as durable run context, never as appended prompt text.

**Tech Stack:** Node.js 22.19+, TypeScript, React 19, Vite, Vitest, Tailwind CSS v4, shadcn/ui, Pi adapter, pdfjs-dist, `@napi-rs/canvas` 1.0.5, pnpm.

## Global Constraints

- Treat the implementation commit being worked on as the source of truth. The two historical Gold6 runs are regression-scenario inputs only, never proof of current behavior.
- Do not edit `docs/evaluation/gold-v1/prompts/gold6.txt`; its SHA-256 must remain `f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298`.
- Preserve the current Agent + deterministic Dataset Core boundary. VLM output is candidate evidence, not a Publication and not a Core-owned scientific value.
- Do not promote arbitrary Agent Workspace files, browser screenshots, or the legacy `parsed/chart_data/*.csv` files into formal carriers.
- Every formal extraction input must be a task-owned SourceAsset registration returned by fixed Core acquisition or deterministic Core archive extraction.
- A non-visual main model must work with an explicitly selected visual model. Do not retain a hidden hard-coded `qwen-vl-max` fallback.
- Never log or serialize raw provider credentials. Publication provenance records provider/model identifiers and versions, not secrets.
- All VLM-derived coordinate values are `estimated` until an evidence-bound user review accepts or corrects them.
- Unclear axis or legend semantics may produce an explicit empty `chart_points` table, but may not publish exact points.
- Keep Python restricted to the existing `database/` bridge. Do not add a Python image-processing runtime, FastAPI service, sandbox, container, or IPC backend.
- New wire DTOs go into `@biomed/contracts` first. Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Start each behavior change with a reproducing Vitest test, make the smallest implementation pass, and commit at the end of each independently reviewable task.

## Current-HEAD Baseline

This plan was written against `origin/main@59daf031` on 2026-08-30. Before implementation, re-run the searches and characterization tests below if `origin/main` has moved.

The baseline has four independently verified gaps:

1. `run-case.mjs` hashes the Gold6 case but sends only the natural-language prompt to `/api/v1/tasks`; the frozen source selection, required tables, and forbidden shortcuts do not reach the run.
2. model settings expose one active model plus editable modality flags; an inactive visual model cannot be selected as a separate runtime role, and VLM configuration is snapshotted at Host bootstrap.
3. `extract_chart_data_vlm` writes preparation CSV/JSON files, while formal chart publication begins from an already rich, manually registered JSON fixture. No production converter and registration service connects the two.
4. frozen Gold6 requires `paper_records`, `experiment_records`, `activity_value_records`, `chart_series`, `chart_points`, and `supplementary_asset_records`; the current publication-closure fixture produces `activities`, `compounds`, `assays`, `targets`, `chart_series`, `chart_points`, `papers`, and `sources`.

## Chosen Approach and Rejected Alternatives

Use an explicit visual-model role plus a governed registered-evidence extraction service. This is the smallest design that supports a non-visual main model without weakening publication trust.

- **Rejected: retain the hidden `qwen-vl-max` fallback.** It ignores configured inactive visual models, depends on bootstrap-time environment state, and records misleading provenance when another model is actually used.
- **Rejected: let the Agent convert workspace CSV into formal JSON.** That would let Agent-authored bytes cross the publication boundary and contradict ADR-007, ADR-029, ADR-034, and the current phase-one prompt.
- **Deferred: create a visual child Agent.** Current server code does not produce managed subagents. Figure extraction is a bounded tool operation; multi-figure research delegation can be designed later without blocking Gold6.

## File and Responsibility Map

- `packages/contracts/src/task-execution-context.ts`: versioned frozen-evaluation context carried separately from user input.
- `packages/contracts/src/model-registry.ts` and `packages/contracts/src/settings.ts`: visual-role assignment and settings response contracts.
- `server/src/settings/model-registry/`: role persistence, migration, validation, and per-call model resolution.
- `server/src/dataset/acquisition/extended-providers.ts`: fixed Europe PMC PDF carrier acquisition.
- `server/src/processing/vlm/registered-paper-chart-extraction.ts`: governed extraction from registered XML/PDF/supplementary assets into rich candidate rows.
- `server/src/agent/tools/extract-registered-paper-chart-evidence.ts`: bounded Agent-facing formal extraction tool.
- `server/src/dataset/families/bioactivity-measurement/paper-evidence/`: the four non-chart Gold6 product tables and deterministic canonical-row derivation.
- `server/src/dataset/families/bioactivity-measurement/chart-evidence/`: existing formal chart tables, locators, transform provenance, and review gates.
- `server/src/runtime/execution-continuation.ts`: persisted continuation for publication-acceptance recovery.
- `docs/evaluation/gold-v1/`: unchanged prompts plus the runner and current-commit assertion/evidence scripts.

---

### Task 1: Carry the frozen Gold6 contract as durable run context

**Files:**
- Create: `packages/contracts/src/task-execution-context.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/task-run.ts`
- Modify: `server/src/agent/contracts.ts`
- Modify: `server/src/agent/pi-adapter.ts`
- Modify: `server/src/runtime/durable-agent-runtime.ts`
- Modify: `server/src/runtime/task-repository.ts`
- Modify: `server/src/runtime/task-reducer.ts`
- Modify: `frontend/src/lib/apiResponseParsers.ts`
- Modify: `docs/evaluation/gold-v1/run-case.mjs`
- Modify: `docs/evaluation/gold-v1/verify.mjs`
- Modify: `docs/evaluation/gold-v1/checksums.sha256`
- Create: `packages/contracts/tests/task-execution-context.test.ts`
- Create: `server/tests/gold-v1-runner.test.ts`
- Modify: `server/tests/pi-adapter.test.ts`
- Modify: `server/tests/durable-runtime.test.ts`
- Modify: `server/tests/task-reducer.test.ts`

**Interfaces:**
- Produces `FrozenEvaluationContextV1` with manifest/case/prompt/runtime hashes, expected family, required tables, allowed sources, source selection, success definition, and forbidden shortcuts.
- Extends `run_queued` and `RunRecord` with `execution_context: TaskExecutionContext | null`.
- Adds `systemContext?: string` to `BioMedSessionConfig`; Pi appends it to the system prompt, never to the user message.

- [ ] **Step 1: Write hostile contract tests**

Add tests that accept the exact Gold6 context and reject unknown keys, missing hashes, duplicate required tables, URL/path-shaped source identifiers, and a context whose `prompt_sha256` differs from the frozen case.

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```powershell
pnpm --filter @biomed/contracts test -- task-execution-context.test.ts
```

Expected: FAIL because `parseTaskExecutionContext` does not exist.

- [ ] **Step 3: Add the versioned DTO and parser**

Use this public shape:

```ts
export interface FrozenEvaluationContextV1 {
  schema_version: "1.0";
  kind: "frozen_evaluation";
  manifest_id: string;
  case_id: string;
  manifest_sha256: string;
  case_spec_sha256: string;
  prompt_sha256: string;
  runtime_profile_sha256: string;
  expected_family: string;
  required_tables: readonly string[];
  allowed_sources: readonly string[];
  source_selection: Readonly<Record<string, readonly string[]>>;
  success_definition: string;
  forbidden_shortcuts: readonly string[];
}
```

The parser must be exact, bounded, UTF-8 clean, and return frozen arrays/objects.

- [ ] **Step 4: Persist and replay the context**

Add a repository test proving request-id idempotency compares the context as well as input/databases/mode, and proving event replay returns byte-equivalent context after Host restart.

- [ ] **Step 5: Verify that prompt bytes remain unchanged**

Start a local capture server in `gold-v1-runner.test.ts`, invoke `run-case.mjs gold6`, and assert:

```ts
expect(request.input).toBe(await readFile(GOLD6_PROMPT, "utf8"));
expect(sha256(request.input)).toBe(GOLD6_PROMPT_SHA256);
expect(request.execution_context?.case_id).toBe("gold6");
expect(request.execution_context?.source_selection.papers).toEqual([
  "PMC10408569", "PMC5355725", "PMC5094958",
]);
```

- [ ] **Step 6: Inject context through the Pi system prompt**

Serialize the validated context with stable key order under a clearly delimited `Frozen execution context` section. Add a Pi adapter test proving the context appears once in `systemPrompt` and never in the upstream user prompt.

- [ ] **Step 7: Run targeted suites and commit**

```powershell
pnpm --filter @biomed/contracts test
pnpm --filter @biomed/server test -- gold-v1-runner.test.ts pi-adapter.test.ts durable-runtime.test.ts task-reducer.test.ts
git add packages/contracts server/src server/tests frontend/src/lib/apiResponseParsers.ts docs/evaluation/gold-v1
git commit -m "feat(evaluation): bind frozen Gold context to runs"
```

### Task 2: Add an explicit visual-model role

**Files:**
- Modify: `packages/contracts/src/model-registry.ts`
- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/runtime/settings.ts`
- Modify: `server/src/settings/model-registry/store.ts`
- Modify: `server/src/settings/model-registry/migration.ts`
- Modify: `server/src/settings/model-registry/service.ts`
- Modify: `server/src/settings/model-registry/model-resolution.ts`
- Modify: `server/src/bootstrap.ts`
- Modify: `server/src/runtime/phase3-composition.ts`
- Create: `frontend/src/components/settings/model/VisionModelSelector.tsx`
- Modify: `frontend/src/components/settings/sections/ModelSettingsSection.tsx`
- Modify: `frontend/src/components/settings/types.ts`
- Modify: `server/tests/model-settings.test.ts`
- Modify: `server/tests/model-settings-migration.test.ts`
- Modify: `server/tests/bootstrap.test.ts`
- Modify: `frontend/src/test/settings-panel.test.tsx`
- Modify: `frontend/src/test/settings-model-validation.test.tsx`

**Interfaces:**
- Adds `vision_model_id: string | null` to registry settings and settings updates.
- Exposes `vision_model_name`, `vision_provider_name`, and `vision_model_ready` as read-only response facts.
- Resolves VLM configuration on each formal extraction call, not once in `bootstrap.ts`.

- [ ] **Step 1: Characterize the required routing behavior**

Add server tests for these exact cases:

1. non-visual active main + selected inactive visual model uses the selected model and its own provider key/base URL;
2. selected model with `capabilities.image=false` is rejected;
3. deleted/disabled visual model clears the assignment and returns an actionable configuration blocker;
4. no assignment + visual active model uses the active model;
5. no assignment + non-visual active model fails closed instead of returning `qwen-vl-max`;
6. a role change after Host bootstrap is visible to the next extraction call without restart.

Before editing frontend components, read the repository `shadcn` skill and reuse the existing Select, Badge, Alert, and settings-section patterns with the `@/` import alias.

- [ ] **Step 2: Run server model tests and confirm RED**

```powershell
pnpm --filter @biomed/server test -- model-settings.test.ts model-settings-migration.test.ts bootstrap.test.ts
```

Expected: the separate-role assertions fail against the single-active-model resolver.

- [ ] **Step 3: Implement role persistence and migration**

Persist the internal managed-model record ID, not a provider model name. Existing registries migrate with `vision_model_id: null`; do not infer a visual role from a manually edited capability during migration.

- [ ] **Step 4: Replace static `vlmConfig` injection with a resolver**

Change runtime composition to consume:

```ts
resolveVlmConfig: () => Promise<{ apiKey: string; baseUrl: string; model: string }>
```

Resolve immediately before the governed extraction request. Keep the API key only in memory and out of tool results/events.

- [ ] **Step 5: Add the settings-page selector**

Render a `视觉抽取模型` selector below the current main model. List only enabled models with `capabilities.image=true`, show provider and credential readiness, and explain that uploaded images are processed by the extraction tool rather than sent directly to the main chat model.

- [ ] **Step 6: Test the non-visual-main workflow**

Add a frontend test selecting a visual model while leaving the current main model unchanged. Assert the saved role, readiness message, and absence of raw credential material.

- [ ] **Step 7: Run targeted suites and commit**

```powershell
pnpm --filter @biomed/server test -- model-settings.test.ts model-settings-migration.test.ts bootstrap.test.ts
pnpm --filter @biomed/frontend test -- settings-panel.test.tsx settings-model-validation.test.tsx
git add packages/contracts server/src frontend/src server/tests
git commit -m "feat(settings): add explicit visual model role"
```

### Task 3: Add fixed Core acquisition for Europe PMC PDFs

**Files:**
- Modify: `server/src/dataset/acquisition/extended-providers.ts`
- Modify: `server/src/dataset/acquisition/provider-catalog.ts`
- Modify: `server/tests/fixed-biomedical-acquisition-providers.test.ts`
- Modify: `server/tests/core-acquisition-provider-catalog.test.ts`
- Modify: `server/tests/phase5/provider-live-smoke.test.ts`
- Modify: `server/tests/dataset-route-preflight.test.ts`

**Interfaces:**
- Produces provider `europepmc.pdf.v1`, source `europepmc_pdf`, accepting exactly one uppercase PMCID and returning a registered `application/pdf` carrier.
- Uses `https://europepmc.org/api/getPdf?pmcid=<PMCID>` with the existing bounded downloader, allow-list, receipt, retry, and SHA-256 logic.

- [ ] **Step 1: Add provider-plan tests**

Assert exact provider ID/source/database/accession, URL, filename `<PMCID>.pdf`, allowed host `europepmc.org`, `application/pdf` media type, and rejection of PMID/DOI/URL/path inputs.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @biomed/server test -- fixed-biomedical-acquisition-providers.test.ts core-acquisition-provider-catalog.test.ts dataset-route-preflight.test.ts
```

- [ ] **Step 3: Register the fixed provider and preflight guidance**

Expose the provider through `acquire_core_carrier`; do not add a second ad-hoc PDF download path. Route preflight should instruct the Agent to acquire one PDF carrier per frozen PMCID.

- [ ] **Step 4: Add an opt-in live smoke case**

Gate the live request behind the existing live-smoke environment switch and verify `%PDF-`, media type, receipt asset ID, bytes, and SHA-256 without storing the downloaded paper in git.

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm --filter @biomed/server test -- fixed-biomedical-acquisition-providers.test.ts core-acquisition-provider-catalog.test.ts dataset-route-preflight.test.ts
git add server/src/dataset/acquisition server/tests
git commit -m "feat(dataset): add governed Europe PMC PDF carrier"
```

### Task 4: Add the four missing paper-bioactivity product tables

**Files:**
- Create: `server/src/dataset/families/bioactivity-measurement/paper-evidence/types.ts`
- Create: `server/src/dataset/families/bioactivity-measurement/paper-evidence/schemas.ts`
- Create: `server/src/dataset/families/bioactivity-measurement/paper-evidence/validation.ts`
- Create: `server/src/dataset/families/bioactivity-measurement/paper-evidence/registered.ts`
- Create: `server/src/dataset/families/bioactivity-measurement/paper-evidence/assembler.ts`
- Create: `server/src/dataset/families/bioactivity-measurement/paper-evidence/index.ts`
- Modify: `server/src/dataset/families/bioactivity-measurement/index.ts`
- Modify: `server/src/dataset/families/registry.ts`
- Modify: `server/src/dataset/runtime/registered-multitable.ts`
- Create: `server/tests/fixtures/bioactivity-paper-evidence/non-gold.valid.json`
- Create: `server/tests/bioactivity-paper-evidence.test.ts`
- Modify: `server/tests/chart-evidence-publication-closure.test.ts`

**Interfaces:**
- Adds formal table IDs `paper_records`, `experiment_records`, `activity_value_records`, and `supplementary_asset_records` without renaming or removing existing canonical tables.
- Deterministically derives stable canonical `activities`, `compounds`, `assays`, and `targets` identities from admitted paper evidence so chart points can reference real primary activity IDs.
- Keeps the frozen six-table projection as a subset of the richer publication, not an evaluation-only alias applied after publication.

- [ ] **Step 1: Freeze schemas from `gold6-reference.json`**

Write schema tests that assert exact table IDs, roles, primary keys, column order, row granularity, provenance fields, and foreign keys. Add hostile fixtures for missing experiment-paper links, missing activity-experiment links, blank raw relation/unit/original text, duplicate composite keys, and unregistered supplementary asset IDs.

- [ ] **Step 2: Run the new suite and confirm RED**

```powershell
pnpm --filter @biomed/server test -- bioactivity-paper-evidence.test.ts
```

- [ ] **Step 3: Implement registered JSON parsers and validation**

Accept only `application/json` SourceAssets, exact JSON pointers matching the four table IDs, SourceLocator 2.0, and registration receipts owned by the current task.

- [ ] **Step 4: Add deterministic canonical identity derivation**

Generate IDs from normalized source-backed identity components and content digests. Never let the Agent or VLM choose canonical IDs. Preserve raw value, raw unit, raw relation, original text, and source locator alongside standardized values.

- [ ] **Step 5: Extend the publication-closure test**

Assert the candidate contains at least the frozen six tables and that every chart point's `activity_id` resolves to a derived canonical activity. Recompute every published artifact SHA-256.

- [ ] **Step 6: Run suites and commit**

```powershell
pnpm --filter @biomed/server test -- bioactivity-paper-evidence.test.ts bioactivity-chart-evidence.test.ts chart-evidence-publication-closure.test.ts
git add server/src/dataset/families server/src/dataset/runtime server/tests
git commit -m "feat(dataset): add paper bioactivity evidence tables"
```

### Task 5: Build governed registered paper/chart extraction

**Files:**
- Create: `server/src/processing/vlm/registered-paper-chart-extraction.ts`
- Modify: `server/src/processing/vlm/index.ts`
- Modify: `server/src/processing/vlm/chart-json.ts`
- Modify: `server/src/processing/vlm/chart-extraction.ts`
- Modify: `server/src/processing/vlm/vlm-client.ts`
- Modify: `server/src/dataset/families/bioactivity-measurement/chart-evidence/types.ts`
- Modify: `server/src/dataset/families/bioactivity-measurement/chart-evidence/schemas.ts`
- Modify: `server/src/dataset/families/bioactivity-measurement/chart-evidence/validation.ts`
- Create: `server/src/agent/tools/extract-registered-paper-chart-evidence.ts`
- Modify: `server/src/runtime/phase3-composition.ts`
- Modify: `server/src/agent/skills/skill-tool-map.ts`
- Modify: `.pi/skills/extract_chart_data_vlm/SKILL.md`
- Create: `server/tests/registered-paper-chart-extraction.test.ts`
- Modify: `server/tests/dynamic-family-phase3-composition.test.ts`
- Modify: `server/tests/skill-manifests.test.ts`

**Interfaces:**
- Consumes only `{ paper_xml_asset_id, paper_pdf_asset_id, supplementary_asset_ids, paper_id, paper_id_namespace }`, with every asset resolved through the current task's `SourceAssetRegistry`.
- Produces one registered JSON carrier containing paper-evidence rows plus `chart_series`, `chart_points`, `papers`, and `sources`, and returns its registration receipt and bounded summary.
- Records actual visual provider/model/version, input/output digests, page/figure/bbox locators, precision, confidence, reliability, and review provenance.

- [ ] **Step 1: Write registry-bound extraction tests**

Use fake registered XML/PDF assets and a fake VLM response. Assert that absolute paths, workspace-relative paths, browser-only registrations, cross-task asset IDs, wrong media types, and unregistered byte digests are rejected before any model call.

- [ ] **Step 2: Run the extraction test and confirm RED**

```powershell
pnpm --filter @biomed/server test -- registered-paper-chart-extraction.test.ts
```

- [ ] **Step 3: Define the model response contract**

Require structured paper, experiment, activity, series, and point candidates. VLM-derived points enter as `estimated`; missing locator, confidence reason, figure identity, axis unit, or legend status must fail or produce an explicit unclear/no-points series.

- [ ] **Step 4: Register the rich carrier atomically**

Serialize with stable key order, compute SHA-256, write under the task-owned Core asset root, and call `SourceAssetRegistry.register`. Return only asset ID, receipt metadata, row counts, and review IDs to the Agent.

- [ ] **Step 5: Preserve the legacy preparation tool boundary**

Keep `extract_chart_data_vlm` available for exploratory workspace CSV output, but update its description and skill text to say that it cannot publish. Formal instructions must name only `extract_registered_paper_chart_evidence` as the promotion path.

- [ ] **Step 6: Verify composition and commit**

```powershell
pnpm --filter @biomed/server test -- registered-paper-chart-extraction.test.ts dynamic-family-phase3-composition.test.ts skill-manifests.test.ts
git add server/src/processing/vlm server/src/dataset/families/bioactivity-measurement/chart-evidence server/src/agent server/src/runtime/phase3-composition.ts server/tests .pi/skills/extract_chart_data_vlm/SKILL.md
git commit -m "feat(vlm): register governed paper chart evidence"
```

### Task 6: Close credential, data-review, error, and restart semantics

**Files:**
- Modify: `server/src/runtime/hil-gate.ts`
- Modify: `server/src/runtime/hil-store.ts`
- Modify: `server/src/runtime/execution-continuation.ts`
- Modify: `server/src/runtime/durable-agent-runtime.ts`
- Modify: `server/src/agent/tools/extract-chart-data-vlm.ts`
- Modify: `server/src/agent/tools/extract-registered-paper-chart-evidence.ts`
- Modify: `server/src/processing/vlm/chart-extraction.ts`
- Modify: `server/tests/phase5/approval-gate.test.ts`
- Modify: `server/tests/phase5/hil-timeout-suspension.test.ts`
- Modify: `server/tests/phase5/vlm.test.ts`
- Modify: `server/tests/durable-agent-runtime.test.ts`
- Modify: `frontend/src/test/hil-data-correction-e2e.test.tsx`

**Interfaces:**
- Provides one coalesced credential approval per run and operation scope; parallel callers await the same pending decision.
- Batches all pending VLM estimates for one carrier into one `data_review` request.
- Persists `PublicationAcceptanceContinuationV1` before requesting publication acceptance and resumes exactly once after restart.
- Marks every `{status:"error"}` tool result with `isError: true`.

- [ ] **Step 1: Add concurrency and semantic-error regressions**

Start four concurrent extraction requests for one run. Assert one credential request, four callers awaiting it, and no `another HIL request is already pending` error. Add a processor-returned error case asserting `isError === true`.

- [ ] **Step 2: Expand data review from low-only to pending estimates**

Review every VLM-derived point whose `review_status` is `pending`, regardless of confidence level. Accept sets review provenance, correct preserves original values and appends `human_correction`, reject removes the point, and skip leaves no publishable estimate.

- [ ] **Step 3: Add restart recovery RED test**

Persist a publication candidate, stop the Host while `publication_acceptance` is pending, reopen the repository, resolve the same review, and assert one Publication with the original candidate digest. Confirm the baseline fails with the current fail-closed recovery message.

- [ ] **Step 4: Implement deterministic publication continuation**

The continuation must bind task/run/requirement, candidate digest, registered inputs, assessment digest, requested review ID, and submission receipt. Reject digest drift, a second resolution, or a different run.

- [ ] **Step 5: Run targeted suites and commit**

```powershell
pnpm --filter @biomed/server test -- phase5/approval-gate.test.ts phase5/hil-timeout-suspension.test.ts phase5/vlm.test.ts durable-agent-runtime.test.ts
pnpm --filter @biomed/frontend test -- hil-data-correction-e2e.test.tsx
git add server/src server/tests frontend/src/test/hil-data-correction-e2e.test.tsx
git commit -m "fix(hil): make visual review and publication recovery durable"
```

### Task 7: Cover vector and page-rendered PDF figures

**Files:**
- Modify: `server/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `server/src/processing/vlm/pdf-pages.ts`
- Modify: `server/src/processing/vlm/pdf-images.ts`
- Modify: `server/src/processing/vlm/chart-extraction.ts`
- Create: `server/tests/phase5/fixtures/pdf/vector-dose-response.pdf`
- Modify: `server/tests/phase5/vlm.test.ts`

**Interfaces:**
- Preserves embedded-raster extraction as the first tier.
- Adds caption-guided page rendering at 144 DPI through `@napi-rs/canvas` 1.0.5 when embedded rasters are absent or unusable.
- Renders at most 12 candidate pages per PDF and carries the 1-based page number plus full-page or detected bbox into SourceLocator 2.0.

- [ ] **Step 1: Add a vector-only PDF regression fixture**

The fixture must contain vector axes, legend text, a dose-response curve, and a caption on the same page, with no image XObject. Assert the current L1 extractor returns no usable image.

- [ ] **Step 2: Add the direct canvas dependency**

```powershell
pnpm --filter @biomed/server add @napi-rs/canvas@1.0.5
```

Expected: only `server/package.json` and `pnpm-lock.yaml` dependency entries change.

- [ ] **Step 3: Implement caption-guided page rendering**

Scan the text layer first, rank pages containing `Fig`, `Figure`, `dose`, `response`, or the extraction hint, render the bounded candidate set, and fall back to the first pages only when no caption candidate exists. Do not render an unbounded full paper.

- [ ] **Step 4: Test locators and resource caps**

Assert the vector fixture reaches the fake VLM, produces the correct page locator, and stops at 12 pages. Add cancellation and render-failure cases that return typed extraction errors.

- [ ] **Step 5: Run cross-cutting gates and commit**

```powershell
pnpm --filter @biomed/server test -- phase5/vlm.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git add server/package.json pnpm-lock.yaml server/src/processing/vlm server/tests/phase5
git commit -m "feat(vlm): render vector PDF chart pages"
```

### Task 8: Wire Gold6 orchestration and prove current-commit closure

**Files:**
- Modify: `server/src/agent/phase1-prompt.ts`
- Modify: `.pi/skills/dataset-construction/SKILL.md`
- Modify: `.pi/skills/extract_chart_data_vlm/SKILL.md`
- Modify: `server/tests/pi-adapter.test.ts`
- Modify: `server/tests/skill-manifests.test.ts`
- Create: `server/tests/gold6-current-head-e2e.test.ts`
- Create: `docs/evaluation/gold-v1/assert-current-run.mjs`
- Modify: `docs/evaluation/gold-v1/README.md`
- Modify: `docs/evaluation/gold-v1/checksums.sha256`
- Modify: `docs/TODO.md`
- Modify: `docs/ISSUES.md`

**Interfaces:**
- Agent sequence: frozen context -> acquire Core XML/PDF/supplement carriers for all three PMCIDs -> governed registered extraction -> bind paper/chart registered parsers -> Core validation/ProductAssessment -> real `publication_acceptance` -> Publication/Artifact verification.
- `assert-current-run.mjs` rejects commit mismatch, context-hash mismatch, missing PMCID coverage, missing required tables, pending/rejected estimates, absent review IDs, stale source receipts, and Artifact API hash mismatch.

- [ ] **Step 1: Add a fake-provider/fake-VLM end-to-end RED test**

Run the full Host route with three fixed PMCID fixtures and a deterministic fake visual model. Assert the exact unchanged Gold6 prompt, all frozen source constraints, the six required tables, accepted/corrected estimates, one publication-acceptance review, and recomputed artifact hashes.

- [ ] **Step 2: Update Agent guidance**

Teach the Agent to treat `execution_context` as binding task semantics but never as publication authority. For Gold6-like work, it must acquire registered XML/PDF/supplement carriers and call the formal extraction tool; if any carrier, visual model, locator, or review is unavailable, return a structured blocker rather than workspace CSV.

- [ ] **Step 3: Run the full local quality gates**

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm docs:check
git diff --check
```

Expected: all commands exit 0. If an unrelated baseline failure remains, prove it on unchanged `origin/main`, record it in `docs/ISSUES.md`, and keep the Gold6 targeted suites green.

- [ ] **Step 4: Commit the orchestration closure**

```powershell
git add server/src/agent server/tests .pi/skills docs/evaluation/gold-v1 docs/TODO.md docs/ISSUES.md
git commit -m "test(gold): prove governed Gold6 vision closure"
```

- [ ] **Step 5: Run one live Gold6 on a frozen commit**

Use one Host and one fresh data root. Verify the manifest, start the Host, run Gold6 with an explicit base URL/output path, resolve real extraction reviews and `publication_acceptance`, then assert the saved run:

```powershell
node docs/evaluation/gold-v1/verify.mjs
node docs/evaluation/gold-v1/run-case.mjs gold6 --base-url http://127.0.0.1:5173 --output data/gold/gold6-current-run.json
node docs/evaluation/gold-v1/assert-current-run.mjs data/gold/gold6-current-run.json
```

Do not reuse either historical Gold6 task. The evidence bundle must identify the implementation commit, task/run/requirement, registered input receipts, reviews, ProductAssessment, Publication, and Artifact API hashes from this run.

- [ ] **Step 6: Sync, merge, and close**

Fetch `origin/main`, use rebase for five or fewer branch commits and merge otherwise, re-run all applicable gates after conflict resolution, merge with `--no-ff`, push `main`, post Commonly `[DONE]`, and mark the existing Gold6/TODO acceptance item complete only after the live assertion passes.

## Final Acceptance Checklist

- [ ] The Gold6 prompt bytes and frozen checksums are unchanged.
- [ ] The run snapshot contains the validated frozen execution context and all three required PMCIDs.
- [ ] A non-visual main model and separately selected visual model complete the extraction route without Host restart.
- [ ] Every formal source is a current-task Core registration with reverified bytes and SHA-256.
- [ ] No workspace CSV or browser screenshot is accepted as a formal carrier.
- [ ] The Publication contains all six frozen required tables with closed paper/experiment/activity/chart/supplement relations.
- [ ] Every estimated point is accepted or corrected; original values survive correction.
- [ ] Unclear axis/legend semantics never publish exact primary points.
- [ ] Actual visual model/version and transform digests appear in provenance.
- [ ] Parallel visual work produces one coalesced credential review rather than HIL conflicts.
- [ ] Publication acceptance survives one deliberate Host restart and publishes exactly once.
- [ ] Artifact API bytes re-hash to the manifest values.
- [ ] The live evidence comes from one current commit, one Host, and one data root; historical runs are not used to fill gaps.

## Execution Handoff

Recommended execution mode is subagent-driven development, one fresh worker per task with specification and code-quality review between tasks. Inline execution is acceptable when only one worker is available, but must retain the task boundaries, RED/GREEN checkpoints, and per-task commits above.
