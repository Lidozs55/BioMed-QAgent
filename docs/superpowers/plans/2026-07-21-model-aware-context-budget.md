# Model-Aware Context Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` task-by-task. Work only in `D:\coding\BioMed-QAgent\.worktrees\fix-model-aware-context-budget` on branch `fix/model-aware-context-budget`. Every behavior follows RED -> GREEN -> REFACTOR. Do not create commits, push, rebase, or merge unless the user separately requests Git operations.

**Goal:** Make every managed Agent model invocation obey one immutable model-aware input budget, including MaxTurns continuations, while preserving durable summaries and exposing authoritative budget configuration through the active API and UI.

**Architecture:** Extend the frozen run settings with a frozen `ContextBudget`. Estimate the complete candidate prompt before every `Runner.run_streamed`, compact the effective session to a token target when necessary, and persist only positive post-call residual calibration for later Runs. Keep the raw session append-only and retain the manager-owned atomic summary/event commit.

**Tech Stack:** Python 3.12, Pydantic v2, OpenAI Agents SDK, FastAPI, optional `dashscope[tokenizer]`, React 19, strict TypeScript, pytest, Vitest.

## Global Constraints

- `safety_reserve_tokens = max(16_384, ceil(context_window * safety_reserve_ratio))`; defaults are safety `0.05`, trigger `0.85`, target `0.60`.
- `input_capacity = context_window - max_output_tokens - safety_reserve_tokens`; reject non-positive capacity.
- Validate `0 <= safety_reserve_ratio <= 0.25` and `0 < target < trigger < 1`.
- Preserve exact versioned catalog windows. Known models use `catalog` unless positively overridden; unknown models cannot run without an explicit positive window.
- Qwen local counting may use `dashscope.get_tokenizer(model).encode` through an optional adapter. Default correctness never depends on that extra or a network/model download.
- The dependency-free fallback returns zero for empty text and otherwise the UTF-8 byte length. Structural overhead is added separately.
- Never call `Tokenization.call` in production, count stream chunks, or identify `o200k_base` as Qwen tokenization.
- Calibration stores no prompt data, keeps the latest 20 positive residuals, uses their maximum capped at 10% of the exact context window, and never mutates the active Run.
- The active settings route is `backend/app/api/settings.py`; do not implement this in inactive `settings_router.py`.
- Keep the two approved pre-existing frontend failures unchanged. All touched tests must pass.

## File Map

**Create**
- `backend/app/model_config/context_budget.py`: frozen budget/config contracts, catalog resolution, derived capacities, typed overflow error.
- `backend/app/model_config/token_estimation.py`: canonical serialization, counter protocol/adapters, structural policy, component estimate.
- `backend/tests/test_context_budget.py`: contract/catalog/boundary tests.
- `backend/tests/test_tokenizer_adapter.py`: optional adapter and fallback tests.
- `backend/tests/test_token_estimation.py`: estimator/calibration tests.
- `backend/tests/live/test_context_budget_estimator_live.py`: marked synthetic DashScope comparison.

**Modify**
- `backend/app/model_config/schemas.py`, `catalog.py`, `__init__.py`: settings fields and exact catalog lookup.
- `backend/app/model_settings.py`: resolved metadata and atomic calibration sibling store.
- `backend/app/agent_loop/model.py`, `context.py`, `agent.py`, `runner.py`: immutable capture, prompt-shape inputs, preflight, usage recording.
- `backend/app/runtime/compaction.py`: token trigger/target, summary shortening, duplicate-anchor recovery.
- `backend/app/api/settings.py`: authoritative request/response and merged-candidate validation.
- `backend/pyproject.toml`, `backend/uv.lock`: optional `qwen-tokenizer` extra only.
- Focused backend tests under `tests/agent_loop`, `tests/runtime`, and `tests/api`.
- `frontend/src/hooks/useAPI.ts`, `frontend/src/components/SettingsPanel.tsx`, and focused frontend tests.
- `docs/ARCHITECTURE.md`, backend/frontend READMEs, and `docs/TODO.md` after acceptance.

## Task 1: Tokenizer Boundary and Immutable Budget

**Interfaces**
```python
class TextTokenCounter(Protocol):
    def count(self, text: str) -> int: ...

@dataclass(frozen=True, slots=True)
class ContextBudget:
    context_window: int
    max_output_tokens: int
    safety_reserve_tokens: int
    trigger_tokens: int
    target_tokens: int
    provider_origin: str
    model_name: str
    tokenizer_kind: Literal["qwen_local", "conservative"]
    calibration_margin_tokens: int
```

- [ ] RED `tests/test_tokenizer_adapter.py`: fallback is selected by default; injected official tokenizer counts locally; missing/unsupported optional support falls back; no HTTP/download occurs.
- [ ] Run `uv run pytest tests/test_tokenizer_adapter.py -q`; expect missing adapter failure.
- [ ] GREEN: implement `DashScopeLocalTokenizerAdapter.try_create`, `ConservativeUtf8TokenCounter`, and optional extra `qwen-tokenizer = ["dashscope[tokenizer]>=1.26.3"]`; leave required dependencies and `requirements.txt` unchanged.
- [ ] RED `tests/test_context_budget.py`: exact 32,768 and 1,000,000 catalog windows, user override precedence, unknown rejection, frozen values, invalid ratios/capacity, and 16,384 reserve floor.
- [ ] GREEN: implement shared budget contract, exact catalog resolution, settings fields, and immutable `RunModelSettings.context_budget`.
- [ ] Run `uv sync` and `uv sync --extra qwen-tokenizer`; expect both dependency resolutions to exit 0 without changing required dependencies.
- [ ] Run `uv run pytest tests/test_tokenizer_adapter.py tests/test_context_budget.py tests/agent_loop/test_run_model_settings.py tests/api/test_model_settings_api.py tests/test_settings_manager.py -q`; expect all adapter, catalog, boundary, snapshot, API, and serialization cases to pass.
- [ ] Run `uv run ruff check app/model_config app/model_settings.py tests/test_tokenizer_adapter.py tests/test_context_budget.py tests/agent_loop/test_run_model_settings.py tests/api/test_model_settings_api.py tests/test_settings_manager.py`; expect exit code 0 with no warnings.

## Task 2: Deterministic Estimate and Calibration

**Interfaces**
```python
@dataclass(frozen=True, slots=True)
class PromptTokenEstimate:
    content_tokens: int
    message_wrapper_tokens: int
    instruction_tokens: int
    tool_schema_tokens: int
    current_input_tokens: int
    calibration_margin_tokens: int

    @property
    def total(self) -> int: ...
```

- [ ] RED `tests/test_token_estimation.py`: injected counters determine Chinese/English/mixed counts; canonical compact sorted JSON is stable; components remain observable; fallback equals UTF-8 bytes; safety reserve is not included.
- [ ] RED API/store tests: normalized provider/model key, latest 20 positive residuals, maximum capped at 10%, corrupt/missing file fallback, no prompt data, immutable captured margin.
- [ ] Run focused tests and confirm expected failures.
- [ ] GREEN: implement canonical prompt representation and versioned Chat Completions wrapper/tool overhead policy. Reuse the exact instructions/tools used to build the Agent.
- [ ] GREEN: atomically persist `calibration.json` beside settings via the existing replace/fsync pattern and lock.
- [ ] Run `uv run pytest tests/test_token_estimation.py tests/test_tokenizer_adapter.py tests/test_context_budget.py tests/api/test_model_settings_api.py -q`; expect all deterministic component, fallback, canonical serialization, calibration, and immutable-capture cases to pass.
- [ ] Run `uv run ruff check app/model_config/token_estimation.py app/model_settings.py app/agent_loop/agent.py tests/test_token_estimation.py tests/test_tokenizer_adapter.py tests/test_context_budget.py tests/api/test_model_settings_api.py`; expect exit code 0 with no warnings.

## Task 3: Token-Targeted Compaction

**Interface**
```python
@dataclass(frozen=True, slots=True)
class CompactionPreparation:
    session: Session
    agent_input: str | list[TResponseInputItem]
    estimate: PromptTokenEstimate
    compacted: bool = False
    degraded_alignment: bool = False
```

- [ ] RED `tests/runtime/test_compaction.py`: below trigger is unchanged; equality compacts; repeated estimation reaches target; newest complete Runs remain whole; summary shortens before newer Runs are removed; fixed prompt overflow raises typed error before provider/summarizer call.
- [ ] RED duplicate-prompt tests: valid existing summary marker/digest remains effective; ambiguous post-anchor items form one conservative segment; warning `compaction_alignment_degraded` is emitted; corrupt markers retain `compaction_failed` behavior.
- [ ] GREEN: replace character/run-count decisions with estimated tokens; validate the summary anchor before aligning suffix; shorten summary with one bounded summarizer request, then evict oldest complete segments only.
- [ ] Preserve cancellation, atomic commit, append-only raw session, delegated writes, and truncated-summary hard failure.
- [ ] Run `uv run pytest tests/runtime/test_compaction.py tests/contracts/test_runtime_contracts.py -q`; expect every compaction, duplicate-anchor, cancellation, durability, and truncation case to pass.
- [ ] Run `uv run ruff check app/runtime/compaction.py tests/runtime/test_compaction.py tests/contracts/test_runtime_contracts.py`; expect exit code 0 with no warnings.

## Task 4: Gate Every SDK Invocation

- [ ] RED first-call test: complete candidate preflight occurs before `Runner.run_streamed`; overflow yields typed failure and zero SDK calls.
- [ ] RED MaxTurns tests: every continuation re-runs preflight with `result.to_input_list()` and uses the refreshed bounded session/input.
- [ ] RED retry/cancellation tests: every loop iteration, including Qwen malformed-argument retry, gates again; cancellation after preparation makes zero provider calls.
- [ ] GREEN: move `ConversationCompactor.prepare` inside the runner loop immediately before each SDK invocation, passing the same immutable budget but replacing session/input with preparation output.
- [ ] Characterize the installed SDK public usage object in a test, then record positive authoritative input usage after successful calls for future Runs only. Unsupported usage remains a no-calibration path.
- [ ] Run `uv run pytest tests/agent_loop/test_execution.py tests/agent_loop/test_max_turns_continue.py tests/agent_loop/test_qwen_function_args_retry.py tests/agent_loop/test_run_model_settings.py -q`; expect all first-call, continuation, retry, cancellation, and immutable-settings cases to pass.
- [ ] Run `uv run ruff check app/agent_loop/runner.py app/agent_loop/model.py app/agent_loop/context.py tests/agent_loop/test_execution.py tests/agent_loop/test_max_turns_continue.py tests/agent_loop/test_qwen_function_args_retry.py tests/agent_loop/test_run_model_settings.py`; expect exit code 0 with no warnings.

## Task 5: Active Settings API

- [ ] RED API tests: GET returns context window/source, output, safety ratio/tokens, trigger/target, and available input; PUT resolves known catalog values, persists overrides, rejects unknown-without-window and invalid merged combinations without modifying storage.
- [ ] RED model preview: known IDs expose catalog metadata; unknown discovered IDs remain visible with `context_window=0` and cannot become active until configured.
- [ ] GREEN only in active `api/settings.py` and `ModelSettingsStore.update`; validate the complete merged candidate before write/cache publication.
- [ ] Run `uv run pytest tests/api/test_model_settings_api.py tests/api/test_model_preview_security.py tests/runtime/test_manager.py -q`; expect settings round trips, unknown-model preview, invalid merged candidate/no-write, and manager integration cases to pass.
- [ ] Run `uv run ruff check app/api/settings.py app/model_settings.py tests/api/test_model_settings_api.py tests/api/test_model_preview_security.py tests/runtime/test_manager.py`; expect exit code 0 with no warnings.

## Task 6: Strict Frontend Controls

- [ ] Load the project `shadcn` and `frontend` skills before editing; reuse current controls and add no dependency.
- [ ] RED API type tests for exact backend fields and dirty-field request bodies.
- [ ] RED settings UI tests: exact capacity/source/output/safety/available input display; model-bound output; explicit unknown-model window; invalid combinations disable save; advanced ratio editing; backend 422 preserves saved state.
- [ ] GREEN `useAPI.ts` and `SettingsPanel.tsx`; integer helpers mirror backend `ceil`, while backend remains authoritative.
- [ ] Run `pnpm test -- src/test/api.test.ts src/test/settings-panel.test.tsx src/test/app.test.tsx`; expect all touched API/settings/startup tests to pass.
- [ ] Run `pnpm test`; expect no new failures. The only allowed baseline failures are the test in `src/components/ConversationStep.test.tsx` that expects warning code `partial_results`, and the test in `src/test/chat-panel.test.tsx` that expects a failed-run marker with role `alert`; their failure classes must remain unchanged.
- [ ] Run `pnpm lint`, `pnpm tsc`, and `pnpm build`; expect each command to exit 0. The existing Vite chunk-size warning is allowed; TypeScript and ESLint warnings/errors are not.

## Task 7: Marked Live Comparison

- [ ] RED/collect-only: run `uv run pytest tests/live/test_context_budget_estimator_live.py --collect-only -q`; expect the marked test to collect without a network call and remain excluded from plain `uv run pytest -q`.
- [ ] Use fixed synthetic bilingual messages and minimal synthetic tools with final `include_usage` prompt count.
- [ ] With optional extra, assert `qwen_local`; without it or on unsupported models, assert conservative byte-plus-structure formula. Optional absence is not failure.
- [ ] Run `uv run pytest -m live tests/live/test_context_budget_estimator_live.py -v`; with `DASHSCOPE_API_KEY`, expect the conservative path and calibration assertions to pass. Without the key, expect one explicit credential-based skip before any request.
- [ ] Run `uv run --extra qwen-tokenizer pytest -m live tests/live/test_context_budget_estimator_live.py -v`; with the key and a supported model, expect the local-Qwen path and calibration assertions to pass. If the optional tokenizer does not support that model, expect the conservative-path assertion to pass; without the key, expect the same explicit skip.

## Task 8: Documentation and Acceptance

- [ ] Document immutable capture, 16,384 reserve floor, exact catalog windows, explicit unknown models, estimate components, calibration, every-call gate, duplicate anchors, and append-only durability.
- [ ] Document optional `uv sync --extra qwen-tokenizer`, conservative default, and live commands; explicitly state `o200k_base` is not used as Qwen tokenization.
- [ ] Mark TASK-024..027 complete only after acceptance tests pass and synchronize Commonly.
- [ ] From `backend/`, run `uv run pytest tests/test_tokenizer_adapter.py tests/test_context_budget.py tests/test_token_estimation.py tests/runtime/test_compaction.py tests/agent_loop/test_run_model_settings.py tests/agent_loop/test_max_turns_continue.py tests/agent_loop/test_execution.py tests/api/test_model_settings_api.py -q`; expect all focused tests to pass.
- [ ] From `backend/`, run `uv run pytest -q`, `uv run ruff check app/ tests/ launcher.py`, and `uv run python -m compileall -q app tests launcher.py`; expect all three commands to exit 0 with live tests deselected.
- [ ] From `backend/`, start `uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`; request `GET http://127.0.0.1:8000/api/v1/health`; expect HTTP 200 and `{"status":"ok"}`, then stop the server cleanly.
- [ ] From `frontend/`, run `pnpm test -- src/test/api.test.ts src/test/settings-panel.test.tsx src/test/app.test.tsx`; expect all touched tests to pass. Run `pnpm test`; expect only the two named baseline failures, if they still exist. Run `pnpm lint`, `pnpm tsc`, and `pnpm build`; expect exit code 0 for each.
- [ ] Start backend on `127.0.0.1:8000` and frontend with `pnpm dev --host 127.0.0.1 --port 5173`. With Playwright at `1440x900`, open Settings -> Model, select a catalog model, and verify exact context/source/output/safety/available-input values, model-bound output control, advanced ratios, successful save/reload, and no overlap or console error.
- [ ] With Playwright at `390x844`, repeat Settings -> Model for an unknown model: enter a positive context override, verify invalid output/ratio combinations prevent save and show the backend rejection, correct them, save, reopen, and verify persistence without clipped or overlapping controls.
- [ ] Run diagnostics on every changed source file and review every diff against the approved spec.

## Execution Order

1. Baseline capture, tokenizer adapter/fallback, immutable budget.
2. Estimator and calibration.
3. Compactor and duplicate-summary recovery.
4. Every-invocation/MaxTurns gate.
5. Active API.
6. Frontend controls.
7. Live test and documentation.

After Task 1 freezes public field names, frontend RED tests may run in parallel with estimator work. Compactor work may run in parallel with API RED tests, but Task 4 depends on Tasks 2 and 3. Only one worker owns each shared file.

## Acceptance

- Every `Runner.run_streamed` call is immediately preceded by a budget gate.
- The 16,384 floor and exact catalog windows survive resolution unchanged.
- Unknown models cannot run without explicit context.
- MaxTurns uses refreshed bounded input/session.
- Duplicate prompts preserve a valid durable summary.
- Calibration stores no prompt data and raw history remains append-only.
- Default installation uses deterministic conservative estimation; optional installation uses local `dashscope.get_tokenizer(model).encode` without production network calls.
- All new/focused tests pass; backend full suite is clean; frontend adds no failures beyond the two recorded baseline failures; lint/type/build/startup/manual UI checks pass.
