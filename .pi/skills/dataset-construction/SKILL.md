---
name: dataset-construction
description: Construct a DatasetBuild through the trusted Dataset Core boundary.
---

# Dataset construction

Prepare a DatasetBuildSpec, validate it with `validate_dataset_build`, correct
any structured validation errors, then execute it through
`execute_dataset_build`. Treat only the resulting Publication as formal
output.

## Protocol

1. After source discovery and vetting, construct one DatasetBuildSpec per
   dataset family + row granularity (expression, mutation, pathway demands
   split into separate builds).
2. Call `validate_dataset_build` and fix every structured error
   (unknown_schema, family_mismatch, profile_not_allowed, …) before
   executing — never submit a spec that failed validation.
3. Call `execute_dataset_build` with the spec plus any already-registered
   task-relative source_files / mapping_files / metadata_files references.
   Omit missing source_files when the binding has a registered Core acquisition
   provider; do not download or parse that provider again with workspace commands.
4. When a frozen multi-table topology cannot be expressed by a registered static
   family, use the fixed two-phase dynamic protocol: call
   `prepare_dynamic_family_build` first, bind the proposal transform-ref digest
   to the returned Host descriptor digest, then call
   `submit_dynamic_family_build` with that unchanged receipt. A fresh prepare
   after source/projection/transform changes is mandatory; also prepare after
   any committed role, binding, or acquisition-request change, FamilySpec,
   Projection, or transform fact changes. Use this protocol with:
   - `execution_backend="in_process_unisolated"` exactly. This backend is **not a
     sandbox, isolation mechanism, or security boundary**; never describe it as one.
   - a canonical-digest-valid task/user/curated/system `FamilySpec`, selected
     Projection, strict transform metadata/source, and BuildSpec 2.0 proposal;
   - Close every source binding exactly once with either:
     - an acquisition-requests object mapping each binding ID to a fixed Core provider ID plus parameters (preferred for formal GEO/GDC/Xena/PDB/ChEMBL/PubChem acquisition), or
     - a registered-sources object mapping each binding ID to an asset SHA-256 ID only when that asset ID was returned by a previous fixed Core acquisition.
     Browser/download/discovery registrations are rejected as formal carriers. Registered assets live in Core task storage, not the Agent Workspace: never use workspace search or process execution to locate or parse them. Never pass paths or response bytes.
   - Runtime inputs are ordered by source bindings and use handles in-0, in-1,
     …, not binding IDs. Every bracket element-access syntax is rejected,
     including array indexes and regex match indexes; use destructuring,
     forEach/map/find/shift, dot access, and named regex groups.
   - deterministic output handles out-0, out-1, … in primary + supporting +
     derived projection order. Each output needs a non-empty registered input
     receipt ID as locator; multiple tables from one source may share it.
   The Host owns compilation. Bind `build_proposal.transform_refs[0].digest` to
   `preflight_receipt.host_descriptor_digest` exactly, and pass the unchanged
   receipt to submit. Do not repeat a failure-driven descriptor handshake,
   bypass the receipt, or invent a digest. Treat only the returned immutable
   Publication as formal output. A schema containing
   review-status or human-review-status remains human-review-pending until
   genuine HIL acceptance exists.
5. Treat a failed result as actionable state. Retry unchanged inputs only when
   retryable is true and the external condition may have changed. A non-retryable
   static adapter/transform rejection or requested-field/topology mismatch means
   the registered static family is unsuitable: stop static execution and required-
   field vocabulary probing, then switch immediately to the fixed dynamic
   protocol: call `prepare_dynamic_family_build`, bind the proposal transform-ref
   digest to the returned Host descriptor digest, and call
   `submit_dynamic_family_build` with that unchanged receipt. For a permission
   or human-review request, wait for the decision instead of replacing the
   trusted operation with workspace output.
6. Only a successful Publication is formal output. Never describe rejection,
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
  repeat the same command or build with unchanged inputs.
