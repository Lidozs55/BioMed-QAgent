# ADR-034: Registered-Table Adapters Trust Core Asset Receipts

## Status

Accepted

## Context

Structured biomedical APIs commonly return CSV, TSV, or JSON that a
source-specific adapter can map deterministically into a registered canonical
schema. Agent research tools can also write similar-looking files into a task
workspace. Accepting a filesystem path or an Agent-supplied parser would make
those two origins indistinguishable and would bypass Core SourceAsset ownership,
immutable content receipts, and publication validation.

`TASK-C1C` defines task-owned, content-addressed SourceAsset references and
registration receipts. The runtime resolver that turns an asset ID into trusted
bytes remains `TASK-C1I`; this module decision must not claim that missing E2E
wiring exists.

## Decision

1. A registered-table request contains only task ID, content-addressed asset ID,
   schema reference, registered adapter ID, and parser version. Exact-key parsing
   rejects workspace paths, parser code, callbacks, and all unknown fields.
2. C1I will resolve the asset ID and supply a C1C registration receipt plus a
   read-only byte stream. The adapter requires source role, matching task/asset
   identity, `asset_id` path-compatibility mode, registered media type, size, and
   SHA-256. It recomputes size and SHA-256 before committing output.
3. Parser behavior is registered server code plus declarative field mappings.
   CSV/TSV mappings name exact ordered headers; JSON mappings use RFC 6901-style
   pointers into a registered rows array. Dynamic import, eval, shell, script,
   or Agent-provided transformations are not accepted.
4. The target is a registered `DatasetSchemaV2`. Parser target fields must equal
   the schema fields in order. Row width, nullability, supported data types, and
   configured resource limits are strict. Any rejected row rejects the complete
   table instead of silently publishing a partial canonical table.
5. Every accepted value carries a source locator: line/column locators for
   CSV/TSV and JSON-pointer locators for JSON. The audit records registration
   receipt, locator/parser versions, declared and actual hash/size, accepted and
   rejected row counts, rejection reasons, and rejected-row locators.
6. Output uses a transactional sink. Rows remain staged until complete asset and
   schema validation succeeds; receipt drift or any fatal error rolls all staged
   rows back. Runtime registration, `adapters.ts` wiring, Core operation results,
   validation, and publication remain separate owner tasks.

## Consequences

- A workspace file cannot become trusted merely because it has a valid table
  shape; it first needs C1I registration and an immutable Core receipt.
- Source-specific API adapters remain small declarative mappings while sharing
  one strict CSV/TSV/JSON validation and audit implementation.
- Parser changes require an explicit version change, making parser identity part
  of audit and future checkpoint/cache identity.
- `TASK-048-B4M` is module-complete after this decision and its fixtures/tests,
  but trusted E2E remains blocked by `TASK-C1I` and the owner-controlled wiring;
  no family or Publication capability is completed by this module alone.
