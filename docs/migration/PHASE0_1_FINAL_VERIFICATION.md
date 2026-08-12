# Phase 0/1 Final Verification

Verification date: 2026-08-12.

This record closes the six Important findings from the single whole-branch review of
the Phase 0/1 migration. No second broad review was performed.

## Review fixes

1. The Dataset Core bridge fails closed without a secret, requires loopback plus a
   constant-time secret match, and rejects attach/client configurations with a blank
   secret.
2. Experimental Pi uses a bounded live handoff buffer while no subscriber is registered.
   Zero-delay first runs, later runs, and immediate failures reach the next live
   subscriber without claiming durable replay.
3. Pi emits cancellation acknowledgement only after upstream abort succeeds. Abort
   rejection becomes a bounded `UPSTREAM_FAILURE`, and terminal projection suppresses
   duplicate failure events.
4. Managed legacy processes are owned and terminated as process trees. Windows tests
   cover child and grandchild cleanup when the direct parent is live and after it exits.
5. Managed mode dynamically allocates its private loopback port. Readiness uses the
   per-launch secret, validates the internal bridge response, and races against child
   exit, so an occupied port or unrelated HTTP 200 cannot satisfy startup.
6. Bridge calls carry request, task, run, Pi session, tool call, and build identities.
   Python binds the outer run ID into `RunContext`; bounded structured diagnostics include
   duration and typed outcome.

## Final gates

The Node gates used the configured project environment, not an embedded application
runtime:

```text
node v24.11.1
pnpm 11.14.0
```

Results:

- `pnpm test`: passed; contracts 13, server 101, frontend 751 tests;
- `pnpm lint`: passed with zero errors/warnings;
- `pnpm typecheck`: passed;
- `pnpm build`: passed; contracts, server, and frontend built;
- `uv run pytest`: 2396 passed, 1 skipped, 26 deselected;
- `uv run ruff check app/ tests/ launcher.py`: passed;
- direct Uvicorn smoke: public health returned 200 and the owned process stopped;
- root `pnpm dev` smoke: public health returned 200, public
  `/internal/migration/*` returned 404, dynamic private backend identity was accepted,
  and shutdown released the public port;
- real Windows process-tree tests: live-parent and exited-parent grandchild cleanup both
  passed.

One root parallel run timed out once while cancelling a workspace process tree and then
reported a busy temporary directory. The same 23-test workspace file passed in isolation,
the complete 101-test server suite passed, and the final root parallel run passed with the
counts above. The failure was not reproducible and no timeout or cleanup behavior was
weakened to hide it.

Frontend Vitest still prints pre-existing React `act(...)` diagnostics in several tests;
the suite completed with zero failures. Vite reports the pre-existing large-chunk
advisory during production build; the build exits successfully.

Environment and local-data migration instructions are in
[ENVIRONMENT_MIGRATION.md](ENVIRONMENT_MIGRATION.md).
