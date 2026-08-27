> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 12. ADR-010：RunStatus、BuildResult、ValidationResult 与 Publication 正交

### 状态

已被 ADR-041 取代。本文保留为旧 Build 领域的决策历史。

### 决策

四个状态体系分别回答不同问题：

| 概念 | 回答问题 | 典型值 |
| --- | --- | --- |
| `RunStatus` | 执行是否排队、运行、完成、失败或取消 | QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED |
| `BuildResult` | 正常完成后得到什么数据结果 | SUCCEEDED/PARTIAL_SUCCESS/NO_DATA/SPEC_REJECTED |
| `ValidationResult` | 某个 Manifest digest 是否通过 Profile | PASSED/FAILED |
| `DatasetPublication` | 哪个不可变版本已正式提升 | publication ID + supersedes |

只有 `RunStatus=COMPLETED` 才产生 `BuildResult`。执行异常和用户取消不再重复表示为 `EXECUTION_FAILED` 或 `CANCELLED` BuildResult。

不使用 `validated_intermediate` / `validated_final`。每次成功发布都生成不可变 Publication，后续版本使用 `supersedes_publication_id` 关联。任务或会话只维护 `current_publication_id`。

### 结果

- 无主数据不再必然触发内部失败；
- 前端不通过错误字符串猜 no_data；
- 无数据时可以交付审计型 Publication；
- 内部异常仍然是 failed；
- 用户始终收到服务端生成的 RunSummary；
- 新版本不会改变旧 Artifact 的状态。
