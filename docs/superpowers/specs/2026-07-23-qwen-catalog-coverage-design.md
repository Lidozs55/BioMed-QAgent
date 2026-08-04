# Qwen Catalog Coverage Design

## Goal

Expand the built-in Qwen catalog with every current official Model Studio or
DashScope Qwen, QwQ, multimodal, and audio model that is documented for the
OpenAI-compatible endpoint and has an exact published context window and
maximum output value.

## Source Policy

- Catalog entries come only from current official Alibaba Cloud Model Studio or
  DashScope documentation.
- Each entry uses the exact published model ID. There is no prefix, family, or
  provider-name inference.
- An ID without published context-window and output-limit data stays outside
  the runnable static catalog. Users can still configure it with an explicit
  positive context window.
- The catalog remains static at runtime. It performs no provider metadata
  discovery or network request while resolving a budget.

## Data Contract

Each `QwenModelEntry` keeps the existing contract:

- `id`: exact provider model ID.
- `context_window`: exact published input context limit.
- `suggested_max_tokens`: exact published output limit or documented default
  when the provider documentation identifies it as such.
- `capabilities`: explicit text, image, video, and audio support.

`resolve_context_budget()` continues to use the user's configured `max_tokens`
for an active Run. `suggested_max_tokens` is catalog guidance and does not
silently replace a user setting.

## Delivery Batches

The catalog is extended through small independent commits:

1. Text and reasoning models: Qwen and QwQ IDs usable as text chat models.
2. Vision and omni models: image, video, and multimodal capability entries.
3. Audio models: audio-capable entries.

Each batch includes only the entries confirmed by the official source sweep at
that time. Existing exact entries are corrected only when current official
documentation contradicts their stored metadata.

## Verification

- One focused table-driven regression set resolves representative exact IDs
  from each delivered batch and asserts their window, suggested output, and
  capabilities.
- Unknown-model behavior (per the 2026-08-04 model-context change): an
  undocumented ID without a positive override now resolves a guessed window
  (default 512K) instead of being blocked.
- Each catalog batch runs its focused pytest target and Ruff before its commit.

## Non-Goals

- No runtime provider discovery.
- No model-family fallback or case-normalized matching.
- No changes to token estimation, admission control, or frontend settings as
  part of catalog-only commits.
