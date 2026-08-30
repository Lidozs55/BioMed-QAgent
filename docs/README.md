# 文档地图与维护规则

仓库的统一首入口是 [`../README.md`](../README.md)。本文是 `docs/` 内部的详细地图，回答“某类信息应该去哪里找、由谁维护、何时归档”，不与根 README 竞争项目入口职责。系统行为仍以代码为最终事实；各主题的权威文档如下。

## 先读什么

| 需求 | 文档 | 职责 |
| --- | --- | --- |
| 了解产品与评分目标 | [`../PROBLEM.md`](../PROBLEM.md) | 外部问题与评价标准 |
| 了解系统边界与组件 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | 现行技术架构入口 |
| 了解已具备能力 | [`FEATURES.md`](FEATURES.md) | 面向产品/汇报的能力现状 |
| 本地安装与开发 | [`DEVELOPER_QUICKSTART.md`](DEVELOPER_QUICKSTART.md) | 可执行的开发流程 |
| 查看当前工作 | [`TODO.md`](TODO.md) | 仅开放任务与验收条件 |
| 查看已知缺陷 | [`ISSUES.md`](ISSUES.md) | 仅可复现或待验证的问题 |
| 理解决策原因 | [`adr/README.md`](adr/README.md) | ADR 索引与状态 |
| 查看未来方向 | [`architecture/roadmap.md`](architecture/roadmap.md) | 非任务化的演进方向与非目标 |
| 调用 Agent API | [`AGENT_API_QUICKSTART.md`](AGENT_API_QUICKSTART.md) | HTTP/WS 操作手册 |

架构章节位于 `architecture/`，由 [`ARCHITECTURE.md`](ARCHITECTURE.md) 的章节地图索引。评估固件及其运行说明位于 `evaluation/`；审计快照位于 `audit/`；日期化汇报材料位于 `reports/`。

## 生命周期

每份非历史文档必须属于一种类型：

| 类型 | 放置位置 | 可以包含 | 不应包含 |
| --- | --- | --- | --- |
| 现行规范 | `ARCHITECTURE.md`、`architecture/`、`adr/` | 当前边界、契约、已接受决策 | 分支进度、临时任务 |
| 操作指南 | 根 `README.md`、`DEVELOPER_QUICKSTART.md`、专题 quickstart | 可执行命令、故障排查 | 架构决策全文 |
| 产品说明 | `FEATURES.md`、`reports/` | 能力与演示叙事 | 新的技术权威定义 |
| 评测研究 | `reports/`（如 [`reports/2026-08-29-gold-qwen-direct-validation-study.md`](reports/2026-08-29-gold-qwen-direct-validation-study.md)） | 带日期的多轮评测结论、失败模式与修复映射 | 散装 run 日志（归 runs-log 与证据包） |
| 当前计划 | `TODO.md`、`plans/` | 开放任务、验收条件、确有需要的活跃计划 | 已完成日志、长期架构解释 |
| 问题追踪 | `ISSUES.md` | 可复现问题、影响、下一步 | 已关闭问题全文 |
| 证据快照 | `audit/`、`evaluation/` | 带日期/commit 的审计和评估证据 | 无时间边界的“当前状态” |
| 历史记录 | `archive/`、`migration/` | 已完成、被替代或仅供追溯的材料 | 对当前实现的规范性要求 |

`migration/` 专门保存已完成迁移的历史证据；`archive/` 保存其他已完成计划、评审、运行日志和被替代文档。两者都不是当前行为依据。

## 维护约束

1. 一个事实只有一个权威位置；其他文档用链接和一句上下文引用，不复制完整定义。
2. `TODO.md` 只保留开放工作。完成项由提交历史、Commonly board 和必要的归档快照追溯。
3. `ISSUES.md` 只保留仍开放的问题；修复提交必须带回归测试，关闭后移除条目。
4. 超过一个迭代的方案才进入 `plans/`，并在首屏写明 owner、状态、创建日期和退出条件；完成或被替代后整份移入 `archive/plans/`。
5. 日期化报告、审计和基准必须标注验证日期及 commit；它们是快照，不自动更新为当前事实。
6. 架构边界变化通过新 ADR 决策，并同步 `ARCHITECTURE.md`；不得在 TODO、Prompt 或实现笔记里悄悄改写。
7. 移动文档时必须更新 current 区域的引用并运行相对链接检查。历史区允许保留上下文，但不得从 current 文档把历史材料描述为现行规范。

## 本轮归档说明

2026-08-24 的维护将已完成的 Family Host 批次计划、Gold/Canonical Evidence 近期计划、`superpowers` 执行稿、运行日志、被替代的 Family Host 架构笔记和旧 TODO/ISSUES 快照移入 `archive/`。日期化项目汇报移入 `reports/`。内容未删除，旧 Git 历史仍可完整追溯。
