# Cache & File Import — Design

> **Status**: Implemented (Phase 1–9 + e2e tests)
> **Scope**: local queryable cache + LLM-driven file import pipeline
> **Authoritative code**: `backend/app/tools/cache_store.py`,
> `backend/app/tools/cache_tools.py`, `backend/app/tools/sandbox.py`,
> `backend/app/skills/builtin/acquisition/local_cache.py`,
> `backend/app/agent_loop/import_agent.py`,
> `backend/app/agent_loop/runner.py` (`ModeDispatchRunExecutor`,
> `ImportRunExecutor`), `backend/app/api/routes.py` (`POST /import/tasks`),
> frontend upload wiring in `frontend/src/`.

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
│     - TaskManager.create_task(mode=IMPORT)                     │
│     - stream-upload files to task workdir/source_assets/        │
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
│  build_import_agent() with 5 tools:                             │
│    read_file, write_file, list_files,                           │
│    run_python_script (sandbox), commit_to_cache                 │
│                                                                 │
│  Instructions document the 22-column schema and workflow.       │
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
  "extra": {}
}
```

### 3.4 SQLite index schema

```sql
CREATE TABLE datasets (
    dataset_id          TEXT NOT NULL,
    source_namespace    TEXT NOT NULL,
    topic               TEXT NOT NULL,
    description         TEXT NOT NULL,
    row_count           INTEGER NOT NULL,
    created_at          TEXT NOT NULL,
    created_by_task_id  TEXT NOT NULL,
    manifest_path       TEXT NOT NULL,
    PRIMARY KEY (source_namespace, dataset_id)
);
CREATE INDEX idx_datasets_namespace ON datasets(source_namespace);
CREATE INDEX idx_datasets_topic     ON datasets(topic);
```

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
| `search_datasets(query, limit=20)`                           | LIKE search on `topic` and `description`.          |
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

### 6.1 Tools (5 total)

| Tool                | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `list_files`        | Discover uploaded files in `source_assets/`                  |
| `read_file`         | Inspect file content (text only — fails on binary)           |
| `write_file`        | Persist intermediate notes if needed                         |
| `run_python_script` | Sandbox-execute a cleaning script for non-standard formats   |
| `commit_to_cache`   | Write the cleaned 22-col CSV into the local cache            |

Notably **not** included: `run_research_pipeline`, any external-database
acquisition skill, `compress_query_log`, `self_evolution`. The IMPORT
agent's scope is intentionally narrow.

### 6.2 Instructions

The `IMPORT_INSTRUCTIONS` constant in
[import_agent.py](../backend/app/agent_loop/import_agent.py) documents:

- The 5-step workflow (discover → inspect → clean → commit → report)
- The 22-column schema with per-column fill rules
- Two cleaning strategies:
  - **Strategy A** — Direct `commit_to_cache` when the file is already a
    22-column subset CSV
  - **Strategy B** — `run_python_script` to clean arbitrary formats
    (CSV with custom columns, JSON, MD tables, TSV, ...) into 22-col rows
- `dataset_id` regex constraint (`^[a-z0-9][a-z0-9_-]*$`)
- Sandbox constraints (no `os`/`subprocess`/`shutil`/`pathlib`/`open`)
- "Do not fabricate data" — empty columns are preferred over invented values

### 6.3 Max turns

`IMPORT_AGENT_MAX_TURNS = 12` — covers `list_files` (1) + `read_file` (1)
+ `run_python_script` (1) + `read_file` cleaned output (1) +
`commit_to_cache` (1) + report (1) = 6 turns minimum, plus retry margin.

### 6.4 Executor wiring

`ImportRunExecutor` subclasses `AgentRunExecutor` (Template Method pattern)
and overrides only `_build` (returns `build_import_agent()`) and
`_max_turns` (returns `IMPORT_AGENT_MAX_TURNS`). All other lifecycle —
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
- Each file ≤ `_IMPORT_MAX_FILE_BYTES` (10 MB)
- Filenames sanitized via `_IMPORT_SAFE_FILENAME` regex
  (`[^A-Za-z0-9._-]` → `_`); path prefixes stripped
- Duplicate filenames rejected

**Behavior**:
1. Sanitize and deduplicate filenames.
2. Compose a task input string: `<user_note>\n\n[uploaded_files (N): a.csv, b.json]`
   (or `Import N file(s) into local cache: a.csv, b.json` if no user note).
3. `TaskManager.create_task(StartTaskRequest(mode=TaskMode.IMPORT, ...))` —
   the task enters the durable queue.
4. Stream each upload to `task_workdir.source_asset_file(name)` in 64 KB
   chunks. Files larger than the per-file limit mid-stream are unlinked
   and the request returns 413.
5. Return `TaskRunAccepted` (202) with `task_id`, `run_id`, `request_id`.

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
| `components/AgentComposer.tsx`             | File picker (hidden `<input type="file" multiple>`), chip display, `onSubmitFiles` prop |
| `components/ChatPanel.tsx`                 | `uploadFiles` prop + `submitFiles()` handler          |
| `App.tsx`                                  | Wires `controller.startImportTask` to `ChatPanel`     |

The upload UX is intentionally minimal in this phase: the user picks
files via a dropdown menu trigger, the files appear as removable chips
in the composer, and pressing Enter (or clicking Send) starts the IMPORT
task. A dedicated import page is a future UX iteration.

---

## 9. End-to-end test coverage

Tests live in [backend/tests/](../backend/tests/):

| File                                       | Coverage                                             |
| ------------------------------------------ | ---------------------------------------------------- |
| `test_cache_store.py` (13 tests)           | commit/list/search/get/describe, namespace + dataset_id validation, column validation, empty-rows rejection, recommit overwrite, UTF-8 BOM read-back, uninitialized singleton |
| `test_sandbox.py` (27 tests)              | AST whitelist (allow + deny), forbidden calls, dunder access, subprocess execution (read_input/write_output/read_csv/read_csv/read_json/write_csv/write_json), open() guard, import os guard, runtime error surfacing, empty output, SandboxResult dataclass |
| `test_cache_tools.py` (6 tests)            | commit_to_cache writes + returns status, rejects extra columns, rejects empty CSV, rejects invalid dataset_id, returns error when store uninitialized, records source_files |
| `api/test_import_api.py` (6 tests)         | 202 + file persistence, 422 no files, 422 too many, 413 oversized, 422 duplicate filenames, mode=import + composed input |
| `agent_loop/test_import_agent.py` (11 tests)| build_import_agent tool set, instructions document 22-col schema, instructions list workflow steps, max_turns bounds, ModeDispatch routes IMPORT, ImportRunExecutor subclasses AgentRunExecutor, e2e CSV→clean→commit→verify, e2e JSON→clean→commit→verify, e2e MD table→clean→commit→verify, e2e TSV→clean→commit→verify |

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
empty index. There is no admin API for selective deletion yet.

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
2. **FTS5 search** — Replace `LIKE` queries with SQLite FTS5 for better
   matching on `topic` / `description`.
3. **Dataset deletion API** — `DELETE /api/v1/cache/{namespace}/{dataset_id}`
   for GDPR / data-retention compliance.
4. **Larger file support** — Raise `_IMPORT_MAX_FILE_BYTES` and add
   chunked upload (`Content-Range`) for >10 MB files.
5. **Pandas / numpy in sandbox** — `SANDBOX_ALLOWED_MODULES` already
   whitelists them, but the backend's `pyproject.toml` doesn't declare
   them as dependencies. Add them when a real IMPORT use case requires
   vectorized cleaning.
6. **Progress streaming for IMPORT** — Currently the IMPORT agent emits
   standard `tool_started` / `tool_completed` events. A dedicated
   `import_progress` event with file-level granularity would improve UX
   for multi-file imports.
7. **Cross-task cache isolation** — If multi-tenancy is added, scope
   `source_namespace` by tenant ID and enforce isolation in
   `CacheStore.search_datasets`.
