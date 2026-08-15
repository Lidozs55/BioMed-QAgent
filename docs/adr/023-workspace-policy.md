# ADR-023: Preserve staging-only Agent writes and immutable state boundaries

## Status

Accepted — 2026-08-12. **Superseded by [ADR-026](026-agent-workspace-permissions.md) on
2026-08-16** for the Agent write model: the staging-only confinement is retired in
favor of a dedicated Agent Workspace (`data/workspaces/<taskId>`) plus an
`allow/ask/deny` permission system. The immutable-publication guarantee survives —
it now rests on manifest + content hash verification instead of path
unreachability.

## Context

Pi supplies more general read, write, edit, and command capabilities than the current
Python Agent tools. Without a repository policy, that convenience could bypass the
publication gate, mutate durable state, or escape a task workspace differently on
Windows and Linux.

## Decision

Agent-originated write and edit operations are confined to `staging/agent/` within
the mapped Task workspace. Reads are bounded and task-relative. `artifacts/` and
`state/` are never Agent-writable; formal artifacts are created only by the Dataset
Core and durable state only by its owning runtime.

Development command execution is audited, bounded, cancellable, and rooted at the
Task workspace. Phase 1 product mode exposes only a policy prototype, not an
unrestricted shell. Path containment is verified after resolution with explicit
Windows and Linux security coverage.

## Consequences

- Pi workspace tools preserve the existing publication and state invariants.
- Edit cannot be used as an alternate path to mutate a protected file.
- Child processes and output limits become Host-owned security obligations.
- The complete permission and test policy is
  [workspace-policy-phase1.md](../migration/workspace-policy-phase1.md).
