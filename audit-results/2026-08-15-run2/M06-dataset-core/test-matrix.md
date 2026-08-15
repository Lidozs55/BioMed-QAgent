# M06 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M06-T01 | PASS | parity 测试 + `ts-core-e2e.test.ts`（publishes immutably） |
| M06-T02 | PASS | `dataset-build-tools.test.ts`、spec validator parity |
| M06-T03 | PASS | `ts-core-e2e.test.ts`（SUCCESS/PARTIAL_SUCCESS/NO_DATA/SPEC_REJECTED） |
| M06-T04 | PASS | `dataset-integrator.test.ts`、`dataset-canonicalizer.test.ts`、`dataset-contracts.test.ts` |
| M06-T05 | PASS | `dataset-runtime.test.ts`、`straggler-safety.test.ts`、`large-integrate.test.ts` |
| M06-T06 | PASS | `core-preemption.test.ts`、`straggler-safety.test.ts`、`ts-core-e2e.test.ts` |
| M06-T07 | PASS | `phase5/build-lock.test.ts`、`ts-core-e2e.test.ts`（build lock） |
| M06-T08 | PASS | `dataset-publication.test.ts`（atomic promotion）、publish fence |
| M06-T09 | PASS | `durable-agent-runtime.test.ts`（integrity drift）、`dataset-publication.test.ts` |
| M06-T10 | PASS | 全部 `dataset-*-parity` 测试逐字段 parity |
