# Phase 1A Contracts and Storage Foundation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this
> plan task by task and `test-driven-development` for every behavior change.

**Goal:** Establish the strict, versioned backend contracts and task-local
storage layout required by the deterministic PubMed-to-GEO pipeline, without
breaking the existing MVP tools before they are migrated.

**Architecture:** Add a new `app.domain.contracts` package as the authoritative
pipeline boundary. Existing dataclass models remain compatibility-only until
their callers move to the pipeline. The task work directory adopts the new
source/staging/state layout while retaining a deprecated `raw` property during
the migration. Model credentials are validated only when a model call begins,
so deterministic code and tests can run offline.

**Tech Stack:** Python 3.12, Pydantic v2, pytest, OpenAI Agents SDK, pathlib.

---

## Task 1: Contract base, enums and deterministic IDs

**Files:**

- Create: `backend/app/domain/contracts/base.py`
- Create: `backend/app/domain/contracts/enums.py`
- Create: `backend/app/domain/contracts/ids.py`
- Create: `backend/app/domain/contracts/__init__.py`
- Test: `backend/tests/contracts/test_base_and_ids.py`

**Step 1: Write the failing tests**

Cover these observable rules:

- every contract serializes `schema_version="1.0"`;
- unknown fields are rejected and list defaults are not shared;
- database and data-level enums serialize to their lowercase wire values;
- generated task and attempt IDs use their type prefix plus lowercase UUID4;
- dataset, source, asset and record IDs are deterministic and insensitive only
  to the canonicalization explicitly defined by the design.

**Step 2: Verify RED**

Run:

```powershell
uv run pytest tests/contracts/test_base_and_ids.py -q
```

Expected: collection fails because `app.domain.contracts` does not exist.

**Step 3: Implement the minimum contract primitives**

Use one strict base:

```python
class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)
    schema_version: Literal["1.0"] = "1.0"
```

Define the approved string enums and ID helpers. Hash-derived identifiers use
canonical JSON encoded as UTF-8 and SHA-256, with stable type prefixes.

**Step 4: Verify GREEN**

Run the focused test, then `uv run pytest tests/contracts -q`.

**Step 5: Commit**

```powershell
git add backend/app/domain/contracts backend/tests/contracts/test_base_and_ids.py
git commit -m "feat: add strict pipeline contract primitives"
```

## Task 2: Task, source and file contracts

**Files:**

- Create: `backend/app/domain/contracts/task.py`
- Create: `backend/app/domain/contracts/source.py`
- Update: `backend/app/domain/contracts/__init__.py`
- Test: `backend/tests/contracts/test_task_contracts.py`
- Test: `backend/tests/contracts/test_source_contracts.py`

**Step 1: Write failing contract tests**

Specify `TaskRequest`, `QuerySpecification`, `DatasetSelection`,
`TaskSpecification`, `SourceRecord`, `SourceRelation`, `DownloadAttempt`,
`FileAsset`, `SourceAsset` and `SourceLocator`. Include failures for blank
topics, unsupported extra fields, invalid SHA-256, non-relative/escaping paths,
failed attempts masquerading as assets, and zero-based/one-based locator
violations.

**Step 2: Verify RED**

Run both new files and confirm imports fail for the missing contracts.

**Step 3: Implement minimum Pydantic models**

Use constrained strings and model validators. `SourceAsset` validates
`kind="source"` and paths rooted under `source_assets/`. A successful source
asset refers to an attempt ID; whether that attempt actually succeeded is a
repository-level cross-record validation performed later.

**Step 4: Verify GREEN and regression**

Run the focused files and the full backend unit suite with an offline
environment.

**Step 5: Commit**

```powershell
git add backend/app/domain/contracts backend/tests/contracts
git commit -m "feat: define task and source data contracts"
```

## Task 3: Stage, artifact and run-manifest contracts

**Files:**

- Create: `backend/app/domain/contracts/pipeline.py`
- Update: `backend/app/domain/contracts/__init__.py`
- Test: `backend/tests/contracts/test_pipeline_contracts.py`

**Step 1: Write failing tests**

Test `ErrorDetail`, `WarningRecord`, `ParsedDataset`, `StageAttempt`,
`ArtifactManifestEntry`, `ValidationSummary` and `RunManifest`. Require sorted,
unique manifest ID lists, valid time ordering, valid attempt status fields,
artifact-relative paths under `artifacts/`, and on-disk rather than in-memory
parsed dataset metadata.

**Step 2: Verify RED**

Run the focused test and confirm the new symbols are missing.

**Step 3: Implement minimum models**

Keep recursive JSON values JSON-safe. Model validators enforce invariants that
can be checked within one record; cross-file foreign keys remain the later
Validation Gate's responsibility.

**Step 4: Verify GREEN and regression**

Run focused contracts tests followed by the full backend suite.

**Step 5: Commit**

```powershell
git add backend/app/domain/contracts backend/tests/contracts/test_pipeline_contracts.py
git commit -m "feat: add pipeline and artifact contracts"
```

## Task 4: Typed persisted event envelope

**Files:**

- Create: `backend/app/domain/contracts/events.py`
- Update: `backend/app/domain/contracts/__init__.py`
- Test: `backend/tests/contracts/test_event_contracts.py`

**Step 1: Write failing tests**

Cover all mandatory event payload types, discriminated payload validation,
UUID event IDs, positive task-local sequences, optional stage-attempt linkage,
and rejection of a payload that does not match its event type.

**Step 2: Verify RED**

Run the focused test and confirm imports fail.

**Step 3: Implement minimum event contracts**

Use a Pydantic discriminated union whose payload models each carry a literal
`type`. Keep the legacy `app.domain.events.EventFactory` unchanged until the
runner persistence migration.

**Step 4: Verify GREEN and regression**

Run event contract tests and the full suite.

**Step 5: Commit**

```powershell
git add backend/app/domain/contracts backend/tests/contracts/test_event_contracts.py
git commit -m "feat: define typed pipeline event contracts"
```

## Task 5: Task directory and content-cache layout

**Files:**

- Update: `backend/app/tools/workdir.py`
- Create: `backend/app/tools/content_cache.py`
- Update: `backend/tests/test_workdir.py`
- Create: `backend/tests/test_content_cache.py`

**Step 1: Write failing tests**

Require `source_assets`, `download_tmp`, `parsed`, `normalized`, `staging`,
`artifacts`, `state` and `logs`. Reject unsafe task IDs and filenames at the
path helper boundary. Require run-specific staging directories and canonical
SHA-256 blob/cache-metadata paths. Keep `raw` as a read-only compatibility
alias of `source_assets` and test that explicitly.

**Step 2: Verify RED**

Run the two focused files and verify missing directories/helpers cause the
expected failures.

**Step 3: Implement minimum safe path helpers**

Resolve and check every returned child path remains beneath its intended root.
Do not download or mutate cache contents yet; this task defines layout only.

**Step 4: Verify GREEN and regression**

Run focused tests and the full suite.

**Step 5: Commit**

```powershell
git add backend/app/tools/workdir.py backend/app/tools/content_cache.py backend/tests/test_workdir.py backend/tests/test_content_cache.py
git commit -m "feat: establish pipeline task storage layout"
```

## Task 6: Defer model credential enforcement to execution

**Files:**

- Update: `backend/app/agent_loop/model.py`
- Update: `backend/app/agent_loop/runner.py`
- Create: `backend/tests/test_model_credentials.py`

**Step 1: Write failing tests**

With all DashScope key environment variables absent, app/agent construction
must succeed. Starting an actual Agent run must raise a stable configuration
error before invoking the SDK. With a configured key, the runner proceeds to
the SDK boundary (mock only that network boundary).

**Step 2: Verify RED**

Run the focused test without a placeholder key and confirm eager
`AsyncOpenAI` construction fails.

**Step 3: Implement lazy credential checking**

Avoid constructing `AsyncOpenAI` during deterministic imports or agent
assembly. Add one execution-boundary credential guard with a stable error code
and safe message.

**Step 4: Verify GREEN and full regression**

Run:

```powershell
Remove-Item Env:DASHSCOPE_API_KEY -ErrorAction SilentlyContinue
uv run pytest -q
```

Expected: the complete backend suite passes without real or placeholder model
credentials.

**Step 5: Commit**

```powershell
git add backend/app/agent_loop backend/tests/test_model_credentials.py
git commit -m "fix: defer model credentials until agent execution"
```

## Phase 1A Completion Check

Run:

```powershell
uv run pytest -q
git diff --check
git status --short
```

Then review the branch diff against
`docs/superpowers/specs/2026-07-12-backend-data-closure-design.md`. Phase 1A
does not claim the PubMed/GEO pipeline or artifact validation is implemented;
the next plan begins with real NCBI clients and the pinned fixture.
