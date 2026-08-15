# M14 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| 维度 | 结果 | 证据 |
| --- | --- | --- |
| 10k 记录整合 | PASS | `large-integrate.test.ts` |
| 50 并发任务 | PASS | `concurrent-tasks.test.ts` |
| build lock 竞争/心跳租约/原子接管 | PASS | `build-lock.test.ts` |
| straggler/超时/取消抢占 | PASS | `straggler-safety.test.ts`、`core-preemption.test.ts` |
| 网络故障（provider 不可达） | PASS | `network-fault.test.ts`（fail-closed） |
| 恶意大输入（超长/深层 JSON） | PASS | `malicious-input.test.ts`（不崩溃） |
| 磁盘满/句柄耗尽（写失败注入） | PASS | `fault-injection.test.ts`（open 失败 reject） |
| 100 并发任务 | PASS | `clock-and-scale.test.ts` |
| 时钟跳变 | PASS | `clock-and-scale.test.ts`（sequence 跨时钟回拨仍单调） |
| 恶意压缩（zip bomb） | NOT_RUN | 未执行（创建 zip bomb fixture 不安全） |

## 通过标准观察

- 无无界内存增长/永久锁/孤儿进程的显式断言未做（需要专用压测环境）。
