# Gold 直问验证研究：多模型护栏纵深与能力分层（2026-08-29）

> 本文归档 2026-08-29 一天内、围绕 gold7（阿尔茨海默 GWAS 多源整合）开展的
> **10+ 轮多模型直问验证 campaign**：测试方法学重置、逐轮失败模式与护栏拦截记录、
> 由此落地的产品修复清单、以及"模型能力分层"的可复现结论。
> 权威事实来源为各证据包与 `data/gold/gold7_alzheimer_gwas/runs-log.md`；本文是
> 导览与结论，不重复细节。

---

## 1. 背景与目标

赛题要求基于国产开源大模型的科研数据整合系统。2026-08-28 的 gold7/8/9 三案例
正式发布均由 DeepSeek-V4-Flash 完成；本次 campaign 要回答的问题是：

1. 换用 Qwen 系模型（含更低位的 flash 档）时，正式发布全链路是否可用？
2. 失败发生时，系统的护栏（preflight 校验、quarantine 准入、supervisor 白名单、
   占位符筛查）是否都能在正确的层拦截？
3. 哪些失败暴露的是**产品缺口**（应修产品），哪些是**模型能力边界**（应如实分层）？

## 2. 方法学重置（本轮确立，永久有效）

campaign 初期曾把 prepare/submit 契约细节写进用户提示词（"已知良好骨架"、
"两阶段 digest 规则"等）；经裁决废除。**正式测试方法**（详见
[../gold-formal-rerun.md](../gold-formal-rerun.md) §Test-prompt methodology）：

1. **直问**：`POST /api/v1/tasks` 直接以真实研究问题建任务，自动启动的 Run 1
   就是被测 Run（废除 bootstrap 占位任务——残留指令曾被轻量模型在收尾时服从，
   见运行矩阵 r1）；supervisor 以 `--adopt` 附加采证。
2. **人类可信提示词**：用户消息只含主题/方向/目标产物（gold7 即 412 字节的
   `TOPIC.txt` 原文）；机制与约束属于系统提示词与工具描述。

## 3. 运行矩阵（按时间序）

| # | 基线 | 模型 | 结局 | 首要失败模式 | 拦截层 | 随后落地的修复 |
| --- | --- | --- | --- | --- | --- | --- |
| r1 | 57af4fec | qwen3.7-flash | blocked | bootstrap 残留指令劫持（尾段只回 READY） | —（提示词层） | bootstrap 废除 → `--adopt` |
| r2 | 57af4fec | qwen3.7-flash | blocked | prepare 契约 25 次不收敛（含 2 次自造 digest） | preflight 逐字段校验 | 已知良好骨架 → 后转正进工具描述/系统提示词 |
| r3 | 57af4fec | qwen3.7-flash | 拦停 | submit 回显失真 ×12 后请求读取 `D:\` | supervisor 白名单 | receipt-only submit；两阶段 digest 说明 |
| r4 | 57af4fec | qwen3.7-flash | **发布成功但内容为占位符空壳** | 占位行（UNKNOWN/NONE/placeholder） | 未拦住 → 立案 [ISSUES P1] | `PLACEHOLDER_CONTENT` 准入筛查（main@22d87d15 前身） |
| r5 | 57af4fec | qwen3.8-flash | blocked | transform 输出表头与声明差一字段 | quarantine `OUTPUT_HEADER_MISMATCH` | 沙箱方言进系统提示词 |
| r6 | 57af4fec | qwen3.8-flash | blocked | 三类拒绝循环不收敛（35 prepare/18 submit） | preflight + quarantine | prepare 键差报错（missing/unexpected 点名） |
| 隔离1 | 635025ba | deepseek-v4-flash | blocked | 首次 prepare 墙前放弃（2 次），转工作区 | supervisor（诚实分类） | 温度假设提出（0.2 vs 0.7） |
| 隔离2 | 635025ba | deepseek-v4-flash | 拦停 | 2 分钟直奔 python 解 zip | supervisor | 证伪温度杠杆 → 确认数据可见性缺口 |
| 直问1 | b98db211 | qwen3.7-flash | 拦停 | 盲写 transform 触沙箱拒绝后转 python | supervisor | 沙箱方言进系统提示词 |
| 直问2 | 635025ba | qwen3.7-flash | blocked | **零正式尝试**即交"临时结果+假阻塞" | supervisor 诚实分类 | （待办）end-of-run publication gate |
| 直问3 | 22d87d15 | qwen3.7-flash | 拦停 | 发布评估 `resource_measurement` 拒绝后转 python | supervisor | receipt-only wire 绑定修复 + 拒绝携带 check detail |

> 直问3 的完整链路：prepare 成功（receipt-only）→ submit 穿过校验 → transform
> 真实执行 → 产物进入发布评估 → 被资源预检拒绝。与 08-28 deepseek 首跑收敛相比，
> 差距收敛为两级台阶 + 绕路冲动。

## 4. 由此落地的产品修复（全部在 main）

| 修复 | 内容 | 位置 |
| --- | --- | --- |
| receipt-only submit | `submit_dynamic_family_publication` 接受 `{schema_version, preflight_receipt}`，服务端按 coordinator 存储解析 prepared submission；全量回显仍兼容 | `agent/tools/dynamic-family-publication.ts`、`runtime/dynamic-family-preflight-coordinator.ts`、`runtime/phase3-composition.ts` |
| 占位符内容筛查 | 数据行含哨兵词单元格（placeholder/unknown/tbd/n/a/not_found/no_records_found_in_input_json）或整行无真实值 → `PLACEHOLDER_CONTENT` 拒绝 | `dataset/transform-admission/`（[ISSUES](../ISSUES.md) P1 第一层） |
| 机制系统提示词 | `[Dynamic publication mechanics]` 段：digest 由 Core 派生、role 绑定、闭包等式、receipt-only submit、transform 沙箱方言（禁括号取值）、binary_archive 用 preview/extract 工具 | `agent/phase1-prompt.ts`（cap 7400） |
| prepare 键差报错 | strict 校验失败点名 `missing/unexpected` 键；prepare 描述内嵌顶层键清单 | `agent/tools/dynamic-family-publication.ts` |
| 发布拒绝带详情 | "not publishable" 消息携带失败 check 的 `detail`（如资源决策 JSON） | `dataset/dynamic-family/publication.ts` |
| supervisor `--adopt` | 附加到任务现存/最新 Run 采证，废除 bootstrap；`POST /api/v1/tasks` 的直问 Run 即被测 Run | `scripts/gold-formal-supervisor.mjs` |
| Core 资产预览/解压工具 | `preview_core_asset`（zip 成员清单/成员头部文本）与 `extract_core_archive`（成员 → 新注册 Core 资产，derived 溯源），stdlib zlib 实现，无子进程无 7z | `agent/tools/core-asset-tools.ts`、`dataset/transform-host/zip.ts` |

## 5. 结论

1. **护栏纵深有效**：十轮中每一次错误都精确落在对应拦截层（preflight 假 digest、
   quarantine 表头/占位符、supervisor 越权读盘与 shell），**没有任何编造行进入过
   受验发布**（r4 的空壳发布是唯一的穿透，其缺口已修复并单独立案）。
2. **模型能力分层清晰**：deepseek-v4-flash 在 08-28 零脚手架首跑自收敛；
   qwen flash 档在同一 TOPIC 上表现出六种不同失败模式，最佳轮次推进到发布评估
   最后一级。两层结论对报告的"模型无关性/能力边界"叙事直接可用。
3. **失败模式即产品路线图**：多数"模型失败"实为产品可观测性/工效缺口
   （数据不可见、错误不点名、逃生门太顺手），已按此顺序修复；
   遗留项见 [TODO.md](../TODO.md)（end-of-run publication gate 等）。
4. **方法学资产**：直问 + `--adopt` + 人类可信提示词的评测方法已固化
   （[../gold-formal-rerun.md](../gold-formal-rerun.md)），后续评测可直接复用。

## 6. 证据索引

- 逐轮记录：`data/gold/gold7_alzheimer_gwas/runs-log.md`（2026-08-29 各节）
- 证据包：`data/gold-runs/57af4fec-gold7-qwen37flash-r{1,2,3,4}`、
  `57af4fec-gold7-qwen38flash-r{5,6}`、`b98db211/635025ba/22d87d15/1336428a-gold7-*-direct-*`、
  `635025ba-gold7-dsflash-direct-r{1,2-temp02}`
- 关联：[ISSUES.md](../ISSUES.md) 占位符 P1、[TODO.md](../TODO.md) end-of-run gate、
  [../gold-formal-rerun.md](../gold-formal-rerun.md) 测试方法学
