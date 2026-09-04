> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 5. ADR-003：保留可信执行内核，不保留固定五阶段业务状态机

### 状态

已接受。

### 保留

- SourceAsset；
- DownloadAttempt；
- 文件 hash；
- Attempt 输入/参数/输出摘要；
- 任务锁；
- checkpoint；
- timeout/cancel；
- durable event；
- staging；
- Validation Gate；
- atomic publication；
- fixture/live 区分。

### 替换

- `_STAGES` 全局固定列表；
- `StageName` 作为业务主协议；
- 固定数据库组合；
- `StageAttempt` 的阶段专属语义；
- 固定 Artifact 文件集合；
- 固定验证顺序。

### 理由

可靠性能力本身正是赛题的来源追踪、可复现和错误修正基础。直接删除 Pipeline 会丢失最有价值的实现资产。

---
