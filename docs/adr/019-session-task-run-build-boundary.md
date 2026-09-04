# ADR-019: Pi Session, BioMed Task, Run, and DatasetBuild remain distinct

## Status

Superseded by ADR-041 - 2026-08-27. Retained as Build-domain decision history.

## Context

Pi introduces a session identity while BioMed already has durable Task, Run, and
DatasetBuild identities. Reusing one identifier or lifecycle for all four would make
conversation state authoritative for product state and would prevent multiple turns
or builds from being represented correctly.

## Decision

The identities and lifetimes are:

| Object | Owner and meaning | Lifetime |
| --- | --- | --- |
| Pi Session | Pi adapter; conversation, model context, and tool trace | One model-facing conversation; Phase 1 registry is process-local |
| BioMed Task | BioMed runtime; durable product object and user-visible history | Across process restarts until explicit terminal-task deletion |
| Run | BioMed runtime; one execution caused by one user turn | From queue admission through one terminal run state |
| DatasetBuild | Dataset Core; resumable deterministic construction from one spec | Independent build lifecycle; zero or more may be associated with a Run |

Mappings are explicit records (`task_id`, `run_id`, `pi_session_id`, and any
`build_id`); no layer substitutes for another. A Task may contain multiple Runs, a
Run may invoke zero or more DatasetBuilds, and a Pi Session may span multiple Runs
only when the adapter explicitly preserves that mapping.

## Consequences

- `SessionRegistry` is not a `TaskRepository`; losing an experimental Phase 1 Pi
  session on restart does not redefine durable Task state.
- Cancellation is propagated across mapped objects but each owner records its own
  terminal result.
- Experimental Pi event order does not become durable Task replay authority.
- Resource ownership is enumerated in
  [runtime-ownership-matrix.md](../migration/runtime-ownership-matrix.md).
