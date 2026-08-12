# Phase 1 Single-Host Lifecycle and Feature Flags

This document operationalizes [ADR-018](../adr/018-single-ts-application-host.md).
The Phase 1 target has one TypeScript Application Host and one browser-facing port;
legacy FastAPI is private and loopback-only.

## Startup and shutdown

Normal development startup is ordered:

```text
TS Host process
→ validate feature-flag combination and configuration
→ start or attach the legacy backend on a private loopback port
→ wait for required legacy readiness
→ initialize Pi adapter and experimental session registry when enabled
→ create Vite middleware
→ create routes/proxies and WebSocket upgrades
→ listen on the one public application port
```

The Host does not open the public port if a required resource fails. Partial startup
closes resources already created in reverse order and terminates a managed legacy
child. An attached externally managed diagnostic backend is never killed by the
Host; ownership is explicit in configuration.

Graceful shutdown is ordered:

```text
stop accepting new HTTP/WS work
→ request cancellation of active experimental Pi sessions and Tools
→ await bounded session disposal and kill leaked command process trees
→ close experimental event listeners and Pi adapter resources
→ close Vite middleware/watchers
→ close legacy HTTP/WS proxies
→ terminate the Host-managed legacy backend and await exit
→ close the public server and process resources
```

Timeout escalation is bounded and logged. `Ctrl+C`, startup failure, normal exit,
and test teardown follow the same closer registry so no Pi, Vite, legacy, or command
child survives the Host.

## Flag semantics

| Flag | Values | Phase 1 meaning |
| --- | --- | --- |
| `APP_HOST` | `fastapi`, `ts` | Select legacy rollback topology or the single TypeScript Host |
| `AGENT_RUNTIME` | `legacy`, `pi` | Select legacy product Agent or the Phase 3 formal Pi Task/Run runtime; the default remains legacy |
| `DATASET_CORE` | `python`, `ts` | Select Core implementation; only `python` is valid in Phase 0/1 |
| `PI_EXPERIMENTAL` | `0`, `1` | Disable or expose `/experimental/pi/*` and its experimental WebSocket on the TS Host |

Flags are parsed once at startup. Unknown values or invalid combinations fail before
the public port opens.

## Valid combinations

| Profile | `APP_HOST` | `AGENT_RUNTIME` | `DATASET_CORE` | `PI_EXPERIMENTAL` | Use |
| --- | --- | --- | --- | --- | --- |
| Full legacy rollback | `fastapi` | `legacy` | `python` | `0` | Pre-Host product/debug rollback; does not claim the Phase 1 one-port development topology |
| TS Host proxy-only | `ts` | `legacy` | `python` | `0` | Verify the Host, Vite middleware, legacy HTTP, and legacy WS without Pi |
| Normal Phase 1 transition | `ts` | `legacy` | `python` | `1` | Stable `/api/v1` remains legacy while `/experimental/pi/*` uses Pi and the Python Core bridge |
| Pi-focused experimental smoke | `ts` | `pi` | `python` | `1` | Tests the experimental Pi composition only; it does not promote Pi to the formal product API |
| Phase 3 formal Pi runtime | `ts` | `pi` | `python` | `0` or `1` | New `task_ts_*` Tasks use TS durable runtime; legacy Task/API traffic falls through to FastAPI |

Invalid in Phase 0/1:

- every combination with `DATASET_CORE=ts`;
- `APP_HOST=fastapi` with `PI_EXPERIMENTAL=1` or `AGENT_RUNTIME=pi`;
- any topology that exposes the internal migration bridge or legacy FastAPI as a
  second public browser endpoint while `APP_HOST=ts`.

## Route ownership in the normal Phase 1 transition

| Public route | Host handling | Runtime authority |
| --- | --- | --- |
| `/experimental/pi/*` and experimental WS | Direct TS Host route | Pi adapter/session; live experimental events only |
| `/api/v1/*` | TS Host proxy | Legacy FastAPI and legacy Agent |
| `/api/v1/ws` | TS Host WebSocket proxy | Legacy durable Task event runtime |
| frontend/HMR/static paths | Vite middleware or static handler | TS Host |
| `/internal/migration/*` | Not registered/proxied publicly | Loopback-only Legacy Dataset Core bridge |

When `AGENT_RUNTIME=pi`, the Host instead owns formal Task routes and the public
`/api/v1/ws`. The socket multiplexes TS Task subscriptions locally and forwards
legacy Task subscriptions to private FastAPI. Other `/api/v1/*` routes remain
proxied. See [Phase 3 runtime](phase3-ts-application-runtime.md).

## Rollback surface

Rollback does not migrate or rewrite Task files, EventStore data, Cache, Workspace,
or Publications:

1. set `PI_EXPERIMENTAL=0` and `AGENT_RUNTIME=legacy` to remove the Pi surface while
   retaining the TS Host proxy/Vite entry;
2. if Host behavior is the suspected fault, set `APP_HOST=fastapi` to return to the
   full legacy topology;
3. keep `DATASET_CORE=python` throughout Phase 0/1, so Pi rollback never converts or
   repairs dataset state;
4. dispose active experimental sessions before the flag/profile change is considered
   complete; incomplete staging may be removed by its owner, but immutable artifacts
   and durable state are preserved.

Automated smoke coverage includes one public port, legacy HTTP/WS proxy behavior,
experimental routing, legacy startup failure, cancellation, `Ctrl+C`, and orphan
process checks on both Windows and Linux.
