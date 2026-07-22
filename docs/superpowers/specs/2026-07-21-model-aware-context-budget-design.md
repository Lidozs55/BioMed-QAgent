# Model-Aware Context Budget Design

**Date:** 2026-07-21  
**Status:** Approved for implementation planning  
**Scope:** Agent-loop context accounting, compaction, model settings, and regression coverage

## Goal

Make every Agent model invocation obey an immutable, model-aware context budget while preserving durable conversation summaries and preventing MaxTurns continuations from bypassing compaction.

## Decisions

### Token accounting

The application primarily targets Qwen through DashScope but must continue to support compatible providers.

- Qwen estimation uses the local DashScope tokenizer when available.
- The estimate includes message/content tokens, Chat Completions message-wrapper overhead, Agent instructions, tool schemas, current input, and a conservative structural reserve.
- Streaming update count is never treated as token count. A stream chunk is a transport fragment and may contain zero, one, or multiple tokens.
- DashScope `Tokenization.call(model, messages=...)` remains a diagnostic and explicit live-test tool, not a production hard dependency. Measurements on 2026-07-21 showed it omitted or undercounted Chat Completions wrapper and tool-schema overhead.
- OpenAI-compatible streaming calls must request `stream_options.include_usage=true` where supported. The final usage object is authoritative for post-call calibration; it is not available early enough to protect the current request.
- Actual usage updates a provider/model calibration record for future estimates only. It never mutates the immutable budget snapshot of the active Run.
- Providers without a local tokenizer use the existing conservative estimator plus the configured structural reserve.

The pre-call estimate is deterministic:

```text
estimated_input_tokens =
    content_tokens
    + message_wrapper_tokens
    + instruction_tokens
    + tool_schema_tokens
    + current_input_tokens
    + calibration_margin_tokens
```

Tool schemas and structured message fields are serialized as canonical compact JSON before local tokenization. `safety_reserve_tokens` is not added to this estimate; it is subtracted once from total capacity. This avoids counting the same uncertainty twice.

Calibration is keyed by normalized provider origin and model name. After a successful call, the runtime records `max(0, actual_prompt_tokens - pre_call_estimated_input_tokens)`. The margin used by a new managed Run is the maximum positive residual from the latest 20 successful calls, capped at 10% of the model context window. Calibration is stored atomically beside model settings, contains no prompt content, and is an optimization rather than a correctness dependency: missing or corrupt calibration starts from the conservative static wrapper reserve. The active Run keeps its captured margin unchanged; new values apply only to later managed Runs.

### Model and budget contract

Each managed Run receives an immutable `ContextBudget` snapshot containing:

- `context_window`: total provider input/output context capacity in tokens.
- `max_output_tokens`: maximum generated output reserved for the request.
- `safety_reserve_tokens`: `max(16_384, ceil(context_window * 0.05))` by default.
- `compaction_trigger_ratio`: `0.85` by default.
- `compaction_target_ratio`: `0.60` by default.
- provider/model estimator metadata and the calibration values captured at Run start.

The usable input capacity is:

```text
input_capacity = context_window - max_output_tokens - safety_reserve_tokens
```

Token counts derived from ratios are rounded up to the nearest integer. The configuration boundary requires `context_window > 0`, `max_output_tokens > 0`, `0 <= safety_reserve_ratio <= 0.25`, and `0 < compaction_target_ratio < compaction_trigger_ratio < 1`. It rejects any setting where `input_capacity <= 0`. The active model configuration must carry a positive context window. Known catalog models populate it from versioned metadata. Users may explicitly override the catalog value for compatible deployments that reuse a model ID; the persisted settings record whether the source is `catalog` or `user`. Dynamically discovered models are visible but cannot run until the user explicitly supplies a valid context window.

Catalog resolution preserves the exact documented capacity for each versioned model. Large current-model windows do not justify silently raising genuine smaller entries to a shared minimum.

The output-token field remains output-only. It must be validated against the selected model's context window rather than the current UI's global `131072` maximum.

### Compaction and invocation flow

Every `Runner.run_streamed` invocation passes through the same budget gate, including the first call and every MaxTurns continuation:

1. Build the complete candidate model input, including instructions, tools, retained session items, and current input.
2. Estimate input tokens using the configured estimator and calibration.
3. If the estimate is at or above `input_capacity * compaction_trigger_ratio`, compact before calling the model.
4. Compact to `input_capacity * compaction_target_ratio` by retaining the newest complete Runs plus a durable summary. Re-estimate after each reduction.
5. If the summary itself is too large, shorten it before removing newer complete Runs. Never split a managed Run into an invalid partial exchange.
6. If fixed instructions, tools, current input, and output reserve alone exceed capacity, do not call the provider. Return a typed context-budget error with the measured components and configured limits.
7. Invoke the model only after the candidate input passes the gate.
8. Record authoritative usage after the call and update future calibration data.

The preparation object/session must be refreshed or replaced after compaction. A MaxTurns continuation must not reuse a stale pre-run budget decision or unbounded `result.to_input_list()` history.

The existing append-only raw session and atomic summary/event persistence remain the durability mechanism. The effective session is a view over summary plus retained raw items; raw history is not deleted merely because it is compacted.

### Ambiguous duplicate prompts

When repeated user prompts make raw session-to-managed-Run alignment non-unique:

- Preserve an existing durable summary instead of falling back to the latest 20 raw groups and discarding the effective older context.
- Use the summary's `covered_through_run_id` and summary marker digest as the anchor.
- Group only records after the anchor when ownership can be proven.
- Treat records whose ownership cannot be proven as one indivisible conservative segment for token budgeting and retention.
- Remove only the oldest complete segment if required to meet the target budget.
- Emit a warning describing degraded alignment without claiming that durable history was deleted.

### API and UI

The active settings API and frontend contracts expose:

- model/context metadata;
- output-token limit;
- available input budget derived from the selected model;
- advanced safety reserve and compaction trigger/target ratios.

Known models populate context metadata automatically and permit an explicit override. Unknown models require an explicit positive context-window value before save/run. The UI displays context capacity, metadata source, reserved output, safety reserve, and available input capacity. Advanced ratios are editable only in advanced settings. API validation is authoritative and rejects invalid combinations regardless of UI behavior.

## Testing

The implementation is test-first and must add tests before production changes.

1. Pure token-estimator tests cover Chinese, English, mixed text, message wrappers, tool schemas, calibration, boundary ratios, and inputs that cannot fit even after compaction.
2. Compactor integration tests cover token-based triggering, target-budget retention, summary size reduction, existing-summary reuse, duplicate-prompt anchors, and warning emission.
3. Agent-loop tests prove the budget gate runs before the first SDK call and before each MaxTurns continuation, with a refreshed effective session after compaction.
4. Active API tests cover known-model metadata, unknown-model explicit configuration, invalid output/context combinations, and persisted budget fields.
5. Frontend tests cover budget display, model-dependent output bounds, advanced ratio editing, and rejection state.
6. A marked live test may call DashScope and compare the estimator against authoritative usage. It is excluded from the default suite and must not send repository or user data.

## Non-goals

- Do not count stream chunks as tokens.
- Do not make every production request depend on a second DashScope network call.
- Do not replace the durable append-only session with destructive history rewriting.
- Do not add a generic Responses-API auto-compaction dependency to the Qwen Chat Completions path.
- Do not support unknown models by silently assuming a default context window.
