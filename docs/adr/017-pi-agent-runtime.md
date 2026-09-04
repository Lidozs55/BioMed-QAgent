# ADR-017: Pi replaces the custom Agent layer, not deterministic dataset semantics

## Status

Accepted — 2026-08-12.

## Context

The custom OpenAI Agents SDK loop currently owns conversation orchestration, tool
registration, prompt assembly, and model-facing execution. The repository also
contains deterministic biomedical semantics—spec validation, compatibility,
normalization, validation profiles, provenance, and publication—that are tested
independently of the model. Treating all of this as one “agent runtime” would turn
the migration into an unsafe rewrite and weaken the product boundary.

## Decision

Pi replaces the model-facing Agent layer incrementally. It may take over sessions,
turn execution, model/provider wiring, skill loading, tool dispatch, streaming, and
cancellation. It does not replace BioMed deterministic business semantics merely
because it replaces the Agent framework. Those semantics remain trusted services
or tools governed by [ARCHITECTURE.md](../ARCHITECTURE.md).

The legacy Agent path stays available during the strangler transition and is removed
only after equivalent Pi behavior and rollback gates are verified.

## Consequences

- Agent-framework replacement can proceed without rewriting the Dataset Core.
- Prompt or Skill text cannot become the sole enforcement point for business rules.
- Legacy and Pi Agent paths may coexist temporarily, but both must reach the same
  trusted dataset boundary.
- Phase 1 scope and tool disposition are frozen in the
  [tool and prompt migration matrix](../migration/agent-tool-prompt-matrix.md).
