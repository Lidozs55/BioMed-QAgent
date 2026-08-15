# ADR-026: Agent Workspace 与权限系统（Workspace 独立 + allow/ask/deny）

- Status: Accepted (2026-08-16)
- Supersedes: [ADR-023](023-workspace-policy.md) — the staging-only write model
  is retired; this record keeps the immutable-publication guarantee of ADR-023
  and moves the enforcement point from "the agent cannot reach the path" to
  "publication is hash-verifiable".

## Context

The Pi migration gives the Main Agent generic file tools and command execution.
The old Workspace Policy treated the task directory as a sandbox with
path-denials (absolute paths rejected, `../` rejected, writes confined to
`staging/agent/`). That model has two structural problems:

1. **No physical boundary** between agent work files and framework state — both
   lived under `data/output/tasks/<taskId>/` (`source_assets/`, `parsed/`,
   `normalized/`, `staging/`, `artifacts/`, `state/`, `logs/`).
2. **Path denials are the wrong control for a general agent** — an agent with
   `read`/`write`/`edit`/`exec` needs an explicit permission decision, not a
   hidden allowlist; and "cwd = workspace" is not a sandbox for commands.

## Decision

Three independent concepts:

```text
Workspace          = Agent's own working directory (data/workspaces/<taskId>)
Permission System  = authorization when the Agent touches anything else
Deterministic Core = the only trusted path that produces Publications
```

### 1. Workspace decoupling (W1)

- Agent cwd moves from `data/output/tasks/<taskId>/` to
  `data/workspaces/<taskId>/` (sibling of the output dir).
- `data/output/tasks/<taskId>/` keeps framework state only
  (`source_assets/`, `parsed/`, `normalized/`, `artifacts/`, `state/`,
  `logs/`, `events.jsonl`).
- The workspace holds no `.biomed-*` metadata; workspace path/version/migration
  state lives in `<taskOutput>/state/workspace.json`.
- Multiple runs of a task share one workspace; task deletion removes both the
  workspace and the framework output (after cancel/dispose).
- Workspaces are durable across restarts; `WorkspaceManager.ensure(taskId)` is
  the only path derivation entry point.
- Legacy `staging/agent/**` content is migrated once into the workspace
  (copy → verify → mark), then left in place for reversibility.

### 2. Permission system (P1–P6)

```text
Permission = Capability × Resource × Policy
capability: fs.read | fs.write | fs.edit | process.exec
policy:     allow | ask | deny
```

- Resources classify into scopes after canonicalization (realpath): workspace,
  task_output, project, external.
- Defaults (ask-when-needed preset): workspace read/write/edit allow; task
  output read allow, write/edit deny; project/external ask; `process.exec` ask.
- Decision order: framework invariant (hard deny on
  `task_output/{state,logs,artifacts}/**` writes) → temporary grant (once/run/
  task) → most-specific persistent rule → preset default.
- The agent requests permission simply by attempting the operation — there is
  no `request_permission` tool. An `ask` suspends exactly one tool call
  (`permission_requested` durable event) and resumes it after the user decides
  via `POST /api/v1/tasks/{taskId}/runs/{runId}/permissions/{requestId}`.
- `process.exec` is an independent high-risk capability; command-string
  analysis is forbidden. Runtime controls (timeout, output limits, cancel,
  process-tree cleanup, audit) remain, and the OS-account warning is shown in
  the UI. Migration flag `AGENT_EXEC_POLICY=deny|ask|allow` temporarily
  overrides the preset.
- Persistent rules are user settings (`data/settings/agent-permissions.json`),
  never workspace data.

### 3. Publication trust moves from unreachability to verifiability (P7)

- Agent file tools can never publish; the Dataset Core remains the only
  publication path, and every read of a published artifact verifies manifest
  hash + size (ArtifactIntegrityError on drift).
- Therefore "Full Access" does not break business trust semantics: even if an
  allowed command mutates an artifact file, the integrity check detects it.

## Consequences

- Workspace tools accept relative and absolute paths; nothing is rejected for
  "escaping" — paths flow through normalize → classify → broker.
- The old `staging/agent` write-only rule and the exec "protected snapshot /
  restore" machinery are removed (the workspace is agent-owned).
- Permissions are audited (`logs/permission-audit.jsonl`) and mirrored as
  durable `permission_requested` / `permission_resolved` events so the UI can
  restore pending approvals after a reconnect; pending promises are in-memory
  and invalidated on restart/cancel.
- ADR-023's immutable-publication guarantee is preserved via manifest + hash;
  see ADR-023 for the original staging-only rationale (retired).
