> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 11. ADR-009：字段字符串相似度只能提议映射，不能批准映射

### 状态

已接受。

### 决策

正式字段映射必须来自：

- Adapter 声明；
- Schema Registry；
- 可信元数据；
- 明确规则；
- 人工批准。

字符串相似度可生成候选和置信度，但默认状态为 `proposed`。

### 原因

列名相似无法证明：

- 同一语义；
- 同一单位；
- 同一粒度；
- 同一值域；
- 同一实体 ID；
- 一对一关系。

### 当前踩坑

`alignment.py` 的包含关系和公共前缀规则足以将看似相似、实际不同的字段对齐。之后垂向合并会让错误进入正式数据。

---
