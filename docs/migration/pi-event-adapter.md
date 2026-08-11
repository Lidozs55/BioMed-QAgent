# Phase 1 Pi Event Adapter Contract

Pi-native events do not cross the browser boundary. The Pi adapter and
`server/src/agent/event-adapter.ts` normalize them into a bounded,
BioMed-compatible experimental event shape from `@biomed/contracts`.

## Mapping

| Pi source event | Experimental BioMed event | Required handling |
| --- | --- | --- |
| Session/turn starts execution | `run_started` | Use mapped BioMed `task_id` and `run_id`, never the Pi session ID as either |
| Assistant text stream | `assistant_delta` | Preserve text order; apply normal payload bounds |
| Assistant reasoning stream, when exposed | `assistant_reasoning_delta` | Treat as optional capability and sanitize provider-only metadata |
| Tool accepted/starts | `tool_started` | Include BioMed tool name, tool call ID, and bounded arguments when available |
| Tool invocation metadata | `tool_called` | Preserve call identity and operation metadata without secrets |
| Tool returns successfully | `tool_completed` | Return bounded structured/serialized output |
| Tool returns an error | `tool_completed` | Return a bounded typed error summary; if the turn terminates, also emit `run_failed` |
| Cancellation requested | `run_cancel_requested` | Emit when BioMed accepts the request, before upstream acknowledgement |
| Pi and active tools confirm cancellation | `run_cancelled` | Emit only after cancellation is acknowledged/observed |
| Turn fails | `run_failed` | Map to a stable project error category; keep upstream traceback in server logs only |
| Turn completes normally | `run_completed` | Means Agent turn completion, not DatasetBuild or Publication success |

Bridge Tool logs additionally retain `tool_call_id`, tool name, bridge `request_id`,
optional `build_id`, typed exit/error code, and duration. Credentials, raw reasoning,
absolute private paths, and unbounded Core output are never included in browser events.

Unknown Pi events are recorded as bounded debug diagnostics and ignored by the
browser adapter unless a safe mapping exists. They must not be guessed into a
business or terminal event. A terminal Pi event closes the mapped live stream once;
duplicate upstream terminal events are suppressed by tool/run identity.

## Experimental sequence semantics

The Phase 1 experimental event bus may assign a monotonically increasing sequence
within one live experimental Task stream so existing reducers can preserve display
order. That value has exactly this meaning:

```text
experimental sequence = live stream ordering
experimental sequence != durable replay authority
```

It may reset after Host restart, is not appended to the legacy `events.jsonl`, and
does not support the authoritative `after_sequence → replay → realtime` guarantee.
The experimental WebSocket must not advertise successful replay. Gaps or reconnects
are surfaced as a fresh experimental stream/session limitation until durable event
ownership migrates in a later phase.

## Verification fixtures

Fake Pi streams cover assistant text, optional reasoning, tool start/call/result,
typed tool error, normal completion, model failure, cancellation request and
acknowledgement, duplicate terminal input, and unknown input. Snapshots compare the
BioMed event shape and order, including monotonic live sequence, while asserting no
event was written to the authoritative legacy Event Store.
