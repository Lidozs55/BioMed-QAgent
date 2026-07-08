# AGENT.md — Agent 协作工作流规范

> 本文件规定所有 agent（含人类协作者）接入 Commonly 平台时的工作流、文件锁定、消息、Git 与文档维护规范。
> **任何 agent 在开始项目工作前必须先读本文件。**

---

## 一、协作模型

BioMed QAgent 通过 Commonly pod 协作：

- **podId**：`6a4dce09667e4495bb265b4a`（所有 Commonly 工具调用的 podId 固定用此值）
- **pod 名称**：BioMed QAgent
- **成员**：人类协作者 + 一个或多个 agent

**核心原则：拉取式（pull），非推送式。** @ 提及不会自动唤醒 agent；agent 必须在 TRAE 会话中主动调用 `commonly_get_tasks` / `commonly_get_messages` 拉取最新状态。人类需要 agent 响应时，须在 TRAE 侧发起对话触发 agent 运行。

---

## 二、任务生命周期

任务在 Commonly 任务板上流转：

```
pending → claimed → completed
```

### 2.1 接手工作的标准流程（每次会话开始时执行）

1. **拉取任务板** — `commonly_get_tasks`（先查 `status=pending`，再查 `claimed`）
2. **拉取最近消息** — `commonly_get_messages`（limit=40，查看讨论与文件锁）
3. **认领任务** — `commonly_claim_task`（taskId），同一时间只 claim 一个任务
4. **声明文件锁** — 见第三节
5. **执行任务** — 对照 `ARCHITECTURE.md` 与 `PROBLEM.md`
6. **验证** — AST 检查、import 链、前端 tsc、后端重启确认
7. **push 代码** — 见第五节
8. **解封文件锁** — 见第三节
9. **完成任务** — `commonly_complete_task`
10. **发消息通知** — `commonly_post_message`，简述完成内容与影响范围

### 2.2 创建新任务

发现新待办项时：

1. `commonly_create_task`，title 加 `[P0]`/`[P1]`/`[P2]` 优先级前缀
2. `source` 字段填写来源文档路径（如 `ARCHITECTURE.md 3.2`）
3. 有硬依赖时填 `dep`（前置 taskId）
4. 在 pod 发消息说明任务背景与预期产出

### 2.3 任务状态约束

- 一个 agent 同时只 `claim` 一个任务，避免上下文切换
- `complete` 任务前必须确认：代码已 push、文件锁已解封、相关文档已更新
- 任务卡住超 1 轮对话无法推进时，发 `[BLOCKED]` 消息并 unclaim，让其他 agent 接手

---

## 三、文件锁定机制（避免 git 冲突）

Commonly 无原生文件锁，采用基于消息的轻量协议。目的：让多个 agent 并行工作时不会修改同一文件，避免 git merge 冲突复杂化。

### 3.1 加锁

claim 任务后、修改任何文件前，在 pod 发送锁定消息：

```
commonly_post_message:
  content: "[LOCK] TASK-XXX: backend/app/agents/search.py, backend/app/tools/registry.py"
```

约束：

- 一个任务最多锁 **5 个文件**；超出需拆分任务
- 锁的是"即将修改"的文件，不是整个模块目录

### 3.2 检查锁

修改任何文件前，先 `commonly_get_messages`（limit=20），扫描最近消息中是否有 `[LOCK]` 且无对应 `[UNLOCK]`。若目标文件被锁，且锁该文件的用户并非自己，则：

- 等待锁持有者 push 解封，或
- 发 `[Q]` 消息与锁持有者协商

### 3.3 解锁

push 代码后立即发：

```
commonly_post_message:
  content: "[UNLOCK] TASK-XXX"
```

`commonly_complete_task` 前必须确保该任务所有锁已解封。

---

## 四、消息与讨论规范

### 4.1 消息前缀约定

| 前缀                    | 用途        |
| --------------------- | --------- |
| `[LOCK]` / `[UNLOCK]` | 文件锁定状态    |
| `[TASK]`              | 任务看板更新通知  |
| `[Q]`                 | 提问 / 讨论征询 |
| `[DONE]`              | 任务完成通知    |
| `[BLOCKED]`           | 阻塞 / 风险提示 |

### 4.2 讨论规则

- 涉及架构决策、不确定的技术选型，先发 `[Q]` 消息讨论，不要擅自决策
- 回复特定消息时用 `replyToMessageId` 做线程回复，保持上下文
- 纯 `@agent-name` 无实质内容的不必逐条回复

### 4.3 避免噪声

- 不发无实质内容的消息
- `[DONE]` 通知用一条消息概括改动 + 影响，不逐条刷屏
- 拉取消息后，已处理过的讨论不重复回复

---

## 五、Git 工作流

### 5.1 提交时机

- **每完成一个 Commonly 任务**：commit + push 一次
- **不跨任务累积 commit**：便于通过 taskId 追溯
- commit message 格式：`[TASK-XXX] 简述`（对应 Commonly taskId）

### 5.2 提交前验证清单

push 前必须确认：

- [ ] Python 文件 AST 检查通过
- [ ] import 链正常（无循环引用、无缺失模块）
- [ ] 前端 `tsc` 0 error（若改动前端）
- [ ] 后端 `uvicorn --reload` 重启正常，工具数符合预期
- [ ] 不提交 `.env`、`__pycache__`、`data/` 运行时数据

### 5.3 重启约定（后端改动后）

1. 清理所有 `__pycache__` 目录
2. kill 所有 Python 进程
3. `uvicorn app.main:app --reload` 启动
4. 确认工具注册数、路由正常

> 原因：`uvicorn --reload` 可能加载 `__pycache__` 中旧 `.pyc`，导致代码改动不生效。

### 5.4 分支与 force push

- 默认在主分支工作（除非团队约定分支策略）
- **绝不 force push 到主分支**
- push 失败因远端有新提交时，先 `git pull --rebase`，不 force
