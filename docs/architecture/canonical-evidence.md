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
