> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 15. ADR-013：置信度先做可解释等级，不做虚假概率

### 状态

已接受。

### 决策

置信度包含：

- level：high/medium/low；
- channel；
- reasons；
- source reliability；
- extraction reliability；
- mapping reliability；
- validation result；
- cross-source consistency；
- human review state。

确定性官方 API 可以使用批次默认等级；VLM/LLM/网页抽取必须逐条标注。

### 原因

未经标定的 0.92 看似精确，实际没有概率解释。赛题更需要可解释、可追溯和可复核。

### 与 Validation 的关系

置信度不是 Validation 的替代。Validation 判断是否满足发布规则；Confidence 描述记录在已知证据下有多可靠。

---
