# PRE-03 静态退役扫描（Run #2）

- **case_id**：PRE-03
- **Commit**：`be78a1a577a9d20cec4cefb3b604661f0187a59c`
- **日期**：2026-08-15
- **结果**：PASS

## `git ls-files backend`

空（无 tracked 文件）—— M01-T01 同时满足。

## active source 扫描

扫描范围：`server/src`、`frontend/src`、`packages`、`scripts`、`package.json`、
`.env.example`、`.github`。

命中 1 处，且为**说明性注释**，非 active 运行时引用：

```text
.env.example:22:# Core；Phase 8 起不再有 APP_HOST/AGENT_RUNTIME/DATASET_CORE/PI_EXPERIMENTAL
```

判定：`文档历史引用`（明确声明“不再有”），不构成回归。其余 active source
无 FastAPI/Uvicorn/Python Runtime spawn/legacy proxy/退役 flag 命中。
