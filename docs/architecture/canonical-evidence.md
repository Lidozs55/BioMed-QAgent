# Canonical Evidence Product Layer

This chapter defines the semantic product layer introduced by
[ADR-038](../adr/038-canonical-evidence-product-layer.md). It is additive to the
existing Dataset Core pipeline and does not create an Agent-controlled workflow
graph. The completed implementation plan is historical and remains under
`docs/archive/plans/`.

## Purpose

The Dataset Core currently validates and publishes family-owned projections.
That proves execution and artifact integrity, but execution completion alone does
not prove that the requested biomedical evidence product is complete. The
canonical layer separates those concerns while preserving the current trust
boundary:

```text
SourceAsset receipts
  -> fixed Core pipeline
  -> canonical evidence objects
  -> semantic package validation
  -> package projection
  -> ProductAssessment
  -> immutable Publisher
```

The Agent may propose a package and source bindings. It cannot define new entity
or relation semantics at runtime, set publication thresholds, or promote a
workspace result into a formal artifact.

## Semantic Objects

The first version uses six internal concepts:

- **Entity**: a canonical identity with `entity_type`, namespace, source IDs and
  deterministic canonical ID.
- **Relation**: a typed subject/predicate/object edge with qualifiers and evidence
  references.
- **Evidence**: an assertion or measurement with value/unit/condition,
  source-asset receipt, locator and confidence/review references.
- **CrossReference**: a source namespace/id mapping to a canonical entity,
  including match method, conflict state and confidence.
- **Provenance**: source retrieval, transform/algorithm identity, input/output
  digests and the receipt closure needed to reproduce a result.
- **ConfidenceReview**: categorical confidence, reason, review status and the
  evidence reviewed by a human when required.

These objects are an internal canonical representation. CSV/JSON artifacts remain
package projections selected by a registered package and produced through the
existing Publisher.

## Semantic Packages

A package is a reusable biomedical product capability, not a Gold-case schema.
The initial package vocabulary is:

- `expression_evidence`: Study, Sample, Probe, Gene, ExpressionMeasurement;
- `target_evidence`: Protein, Variant, Drug, Disease, ClinicalTrial;
- `structure_interaction`: Protein, Structure, Chain, Residue, Interaction;
- `bioactivity_identity`: Compound, Target, Assay, ActivityMeasurement,
  CrossReference;
- `figure_evidence`: Figure, Chart, ChartPoint and MeasurementEvidence.

A package declares entity types, relation predicates, evidence types, row and
measurement semantics, identity rules, and valid artifact projections. A
requirement manifest may require a complete or partial closure of a package, but
it cannot introduce an unregistered topology.

### Figure/chart evidence publication route (implemented)

The `figure_evidence` capability is realized by the
`bioactivity-measurement/chart-evidence` module and now runs inside the same
Core trust boundary as every other family:

- **Ownership.** VLM/PDF/caption extraction output enters the formal route only
  as task-owned registered SourceAssets parsed by Core-owned registered table
  parsers (`registered_bioactivity_chart_*_json`). A workspace CSV or agent
  transcript never becomes a publication input; every table row carries a
  content-addressed `source_asset_id` plus a SourceLocator 2.0 page/bbox
  locator that Core re-validates at parse time.
- **Registered-paper extraction.** The governed paper route derives paper
  identity and bibliographic metadata from the byte-verified JATS XML carrier,
  never from a page-image model response. It renders bounded caption-selected
  full PDF pages from the already verified PDF bytes (216 DPI with page/pixel
  caps), preserving vector marks, axes, legends and surrounding labels in one
  visual input; embedded-image extraction remains available to exploratory
  tooling but is not the publication carrier boundary.
- **Provenance retention.** The formal publication keeps, per series and per
  point: source asset, page/bbox locator, extraction model name and pinned
  version, every transform step (`vlm_extract`, `coordinate_transform`,
  `unit_transform`, `human_correction`) with input/output digests and prompt
  parameters, point-level confidence with reason, and review state.
- **Review state machine.** `not_required | pending | accepted | corrected |
  rejected`; human review may change values (corrected) but never upgrades
  source or extraction reliability. Estimated or low-confidence primary points
  require `accepted`/`corrected` review; rejected rows never publish.
- **Fail-closed gates.** The chart gate (`evaluateChartEvidencePublication`)
  runs before assembly and again inside validation; provenance gaps, missing
  transform digests, invalid locators, or pending reviews fail the build with a
  structured `chart_evidence:chart_evidence_gate` check in
  `validation_report.json`, and no immutable Publication is promoted.
- **Assembly.** When chart tables are bound, the bioactivity registered
  assembler dispatches to `assembleBioactivityChartEvidenceCandidate`, which
  requires all four chart tables, validates the exact per-route asset closures
  (base tables may reference a strict subset of the combined registered assets),
  and emits the eight-table candidate through the normal B3 validation and
  Publisher.

## Product Assessment

`ExecutionResult` describes whether fixed operations ran. `ProductAssessment`
describes whether the resulting canonical evidence is usable as the requested
product:

```text
execution_status: queued | running | failed | completed
product_status: incomplete | validated | publishable
score: schema / relations / identifiers / provenance / confidence / reproducibility
missing_requirements: string[]
blockers: string[]
```

Existing `BuildResult` remains compatible during migration. New package flows
must not equate `execution_status=completed` with `product_status=publishable`.
Publication eligibility is decided by the Core-owned assessment and Publisher,
never by Agent prose or workspace files.

## Supplementary Transforms

> **Deferred target:** ADR-039 described replacing the old `RegisteredTransform`
> promotion model with a versioned `DatasetTransform` ABI in an isolated Host,
> but the Host/sandbox/IPC route is now deferred. Agent-authored scripts remain
> candidate research transforms only and cannot enter the product path.

If a future decision resumes `DatasetTransform`, it may be submitted from the
Agent workspace only after it can be normalized, compiled, content-addressed,
and executed outside the TS Application Host in an approved isolation backend. The Host produces only a
`TransformExecutionReceipt` and invocation-scoped quarantine outputs. Core must
rehash and admit those outputs, bind them to registered SourceAsset or committed
OperationResult inputs, validate canonical entity/relation/evidence semantics,
and publish only through the existing Publisher.

The transform may declare canonical output capabilities, but it cannot select a
family, merge winner, validation threshold, ProductAssessment result, DAG,
or publication policy. `example`, `task`, `user`, and `curated` scope, execution
status, verification, and activation are separate dimensions; a sandbox
execution or Host receipt is not publication trust.

## Literature Experiment Chart Profile

`literature_experiment_chart.release.v1` is the reusable formal projection for
paper-level quantitative evidence. It is a Core-owned six-table topology:

- `activity_value_records` (primary);
- `paper_records`;
- `experiment_records`;
- `chart_series`;
- `chart_points` (derived, may be empty only under the declared projection);
- `supplementary_asset_records`.

The profile registry owns the complete `FamilySpec`, Projection, table roles,
field closure and relations. `scaffold_dataset_profile` may return either the
profile alone or a complete prepare submission after the caller supplies source
bindings, Core asset/provider bindings, transform input roles and extraction
source. The caller cannot rename, remove or re-role profile objects. Prepare and
submit still recompute the existing digests and fail closed on any drift.

This profile is not an evaluator-side 8-to-6 rename. The existing eight-table
bioactivity chart profile remains a separate compatibility product. Both use
Core profile registration and immutable publication; neither can be synthesized
from workspace files.

## Evidence Asset Ownership

A formal VLM input begins with a task-owned Core-acquired or Core-derived image
or PDF asset. After point-level `vlm_extraction` HIL, the processing layer writes
a content-addressed evidence manifest containing source asset IDs, page/bbox,
model and version, prompt digest, axis/legend facts, point values, confidence,
review IDs, evidence digests, reviewer, review time and corrections. Dataset
Core registers that manifest as a derived SourceAsset and persists the matching
OperationResult. Publication rechecks every chart/point row against the manifest
bytes and provenance before B3; model output copied into a workspace CSV is not
accepted.

Review states are `pending -> accepted | corrected | rejected`. Low-confidence
or estimated points cannot publish while pending. A correction retains original
values and HIL evidence. Point-level `vlm_extraction` review and final
`publication_acceptance` are distinct blocking decisions; credential approval
satisfies neither.

Official supplementary ZIPs are Core-acquired carriers. The bounded ZIP parser
rejects traversal, duplicate members, encryption, unsupported compression,
ZIP64 and resource-limit violations. Every member is rehashed and registered as
a derived SourceAsset with parent ZIP asset/hash, member path/hash and a durable
OperationResult. Fixed parser registrations normalize CSV/TSV, XLSX sheets and
PDF tables into new UTF-8 derived assets. Their provenance recursively closes to
the member and parent ZIP; parser failures remain failed OperationResults and do
not become formal inputs. Agent shell, Python and `tar` extraction are outside
this path.

## Compatibility

Existing family schemas and four-table projections remain valid compatibility
outputs while package projections are introduced. New code should adapt existing
parsers into canonical objects incrementally rather than rewrite all adapters at
once. A package migration must retain fixture parity, provenance closure and
Artifact API hash tests before changing production registration.
