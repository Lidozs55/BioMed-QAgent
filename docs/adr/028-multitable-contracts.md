# ADR-028: Versioned multi-table publication contracts

## Status

Accepted

## Context

The Dataset Core currently publishes one expression table through a Manifest 1.0
contract. Gold3-Gold6 require trusted publications containing several related
tables, explicit relation/cardinality semantics, provenance/confidence references,
and source locators for JSON, XML, PDF and image evidence. Adding optional fields
to the 1.0 shape would allow a payload labelled 1.0 to carry unvalidated v2 data.

## Decision

1. Add a strict Manifest 2.0 contract with `tables`, `relations`, and
   `candidate_refs`. Each table declares its schema reference, role, required and
   allow-empty policy, and field names. Each relation declares both table/field
   sides, cardinality, and missing-row policy.
2. Keep Manifest 1.0 parsing unchanged and dispatch by `schema_version`. A 1.0
   payload with v2 fields is rejected. Publication schema versions remain 1.0
   and 1.1: Publication 1.1 binds the manifest file hash regardless of the
   manifest's internal version.
3. Candidate references contain Core-owned identifiers only. Unknown tables,
   relations, schema references, fields, duplicate IDs, missing primary tables,
   invalid foreign fields, and empty candidate table references fail closed.
4. Split `SchemaField.required` from `SchemaField.nullable`. Existing 1.0
   schemas remain readable by deriving nullable from required when omitted; new
   schemas must state both semantics.
5. Preserve the existing CSV/line SourceLocator as the legacy shape and add a
   discriminated Locator 2.0 for JSON pointers, XML cells, PDF regions, and image
   bounding boxes. Every locator still requires a Core-owned asset ID and safe
   logical file.
6. Keep reference schemas out of the production FamilyRegistry until a complete
   family runtime vertical slice exists.

## Consequences

- B2/B3/B4 can implement assembly, generic relation validation, and registered
  table adapters against stable contracts without editing A-owned runtime or
  publisher files.
- Existing expression fixtures and Publication 1.0/1.1 consumers remain
  compatible, but product BuildStore/UI/runtime consumers need an explicit later
  wiring task before they can display Manifest 2.0 table inventories.
- Schema reference and field validation accepts an optional resolver so the
  contract parser can fail closed when a registry is available without making
  the wire DTO depend on a particular registry implementation.
