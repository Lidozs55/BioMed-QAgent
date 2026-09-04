# ADR-037: Durable Build API and independent state machine

## Status

Superseded by ADR-041 - 2026-08-27. The API and state machine described below
were removed without compatibility.

## Context

The existing `/api/v1/builds` surface discovers completed Dataset Core output by
scanning manifests. It cannot represent a queued or running build, survive a Host
restart as an independently recoverable object, or acknowledge cancellation before
a terminal outcome exists. A Pi tool call or Run lifecycle is also too short-lived to
own a multi-gigabyte DatasetBuild.

`BuildResult` already defines the business terminal outcomes `succeeded`,
`partial_success`, `no_data`, and `spec_rejected`. Adding scheduler states to that
union would conflate execution state with the scientific publication outcome. Using
Run completion, error text, or artifact count as a substitute would violate the
Task/Run/Build identity boundary in ADR-019.

## Decision

1. `@biomed/contracts` defines versioned start/get/cancel DTOs and a separate
   `DurableBuildRecord`. Start is `POST /api/v1/builds`, get is
   `GET /api/v1/builds/{build_id}`, and cancel is
   `POST /api/v1/builds/{build_id}/cancel`. The existing list/detail/artifact DTOs
   remain compatible while TASK-C3I wires the new asynchronous behavior.
2. Start requires `idempotency_key`, `task_id`, `run_id`, and the self-contained
   `DatasetBuildSpec`. The key is scoped to the start endpoint. The scheduler computes
   `request_digest` over canonical JSON containing the complete versioned request
   except the idempotency key. Reusing a key with the same task/run/build identity and
   digest returns the same Build with `idempotent_replay=true`; any mismatch returns
   structured `idempotency_key_reused` and does not create another Build.
3. Build status is independent from `RunStatus` and follows only these edges:

   ```text
   queued -> running | cancel_requested | spec_rejected | failed
   running -> cancel_requested | succeeded | partial_success | no_data |
              spec_rejected | failed
   cancel_requested -> cancelled | failed
   terminal -> no transitions
   ```

   Lease expiry/recovery changes `attempt` and emits `build_recovered`; it does not
   invent another lifecycle state or another Build ID.
4. Business terminal states carry a matching existing `BuildResult`. `failed` carries
   a structured `DurableBuildFailure`; `cancelled` carries cancellation metadata.
   Nonterminal states carry no terminal result. A terminal Run does not terminate a
   Build, and a terminal Build does not rewrite its Run.
5. Every Build record preserves exact `task_id`, `run_id`, and `build_id` plus durable
   event references. Build lifecycle events carry explicit `build_id` on the task
   event envelope: `build_queued`, `build_started`, `build_recovered`,
   `build_cancel_requested`, `build_completed`, `build_failed`, and
   `build_cancelled`.
6. Cancel acknowledgement is idempotent and structured. `accepted` and
   `already_requested` report the nonterminal Build status and cancel-request event;
   `already_terminal` reports the authoritative terminal status/event. A cancel HTTP
   acknowledgement does not itself mean `cancelled`.
7. API and frontend consumers branch only on typed status, disposition, result, and
   error-code fields. Human-readable `message`, `reason`, and `BuildResult.user_summary`
   are display text and never state-machine inputs.
8. TASK-C3C provides contracts, wire parsers, tests, and a server re-export only.
   Scheduler persistence, leases, restart scanning, Core execution, route wiring, and
   Pi continuation remain A-owned TASK-C3I.

## Consequences

- TASK-C3I can persist/recover a Build independently from a model session or Run while
  reusing the existing `DatasetBuildSpec` and `BuildResult` contracts.
- Clients can render queued, running, cancelling, failed, cancelled, and business
  terminal states without parsing error strings or counting artifacts.
- Event replay has explicit Task/Run/Build correlation and can wake a continuation on
  the Build terminal event without treating Run terminal state as Build evidence.
- The existing completed-build product API remains migration-compatible until the
  scheduler implementation replaces manifest scanning as the authoritative Build
  record source.
