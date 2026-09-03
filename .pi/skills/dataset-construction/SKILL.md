---
name: dataset-construction
description: Execute a dataset requirement through the trusted Dataset Core boundary.
---

# Dataset construction

Prepare a DatasetExecutionSpec, validate it with `validate_dataset_execution`, correct
any structured validation errors, then execute it through
`execute_dataset_execution`. After a publication, inspect Core coverage with
`inspect_source_coverage`; failed or not-attempted declared bindings require an
independent source attempt and a new formal build. Use `preflight_cleaning_rules`
for unit or field-mapping proposals: only unique Core-registered rules may be
accepted automatically; similarity-only or ambiguous candidates remain HIL-bound.
Treat only the resulting Publication as formal output.

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
   split into separate requirements). Within the request's scope, search
   broadly enough to surface the plausible candidate pool before narrowing,
   then prefer a diverse, complementary source set (several independent
   series, accessions, or studies — one source often exposes several
   high-value datasets; adopt each as its own build) over a single-source
   deep dive; narrow to one source only when the request names its sources
   or only one relevant source exists.
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
4. On the static route, NEVER hand-write the spec JSON: call
   `scaffold_dataset_execution_spec` with the family id, the context entities,
   and one `{source, adapter_id, accession}` tuple per binding, then pass the
   returned spec unchanged to `validate_dataset_execution` and
   `execute_dataset_execution`. Then call `execute_dataset_execution` with the spec plus any already-registered
   task-relative source_files / mapping_files / metadata_files references.
   Omit missing source_files when the binding has a registered Core acquisition
   provider; do not download or parse that provider again with workspace commands.
   - Curated registered sources (`registered_*`) have no acquisition provider:
     supply `source_files[<binding_id>]` with a task-owned asset id — for paper
     supplementary data, call `acquire_core_carrier` first and reference one of
     the returned extraction member asset ids.
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
   family, call `scaffold_dataset_profile` with the exact Core profile returned
   by route inspection. Use its FamilySpec, Projection, table definitions,
   relations, and output closure unchanged; supply only source bindings,
   registered/Core acquisition bindings, transform input roles, and extraction
   source. Then use the fixed two-phase dynamic protocol: call
   `prepare_dynamic_family_publication` first, then call
   `submit_dynamic_family_publication` with only the unchanged receipt. The Host
   retrieves the server-bound prepared submission by receipt digest; never copy
   or reconstruct that large object. A fresh prepare
   after source/projection/transform changes is mandatory; also prepare after
   any committed role, binding, or acquisition-request change, FamilySpec,
   Projection, or transform fact changes. Use this protocol with:
   - one `dynamic.product_requirement_profiles` entry returned by
     `inspect_dataset_execution_routes`. Never hand-write, rename, remove, or
     re-role its tables and relations after `scaffold_dataset_profile`. Set
     assessment_policy_ref to that exact Core profile. An Agent-authored
     assessment profile, a reduced projection, or provider availability alone
     cannot reach HIL/publication; preflight rejects it before acquisition;
   - `execution_backend="in_process_unisolated"` exactly. This backend is **not a
     sandbox, isolation mechanism, or security boundary**; never describe it as one.
   - a task/user/curated/system `FamilySpec`, selected Projection, strict
     transform metadata/source, and execution proposal. Omit derived digest
     properties from prepare; the server returns them in the prepared submission;
   - Close every source binding exactly once with either:
     - an acquisition-requests object mapping each binding ID to a provider
       enumerated in the dynamic tool schema plus its parameters (preferred), or
     - a registered-sources object mapping each binding ID to an asset SHA-256 ID returned by fixed Core acquisition, `extract_supplementary_archive`, or formal VLM evidence registration. Derived assets must carry a persisted OperationResult and complete parent closure.
   Archive/VLM/parser assets live in Core task storage, not the Agent Workspace:
   never use workspace search or process execution to locate or parse them.
   Browser/download/discovery registrations are rejected as formal carriers.
   Never pass paths or response bytes.
   - Runtime inputs are ordered by source bindings and use handles in_0, in_1,
     …, not binding IDs. Every bracket element-access syntax is rejected,
     including array indexes and regex match indexes; use destructuring,
     forEach/map/find/shift, dot access, and named regex groups.
   - deterministic output handles out_0, out_1, … in primary + supporting +
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
  The Host owns compilation and retains the prepared submission. Pass only the
  unchanged preflight receipt to submit; the Host descriptor digest is
  server-bound. Do not recompute or edit digest bindings. Do not repeat a failure-driven descriptor handshake, bypass the receipt, or invent a digest. Treat only the returned immutable
  Publication as formal output. A schema containing
   review-status or human-review-status remains human-review-pending until
   genuine HIL acceptance exists.
6. Treat a failed result as actionable state. Retry unchanged inputs only when
   retryable is true and the external condition may have changed. A non-retryable
   static adapter/transform rejection or requested-field/topology mismatch means
   the registered static family is unsuitable: stop static execution and required-
   field vocabulary probing, then switch immediately to the fixed dynamic
   protocol: call `scaffold_dataset_profile`, then
   `prepare_dynamic_family_publication`, then call
   `submit_dynamic_family_publication` with only its unchanged receipt; the Host
   retains and revalidates the server-bound prepared submission. For a permission
   or human-review request, wait for the decision instead of replacing the
   trusted operation with workspace output.
7. Only a successful Publication is formal output. After publishing, verify content fidelity via the artifacts REST API (`GET /api/v1/tasks/{task_id}/artifacts` + artifact download): every published row must trace to an acquisition receipt — if a transform could not decode a carrier field, leave it empty and say so in the final report; never fill published rows with model-supplied placeholders. Carrier payload shapes for faithful decoding live in `.pi/skills/mgnify/docs/carrier-shapes.md`. Never describe rejection,
   NO_DATA, cancellation, incomplete review, or failure as success; never
   fabricate file names when reporting artifacts.
8. No silent data loss. Every dataset inside the request's scope must reach the
   final report through one of two channels: the formal Publication (rows that
   passed the gates) or, for valid data a formal gate cannot accept (e.g.
   structure that fails admission, facts that cannot be verified), the
   governed non-formal channel — and when no such channel is available in the
   current surface, keep the data in run evidence and report it explicitly.
   When a derived fact cannot be resolved (e.g. a probe with no gene mapping),
   keep the row with an explicit unresolved status such as
   `mapping_status="unmapped"` and report the unresolved count instead of
   dropping the row. Never drop valid rows to make a gate pass, and never
   invent the missing fact. When sample grouping is part of the requested
   product (e.g. tumor/normal), carry the grouping into a published table,
   traced to the sample's own metadata.

## Transform source admission dialect

Dynamic transforms are statically admitted before execution. The admission
AST policy rejects eval-class identifiers and **every** bracket access —
including a literal index like `rows[0]` — plus computed property names and
bracket enumeration of any kind. It reports **all** violations with `L`/`C`
line-column positions in one rejection; fix every listed position, then
resubmit once.

Reading data inside the dialect:

- Arrays: destructuring (`const [drug_name, pt, count] = line.split(",")`),
  `.at(i)`, `.slice()`, `.shift()`, `.map`, `.filter`, `.join`.
- Objects: dot paths only (`request.inputs`, `match.groups.severity`).
- Available globals: `JSON.parse`, `String`, `Number`, `Math`.

Minimal passing shape (CSV in, CSV out):

```ts
import { defineTransform } from "@biomed/transform-sdk/v1";

export const transform = defineTransform({
  run(request) {
    const source = request.inputs.at(0);
    const lines = source.text.split("\n").filter((line) => line !== "");
    const rows = lines.slice(1).map((line) => {
      const [drug_name, pt, count] = line.split(",");
      return { drug_name, pt, count: Number(count) };
    });
    const content = "drug_name,pt,count\n" + rows
      .map((row) => row.drug_name + "," + row.pt + "," + String(row.count))
      .join("\n");
    return {
      outputs: [{
        content,
        handle: "out_0",
        locator_ref: source.receipt_id,
        row_count: rows.length,
        schema_ref: "schema_from_your_projection",
        table_id: "table_from_your_projection",
      }],
    };
  },
});
```

## Boundaries


- A frozen evaluation context carried in the system prompt (evaluation runner
  runs) is binding task semantics for the run — expected family, required
  tables, allowed sources, success definition — but it is never publication
  authority and never bypasses this protocol: completion still requires the
  current-run immutable Publication through the Dataset Core.
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
