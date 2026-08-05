# Backend P0 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the six verified backend release blockers while preserving the deterministic Pipeline and durable runtime contracts.

**Architecture:** Apply fail-closed, contract-preserving fixes at the existing API and Pipeline stage boundaries. Each blocker gets a regression test, the smallest production change, focused verification, and an independent commit; the final pass updates architecture/TODO claims and runs all backend release gates.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, httpx, pytest with strict asyncio, uv, Ruff, Git worktrees.

## Global Constraints

- Work only in `D:/coding/BioMed-QAgent/.worktrees/backend-review-remediation` on branch `codex/backend-review-remediation`.
- Run every backend command from `backend/`.
- Write the failing regression test and observe the intended failure before changing production code.
- Do not add dependencies, suppress type errors, or create a new source-adapter framework.
- Live failures remain failures; metadata-only or mock data cannot satisfy a live validation gate.
- Preserve existing fixture behavior except where a fixture explicitly encoded the invalid placeholder-success contract.
- Stage and commit each numbered repair independently.

---

## File Map

- `backend/app/api/settings.py`: choose whether a preview may reuse the saved credential.
- `backend/app/pipeline/runner.py`: canonical checkpoint parameter fingerprints and live fixture independence.
- `backend/app/pipeline/stages/acquisition.py`: GEO client lifetime, official GDC query mapping, multi-source acquisition, Xena identity.
- `backend/app/pipeline/stages/discovery.py`: resolve all selected GDC/Xena datasets.
- `backend/app/pipeline/processing/geo_tximport.py`: parse real GEO series-matrix values.
- `backend/app/pipeline/processing/gdc.py`: parse official single-sample STAR-counts TSV.
- `backend/app/pipeline/stages/processing.py`: route series-matrix fallback to the value parser.
- `backend/app/pipeline/stages/validation.py`: require scientific values and a non-vacuous lineage check.
- `backend/tests/api/test_model_preview_security.py`: credential-boundary regression.
- `backend/tests/pipeline/test_pipeline_runner_recovery.py`: specification-sensitive reuse regression.
- `backend/tests/pipeline/test_pipeline_runner_resilience.py`: missing fixture directory in live mode.
- `backend/tests/pipeline/test_geo_tximport_processing.py`: populated/empty series-matrix behavior.
- `backend/tests/pipeline/test_acquisition_download_log.py`: GEO client lifetime and attempts.
- `backend/tests/pipeline/test_validation_rules.py`: reject metadata-only packages.
- `backend/tests/pipeline/test_gdc_acquisition.py`: official GDC filter and live clinical rejection.
- `backend/tests/pipeline/test_gdc_processing.py`: official STAR-counts parsing and lineage.
- `backend/tests/pipeline/test_multisource_merge.py`: entry-to-validation GDC + Xena closure.
- `docs/ARCHITECTURE.md`, `docs/TODO.md`: truthful support and acceptance claims.

### Task 1: Keep saved credentials on the saved endpoint

**Files:**
- Modify: `backend/app/api/settings.py:183-201`
- Test: `backend/tests/api/test_model_preview_security.py`

**Interfaces:**
- Consumes: `ModelPreviewRequest.preview_base_url`, `preview_api_key`, and `ModelSettingsStore.snapshot()`.
- Produces: `_preview_api_key(body: ModelPreviewRequest, current: ModelConfiguration) -> str`.

- [ ] **Step 1: Write the failing cross-endpoint test**

Add a test that saves `stored-secret` for `https://saved.provider.example/v1`,
previews `https://other.provider.example/v1` with an empty explicit key, and
captures the outbound request:

```python
assert outbound.headers.get("Authorization") is None
```

Add the compatibility assertion for the same normalized endpoint:

```python
assert outbound.headers["Authorization"] == "Bearer stored-secret"
```

- [ ] **Step 2: Verify red**

Run:

```powershell
uv run pytest tests/api/test_model_preview_security.py -k "saved_key" -v
```

Expected: the cross-endpoint case fails because it receives
`Bearer stored-secret`.

- [ ] **Step 3: Implement the minimal endpoint comparison**

```python
def _preview_api_key(
    body: ModelPreviewRequest,
    current: ModelConfiguration,
) -> str:
    if body.preview_api_key:
        return body.preview_api_key
    if body.preview_base_url.rstrip("/") == str(current.base_url).rstrip("/"):
        return current.api_key
    return ""
```

Use this helper in `list_models`; leave the network-safety boundary unchanged.

- [ ] **Step 4: Verify green and lint**

```powershell
uv run pytest tests/api/test_model_preview_security.py tests/api/test_model_preview_catalog.py -v
uv run ruff check app/api/settings.py tests/api/test_model_preview_security.py
```

- [ ] **Step 5: Commit**

```powershell
git add backend/app/api/settings.py backend/tests/api/test_model_preview_security.py
git commit -m "fix: keep model preview credentials on configured endpoint"
```

### Task 2: Make checkpoint reuse specification-safe

**Files:**
- Modify: `backend/app/pipeline/runner.py:1084-1105`
- Test: `backend/tests/pipeline/test_pipeline_runner_recovery.py`

**Interfaces:**
- Consumes: `PipelineRunner.databases`, `.specification`, `.mode`, and `.fixture_dir`.
- Produces: a parameter digest that changes for any canonical input-specification change.

- [ ] **Step 1: Write failing digest/reuse tests**

Construct two runners for the same task/topic with specifications that differ
only in a GDC data type or a selected database, then assert:

```python
first = runner_a._compute_parameter_digest(StageName.DISCOVERY)
second = runner_b._compute_parameter_digest(StageName.DISCOVERY)
assert first != second
```

Run a recovery pair and assert Discovery is executed rather than emitted as a
reused `stage_skipped` attempt when the specification changes.

- [ ] **Step 2: Verify red**

```powershell
uv run pytest tests/pipeline/test_pipeline_runner_recovery.py -k "specification or database" -v
```

Expected: both parameter digests are equal, or the changed run reuses the old
Discovery output.

- [ ] **Step 3: Hash canonical inputs**

Extend the digest payload with:

```python
"databases": sorted(self.databases),
"specification": (
    self.specification.model_dump(mode="json")
    if self.specification is not None
    else None
),
```

Keep fixture hashing unchanged for this commit; Task 4 will make it mode-aware.

- [ ] **Step 4: Verify green**

```powershell
uv run pytest tests/pipeline/test_pipeline_runner_recovery.py tests/pipeline/test_pipeline_runner_state_machine.py -v
uv run ruff check app/pipeline/runner.py tests/pipeline/test_pipeline_runner_recovery.py
```

- [ ] **Step 5: Commit**

```powershell
git add backend/app/pipeline/runner.py backend/tests/pipeline/test_pipeline_runner_recovery.py
git commit -m "fix: fingerprint pipeline specifications for recovery"
```

### Task 3: Close the GEO real-value path

**Files:**
- Modify: `backend/app/pipeline/stages/acquisition.py:640-720`
- Modify: `backend/app/pipeline/processing/geo_tximport.py`
- Modify: `backend/app/pipeline/stages/processing.py:30-130,640-700`
- Modify: `backend/app/pipeline/stages/validation.py:430-770`
- Test: `backend/tests/pipeline/test_acquisition_download_log.py`
- Test: `backend/tests/pipeline/test_geo_tximport_processing.py`
- Test: `backend/tests/pipeline/test_validation_rules.py`

**Interfaces:**
- Produces: `process_geo_series_matrix(source_asset, dataset_id, workdir) -> tuple[ParsedDataset, list[GeoSampleMetadata]]`.
- Produces: validation check `core_scientific_values` for non-Reactome main data.

- [ ] **Step 1: Write the failing acquisition lifetime test**

Use a strict fake client that raises after `__aexit__`. Return a successful
counts asset followed by SOFT and assert both calls complete before close.

- [ ] **Step 2: Write the failing populated-matrix parser test**

Create a gzipped matrix with two samples and two numeric gene rows. Assert four
long-form rows and exact source locator fields.

- [ ] **Step 3: Write the failing empty-matrix and validation tests**

Assert an empty matrix block raises `ValueError` and a package containing only
`measurement_type=sample_metadata` fails `core_scientific_values` with zero
checked lineage values.

- [ ] **Step 4: Verify all three red paths**

```powershell
uv run pytest tests/pipeline/test_acquisition_download_log.py tests/pipeline/test_geo_tximport_processing.py tests/pipeline/test_validation_rules.py -k "client or series_matrix or scientific_values" -v
```

- [ ] **Step 5: Keep the GEO client alive**

Move the SOFT acquisition inside the existing `async with
httpx.AsyncClient()` scope. Preserve the ordered attempt list and fail when
SOFT is required but unavailable.

- [ ] **Step 6: Implement the series-matrix value parser**

Parse metadata plus the table block, emit `_OUTPUT_COLUMNS`, validate every
value with `float(raw)`, record 1-based source line and 0-based source column,
and delete the partial output before raising on an empty matrix.

- [ ] **Step 7: Remove placeholder routing and add the gate**

Call `process_geo_series_matrix` when no counts + SOFT pair exists. Add a
`core_scientific_values` check that requires a non-metadata numeric row with a
valid locator, and fail `source_value_lineage` when its checked count would be
zero.

- [ ] **Step 8: Verify green and focused regressions**

```powershell
uv run pytest tests/pipeline/test_acquisition_download_log.py tests/pipeline/test_geo_tximport_processing.py tests/pipeline/test_validation_rules.py tests/pipeline/test_pinned_pipeline.py -v
uv run ruff check app/pipeline/stages/acquisition.py app/pipeline/processing/geo_tximport.py app/pipeline/stages/processing.py app/pipeline/stages/validation.py tests/pipeline
```

- [ ] **Step 9: Commit**

```powershell
git add backend/app/pipeline/stages/acquisition.py backend/app/pipeline/processing/geo_tximport.py backend/app/pipeline/stages/processing.py backend/app/pipeline/stages/validation.py backend/tests/pipeline/test_acquisition_download_log.py backend/tests/pipeline/test_geo_tximport_processing.py backend/tests/pipeline/test_validation_rules.py
git commit -m "fix: require source-derived values for GEO artifacts"
```

### Task 4: Remove live release dependency on test fixtures

**Files:**
- Modify: `backend/app/pipeline/runner.py:1084-1105`
- Test: `backend/tests/pipeline/test_pipeline_runner_resilience.py`
- Test: `backend/tests/pipeline/test_pipeline_tool.py`

**Interfaces:**
- Produces: live parameter digests with `fixture_hash=None`; fixture digests retain content hashing.

- [ ] **Step 1: Write the failing live missing-fixture test**

Create a live runner with `fixture_dir=tmp_path / "not-present"`, stub
Discovery to raise a sentinel live error, and assert the sentinel is reached
instead of `FileNotFoundError` from `_hash_directory`.

- [ ] **Step 2: Verify red**

```powershell
uv run pytest tests/pipeline/test_pipeline_runner_resilience.py -k "missing_fixture" -v
```

- [ ] **Step 3: Make fixture hashing mode-aware**

```python
fixture_hash = _hash_directory(self.fixture_dir) if self.mode == "fixture" else None
```

Do not package fixtures and do not weaken fixture-mode validation.

- [ ] **Step 4: Verify green**

```powershell
uv run pytest tests/pipeline/test_pipeline_runner_resilience.py tests/pipeline/test_pipeline_tool.py -v
uv run ruff check app/pipeline/runner.py tests/pipeline/test_pipeline_runner_resilience.py
```

- [ ] **Step 5: Commit**

```powershell
git add backend/app/pipeline/runner.py backend/tests/pipeline/test_pipeline_runner_resilience.py
git commit -m "fix: decouple live pipeline from test fixtures"
```

### Task 5: Support official GDC gene-expression TSV

**Files:**
- Modify: `backend/app/pipeline/stages/acquisition.py:260-330`
- Modify: `backend/app/pipeline/processing/gdc.py`
- Test: `backend/tests/pipeline/test_gdc_acquisition.py`
- Test: `backend/tests/pipeline/test_gdc_processing.py`

**Interfaces:**
- Produces: `_gdc_official_data_type(data_type: str) -> str`.
- Extends: `parse_gdc_table(...)` with official STAR-counts auto-detection while preserving fixture matrices.

- [ ] **Step 1: Write the failing official-filter test**

Capture the GDC Files API `filters` parameter and assert it contains:

```python
{"field": "data_type", "value": "Gene Expression Quantification"}
{"field": "data_format", "value": "TSV"}
```

Add a live `clinical` assertion that fails before an HTTP request with a stable
unsupported-format message.

- [ ] **Step 2: Write the failing official TSV parser test**

Use a local TSV containing two `#` lines, the official ten-column header, one
summary row, and two ENSG rows. Assert two output rows, `tpm_unstranded` values,
version-stripped canonical IDs, exact original line/column locators, and a
stable file-derived sample ID.

- [ ] **Step 3: Verify red**

```powershell
uv run pytest tests/pipeline/test_gdc_acquisition.py tests/pipeline/test_gdc_processing.py -k "official or clinical_live" -v
```

- [ ] **Step 4: Map aliases and constrain the query**

Map `gene-expression`, `gene expression`, and `expression` to
`Gene Expression Quantification`; add the TSV format filter; reject other live
types before opening the client.

- [ ] **Step 5: Implement official-table auto-detection**

Read through comment lines while tracking physical line numbers. When the
header contains `gene_name` plus `tpm_unstranded`/`unstranded`, emit the
single-sample official layout. Otherwise call the existing fixture-matrix
logic.

- [ ] **Step 6: Verify green and compatibility**

```powershell
uv run pytest tests/pipeline/test_gdc_acquisition.py tests/pipeline/test_gdc_processing.py tests/pipeline/test_multisource_merge.py -v
uv run ruff check app/pipeline/stages/acquisition.py app/pipeline/processing/gdc.py tests/pipeline/test_gdc_acquisition.py tests/pipeline/test_gdc_processing.py
```

- [ ] **Step 7: Commit**

```powershell
git add backend/app/pipeline/stages/acquisition.py backend/app/pipeline/processing/gdc.py backend/tests/pipeline/test_gdc_acquisition.py backend/tests/pipeline/test_gdc_processing.py
git commit -m "fix: ingest official GDC gene expression tables"
```

### Task 6: Complete GDC + Xena multi-source entry path

**Files:**
- Modify: `backend/app/pipeline/stages/discovery.py:130-170,388-470`
- Modify: `backend/app/pipeline/stages/acquisition.py:170-215,220-380,520-560`
- Test: `backend/tests/pipeline/test_multisource_merge.py`

**Interfaces:**
- Produces: one resolved `DatasetSelection` and `SourceRecord` per selected GDC/Xena dataset.
- Produces: one combined `AcquisitionOutput` with all assets and attempts.

- [ ] **Step 1: Write the failing Discovery/Acquisition integration test**

Build a fixture specification with one GDC and one Xena dataset, invoke actual
Discovery then actual Acquisition, and assert:

```python
assert len(discovery.output.sources) == 2
assert len(discovery.output.specification.datasets) == 2
assert len(acquisition.output.source_assets) == 2
assert {asset.source_id for asset in acquisition.output.source_assets} == {
    source.source_id for source in discovery.output.sources
}
```

Continue through Processing, Artifact Build, and Validation and assert the
merged package is valid.

- [ ] **Step 2: Verify red**

```powershell
uv run pytest tests/pipeline/test_multisource_merge.py -k "entry_path" -v
```

Expected: Discovery retains only GDC and Acquisition produces one asset.

- [ ] **Step 3: Aggregate Discovery**

Refactor the existing GDC/Xena resolution code into helpers that return a
resolved dataset plus source. Iterate input datasets, preserve order, and
construct one `DiscoveryOutput` whose singular compatibility fields use the
first dataset.

- [ ] **Step 4: Aggregate Acquisition and preserve Xena identity**

Run each selected fixture/live helper, concatenate assets and attempts, set
`source_path` from the first result, and compute an output digest over ordered
asset digests. Change Xena source construction to:

```python
source_id=dataset.source_id or make_source_id(...)
```

- [ ] **Step 5: Verify green and full multi-source package**

```powershell
uv run pytest tests/pipeline/test_multisource_merge.py tests/pipeline/test_xena_matrix_processing.py tests/pipeline/test_gdc_acquisition.py -v
uv run ruff check app/pipeline/stages/discovery.py app/pipeline/stages/acquisition.py tests/pipeline/test_multisource_merge.py
```

- [ ] **Step 6: Commit**

```powershell
git add backend/app/pipeline/stages/discovery.py backend/app/pipeline/stages/acquisition.py backend/tests/pipeline/test_multisource_merge.py
git commit -m "fix: preserve all datasets through multi-source acquisition"
```

### Task 7: Reconcile documentation and run release gates

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TODO.md`
- Modify if evidence requires: `docs/DEVELOPER_QUICKSTART.md`

**Interfaces:**
- Produces: documentation and Commonly board state matching verified code.

- [ ] **Step 1: Update truthful support boundaries**

Document the real GEO series-matrix behavior, official GDC gene-expression
format, explicit live clinical rejection, complete GDC + Xena flow, canonical
checkpoint fingerprints, and live fixture independence. Correct stale TODO
checkboxes and completion notes.

- [ ] **Step 2: Run focused aggregate verification**

```powershell
uv run pytest tests/api/test_model_preview_security.py tests/pipeline/test_pipeline_runner_recovery.py tests/pipeline/test_pipeline_runner_resilience.py tests/pipeline/test_geo_tximport_processing.py tests/pipeline/test_validation_rules.py tests/pipeline/test_gdc_acquisition.py tests/pipeline/test_gdc_processing.py tests/pipeline/test_multisource_merge.py -v
uv run ruff check app/ tests/ launcher.py
```

- [ ] **Step 3: Run the complete backend suite**

```powershell
uv run pytest
```

Expected: no failures or warnings; marked live tests remain deselected by the
default configuration.

- [ ] **Step 4: Run import and startup gates**

```powershell
uv run python -m compileall -q app tests launcher.py
```

Clear only `__pycache__` directories inside this worktree, then launch
`.venv/Scripts/python.exe -m uvicorn app.main:app` with a temporary local port,
poll `/api/v1/health`, and terminate the exact process in `finally`.

- [ ] **Step 5: Commit documentation**

```powershell
git add docs/ARCHITECTURE.md docs/TODO.md docs/DEVELOPER_QUICKSTART.md
git commit -m "docs: record verified backend P0 support boundaries"
```

- [ ] **Step 6: Review branch and integrate**

Run `git diff main...HEAD --check`, inspect every commit and changed file,
synchronize with `origin/main` using the repository's commit-count rule,
repeat all quality gates after conflict resolution, merge the complete
functional unit, and update Commonly TASK-029 and TASK-032 through TASK-036
with exact commit and verification evidence.

## Plan Self-Review

- Every design requirement maps to exactly one implementation task.
- Every production edit is preceded by a regression test and an observed red
  result.
- The helper names and return types used by later tasks are defined where they
  are introduced.
- No dependency, adapter framework, fixture bundling, or P1/P2 scope was added.
- Each repair and the closing documentation have explicit commit boundaries.
