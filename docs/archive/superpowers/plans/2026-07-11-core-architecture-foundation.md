# 已废弃：Core Architecture Foundation Implementation Plan

> 本计划已被团队于 2026-07-12 达成的新共识取代，请勿继续执行其中的分层重构任务。

团队决定：

- 保留 OpenAI Agents SDK 作为 Agent loop、Tool 调用、Streaming、Session 和 HITL 的运行核心；
- 不创建平行的 `AgentRuntime` Port；
- 不建立通用 `SkillExecutor`；
- 不采用 `domain/application/ports/infrastructure` 四层重构；
- 使用一个 Main Agent、统一 Skill 仓库和 SDK Function Tool；
- 区分内置 Skill 与后天 Skill；
- 一个网站对应一个或多个 Tool，同类网站可以归入同一 Skill。

当前执行依据：

- [BioMed-QAgent 架构设计](../../ARCHITECTURE.md)
- [开发 TODO](../../TODO.md)
- [Skill Repository 文档更新计划](2026-07-12-skill-repository-docs-update.md)

仍应优先解决的已有问题：

1. OpenAI Agents SDK 流式事件映射；
2. 前端 WebSocket 连接和发送必须由同一实例管理；
3. 文件路径和任务工作目录安全；
4. Tool、Skill 和端到端流程必须具备可执行测试。
