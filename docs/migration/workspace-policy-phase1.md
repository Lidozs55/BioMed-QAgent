# Phase 1 Pi Workspace Policy

This is the normative Phase 1 operating policy required by
[ADR-023](../adr/023-workspace-policy.md). All paths supplied by the Agent are
relative to one resolved Task workspace root.

## Directory permissions

| Directory | Read | Write/edit | Files created by exec | Owner |
| --- | ---: | ---: | ---: | --- |
| `source_assets/` | yes | no | no | acquisition/runtime |
| `parsed/` | yes | no | no | Dataset Core |
| `normalized/` | yes | no | no | Dataset Core |
| `staging/agent/` | yes | yes | yes | Agent through Workspace tools |
| `artifacts/` | yes | **no** | **no** | Publisher only; immutable after publication |
| `state/` | limited, allowlisted reads | **no** | **no** | Task/Dataset runtime only |
| `logs/` | bounded read | no | no | Host/runtime only |

List, read, and search operations are bounded by entry count, byte count, and output
size. Write and edit resolve both the requested path and its existing parent/target
before authorizing the operation. A symlink, junction, reparse point, or path alias
must not turn an allowed lexical path into an external or protected physical path.

## Path authorization

Before filesystem access, the Workspace implementation:

1. rejects empty, absolute, device, drive-qualified, UNC, and parent-traversal input;
2. joins the task-relative path to the canonical Workspace root;
3. resolves existing parents and targets without following an escape outside the root;
4. checks the resolved target against the operation permission table;
5. opens or replaces the file without widening permissions through a second path;
6. records the normalized relative path, operation, Task/Run identity, result, and
   duration in the command/file audit stream.

The same checks apply to edit, rename, command output, and temporary files. The Host
and Dataset Core may write protected directories through separate trusted services;
the Agent tool cannot inherit that authority.

## Development exec policy

Development `exec` is enabled only by an explicit development configuration and has:

- `cwd` fixed to the Task workspace;
- a bounded wall-clock timeout and cooperative cancellation;
- bounded stdout/stderr capture with a `truncated` marker;
- structured result fields: command, exit code, stdout, stderr, duration, and
  truncation state;
- an audit record containing executable/arguments without logging secrets;
- environment filtering and no automatic credential injection;
- process-tree cleanup on completion, timeout, cancellation, and Host shutdown;
- post-execution verification that created/modified files remain inside
  `staging/agent/`.

Generic development commands do not authorize protected writes. A command that
attempts them fails even when its process exit code would otherwise be zero.

## Product exec policy

Phase 1 product mode does not expose an unrestricted shell. `workspace_exec` is a
policy prototype and is disabled by default; when a product test explicitly enables
it, only reviewed command templates with bounded arguments may run. There is no
shell-string interpolation, background mode, user-selected executable path, or
credential-bearing environment. Broader product execution requires a separate
security review and ADR.

## Required cross-platform security cases

Each case is automated on Windows and Linux unless the row names an OS-specific
representation. Passing on one OS does not waive the other.

| Case | Windows evidence | Linux evidence | Required result |
| --- | --- | --- | --- |
| Parent escape | `..\` and mixed separators | `../` and repeated separators | Reject before access |
| Absolute path | drive-rooted path | `/etc/...`-style path | Reject before access |
| Drive/UNC/device path | drive-relative, UNC, extended-length, and device names | Not applicable representation; retain generic absolute-path test | Reject before access |
| Symlink-like escape | junction, symlink, and reparse-point target outside root | symlink target outside root | Reject resolved target |
| Protected write/edit | `artifacts/` and `state/` using case/separator variants | `artifacts/` and `state/` | Reject with no file change |
| Protected command output | redirection or child output targeting protected paths | redirection or child output targeting protected paths | Terminate/fail and leave protected paths unchanged |
| Case and alias handling | case-insensitive aliases and trailing dot/space forms | case-sensitive sibling names | Authorize by canonical OS semantics |
| Command timeout | process tree with child | process group with child | Kill complete tree and return timeout |
| Cancellation | long-running child and grandchild | long-running child and grandchild | Kill complete tree and return cancelled |
| Output flood | stdout and stderr beyond limits | stdout and stderr beyond limits | Truncate without unbounded memory growth |
| Background leak | detached/background child attempt | daemonized/background child attempt | No surviving child after tool/Host shutdown |

Windows cleanup must cover process-tree semantics rather than terminating only the
shell wrapper; Linux cleanup must cover the process group. Tests verify protected
directory digests before and after every denied write and cancellation case.
