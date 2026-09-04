# Backend Audit Remediation Design

**Date:** 2026-08-03

**Status:** Approved for direct execution by the user

## Goal

Close the backend gaps found in the 2026-08-03 competition-fit audit without
weakening the deterministic Pipeline, provenance contracts, or durable runtime.
Every behavioral change must be introduced by a failing test, verified in
isolation, and committed as an independently reviewable unit.

## Scope and ordering

Work proceeds in severity order:

1. Prevent invalid fixed-case publication and task-external file disclosure.
2. Repair provenance relationships, managed child HIL, immutable Run settings,
   and Acquisition safety.
3. Make cleaning, source selection, source relationships, child completion, and
   live acceptance truthful.
4. Correct secondary schema, audit-log, chart accumulation, WebSocket, and
   idempotency weaknesses.

Frontend changes are out of scope unless an API contract change requires a
minimal transport update. No new third-party dependency is required.

## Considered approaches

### A. Patch only the two P0 findings

This is the smallest release-blocker change, but it leaves the competition
claims materially stronger than the implementation and retains known runtime
and provenance defects. It does not satisfy the request to repair findings in
sequence.

### B. Rewrite the Pipeline and runtime contracts together

A broad rewrite could unify several concepts, but it would create a large
unreviewable change, invalidate the existing 1,900-test safety net, and conflict
with the requirement for timely independent commits.

### C. Contract-preserving incremental remediation (selected)

Keep existing public contracts where possible, add one regression test per
failure mode, and make the smallest production change that closes it. Where a
declared capability is not actually implemented, fail closed at admission
instead of silently dropping a source. This yields reviewable commits and lets
later improvements build on verified invariants.

## Design decisions

### Fixed-case lineage

The pinned GSE178352/PMID34180400 acceptance case is a special validation
profile. It must validate every `main_data.csv` value against its source asset.
General datasets retain deterministic bounded sampling to avoid unbounded
validation cost. The profile is selected from the canonical specification, not
from filenames or task IDs.

### Task-local processing paths

All VLM and PDF processing entry points resolve the requested path, reject
missing paths and symlinks escaping the task root, and only then inspect or copy
content. The shared check returns the resolved path so callers cannot validate
one path and open another.

### Relational provenance

Validation will build explicit maps for dataset-to-source, sample-to-dataset,
asset-to-source/attempt, and attempt-to-source. A main-data row passes only when
all referenced objects form one consistent chain. Source relations are checked
against discovery evidence before being emitted.

### Managed child HIL

Child contexts inherit the parent managed Run identity and the already-bound
runtime services. The input broker registers a pending request before the
user-visible required event is emitted, eliminating the immediate-resume race.

### Immutable Run settings

The accepted Run stores a `RunModelSettings` snapshot. Queue execution consumes
that snapshot and never rereads mutable global settings. No API key is written
to events, snapshots, or user-visible API models.

### Safe Acquisition

Cache hits must satisfy the current request's size, checksum, and media-type
constraints before publication. PubMed supplementary files use the same pinned,
bounded, content-addressed Acquisition path as other downloads and produce
`DownloadAttempt` plus `SourceAsset` records.

### Cleaning

Cleaning becomes a deterministic transformation rather than report-only logic:
trim surrounding text whitespace, normalize known missing sentinels to empty
values, and remove exact duplicate rows while preserving first occurrence and
row order. Ambiguous type mismatches remain warnings; the system must not invent
scientific corrections. The transformed file receives a new hash, size, and row
count before Artifact Build.

### Capability truthfulness

The tool and Discovery stage share one combination validator. Supported routes
remain GEO with optional linked PubMed, one GDC dataset, one Xena dataset, the
explicit one-GDC-plus-one-Xena merge, and one Reactome dataset. Unsupported
PubMed-only, multi-GEO, or literature-plus-GDC/Xena combinations fail before
network access instead of silently dropping selections.

### Child success and live acceptance

A child is `COMPLETED` only when it returns at least one verifiable asset or a
recipe result appropriate to its role. Evidence-free normal output maps to a
typed failure. Live acceptance tests require `completed`, `live_accepted`, valid
artifacts, and the expected pinned accession; a failed terminal state never
counts as acceptance.

### Secondary hardening

GDC/Xena output retains Ensembl version and integer-expectation metadata,
dataset counts are derived from parsed content, multi-source logs include every
parse edge, and Reactome normalized TSV is a derived asset. VLM chart outputs
append safely and deduplicate stable IDs. WebSocket connections enforce the
same configured local origins as CORS. Request idempotency stores and compares a
canonical semantic fingerprint before returning an existing acceptance.

## Verification

Each commit runs its focused test file and Ruff on changed modules. Cross-cutting
commits also run the nearest runtime or Pipeline suite. Before integration:

- `uv run pytest`
- `uv run ruff check app/ tests/ launcher.py`
- Python compile/import verification
- cold Uvicorn startup and `/api/v1/health`
- `git diff --cached --check`, unmerged-file check, and clean worktree check

The network-marked live suite is reported separately and is never implied by
the default offline test result.
