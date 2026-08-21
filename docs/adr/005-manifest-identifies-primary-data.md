> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 7. ADR-005：主数据通过 Manifest 识别，不依赖固定文件名

### 状态

已接受。

### 决策

输出包含一个 `dataset_manifest.json`，其中显式标识：

- 主数据路径；
- dataset family；
- row grain；
- Schema；
- 主键；
- 行数和 hash；
- 来源、验证、置信度和 provenance 摘要。

可为 Demo 提供 `dataset.csv`，但程序不得硬编码该文件名。

### 影响

需要迁移：

- Artifact Builder；
- Validation；
- Cache；
- API；
- 前端 ResultsViewer；
- 测试 fixture；
- 文档。

---
