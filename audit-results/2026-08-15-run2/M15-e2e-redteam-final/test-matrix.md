# M15 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19 / Playwright

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1 多来源构建 gene-expression | PASS | `ts-core-e2e.test.ts`（fixture 级 SUCCESS/GEO） |
| 2 一源超时+一源不兼容 → PARTIAL_SUCCESS | PASS | `ts-core-e2e.test.ts` |
| 3 全部无数据 → NO_DATA | PASS | `ts-core-e2e.test.ts` |
| 4 spec 不完整 → SPEC_REJECTED | PASS | `ts-core-e2e.test.ts` |
| 5 中途取消/重启 → 不半发布 | PASS | `core-preemption`、`straggler-safety`、`dataset-runtime` |
| 6 WS 断线刷新一致 | PASS | `runtime-controller.test.ts`、`hydrate-compat.test.ts` |
| 7 declarative DB + HIL | PASS | `hil-data-correction-e2e.test.tsx`、`approval-gate.test.ts` |
| 8 恶意输入组合 | PARTIAL | 路径穿越/SSRF/伪造 manifest/并发单项均覆盖；完整组合未执行 |
| 真实外部数据源 | PASS | `live-smoke.test.ts`（BIOMED_LIVE_SMOKE=1，10 端点） |
