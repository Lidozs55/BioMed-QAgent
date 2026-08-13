# 溯源、复现与报告

覆盖多源整合时的实体一致性、来源追溯、不可变发布与复现契约。对应赛题"来源可追溯性 /
清洗整合可靠性"评价维度。

## 1. 逐行溯源

- 每个产物行应能追溯到 `source_id` / `asset_id` / `source_logical_file` /
  `source_line_number` / `source_column_index` / `source_raw_value`；
- 下载血缘闭合：每个下载先有 `DownloadAttempt`，成功后有对应 `SourceAsset`；
- 来源清单/下载日志/处理日志齐全，`processing_log.parameters` 记录清洗参数；
- 检查 `provenance closure`：所有 primary 行的资产都在 provenance 文档中、覆盖全部
  source asset——发布前不变量校验失败会拒绝 promotion。

## 2. 多源整合的实体一致性

- 合并前确认各源 **population/时间/结局/特征定义可比**；无法个体级连接的数据用于
  跨队列比较或互证，不作行级合并；
- 同一样本跨源（如 GDC 与 Xena 同一 TCGA 队列）用稳定 ID 对齐（TCGA 条码、样本 ID），
  不依赖显示名；
- 基因/探针 ID 命名空间必须一致才能合并（同 family/granularity + compatibility gate
  检查单位/尺度/主键语义/映射证据）；
- 单位/尺度不一致时记录映射与归一化审计，不静默合并。

## 3. 不可变发布

- 构建成功 → 不可变 publication（版本目录 + supersedes 链），旧版本不被修改；
- `publication_id` / `manifest_ref` / `validation_result_ref` 引用闭包完整（包括
  validation_report.json 在版本目录内）；
- 发布前 gate：provenance 闭包 + profile passed + 原子 promotion 三项不变量全部通过。

## 4. 复现契约

正式结果关联一个构建 ID，可定位：

- 输入来源与版本（accession、GPL 平台、下载 URL、文件 hash）；
- 处理链路与参数（adapter 版本、normalization profile、AdapterParams、merge strategy）；
- 验证结果（validation profile、rejected/conflicts 审计）；
- 产物清单（schema.json / dataset_manifest.json / provenance.json / primary.csv）。

无法保存受限输入时，至少保存来源、访问方式、结构说明与生成步骤。

## 5. 报告分层

- **用户可见汇报**：结论摘要、关键质量事实、来源追溯摘要、局限与下一步——不堆内部
  台账/规则矩阵/文件清单；
- **审计产物**：rejected / normalization_log / field_mappings / platform_audit 等以
  artifact role 发布，供需要时单独交付；
- 引用产物时用 `list_files` 查看实际文件名，不编造文件名或列名。

## 6. 失败与部分成功

- `partial_success`：读 `rejected_sources` 与拒绝原因，说明哪些 binding 成功、哪些被拒
  及原因；
- `no_data`：读 `reason_codes`（如 `no_primary_data`、probe 映射缺失），按 `cleaning`
  主题诊断；
- 已发布但 run 非成功（配额/取消窗口）：说明产物存在于磁盘与 publication 未登记的关系，
  不冒充成功。
