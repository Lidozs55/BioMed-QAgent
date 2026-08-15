# §5 API 与状态覆盖矩阵（Run #2）

| 区域 | 成功态证据 | 失败/竞态态证据 |
| --- | --- | --- |
| health/root | PRE-04 200、正确 ts/pi/ts 标识、SPA fallback | host.test.ts（未构建静态包/503） |
| databases | product-api.test.ts、declarative-db.test.ts | 重名/非法 manifest/内置删除（database 测试） |
| settings/models | model-settings.test.ts、settings-panel.test.tsx | api-parser-rejection（错 key/未知字段） |
| tasks/runs | durable-agent-runtime.test.ts、durable-runtime.test.ts | active run 冲突/幂等重试/非法状态 |
| cancel/resume | pi-adapter.test.ts、approval-gate.test.ts | terminal/重复/失效 decision |
| events/ws | durable-agent-runtime.test.ts、ws-protocol.test.ts | 未知命令/非法 after_sequence/慢连接（部分） |
| builds/artifacts | ts-core-e2e.test.ts、durable-agent-runtime.test.ts | 未发布/路径逃逸/hash/size 不符 |
| cache | product-api.test.ts、db-bridge.test.ts | 半提交/磁盘满（磁盘满 NOT_RUN） |
