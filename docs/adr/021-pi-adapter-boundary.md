# ADR-021: Isolate Pi dependencies behind one adapter

## Status

Accepted — 2026-08-12.

## Context

Pi package types, event shapes, and lifecycle APIs may evolve independently of
BioMed. Allowing them throughout Host, API, workspace, and business code would couple
the migration to upstream internals and make fake-based testing and rollback hard.

## Decision

All imports of Pi runtime packages and all construction of Pi sessions are confined
to `server/src/agent/pi-adapter.ts` or an equivalent module inside the same adapter
boundary. Project code depends on BioMed-owned session, event, tool, cancellation,
and error interfaces.

The adapter owns Pi session creation, provider/model injection, skill roots, tool
registration, workspace `cwd`, upstream event normalization, cancel/dispose, and
translation of upstream failures. It does not own Task/Build persistence,
Publication, durable sequence storage, or UI state.

## Consequences

- A fake adapter can verify Host behavior without Pi or network access.
- A static import-boundary check is required before enabling the Pi path.
- Upstream Pi changes are localized; project contracts can remain stable.
- Event conversion after the adapter follows
  [pi-event-adapter.md](../migration/pi-event-adapter.md).
