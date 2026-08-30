# ADR-042: Use OS-assigned port fallback and one production instance per user

## Status

Accepted — 2026-08-30.

## Context

ADR-018 fixes one TypeScript Application Host and one browser-facing port, but it
does not require that port to have one fixed number. The Host previously failed
when its preferred port was occupied, even though the frontend, HTTP API,
WebSocket transport, and Vite middleware already share one server and can follow
any actual bound port.

The distributed application is a cross-platform source bundle launched with
`pnpm start`, not an Electron or Tauri desktop shell. A port collision is not an
application identity check: a different process can own the preferred port, and
two BioMed-QAgent copies can otherwise run on different ports and data roots.
The existing tasks-root lease protects one durable journal from multiple writers,
but it is not a per-user product instance lock.

## Decision

The Application Host first binds its configured preferred port (5173 by default).
Only when that real bind fails with `EADDRINUSE` does the same HTTP server bind
port 0, allowing the operating system to atomically select and reserve an
available port. The Host does not probe, randomly choose, or scan ports. It emits
its actual base URL as `BIOMED_QAGENT_URL=<url>` in addition to the human-readable
startup banner.

Static production startup (`--static`, including `pnpm start`) acquires a stable
per-user application instance lease before binding a port or initializing any
application resource. The lease uses an atomic directory claim and an owner file
containing a PID and random token. A live holder makes a second invocation print
`BioMed-QAgent is already running.` and exit successfully without constructing a
second Host. A dead or incompletely initialized holder is recovered by atomically
renaming the stale lock directory. Release is token-aware so an old holder cannot
remove a successor's lock.

The second invocation does not activate a browser, navigate to the first
instance, or send IPC. Development startup does not acquire the per-user product
lease, so isolated development Hosts remain possible. The tasks-root lease stays
in force in every mode and continues to reject multiple writers for one durable
data root.

## Consequences

- The normal URL remains `http://127.0.0.1:5173`; when it is occupied, users and
  automation must read the actual URL from startup output.
- Port selection and reservation have no probe/bind race window.
- `pnpm start` is a no-op with exit code 0 while another production instance for
  the same OS user is alive, independent of installation path, port, or output
  directory.
- A production `SIGTERM` performs bounded graceful shutdown so the application
  lease is released after other resources. Development watch restarts retain
  their immediate `SIGTERM` exit behavior.
- The lease is per user rather than system-wide, avoiding cross-account blocking
  and privileged global state. A stale lease whose PID has been reused fails
  closed until that process exits; preventing duplicate Hosts takes precedence
  over speculative takeover.
- No Electron/Tauri dependency, process-name scan, fixed-port assumption, or
  second-instance IPC is introduced.
