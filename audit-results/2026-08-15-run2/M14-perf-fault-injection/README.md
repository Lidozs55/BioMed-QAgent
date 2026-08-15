# M14 性能、并发、资源与故障注入红队 审计结果（Run #2）

- 审计人: root
- 基线: be78a1a
- 状态: PARTIAL

## 覆盖情况

| 维度 | 结果 |
| --- | --- |
| build lock 竞争 / 心跳租约 / 原子接管 | PASS（build-lock 8 通过；本拉取已记录一个偶发失败为 P2 tech debt） |
| straggler 取消后不发布 / 操作超时抢占 | PASS |
| 下载重试有界、截断 gzip fail-closed | PASS |
| 10k 记录整合 | PASS（`large-integrate.test.ts`，10,000 行去重整合完成） |
| 50 并发任务准入 | PASS（`concurrent-tasks.test.ts`，无 request-id/sequence 损坏） |
| 磁盘满 / 句柄耗尽 / 慢消费者背压 / 恶意大输入 | NOT_RUN |

## 建议进入长期回归套件

- 10k 行 canonicalize/integrate/publish 基准（p50/p95/p99 + 内存上限）。
- 磁盘满/句柄耗尽下的 cache/events.jsonl 写失败路径（需专用故障注入环境）。
- 慢消费者 WS 背压与内存回收。
