# M03 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M03-T01 | PASS | packages/contracts 14/14；wire DTO 上移 `@biomed/contracts` runtime |
| M03-T02 | PASS | `dataset-contracts.test.ts`（extra=forbid 等）、frontend `api-parser-rejection.test.ts` |
| M03-T03 | PASS | `contracts.test.ts`（event schema/task/run 冻结）、`event-adapter.test.ts` |
| M03-T04 | PASS | `event-adapter.test.ts`（arguments 可选/向后兼容） |
| M03-T05 | PASS | `contracts.test.ts`、`event-adapter.test.ts`（stage_* 仅 replay） |
| M03-T06 | PASS | `dataset-contracts.test.ts`（family/granularity/source binding） |
| M03-T07 | PASS | `dataset-publication.test.ts`、`dataset-runtime.test.ts` |
| M03-T08 | PASS | `dataset-contracts.test.ts`（schema_version 归一化） |
