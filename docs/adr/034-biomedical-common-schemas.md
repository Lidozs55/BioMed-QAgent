# ADR-034: Parameterized biomedical common schemas remain non-production capabilities

## Status

Accepted

## Context

The non-expression publication families need shared identity, source, paper,
compound, assay, structure, trial, and crosswalk table shapes. Repeating those
columns in each family would allow the same concept to drift across family
modules. The shared shapes also need explicit ID namespaces, relation and unit
semantics, and identity-link evidence so that a future family can pass the
existing B1 contract parsers and B3 structural/relation gate.

A shared schema alone must not create a production family. A family still needs
its own trusted adapter, assembler, validation/confidence policy, provenance
closure, and runtime wiring before it can enter the default registry.

## Decision

1. Add B-owned parameterized builders under `server/src/dataset/schema/common/`.
   Every builder takes a `datasetFamily` and produces a `DatasetSchemaV2`; table
   builders produce the matching B1 `TableDefinition` as well.
2. Provide reusable builders for entity, paper, compound, assay, structure
   dimension, trial, source carrier, entity crosswalk, and compound crosswalk.
   Source is modeled as a carrier/supporting table, never as a dataset family.
3. Keep finite vocabularies for ID namespaces, relation types, cardinalities,
   measurement relation tokens, units, crosswalk match methods/conflict states,
   and confidence levels. Unknown values fail at builder/parser boundaries.
4. Crosswalk schemas preserve the assertion rather than collapsing identities:
   `match_method`, structured `match_evidence`, `conflict_status`, optional
   `conflict_details`, `confidence_score`, and `confidence_level` are explicit
   columns. Conflicts remain separate assertions.
5. Reuse `parseDatasetSchemaV2`, `parseTableDefinition`, and
   `parseRelationDefinition`; B3 remains the owner of byte-level table,
   foreign-key, cardinality, token-preservation, provenance, and confidence
   closure checks. Common builders do not duplicate validation or publish.
6. Do not add common schemas to the default schema/family registry or modify
   runtime, adapters, assembly, or publication wiring in this task.

## Consequences

- Future family modules can select the same common concept without copying its
  field semantics, while still choosing their own family and row granularity.
- A generated common table is structurally ready for B1/B3, but it is not a
  trusted ingestion or publication capability by itself.
- Vocabulary admission is intentionally conservative. New authorities, units,
  relation types, or match methods require an explicit schema-owner change and
  tests rather than silent string expansion.
- Crosswalk consumers can distinguish an exact match, a conflict, and an
  unresolved assertion without losing the evidence needed for review.
