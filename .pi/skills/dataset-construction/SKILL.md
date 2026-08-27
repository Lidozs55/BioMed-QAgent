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
   - Static-first heuristic: when `inspect_dataset_execution_routes` lists a
     static family whose tables cover the requested product (for example,
     `gut_microbiome` for microbiome study/taxon/differential/prevalence
     integration), you MUST attempt the static route first — validate the
     spec, fix every structured error, then execute. Publish the static
     family even when some auxiliary sources stay blocked; never skip
     straight to Dynamic Family for a topology the static registry already
     expresses.
   - Use the dynamic route only when no static entry expresses the required
     semantic topology. Do not pass a dynamic
     FamilySpec to `validate_dataset_execution`, and do not treat a static rejection
     or a source missing from static enums as evidence that dynamic acquisition
     is unavailable. Use the route preflight facts instead.
4. On the static route, call `execute_dataset_execution` with the spec plus any already-registered
   task-relative source_files / mapping_files / metadata_files references.
   Omit missing source_files when the binding has a registered Core acquisition
   provider; do not download or parse that provider again with workspace commands.
   - Fixed providers accept only `source`, `accession`, and `entities`; never put
     build inputs into `binding.parameters` — those are rejected outright.
   - Declare phenotype/study context once in the top-level spec `entities` map:
     for gut_microbiome study bindings (`registered_gut_microbiome_study_json`)
     live MGnify JSON:API carriers carry no disease annotations, so declare
     `disease_id` (MeSH ID such as D003924), `disease_name`, and
     `host_taxon_id` (e.g. 9606), plus the study identity via one of
     `study_id`/`study_accession`/accession. Self-describing fixed carriers may
     embed these fields themselves; live acquisitions cannot. Each entity value
     is exactly one non-empty string.
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
   - Preflight closure rules (each rejection tells you exactly what failed):
     - a projection declares exactly ONE primary table; all other tables are
       supporting;
     - per binding, `transform_metadata.declared_input_roles[].role` must be
       the IDENTICAL string as that binding's `input_requirement_ref` in the
       same submission (e.g. declare `mgnify_study_data` for a binding whose
       requirement ref is `mgnify_study_data`, never a generic role such as
       `csv_data`);
     - the transform's declared output tables must equal the selected
       projection's tables, in projection order — no extra and no missing.
   - Worked single-source shape (one MGnify study → one primary table):
     acquisition-request binds `mgnify.files.v1` with `{source: "mgnify",
     accession: "MGYS00000322"}`; one transform compiles the study JSON into
     one primary table with a registered-input locator; prepare returns the
     server-bound descriptor digests; submit passes them unchanged.
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
