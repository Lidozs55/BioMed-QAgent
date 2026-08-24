# ADR-022: Phase 1 uses a named-operation Legacy Dataset Core bridge

## Status

Superseded — 2026-08-14 by the Phase 8 retirement of the legacy Dataset Core.

The decision below remains the Phase 1 transport record. The bridge and
`server/src/legacy/` no longer exist; Python is now limited to the persistence
bridge described in [the architecture](../ARCHITECTURE.md). See
[PHASE8_FINAL_VERIFICATION.md](../migration/PHASE8_FINAL_VERIFICATION.md) for
retirement evidence.

## Context

Pi must reach the Python V2 Core without depending on the OpenAI Agents SDK wrapper
or exposing a general Python execution surface. The existing FastAPI lifespan also
owns resources needed by the current dataset service, so bypassing it prematurely
would create a second partial Python runtime.

## Decision

Phase 1 exposes only three versioned operations:
`validate_dataset_build_spec`, `execute_dataset_build`, and `get_build_result`.
The TypeScript client hides transport details behind
`server/src/legacy/dataset-core-client.ts`. The preferred first transport is a
loopback-only internal endpoint on the managed legacy process and is never proxied to
the browser.

The bridge cannot execute arbitrary Python or SQL and cannot accept arbitrary path
writes. Publication remains inside the Core. The normative envelope, errors, and
cancellation behavior are defined in
[legacy-dataset-core-bridge.md](../migration/legacy-dataset-core-bridge.md).

## Consequences

- The legacy FunctionTool and Pi bridge can be parity-tested against the same fixture.
- Transport may later change to a managed JSONL subprocess without changing Pi tools.
- Bridge unavailability, domain outcomes, and cancellation remain typed rather than
  collapsing into HTTP 500 strings.
- The bridge is temporary and is removed when a replacement Core is authoritative.
