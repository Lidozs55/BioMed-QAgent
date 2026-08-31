# Gold 评测规则（data/gold/）

`data/gold/` 存放参考输入/输出案例（gold1～gold10），用于端到端评测与论文实验。
当前处于论文写作阶段：遇到的问题仅记录 + 分析，不落地代码修改。

## 案例结构

每个案例（`gold<N>_*/`）包含：

- `TOPIC.txt` — 用户需求原文，**唯一合法的任务输入**
- 参考 CSV / JSON 与 `provenance.json` — 仅用于事后对照（参考输出并不唯一正确）
- `raw/` — 原始 API 响应存档，仅用于核对，禁止喂给 agent

## 模型与上下文

- 模型：统一使用 qwen3.8 系列
  - 当前阶段：**qwen3.8-flash**
  - 后续单例对照实验：qwen3.8-max、qwen3.8-27b、qwen3.8-2.4t-a95b
- 上下文窗口：**统一 1M**

## 输入约束

- 输入仅允许使用各 gold 下的 `TOPIC.txt` 原文
- 严禁混入参考 CSV、`provenance.json`、`raw/` 内容，禁止以参考数据冒充 run 产物

## 运行与记录

- 运行方式遵循 `docs/gold-formal-rerun.md`（formal rerun supervisor，fail-closed 协议）
- 每次 run 的记录追加到 `data/gold/<case>/runs-log.md`
- 评测中发现的问题：仅记录现象与分析（写入 `runs-log.md` 或 `docs/evaluation/`），不做修复