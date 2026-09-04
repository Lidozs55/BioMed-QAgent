# Model Info Update & Context Fallback (2026-08-04)

**Date:** 2026-08-04
**Status:** Implemented
**Scope:** Model-info warehouse data refresh, model-switch context handling, unknown-model context fallback

## Problem

- When a user switches to a model that is missing from the model catalog, the
  model preview returned `context_window=0` and the settings UI therefore did
  not auto-adjust the context window to the model's maximum (the initial value
  feature was skipped).
- Budget resolution raised `a positive context window is required` for
  unregistered models without a user override, blocking settings saves, run
  admission, and import admission.
- Qwen3.8-Max was released 2026-08-02/03 (Alibaba) but was absent from both
  the runtime catalog and the model-info warehouse.

## Decisions

### 1. Model-info warehouse is authoritative

- `get_known_model()` now checks the legacy `model_config` catalog first and
  then falls back to the `model_info` warehouse (`get_repository().get_model()`),
  converting `ModelDetail` into the legacy `QwenModelEntry` shape. Every model
  registered in the warehouse therefore resolves its exact context window,
  capabilities, and suggested output without duplicating metadata.
- This removes the need to mirror every provider entry into `model_config`.

### 2. Unknown-model context fallback (guess, then 512K)

- `guess_context_window(model_id)` infers a window from naming conventions
  (e.g. `*max*`/`*1m*` -> 1M, `*128k*` -> 128K, VL/omni -> 128K).
- When no pattern matches, `DEFAULT_GUESS_CONTEXT_WINDOW = 524_288` (512K) is
  used.
- `resolve_context_budget()` no longer raises for a missing window: explicit
  override > catalog/warehouse > guess > 512K default.
- Task feasibility depends on remaining input capacity, not on whether the
  context window was explicitly configured.

### 3. Model preview returns the guessed window

- `/api/v1/models` preview entries for unknown models now return
  `context_window = guess_context_window(model_id)` instead of `0`, so the
  settings page auto-sets the context initial value to the model's maximum
  (the existing frontend auto-save fires whenever `context_window > 0`).

### 4. Data refresh (settings-page vendors)

- DashScope: added `qwen3.8-max` (1M window, 64K max output, image+video
  capabilities, knowledge cutoff 2026-08). Sources: Alibaba news release and
  QbitAI coverage of the 2026-08-03 Qwen3.8 release.
- ZhipuAI: corrected `glm-5.2` to 1M/128K and added current GLM entries
  (glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4-long, glm-4-flash-250414,
  glm-5v-turbo, glm-4.6v, glm-4v-flash) per the official model overview.
- OpenAI: updated `gpt-5.6` to 1M/128K (2026-02 cutoff) and added the
  gpt-5.6-luna/terra/sol family per OpenAI's GPT-5.6 announcement.

## Behavior change for unknown models

- Previously: unknown model without an explicit window was visible but not
  runnable (`context_window=0`, `context_window_source="unknown"`, `run_ready=False`).
- Now: unknown model resolves `context_window=524_288` (or a name-based guess),
  `context_window_source="inferred"`, `run_ready=True`.
- The persisted `context_window` remains `None` unless the user/frontend
  explicitly saves a value; the guess applies at budget-resolution time.

## Verification

- Backend: full `pytest` suite (one pre-existing flaky timing test in
  `tests/runtime/test_fixture_executor.py` is unrelated and passes on rerun).
- `ruff check app/ tests/ launcher.py` clean.
- Frontend `pnpm lint`, `pnpm tsc`, `pnpm build` clean (no frontend code
  change needed; the existing auto-save now receives guessed windows).
