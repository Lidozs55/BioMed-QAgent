# ADR-029: Core-owned SourceAsset registration receipts

## Status

Accepted

## Context

The Core already hashes task-local `source_assets/` files and derives a
content-addressed `asset_<sha256>` identity. Multi-table publication needs to
refer to source, mapping, metadata, and carrier inputs without trusting Agent
workspace paths, crossing task boundaries, or silently accepting a file whose
bytes no longer match its identity.

## Decision

1. A registered asset reference contains only the content-addressed `asset_id`,
   owning `task_id`, and one role: `source`, `mapping`, `metadata`, or `carrier`.
2. A `SourceAssetRegistrationReceipt` records the source ID, task-relative
   `source_assets/` path, SHA-256, byte size, media type, registration time, and
   the asset reference. The parser requires `asset_id === asset_<sha256>` and
   rejects cross-task receipts and hash drift.
3. The preferred reference mode is `asset_id`. Legacy task-relative paths are a
   versioned compatibility mode only; they must remain under `source_assets/`
   and emit `legacy_path_compatibility_used` telemetry. Absolute paths, Agent
   workspace paths, traversal, and arbitrary download code are not accepted.
4. The receipt contract is additive to SourceAsset 1.0. Existing GEO/GDC
   adapters remain readable; A-group C1I owns runtime registration, receipt
   persistence, and replacement of compatibility call sites.

## Consequences

- C1I can register assets before adapters consume them and preserve A1's
  streaming hash/TOCTOU guarantees.
- B4M and future families can consume stable asset IDs without receiving
  workspace paths.
- Compatibility use is observable and can be retired after all built-in
  adapters migrate.
