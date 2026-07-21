# 问题/issue 收集文档

- [X] (260721-60880a41a8f68cba552c9c513d4d84ee407902c8) 正常启动前后端后输入 prompt，前端直接显示“任务执行失败”，控制台和前端均未显示具体原因。
  - 状态：已解决（2026-07-21）。
  - 根因：动态 instructions callable 只有 `(context)` 一个参数，不符合 OpenAI Agents SDK 0.18.2 要求的 `(context, agent)` 契约，首轮模型调用前即失败。
  - 修复：补齐二参数签名，并由 `tests/test_agent.py::test_dynamic_instructions_resolve_through_sdk` 通过 SDK 公共解析边界提供回归保护。详细诊断见 `docs/ARCHITECTURE.md` §8.5。

* [ ] (260721)设置界面skill选项卡下无法正常调整skill（主要包括 用户skill的引入、已引入skills的启停）

* 注：数据库这个界面我不懂，我就只提skill这里的（意为设置界面问题可能并不全面
* 状态：未解决

* [ ] (260721)完成模型设置后，主页面工作区模型选择存在问题。

* 状态：未解决
* 具体说明：问题在于只要配置apikey后就会显示Qwen系列的四个模型，即使你接入ds的模型。进一步说明这里的没有发挥任何配置作用
* 修改意见：建议保留最初设计，让这里同步为设置界面的model list，如果考虑到qwen主体地位，建议在检索到qwen模型时优先展示，并将最强基座模型标注为推荐模型
