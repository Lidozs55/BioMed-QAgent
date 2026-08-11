# ADR-024: `@biomed/contracts` is canonical for TypeScript wire DTOs

## Status

Accepted — 2026-08-12.

## Context

The frontend historically defined its own TypeScript runtime contracts while the
legacy service used Python Pydantic models. Adding a TypeScript Host would create a
third contract copy unless TypeScript consumers share one package. Python remains
the executing legacy runtime in Phase 0/1, so an immediate language-wide rewrite is
neither necessary nor safe.

## Decision

`@biomed/contracts` is the canonical source for TypeScript wire DTOs used by the
frontend and TypeScript Host. Frontend-local contract modules may re-export these
DTOs and retain view-only types, but they do not redefine the wire schema.

Python Pydantic models remain the legacy runtime implementation during Phase 0/1.
Bidirectional parity fixtures must verify that both sides interpret stable payloads,
enums, optional fields, and schema versions consistently. Contract changes land in
the shared package first and preserve compatibility unless an explicit versioned
migration is approved.

## Consequences

- TypeScript wire consumers cannot drift independently.
- Python remains executable without pretending that generated TS types govern its
  runtime behavior.
- Parity fixtures, rather than hand-maintained prose, detect cross-language drift.
- This ADR defines source ownership; field semantics remain authoritative in
  [ARCHITECTURE.md](../ARCHITECTURE.md).
