# ADR-020: Python V2 Dataset Core remains authoritative in Phase 0/1

## Status

Superseded — 2026-08-14 by the Phase 8 TypeScript Dataset Core migration.

This record remains the authoritative Phase 0/1 decision: deterministic dataset
semantics were never delegated to Pi. The current implementation is the
TypeScript Dataset Core described in [the architecture](../ARCHITECTURE.md); the
retirement evidence is in
[PHASE8_FINAL_VERIFICATION.md](../migration/PHASE8_FINAL_VERIFICATION.md).

## Context

The Python V2 Core already enforces scientific and publication invariants through
typed contracts and deterministic services. Re-expressing those invariants as Pi
prompt instructions would make correctness model-dependent and discard validated
behavior before a replacement exists.

## Decision

Python V2 remains the authoritative Dataset Core for Phase 0 and Phase 1. It owns
spec validation, compatibility, deterministic transformation and integration,
Validation Profiles, provenance closure, BuildResult semantics, and atomic immutable
Publication. Pi can propose a spec and invoke trusted operations; it cannot implement
or relax these rules.

Validation and Publication rules are executable Core contracts. They must never be
reduced to prompt or Skill instructions. A future TypeScript Core requires explicit
parity evidence and a superseding ADR.

## Consequences

- Phase 1 proves the Agent/Core seam instead of rewriting acquisition or science.
- Formal artifacts still originate only from the Core publication path.
- `NO_DATA`, `PARTIAL_SUCCESS`, and `SPEC_REJECTED` remain domain outcomes rather
  than prose invented by the Agent.
- The Phase 1 invocation boundary is defined by
  [ADR-022](022-phase1-legacy-core-bridge.md).
