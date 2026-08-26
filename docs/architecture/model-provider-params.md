# Model Provider Parameters & Verified Facts

> Reference for the per-provider parameter profiles and model catalog data.
> Current implementation (TypeScript): `server/src/settings/model-registry/` and
> `packages/contracts/src/model-registry.ts`; the legacy `backend/` paths were
> removed in Phase 8. Facts below were verified against official docs on 2026-08-24.

## Model catalog maintenance (verified 2026-08-24)

- The **single source of truth** for model metadata (context window, max
  output, suggested output, capabilities) is now TypeScript:
  `server/src/settings/model-registry/model-catalog.ts` (verified model facts)
  plus `server/src/settings/model-registry/catalog.ts` (provider/model parameter
  profiles). `packages/contracts/src/model-registry.ts` only carries transport
  shapes. The legacy `backend/app/model_info/providers/*.py` was removed in
  Phase 8; the facts were restored and re-checked against the CC Switch local
  presets and official vendor pages on 2026-08-24, including
  `deepseek-v4-pro-0813`, `ZHIPU/GLM-5.3`, `qwen3.8-27b` and
  `qwen3.8-2.4t-a95b`.
- The Python generated mirrors (`catalog_qwen.py`, `catalog_compatible.py`)
  and `backend/scripts/regenerate_model_info.py` were removed with
  `backend/` in Phase 8. The TS catalog is source-controlled directly:
  update `server/src/settings/model-registry/model-catalog.ts` and
  `catalog.ts` instead of regenerating from legacy Python files.

## How the pieces fit

- Vendor presets and quick-fill defaults come from
  `server/src/settings/model-registry/catalog.ts`; the API surface is
  `server/src/settings/model-registry/routes.ts` (`/api/v1/model-registry/*`).
- Parameter specs are part of the provider/model shapes in
  `packages/contracts/src/model-registry.ts`; runtime resolution (active
  provider/model, context window, base URL, API key) is in
  `server/src/settings/model-registry/model-resolution.ts`.
- Provider `/v1/models` discovery returns only `id` (+`owned_by`); context
  window / max output / capabilities are enriched from `model-catalog.ts`.
  Unknown ids return `context_window: null` and the UI shows “未知” instead of
  inventing a number; `guessContextWindow` is not used by discovery.
- Durable model rows carry `metadata_source` (`catalog`/`api`/`user`).
  On startup, catalog- and API-sourced rows whose ids appear in the local
  catalog are refreshed; rows explicitly edited by the user (`user`, including
  all `manual` rows) are never overwritten.
- The model list editor allows editing the context window of **any** model,
  including API/catalog-sourced ones (`PUT /model-registry/models/{id}` with
  `context_window`; empty string on the client clears it to `null` = 未知).
  The edit marks the row `metadata_source: user` so catalog refresh skips it,
  and when the edited model is the active one the runtime
  `settings.context_window` is synced immediately (same rule as the startup
  catalog sync), so the Pi session and the context-budget UI follow at once.

## Active model selection

- `active` on a maintained model is the authoritative current-model flag;
  `settings.model_name` is a runtime mirror, not a selector identity.
- When the first maintained model is created and no model is active yet,
  the service automatically activates it so the workspace model selector is
  immediately usable. Once a model is active, adding more models never
  changes the current selection.
- Deleting the active model or its provider clears the mirrored runtime
  settings, and `resolveActiveModel` refuses an empty model identity.

## Model-level parameter profiles (2026-08-24)

- `catalog.ts` carries provider parameter profiles plus model-level overrides
  so each known model exposes the parameters it actually supports per official
  docs. Examples: `glm-5.3` uses `reasoning_effort`/`thinking`; `kimi-k3`
  uses `reasoning_effort`/`tool_choice`; `grok-4.5` always reasons and only
  adjusts effort; `deepseek-v4` exposes thinking/reasoning effort.
- DashScope families are covered by `MODEL_PARAM_PREFIXES` (longest-prefix
  match, plus keyword rules for non-chat models): Qwen3.8 uses
  `reasoning_effort` (`low/medium/xhigh`, default `xhigh`, mutually exclusive
  with `thinking_budget`), Qwen3.7/3.6/3.5 use `enable_thinking` +
  `thinking_budget` (caps 256K/128K), Qwen3-VL adds `presence_penalty` /
  `do_sample` / `seed`, image models (`qwen-image-*`, `wan*`) expose
  `size`/`n`/`negative_prompt`/`prompt_extend`/`watermark`, embeddings expose
  `dimension`, and ASR/music models expose no chat parameters at all.
- Precedence in `paramSpecsFor(providerId, modelId)`: model override →
  provider profile → generic fallback.
- Discovery and managed-model responses re-attach current specs from
  `catalog.ts`, so imported models never rely on stale import-time snapshots.
- The graphical editor shows main parameters and collapses the advanced
  section; the JSON config view serializes **every** supported parameter
  (spec defaults + current values), so it opens non-empty even when stored
  `params` is empty.
- Saved `params` are carried through `BioMedModelConfig.params` and merged into
  the Pi/OpenAI-compatible request payload by `applyModelProfileToPayload`.
  Portable fields (`max_tokens`/`temperature`/`top_p`) remain controlled by the
  active runtime settings; provider-specific fields like `reasoning_effort`,
  `tool_choice` and `thinking` are forwarded. `thinking` is normalized from a
  JSON string (the registry/editor representation) to an object before the
  request, and `top_logprobs` is omitted unless `logprobs` is true — both are
  required to avoid OpenAI-compatible providers (e.g. DeepSeek) returning 400.

## Verified parameter facts (2026-08-24)

### 智谱 GLM (`docs.bigmodel.cn/cn/guide/start/concept-param`)

- `do_sample` boolean, default `true`.
- `thinking` is an **object** (`{"type":"enabled"}` default /
  `{"type":"disabled"}`), GLM-4.5+ only. Profile exposes it as a JSON string
  so the graphical and JSON views stay consistent (no object type exists in
  `ParameterSpec`).
- `reasoning_effort` is GLM-5.2+ only: `max/xhigh/high/medium/low/minimal/none`,
  default `max`; `low/medium` map to `high`, `xhigh` maps to `max`,
  `none/minimal` disable thinking.
- `max_tokens` defaults/maxima: GLM-5.2/5.1/5/5-turbo/5v-turbo/4.7/4.6 →
  65536/131072; GLM-4.6v/4.6v-flash/flashx → 16384/32768; GLM-4.5 series →
  65536/98304; glm-4-flash-250414 → 32768/32768; glm-4v-flash → 1024/1024;
  glm-4-plus/air/flash → dynamic, max 4095.
- `stream` boolean, default `false`.

### 月之暗面 Kimi (`platform.kimi.com/docs/api/models-overview`)

- `kimi-k3`: 1M context; `reasoning_effort` `low/high/max` (default `max`);
  `tool_choice` auto/none/required; temperature fixed 1.0, top_p fixed 0.95,
  n fixed 1, presence/frequency fixed 0 — passing other values errors.
- `kimi-k2.6` / `kimi-k2.7-code`: 256K context; `thinking` object only
  (k2.7-code only accepts `{"type":"enabled","keep":"all"}`); `tool_choice`
  does **not** support `required`; temperature fixed (thinking 1.0 / non
  thinking 0.6, k2.7 1.0).

### OpenAI / DeepSeek

- `presence_penalty` / `frequency_penalty` range is **-2 .. 2** for both
  (previously mislabeled 0..2).
- DeepSeek `temperature` 0..2, `top_p` 0..1, `logprobs` bool,
  `top_logprobs` 0..20.

### Groq (`api.groq.com/openai/v1`)

- OpenAI-compatible; `llama-4-scout-17b-16e-instruct` → 131072 context /
  8192 max output; Llama 3.3 70B versatile → 131072 / 32768.
- temperature 0..2, penalties -2..2; newer docs suggest
  `max_completion_tokens` over `max_tokens`.

### xAI (`api.x.ai/v1`)

- `grok-4.5`: 500K context, ~128K max output, $2/$6 per 1M in/out.
- Always reasons (not disableable); `reasoning_effort` low/medium/high,
  default high.
- `presence_penalty` / `frequency_penalty` / `stop` error when combined with
  the reasoning model.

### Mistral (`api.mistral.ai/v1`)

- OpenAI-compatible; `mistral-large-latest` → 262144 context / 16384 max
  output (sending context-sized `max_tokens` can 422).
- Extra params: `random_seed`, `safe_prompt`.

## Model catalog conventions

- `ModelCatalogEntry.max_output_tokens` is the hard upper bound;
  `suggested_max_tokens` is the UI default (often more conservative).
- Discovery enrichment consults `lookupModelCatalog` first, so registering a
  model in `model-catalog.ts` fixes its discovered metadata without relying on
  `guessContextWindow` heuristics.
