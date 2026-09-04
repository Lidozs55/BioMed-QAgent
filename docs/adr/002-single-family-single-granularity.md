> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 4. ADR-002：一个 DatasetBuild 只能有一个主数据集族和一种行粒度

### 状态

已接受。

### 决策

一个 Build 的主数据必须满足：

```text
dataset_family + row_granularity + key_semantics + measurement_semantics
```

均明确且兼容。

### 示例

可以合并：

- 多来源 gene-sample expression；
- 多论文中采用同一指标和同一对象粒度的实验测量；
- 多数据库的 pathway-member 记录。

不能直接合并：

- 表达行与突变事件行；
- 基因-样本测量与队列聚合统计；
- 文献元数据与表达测量；
- 通路节点与临床样本；
- 原始 count 与 TPM，除非明确转换或保持可区分语义。

### 复合需求

复合需求拆成多个 Build。会话可将多个 Build 放在同一任务下，但每个 Build 独立验证和发布。

### 后果

`main_data.csv` 的“单一行粒度”原则保留，但文件名、列结构和数据族不再固定。

---
