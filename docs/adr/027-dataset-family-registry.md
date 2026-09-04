# ADR-027: Dataset families are registered runtime capabilities

## Status

Accepted - 2026-08-18.

## Context

The fixed Dataset Construction Runtime is intentionally not an Agent-defined DAG,
but its production entry points still encoded one dataset family directly. The Pi
tool schema listed only gene-expression schemas, granularities, profiles, sources,
and adapter parameters. The default Schema Registry and production SpecValidator
were assembled separately, so adding a family could expose values to the Agent
without proving that the deterministic Core owned the matching runtime behavior.

Gold3-Gold6 confirmed the resulting product boundary: the Agent can research
non-expression evidence, but the Core cannot yet validate and publish it. Registering
reference schemas alone would create a false capability because adapters,
canonicalization, assembly, validation, confidence, provenance, and publication
policy would still be absent.

## Decision

A `DatasetFamilyRegistry` is the production source of admitted dataset-family
capabilities. Each `DatasetFamilyDefinition` declares:

- canonical schemas and row granularities;
- target entity levels when the family uses them;
- normalization and validation profile references, including a family-owned default;
- schema-to-profile and source-to-schema compatibility;
- allowed merge strategies and output formats;
- source-to-adapter bindings, Agent-facing parameter schemas, and runtime validators;
- a `runtime_id` admitted only when the Core has registered that family runtime.

The default Schema Registry is derived from registered family definitions. The Pi
DatasetBuild tool emits a family-discriminated JSON Schema `oneOf`, and the
production SpecValidator checks family/schema/granularity/profile/merge/source/
adapter consistency before acquisition. Tool input is parsed through the strict
`DatasetBuildSpec` runtime parser instead of being accepted by TypeScript cast.

Registry construction resolves every declared Schema, Adapter, normalization
profile, and validation profile; rejects missing, duplicate, cross-family, or unsupported
source/schema/profile combinations; and refuses a family whose `runtime_id` has no Core
implementation.
The remaining deterministic operation handlers, provenance/confidence policy, and
publication assembly are deliberately not abstracted in this foundation change;
they land with the multi-table execution layer. This ADR initially registers only
`gene_expression` and does not claim trusted publication support for Gold3-Gold6.

The fixed operation skeleton remains. `integrate` continues to merge, deduplicate,
and resolve conflicts within one canonical table. A later change may add a family
`assemble` operation after integration to produce a trusted multi-table
`PublicationCandidate`; this is not a rename and does not make the Publisher
family-specific.

## Consequences

- Adding a family's admission contract becomes one explicit registration unit
  instead of edits to unrelated Agent/Core allowlists.
- Agent-visible capabilities and Core admission share one source of truth.
- Existing DatasetBuildSpec 1.0, expression schemas, operation IDs, manifest 1.0,
  publication 1.1, and expression artifact layout remain compatible.
- `target_entity_level` is a family-defined string at the wire level; the selected
  family definition constrains its admitted values.
- Gold3-Gold6 remain artifact failures until their reusable schemas, trusted
  adapters, family canonicalizers/assemblers, validation profiles, provenance and
  confidence policies, and multi-table publication contract are implemented.
- New family registration must include tests proving definition consistency and
  rejection of mismatched source/adapter/spec combinations.
