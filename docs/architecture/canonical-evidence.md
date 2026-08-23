# Canonical Evidence Product Layer

This chapter defines the semantic product layer planned in
[the implementation plan](../plans/2026-08-20-canonical-evidence-product-layer.md).
It is additive to the existing Dataset Core pipeline and does not create an
Agent-controlled workflow graph.

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

## Compatibility

Existing family schemas and four-table projections remain valid compatibility
outputs while package projections are introduced. New code should adapt existing
parsers into canonical objects incrementally rather than rewrite all adapters at
once. A package migration must retain fixture parity, provenance closure and
Artifact API hash tests before changing production registration.
