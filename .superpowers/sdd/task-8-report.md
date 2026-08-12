# Task 8 report — governed Pi Task Workspace

Date: 2026-08-12
Worktree: `D:\coding\BioMed-QAgent\.worktrees\migration-pi-runtime-phase0-1`
Starting HEAD: `b4b54a0`
Local commit subject: `feat: add governed Pi task workspace`
Push: not performed

## Delivered

- Added project-owned Task Workspace context, identity validation, path policy,
  bounded read/list/search, staging-only write/edit, audit sinks, development exec,
  and tool composition under `server/src/agent/workspace/`.
- Kept Workspace modules independent of Pi. Project JSON Schema tool descriptors are
  converted to Pi 0.82.1 `ToolDefinition` values only in `pi-adapter.ts`; Pi built-ins
  remain disabled.
- Replaced the experimental runtime's repository-root cwd with an explicit factory
  mapping `task_id` to the existing `OUTPUT_DIR/tasks/<task_id>` Task root. The Host
  owns the append-only `logs/workspace-audit.jsonl` sink.
- Connected session/runtime/Host disposal to Workspace cleanup and active command
  cancellation. Legacy Python tools were not changed.

## TDD evidence

The first focused Workspace run was a genuine RED: `workspace.test.ts` could not
resolve `../src/agent/workspace/index.js`. After the bounded file operations were
implemented, the first exec-focused run was also RED: 18 tests passed and all five
exec cases failed with `Development exec implementation is not available`.

The adapter/Host integration tests were then written before integration. Their RED
had six assertion failures plus the missing `workspace/tools.js` module: non-empty
tools were rejected, cleanup was absent, the experimental cwd remained static, and
the development flag was not parsed.

A final state-policy regression demonstrated that `list(state)` exposed
`state/session_items.jsonl` (1 failure, 22 skipped). The implementation now filters
list and search candidates through the same minimal state allowlist as read. An
invalid-session cleanup regression likewise failed with zero cleanup calls before
the adapter lifecycle fix.

## Windows security evidence

The authorized Windows focused run passed 36/36 tests (23 Workspace, 2 tool/audit,
11 adapter). It exercised:

- parent, mixed-separator, POSIX absolute, drive-rooted/relative, UNC,
  extended/device, NUL, reserved-name, case, and separator aliases;
- a Windows junction escaping the Task root (the run reported no privilege skip);
- state allowlisting, bounded logs, stable bounded list/search, large read/write
  limits, and ambiguous edit rejection;
- protected write/edit byte-digest preservation;
- exec disabled by default, fixed Task cwd, filtered environment, `shell: false`,
  executable metacharacter rejection, and combined stdout/stderr truncation;
- timeout, AbortSignal cancellation, Workspace/session disposal, and normal wrapper
  completion killing child and grandchild processes through Windows tree cleanup;
- protected command mutation detection, bounded byte backup, exact restoration, and
  rejected policy evidence; oversized snapshots refuse execution before spawn;
- success, rejection, disabled, timeout/cancel, and append-only audit behavior
  without logged arguments marked as secrets or absolute executable paths.

The POSIX implementation uses a detached process group and negative-PID `SIGKILL`;
it is covered by the same cross-platform test source but was not executed on this
Windows host.

## Verification

- Focused Task 8: 3 files, 36 tests passed in 4.81 s.
- Server suite: 11 files, 62 tests passed in 5.24 s.
- Server lint, typecheck, and build: passed.
- Root `pnpm test`: passed — workspace foundation, 62 server tests, 3 contracts
  tests, and 739 frontend tests. Existing React `act(...)` stderr warnings remained
  non-failing.
- Root `pnpm lint`: passed.
- Root `pnpm typecheck`: passed.
- Root `pnpm build`: passed. Vite emitted its existing non-failing large-chunk
  warning.
- Static Pi-import boundary: passed as part of the server suite.
- `git diff --check`: passed.

## Development exec limitations

This is an explicitly enabled development prototype, not an OS sandbox. The safety
boundary is application-level: it makes a bounded byte-for-byte snapshot of every
Task-root entry outside `staging/agent`, refuses to run if that snapshot exceeds the
file/byte limits, terminates the process tree, compares the protected tree, restores
the snapshot on any difference, and rejects the command. It cannot contain or audit
writes a permitted development executable makes outside the Task root; production
must continue to leave this tool disabled until an OS-level sandbox or reviewed
allowlisted runner exists.

Windows full-tree cleanup uses `taskkill /T /F`; a bounded internal timeout and
direct-child kill are defensive fallbacks, but the fallback alone is not claimed to
provide full descendant cleanup when Windows denies tree termination. The authorized
test run verified the full tree path.
