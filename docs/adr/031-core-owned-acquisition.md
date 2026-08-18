# ADR-031: Core-owned acquisition identity and lineage

## Status

Accepted

## Context

Trusted non-expression families need to acquire structured API responses and
files through the same Core-owned path as GEO/GDC/Xena. A provider name alone is
not enough to reproduce a request: recipe/provider version, parameters, retry
attempts, partial files, cache blobs and registered output assets must be bound
together. Agent-supplied download code or arbitrary paths cannot establish that
identity.

## Decision

1. `CoreAcquisitionRequest` fixes task/build/binding identity and requires either
   a builtin provider ID or a workflow recipe ID/version, never both. Parameters
   are part of request identity.
2. Workflow recipes are executable only when their `WorkflowRecipeRef.status` is
   `PROMOTED`; implementation digest is recorded.
3. `CoreDownloadAttempt` records numbered retry status, provider, URL, byte count,
   retryability, cache lineage, resume attempt and registered asset reference.
   Successful attempts must reference a task-owned content-addressed asset;
   failed/cancelled attempts cannot publish one.
4. Cache lineage requires a request identity digest. Part files remain relative
   to `source_assets/`; traversal and workspace paths are rejected. Cache and
   resume metadata are evidence, not publication artifacts by themselves.

## Consequences

- C2I can reuse the existing verified downloader while emitting a stable
  acquisition receipt consumed by family adapters and B7.
- Retry/resume changes remain reproducible because provider/recipe versions and
  request parameters are bound into identity.
- No generic Agent DAG or arbitrary download workflow is introduced.
