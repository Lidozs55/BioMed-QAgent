# Phase 1B NCBI/GEO Discovery and Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current ad-hoc PubMed/GEO network calls with one tested
NCBI integration that resolves numeric GEO UIDs to real GSE accessions and
creates verified `SourceAsset` records without parsing downloaded data.

**Architecture:** `app.integrations.ncbi` owns HTTP policy and response parsing;
Skills become thin Agent-facing adapters. Official responses and a controlled
slice of `GSE178352_tximportCounts.txt.gz` provide offline acceptance evidence.
Acquisition streams into `download_tmp/`, verifies bytes, enters the
content-addressed cache, then publishes an immutable task-local source asset.

**Tech Stack:** Python 3.12, Pydantic v2, httpx, asyncio, pytest,
pytest-asyncio, NCBI E-utilities and GEO HTTPS downloads.

## Global Constraints

- Default tests must not access the network or require DashScope credentials.
- NCBI requests include configured `tool`, developer `email` and User-Agent.
- Limit all E-utilities calls process-wide to 3 requests/second without an API
  key and 10 requests/second with an API key.
- Retry only HTTP 429 and 5xx responses with bounded exponential backoff and
  `Retry-After` support.
- Default pytest configuration excludes `live`; live network tests require an
  explicit marker and environment opt-in.
- GEO search UIDs are never passed to GEOparse as accessions.
- Download code never decompresses or parses source files.
- A `SourceAsset` exists only after complete bytes and SHA-256 are verified.
- Frontend files and frontend skills are out of scope.

---

### Task 1: Reproducible official fixtures

**Files:**

- Create: `backend/scripts/build_gse178352_fixture.py`
- Create: `backend/tests/fixtures/ncbi/gse178352/manifest.json`
- Create: `backend/tests/fixtures/ncbi/gse178352/pubmed_34180400.xml`
- Create: `backend/tests/fixtures/ncbi/gse178352/pubmed_esearch.json`
- Create: `backend/tests/fixtures/ncbi/gse178352/geo_esearch.json`
- Create: `backend/tests/fixtures/ncbi/gse178352/geo_esummary.json`
- Create: `backend/tests/fixtures/ncbi/gse178352/geo_suppl_listing.html`
- Create: `backend/tests/fixtures/ncbi/gse178352/tximport_counts_slice.tsv`
- Create: `backend/tests/integration/test_gse178352_fixture.py`

**Interfaces:**

- Consumes: official URLs pinned in the approved design.
- Produces: `build_fixture(output_dir: Path, retrieved_at: datetime) -> Path`
  and a manifest containing source/fixture checksums used by later tests.

- [ ] **Step 1: Write the failing fixture-integrity test**

The test loads `manifest.json`, verifies all fixture file SHA-256 values, asserts
the full source metadata equals:

```python
assert source["size_bytes"] == 4_597_797
assert source["sha256"] == (
    "71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55"
)
assert manifest["retained_source_lines"] == [1, 2, 3, 4, 5]
assert manifest["retained_data_columns"] == list(range(38))
```

It also asserts the source's irregular shape without silently repairing it: the
header has 37 fields because the leading Ensembl-ID column is unnamed, each
data row has 38 fields, twelve header fields start with `counts.`, and the
first data-row gene token is `ENSG00000000003`.

- [ ] **Step 2: Run the fixture test and verify RED**

Run `uv run pytest tests/integration/test_gse178352_fixture.py -q` from
`backend/`. Expected: fixture files do not exist.

- [ ] **Step 3: Implement and run the fixture builder**

The builder downloads these exact URLs with an identifying User-Agent:

```python
PUBMED_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    "?db=pubmed&id=34180400&retmode=xml"
)
PUBMED_SEARCH_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    "?db=pubmed&term=34180400%5BPMID%5D&retmax=1&retmode=json"
)
GEO_SEARCH_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    "?db=gds&term=GSE178352%5BAccession%5D&retmode=json"
)
GEO_SUMMARY_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
    "?db=gds&id=200178352&retmode=json"
)
COUNTS_URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/"
    "suppl/GSE178352_tximportCounts.txt.gz"
)
GEO_SUPPL_LISTING_URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/suppl/"
)
```

It preserves the five official response bodies, extracts physical lines 1-5
from the decompressed counts file without changing tokens, calculates all
checksums, and writes canonical sorted/indented JSON for the manifest.
The manifest also records request parameters, response content types, fixture
sizes, twelve sample accessions, the PMID-to-GSE evidence relation, logical
filename, script version and exact extraction command.

- [ ] **Step 4: Verify GREEN**

Run the focused fixture test twice. The second run must pass without rebuilding
or network access.

- [ ] **Step 5: Commit**

```powershell
git add backend/scripts/build_gse178352_fixture.py backend/tests/fixtures backend/tests/integration/test_gse178352_fixture.py
git commit -m "test: add reproducible GSE178352 fixtures"
```

### Task 2: Typed discovery records and response parsers

**Files:**

- Create: `backend/app/domain/contracts/discovery.py`
- Update: `backend/app/domain/contracts/__init__.py`
- Create: `backend/app/integrations/__init__.py`
- Create: `backend/app/integrations/ncbi/__init__.py`
- Create: `backend/app/integrations/ncbi/parsers.py`
- Create: `backend/tests/integrations/ncbi/test_parsers.py`

**Interfaces:**

- Consumes: fixture bytes from Task 1.
- Produces:
  - `parse_pubmed_xml(xml: bytes) -> list[LiteratureRecord]`
  - `parse_geo_esearch(payload: bytes) -> GeoSearchPage`
  - `parse_geo_esummary(payload: bytes) -> list[GeoSeriesRecord]`
  - `resolve_geo_supplementary_assets(html: bytes, base_url: str) -> list[GeoAssetCandidate]`

- [ ] **Step 1: Write failing parser tests**

Assert PMID `34180400` preserves ordered authors, DOI, PMCID when present,
journal, title and abstract. Assert GEO eSearch records numeric UIDs and term
translation but does not call them accessions. Assert GEO eSummary maps UID
`200178352` to accession `GSE178352`, twelve ordered samples, organism, platform,
PMID `34180400` and BioProject. Assert the separate supplementary-listing
resolver, not eSummary, returns the official processed-counts URL.

- [ ] **Step 2: Verify RED**

Run `uv run pytest tests/integrations/ncbi/test_parsers.py -q`. Expected: the
new contracts and parser module are missing.

- [ ] **Step 3: Implement strict contracts and pure parsers**

Use `ContractModel`, `Field(default_factory=...)`, ordered author/sample lists,
and strict `extra="forbid"`. XML text uses `"".join(element.itertext())` so
inline tags do not truncate titles or abstracts; publication dates come from
Journal `PubDate` or `ArticleDate`, never `DateRevised`. `GeoSearchPage.ids` remains a
list of numeric strings; only `GeoSeriesRecord.accession` may contain `GSE...`.

- [ ] **Step 4: Verify GREEN and regression**

Run parser tests, all contract tests, then the full offline backend suite.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/domain/contracts backend/app/integrations backend/tests/integrations
git commit -m "feat: parse typed PubMed and GEO discovery records"
```

### Task 3: Shared NCBI E-utilities client policy

**Files:**

- Create: `backend/app/integrations/ncbi/client.py`
- Update: `backend/app/config.py`
- Create: `backend/tests/integrations/ncbi/test_client.py`
- Update: `backend/pyproject.toml`

**Interfaces:**

- Consumes: an injected `httpx.AsyncClient` and NCBI configuration.
- Produces:

```python
class NcbiEutilsClient:
    async def esearch(self, *, db: str, term: str, retmax: int) -> bytes: ...
    async def esummary(self, *, db: str, ids: list[str]) -> bytes: ...
    async def efetch(self, *, db: str, ids: list[str], retmode: str) -> bytes: ...
```

- [ ] **Step 1: Write failing policy tests**

With `httpx.MockTransport`, assert `tool`, `email`, optional `api_key`, retmode,
ID batching and User-Agent are sent. Inject a fake monotonic clock/sleeper and
assert the shared limiter enforces 3/s or 10/s. Return 429 with `Retry-After`,
then 503, then 200 and assert bounded retries; return 400 and assert no retry.

- [ ] **Step 2: Verify RED**

Run `uv run pytest tests/integrations/ncbi/test_client.py -q`. Expected: client
module is missing.

- [ ] **Step 3: Implement the minimum client**

Add `ncbi_email`, `ncbi_tool`, `ncbi_api_key` and `ncbi_user_agent` settings.
Use one process-wide async limiter per quota, `httpx.Timeout` with explicit
connect/read/write/pool values, maximum three retries, exponential delays
`0.5, 1.0, 2.0` seconds plus injected jitter, and the larger Retry-After value.
Wrap each operation in an injected application-level total deadline. Parse
`Retry-After` as either seconds or an HTTP date.
Raise a structured `NcbiRequestError` with status, retryability and safe body
excerpt after the final failure.

- [ ] **Step 4: Verify GREEN and regression**

Run client tests and the full offline suite. Tests must finish without sleeping
in real time.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/integrations/ncbi/client.py backend/app/config.py backend/tests/integrations/ncbi/test_client.py backend/pyproject.toml backend/uv.lock
git commit -m "feat: add shared NCBI request policy"
```

### Task 4: PubMed and GEO discovery services

**Files:**

- Create: `backend/app/integrations/ncbi/discovery.py`
- Create: `backend/tests/integrations/ncbi/test_discovery.py`

**Interfaces:**

- Consumes: `NcbiEutilsClient` and Task 2 parsers.
- Produces:

```python
async def search_pubmed(client, query, max_results) -> PubMedSearchResult: ...
async def search_geo_series(client, query, max_results) -> GeoSearchResult: ...
async def describe_geo_series(client, accession) -> GeoSeriesRecord: ...
```

- [ ] **Step 1: Write failing service tests**

Use a fixture-backed fake client. Assert PubMed preserves returned ID order and
query translation. Assert GEO batches numeric eSearch IDs into eSummary, filters
`entrytype != "GSE"`, returns real accessions, and finds exactly `GSE178352` for
the pinned accession query. Assert empty and upstream-error outcomes are typed.

- [ ] **Step 2: Verify RED**

Run the focused discovery test. Expected: service functions are missing.

- [ ] **Step 3: Implement service orchestration**

The GEO path is always `esearch(db="gds") -> esummary(db="gds", ids=...) ->
filter GeoSeriesRecord`; no numeric UID reaches GEOparse. PubMed batches efetch
IDs and reorders parsed records to the exact eSearch order.

- [ ] **Step 4: Verify GREEN and regression**

Run discovery tests and the complete offline suite.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/integrations/ncbi/discovery.py backend/tests/integrations/ncbi/test_discovery.py
git commit -m "feat: add deterministic PubMed and GEO discovery"
```

### Task 5: Verified source acquisition and cache publication

**Files:**

- Create: `backend/app/integrations/acquisition.py`
- Update: `backend/app/tools/content_cache.py`
- Create: `backend/tests/integrations/test_acquisition.py`

**Interfaces:**

- Consumes: URL, `SourceRecord`, `TaskWorkDir`, `ContentCache`, injected
  `httpx.AsyncClient`, `DataLevel`, maximum bytes and optional expected SHA-256.
- Produces:

```python
class AcquisitionResult(ContractModel):
    attempt: DownloadAttempt
    asset: SourceAsset | None = None

async def acquire_source(...) -> AcquisitionResult: ...
```

- [ ] **Step 1: Write failing acquisition tests**

Cover successful chunked download, content-length mismatch, connection error,
maximum-size rejection, expected-checksum mismatch, existing cache reuse and
same-filesystem hard-link fallback to verified copy. Every failure keeps the
partial file outside `source_assets/`, returns a failed `DownloadAttempt`, and
returns `asset is None`. Assert no parser/decompressor is called.
Also reject non-HTTP schemes, URL credentials, unapproved NCBI hosts and
cross-host redirects; sanitize Content-Disposition filenames; simulate a
mid-stream interruption; and reject empty successful responses.

- [ ] **Step 2: Verify RED**

Run `uv run pytest tests/integrations/test_acquisition.py -q`. Expected:
`acquire_source` is missing.

- [ ] **Step 3: Implement streaming verification and publication**

Write to a unique `.part` file under `download_tmp/`, update SHA-256 and byte
count per chunk, flush and fsync, validate length/limit/expected checksum, move
verified bytes into `cache/blobs/sha256/...`, then hard-link or verified-copy to
`source_assets/<asset_id>/<original-name>`. Never overwrite differing bytes.
Use atomic cache publication under a digest lock, re-hash existing blobs before
reuse, and write canonical request metadata keyed by normalized
database/accession/URL/parameters. On copy fallback, copy to a temporary target,
re-hash it, then atomically rename. A shared content `asset_id` may have multiple
source-specific `SourceAsset` rows; validation treats `(asset_id, source_id)` as
the provenance key.

- [ ] **Step 4: Verify GREEN and regression**

Run acquisition tests and the complete offline suite.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/integrations/acquisition.py backend/app/tools/content_cache.py backend/tests/integrations/test_acquisition.py
git commit -m "feat: verify and publish immutable source assets"
```

### Task 6: Thin Skill adapters and live acceptance markers

**Files:**

- Update: `backend/app/skills/builtin/discovery/pubmed.py`
- Update: `backend/app/skills/builtin/acquisition/geo.py`
- Update: `backend/pyproject.toml`
- Create: `backend/tests/integration/test_ncbi_skill_adapters.py`
- Create: `backend/tests/live/test_gse178352_live.py`

**Interfaces:**

- Consumes: Tasks 3-5 services.
- Produces: existing Agent Tool names `search_pubmed`, `search_geo`,
  `describe_geo` and `download_geo` with typed internals and compatible JSON
  output during the API migration.

- [ ] **Step 1: Write failing adapter and live tests**

Configure pytest with `addopts = "-m 'not live'"`; running live tests requires
an explicit `-m live`. Offline adapter tests inject fixture-backed async
services and assert `search_geo`
returns `GSE178352`, never `200178352`; `download_geo` returns a
`repository_processed` `SourceAsset` and does not decompress. Live tests carry
`@pytest.mark.live` and verify PMID, accession, twelve samples, download size
and checksum.

- [ ] **Step 2: Verify RED and marker exclusion**

Run the adapter test and confirm failure. Run `uv run pytest -q` and confirm the
live test is deselected and no network request occurs.

- [ ] **Step 3: Replace ad-hoc Tool internals**

Keep the SDK-facing names and descriptions, but delegate network work to the
new services through `async def` Function Tools with explicit client/service
injection seams. Remove direct `Bio.Entrez`, `urllib.request`, numeric UID
`GEOparse.get_GEO`, download-time decompression and legacy `SourceRecord`
construction from these four paths. Supplementary-material support remains
unchanged and explicitly outside Phase 1B acceptance.

- [ ] **Step 4: Verify offline and live suites**

Run:

```powershell
uv run pytest -q
uv run pytest -m live tests/live/test_gse178352_live.py -q
```

The offline suite must pass without network/key. The live suite must verify
official bytes and finish within its configured timeout.

- [ ] **Step 5: Update TODO and commit**

Check only requirements demonstrated by tests, then commit:

```powershell
git add backend/app/skills backend/tests backend/pyproject.toml backend/uv.lock docs/TODO.md
git commit -m "feat: connect Skills to verified NCBI pipeline"
```

## Phase 1B Verification

Run from `backend/` with no model key:

```powershell
Remove-Item Env:DASHSCOPE_API_KEY -ErrorAction SilentlyContinue
uv run pytest -q
uv run pytest -m live tests/live/test_gse178352_live.py -q
```

Then run `git diff --check` and confirm no frontend file differs from the
merged main baseline because of Phase 1B implementation work.
