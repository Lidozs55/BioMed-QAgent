# Backend P0 Remediation Design

## Status

Approved by the user on 2026-08-03. The user authorized independent technical
decisions and requested uninterrupted execution with one commit per repair.

## Goal

Remove the six backend release blockers confirmed by the 2026-08-03 review so
that credentials stay within their configured trust boundary, checkpoint reuse
is specification-safe, live GEO and GDC runs either publish real scientific
values or fail clearly, packaged live runs do not depend on test fixtures, and
GDC + Xena selections complete the deterministic multi-source pipeline.

## Scope

This worktree covers, in order:

1. TASK-032: saved model API keys must not be sent to a different preview
   endpoint.
2. TASK-036: Pipeline checkpoint parameter digests must include the complete
   normalized input specification and selected databases.
3. TASK-029: GEO acquisition and processing must recover real values and the
   Validation Gate must reject metadata-only packages.
4. TASK-033: live packaged runs must not read or hash `tests/fixtures`.
5. TASK-034: GDC live gene-expression acquisition and parsing must match the
   official API data type and per-file TSV layout.
6. TASK-035: GDC + Xena Discovery and Acquisition must retain both datasets,
   and Xena must keep one `source_id` across all stages.

P1/P2 review findings are out of scope. Each numbered repair is independently
tested and committed. Documentation and final quality-gate updates may be a
separate closing commit.

## Considered Approaches

### A. Fail closed at every unverified boundary (selected)

Add the smallest contract-preserving fixes and reject paths that cannot yet
produce verified scientific rows. This prevents competition demos and release
artifacts from reporting success on placeholders.

### B. Preserve every current success response

Continue returning metadata-only GEO output and accept GDC clinical files with
best-effort parsing. This minimizes visible failures but keeps the central
review defect: a successful task can contain no usable scientific values.

### C. Rewrite the source pipeline around a new adapter framework

A new generic source adapter could unify all discovery, acquisition, and
processing behavior. It would exceed this P0 scope, duplicate current
contracts, and make regression isolation harder.

Approach A is selected because it is surgical, testable, and consistent with
the architecture rule that live failure must never become mock or placeholder
success.

## Design

### 1. Model-preview credential boundary

`POST /api/v1/models` may reuse the persisted API key only when the requested
preview URL, after trailing-slash normalization, is exactly the persisted model
base URL. A different URL receives only `preview_api_key`; when that field is
empty the request is anonymous. Existing public-target resolution, pinned
connection URL, SNI, Host header, redirect prohibition, and response-size
limits remain unchanged.

This preserves the normal settings-page refresh without asking users to retype
the saved key, while changing a base URL can never move the saved secret to a
new origin. Regression tests inspect the actual outbound Authorization header
for same-endpoint and cross-endpoint previews.

### 2. Specification-safe checkpoint reuse

`PipelineRunner._compute_parameter_digest()` will hash:

- stage name;
- topic and mode;
- the sorted selected database identifiers;
- the canonical JSON representation of the complete `TaskSpecification`, or
  `null` when no specification exists;
- the fixture content hash in fixture mode only;
- `run_id` for Artifact Build and Validation, preserving current publication
  isolation.

Using the whole canonical specification intentionally invalidates more stages
than a stage-specific projection. The input object is small, and conservative
re-execution is preferable to stale-source publication. Tests prove that
database, query, dataset, data type, and source changes prevent reuse while an
identical specification remains reusable.

### 3. GEO real-data closure

The GEO live acquisition client remains open through both the primary counts
download and the required family SOFT download. All attempts are retained.

For a series-matrix fallback, Processing parses the expression block between
`!series_matrix_table_begin` and `!series_matrix_table_end`. The first table
row supplies sample columns; each subsequent probe/gene row becomes long-form
records with exact line and column locators. Numeric values are mandatory.
Series-matrix values are marked normalized with an explicit
`series_matrix_value` unit and a GEO probe/gene namespace.

If the matrix has no expression rows, Processing raises a clear error. The
metadata-only placeholder builder is removed from the production path.
Validation adds a core scientific-value check for non-Reactome packages:
there must be at least one row with a non-empty source value, positive source
line, non-negative source column, and a scientific record identity. Expression
rows additionally require a gene identifier and numeric expression value;
traceable non-expression rows such as GDC clinical records remain valid. The
lineage check must inspect at least one value for such packages.

Fixture tests that deliberately exercise malformed/empty series matrices are
updated to expect failure. The pinned tximport + SOFT fixture remains valid.

### 4. Packaged live execution

Fixture paths remain a development/test input for `mode="fixture"`. In live
mode, parameter digest calculation never calls `_hash_directory(fixture_dir)`.
The Agent tool may construct the conventional fixture path, but no live stage
or digest may require it to exist. A regression test runs a live-mode runner
with a nonexistent fixture directory and reaches Discovery instead of failing
while computing the first checkpoint digest.

No test fixtures are added to the PyInstaller bundle. Fixture mode is not a
release feature.

### 5. Official GDC gene-expression contract

Internal `gene-expression` aliases map to the official GDC Files API value
`Gene Expression Quantification`. The files query also constrains the format
to TSV and retains deterministic file selection. The downloaded asset remains
verified through the existing `acquire_source()` path.

The parser supports both existing fixture matrices and official STAR-counts
files. For official files it:

- skips leading `#` metadata lines;
- recognizes the `gene_id`, `gene_name`, and metric columns;
- uses `tpm_unstranded` when available, otherwise `unstranded`;
- skips non-gene summary rows;
- emits one long-form row per gene for the single source file;
- derives a stable sample identifier from the official file name;
- preserves exact source line, column, raw value, gene version, unit, and
  normalization semantics.

The current internal `clinical` fixture parser remains for offline regression
coverage. Live `clinical` is rejected with a precise unsupported-format error
because official Clinical Supplement files are commonly XML and have not yet
passed a real XML parsing and lineage contract. This is an explicit reduction
of a false capability claim, not a silent fallback.

### 6. Multi-source GDC + Xena closure

Discovery resolves every GDC and Xena `DatasetSelection` in input order rather
than returning after the first match. It emits one `SourceRecord` per dataset,
preserves queries, capabilities, and requested outputs, and writes the
resolved `source_id` back to every dataset. Singular compatibility fields in
`DiscoveryOutput` describe the first resolved dataset only.

Acquisition iterates every resolved GDC/Xena dataset and combines all
`SourceAsset` and `DownloadAttempt` values into one `AcquisitionOutput`.
Fixture and live helpers retain their current per-source behavior. The Xena
helper uses `dataset.source_id` when provided; it never regenerates identity
from the download URL.

Existing multi-dataset Processing, field alignment, merge, Artifact Build, and
Validation then receive both assets through their public contracts. A new
end-to-end fixture test starts at `TaskSpecification` and proves that both
sources survive Discovery and Acquisition, the merged dataset is published,
and the complete package passes validation.

## Error Handling

- Cross-endpoint model preview never receives a persisted secret.
- Changed specification means cache miss and a new stage attempt.
- GEO without source-derived numeric rows fails Processing or Validation.
- Live mode with no fixture directory proceeds until the real live boundary.
- Unsupported GDC live clinical input fails before downloading an incompatible
  file.
- Any selected GDC/Xena source that fails acquisition fails the combined stage;
  partial assets are not published downstream.

All failures retain the existing Pipeline terminal-event and staging cleanup
semantics.

## Testing and Acceptance

Every repair follows red-green-refactor and has a focused commit. Acceptance
requires:

1. Cross-origin preview regression tests prove no persisted Authorization
   header leaves the configured endpoint.
2. Recovery tests prove changed databases/specifications cannot reuse old
   Discovery, Acquisition, or Processing outputs.
3. GEO client-lifetime, populated series-matrix, empty-matrix rejection, and
   Validation Gate tests pass.
4. A live-mode runner with a missing fixture directory does not hash it.
5. Official GDC query and STAR-counts parser fixtures pass with precise
   lineage.
6. GDC + Xena entry-to-validation integration passes without manually
   constructing intermediate assets.
7. `uv run ruff check app/ tests/ launcher.py` and the complete default
   `uv run pytest` suite pass from `backend/`.
8. After clearing worktree `__pycache__`, the documented Windows Uvicorn smoke
   test starts and stops cleanly.

## Documentation and Board Consistency

`docs/ARCHITECTURE.md` and `docs/TODO.md` will be corrected where they currently
claim completed GEO/GDC/multi-source behavior that the live implementation did
not provide. Commonly TASK-029 and TASK-032 through TASK-036 will receive the
corresponding commit and verification evidence.
