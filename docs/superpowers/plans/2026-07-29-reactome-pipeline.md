# Reactome Pipeline Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a validated Reactome pathway-participants pipeline path from explicit pathway selection through deterministic artifact publication.

**Architecture:** Reactome is accepted only through an explicit `pathway_id` in `TaskSpecification` and only as a single Reactome source. Discovery creates a Reactome `SourceRecord`, Acquisition obtains the ContentService participant JSON through the existing verified `acquire_source()` path (with fixture coverage), Processing converts it to a lineage-preserving long CSV, and Artifact Build/Validation publish only validated output. Mixed-source requests are rejected; broader multi-source merging remains a later extension.

**Tech Stack:** Python 3.12, FastAPI backend contracts, Pydantic v2, `httpx`, existing `acquire_source()`, pytest, Ruff.

---

### Task 1: Define the explicit Reactome input contract

**Files:**
- Modify: `backend/app/domain/contracts/task.py`
- Modify: `backend/app/pipeline/tool.py`
- Test: `backend/tests/pipeline/test_pipeline_tool.py`

- [x] **Step 1: Write failing contract tests**

Add tests asserting that a Reactome pathway identifier creates a `DatasetSelection` with `database=Database.REACTOME`, `accession=pathway_id`, and `data_type="pathway-participants"`; missing pathway identifiers must not create a Reactome dataset.

- [x] **Step 2: Run the focused tests**

Run: `uv run pytest tests/pipeline/test_pipeline_tool.py -q`
Expected: FAIL because the tool does not yet accept or serialize `reactome_pathway_id`.

- [x] **Step 3: Implement the minimum contract change**

Add the optional `reactome_pathway_id` tool argument and include it in `_build_tool_specification()` only when `reactome` is selected. Normalize the identifier as a non-empty explicit accession; do not add topic search or arbitrary pathway inference.

- [x] **Step 4: Re-run the focused tests**

Run: `uv run pytest tests/pipeline/test_pipeline_tool.py -q`
Expected: PASS.

---

### Task 2: Add Reactome Discovery and fixture acquisition

**Files:**
- Modify: `backend/app/pipeline/stages/base.py`
- Modify: `backend/app/pipeline/stages/discovery.py`
- Modify: `backend/app/pipeline/stages/acquisition.py`
- Create: `backend/tests/fixtures/reactome/pathway_participants.tsv`
- Test: `backend/tests/pipeline/test_reactome_acquisition.py`

- [x] **Step 1: Write failing fixture tests**

Test that explicit `Database.REACTOME` selection produces one `SourceRecord` and that fixture acquisition writes a `SourceAsset` and successful `DownloadAttempt` whose source IDs match. Assert the fixture asset is copied byte-for-byte into `source_assets/`.

- [x] **Step 2: Run the tests**

Run: `uv run pytest tests/pipeline/test_reactome_acquisition.py -q`
Expected: FAIL because Discovery and Acquisition are still GEO/GDC/Xena-specific.

- [x] **Step 3: Implement Discovery routing**

Add the Reactome branch before the PubMed/GEO fallback. Use the ContentService URL `https://reactome.org/ContentService/data/participants/{pathway_id}` as the source URL, create a deterministic Reactome source ID, preserve the supplied specification, and populate the generic dataset fields in `DiscoveryOutput`.

- [x] **Step 4: Implement fixture and live acquisition entry points**

Use `pathway_id` as the explicit accession. Fixture mode reads `pathway_participants.tsv`; live mode calls `acquire_source()` with the ContentService URL, a deterministic filename, `DataLevel.REPOSITORY_PROCESSED`, the configured cache, and the existing byte limit. Parse response metadata only through the existing acquisition contract; failed HTTP responses or empty payloads must not return a successful asset.

- [x] **Step 5: Re-run acquisition tests**

Run: `uv run pytest tests/pipeline/test_reactome_acquisition.py -q`
Expected: PASS.

---

### Task 3: Implement the Reactome participant parser

**Files:**
- Create: `backend/app/pipeline/processing/reactome.py`
- Modify: `backend/app/pipeline/stages/processing.py`
- Test: `backend/tests/pipeline/test_reactome_processing.py`

- [x] **Step 1: Write failing parser tests**

Cover TSV parsing, UTF-8 and TSV.GZ input, preservation of source line numbers and raw participant values, rejection of missing required columns, rejection of blank pathway/participant IDs, and deterministic `ParsedDataset` metadata.

- [x] **Step 2: Run parser tests**

Run: `uv run pytest tests/pipeline/test_reactome_processing.py -q`
Expected: FAIL because the parser does not exist.

- [x] **Step 3: Implement the parser**

Require the fixture contract columns `pathway_id`, `pathway_name`, `participant_id`, `participant_name`, `participant_type`, `species`, and `interaction_type`. Emit `parsed/{dataset_id}_pathway_members.csv` with stable columns, `record_id`, `source_id`, `asset_id`, `source_logical_file`, `source_line_number`, `source_column_index`, `source_column_name`, and `source_raw_value`. Verify the source asset checksum before reading and the generated file checksum before returning `ParsedDataset`.

- [x] **Step 4: Add processing routing**

Route Reactome assets by `Database.REACTOME`/`data_type`, call the parser, produce the existing cleaning report and field alignment output, and reject mixed unsupported assets instead of silently treating them as GEO.

- [x] **Step 5: Re-run parser and processing tests**

Run: `uv run pytest tests/pipeline/test_reactome_processing.py -q`
Expected: PASS.

---

### Task 4: Publish Reactome artifacts and validate lineage

**Files:**
- Modify: `backend/app/pipeline/stages/artifact_build.py`
- Modify: `backend/app/pipeline/stages/validation.py`
- Modify: `backend/app/skills/builtin/__init__.py`
- Modify: `backend/tests/test_builtin_skill_catalog.py`
- Test: `backend/tests/pipeline/test_reactome_processing.py`

- [x] **Step 1: Add failing end-to-end test**

Run a fixture Reactome `PipelineRunner` with `requested_outputs=[RequestedOutput.MAIN_DATA]`; assert completed task state, valid validation status, `main_data.csv` existence, participant row count, and source-lineage fields. Assert malformed participant data fails validation and produces no published artifact.

- [x] **Step 2: Implement artifact routing**

Make `artifact_build` use the parsed dataset columns and source metadata rather than GEO-only hard-coded columns. Publish `pathway_members.csv` as the Reactome main data artifact while retaining common provenance artifacts. Do not fabricate literature or sample metadata for Reactome.

- [x] **Step 3: Implement validation rules**

Require non-empty pathway and participant identifiers, unique record IDs, valid source/asset references, and valid source line/column locators. Ensure only the Reactome artifact that passes these checks reaches `artifacts/`.

- [x] **Step 4: Update capability declarations**

Add `reactome` to the pipeline-supported set only after the complete fixture and live acquisition contract tests pass. Update the skill catalog assertions and the explicit architecture/TODO capability boundary.

- [x] **Step 5: Re-run end-to-end tests**

Run: `uv run pytest tests/pipeline/test_reactome_processing.py tests/test_builtin_skill_catalog.py -q`
Expected: PASS.

---

### Task 5: Full verification and change review

**Files:**
- Modify: `docs/TODO.md`
- Modify: `docs/ARCHITECTURE.md`

- [x] **Step 1: Run the complete relevant backend suite**

Run: `uv run pytest tests/pipeline tests/integrations/test_acquisition.py tests/test_builtin_skill_catalog.py -q`
Expected: PASS with no warnings treated as errors.

- [x] **Step 2: Run lint**

Run: `uv run ruff check app/ tests/`
Expected: `All checks passed!`

- [x] **Step 3: Inspect generated-file hygiene**

Run: `git status --short --untracked-files=all`
Expected: only Reactome implementation, tests, fixture, capability/docs changes, and intentional existing work; no `backend/tmp-*` or generated CSV output.

- [x] **Step 4: Update project tracking**

Mark the Reactome Discovery, Acquisition, Processing, and initial validation tasks complete in `docs/TODO.md`; document that Reactome support is limited to explicit single-pathway selection and record the ContentService URL in `docs/ARCHITECTURE.md`.

- [x] **Step 5: Review the final diff**

Run: `git diff --check` and `git diff --stat`.
Expected: no whitespace errors; diff contains no unrelated generated files or broad refactors.
