# Backend Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair every confirmed backend audit finding in severity order with a failing regression test and an independent commit per remediation unit.

**Architecture:** Preserve the Agent plus deterministic Pipeline architecture. Tighten admission, path, provenance, runtime, and artifact invariants at their current ownership boundaries; do not introduce parallel implementations or compatibility shims.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, OpenAI Agents SDK, httpx, pytest, uv, Ruff.

## Global Constraints

- Run all backend commands from `backend/`.
- No production change precedes a failing regression test.
- Do not weaken Validation Gate or security checks to keep an old test green.
- Each task ends with focused green tests, Ruff on changed files, and one commit.
- Network live tests remain opt-in and their absence is reported explicitly.

---

### Task 1: Fixed-case full lineage validation

**Files:**
- Modify: `backend/app/pipeline/stages/validation.py`
- Modify: `backend/app/pipeline/runner.py`
- Test: `backend/tests/pipeline/test_validation_rules.py`
- Test: `backend/tests/pipeline/test_pinned_pipeline.py`

**Interfaces:**
- Consumes: canonical `TaskSpecification`
- Produces: `run_validation(..., max_lineage_checks: int | None)` where `None` means all rows

- [ ] Add a pinned dataset with more than 100 rows and corrupt row 101; assert validation fails.
- [ ] Run the new test and confirm it currently passes incorrectly or publishes valid output.
- [ ] Select unlimited lineage checks only for the canonical pinned acceptance pair.
- [ ] Run both validation test files and Ruff.
- [ ] Commit as `fix: validate every pinned-case lineage row`.

### Task 2: Task-root boundary for VLM and PDF tools

**Files:**
- Modify: `backend/app/skills/builtin/processing/extract_chart_data_vlm.py`
- Modify: `backend/app/skills/builtin/processing/extract_tables.py`
- Test: `backend/tests/test_skill_extract_chart_data_vlm.py`
- Test: `backend/tests/test_skill_extract_tables.py`

**Interfaces:**
- Produces: shared `_resolve_task_local_source(path, workdir) -> Path`

- [ ] Add tests for absolute external paths and task-internal symlink escapes.
- [ ] Verify both tools currently accept at least the external-path case.
- [ ] Resolve and contain paths before extension checks or file reads.
- [ ] Run both skill test files and Ruff.
- [ ] Commit as `fix: confine processing inputs to task workdirs`.

### Task 3: Relational provenance validation

**Files:**
- Modify: `backend/app/pipeline/stages/validation.py`
- Test: `backend/tests/pipeline/test_validation_rules.py`

- [ ] Add a valid package whose main row swaps to another valid source/asset chain.
- [ ] Confirm the current gate accepts it.
- [ ] Validate dataset, sample, source, asset, and attempt as one chain.
- [ ] Run validation tests and Ruff.
- [ ] Commit as `fix: validate relational provenance chains`.

### Task 4: Managed child credential HIL

**Files:**
- Modify: `backend/app/agent_loop/context.py`
- Modify: `backend/app/subagents/input_broker.py`
- Test: `backend/tests/subagents/test_agents.py`
- Test: `backend/tests/test_skill_gateway.py`
- Test: `backend/tests/runtime/test_manager.py`

- [ ] Add a production-path child test that requests credential approval.
- [ ] Confirm it returns `credential_hil_unavailable`.
- [ ] Inherit managed identity/runtime and register pending input before emitting it.
- [ ] Cover an immediate resume racing the event consumer.
- [ ] Run focused subagent/runtime tests and Ruff.
- [ ] Commit as `fix: connect managed child credential approval`.

### Task 5: Admission-time model snapshot

**Files:**
- Modify: `backend/app/runtime/manager.py`
- Modify: `backend/app/agent_loop/runner.py`
- Test: `backend/tests/agent_loop/test_run_model_settings.py`
- Test: `backend/tests/runtime/test_manager.py`

- [ ] Queue a Run under settings A, change globals to B, then assert execution uses A.
- [ ] Confirm the new test fails with B.
- [ ] Store settings on `RunExecution` at admission and consume only that snapshot.
- [ ] Run focused settings/runtime tests and Ruff.
- [ ] Commit as `fix: freeze model settings at run admission`.

### Task 6: Cache constraint revalidation

**Files:**
- Modify: `backend/app/integrations/acquisition.py`
- Test: `backend/tests/integrations/test_acquisition.py`

- [ ] Add cache-hit tests for smaller max size, wrong expected size/hash, and media type.
- [ ] Confirm all incompatible cache hits currently succeed.
- [ ] Apply current constraints to cached metadata/blob before publishing.
- [ ] Run acquisition tests and Ruff.
- [ ] Commit as `fix: enforce acquisition constraints on cache hits`.

### Task 7: PubMed supplementary safe acquisition

**Files:**
- Modify: `backend/app/skills/builtin/discovery/pubmed.py`
- Modify: `backend/app/integrations/acquisition.py`
- Test: `backend/tests/test_skill_pubmed.py`

- [ ] Add redirect-host, oversized-stream, and provenance-output tests.
- [ ] Confirm the legacy direct download violates them.
- [ ] Route files through bounded content-addressed acquisition and register attempts/assets.
- [ ] Run PubMed and acquisition tests plus Ruff.
- [ ] Commit as `fix: acquire PubMed supplements through safe pipeline`.

### Task 8: Deterministic cleaning transformation

**Files:**
- Modify: `backend/app/pipeline/stages/processing.py`
- Test: `backend/tests/pipeline/test_processing_cleaning.py`

- [ ] Add rows with whitespace, missing sentinels, duplicates, and ambiguous type mismatches.
- [ ] Confirm Artifact Build would currently receive unchanged rows.
- [ ] Transform safe cases, preserve ambiguous values as warnings, and refresh file metadata.
- [ ] Run processing/Pipeline tests and Ruff.
- [ ] Commit as `feat: publish deterministically cleaned parsed data`.

### Task 9: Fail-closed source combination contract

**Files:**
- Modify: `backend/app/pipeline/tool.py`
- Modify: `backend/app/pipeline/stages/discovery.py`
- Modify: `backend/app/domain/contracts/enums.py`
- Test: `backend/tests/pipeline/test_tool.py`
- Test: `backend/tests/pipeline/test_discovery.py`

- [ ] Add unsupported PubMed-only, multi-GEO, and literature-plus-data-dataset tests.
- [ ] Demonstrate current silent dropping or late failure.
- [ ] Centralize supported combinations and reject unsupported specifications before network work.
- [ ] Run tool/discovery tests and Ruff.
- [ ] Commit as `fix: make pipeline source support fail closed`.

### Task 10: Evidence-backed source relationships

**Files:**
- Modify: `backend/app/pipeline/stages/artifact_build.py`
- Modify: `backend/app/pipeline/stages/validation.py`
- Test: `backend/tests/pipeline/test_artifact_build.py`

- [ ] Pair an unrelated PMID and GSE and assert no `geo_pubmed_id` relation is emitted.
- [ ] Confirm the relation is currently unconditional.
- [ ] Emit the relation only when GEO evidence contains the PMID and validate relation endpoints/evidence.
- [ ] Run artifact/validation tests and Ruff.
- [ ] Commit as `fix: require evidence for literature dataset relations`.

### Task 11: Evidence-bearing child completion

**Files:**
- Modify: `backend/app/subagents/agents.py`
- Test: `backend/tests/subagents/test_agents.py`

- [ ] Add normal SDK output with no asset/recipe and expect typed failure.
- [ ] Confirm it currently produces `COMPLETED`.
- [ ] Require verifiable output for success while preserving evidence-bearing paths.
- [ ] Run subagent tests and Ruff.
- [ ] Commit as `fix: reject evidence-free child completion`.

### Task 12: Real live acceptance semantics

**Files:**
- Modify: `backend/tests/live/test_pipeline_live.py`
- Modify: `backend/tests/live/test_all_data_sources_live.py`

- [ ] Require explicit pinned accessions and a completed valid manifest.
- [ ] Correct adapter assertions to current response contracts and remove success-on-error branches.
- [ ] Run collection plus fixture-mode equivalents; report live execution separately.
- [ ] Commit as `test: require successful live pipeline acceptance`.

### Task 13: Artifact schema and audit-log closure

**Files:**
- Modify: `backend/app/pipeline/processing/xena_matrix.py`
- Modify: `backend/app/pipeline/processing/gdc.py`
- Modify: `backend/app/pipeline/stages/artifact_build.py`
- Modify: `backend/app/pipeline/stages/acquisition.py`
- Test: `backend/tests/pipeline/test_multisource_merge.py`
- Test: `backend/tests/pipeline/test_reactome_pipeline.py`

- [ ] Assert gene version/integer metadata, derived sample counts, per-source parse logs, and derived Reactome asset identity.
- [ ] Confirm the current artifacts violate each invariant.
- [ ] Preserve schema metadata and model every transformation edge explicitly.
- [ ] Run multisource/Reactome tests and Ruff.
- [ ] Commit as `fix: close artifact schema and processing lineage`.

### Task 14: Accumulative chart outputs

**Files:**
- Modify: `backend/app/skills/builtin/processing/extract_chart_data_vlm.py`
- Test: `backend/tests/test_skill_extract_chart_data_vlm.py`

- [ ] Invoke extraction twice and assert both chart sets remain.
- [ ] Confirm the second call overwrites the first.
- [ ] Merge by stable chart/point identifiers and atomically rewrite combined CSVs.
- [ ] Run VLM skill tests and Ruff.
- [ ] Commit as `fix: preserve chart results across extractions`.

### Task 15: Local-origin WebSocket policy

**Files:**
- Modify: `backend/app/api/ws.py`
- Test: `backend/tests/api/test_websocket_replay.py`

- [ ] Add allowed, missing, and hostile Origin handshake tests.
- [ ] Confirm hostile Origin is currently accepted.
- [ ] Enforce the configured local origins while preserving non-browser clients without Origin.
- [ ] Run WebSocket tests and Ruff.
- [ ] Commit as `fix: enforce websocket origin policy`.

### Task 16: Semantic request idempotency

**Files:**
- Modify: `backend/app/runtime/manager.py`
- Modify: `backend/app/domain/contracts/runtime.py`
- Test: `backend/tests/runtime/test_manager.py`
- Test: `backend/tests/api/test_import_api.py`

- [ ] Reuse one request ID across different mode/input/database/upload semantics and expect conflict.
- [ ] Confirm the current manager returns the prior acceptance.
- [ ] Persist a canonical request fingerprint and compare it on idempotent lookup.
- [ ] Run manager/import tests and Ruff.
- [ ] Commit as `fix: validate request idempotency semantics`.

### Task 17: Final verification and integration

- [ ] Run `uv run pytest`.
- [ ] Run `uv run ruff check app/ tests/ launcher.py`.
- [ ] Run compile/import and cold Uvicorn health smoke checks.
- [ ] Re-read `AGENTS.md`, sync Commonly tasks and documentation, and inspect every commit.
- [ ] Merge the completed branch into `main`, rerun the full gates, and push without force.
