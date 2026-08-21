# Canonical Evidence Product Layer

## Status

Long-term additive semantic design reference. Phase 0 (`ProductRequirementManifest` +
`ProductAssessment` + pure evaluator) is implemented. Remaining phases are
**deferred behind the Phase 4 Gold diagnostic and Phase 5 release-hardening
roadmap**; they are not the current default execution sequence.

The supplementary-transform portion of this document is superseded as a target
execution model by the Proposed [ADR-039](../adr/039-family-transform-host.md)
and the [Family Host + Transform Host plan set](family-host/README.md): the
future executable boundary is one isolated `DatasetTransform` Host, not a
second `RegisteredTransform` ABI. Until ADR-039 is accepted, the current
candidate-only restriction remains in force.

This plan is for the BioMed-QAgent product, not a Gold-case patch. The current TS
Host + Pi Agent + TS Dataset Core topology remains unchanged. New canonical
primitives should be implemented only when evaluator evidence shows a reusable
contract gap with more than one real product consumer.

## Why

The current Dataset Core can produce a valid `DatasetPublication` while only
proving that the registered family contract ran successfully. That execution
success is weaker than the user's requested biomedical product being complete.
Gold2-Gold5 exposed the same structural issue through different domains:
missing study/sample relationships, missing cross-domain identity, missing
structure interactions, and missing compound identity closure.

The product objective in `PROBLEM.md` is not merely to run a parser. It is to
find heterogeneous biomedical data, clean and align it, preserve provenance,
and output usable structured data. Those requirements need a semantic product
layer that is reusable across families and is evaluated independently from the
mechanics of one pipeline run.

## Design Principle

A family is a semantic biomedical product capability, not a benchmark-specific
list of CSV files. A family package declares the entity types, relation types,
evidence types, row and measurement semantics, and valid projections it can
publish. A requirement profile may require a subset or complete closure of that
package, but it does not redefine the package for one Gold case.

```text
Agent intent/source evidence
  -> DatasetBuildSpec admission
  -> fixed acquisition/parse/canonicalize/integrate/derive pipeline
  -> Canonical Evidence IR
  -> package identity/relation/provenance validation
  -> package projection (CSV + schema + provenance + audit)
  -> ProductAssessment
  -> Publisher only when publishable
```

The existing pipeline remains the execution skeleton. The new layer provides
semantic objects and assessment between canonicalization and final projection;
it does not introduce Agent-controlled nodes or a general DAG.

## Non-goals

- Do not add Gold2, Gold3, Gold4, or Gold5 production profiles as bespoke
  runtimes.
- Do not replace the current `DatasetBuildSpec`, Dataset Core, Publisher, or
  SourceAsset trust boundary in one migration.
- Do not allow workspace CSVs, arbitrary Python/JavaScript, or Agent-selected
  table topology to become formal artifacts.
- Do not turn `WorkflowRecipe` into arbitrary code execution.
- Do not make `BuildResult.succeeded` retroactively mean every user requirement
  was satisfied; introduce explicit product assessment instead.
- Do not remove existing four-table compatibility projections until equivalent
  package projections are proven and migrated.

## Phases

### Phase 0: ProductRequirementManifest and ProductEvaluator

Create a versioned, server-owned evaluation contract. It describes semantic
requirements rather than Gold-specific implementation details:

- required entity types and minimum identity closure;
- required relation predicates and key topology;
- required evidence/measurement types and granularity;
- identifier requirements and cross-reference closure;
- provenance fields, locator policy, confidence distribution, and HIL state;
- artifact reproducibility and package projection requirements.

Implement a pure evaluator that consumes a committed package assessment and
returns:

```text
product_status: incomplete | validated | publishable
score: { schema, relations, identifiers, provenance, confidence, reproducibility }
missing_requirements: [...]
blockers: [...]
```

Initially the evaluator is an external/diagnostic gate and does not alter the
existing Publisher. Add machine tests using generic fixtures, not Gold data.

### Phase 1: Separate execution from product outcome

Add an additive `ProductAssessment` field to the durable build/result boundary.
Keep existing `BuildResult` fields for compatibility. A successful executor run
may carry `product_status=incomplete`; only a publishable assessment may attach
an eligible product publication in new flows.

Expose assessment in task/build APIs and durable evidence so the Agent receives a
specific next action instead of treating an incomplete product as success.

### Phase 2: Canonical Evidence IR

Add a small internal, typed, digestible representation. It is not a new public
file format and is not a replacement for existing family tables.

Minimum objects:

- `Entity`: canonical id, entity type, namespace, source identifiers;
- `Relation`: subject, predicate, object, qualifiers, evidence references;
- `Evidence`: assertion or measurement, value/unit/condition, locator, source
  receipt, confidence/review references;
- `CrossReference`: source namespace/id, canonical entity, match method,
  conflict state, confidence;
- `Provenance`: source asset/retrieval/transform/input/output digests;
- `ConfidenceReview`: categorical confidence, reason, review status, reviewer
  evidence.

Provide deterministic serialization and digest functions. Existing adapters may
continue returning their current canonical batches; an adapter bridge can emit
IR objects incrementally.

### Phase 3: Semantic package registry

Register reusable product packages, initially:

- `expression_evidence`: Study, Sample, Probe, Gene, ExpressionMeasurement;
- `target_evidence`: Protein, Variant, Drug, Disease, ClinicalTrial;
- `structure_interaction`: Protein, Structure, Chain, Residue, Interaction;
- `bioactivity_identity`: Compound, Target, Assay, ActivityMeasurement,
  CrossReference;
- later `figure_evidence`: Figure, Chart, ChartPoint, MeasurementEvidence.

Each package declares allowed entities, relations, evidence types, row/granularity
semantics, identity rules, and valid artifact projections. The package registry
is a semantic capability registry; it is not a case registry.

### Phase 4: Package projections and compatibility

Build package assemblers that consume committed canonical objects and produce
existing-style role-based artifacts. Keep old family projections as compatibility
adapters. Add relation and identity validation before projection. The Publisher
continues to own immutable promotion and hashes.

### Phase 5: Provider and crosswalk integration

Move source-specific work toward canonical objects:

- ClinVar raw field compatibility while preserving the original classification;
- PubChem compound identity and ChEMBL/PubChem cross-reference;
- UniProt protein identity;
- PDB structure/chain/residue identity;
- PubMed/JATS/BioC paper and evidence locators;
- ClinicalTrials trial identity.

Crosswalks must carry match method, source identifiers, conflict status, and
confidence. Provider/carrier audits must include retrieval and implementation
receipts rather than an empty audit report.

### Phase 6: Fixed deterministic derivations

Keep one server-owned derive slot in the existing fixed topology. Derivations
consume canonical objects and emit typed entities/relations/evidence with
algorithm ID, implementation digest, parameters, input digest, output digest,
and provenance. Interface distance is one structure-interaction derivation, not
a Gold4-specific escape hatch.

### Phase 7: DatasetTransform Host (deferred and superseded as sequencing)

Only after the IR/package need is justified and the Transform Host security gates
are accepted should the project add one versioned `DatasetTransform` ABI. An Agent
may submit candidate source, but production execution must use the isolated Host
planned in `docs/plans/family-host/03-transform-host-security.md`.

The Host/Core boundary must bind:

- fixed transform ID/version and Host-computed implementation digest;
- normalized source, emitted bundle, compiler/options, dependency, runtime and
  policy digests;
- registered SourceAsset/OperationResult input handles;
- declared FamilySpec/projection/output schemas;
- no network/path escape/native addon/child process;
- bounded OS resources, hard cancellation and deterministic replay;
- quarantine output and a TransformExecutionReceipt before Core admission.

Core rehashes and validates outputs, then performs integration, provenance,
ProductAssessment and Publisher admission. The transform cannot choose family,
validation profile, merge strategy, acceptance threshold, DAG, or publication
policy. Sandbox execution is not activation, and Host receipt is not Core trust.

### Phase 8: Agent guidance

Update the dataset construction skill and tool descriptions so the Agent:

1. chooses a registered semantic package capability;
2. inventories required entities/relations/evidence before discovery;
3. prefers registered providers and Core acquisition;
4. treats workspace scripts as candidate research transforms only;
5. stops with `product_status=incomplete` and named blockers when capability is
   absent; and
6. never invents table topology or upgrades confidence/publication status.

### Phase 9: Evaluation and Gold closure

Upgrade the Gold evaluator from checksum-only verification to a ProductEvaluator
invocation. Keep checksum/prompt/manifest freeze checks, then add required
entities, relations, identifiers, provenance, confidence/HIL and artifact
reproducibility checks. Run all six cases only after the relevant generic package
capabilities are complete on one product commit.

## Dependency Order

```text
Gold diagnostic evaluator (current P0)
  -> evidence-based contract/family review
  -> smallest Agent-to-Publication repair
  -> Gold closure and release hardening
  -> only then, if justified:
       ProductAssessment boundary
       -> Canonical Evidence IR
       -> semantic package registry
       -> package projections
       -> providers/crosswalks/derivations
       -> isolated DatasetTransform Host
       -> Agent guidance
```

Do not implement the DatasetTransform Host before the canonical object vocabulary,
OS isolation backend, bundle/dependency identity, and rollback path are frozen.
Do not add provider-specific tables without a package semantic owner. Do not
continue the canonical layer merely because the design exists; require observed
multi-family need and a release-safe rollback path.

## First Implementation Slice

The first code slice should be Phase 0 only:

- contracts for `ProductRequirementManifest`, `ProductAssessment`, and blocker/
  score records;
- pure evaluator with generic fixture tests;
- no production Publisher behavior change;
- additive result/API wiring only after the pure contract is stable.

Acceptance: evaluator distinguishes executor completion from product
publishability, returns deterministic blockers/scores, rejects incomplete
provenance/relations, and does not reference any Gold case identifier.

## Rollback

Phase 0/1 is additive. If the evaluator integration causes regressions, disable
only the new assessment projection and retain existing BuildResult/publication
behavior. Do not delete canonical evidence or alter existing immutable
publications. Later package migrations require per-package compatibility fixtures
and an explicit migration decision.
