# 已废弃：核心架构基础设计

> 本设计已被团队于 2026-07-12 达成的新共识取代，请勿继续按本文原方案实施。

原方案计划引入独立 `AgentRuntime`、通用 `SkillExecutor`、应用分层和任务平台。团队复核后决定继续以 OpenAI Agents SDK 为运行核心，采用“Main Agent + 统一 Skill 仓库 + SDK Function Tool”的轻量架构。

当前唯一架构依据：

- [BioMed-QAgent 架构设计](../../ARCHITECTURE.md)
- [开发 TODO](../../TODO.md)

原方案中仍然有效的关注点仅包括：SDK 流式事件映射、前端 WebSocket 所有权、文件路径安全和可执行测试。其余分层和运行时隔离要求不再适用。
