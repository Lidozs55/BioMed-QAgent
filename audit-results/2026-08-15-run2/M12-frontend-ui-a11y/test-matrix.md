# M12 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19 / jsdom

| Case | 结果 | 证据 |
| --- | --- | --- |
| M12-T01 | PASS | `runtime-controller.test.ts`、`chat-panel.test.tsx`、`subagent-flow.test.tsx` |
| M12-T02 | PASS | `runtime-controller.test.ts`、`realtime-stream-reducer.test.ts`、`hydrate-compat.test.ts` |
| M12-T03 | PASS | `results-viewer.test.tsx`、`chat-panel.test.tsx`、`task-outcome.test.ts` |
| M12-T04 | PASS | `artifact-fab.test.tsx`、`build-report-card.test.tsx` |
| M12-T05 | PASS | `settings-panel.test.tsx`、`settings-editor.test.tsx` |
| M12-T06 | PASS | `settings-database-draft.test.tsx`、`hil-data-correction-e2e.test.tsx` |
| M12-T07 | PASS | `markdown-streaming.test.tsx`、`LoadingScreen.test.tsx` |
| M12-T08 | PASS | `accessibility-axe.test.tsx`、`composer-a11y.test.tsx`（基础 role/name + axe） |
| M12-T09 | PASS | `api-client-boundary.test.ts`、`event-adapter.test.ts`（脱敏） |
