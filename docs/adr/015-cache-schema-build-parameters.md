> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 17. ADR-015：Cache 由 Schema 和构建参数标识，不由关键词或固定列标识

### 状态

已接受。

### 决策

缓存身份包含：

- dataset family；
- Schema version；
- SourceAsset digest；
- Adapter/parser version；
- normalization profile；
- cohort/query parameters。

关键词用于检索缓存，不用于决定资产身份。

### 当前踩坑

现有 Cache Design 为复用 Pipeline，固定采用 22 列 `main_data.csv`。这减少了一套 Schema，却把表达任务的实现细节扩散成全局协议。

---
