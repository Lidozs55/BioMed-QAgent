# Gold formal rerun supervisor

`scripts/gold-formal-supervisor.mjs` is the bounded, dependency-free Node
supervisor for a formal Gold rerun. It is an evidence driver only: the
TypeScript Host and Dataset Core remain the owners of task execution,
validation, publication, and artifact registration. It does not import or
modify production family/Core code, discover Gold sources, run a shell, or
print request bodies and credentials.

## Invocation

Create or select the task through the formal `/api/v1` API, then run one case
against the same static Host and frozen product commit:

```text
pnpm gold:supervise -- \
  --base-url http://127.0.0.1:5173 \
  --task-id task_ts_... \
  --request-id gold-rerun-gold1-... \
  --prompt-file path/to/prompt.txt \
  --evidence-dir data/gold/evidence/gold1 \
  --case-label gold1 \
  --expected-commit ff9b2dec1dd5ed064f8f368d4b8924331fae412b
```

`--timeout` is a wall-clock timeout in milliseconds. There is intentionally no
`max_turns` option: the Host owns the agent session and the supervisor waits
until a durable terminal state or the wall-clock timeout. `--page-size` may be
used to exercise/restrict event pages.

## Fail-closed protocol

1. The prompt is read as strict, canonical UTF-8 and any invalid bytes or
   U+FFFD replacement character stops the run before the POST.
2. `/api/v1/health` must report the fixed `ts` Host, `pi` agent runtime, and
   `ts` Dataset Core. The task snapshot must match `task-id`, be an `agent`
   task, and have `active_run_id: null` before a new run is submitted. A
   different active run is never adopted.
3. A new run uses `POST /api/v1/tasks/:task-id/runs` with the supplied request
   id and prompt. The acceptance response supplies the durable `run_id`.
4. Events are fetched with `after_sequence` and a bounded page size. Each
   contiguous page is appended to `events.jsonl`, and the cursor/run identity
   is atomically persisted in `supervisor-state.json`. Restart with `--resume`
   reuses that run and cursor; it never posts a second run.
5. Permission requests are classified without executing anything. Only a
   canonical `fs.read` in the current task workspace (excluding secret-named
   files) and the argument-free, workspace-local fixed parser form
   `node parse*.js` / `node parse*.mjs` are automatically allowed, once.
   Recognized shell-wrapper or subprocess-network bypasses are automatically
   denied once so the same run can recover through governed tools. Malformed,
   secret, external, unknown, and other out-of-policy requests remain
   fail-closed and stop with exit code `20`.
6. Every `kind=data_review` request stops with exit code `21` and writes
   `HIL-STOP.json`. `browser_evidence_acceptance` and
   `publication_acceptance` are treated as data-review stops regardless of
   their surrounding kind. The supervisor never resolves these requests.

After a person resolves the request through the Host, record that decision in
`human-review.jsonl` in the evidence directory (including `request_id`, the
Host-provided `evidence_digest`, `decision`, and optional `reason`), then run
the same command with `--resume`. The decision is read from that explicit
human record and posted to the Host; it is not guessed from the report.

## Terminal and artifact closure

Terminal runs are classified as `succeeded_publication`,
`blocked_no_publication`, or `failed_or_cancelled`. A successful closure must
have a completed run and a publication whose `run_id` matches the supervised
run (the task's `current_publication_id` from a later run is reported as
`blocked_publication_mismatch`). The supervisor then GETs the publication
detail, downloads every listed artifact plus the special `dataset_manifest`
artifact through `/api/v1/publications/:id/artifacts/...`, recalculating byte
size and SHA-256 before writing `artifacts.jsonl` and `closure.json`.

The closure records two different digests:

- `manifest_file_digest` is the SHA-256 of the downloaded
  `dataset_manifest.json` bytes (the publication file receipt).
- `package_digest` is recomputed from the registered non-manifest artifact
  `(relative_path, sha256)` pairs using the Dataset Core manifest algorithm.

A file-size/hash mismatch or package-digest mismatch exits with code `31`; no
successful closure is emitted. Other exit codes are stable and specific:
`10` health, `11` task, `12` active run, `30` terminal failure, `32` timeout,
and `33` protocol/HTTP validation failure. Standard output is a minimal closure
identity only; prompts, response bodies, URLs containing credentials, and
permission arguments are not printed.

## Single-instance requirement

The tasks root (`data/output/tasks/`) admits exactly **one** live Application
Host process at a time. Every Host startup runs `recoverActiveRuns` over the
whole directory and marks every active run that is not in its own memory as
`run_interrupted`; two live instances therefore kill each other's runs, and
concurrent event appends can corrupt `events.jsonl` badly enough that the next
Host startup fails on a sequence-gap parse error. Before starting a Host or
attaching a supervisor, confirm no other instance (dev or `--static`) is
already serving the same data directory, and never run a second instance "just
to be safe" — a restart sweep is guaranteed. See docs/ISSUES.md §运行环境 for
the 2026-08-27 incident and repair notes.

Since `ac2ffaba` the runtime enforces this at startup: every Host claims an
exclusive `.host-lease.json` on the tasks root, and a second **live** instance
fails fast with `HostLeaseHeldError` instead of silently interrupting the
first host's runs. A lease left by a dead process is taken over. Hosts built
before this change write no lease, so during upgrades still verify manually
that no old instance is running.

## Test-prompt methodology (mandatory since 2026-08-29)

Gold reruns evaluate the product, not prompt engineering. Every run must:

1. **Send the real question directly.** Create the task via
   `POST /api/v1/tasks` with the actual research question as the input; that
   auto-launched run IS the evaluated run. Never create a separate bootstrap
   task (the old "Reply with READY" sentinel stays in the session history and
   light models have been observed obeying it at run end — gold7 qwen r1).
   Attach the supervisor with `--adopt`, which journals the already-running
   (or latest) run instead of posting its own.
2. **Use a human-plausible prompt.** The run input describes only the topic,
   direction, and target artifacts — what a researcher would actually type.
   Constraints, execution mechanics (prepare/submit contract details, digest
   rules, error-recovery recipes) belong in the shared system prompt
   (`server/src/agent/phase1-prompt.ts`), never in the user message. Per-case
   requirement notes (e.g. "the crosswalk must carry per-source value columns")
   are legitimate target-artifact descriptions; tool-call instructions are not.

Prompt files used for a run stay in the evidence pack for transparency.
`scripts/gold-formal-supervisor.mjs --adopt` journals events from sequence 0,
so attaching a few seconds after task creation loses nothing.
