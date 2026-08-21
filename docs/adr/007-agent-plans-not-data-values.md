> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 9. ADR-007：Agent 决定计划，不决定科研数据值

### 状态

已接受。

### Agent 权限

- 解析需求；
- 选择或建议 Schema；
- 查找候选来源；
- 选择 Acquisition Provider、Adapter 或已允许的 WorkflowRecipe；
- 提议字段映射；
- 直接生成自包含 DatasetBuildSpec；
- 根据诊断重新规划。

### 服务端权限

- 下载和校验文件；
- 运行 Parser；
- 读取源值；
- 执行确定性转换；
- 批准字段映射；
- 判断兼容性；
- 管理验收阈值与 Validation Profile；
- 计算质量和置信度；
- 发布。

### 禁止

Agent 不能直接提交一个数字并声明它来自论文、图表或数据库。模型提取必须绑定 SourceAsset、定位信息、模型版本、置信度和审核状态。

---
