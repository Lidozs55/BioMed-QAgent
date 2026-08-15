# M14 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| 维度 | 结果 | 证据 |
| --- | --- | --- |
| 10k 记录整合 | PASS | `large-integrate.test.ts` |
| 50 并发任务 | PASS | `concurrent-tasks.test.ts` |
| build lock 竞争/心跳租约/原子接管 | PASS | `build-lock.test.ts` |
| straggler/超时/取消抢占 | PASS | `straggler-safety.test.ts`、`core-preemption.test.ts` |
| 100/1k 记录、10/100 并发、磁盘满/句柄耗尽、慢消费者背压、大文件/恶意压缩/深层 JSON | NOT_RUN | 未执行 |
| 时钟跳变 | NOT_RUN | 未执行 |

## 通过标准观察

- 无无界内存增长/永久锁/孤儿进程的显式断言未做（需要专用压测环境）。
