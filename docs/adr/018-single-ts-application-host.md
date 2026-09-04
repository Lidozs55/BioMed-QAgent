# ADR-018: Use one TypeScript Application Host and one browser-facing port

## Status

Accepted — 2026-08-12.

## Context

The current development topology exposes Vite and FastAPI as separate processes and
ports. Adding Pi as a third public service would multiply routing, lifecycle, CORS,
and shutdown behavior and would make the transition topology permanent by accident.

## Decision

The target application has one TypeScript Application Host, one public browser port,
and one process-level composition root. In development the Host embeds Vite as
middleware. During Phase 1 it serves the experimental Pi surface and proxies the
legacy HTTP/WebSocket product surface to FastAPI on a private loopback port.

Legacy FastAPI is a transitional implementation, not a second browser entry point.
It must not bind a public interface in this topology.

## Consequences

- `pnpm dev` becomes the single normal development entry after the Host shell is
  ready; standalone frontend/backend commands remain migration diagnostics only.
- The Host owns ordered startup and shutdown of Vite, Pi sessions, and any managed
  legacy child process.
- Removing the proxy later does not change the browser origin or public port.
- The operational lifecycle and rollback combinations are fixed in
  [single-host-lifecycle-and-flags.md](../migration/single-host-lifecycle-and-flags.md).
