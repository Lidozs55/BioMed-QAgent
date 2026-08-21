# WP-B：流式执行与可信运行原语

## 1. 目的

将 expression 现有 streaming、SQLite disk-backed integration、quota、cancel 等能力整理为可供多个 Family 使用的基础设施，避免把当前 `registered_multitable.runtime.v1` 的完整内存路径扩展到大数据生产场景。

## 2. 当前约束

当前 registered multi-table runtime 存在：

- carrier bytes 完整读入 `Buffer`；
- `ProviderRows = Record<string, readonly object[]>`；
- 全量数组聚合和写表；
- `readFile(...).split("\n")` 统计行数；
- provider dispatch 和 schema mapping 的 family 特判。

因此本工作包完成前：

- 不将 gene expression production executor 切换到该 runtime；
- 不把 GEO/GDC/Xena rows 统一转成 `object[]`；
- 不以已有 integrator heap 测试替代 provider carrier 的压力测试。

## 3. 交付原语

### B1：Bounded source reader

提供 cancellation-aware、受 `RuntimeLimits` 约束的流式读取接口：

- chunk/line/record reader；
- 最大单条记录长度；
- 最大输入和解压大小；
- hash、size、media type、receipt 校验；
- 中途取消清理临时文件；
- 不允许绕过 task-owned asset registry 直接读取任意 path。

### B2：File-backed table writer

定义 table-level writer：

- 只接受经过 schema parser 的 typed row；
- bounded output buffer；
- header/row width/type 校验；
- 增量 row count、digest、rejected/conflict side output；
- 产生 committed `OperationResultManifest`；
- 输出路径固定在 build checkpoint/output subtree；
- commit 前失败不暴露 publication-eligible artifact。

### B3：Disk-backed table state

将 dedup key、FK/PK index、冲突索引和 row statistics 放入 SQLite 或等价的磁盘结构：

- quota bytes/records；
- deterministic key encoding；
- transaction batch；
- checkpoint rehydrate；
- stale lease/build fence；
- restart 后不重复 commit。

### B4：Durable operation boundary

每个 supporting table、mapping、audit 输出都必须有：

- operation id/attempt；
- input asset IDs + SHA-256；
- parameter digest；
- implementation digest；
- output file receipt；
- dependency closure；
- commit receipt；
- cancellation/partial status。

### B5：Generic execution adapter

先提供 family-agnostic primitive API，再由 expression projection、registered family adapter 调用。Family adapter 不得重新实现资源控制、receipt、checkpoint 或 hash 逻辑。

## 4. 分阶段计划

1. B1/B2：从 expression 现有 writer/integrator 中抽出最小接口，保持旧路径兼容。
2. B3：为 expression primary 和 supporting table 加磁盘 identity/index；完成 heap/quota/cancel fixtures。
3. B4：将 sample metadata、probe mapping、rejected/conflict 变为 committed result。
4. B5：提供 projection execution adapter；先只在内部 vertical slice 使用。
5. B6：对 registered multi-table provider path 做独立 streaming 改造；未通过压力门时不切 production。

## 5. 依赖与并行关系

- B1 可与 A1 并行；B2 的 table fields 依赖 A1/A2 的 contract。
- B3 依赖 A 的 per-table merge identity，但可以先用 expression fixture 开发。
- C 依赖 B3 的 deterministic store API。
- D/GEO 可在 B2+B4 的最小版本上接入；GDC/Xena 不能绕过 B1/B2。
- E/H 依赖 B4 的 committed result 和实际 row statistics。

## 6. 资源验收

至少记录：RSS、heap、wall time、temp-store size、输入/输出 bytes、批次数、最长 operation、取消延迟和 checkpoint 恢复时间。必须覆盖：

- 大矩阵不随行数线性增长的 JS heap；
- 超过 quota fail-closed；
- cancel 不留下可发布半成品；
- restart 从 typed checkpoint 继续，不重复 replay 已 committed operation；
- output hash 与 manifest/API 下载 hash 一致。

## 7. 禁止事项

- 用全量 `Buffer` 作为长期 provider contract；
- 用 `object[]` 作为大表通用聚合接口；
- 通过读取整个 CSV 计算 row count；
- 把 sidecar 文件直接挂到 manifest 而没有 OperationResult receipt；
- 用固定 `coverage_ratio = 1` 代替真实统计；
- 让 FamilySpec 关闭全局 resource limit、cancel、path containment 或 publication fence。
