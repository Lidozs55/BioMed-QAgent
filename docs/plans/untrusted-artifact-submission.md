# 非权威产物旁路提交

- **状态：** 手动提交已实现；自动 candidate fallback 设计已批准、实现中
- **分支：** `feat/untrusted-artifact-submission`（手动基线）/ `fix/gold6-r4-evidence-binding`（自动 fallback）
- **适用范围：** 个人单机运行

## 目标

当正式数据构建因来源未完成准入、数据不完整或覆盖范围不足而无法发布时，允许用户把已有文件保存在任务下，明确查看其可信状态、覆盖范围和缺失范围，并下载继续检查。

旁路记录不是正式发布。它不得产生或修改：

- `OperationResult`
- `ValidationResult`
- `ProductAssessment`
- `DatasetPublication`
- `publication_created` / `artifact_produced` 事件
- `current_publication_id`
- `publish/`、`dataset_runs/`、`source_assets/`、`events.jsonl`

正式发布链及其 Core admission、重新哈希、Validation、B3、HIL 和 Publisher 门禁保持不变。

## 最小设计

新增任务级 quarantine 目录：

```text
<tasksRoot>/<taskId>/quarantine/<submissionId>/
  artifact.bin
  receipt.json
```

客户端使用浏览器原生 `multipart/form-data` 提交两个字段：

- `metadata`：JSON 字符串，包含显示名称、媒体类型、可选来源说明、覆盖状态、已覆盖范围和缺失范围；
- `file`：原始文件字节。

服务端：

1. 确认任务存在并要求 multipart 请求。
2. 解析严格字段集的元数据，拒绝缺失或未知字段。
3. 拒绝空文件及超过现有单文件导入上限的文件。
4. 生成 `submission_id`，重新计算 SHA-256 和字节数。
5. 使用固定文件名写入 `artifact.bin`，原子写入 `receipt.json`。
6. 返回明确包含 `authoritative: false` 和 `trust: "untrusted"` 的收据。
7. 下载前按收据重新校验文件大小和 SHA-256。

该入口复用运行时已有的原生 multipart 解析方式，不新增上传依赖、索引数据库、后台任务、额外生命周期锁、幂等 sidecar、配额、遥测或远程部署防御。

## API

- `POST /api/v1/tasks/:task_id/quarantine`
- `GET /api/v1/tasks/:task_id/quarantine`
- `GET /api/v1/tasks/:task_id/quarantine/:submission_id`
- `GET /api/v1/tasks/:task_id/quarantine/:submission_id/content`

`metadata` 由 `@biomed/contracts` 的 `UntrustedArtifactMetadata` 定义：

```text
schema_version: "1.0"
name
media_type
source_note
coverage_status: complete | partial | unknown
covered_scope[]
missing_scope[]
```

服务端收据 `UntrustedArtifactReceipt` 额外包含：

```text
submission_id
task_id
size_bytes
sha256
submitted_at
authoritative: false
trust: "untrusted"
```

列表响应固定为 `{ items: UntrustedArtifactReceipt[] }`。下载响应使用元数据中的媒体类型和经过响应头清理的附件文件名；磁盘路径只使用服务端生成的 ID 和固定的 `artifact.bin`。任务删除沿用现有整棵任务目录删除行为，因此自然删除 quarantine。

每次手动提交独立生成一条收据。本地功能不维护额外幂等状态。

## 正式拒绝后的自动 fallback

当 Dynamic Family 已经完成 transform quarantine admission、产生 committed native
`OperationResult` 和可逐文件寻址的 candidate bytes，并且后续命中显式 typed 产品拒绝
（literature semantic profile、最终 B3/ProductAssessment 不可发布，或
`publication_acceptance` 人工 reject/skip）时，Host 可将候选表**单向复制**到同一 task
quarantine：

1. 从 Core-owned committed root 按 canonical relative path 重新读取候选文件；
2. 对照 OperationResult receipt 重验 size 和 SHA-256；
3. 每张表独立调用同一 `storeUntrustedArtifact`，写出 `ua_*` receipt；
4. metadata 明确记录自动 fallback、task/run/requirement/result identity、正式拒绝原因、
   covered table 与缺失的正式门；
5. 原始 publication error 继续返回，工具结果保持 error，不改成成功。

自动 fallback 不适用于 transform 尚未产出 bytes，也不得把未知异常降级；cancel/abort、
timeout/resource limit、I/O、stale generation、execution-lock/fence loss、跨 task/run 身份
错配、路径越界、缺失 admitted output、TOCTOU 或 size/hash 漂移均属于控制、资源或完整性
失败。fallback 自身失败也不能掩盖原始正式拒绝。

跨 Application Host restart 的 `publication_acceptance` continuation 不持久化完整 committed
`OperationResult` 或 trusted root，因此 restart 后的 reject/skip 只保留同一 typed 正式拒绝及
reviewer reason，并以 `run_failed` 收束；它不得据 continuation 中的 table 摘要伪造 `ua_*`
或任何正式 Artifact/Publication。

## 前端

输入栏旁提供统一的“资源”入口和 Sheet，内部保持独立分组：正式/任务产物、未准入文件、来源与证据资产。未准入分组继续提供：

- 选择并提交本地文件；
- 填写简短来源说明、覆盖状态、已覆盖和缺失范围；
- 列出任务下的 quarantine 收据；
- 显示“非权威 / 未经准入”、覆盖与缺失范围、文件大小和 SHA-256；
- 提供下载按钮。

quarantine 状态仅存在于统一 Assets Sheet 的独立“未准入”分组中，不嵌入正式 `ResultsViewer`，也不加入 artifact、publication、task outcome 或事件投影。即使存在 quarantine 文件，任务也不能因此被判定为正式“有数据”；聚合展示不合并底层 DTO 或信任状态。

## 测试

### 后端

- multipart 创建、列表、详情和下载；
- 服务端摘要和字节数正确；
- 未知任务、非 multipart、缺少字段、无效元数据和空文件失败；
- 提交显示名称不会成为磁盘路径；
- 文件被修改后下载按摘要失败；
- quarantine 不写入正式 `publish/`、`dataset_runs/`、`source_assets/` 或 `events.jsonl`；
- 删除任务后 quarantine 一并消失。

### 前端

- API multipart 请求和严格响应解析；
- 上传后刷新列表；
- 显示非权威、覆盖和缺失范围；
- 下载地址正确；
- 入口独立于正式结果组件。

## 非目标

- 不把 quarantine 自动提升为正式发布；
- 不从浏览器 `SourceAsset` 自动复制文件到 quarantine；只有已有 committed Dynamic Family candidate bytes 且非控制/完整性失败时可自动 fallback；
- 不执行、解析、预览或解压任意提交文件；
- 不新增多账号、服务端部署、认证、遥测或监控能力；
- 不建立第二套 Publisher、发布状态机或额外索引。
