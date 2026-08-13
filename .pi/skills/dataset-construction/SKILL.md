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
3. Call `execute_dataset_build` with the spec plus the task-relative
   source_files / mapping_files / metadata_files references.
4. Only a successful Publication is formal output. Never describe rejection,
   NO_DATA, cancellation, or failure as success; never fabricate file names
   when reporting artifacts.

## Boundaries

- The trusted Dataset Core owns validation, compatibility gating, integration,
  and immutable publication. Agent filesystem writes are restricted to
  staging — never write into artifacts/ or publications directly.
