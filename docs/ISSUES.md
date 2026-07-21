# 问题/issue 收集文档

- [x] (260721-60880a41a8f68cba552c9c513d4d84ee407902c8) 正常启动前后端后输入 prompt，前端直接显示“任务执行失败”，控制台和前端均未显示具体原因。
  - 状态：已解决（2026-07-21）。
  - 根因：动态 instructions callable 只有 `(context)` 一个参数，不符合 OpenAI Agents SDK 0.18.2 要求的 `(context, agent)` 契约，首轮模型调用前即失败。
  - 修复：补齐二参数签名，并由 `tests/test_agent.py::test_dynamic_instructions_resolve_through_sdk` 通过 SDK 公共解析边界提供回归保护。详细诊断见 `docs/ARCHITECTURE.md` §8.5。
