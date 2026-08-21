# Cache & File Import — Design

> ⚠️ **Status update (2026-08-17)**: `backend/` 已随 Phase 8 物理删除，下文
> "Authoritative code" 指向的路径已失效。现行实现：TS DatabaseClient
> （`server/src/persistence/db-client.ts`）+ Python DB bridge
> （`database/cache_store.py`，schema-neutral JSONL named-op）+ Agent 侧
> `server/src/agent/tools/local-cache.ts` + `server/src/agent/tools/pdf.ts`；
> FTS5 搜索、schema 泛化、cache ZIP export 等设计决策仍有效，代码位置以现状为准。
>
> **Update (2026-08-20)**: 缓存注册与下载/导入流程脱节的已知缺口已闭合
> （见 [TODO.md](TODO.md)，TASK-045）——下载经 `CacheRegistrar`
> 自动注册、本地导入经 `commit_to_cache` 注册，`search_local_cache` 等
> 读取工具可直接命中；并新增缓存管理 HTTP API 与前端设置页。详见 §13。

> **Status**: Implemented (Phase 1–10 + e2e tests)
> **Scope**: local queryable cache + LLM-driven file import pipeline +
> PDF extraction + cache ZIP export + FTS5 search + schema generalization
> **Authoritative code**: `backend/app/tools/cache_store.py`,
> `backend/app/tools/cache_tools.py`, `backend/app/tools/sandbox.py`,
> `backend/app/tools/cache_export.py`, `backend/app/tools/pdf_tools.py`,
> `backend/app/skills/builtin/acquisition/local_cache.py`,
> `backend/app/agent_loop/import_agent.py`,
> `backend/app/agent_loop/runner.py` (`ModeDispatchRunExecutor`,
> `ImportRunExecutor`), `backend/app/api/routes.py` (`POST /import/tasks`,
> `GET /cache/export`), frontend upload wiring + cache export button in
> `frontend/src/`.

---

## 1. Goals and non-goals

### Goals

1. **External data import** — Users (e.g. hospital researchers) can upload
   private clinical datasets (CSV / TSV / JSON / Markdown tables / SQLite3 /
   any text format) so the agent can answer questions against them without
   the data ever being published to a public database.
2. **Reusable cache** — Once cleaned, imported data lives in a queryable
   cache. Subsequent research tasks can read it via the same acquisition
   skill pattern used for PubMed/GEO, avoiding repeated cleaning.
3. **LLM-authored cleaning scripts** — For non-standard file formats the
   IMPORT agent writes and executes a Python script in a sandbox to reshape
   the data into the 22-column long format. No format-specific parsers are
   hardcoded in the backend.
4. **Frontend–backend parity** — The frontend can upload files via a
   dedicated IMPORT task mode; the backend runs a focused IMPORT AgentLoop
   that produces cache rows.

### Non-goals

- **Public-database caching** — The existing `content_cache.py` (SHA-256
  content-addressed blob dedup for HTTP downloads) is orthogonal and is
  not replaced by this design.
- **Cross-user sharing** — The cache is per-deployment, not per-user.
  Multi-tenant isolation is a future concern.
- **Versioned datasets** — Re-committing the same `dataset_id` overwrites.
  Differencing / dataset history is out of scope.
- **Automatic pipeline-artifact caching** — The `pipeline_artifact`
  namespace is reserved but the wiring that auto-caches Pipeline-produced
  `main_data.csv` is not implemented in this phase.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Frontend (React)                          │
│   AgentComposer.tsx ─ file picker + chip display                │
│   controller.ts     ─ startImportTask(files, note)              │
│   useAPI.ts         ─ FormData multipart POST                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ POST /api/v1/import/tasks (multipart)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FastAPI (routes.py)                          │
│   create_import_task:                                          │
│     - sanitize filenames                                       │
│     - enforce size/count limits                                │
│     - stage complete uploads under tasks/.uploads/              │
│     - publish source_assets before TaskManager queues the Run   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ durable task queue
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              TaskManager → ModeDispatchRunExecutor              │
│                                                                 │
│   ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐ │
│   │ AgentRunExecutor│  │FixtureRunExecutor│  │ImportRunExecutor│ │
│   │ (mode=AGENT)    │  │ (mode=FIXTURE)  │  │ (mode=IMPORT)  │ │
│   └─────────────────┘  └─────────────────┘  └────────┬───────┘ │
│                                                   inherits     │
│                                                       │        │
│                                                       ▼        │
│                                              AgentRunExecutor │
│                                              (Template Method)│
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              IMPORT AgentLoop (OpenAI Agents SDK)               │
│  build_import_agent() with 7 tools:                             │
│    read_file, write_file, list_files,                           │
│    run_python_script (sandbox), commit_to_cache,                │
│    extract_pdf (chunked, D3), parse_cache_export_zip (D7)       │
│                                                                 │
│  Instructions document the 22-column schema, workflow,          │
│  PDF chunked extraction (Strategy C), and semantic              │
│  generalization (D10).                                          │
└──────────┬──────────────────────────────────────┬───────────────┘
           │                                      │
           ▼                                      ▼
┌─────────────────────────┐         ┌──────────────────────────────┐
│  app.tools.sandbox      │         │  app.tools.cache_store        │
│  - AST whitelist        │         │  - records/<ns>/<id>/         │
│  - subprocess isolation │         │    main_data.csv (22-col)     │
│  - controlled I/O       │         │    manifest.json              │
│    (read_input/write_   │         │  - index.sqlite3              │
│     output/read_csv/    │         │  - atomic .tmp + os.replace   │
│     read_json/write_csv/│         │  - namespace regex guard      │
│     write_json)         │         │                              │
└─────────────────────────┘         └──────────────┬───────────────┘
                                                   │
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │ local_cache acquisition skill│
                                    │ (loaded by main Agent)       │
                                    │ - search_local_cache         │
                                    │ - describe_local_cache       │
                                    │ - get_cache_dataset          │
                                    │ (NOT in GET /databases list) │
                                    └──────────────────────────────┘
```

---

## 3. Data model

### 3.1 Cache directory layout

```
data/cache/
├── records/
│   └── <source_namespace>/          # e.g. "user_import", "pipeline_artifact"
│       └── <dataset_id>/            # e.g. "user_import_20260719_patients"
│           ├── main_data.csv        # 22-col long format (utf-8-sig)
│           └── manifest.json        # CacheDatasetManifest
└── index.sqlite3                    # search index (topic / description / ns)
```

### 3.2 The 22-column long format (`CACHE_MAIN_DATA_COLUMNS`)

Imported data is reshaped to the same 22-column schema used by the
Pipeline-produced `main_data.csv`. This is intentional — it lets the
agent reason about cached rows and pipeline rows with the same column
vocabulary.

| Column                  | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `record_id`             | Per-row unique ID (e.g. `r1`, `r2`)                |
| `dataset_id`            | Dataset this row belongs to                        |
| `source_id`             | Logical source (e.g. `user_import`)                |
| `asset_id`              | Original file SHA-256 (optional)                   |
| `gene_id_raw`           | Original gene/feature identifier                   |
| `gene_id`               | Normalized gene ID (NCBI / HGNC)                   |
| `gene_id_namespace`     | ID namespace (`hgnc` / `ncbi_gene` / `ensembl`)    |
| `gene_id_version`       | Version (e.g. Ensembl release)                     |
| `sample_id`             | Sample ID                                          |
| `source_sample_alias`   | Original sample alias (e.g. column name)           |
| `measurement_type`      | `expression` / `mutation` / `clinical` / ...       |
| `value_semantics`       | `continuous` / `categorical` / `binary`            |
| `value_scale`           | `raw_count` / `tpm` / `fpkm` / `log2`              |
| `is_normalized`         | `true` / `false`                                   |
| `is_integer_expected`   | `true` for raw counts                              |
| `expression_value`      | Numeric value (as string)                          |
| `expression_unit`       | `count` / `tpm` / `fpkm` / `NA`                    |
| `source_logical_file`   | Original file name                                 |
| `source_line_number`    | Line number in source file (string)                |
| `source_column_index`   | 0-based column index in source file (string)       |
| `source_column_name`    | Original column name                               |
| `source_raw_value`      | Original cell value (string)                       |

Missing columns are stored as empty strings — the IMPORT agent is told to
populate only the columns that make sense for the source data.

#### 3.2.1 Schema semantic generalization (D10)

The 22-column schema was originally designed for gene-expression data,
but the cache must support arbitrary biomedical data (drugs, compounds,
pathways, clinical records, PDF papers, etc.). Rather than introduce a
second schema, the IMPORT instructions apply **semantic generalization**
to certain columns (column names are unchanged):

| Column                  | Generalized semantics (D10)                              |
| ----------------------- | -------------------------------------------------------- |
| `gene_id_raw`           | **Primary entity raw ID** — gene / protein / compound /  |
|                         | drug / pathway / microbe / any "measured object"         |
| `gene_id`               | **Primary entity canonical ID** (NCBI Gene / UniProt /   |
|                         | PubChem CID / DrugBank ID / ...)                         |
| `gene_id_namespace`     | `hgnc` / `uniprot` / `pubchem` / `drugbank` / `reactome` |
|                         | / `taxonomy` / ...                                       |
| `sample_id`             | **Secondary entity ID** — sample / patient / cell line / |
|                         | time point / cohort / any "measurement context"          |
| `measurement_type`      | Free-form string with controlled prefixes:               |
|                         | `expression` / `mutation` / `binding` / `clinical` /     |
|                         | `paper_section` / `sample_metadata` / ...                |
| `expression_value`      | **Measurement value** (any numeric or categorical)       |

**When no clear "primary entity" exists** (e.g. plain PDF text, clinical
records), the entity ID columns are left empty. The IMPORT instructions
explicitly warn against force-filling entity IDs for non-structured data.

**Keywords vs entity IDs** (no semantic conflict):
- Entity IDs (`gene_id`, `sample_id`, ...) are **row-level structured
  data** stored in CSV cells, used for row-level queries.
- `keywords` (dataset-level, in `manifest.json`) are **LLM-extracted
  search tags** used for dataset-level FTS5 retrieval.

For example, a drug-target binding dataset might have:
- CSV rows: `gene_id_raw=imatinib, gene_id_namespace=drugbank, sample_id=ABL1, ...`
- Dataset keywords: `"imatinib,ABL1,drug-target,binding,IC50"`
- User search for either `"imatinib"` or `"ABL1"` hits this dataset.

### 3.3 `CacheDatasetManifest`

```json
{
  "dataset_id": "user_import_patients_csv",
  "source_namespace": "user_import",
  "topic": "Hospital oncology patient cohort",
  "description": "Cleaned clinical data from patients.csv upload",
  "row_count": 5,
  "column_count": 22,
  "created_at": "2026-07-19T12:34:56.789012+00:00",
  "created_by_task_id": "task_abc123",
  "source_files": ["patients.csv"],
  "extra": {},
  "keywords": ["BRCA", "LUAD", "clinical", "patient", "oncology"]
}
```

`keywords` is an LLM-extracted list of dataset-level search tags (D2
decision). It is stored in the manifest and in the FTS5 index for
full-text search.

### 3.4 SQLite index schema (FTS5 + structured fields, D2)

```sql
CREATE TABLE datasets (
    dataset_id          TEXT NOT NULL,
    source_namespace    TEXT NOT NULL,
    topic               TEXT NOT NULL,
    description         TEXT NOT NULL,
    keywords            TEXT NOT NULL DEFAULT '',  -- space-joined tags
    row_count           INTEGER NOT NULL,
    created_at          TEXT NOT NULL,
    created_by_task_id  TEXT NOT NULL,
    manifest_path       TEXT NOT NULL,
    PRIMARY KEY (source_namespace, dataset_id)
);
CREATE INDEX idx_datasets_namespace ON datasets(source_namespace);
CREATE INDEX idx_datasets_topic     ON datasets(topic);

-- FTS5 full-text index (D2) — supports unicode61 tokenizer for CJK
CREATE VIRTUAL TABLE datasets_fts USING fts5(
    source_namespace UNINDEXED,
    dataset_id       UNINDEXED,
    topic,
    description,
    keywords,
    manifest_path    UNINDEXED,
    created_at       UNINDEXED,
    tokenize = 'unicode61'
);
```

`search_datasets(query, limit)` first attempts FTS5 MATCH; on failure
(or empty result) it falls back to LIKE on `topic` / `description` /
`keywords` for substring matching. The combination provides both
tokenized full-text search and substring fallback.

**FTS5 upsert**: FTS5 doesn't support `ON CONFLICT`, so re-committing a
dataset `DELETE`s the old FTS5 row before `INSERT`ing the new one
(see `_upsert_index`). This avoids stale index entries.

**Migration**: Existing databases created before the `keywords` column
are migrated via `ALTER TABLE datasets ADD COLUMN keywords TEXT NOT NULL
DEFAULT ''` wrapped in `contextlib.suppress(sqlite3.OperationalError)`
(no-op if the column already exists).

The index is a **search accelerator only** — the `records/` files are
authoritative. `CacheStore._load_manifest` always re-reads `manifest.json`
from disk so a stale index row cannot fabricate a dataset.

---

## 4. CacheStore API

Defined in [backend/app/tools/cache_store.py](../backend/app/tools/cache_store.py).

| Method                                                       | Purpose                                            |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `commit_dataset(...)`                                        | Atomic write of `main_data.csv` + `manifest.json` + upsert index row. Validates namespace and dataset_id regexes; rejects rows with columns outside the 22-col schema. |
| `list_datasets(source_namespace=None, limit=50)`             | List manifests, newest first, optionally filtered by namespace. |
| `search_datasets(query, limit=20)`                           | FTS5 MATCH on `topic` / `description` / `keywords` with LIKE substring fallback (D2). |
| `describe_dataset(ns, id) -> manifest \| None`               | Read manifest only (no data rows).                 |
| `get_dataset(ns, id) -> (manifest, rows) \| None`            | Read manifest + all `main_data.csv` rows.          |

**Atomicity**: `commit_dataset` writes both files to `.tmp` first, then
`os.replace`s them. On any exception the `.tmp` files are unlinked; no
partial state is visible to readers.

**Module singleton**: `init_cache_store(cache_dir)` is called once by the
FastAPI lifespan (see [main.py](../backend/app/main.py)). Tools retrieve
the singleton via `get_cache_store()`, which raises `RuntimeError` if
lifespan has not initialized it.

---

## 5. LLM script sandbox

Defined in [backend/app/tools/sandbox.py](../backend/app/tools/sandbox.py).

### 5.1 Security model

1. **AST whitelist** — `validate_sandbox_code` walks the AST and rejects:
   - `import` of any module outside `SANDBOX_ALLOWED_MODULES`
   - `from X import ...` where `X`'s top-level name is not whitelisted
   - Calls to `_FORBIDDEN_CALL_NAMES` (`exec`, `eval`, `compile`, `open`,
     `__import__`, `globals`, `locals`, `vars`, `breakpoint`, ...)
   - Access to dunder attributes (`obj.__class__`, etc.)
   - Use of dunder names (`__import__`, ...)
2. **Whitelisted modules** — pure-computation stdlib + opt-in data libs:
   `csv`, `json`, `re`, `math`, `itertools`, `collections`, `statistics`,
   `datetime`, `decimal`, `fractions`, `hashlib`, `io`, `pandas`, `numpy`.
   Notably **excludes** `os`, `subprocess`, `shutil`, `pathlib`, `socket`,
   `sys`, `builtins`.
3. **Subprocess isolation** — scripts run via `subprocess.run([sys.executable,
   "-I", script_path], timeout=30)`. `-I` isolates the interpreter
   (no user-site, no `PYTHON*` env vars).
4. **Controlled I/O prelude** — the sandbox injects a `_sbx_setup` closure
   that:
   - Captures the real `open` as `_real_open` (closure-local, never exposed
     to module scope)
   - Replaces `builtins.open` with `_guarded_open` that only permits
     `INPUT_PATH` and `OUTPUT_PATH`
   - Provides `read_input()`, `write_output(text)`, `read_csv()`,
     `read_json()`, `write_csv(rows)`, `write_json(obj)` helpers
   - `del _sbx_setup` after installation so LLM code cannot reach the
     closure's `_real_open`
5. **Resource limits** — 30s wall clock, 10 MB max output. Linux rlimits
   are a future improvement; on Windows we rely on subprocess timeout.

### 5.2 Function tool surface

`run_python_script(ctx, code, input_relative_path, output_relative_path)`
is the LLM-facing tool. It:

1. Resolves `input_relative_path` and `output_relative_path` against the
   task workdir root, rejecting path traversal.
2. Verifies the input file exists.
3. Creates parent dirs for the output path.
4. Calls `run_sandbox_script(code, input_path, output_path)`.
5. Returns a human-readable result string (success message + output
   preview, or stderr tail on failure).

---

## 6. IMPORT AgentLoop

### 6.1 Tools (7 total)

| Tool                   | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `list_files`           | Discover uploaded files in `source_assets/`                  |
| `read_file`            | Inspect file content (text only — fails on binary)           |
| `write_file`           | Persist intermediate notes if needed                         |
| `run_python_script`    | Sandbox-execute a cleaning script for non-standard formats   |
| `commit_to_cache`      | Write the cleaned 22-col CSV into the local cache            |
| `extract_pdf`          | Chunked PDF text/table extraction with `start_page`/`end_page` (D3) |
| `parse_cache_export_zip` | Round-trip parser for cache ZIP exports (D7) — the only prebuilt parser |

Notably **not** included: `run_research_pipeline`, any external-database
acquisition skill, `compress_query_log`, `self_evolution`. The IMPORT
agent's scope is intentionally narrow. **No other format-specific
parsers are prebuilt** — the LLM explores the file format and writes a
one-off cleaning script via `run_python_script` (D7 decision).

### 6.2 Instructions

The `IMPORT_INSTRUCTIONS` constant in
[import_agent.py](../backend/app/agent_loop/import_agent.py) documents:

- The 5-step workflow (discover → inspect → clean → commit → report)
- The 22-column schema with per-column fill rules
- **Schema semantic generalization (D10)** — `gene_id_raw` / `gene_id` /
  `sample_id` are generalized to "primary entity ID" / "secondary entity
  ID" so the same schema accommodates drugs, compounds, pathways,
  clinical records, PDF sections, etc. without column renames.
- **`keywords` field usage (D2)** — dataset-level LLM-extracted search
  tags (5–15 items) stored in `manifest.json` and the FTS5 index for
  dataset-level retrieval; distinct from row-level entity IDs.
- Three cleaning strategies:
  - **Strategy A** — Direct `commit_to_cache` when the file is already a
    22-column subset CSV
  - **Strategy B** — `run_python_script` to clean arbitrary formats
    (CSV with custom columns, JSON, MD tables, TSV, ...) into 22-col rows
  - **Strategy C** — `extract_pdf` for PDFs: chunked extraction (10
    pages/chunk) with progress messages between chunks via
    `assistant_delta`, then clean the extracted text/tables into 22-col
    rows (or `paper_section` rows for prose)
- `dataset_id` regex constraint (`^[a-z0-9][a-z0-9_-]*$`)
- Sandbox constraints (no `os`/`subprocess`/`shutil`/`pathlib`/`open`)
- "Do not fabricate data" — empty columns are preferred over invented values
- "PDF must be chunked" — never extract a large PDF in a single call
- "Do not force-fill entity IDs" for non-structured data (PDF prose,
  clinical narratives)

### 6.3 Max turns

`ATTACHMENT_PARSING_MAX_TURNS = 40` (D5 decision) — file formats are
unknown ahead of time, so the LLM needs ample turns to explore the
format, write a cleaning script, retry on failure, extract `keywords`,
and call `commit_to_cache`. PDFs may need multiple chunked extraction
calls. 40 turns covers most multi-file + retry + PDF-chunking scenarios.

### 6.4 Executor wiring

`ImportRunExecutor` subclasses `AgentRunExecutor` (Template Method pattern)
and overrides only `_build` (returns `build_import_agent()`) and
`_max_turns` (returns `ATTACHMENT_PARSING_MAX_TURNS`). All other lifecycle —
compaction, pause-resume, cancellation, streaming, event emission — is
inherited unchanged.

`ModeDispatchRunExecutor.__call__` routes `TaskMode.IMPORT` to
`ImportRunExecutor`, keeping the dispatch logic in one place.

---

## 7. HTTP API

### 7.1 `POST /api/v1/import/tasks` (multipart)

**Request**:
- Form field `request_id` (required, non-empty string)
- Form field `input` (optional, user note)
- Form field `files` (one or more uploaded files)

**Validation**:
- At least 1 file, at most `_IMPORT_MAX_FILES` (10)
- Each file ≤ `_IMPORT_MAX_FILE_BYTES` (500 MB)
- Total upload ≤ `_IMPORT_MAX_TOTAL_BYTES` (2 GB)
- Filenames sanitized via `_IMPORT_SAFE_FILENAME` regex
  (`[^A-Za-z0-9._-]` → `_`); path prefixes stripped
- Duplicate filenames rejected

**Behavior**:
1. Sanitize and deduplicate filenames.
2. Stream every upload into a request-scoped directory under
   `tasks/.uploads/` in 64 KB chunks. Oversized or partial uploads are
   cleaned before any durable task is created.
3. Compose a task input string: `<user_note>\n\n[uploaded_files (N): a.csv, b.json]`
   (or `Import N file(s) into local cache: a.csv, b.json` if no user note).
4. Resolve the available `TaskManager`, then call
   `create_task(..., prepare_task=publish_source_assets)`. The manager saves
   the initial snapshot, atomically moves the staged files into the accepted
   task's `source_assets/`, and only then appends `run_queued` and inserts the
   Run into the execution queue.
5. Return `TaskRunAccepted` (202) with `task_id`, `run_id`, `request_id`.

The shared `.uploads` parent lifecycle is synchronized only while creating or
removing request directories; file streaming remains concurrent. Route cleanup
closes all `UploadFile` objects and removes request staging on validation,
queue-full, runtime-unavailable, publication, and I/O failures.

**Why the IMPORT agent discovers files itself** (rather than receiving the
file list in the task input): the `source_assets/` directory is the
authoritative source of truth — listing it reflects what actually landed
on disk. If we baked the file list into the input string, a partial upload
or a manual copy could desynchronize the agent's expectations.

### 7.2 Database listing exclusion

`GET /api/v1/databases` filters out skills whose `supported_sources` is
`["local_cache"]`, so `local_cache` never appears in the user-selectable
database picker. The cache is always available as an acquisition source
via the main Agent's skill registry.

---

## 8. Frontend integration

| File                                       | Change                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `runtime/contracts.ts`                     | `TaskMode = "agent" \| "fixture" \| "import"`         |
| `hooks/useAPI.ts`                          | `startImportTask({ files, note })` — FormData POST    |
| `runtime/controller.ts`                    | `startImportTask(files, note)` — reuses task handoff  |
| `components/AgentComposer.tsx`             | File picker, shadcn `Attachment` display, limit validation, retry-safe async submission |
| `components/ChatPanel.tsx`                 | `uploadFiles` prop + `submitFiles()` handler          |
| `App.tsx`                                  | Wires `controller.startImportTask` to `ChatPanel`     |

The upload UX is intentionally minimal in this phase: the user picks files via
a dropdown menu trigger, the files appear as removable shadcn attachments in
the composer, and pressing Enter (or clicking Send) starts the IMPORT task.
Rejected uploads preserve the note and attachments for retry; selection is
locked while an upload is pending. A dedicated import page is a future UX
iteration.

---

## 9. End-to-end test coverage

Tests live in [backend/tests/](../backend/tests/):

| File                                       | Coverage                                             |
| ------------------------------------------ | ---------------------------------------------------- |
| `test_cache_store.py` (20 tests)           | commit/list/search/get/describe, namespace + dataset_id validation, column validation, empty-rows rejection, recommit overwrite, UTF-8 BOM read-back, uninitialized singleton, keywords persistence (D2), FTS5 keyword/partial/CJK matching, FTS5 index upsert on recommit |
| `test_sandbox.py` (35 tests)              | AST whitelist (allow + deny), forbidden calls, dunder access, subprocess execution (read_input/write_output/read_csv/read_csv/read_json/write_csv/write_json), open() guard, import os guard, runtime error surfacing, empty output, SandboxResult dataclass |
| `test_cache_tools.py` (6 tests)            | commit_to_cache writes + returns status, rejects extra columns, rejects empty CSV, rejects invalid dataset_id, returns error when store uninitialized, records source_files |
| `api/test_import_api.py`                   | 202 + pre-execution file visibility, validation without task creation, per-file/total-size limits, staging cleanup, concurrent upload-root lifecycle, queue-full/runtime-unavailable cleanup, mode=import + composed input |
| `test_pdf_tools.py` (7 tests)              | `extract_pdf` missing-file error, path traversal rejection, default full-document extraction, chunked first/middle pages, `end_page` clamp to total, `start_page<1` normalization |
| `agent_loop/test_import_agent.py` (12 tests)| build_import_agent tool set (7 tools), instructions document 22-col schema, instructions list workflow steps, instructions document PDF chunked extraction (D3), instructions document schema semantic generalization (D10), max_turns bounds, ModeDispatch routes IMPORT, ImportRunExecutor subclasses AgentRunExecutor, e2e CSV→clean→commit→verify, e2e JSON→clean→commit→verify, e2e MD table→clean→commit→verify, e2e TSV→clean→commit→verify |

**E2E test fixtures** in [backend/tests/fixtures/import/](../backend/tests/fixtures/import/):
`patients.csv` (clinical custom columns), `expression_subset.csv` (22-col
subset), `samples.json` (nested object), `clinical.md` (markdown table),
`counts.tsv` (wide gene×sample matrix).

The e2e tests simulate the LLM tool-call sequence by invoking each
function tool directly with a script the LLM would plausibly generate.
They prove the **tool chain** works end-to-end without requiring LLM
credentials or network access.

---

## 10. Design decisions (ADR-style)

### D1 — Reuse the 22-column `main_data.csv` schema for cache rows

**Forces**: We need a schema that (a) the agent already knows how to
reason about, (b) accommodates heterogeneous biomedical data, (c) has a
working validation gate. Introducing a parallel "cache row" schema would
double the agent's vocabulary and create translation friction.

**Alternatives considered**:
- A1: A separate key-value `cache_records(key, value, type)` table —
  rejected because it loses the long-format structure the agent already
  understands.
- A2: A per-dataset free-form schema with a JSON Schema manifest —
  rejected because the agent would need to learn a new schema per dataset.
- A3: Store the original file verbatim and let the agent re-parse on
  query — rejected because re-parsing on every query wastes turns and
  tokens.

**Cost to change course**: Low-to-moderate. The `CACHE_MAIN_DATA_COLUMNS`
tuple is the single source of truth; switching schemas would touch
`CacheStore._write_main_data`, `_parse_csv_to_rows`, and the IMPORT
instructions.

### D2 — `local_cache` is an acquisition skill, not a database

**Forces**: The cache should be queryable by the main Agent the same way
PubMed/GEO are — via `search_X` / `describe_X` / `get_X` tool triads. But
it must NOT appear in `GET /api/v1/databases` because users don't "select"
it like an external database — it's always available.

**Decision**: Register `local_cache` as a `SkillCategory.ACQUISITION`
skill with `supported_sources=["local_cache"]`. The `get_databases` route
filter excludes it because its `supported_sources` doesn't match any
user-selectable `Database` enum value.

**Cost to change course**: Trivial — change `supported_sources` to
include a real `Database` value if we ever want it in the picker.

### D3 — `commit_to_cache` is a function_tool, not a skill

**Forces**: Only the IMPORT agent should write to the cache. The main
research Agent must not be able to mutate the cache mid-research (it
would create a self-fulfilling data source). Skills are registered
globally and loaded by `build_agent` based on user-selected databases;
there's no clean way to restrict a skill to one task mode.

**Decision**: `commit_to_cache` is a standalone `@function_tool` in
`cache_tools.py`, loaded only by `build_import_agent`. The
`local_cache` skill (read tools) is loaded by `build_agent`.

**Cost to change course**: Trivial — add `commit_to_cache` to a skill's
tools list if we later want the main agent to write.

### D4 — Sandbox reuses the AST safety model from `validate_skill_code`

**Forces**: We already have a battle-tested AST validator that blocks
RCE primitives (`exec`, `eval`, `open`, `__import__`, dunder access,
non-whitelisted imports). Reusing it for the sandbox avoids divergent
security models.

**Decision**: `validate_sandbox_code` mirrors `validate_skill_code`'s
AST walk but uses `SANDBOX_ALLOWED_MODULES` (broader: includes `csv`,
`json`, `pandas`, etc.) and allows `import X` form (sandbox scripts
aren't loaded via `importlib` into the main process).

**Cost to change course**: Moderate. The validator is a single function;
swapping it for a different sandboxing technology (e.g. WASM, container)
would require re-implementing the I/O prelude.

### D5 — IMPORT reuses `AgentRunExecutor` via Template Method

**Forces**: The IMPORT agent needs the same lifecycle as the main agent —
durable event streaming, pause-resume, cancellation, compaction,
max-turns handling. Copy-pasting `AgentRunExecutor` would duplicate
~400 lines of subtle concurrency code.

**Decision**: `AgentRunExecutor` was refactored to expose `_build` and
`_max_turns` as overridable hooks. `ImportRunExecutor` subclasses it and
overrides only those two methods.

**Cost to change course**: Low. If a future IMPORT feature needs
different lifecycle handling, override more hooks or fork the class.

### D6 — HTTP multipart for file upload (not WebSocket)

**Forces**: WebSocket is great for streaming agent events to the
frontend, but file upload is a one-shot request/response. Multiplexing
binary upload onto the event WS would complicate the event protocol and
require frame-level demultiplexing.

**Decision**: `POST /api/v1/import/tasks` is a standard HTTP multipart
endpoint. After the 202 response, the frontend subscribes to the task's
event stream via the existing WS to watch IMPORT progress.

**Cost to change course**: Moderate. The WS event protocol would need
a new frame type; the frontend uploader would need to coordinate HTTP
and WS state.

### D7 — `pipeline_artifact` namespace reserved but not auto-populated

**Forces**: We want future Pipeline runs to auto-cache their
`main_data.csv` so the agent can reuse prior research results. But
auto-caching has correctness implications (what if the pipeline failed
validation? what if the user cancelled?) that need separate design.

**Decision**: The `pipeline_artifact` namespace is documented and the
`local_cache` skill mentions it, but no code writes to it yet. This is
flagged as a future TODO.

### D8 — IMPORT agent emits user-visible progress via `assistant_delta`

**Forces**: PDF extraction and multi-file cleaning can take many turns.
The user sees nothing until `tool_completed` events fire, which makes
long IMPORT runs feel frozen.

**Decision**: The IMPORT instructions tell the LLM to emit a short
natural-language progress message via the standard `assistant_delta`
streaming channel between chunks (e.g. "正在提取 PDF 第 11–20 页…").
The frontend already renders `assistant_delta` as streaming markdown,
so no new event type or frontend wiring is needed. This reuses the
existing agent-streaming infrastructure rather than introducing a
dedicated `import_progress` event.

**Cost to change course**: Low. If we later want structured progress
(file-level granularity, percent-complete), add a dedicated
`import_progress` event; the current text messages remain a useful
human-readable layer.

### D9 — IMPORT agent and main agent run in fully isolated RunContexts

**Forces**: The IMPORT agent must not contaminate the main research
agent's context (different tools, different instructions, different
max_turns). Sharing a RunContext would also leak file paths and
intermediate state across the two phases.

**Decision**: IMPORT runs as a separate `Run` with its own
`RunContextWrapper`. The two-phase flow (Run #1 IMPORT → Run #2 main
research) is coordinated by `_archive_source_assets` archiving
`source_assets/` after IMPORT completes, so the main agent sees a clean
workdir. Neither run's context is reachable from the other.

**Cost to change course**: Low. If we later want the main agent to
inspect IMPORT's intermediate artifacts, expose them via a read-only
tool rather than sharing the context.

### D10 — Schema semantic generalization (no column renames)

**Forces**: The 22-column schema was designed for gene-expression data,
but the cache must support arbitrary biomedical data (drugs, compounds,
pathways, clinical records, PDF papers). Renaming columns (e.g.
`gene_id` → `primary_entity_id`) would break compatibility with the
Pipeline-produced `main_data.csv` and require touching every consumer.

**Decision**: Keep the 22 column names unchanged. Apply **semantic
generalization** in the IMPORT instructions: `gene_id_raw` / `gene_id`
are interpreted as "primary entity ID" (gene / protein / compound /
drug / pathway / microbe / ...), `sample_id` as "secondary entity ID"
(sample / patient / cell line / time point / cohort / ...). For
non-structured data (PDF prose, clinical narratives), entity ID columns
are left empty rather than force-filled. Dataset-level retrieval is
handled by `keywords` (D2), not entity IDs.

**Alternatives considered**:
- A1: Rename columns to entity-neutral names — rejected because it
  breaks the Pipeline schema contract and forces a migration of every
  consumer.
- A2: Introduce a parallel "cache row" schema with entity-neutral names
  — rejected because the agent would need to learn two schemas.
- A3: Add a `entity_type` column — rejected because it can be encoded
  in `gene_id_namespace` (`drugbank` / `uniprot` / `pubchem` / ...).

**Cost to change course**: Low-to-moderate. The generalization is
documentation-only; flipping back to a strict gene-only interpretation
would just require tightening the IMPORT instructions.

---

## 11. Operational notes

### 11.1 Cache location

The cache lives at `data/cache/` (sibling of `data/output/`). This is
configured in [main.py](../backend/app/main.py):
```python
application.state.cache_store = init_cache_store(
    Path(configured.output_dir).parent / "cache"
)
```
Override by setting `OUTPUT_DIR` (the cache is always
`<parent of OUTPUT_DIR>/cache`).

### 11.2 Backup

The cache is plain files + SQLite. To back up: copy `data/cache/`
directory. SQLite is crash-safe under `os.replace` atomic commits, so
hot-copying the directory yields a consistent snapshot.

### 11.3 Resetting the cache

Stop the backend, delete `data/cache/`. The next startup recreates an
empty index. Since §13, an admin **cache management API** is available for
selective deletion / full clear without stopping the server (also exposed
as a dashboard in the frontend settings page).

### 11.4 Inspection

```bash
# List all datasets
sqlite3 data/cache/index.sqlite3 \
  'SELECT source_namespace, dataset_id, row_count, created_at FROM datasets;'

# Read one dataset's manifest
cat data/cache/records/user_import/<dataset_id>/manifest.json

# Read one dataset's rows
python -c "import csv; print(list(csv.DictReader(open('data/cache/records/user_import/<dataset_id>/main_data.csv', encoding='utf-8-sig'))))"
```

---

## 12. Future work

1. **Auto-cache Pipeline artifacts** — After a successful Pipeline run,
   copy the validated `main_data.csv` to
   `records/pipeline_artifact/<task_id>/`. Add a `search_pipeline_artifacts`
   tool or extend `search_local_cache` to filter by namespace.
2. **Dataset deletion API** — ✅ **done (2026-08-20, §13)**: `GET/DELETE
   /api/v1/cache/datasets[/:id]` provide list / delete / clear.
3. **Larger file support** — `_IMPORT_MAX_FILE_BYTES` is currently 500 MB
   and `_IMPORT_MAX_TOTAL_BYTES` is 2 GB. If larger datasets are needed,
   add chunked upload (`Content-Range`) or resumable upload.
4. **Pandas / numpy in sandbox** — `SANDBOX_ALLOWED_MODULES` already
   whitelists them, but the backend's `pyproject.toml` doesn't declare
   them as dependencies. Add them when a real IMPORT use case requires
   vectorized cleaning.
5. **Structured import progress** — The IMPORT agent currently emits
   human-readable progress via `assistant_delta` (D8). A structured
   `import_progress` event with file-level / chunk-level granularity
   would enable a dedicated progress UI.
6. **Cross-task cache isolation** — If multi-tenancy is added, scope
   `source_namespace` by tenant ID and enforce isolation in
   `CacheStore.search_datasets`.

---

## 13. Cache registration on download/import + management API (2026-08-20)

This section documents the current (Phase 8+, TS host) wiring that closes
the historical "download never registers into the cache" gap and adds
user-facing cache management. It is authoritative over §4–§7, whose paths
refer to the deleted `backend/`.

### 13.1 The concrete cache flow

```
downloaded raw file (acquisition)            uploaded file (local data source)
        │                                            │
        ▼                                            ▼
CacheRegistrar                          createImportTools (import-tools.ts):
(cache-registrar.ts)                     list_source_assets / read_source_asset
  enqueue (fire-and-forget)                       │ commit_to_cache
  → cache.commit(ns=<source db>,                 │  (ns = user_import)
      asset = content-addressed blob)            ▼
        │                                     cache.commit(...)
        ▼                                            │
        ▼                                            ▼
database/cache_store.py  ←───／  read by local-cache.ts tools
  records/<ns>/<id>/ + index.sqlite3        (search/describe/get_local_cache)
```

- **Auto-registration on download**: `CacheRegistrar`
  (`server/src/persistence/cache-registrar.ts`) is a small best-effort queue.
  Each acquisition source (browser, publications, public DBs) notifies it
  with a resolved path + a `sanitizeCacheNamespace(source)` key after a
  successful download; it resolves the owning task from the durable task
  store and enqueues a `cache.commit` that writes the file as a
  content-addressed blob asset under that namespace. Failures are logged as
  warnings and never break the download.
- **Local data source import ("本地数据源导入修复")**: the import tool suite
  `server/src/agent/tools/import-tools.ts`
  (`list_source_assets` / `read_source_asset` / `commit_to_cache`) commits
  fetched `source_assets/` files under the reserved `user_import` namespace,
  plus the pre-existing `spec` / `answer` write helpers. `commit_to_cache`
  validates the cache-config (`max bytes`, encryption `key`, `namespace`
  regex) and returns a human-readable result so the agent can report success.
- **Shared reader**: `search_local_cache` / `describe_local_cache` /
  `get_cache_dataset` (`server/src/agent/tools/local-cache.ts`) read the same
  `database/cache_store.py` store, so freshly downloaded/imported datasets
  are immediately searchable on rerun.

### 13.2 Cache store operators (bridge named-ops)

`database/cache_store.py` (wrapped by `db-client.ts`, surfaced over stdin/
stdout JSONL):
- `cache.commit` (with `asset_files` staging + hardlink into content store)
- `cache.list` (namespace / keyword / limit; returns summaries)
- `cache.detail` / `cache.get` / `cache.describe`
- `cache.asset` / `cache.artifact` (content-addressed byte read)
- `cache.delete` (single dataset) / `cache.clear` (all)

### 13.3 Cache management HTTP API (Settings API)

Backed by `server/src/product/cache-api.ts`, exposed in
`server/src/product/product-api.ts`:

| Endpoint                                            | Method      | Purpose                          |
| --------------------------------------------------- | ----------- | -------------------------------- |
| `/api/v1/cache/datasets?namespace=&keyword=&limit=` | `GET`       | List dataset summaries (limit 1–200) |
| `/api/v1/cache/datasets/:id?namespace=`             | `GET`       | Detail a dataset                 |
| `/api/v1/cache/datasets/:id?namespace=`             | `DELETE`    | Delete one dataset (`404` if absent) |
| `/api/v1/cache/datasets`                            | `DELETE`    | Clear cache → `{deleted: N}`     |
| `/api/v1/cache/datasets/:id/artifacts/:artifact?namespace=` | `GET` | Download artifact/asset bytes    |
| `/api/v1/cache/export`                              | `GET`       | Download cache ZIP snapshot      |

Namespaces/dataset ids are URL-encoded. The `allow-list` security gate
already covers `/api/v1/cache/...`.

### 13.4 Frontend settings panel

`GeneralSettingsSection.tsx` (rendered in `SettingsPage.tsx`) gained a
**Cache** management block that reads the dataset list via the
`SettingsAPIClient` (`cacheDatasets()` / `fetchCacheDatasets()`) and offers:
refresh, per-dataset delete, and clear-all (with confirmation). Cache export
reuses the existing export button. Covered by the frontend test
`frontend/src/test/settings-panel.test.tsx`.

### 13.5 Backend test coverage

- `server/tests/phase5/cache-registration.test.ts` — the `CacheRegistrar`
  unit contract (commit of registered paths, failure isolation).
- `server/tests/product-api.test.ts` — the management HTTP surface
  (list/detail/delete/clear/artifact/export).
