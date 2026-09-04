# Gold Exec Routing Hardening Design

## Goal

Prevent formal Gold runs from stalling when the Agent tries to replace governed
acquisition or staging tools with `workspace_exec`, without weakening the normal
permission boundary or automatically approving arbitrary commands.

## Observed failures

- Gold7 wrapped directory creation, file copying, and ZIP inspection in a
  PowerShell `-Command` script. The operation could only create workspace staging
  state; it could not close the missing Core-owned supplementary extraction
  carrier.
- Gold8 invoked `curl.exe` against a GitHub URL instead of using the governed
  browser/download tools or the registered openFDA lookup.
- Both commands correctly produced `process.exec@workspace` permission requests.
  The formal supervisor stopped because neither command matched its fixed parser
  allow-list.

## Design

The repair is deliberately layered:

1. The production workspace command boundary rejects direct network transport
   executables and URL-bearing command arguments before permission evaluation.
   The structured error directs the Agent to governed browser/download tools or
   a registered Dataset Core provider. This prevents subprocess network access
   from bypassing the pinned public-HTTP policy in every permission preset.
2. The formal Gold supervisor automatically denies known shell-wrapper and direct
   network-download permission requests, records the denial, and continues the
   same run. Unknown `process.exec` requests still stop fail-closed for human
   review. No unsafe command is executed or added to the allow-list.
3. The phase-one prompt, dataset-construction skill, and Gold rerun documentation
   state the same recovery contract: do not use shell/network subprocesses to
   replace registered acquisition, filesystem tools, or a missing formal
   extraction carrier; use governed tools or return a structured blocker.
4. The Gold rerun documentation is corrected to match the implementation's real
   automatic allow-list: a workspace-local, argument-free `node parse*.js/mjs`
   entry point, not version-diagnostic commands.

## Error handling

- Host-side policy rejection returns `policy: "rejected"`, `exitCode: null`, and
  a deterministic recovery message without emitting `permission_requested`.
- Formal supervisor known-bypass denial is posted with `decision: "deny"` and
  `grant_scope: null`, then event polling continues.
- Malformed, sensitive, external, or otherwise unknown permission requests remain
  terminal supervisor blockers.

## Verification

- Reproduce the exact Gold8 `curl.exe` shape in a workspace tool test and verify
  rejection occurs before the permission broker is consulted.
- Reproduce the Gold7 PowerShell wrapper and Gold8 curl request in supervisor
  classifier tests; verify deterministic deny while an unrelated command stops.
- Verify allowed fixed parser behavior remains unchanged.
- Run targeted server tests, `pnpm docs:check`, workspace lint, typecheck, build,
  and the server suite required by repository policy.

