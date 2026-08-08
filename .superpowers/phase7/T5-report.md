# Phase 7 T5 — operation events 渲染 + 对话流节点自动折叠

Branch: `feat/phase7-t56-frontend-misc` · Commit: `63bfd5a`

## Scope

Renders V2 build-execution `operation_started/progress/completed/failed` events
(T3 contract, already in `frontend/src/runtime/contracts.ts` EventPayload union
with optional label/category) as first-class conversation nodes, and
auto-collapses in-progress operation/tool nodes into a compact summary row once
completed (TODO P1 原 §3.4). `stage_*` events and old event shapes are untouched
(compatibility preserved).

## Changes (frontend only)

- `runtime/types.ts` — new `OperationItem` conversation kind (`operationId`,
  `label|null`, `category|null`, `status: running|completed|failed|skipped|cancelled`,
  `progress`, `error`).
- `runtime/reducers/pipeline.ts` — `applyOperationEvent`: groups all four
  operation event types into ONE item keyed `operation:<runId>:<operation_id>`
  (progress events update in place, terminal event wins the status). Events with
  `run_id === null` (pre-T3 events.jsonl replay) stay informational — cursor
  advances, no item.
- `runtime/reducers/index.ts` — dispatch cases for the four operation types.
- `components/conversation/operationMeta.ts` — `operationDisplayLabel` (label →
  operation_id → category fallback) + `operationCategoryMeta` (category-derived
  icon/color for the 5 stage categories + default for binding-id categories).
- `components/conversation/OperationStep.tsx` — row shows label + category icon
  (spinner while running) + status badge; running ops show inline `current/total`
  progress; terminal ops auto-collapse into the summary row, detail
  (progress/error) expandable on click; manual expand/collapse preserved via
  local state (same pattern as ToolCallStep/SkillMarker).
- `components/conversation/ConversationStep.tsx` — dispatcher `operation` case.
- `components/ChatPanel.tsx` — `formatActiveItemStatus` operation case (active
  run status marker shows the running operation label).

## TDD

Red first (5 failing + module-not-found on 4 files), then implementation:

- `components/conversation/__tests__/OperationStep.test.tsx` (6 tests):
  (a) label + category-derived icon + running badge + inline progress,
  (b) empty-label → operation_id fallback, (c) label+operation_id empty →
  category fallback, (d) completed op auto-collapses, expand/collapse on click,
  (e) failed op error hidden behind toggle, (f) skipped/cancelled badges.
- `components/conversation/__tests__/ConversationStep.test.tsx` — added
  operation dispatch test; legacy stage/user/tool/artifact cases unchanged.
- `test/runtime-reducer.test.ts` + `test/agent-stream.test.ts` — F4 tests
  updated: operation lifecycle now projects one grouped item (previously
  asserted "items unchanged" for the old informational behavior).

## Gates

- `pnpm lint`: 0 warnings · `pnpm tsc`: 0 errors · `pnpm build`: OK
- `pnpm test`: 705 passed / 44 files (baseline 698 / 43 → +7 tests, 1 new file)
