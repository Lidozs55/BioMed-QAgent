# M02 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M02-T01 | PASS | `pi-import-boundary.test.ts` |
| M02-T02 | PASS | `workspace.test.ts`（symlink 逃逸/原子写/protected alias） |
| M02-T03 | PASS | `config.test.ts`、`workspace.test.ts`（dev exec 默认关闭） |
| M02-T04 | PASS | `event-adapter.test.ts`（`[truncated]`）、pi-adapter bounded union |
| M02-T05 | PASS | `skill-manifests.test.ts`、`skill-tool-map.test.ts` |
| M02-T06 | PASS | `pi-import-boundary.test.ts`、`durable-agent-runtime.test.ts`（仅 manifest 注册 artifact） |
| M02-T07 | PASS | `pi-adapter.test.ts`（session/并发 turn） |
| M02-T08 | PASS | `pi-adapter.test.ts`、`workspace.test.ts`、`durable-agent-runtime.test.ts` |
