
## 完整记录（不丢弃）

- durable 权威事件流（未脱敏，1005 事件含全部思考正文与 60 条精确 usage）：`events-durable.jsonl`；原始位置 `data/output/tasks/${TASK}/events.jsonl`（保留勿删）
- `assistant-messages.md`：全部 assistant 正文；`prompt-gold1.txt`：TOPIC 原文
- `closure.json`：终态 + `run_usage`（本 run 为 usage 记账在正式 gold 闭环上的首份完整记录）
- `events.jsonl`：supervisor journal（仅 seq≤207，进程死于 Host 瞬时 500）；`permissions.jsonl`：bash-gzip 停审记录
