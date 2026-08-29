# 模型卡点收集（gold 正式运行观察）

> 目的：集中收集各 gold 案例正式运行中暴露的 **Agent 行为卡点**（提示词、产品、接口陷阱三类），供后续**批量**修复与提示词优化对照。
> **当前处于收集期：只登记，不修改代码。** 等组员把其余案例测完后再统一分流修复（跟踪项见 [TODO](../TODO.md)）。
> 纪律：每条卡点必须给出证据（事件 seq / 证据包路径 / 正文原话），不可证的不进表；证据包在 `data/gold-runs/`（git 忽略，随 run 机器保留）；用量与终态见各包 `closure.json`（`run_usage`）。

## 条目模板

```markdown
### <case> @ <model>（<日期>，main@<commit>，task_ts_…）

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
```

归类：**prompt**（提示词可解）/ **产品**（需改代码或适配器）/ **接口陷阱**（工具行为反直觉）。

## gold1 @ qwen3.7-plus（2026-08-29，main@5ac29b1dbf7d，task_ts_374f1e07-7255-41c3-92b7-6357c04ff12d）

> ⚠️ 模型身份更正：此 run 标称 qwen3.8-flash，**实际执行 qwen3.7-plus**（原因见 B7）。B1–B6 观察均基于 3.7-plus 行为；qwen3.8-flash 的真实行为以复跑 r2 为准。
> 证据包 `data/gold-runs/5ac29b1dbf7d-gold1-qwen37plus-misrun-r1/`；终态 completed / **blocked_no_publication**；35 次模型调用、275s、input 663,823 / output 6,510 / cache_read 2,012,800、上下文峰值 109,936。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| B1 | **无法检视下载内容 → 全程盲猜适配器参数**。`preview_core_asset` 对 `.gz` 只返回 gzip 二进制（"无法直接读取文本"）；`extract_core_archive` 对刚下载的补充文件报 `registered asset was not found`（seq 754）；同一 matrix asset preview 首次 not found（seq 209/224）、execute 走过一遍后才可解析（seq 548）。模型对 4.2MB 补充 CSV 的列结构零感知，`format/value_semantics/value_scale/expression_unit` 全靠文件名猜（rpkm 被拒→log2_expression 过 validate→execute 仍 parse_error/build_error） | 产品 | events-durable.jsonl seq 209/224/548/677/754；正文"看起来资产可能不在当前任务上下文中" | preview 自动解包 gzip 文本成员；download 成功即注册可解析 asset；`execute` 失败 detail 透出适配器期望布局 |
| B2 | **动态路由零调用（想象复杂度）**。正文 4+ 次说"让我尝试动态路由"，下一段总以"考虑到时间和复杂性"收回；`prepare_dynamic_family_publication` / submit 调用数 = 0，尽管 [Dynamic publication mechanics] 已教学、receipt-referenced submit 已上线、preflight 成本极低 | prompt | assistant-messages.md 134/162/166/194 行"尝试→收回"循环；`prepare_dynamic: false` | 提示词加硬阈值：静态 execute 同类失败 ≥2 次后，blocked 终态前必须至少实际调用一次 dynamic preflight |
| B3 | **幻觉外部时限**。终答"由于时间限制和复杂性…暂停等待用户指示"；实际 `agent_max_turns=240` 仅用 35 次，系统亦无墙钟限制 | prompt | 终答原文；runs-log.md 用量表 | 提示词写明预算事实（回合数、无墙钟时限），禁止以"时间限制"作为放弃理由 |
| B4 | **同路重复撞墙**。GSE318780 静态路由猜参 4 连败（seq 432/460/474/521）后换 GSE343732 仅换数据集不换路线，再吃 `no_primary_data`（seq 659）；7 次 is_error 才开始考虑策略变化，最终也没换成 | prompt | tool_completed is_error 序列：seq 474/521/659 + validate 失败 432/460/645 | 换参重试 ≤2 次的止损规则；换数据集前先判定"路线能力边界" |
| B5 | **未先 activate 就调用工具**。`search_geo not found`（seq 38）、`preview_core_asset not found`（seq 209），随后共 6 次 `activate_agent_tools` 分批解锁；每案例固定损耗 ~2 回合 | 接口陷阱 | `not_found errors: search_geo@38, preview_core_asset@209`；activate ×6 | 提示词交代懒加载工具面规则（先查 skill→tool 映射再调用）；或工具报错文本内联提示 activate 用法（现已部分存在，观察是否可见性不足） |
| B6 | **GDC 替代源浅尝辄止 + 搜索结果相关性差**。`search_gdc("breast cancer TCGA")` 首结果 TCGA-**LUAD**（肺癌，seq 809）；`describe_gdc(TCGA-BRCA)` 已确认 1098 病例 / 4876 转录组文件（seq 823，可行路径！），模型一句"需要更多配置"放弃，零次 validate 尝试 | prompt + 产品 | seq 809/823 输出；正文 150→160 行 | search_gdc 查询词到 project 的映射排序修复；提示词：候选源已被证实存在时必须完成一次最小 formal 尝试再比较成本 |
| B7 | **【环境陷阱】settings PUT 与实际执行模型不一致 → 静默跑错模型**。`PUT /api/v1/settings {model_name}` 只改 `settings.model_name`（显示层），但 `resolveActiveConfig` 用 `active_model_id` 指向的 registry model 记录（`model?.model_id ?? settings.model_name`）。Host 启动时 `bootstrapEnvironmentDefaults` 从 env 引导出一个 `model_dashscope_env_default`（model_id=当时的 qwen3.7-plus、context_window=1M、active=true）；之后 PUT 只改 `settings.model_name=qwen3.8-flash`，未动 active model 记录→**35 次调用全部实际打到 qwen3.7-plus、窗口 1M**（Pi session `model_change` 条目与 assistant.message.model 均为 qwen3.7-plus，铁证），与控制台 qwen3.7-plus 扣费一致。`GET /api/v1/settings` 又回显 `settings.model_name`，看似"已切 3.8-flash"，掩盖了不一致 | 产品（设置接线） | pi-session jsonl `model_change provider=dashscope modelId=qwen3.7-plus`；assistant `model:"qwen3.7-plus"`；registry active=`model_dashscope_env_default`(qwen3.7-plus/1M) 而 settings.model_name=qwen3.8-flash/256k | 正确做法：走 `POST /api/v1/model-registry/models` 建 3.8-flash 记录 + `.../activate`（会同步 settings）；**修复方向**：PUT settings.model_name 若与 active model 冲突应拒绝或级联切换 active；`GET /settings` 应回显真正解析出的 `resolveActiveConfig().modelId` 而非 `settings.model_name`；运行前用 session `model_change` 条目做身份断言。**部分修复（2026-08-29）**：`store.ts` 两处硬编码 `?? "qwen3.7-plus"` 已删除——无 env 模型名时 bootstrap 只注册 provider+key、绝不臆造 active model，`resolveActiveConfig` fail-closed；PUT/active 级联与显示层 truth 化仍待分流修复 |

## gold7–gold10 @ 复跑（2026-08-29 之后，待组员执行）

（空。每完成一个案例，按模板追加；同步把 `closure.json` 的 `run_usage` 抄入本表上方案例头部，便于比较提示词/路线变化对 token 的影响。）

## 已登记的兄弟事实（不重复展开）

- gold8 枚举 555 次 / DILIrank 404 韧性缺口 → [ISSUES](../ISSUES.md) 与 [TODO](../TODO.md) 已各有条目；本文档只在案例复跑暴露**新的行为面**卡点时补条目。
- gold9 跨源空列（回答宣称与发布表不符）→ TODO "gold9 跨源数值列行级填充率门"。
- 行为观察类（浏览器绕路、思考模式等）历史细节见 `data/gold/` 各案例 runs-log（本机）。
