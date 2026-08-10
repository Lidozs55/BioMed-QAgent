# Model Provider Parameters & Verified Facts

> Reference for the per-provider parameter profiles and model catalog data.
> Code lives in `backend/app/model_registry/profiles.py` (parameter profiles)
> and `backend/app/model_info/` (vendor presets + model catalog). Facts below
> were verified against official docs on 2026-08-10.

## How the pieces fit

- `GET /api/v1/vendors` serves quick-fill presets from
  `app/model_info/vendors.py` — frontend has no hardcoded vendor list.
- Parameter specs served per provider come from `profiles.py`
  (`PROFILE_PROVIDER_SPECS`), with `FALLBACK_PARAM_SPECS` as the catch-all
  ("所有参数均可选择、多余参数不报错").
- Provider `/v1/models` discovery returns only `id` (+`owned_by`). Context
  window / max output / capabilities are enriched from the local model
  catalog (`app/model_info/providers/*`), not from the upstream response.

## Verified parameter facts (2026-08-10)

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

- `ModelDetail.max_output_tokens` is the hard upper bound;
  `suggested_max_tokens` is the UI default (often more conservative).
- Discovery enrichment always consults the local catalog first
  (`get_known_model`), so registering a model here also fixes its discovered
  metadata without relying on `guess_context_window` heuristics.
