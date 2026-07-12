# Backend Data Closure Design

## Status

Approved design for the backend-first remediation of BioMed-QAgent.

## Goal

Build a deterministic, testable data pipeline beneath the existing OpenAI
Agents SDK integration so that every final value can be traced to a downloaded
raw asset and a recorded processing step.

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

- Execute every required stage exactly once unless a recorded retry occurs.
- Accept typed inputs and return typed outputs.
- Download immutable raw files and calculate SHA-256 checksums.
- Parse only `RawAsset` objects, never arbitrary URLs.
- Record transformations, row counts, warnings and versions.
- Build artifacts in a staging directory.
- Publish the package only after validation succeeds.

### Skills and Tools

- Skills remain capability bundles selected by the Agent.
- Website Tools implement search, metadata and download operations.
- Download Tools return `RawAsset`; they do not parse data.
- Processing Tools accept local assets or parsed datasets.
- Skills do not replace the Pipeline Runner and cannot skip its validation gate.

## Core Contracts

All contracts use Pydantic v2 and reject unknown fields at API boundaries.

### TaskRequest

```python
class TaskRequest(BaseModel):
    topic: str
    databases: list[str] = ["pubmed", "geo"]
    keywords: list[str] = []
    target_fields: list[str] = []
    time_range: tuple[str, str] | None = None
```

`topic` is the only required business input. The API generates `task_id`.

### TaskSpecification

```python
class TaskSpecification(BaseModel):
    topic: str
    queries: dict[str, str]
    datasets: list[DatasetSelection]
    requested_outputs: list[str]
```

This is a data requirement, not an executable sequence of arbitrary code.

### SourceRecord

```python
class SourceRecord(BaseModel):
    source_id: str
    database: str
    accession: str
    url: str
    title: str
    retrieved_at: datetime
```

### RawAsset

```python
class RawAsset(BaseModel):
    asset_id: str
    source_id: str
    relative_path: str
    sha256: str
    mime_type: str
    size_bytes: int
    status: Literal["success", "partial", "failed"]
```

Paths are task-relative and must resolve inside `raw/`.

### ParsedDataset

```python
class ParsedDataset(BaseModel):
    dataset_id: str
    source_id: str
    asset_id: str
    relative_path: str
    columns: list[str]
    row_count: int
    parser_name: str
    parser_version: str
```

Large tabular content remains on disk. Contracts contain metadata and paths,
not full tables in memory.

### Artifact

```python
class Artifact(BaseModel):
    artifact_id: str
    name: str
    relative_path: str
    media_type: str
    size_bytes: int
    sha256: str
    generated_by: str
```

## Pipeline Stages

### 1. Discovery

Inputs: `TaskRequest` and optional Agent-generated queries.

Outputs:

- structured PubMed records;
- structured GEO dataset candidates;
- the actual query strings, timestamps, result order and URLs;
- the relationship between PMID `34180400` and `GSE178352` for the pinned case.

Discovery writes no final scientific rows.

### 2. Acquisition

Inputs: selected source records.

Rules:

- stream downloads with explicit connect/read/total timeouts;
- write only into `raw/`;
- never overwrite an existing asset with a different checksum;
- record URL, status, byte count, MIME type, retrieved time and SHA-256;
- preserve compressed official assets unchanged;
- return structured failures instead of empty success results.

### 3. Processing

Inputs: `RawAsset` only.

For GSE178352:

1. decompress the official counts file into `parsed/`;
2. parse the tab-delimited matrix without using GEO search IDs as accessions;
3. validate sample columns against the twelve GEO samples;
4. reshape to the canonical long form;
5. normalize field names and scalar types;
6. write normalized data into `normalized/`;
7. record raw row and column locations for lineage.

No differential-expression result is invented. Analysis is a later optional
stage and may run only when the requested comparison and method are explicit.

### 4. Artifact Builder

Artifacts are first written to an isolated staging directory under the task.
The builder never mixes literature rows, dataset rows and measurements in one
table.

### 5. Validation Gate

The package is rejected when any mandatory rule fails:

- every `main_data.source_id` exists in `source_list.csv`;
- every `main_data.asset_id` exists in `download_log.csv`;
- every referenced raw asset exists and its SHA-256 matches;
- every `main_data.csv` column has a field description;
- every normalized value has a raw row and column locator;
- a deterministic sample of up to 100 values equals the value in the raw asset;
- processing steps contain input, output, version and before/after row counts;
- CSV files have a single header, stable column counts and UTF-8 encoding;
- warnings and metrics report the same warning/error totals;
- mandatory artifacts exist and are non-empty.

On failure, validation details are written to `logs/validation_report.json` and
the staging package is not promoted to `artifacts/`.

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
|-- download_log.csv
|-- processing_log.csv
|-- quality_report.csv
`-- warnings.csv
```

### main_data.csv

One row represents one gene measurement in one sample.

Required columns:

```text
record_id,dataset_id,source_id,asset_id,gene_id,sample_id,
expression_value,expression_unit,source_row,source_column
```

It contains no paper title, abstract, dataset description or unsupported
statistical result.

### literature.csv

Required columns:

```text
source_id,pmid,pmcid,doi,title,authors,journal,published_at,
dataset_accessions,source_url,retrieved_at
```

### dataset_catalog.csv

Required columns:

```text
source_id,database,accession,title,organism,experiment_type,
sample_count,platform_ids,related_pmids,source_url,retrieved_at
```

### sample_metadata.csv

Required columns for GSE178352:

```text
sample_id,dataset_id,source_id,cell_line,treatment,replicate,
organism,source_url
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

### download_log.csv

```text
asset_id,source_id,url,relative_path,status,size_bytes,sha256,
mime_type,retrieved_at,error
```

### processing_log.csv

```text
step_id,stage,operation,input_refs,output_refs,tool_version,
rows_before,rows_after,parameters,status,started_at,finished_at,warnings
```

JSON-valued cells use valid JSON with double quotes.

### quality_report.csv

```text
check_id,scope,check_name,status,checked_count,failed_count,details
```

### run_manifest.json

Records the task request, task specification, selected sources, model name,
pipeline version, timestamps, artifact list, validation status and reproducible
commands. It contains no secrets.

## Task Directory

```text
data/output/tasks/<task_id>/
|-- raw/
|-- parsed/
|-- normalized/
|-- staging/
|-- artifacts/
`-- logs/
```

Only `artifacts/` is exposed by the download API. Raw assets remain immutable.

## API and Event Contract

Phase 1 preserves FastAPI and verifies the existing Artifact GET routes against
validated output. Phase 2 adds typed task creation, status and event APIs:

- `POST /api/v1/tasks` creates a task and returns `task_id`.
- `GET /api/v1/tasks/{task_id}` returns typed state and current stage.
- `GET /api/v1/tasks/{task_id}/artifacts` lists validated artifacts only.
- `GET /api/v1/tasks/{task_id}/artifacts/{path}` downloads one artifact.

Events use one envelope:

```json
{
  "type": "stage_started",
  "task_id": "task-...",
  "sequence": 1,
  "timestamp": "2026-07-12T00:00:00Z",
  "payload": {}
}
```

Mandatory event types are `task_created`, `plan_ready`, `stage_started`,
`stage_completed`, `tool_called`, `tool_completed`, `warning`,
`artifact_produced`, `task_completed` and `task_failed`.

## Timeout and Failure Policy

- Model calls, network calls, downloads, parsing and full tasks have separate
  configurable timeouts.
- A task terminal event is guaranteed.
- Tool failures include a stable error code, retryability and safe message.
- The pipeline never converts a failed live workflow into a successful mock
  result.
- Mock mode is explicit and cannot satisfy live acceptance tests.
- Missing model credentials do not prevent importing the app or running
  deterministic pipeline tests; credentials are checked when a model run starts.

## Test Strategy

### Unit Tests

- contract validation and unsafe path rejection;
- GEO numeric search-ID to accession/metadata conversion;
- checksum and streaming download behavior;
- matrix parsing and long-form reshaping;
- field mapping, quality checks and row-count logging;
- every validation-gate rule;
- artifact schemas and deterministic ordering;
- event serialization and terminal-state guarantees.

### Offline Integration Tests

- run the complete pinned case against the documented real-data fixture;
- generate the full artifact package;
- verify every record-to-raw lineage locator;
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
3. Validation checks every output value against its recorded raw location.
4. The Artifact API lists and downloads the validated package.
5. The live suite completes PubMed and GEO retrieval within configured bounds.
6. A failed live run remains failed and never reports mock success.
7. The repository contains no contradictory completion claim in TODO or docs.
