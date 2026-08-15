# M04 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M04-T01 | PASS | `durable-runtime.test.ts`（事件序列/重建 snapshot） |
| M04-T02 | PASS | `durable-runtime.test.ts`（terminal 后准入）、`session-registry.test.ts` |
| M04-T03 | PASS | `durable-runtime.test.ts`（request-id 幂等）、`durable-agent-runtime.test.ts` |
| M04-T04 | PASS | `durable-runtime.test.ts`（interrupted recovery） |
| M04-T05 | PASS | `event-log-corruption.test.ts`（坏 JSON/sequence 缺口 fail-closed） |
| M04-T06 | PASS | `durable-agent-runtime.test.ts`、`pi-adapter.test.ts`（cancel/ack） |
| M04-T07 | PASS | `phase5/approval-gate.test.ts`、frontend `hil-data-correction-e2e.test.tsx` |
| M04-T08 | PASS | `durable-agent-runtime.test.ts`（compact/steer） |
| M04-T09 | PASS | `durable-agent-runtime.test.ts`（删除 terminal task） |
| M04-T10 | NOT_RUN | 无显式事件写失败故障注入 |
