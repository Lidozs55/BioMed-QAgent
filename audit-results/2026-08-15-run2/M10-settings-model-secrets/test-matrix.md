# M10 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M10-T01 | PASS | `model-settings.test.ts`（masked GET）、frontend settings |
| M10-T02 | PASS | `model-settings.test.ts`、frontend `settings-panel.test.tsx` |
| M10-T03 | PASS | `model-settings.test.ts`、frontend `api-parser-rejection.test.ts` |
| M10-T04 | PASS | `workspace.test.ts`（无 secret 审计）、`event-adapter.test.ts`（脱敏） |
| M10-T05 | PASS | `model-settings-migration.test.ts` |
| M10-T06 | NOT_RUN | 无显式并发 PUT 幂等测试 |
| M10-T07 | PASS | `model-settings.test.ts`、frontend provider 发现测试 |
