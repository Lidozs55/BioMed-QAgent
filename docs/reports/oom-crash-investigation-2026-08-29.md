# Out of Memory 崩溃检查与修复报告

日期：2026-08-29 ｜ 分支：`fix/model-refresh-and-oom` ｜ 状态：已修复，待验收

## 1. 故障背景

2026-08-29 gold9 r1（qwen3.7-flash，任务 `task_ts_a6c3581c` / run `run_ts_05cbf58e`）运行约 42 分钟、产生 28,064 个事件后，Host server 子进程死亡（`tsx watch` 于 1 秒后重启），活跃 run 被标记 `interrupted`，supervisor 以 "fetch failed" 退出。运行终端报错为 **out of memory**，崩溃原因当时未定位（见 `data/gold/gold7_alzheimer_gwas/runs-log.md` 当日记录）。当日同一 Host 上还存在第二个并行 gold7 supervisor，两个 run 共享同一 Host 进程。

需要说明的是：浏览器主帧渲染闸门（2026-08-28 `138d5166`，针对 gold9 浏览器渲染进程 10.6 GB 事故的修复）已在本次崩溃前合入，因此本次崩溃发生在 **Node Host 进程自身**，与此前渲染进程事故是两个不同层面的问题。

## 2. 排查范围与方法

对 `server/src/` 做了全量内存路径排查：事件存储与快照链路、WebSocket 订阅回放、下载与外部 API 客户端、数据集载体（carrier）装载与解析、浏览器池、PDF/Excel/图片解析路径，并用本地磁盘上的真实 `events.jsonl`（13 个任务共 60 MB，最大单文件 6.4 MB）校准了事件文件的规模量级。

## 3. 根因分析

### 根因一（主因）：数据集载体全量内存解析，无任何大小闸门

`server/src/dataset/runtime/registered-multitable.ts` 的 `carrierBytes()` 把注册载体资产的内容流**无上限地**整体读入内存（`chunks.push` + `Buffer.concat`），随后 `inherited-disease-evidence/provider.ts` 的 `parseOrphanetCarrier()` 对整份字节做 `toString("utf8")`（UTF-16 字符串再翻倍），再交给 fast-xml-parser `XMLParser.parse()` 构建完整 JS 对象树——对象树膨胀可达源文件的 10 倍以上。

内存峰值估算（以 Orphadata `en_product1.xml` 约 600 MB 为例）：约 0.6 GB Buffer + 1.2 GB 字符串 + 6–12 GB 对象树，远超 Node 默认堆上限，进程以 "JavaScript heap out of memory" 死亡。gold9 正是 Orphadata 跨表列闭合任务，run 期间执行过 3 次 dataset execute，与故障场景吻合。

### 根因二（帮凶）：事件仓库读放大，反复全量重读重解析

`server/src/runtime/task-repository.ts` 的 `readAllEvents()` 每次调用都 `readFile` 整个 `events.jsonl` 并逐行 `JSON.parse`，而该函数被大量高频路径触发：

| 触发路径 | 放大程度 |
| --- | --- |
| `GET /api/v1/tasks`（`listTasks`） | 对**每个**任务目录全量读+解析 |
| WebSocket 订阅回放（`durable-agent-runtime.ts:1615`） | 以 1000 条为块循环调用 `listEvents`，28k 事件 ≈ **29 轮全量读** |
| `findRequest()`（每次 `createTask`/`createRun` 去重） | 遍历所有任务 × 全量解析 |
| `cancelRun`/`resumeRunOnce`/`compactTask`/`resolvePermission` 等 | 每次操作先 `getSnapshot` 全量读 |

一次全量读的瞬态峰值约为文件字节的 3–5 倍（原始字符串 + 行数组 + 解析对象）。两个并行 run 产生数万事件、叠加前端轮询与多标签页 WebSocket 回放时，反复出现数百 MB 级瞬态堆分配，与根因一叠加后加速堆耗尽。

### 次要因素

`server/src/agent/event-adapter.ts` 的 `terminalRuns` Set 只增不减（每个 run 一个短字符串，量级小、危害低）。此外 `docs/architecture/runtime-limits.md` 已记录两项浏览器残余边界（主帧 body 在 MIME/size 闸门前于 Node 侧完整缓冲一次；iframe 子帧导航不经过闸门），本次未改动。

## 4. 修复内容

### 4.1 载体内存闸门（把进程死亡转化为干净报错）

新增 `server/src/dataset/runtime/provider-limits.ts`，定义两个代码级常量：`MAX_PROVIDER_CARRIER_BYTES = 128 MiB`（任意格式载体入内存上限）、`MAX_XML_CARRIER_BYTES = 32 MiB`（XML 对象树解析上限，考虑约 10 倍膨胀故更保守）。

- `registered-multitable.ts` `carrierBytes()`：读取前按登记收据 `size_bytes` 拒绝超限载体（不启动传输）；流式读取中累计字节超限立即中止。错误信息附修复指引（改用窄提取或流式/分片适配器）。
- `inherited-disease-evidence/provider.ts` `parseOrphanetCarrier()` 与 `literature-evidence/provider.ts` `transformBioCLiteratureEvidence()`：解析前校验载体字节数，超限报错并说明对象树膨胀风险。

### 4.2 事件仓库增量缓存（消除读放大）

重写 `task-repository.ts` 的 `readAllEvents()` 为**追加式增量读取缓存**：按任务缓存已解析事件，命中时零磁盘读取、零重新解析；文件增长时只读取新增字节（`byteLength` 偏移起读，按最后换行符截断半行尾部，以缓存末事件序列做连续性校验）；文件变小/被重写时自动全量重建。写路径 `appendEvents()` 在落盘后同步把新事件折入缓存，读写在同一序列化队列中保持一致。缓存设有 256 MiB 全局 LRU 预算（按文件字节 × 3 估算解析后内存），超限自动淘汰最久未访问任务。`deleteTask` 同步清理缓存。

### 4.3 terminalRuns 上限

`event-adapter.ts`：`terminalRuns` 达到 `MAX_TERMINAL_RUNS = 4096` 时按插入序淘汰最旧条目，消除长驻进程下的无界增长。

## 5. 验证

- 服务端 `tsc --noEmit -p tsconfig.test.json`：通过。
- 相关测试 9 组 80 例全部通过：`durable-runtime` / `event-adapter` / `event-log-corruption` / `dataset-inherited-disease-evidence-family` / `dataset-literature-evidence-family` / `durable-agent-runtime` / `concurrent-tasks`（含 50 并发任务无序列错乱）/ `ct4-multitable-resource-preflight` / `dataset-multitable-validation`。
- 本报告同分支内前端改动（模型设置页刷新修复）已通过 `tsc -b`、vitest 32 例与 `vite build`。
- 全量服务端套件 202 个文件中有 3 个失败文件，经与干净 main 基线（stash 对比）逐一复跑确认**均为 main 已有问题，与本分支修复无关**：`model-settings.test.ts` 在基线上以相同断言失败（`resolveActiveModel()` 返回多出 `safetyReserveTokens: 3200` 字段，测试期望未同步）；`dataset-runtime.test.ts` 的 runtime parity 用例在基线与本分支上均呈间歇性失败（3 次重跑 通过/失败/通过 与 失败/通过/失败，报 `impl version: first run executes all` 差异）；`family-host-identity-wiring.test.ts` 在本分支单独运行 3/3 通过，全量套件中的失败属并行执行污染。

## 6. 行为影响与后续建议

修复后，超过闸门的载体会在 execute 阶段以**可诊断的干净报错**失败（错误信息包含已收字节、上限值与处理建议），而不是把整个 Host 进程连同另一个并行 run 一起拖死。gold9 这类需要 Orphadata 全库 XML 的任务，短期内应改用窄提取/分片载体；若确认需要整库解析，需按闸门注释指引实现流式解析适配器（这属于新功能，不在本次修复范围）。

后续建议（按优先级）：在 `pnpm dev`/`start` 脚本显式设置 `--max-old-space-size` 以获得可预期的堆边界与更早的故障信号；关注活跃 run 的 `events.jsonl` 体量；长期考虑事件快照的折叠缓存与 XML 流式解析；`sha256File`、`dataset/acquisition/runtime.ts` 归档读取、`geo/probe-mapping` 等其余整文件读取点可在各自域内补充大小闸门（本次未动，当前均有各自业务上限约束）。
