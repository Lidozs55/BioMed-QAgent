# Backend Data Closure Design

## Status

Approved design for the backend-first remediation of BioMed-QAgent.

## Goal

Build a deterministic, testable data pipeline beneath the existing OpenAI
Agents SDK integration so that every source-derived record has a precise
lineage locator and every transformation is recorded.

The first accepted workflow is:

```text
research topic
    -> PubMed discovery
    -> GEO dataset selection
    -> verified download
    -> parsing and normalization
    -> artifact validation
    -> downloadable artifact package
```

Phase 1 supports PubMed and GEO only. Other databases remain available as
experimental tools but are not part of the acceptance claim.

## Approved Representative Case

The pinned real case is:

- Topic: `breast cancer gene expression under Hsp70 inhibition`
- PubMed: PMID `34180400`
- GEO: `GSE178352`
- Organism: `Homo sapiens`
- Design: two triple-negative breast-cancer cell lines, treated and untreated,
  three replicates per condition, twelve samples in total
- Processed counts asset: `GSE178352_tximportCounts.txt.gz`
- Asset size published by GEO: approximately 4.4 MB
- GEO page: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352`
- PubMed page: `https://pubmed.ncbi.nlm.nih.gov/34180400/`

The repository fixture is a documented, deterministic slice of the official
asset. Its manifest records the source URL, retrieval timestamp, full source
checksum when known, fixture checksum, retained rows and columns, and the
extraction command. A marked live integration test downloads and validates the
complete official asset.

## Architectural Decision

Retain the OpenAI Agents SDK as the runtime for understanding user intent and
choosing capabilities. Do not let the model directly assemble the final output
package.

```text
OpenAI Agents SDK
        |
        v
Main Agent
        |
        v
TaskSpecification
        |
        v
Deterministic Pipeline Runner
        |
        +-- Discovery
        +-- Acquisition
        +-- Processing
        +-- Artifact Builder
        +-- Validation Gate
        |
        v
artifacts/
```

The Agent may generate queries and select an accession. The pipeline enforces
stage order, input/output contracts, provenance, timeouts and artifact quality.

## Responsibilities

### Agent

- Understand the topic and optional filters.
- Select enabled databases.
- Generate a structured `TaskSpecification`.
- Request confirmation before expanding beyond user-selected databases.
- Invoke the pipeline through one SDK Function Tool.
- Explain structured pipeline errors without inventing missing data.

### Pipeline

- Persist every stage attempt independently and make stage operations
  idempotent.
- Reuse a successful stage output only when its input and parameter digests
  match.
- Resume after failure from the most recent verified stage output.
- Accept typed inputs and return typed outputs.
- Download immutable raw files and calculate SHA-256 checksums.
- Parse only successful `SourceAsset` objects, never arbitrary URLs, failed
  attempts or partial files.
- Record transformations, row counts, warnings and versions.
- Build artifacts in a staging directory.
- Publish the package only after validation succeeds.

### Skills and Tools

- Skills remain capability bundles selected by the Agent.
- Website Tools implement search, metadata and download operations.
- Download Tools return `DownloadAttempt` and, on success, `SourceAsset`; they
  do not parse data.
- Processing Tools accept local assets or parsed datasets.
- Skills do not replace the Pipeline Runner and cannot skip its validation gate.

## Core Contracts

All contracts inherit from one Pydantic v2 base:

```python
class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)
```

Collections use `Field(default_factory=...)`. Strict coercion is enabled per
identifier and numeric field rather than globally. Every serialized contract
contains `schema_version="1.0"`.

### Enumerations and IDs

Formal enums define `Database`, `DataLevel`, `RequestedOutput`, `TaskState`,
`StageName`, `AttemptStatus`, `DownloadStatus`, `WarningSeverity` and
`ErrorCode`.

- API-generated task and attempt IDs use lowercase UUID4 with a type prefix.
- Dataset IDs use the canonical database and accession, for example
  `ds_geo_gse178352`.
- Source IDs hash the canonical `(database, accession, URL)` tuple.
- Asset IDs are derived from the full SHA-256 after a successful download.
- Record IDs hash `(dataset_id, gene_id_raw, sample_id)`.
- Event IDs use UUID4; sequence is a separate task-local integer.

### TaskRequest

```python
class TaskRequest(ContractModel):
    topic: str
    databases: list[Database] = Field(
        default_factory=lambda: [Database.PUBMED, Database.GEO]
    )
    keywords: list[str] = Field(default_factory=list)
    target_fields: list[str] = Field(default_factory=list)
    time_range: tuple[str, str] | None = None
```

`topic` is the only required business input. The API generates `task_id`.

### QuerySpecification and DatasetSelection

```python
class QuerySpecification(ContractModel):
    query_id: str
    database: Database
    query: str
    generated_by: Literal["user", "agent", "pipeline"]
    purpose: str
    order: int
    page_size: int | None = None
    max_results: int | None = None

class DatasetSelection(ContractModel):
    dataset_id: str
    database: Database
    accession: str
    source_id: str | None = None
    reason: str
```

Execution logs additionally record the original user keywords, Agent rewrite,
NCBI term translation, page parameters and returned order.

### TaskSpecification

```python
class TaskSpecification(ContractModel):
    topic: str
    queries: list[QuerySpecification]
    datasets: list[DatasetSelection]
    requested_outputs: list[RequestedOutput]
```

This is a data requirement, not an executable sequence of arbitrary code.

### SourceRecord and SourceRelation

```python
class SourceRecord(ContractModel):
    source_id: str
    database: Database
    accession: str
    url: str
    title: str
    retrieved_at: datetime

class SourceRelation(ContractModel):
    relation_id: str
    from_source_id: str
    to_source_id: str
    relation_type: str
    evidence_type: str
    evidence_value: str
    evidence_url: str
```

Relations represent article-to-dataset, dataset-to-BioProject/SRA and similar
evidence without embedding foreign-key arrays inside CSV cells.

### DownloadAttempt and SourceAsset

```python
class DownloadAttempt(ContractModel):
    attempt_id: str
    source_id: str
    url: str
    status: DownloadStatus
    bytes_received: int
    error_code: ErrorCode | None = None
    error_message: str | None = None
    started_at: datetime
    finished_at: datetime

class FileAsset(ContractModel):
    asset_id: str
    kind: Literal["source", "parsed", "normalized", "artifact"]
    relative_path: str
    sha256: str
    size_bytes: int
    media_type: str
    schema_version: str
    generated_by_step_id: str | None = None

class SourceAsset(FileAsset):
    source_id: str
    successful_attempt_id: str
    data_level: DataLevel
```

`SourceAsset` exists only after a successful, complete and verified download.
`DataLevel` distinguishes `raw_sequence`, `submitter_processed`,
`repository_processed` and `metadata`. GSE178352 tximport counts are
`repository_processed`, not raw sequencing data.

Source paths must resolve inside `source_assets/`. Partial files stay in a
temporary download directory and are never parser inputs.

### SourceLocator

```python
class SourceLocator(ContractModel):
    asset_id: str
    logical_file: str
    source_line_number: int
    source_column_index: int
    source_column_name: str
    raw_value: str
```

`logical_file` is the decompressed member name. `source_line_number` is the
one-based physical line number in the decoded logical text and counts headers,
comments and blank lines. `source_column_index` is zero-based and
`source_column_name` is the exact decoded header token. Numeric validation
parses `raw_value` with the documented parser before comparison.

### ParsedDataset

```python
class ParsedDataset(ContractModel):
    dataset_id: str
    source_id: str
    source_asset_id: str
    file_asset: FileAsset
    columns: list[str]
    row_count: int
    parser_name: str
    parser_version: str
```

Large tabular content remains on disk. Contracts contain metadata and paths,
not full tables in memory.

### StageAttempt

```python
class StageAttempt(ContractModel):
    stage_attempt_id: str
    task_id: str
    stage: StageName
    attempt: int
    input_digest: str
    parameter_digest: str
    output_digest: str | None = None
    status: AttemptStatus
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: ErrorDetail | None = None
```

Statuses are `pending`, `running`, `succeeded`, `failed`, `cancelled` and
`skipped`. Retries create new attempts; they never overwrite history.

### Warning, Error, Artifact and RunManifest

```python
# JsonValue is the recursive union of JSON scalar, array and object values.
class ErrorDetail(ContractModel):
    code: ErrorCode
    message: str
    retryable: bool
    stage: StageName | None = None
    details: dict[str, JsonValue] = Field(default_factory=dict)

class WarningRecord(ContractModel):
    warning_id: str
    severity: WarningSeverity
    stage: StageName
    code: str
    message: str
    source_id: str | None = None
    asset_id: str | None = None
    record_id: str | None = None
    created_at: datetime

class ArtifactManifestEntry(ContractModel):
    artifact_id: str
    name: str
    relative_path: str
    media_type: str
    size_bytes: int
    sha256: str
    generated_by_step_id: str

class ValidationSummary(ContractModel):
    status: Literal["valid", "invalid"]
    checked_count: int
    failed_count: int
    report_path: str

class RunManifest(ContractModel):
    task_id: str
    id_generation_version: str
    request: TaskRequest
    specification: TaskSpecification
    task_state: TaskState
    stage_attempt_ids: list[str]
    source_ids: list[str]
    artifacts: list[ArtifactManifestEntry]
    validation: ValidationSummary
    pipeline_version: str
    model_name: str | None
    started_at: datetime
    finished_at: datetime
```

Manifest ID lists are canonical and sorted. It contains no secrets. Event
payload contracts are `TaskCreatedPayload`, `PlanReadyPayload`,
`StageStartedPayload`, `StageCompletedPayload`, `StageFailedPayload`,
`StageSkippedPayload`, `ToolCalledPayload`, `ToolCompletedPayload`,
`WarningPayload`, `ArtifactProducedPayload`, `CancelRequestedPayload`,
`TaskCancelledPayload`, `TaskRecoveredPayload`, `TaskCompletedPayload` and
`TaskFailedPayload`; the envelope discriminates them by `type`.

## Pipeline Stages

### 1. Discovery

Inputs: `TaskRequest` and optional Agent-generated queries.

Outputs:

- structured PubMed records;
- structured GEO dataset candidates;
- the actual query strings, timestamps, result order and URLs;
- the relationship between PMID `34180400` and `GSE178352` for the pinned case.

Discovery writes no final scientific rows.

PubMed uses NCBI E-utilities rather than HTML scraping. The client sends the
configured `tool`, developer `email` and User-Agent, batches ID fetches, logs
every request, and applies one process-wide limiter: at most 3 requests/second
without an NCBI API key and 10 requests/second with the default API-key quota.
HTTP 429 and retryable 5xx responses use bounded exponential backoff with
jitter and respect `Retry-After`.

### 2. Acquisition

Inputs: selected source records.

Rules:

- stream downloads with explicit connect/read/total timeouts;
- write incomplete bytes into a task-local temporary download directory;
- never overwrite an existing asset with a different checksum;
- persist every `DownloadAttempt`, including partial and failed attempts;
- create a `SourceAsset` only after a complete file is verified;
- record URL, data level, status, byte count, MIME type, retrieved time and
  SHA-256;
- preserve compressed official assets unchanged;
- return structured failures instead of empty success results.

Successful bytes enter a content-addressed cache:

```text
data/cache/blobs/sha256/ab/cd/<full-sha256>
data/cache/metadata/<canonical-request-hash>.json
```

The request cache key uses canonical database/accession/URL/request parameters,
never free-text keywords alone. The task `source_assets/` directory receives a
hard link when supported on the same filesystem and a verified copy otherwise.

### 3. Processing

Inputs: successful `SourceAsset` only.

For GSE178352:

1. decompress the official counts file into `parsed/`;
2. parse the tab-delimited matrix without using GEO search IDs as accessions;
3. validate sample columns against the twelve GEO samples;
4. reshape to the canonical long form;
5. normalize field names and scalar types;
6. write normalized data into `normalized/`;
7. record the exact `SourceLocator` for each source-derived measurement;
8. preserve the original cell-line name and record canonicalization separately.

No differential-expression result is invented. Analysis is a later optional
stage and may run only when the requested comparison and method are explicit.

For the pinned case, sample metadata contains `cell_line_raw`,
`cell_line_canonical` and `normalization_rule`. For example, the GEO spelling
`MD-MBA-231` is preserved while the canonical value `MDA-MB-231` is attributed
to `cell-line-name-correction-v1`.

### 4. Artifact Builder

Artifacts are first written to an isolated staging directory under the task.
The builder never mixes literature rows, dataset rows and measurements in one
table.

### 5. Validation Gate

The package is rejected when any mandatory rule fails:

- every `main_data.source_id` exists in `source_list.csv`;
- every `main_data.dataset_id` exists in `dataset_catalog.csv`;
- every `main_data.sample_id` exists in `sample_metadata.csv`;
- every sample-metadata dataset exists in `dataset_catalog.csv`;
- every `main_data.asset_id` exists in `source_assets.csv` and points to a
  successful download attempt;
- every referenced source asset exists and its SHA-256 matches;
- every `main_data.csv` column has a field description;
- every source-derived measurement has a complete `SourceLocator`;
- the pinned GSE178352 case validates every expression value against the
  decompressed source asset;
- general tasks validate all structural references plus a deterministic,
  configurable sample of source-derived values (100 by default);
- processing steps contain input, output, version and before/after row counts;
- CSV files have a single header, stable column counts and UTF-8 encoding;
- warnings and metrics report the same warning/error totals;
- mandatory artifacts exist and are non-empty.

On failure, validation details are written to `logs/validation_report.json` and
the staging package is not promoted to `artifacts/`.

Publishing is task-locked and uses a unique staging directory. The builder
writes and flushes every file, generates the manifest, runs validation, marks
the manifest valid, then publishes with same-filesystem `os.replace`. Directory
fsync is used where supported. Only after publication may the runner persist
`artifact_produced` and `task_completed` events.

## Artifact Contract

The accepted package contains:

```text
artifacts/
|-- run_manifest.json
|-- main_data.csv
|-- literature.csv
|-- dataset_catalog.csv
|-- sample_metadata.csv
|-- field_descriptions.csv
|-- field_mapping.csv
|-- source_list.csv
|-- source_relations.csv
|-- source_assets.csv
|-- download_log.csv
|-- processing_log.csv
|-- quality_report.csv
`-- warnings.csv
```

### main_data.csv

One row represents one gene measurement in one sample.

Required columns:

```text
record_id,dataset_id,source_id,asset_id,gene_id_raw,gene_id,
gene_id_namespace,gene_id_version,sample_id,measurement_type,
value_semantics,value_scale,is_normalized,is_integer_expected,
expression_value,expression_unit,source_logical_file,source_line_number,
source_column_index,source_column_name,source_raw_value
```

It contains no paper title, abstract, dataset description or unsupported
statistical result.

`gene_id_raw` preserves the source token. `gene_id_namespace` distinguishes
Ensembl, Entrez, symbol and transcript identifiers; `gene_id_version` stores a
removed version suffix when normalization is explicitly configured.
`measurement_type`, `value_semantics`, `value_scale`, `is_normalized` and
`is_integer_expected` come from repository metadata and the documented
processing method. The GSE178352 fixture may not label tximport-derived values
as generic raw counts unless that interpretation is supported by its source.

### literature.csv

Required columns:

```text
source_id,pmid,pmcid,doi,title,authors,journal,published_at,
source_url,retrieved_at
```

`authors` is a JSON array preserving publication order.

### dataset_catalog.csv

Required columns:

```text
dataset_id,source_id,database,accession,title,organism,experiment_type,
sample_count,platform_ids,related_pmids,source_url,retrieved_at
```

`platform_ids` and `related_pmids` are canonical JSON arrays sorted
lexicographically. Article-dataset evidence is stored in
`source_relations.csv`, not inferred from these convenience fields.

### sample_metadata.csv

Required columns for GSE178352:

```text
sample_id,dataset_id,source_id,cell_line_raw,cell_line_canonical,
normalization_rule,treatment,replicate,organism,source_url
```

### field_descriptions.csv

One row for every `main_data.csv` column:

```text
field_name,data_type,description,unit,nullable,source,example
```

### field_mapping.csv

```text
dataset_id,raw_field,canonical_field,conversion,confidence,notes
```

### source_list.csv

```text
source_id,database,accession,url,title,retrieved_at
```

### source_relations.csv

```text
relation_id,from_source_id,to_source_id,relation_type,evidence_type,
evidence_value,evidence_url
```

### source_assets.csv

```text
asset_id,source_id,successful_attempt_id,data_level,relative_path,
size_bytes,sha256,media_type,schema_version
```

### download_log.csv

```text
attempt_id,source_id,url,status,bytes_received,error_code,error_message,
started_at,finished_at
```

### processing_log.csv

```text
step_id,stage_attempt_id,stage,operation,input_refs,output_refs,tool_version,
rows_before,rows_after,parameters,status,started_at,finished_at,warnings
```

JSON-valued cells use canonical JSON with double quotes and sorted object keys.
`input_refs` and `output_refs` are lexicographically sorted ID arrays;
`warnings` preserves creation order; `parameters` is a canonical JSON object.

### quality_report.csv

```text
check_id,scope,check_name,status,checked_count,failed_count,details
```

### run_manifest.json

Conforms to the formal `RunManifest` contract. It records `schema_version`, ID
generation version, task request, task specification, task state, stage
attempts, selected sources, model and pipeline versions, timestamps, artifact
manifest, validation summary and reproducible commands. It contains no secrets.

### warnings.csv

```text
warning_id,severity,stage,code,message,source_id,asset_id,record_id,created_at
```

## Task Directory

```text
data/output/tasks/<task_id>/
|-- source_assets/
|-- download_tmp/
|-- parsed/
|-- normalized/
|-- staging/<run_id>/
|-- artifacts/
|-- state/
`-- logs/
```

Only manifest-registered files in `artifacts/` are exposed by the download API.
Source assets remain immutable. `state/` stores the task lock and the latest
recoverable state; append-only stage attempts and events live in `logs/`.

## API and Event Contract

Phase 1 preserves FastAPI and verifies the existing Artifact GET routes against
validated output. Phase 2 adds typed task creation, status and event APIs:

- `POST /api/v1/tasks` creates a task and returns `task_id`.
- `GET /api/v1/tasks/{task_id}` returns typed state and current stage.
- `GET /api/v1/tasks/{task_id}/artifacts` lists validated artifacts only.
- `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` resolves an artifact
  through the validated manifest and downloads it.

Events use one envelope:

```json
{
  "schema_version": "1.0",
  "event_id": "event_...",
  "type": "stage_started",
  "task_id": "task-...",
  "stage_attempt_id": "stage_attempt_...",
  "sequence": 1,
  "timestamp": "2026-07-12T00:00:00Z",
  "payload": {}
}
```

Mandatory event types are `task_created`, `plan_ready`, `stage_started`,
`stage_completed`, `stage_failed`, `stage_skipped`, `tool_called`,
`tool_completed`, `warning`, `artifact_produced`, `task_cancel_requested`,
`task_cancelled`, `task_recovered`, `task_completed` and `task_failed`.

Each event type owns a Pydantic payload in a discriminated union. Sequence is
strictly increasing within one task. Events are appended to `events.jsonl`
before WebSocket publication and can be replayed from a client-provided
sequence. A task lock and state transition guard enforce exactly one terminal
task state.

## Timeout and Failure Policy

- Model calls, network calls, downloads, parsing and full tasks have separate
  configurable timeouts.
- A task terminal event is guaranteed.
- Cancellation and process recovery are persisted as task and stage states.
- Restarting a task reuses only outputs whose input, parameter and file digests
  still match; otherwise it creates a new stage attempt.
- Tool failures include a stable error code, retryability and safe message.
- The pipeline never converts a failed live workflow into a successful mock
  result.
- Mock mode is explicit and cannot satisfy live acceptance tests.
- Missing model credentials do not prevent importing the app or running
  deterministic pipeline tests; credentials are checked when a model run starts.

## Test Strategy

### Unit Tests

- contract validation and unsafe path rejection;
- ID generation, enum serialization and cross-table foreign keys;
- GEO numeric search-ID to accession/metadata conversion;
- NCBI rate limiting, batching and retry policy;
- download attempts, checksum, cache reuse and interrupted downloads;
- matrix parsing and long-form reshaping;
- precise source locators and cell-line/gene-ID normalization lineage;
- idempotent stage attempts, task locks, cancellation and recovery;
- field mapping, quality checks and row-count logging;
- every validation-gate rule;
- artifact schemas and deterministic ordering;
- event serialization and terminal-state guarantees.

### Offline Integration Tests

- run the complete pinned case against the documented real-data fixture;
- generate the full artifact package;
- verify every record-to-source lineage locator and every pinned-case
  expression value;
- verify the package is accessible through the Artifact API;
- run without DashScope credentials.

### Live Integration Tests

Marked `live` and excluded from the default fast suite:

- retrieve PMID 34180400 from PubMed;
- retrieve GSE178352 metadata from GEO;
- download the complete 4.4 MB counts asset;
- verify expected sample identifiers, checksum and parser compatibility;
- execute one minimal Qwen planning request;
- enforce bounded total runtime and a terminal event.

## Delivery Phases

### Phase 1: Backend Data Closure

- contracts and task directories;
- PubMed/GEO clients and pinned case;
- acquisition, parser and provenance;
- artifact package and validation gate;
- offline and live tests;
- deterministic pipeline entry point.

### Phase 2: Agent and API Integration

- structured TaskSpecification generation;
- pipeline Function Tool;
- typed task APIs and event envelope;
- cancellation, timeout and status recovery;
- remove mock fallback from acceptance paths.

### Phase 3: shadcn Frontend Rewrite

- task creation rather than chat-first interaction;
- plan confirmation;
- stage timeline;
- result tabs for data, sources, processing and warnings;
- artifact download and compact table previews;
- one shared task/event client.

### Phase 4: Additional Sources

Add PDF/supplementary-table processing, then GDC, PDB and Xena using the same
contracts and validation gate. No source is marked supported before its live
search, metadata and download tests pass.

## Non-Goals

- Replacing the OpenAI Agents SDK.
- Building a general workflow engine or SiteRecipe DSL.
- Letting generated Skills bypass validation.
- Performing automatic scientific inference or clinical conclusions.
- Treating mock data as a successful competition case.
- Rewriting the frontend before the backend event and artifact contracts settle.

## Acceptance Criteria

Phase 1 is complete only when all of the following are demonstrated in one
fresh verification run:

1. The default test suite passes without real model credentials.
2. The pinned offline case produces every mandatory artifact.
3. Validation checks every pinned-case source-derived expression value against
   its exact source locator.
4. The Artifact API resolves registered artifact IDs and downloads the
   validated package.
5. The live suite completes PubMed and GEO retrieval within configured bounds.
6. A failed live run remains failed and never reports mock success.
7. Cancellation and restart preserve attempt history and recover only matching
   verified outputs.
8. The repository contains no contradictory completion claim in TODO or docs.
