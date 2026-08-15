# M11 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M11-T01 | PASS | `durable-runtime.test.ts`、frontend `api-budget.test.ts` |
| M11-T02 | PASS | `durable-agent-runtime.test.ts`（integrity drift） |
| M11-T03 | PASS | `durable-agent-runtime.test.ts`（删除 terminal task） |
| M11-T04 | PASS | `durable-agent-runtime.test.ts`、`approval-gate.test.ts`、`pi-adapter.test.ts` |
| M11-T05 | PASS | `product-api.test.ts`（cache ZIP export） |
| M11-T06 | PASS | `host.test.ts`、`vite-middleware.test.ts` |
| 通用矩阵 | PASS | `product-api.test.ts`、frontend `api-malformed-rejection`/`api-parser-rejection`/`api-envelope-constraints` |

## 未覆盖

- Host header 注入显式测试：NOT_RUN（建议 M14 补）。
