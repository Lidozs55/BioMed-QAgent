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
   - For `bioactivity_measurement`, ChEMBL/PubChem search tools only discover controlled IDs. Formal bytes must be reacquired by Core with `chembl.files.v1` / `pubchem.files.v1`; omit those bindings from `source_files`. A PubChem binding is optional and supports one exact CID crosswalk per build.
   - **gene-level builds fed by probe-level sources (e.g. GEO `geo_probe`) MUST
     declare a probe→gene annotation** via `mapping_files={"<binding_id>":
     "<GPL annotation relative path>"}` — one entry per binding, keyed by the same
     binding_id as the source. Omitting it lets `validate_dataset_build` pass but the
     binding fails the gene-required coverage/residual gate and the run lands on
       `status: "no_data"` / `reason_codes: ["no_primary_data"]` (see the
       research_data_guidance skill, expression_omics.md section 3, for the
       mechanism). Prefer a gene-level source (GDC/Xena) or a probe-level schema
       when no probe→gene annotation is available.
4. When a frozen multi-table topology cannot be expressed by a registered static
   family, use `submit_dynamic_family_build` with:
   - `execution_backend="in_process_unisolated"` exactly. This backend is **not a
     sandbox, isolation mechanism, or security boundary**; never describe it as one.
   - a canonical-digest-valid task/user/curated/system `FamilySpec`, selected
     Projection, strict transform metadata/source, and BuildSpec 2.0 proposal;
   - `registered_sources={"<binding_id>": "asset_<sha256>"}` closing every source
     binding. Never pass paths or discovery response bytes.
   - deterministic output handles `out_0`, `out_1`, … in projection order; each
     output must use a registered input `receipt_id` as its `locator_ref`.
   The Host owns compilation. If the first submission reports the exact
   Host-compiled descriptor digest, replace the proposal transform-ref digest with
   that value and resubmit; do not bypass or invent the digest. Treat only the
   returned immutable Publication as formal output. A schema containing
   `review_status` or `human_review_status` remains `human_review_pending` until
   genuine HIL acceptance exists.
5. Treat a failed result as actionable state. Retry unchanged inputs only when
   `retryable` is true and the external condition may have changed. For
   non-retryable errors, change the spec or registered source selection; for a
   permission or human-review request, wait for the decision instead of replacing
   the trusted operation with workspace output.
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
