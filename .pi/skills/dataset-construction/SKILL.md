---
name: dataset-construction
description: Execute a dataset requirement through the trusted Dataset Core boundary.
---

# Dataset construction

Prepare a DatasetExecutionSpec, validate it with `validate_dataset_execution`, correct
any structured validation errors, then execute it through
`execute_dataset_execution`. Treat only the resulting Publication as formal
output.

## Protocol

1. For every dataset-producing request, call `inspect_dataset_execution_routes`
   before substantive acquisition. Its output is derived from the live static
   family registry and Core provider catalog. It distinguishes exact static
   family/source capabilities, inputs that Dynamic Family can bind directly,
   and acquisition-only carriers that still require a provenance-bound formal
   extraction. Provider wiring alone does not prove semantic topology,
   transform validity, source availability, or publication eligibility.
2. After source discovery and vetting, construct one DatasetExecutionSpec per
   dataset family + row granularity (expression, mutation, pathway demands
   split into separate requirements).
3. Choose exactly one execution route before substantive acquisition:
   - Use the static route only when the required family, schema, source, and
     topology all appear in the `validate_dataset_execution` schema. Then call
     `validate_dataset_execution` and fix every structured error
   (unknown_schema, family_mismatch, profile_not_allowed, …) before
     executing. Never submit a static spec that failed validation.
   - Otherwise use the dynamic route in step 5 directly. Do not pass a dynamic
     FamilySpec to `validate_dataset_execution`, and do not treat a static rejection
     or a source missing from static enums as evidence that dynamic acquisition
     is unavailable. Use the route preflight facts instead.
4. On the static route, call `execute_dataset_execution` with the spec plus any already-registered
   task-relative source_files / mapping_files / metadata_files references.
   Omit missing source_files when the binding has a registered Core acquisition
   provider; do not download or parse that provider again with workspace commands.
5. When a frozen multi-table topology cannot be expressed by a registered static
   family, use the fixed two-phase dynamic protocol: call
   `prepare_dynamic_family_publication` first, then call
   `submit_dynamic_family_publication` with the returned server-bound submission
   and unchanged receipt. A fresh prepare
   after source/projection/transform changes is mandatory; also prepare after
   any committed role, binding, or acquisition-request change, FamilySpec,
   Projection, or transform fact changes. Use this protocol with:
   - `execution_backend="in_process_unisolated"` exactly. This backend is **not a
     sandbox, isolation mechanism, or security boundary**; never describe it as one.
   - a task/user/curated/system `FamilySpec`, selected Projection, strict
     transform metadata/source, and execution proposal. Omit derived digest
     properties from prepare; the server returns them in the prepared submission;
   - Close every source binding exactly once with either:
     - an acquisition-requests object mapping each binding ID to a provider
       enumerated in the dynamic tool schema plus its parameters (preferred), or
     - a registered-sources object mapping each binding ID to an asset SHA-256 ID only when that asset ID was returned by a previous fixed Core acquisition.
     Browser/download/discovery registrations are rejected as formal carriers. Registered assets live in Core task storage, not the Agent Workspace: never use workspace search or process execution to locate or parse them. Never pass paths or response bytes.
   - Runtime inputs are ordered by source bindings and use handles in-0, in-1,
     …, not binding IDs. Every bracket element-access syntax is rejected,
     including array indexes and regex match indexes; use destructuring,
     forEach/map/find/shift, dot access, and named regex groups.
   - deterministic output handles out-0, out-1, … in primary + supporting +
     derived projection order. Each output needs a non-empty registered input
     receipt ID as locator; multiple tables from one source may share it.
   The Host owns compilation. Pass the prepared submission and unchanged
   preflight receipt directly to submit. Its Host descriptor digest is
   server-bound; do not recompute or edit digest bindings. Do not repeat a failure-driven descriptor handshake, bypass
   the receipt, or invent a digest. Treat only the returned immutable
   Publication as formal output. A schema containing
   review-status or human-review-status remains human-review-pending until
   genuine HIL acceptance exists.
6. Treat a failed result as actionable state. Retry unchanged inputs only when
   retryable is true and the external condition may have changed. A non-retryable
   static adapter/transform rejection or requested-field/topology mismatch means
   the registered static family is unsuitable: stop static execution and required-
   field vocabulary probing, then switch immediately to the fixed dynamic
   protocol: call `prepare_dynamic_family_publication`, then call
   `submit_dynamic_family_publication` with its unchanged prepared submission,
   whose descriptor digest is server-bound, and receipt. For a permission
   or human-review request, wait for the decision instead of replacing the
   trusted operation with workspace output.
7. Only a successful Publication is formal output. Never describe rejection,
   NO_DATA, cancellation, incomplete review, or failure as success; never
   fabricate file names when reporting artifacts.

## Boundaries

- The trusted Dataset Core owns acquisition for registered providers,
  validation, compatibility gating, integration, and immutable publication.
  Agent filesystem writes are restricted to staging — never write into
  artifacts/ or publications directly. Dynamic execution remains Core-owned but
  is process-local and unisolated; its AST policy and `node:vm` timeout are not
  malicious-code defenses.
- `workspace_exec` is for bounded staging or diagnosis when no registered tool
  provides the operation. A non-zero exit code is a failed tool call. Do not
  repeat the same command or execution with unchanged inputs.
- Never use `workspace_exec`, a shell interpreter, or a subprocess network
  client for acquisition, direct file copying, archive inspection, provider
  reimplementation, or formal carrier creation. Use the governed workspace,
  browser, or Dataset Core tool instead. If route preflight reports
  `requires_formal_extraction` and no supported Core extraction carrier exists,
  return the exact structured blocker or `NO_DATA` for that projection; do not
  unpack or parse the carrier in the workspace.
