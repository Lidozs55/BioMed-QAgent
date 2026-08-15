# M05 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M05-T01 | PASS | `durable-agent-runtime.test.ts`（replay 递增） |
| M05-T02 | PASS | `durable-agent-runtime.test.ts`（live 增量） |
| M05-T03 | PASS | `durable-runtime.test.ts`（replay 分页）、frontend transport |
| M05-T04 | PASS | `ws-edge.test.ts`（双 task 不串 + unsubscribe 停止推送） |
| M05-T05 | PASS | `ws-protocol.test.ts`（ping/pong、坏 JSON、未知命令、非法 after_sequence、不存在 task） |
| M05-T06 | NOT_RUN | 慢消费者背压/连接突然关闭未显式测 |
| M05-T07 | PASS | `event-adapter.test.ts`（截断/脱敏） |
| M05-T08 | PASS | `ws-edge.test.ts`（302 事件严格递增 replay） |
