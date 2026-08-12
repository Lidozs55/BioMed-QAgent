# Phase 1 Legacy Dataset Core Bridge Contract

This contract defines the temporary TypeScript-to-Python boundary required by
[ADR-022](../adr/022-phase1-legacy-core-bridge.md). It reaches the Python V2
Dataset Core, not the retired V1 PipelineRunner or an OpenAI Agents SDK wrapper.

## Transport boundary

- The preferred Phase 1 transport is HTTP on a private loopback address managed by
  the TypeScript Host. The legacy server binds `127.0.0.1` or `::1`, never a wildcard
  or externally routable interface.
- The Host sends versioned envelopes to an internal migration endpoint. The public
  router and proxy must reject `/internal/migration/*`; the browser cannot call or
  discover this surface through the Host.
- `server/src/legacy/dataset-core-client.ts` is the only TypeScript transport client.
  Pi tools depend on its BioMed-owned interface rather than URLs or Python types.
- A later JSONL subprocess transport is allowed only behind the same client and must
  preserve this envelope, errors, cancellation, and path policy.

## Request and response envelope

Every operation uses this request shape:

```json
{
  "version": 1,
  "request_id": "req_01...",
  "task_id": "task_01...",
  "run_id": "run_01...",
  "op": "validate_dataset_build_spec",
  "args": {}
}
```

`version` is the integer protocol version. `request_id` identifies this bridge
attempt for logs and cancellation. `task_id` and `run_id` are BioMed identities,
not a Pi session ID. `op` is one of the three names below; unknown values are
`invalid_input`. `args` is validated against the selected operation before Core
code runs.

A successful operation returns:

```json
{
  "version": 1,
  "request_id": "req_01...",
  "ok": true,
  "data": {},
  "error": null
}
```

A typed failure or non-success domain outcome returns:

```json
{
  "version": 1,
  "request_id": "req_01...",
  "ok": false,
  "data": null,
  "error": {
    "code": "spec_rejected",
    "message": "DatasetBuildSpec was rejected",
    "retryable": false,
    "details": {
      "reason_codes": ["unknown_schema"]
    }
  }
}
```

`message` is safe for logs/UI and must not contain credentials, absolute private
paths, tracebacks, or raw source rows. `details` is a bounded operation-specific
object. The client rejects a mismatched `version` or `request_id` as
`bridge_unavailable` rather than guessing.

## Named operations

| Operation | Required `args` | Successful `data` | Authority |
| --- | --- | --- | --- |
| `validate_dataset_build_spec` | `spec` using the frozen DatasetBuildSpec wire DTO | `valid`, `reason_codes`, and bounded `reasons` | Python SpecValidator |
| `execute_dataset_build` | `spec`, task-relative `source_files`, and optional task-relative `mapping_files` | stable `build_result`, optional `publication_id`, and manifest/artifact references | Python DatasetBuildExecutor, Validation, and Publisher |
| `get_build_result` | `build_id` | stable `build_result`, optional validation/publication summary, and manifest/artifact references | Python build repository/service |

The bridge accepts logical IDs and task-relative source references only. It never
returns a writable absolute artifact path. Artifact references are read/download
identifiers governed by the existing API and manifest contracts.

## Error taxonomy

| Code | Meaning | Retryable default | Required details |
| --- | --- | ---: | --- |
| `invalid_input` | Envelope, operation, or arguments fail structural validation | no | field/reason codes without echoing secrets |
| `spec_rejected` | SpecValidator rejected a syntactically valid spec | no | validator `reason_codes` and bounded reasons |
| `no_data` | Core completed with the `NO_DATA` business outcome | no | stable BuildResult fields and failed/empty source summary |
| `partial_success` | Core completed with `PARTIAL_SUCCESS` rather than full success | no | stable BuildResult fields and failed source summary; publication reference when eligible |
| `core_execution_error` | Core failed unexpectedly after accepting the request | policy-dependent | stable internal error ID; no traceback on the wire |
| `bridge_unavailable` | Client cannot connect, protocol version mismatches, or response integrity fails | yes | bounded transport category |
| `cancelled` | Core acknowledged cancellation and the request did not complete normally | no | cancellation source and any terminal build status available |

Domain outcomes remain domain outcomes even though the bridge expresses non-full
success through the error union. They must not be rewritten as generic exceptions
or successful prose. HTTP status alone is never the typed result contract.

## Cancellation

The user cancellation chain is:

```text
BioMed Run cancellation
→ Pi session abort
→ active Pi Tool AbortSignal
→ dataset-core-client cancellation
→ legacy request cancellation by request_id
→ Python Core cooperative cancellation
```

For the HTTP transport, the Host calls the loopback-only cancellation side-channel
`POST /internal/migration/pi/dataset/requests/{request_id}/cancel`. This control
route is not a fourth dataset operation and is also never browser-proxied. The
original request returns `cancelled` only after the legacy service acknowledges the
request or observes a Core terminal cancellation. A dropped socket is not proof of
cancellation. If an operation cannot respond promptly, its limitation must be named
in test evidence and the Host must continue cleanup; it must not emit a false
`run_cancelled` or successful Tool completion.

## Prohibited capabilities

The request schema has no operation or argument for:

- arbitrary Python execution;
- arbitrary SQL execution;
- shell execution;
- absolute or arbitrary path writes;
- direct writes or edits to `artifacts/`, `state/`, or logs;
- selecting a Validation Profile or publication threshold outside the validated
  DatasetBuildSpec contract.

The service rejects extra operation-specific fields. Publication is performed only
inside the V2 Core after its validation gate. Parity tests compare stable business
fields from the legacy FunctionTool path and bridge path for the same fixtures.
