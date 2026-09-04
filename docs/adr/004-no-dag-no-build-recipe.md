> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 6. ADR-004：不采用完整 DAG，也不新增 BuildRecipe

### 状态

已接受，除非未来需求发生显著变化。

### 决策

Dataset Runtime 使用服务端固定、可测试的构建骨架：

```text
acquire[*]
  -> parse[*]
  -> canonicalize[*]
  -> compatibility gate
  -> integrate
  -> validate profile
  -> publish
```

来源步骤可以内部并发。Runtime 记录 OperationAttempt、输入输出 digest 和恢复点，但 Agent 不自由生成 nodes/edges，也不声明数据集级 Recipe。

### 与现有 WorkflowRecipe 的关系

仓库已有 `WorkflowRecipe`，其步骤限定为受控 API、HTML 和 Browser 操作，并拒绝 Python、JavaScript、Shell 等任意代码字段。它保留，但边界限定为 Acquisition：

```text
SkillBuilderAgent
  -> WorkflowRecipe draft
  -> controlled validation
  -> VERIFIED/PROMOTED
  -> RecipeExecutor
  -> SourceAsset
  -> SourceAdapter
```

WorkflowRecipe 不能：

- 产生 Canonical DataBatch；
- 声明跨来源依赖；
- 决定合并；
- 选择 Validation Profile 或阈值；
- 直接发布 Dataset。

“non-executable”只表示 Recipe 不包含任意可执行代码，不表示 Recipe 不会由可信解释器执行。

### 当前代码缺口

当前 `RecipeExecutor.execute()` 和 `find_verified()` 主要面向 `VERIFIED`，而 `PROMOTED` Recipe 的正式发现和执行闭环不明确。V2 要求：

- `PROMOTED`：生产 Build 可自动发现和执行；
- `VERIFIED`：仅受限试用或 HIL 确认；
- `DRAFT/REJECTED`：不得进入生产执行。

### 为什么不使用 DAG 或 BuildRecipe

- 当前流程主体近似线性；
- 并行来源不等于需要通用图调度器；
- 完整 DAG 增加大量基础设施，不直接提高评分；
- 新增 BuildRecipe 会与 WorkflowRecipe 命名和生命周期冲突；
- 代码当前真正缺少的是数据契约、兼容性判断和 Recipe 消费闭环，不是图执行。

### 重新评估触发条件

只有当用户自定义任意分析链、多级条件分支、节点复用和分布式执行成为核心需求时，才重新评估 DAG。
