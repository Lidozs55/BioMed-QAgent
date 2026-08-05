# REVIEW — 全代码库复查报告（2026-08-05）

> 复查方法：三路并行只读扫描（backend / frontend / 数据管线正确性）后，
> 对全部 P0 与高风险 P1 逐条抽样回读代码验证（复查），校准误报后成稿。
> 测试基线：全量 pytest 2043 passed；ruff 0 告警。

---

## 0. 复查校准记录（防误报方法论）

| 原发现 | 校准结论 | 依据 |
|---|---|---|
| P0-1 模型 vendor 漂移（qwen.py 合并表标 dashscope） | **降级 P1**：分厂商模块（deepseek.py 等）含全部同 id 条目并在 `_load_all` 中后注册覆盖，运行时 vendor_id 实际正确；真实问题是"合并表 + 分厂商表"双份维护的漂移风险 | `deepseek.py:8-63` 含 deepseek-chat/r1/v3；`repository.py:54-75` 后注册覆盖 |
| P0-2 模型元数据四源 | **保留 P1**：`get_known_model` 优先查 `catalog_qwen/catalog_compatible`（无 pricing 旧格式），屏蔽 `model_info` 仓库富元数据；同 id 双份维护 | `catalog.py:18-45`、`catalog_qwen.py`、`catalog_compatible.py` |
| P0-3 超时集中配置名义化 | **保留 P1**：`RuntimeLimitsSettings` 无持久化/配置入口，每模块 new 默认实例 | `schemas.py:10-36`、`crawler.py:45` |
| 数据管线 P0-1 500k 截断 | **保留 P0**：截断仅 `logger.warning`，无 WarningPayload、cleaning_report 不记录、validation 不检查——用户不可见 | `processing.py:47,169-177` |

---

## 1. P0 — 数据正确性 / 静默丢失（已复查确认）

### P0-1 `_CLEANING_MAX_ROWS = 500_000` 静默截断（ISSUES.md 活跃项，未修复）

- `backend/app/pipeline/stages/processing.py:47`（常量）、`:169-177`（截断）。
- 截断唯一信号是 `logger.warning`；链路确认**无用户可见出口**：
  - `CleaningReportModel`（`base.py:198-210`）无截断字段 → `cleaning_report.csv` 不记录；
  - 不产生 WarningPayload；validation gate 11 项检查均不含截断。
- **双路径语义缺陷**：无格式修正时（`transformed=False`）CSV 不被重写（磁盘保留全量），但统计仅基于前 500k 行 → **清洗报告系统性低估异常**；有格式修正时 CSV 被原子重写为仅前 500k 行 → **磁盘数据永久丢失且计数"已修正"**。
- 影响：GSE183795（4,695,780 行）产物缺 4.2M 行而不报错。
- 修复方向（两步）：(a) 流式清洗不累积 `all_rows`（`csv.reader` 逐行 + 流式写出）；(b) 截断时发 `WarningPayload(code="cleaning_truncated")` 且 `CleaningReportModel` 增加 `truncated_rows` 字段写入 `cleaning_report.csv`。

---

## 2. P1 — 边界缺陷 / 维护漂移（已复查确认）

### 2.1 数据管线

| # | 问题 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| P1-1 | checkpoint 复用掩盖上游变化：digest 无时间/新鲜度分量，live 模式同参数重跑跨 run 复用 DISCOVERY，跳过 PubMed/GEO 实时检索 | `runner.py:1145-1174`、`state.py:106-151` | 上游数据更新（新文献、GEO 重注释/增补）被静默跳过 | live DISCOVERY 禁用复用，或 digest 纳入检索时间戳；复用语义限定为"同 run 崩溃恢复" |
| P1-2 | metadata-only 包整体绕过 `core_data_existence` 非空率阈值：`main_data_nonempty` 仅 ≥1 行即过 | `validation/checks/main_data.py:100-116` | 1 行 sample_metadata 的空壳包可发布为 valid（有 `warn_no_expression_data` warning 缓解） | 维持 warning 同时加"至少 N 样本"守卫，或引入 `valid_with_warnings` 语义 |
| P1-3 | 事件流不对称：stage 失败/取消时 `tool_called` 无配对 `tool_completed`；取消路径 `stage_started` 无终止事件 | `runner.py:761-767,1384-1387,1433-1460` | 前端可能渲染悬空"工具调用中" | 失败/取消补发 `ToolCompletedPayload(is_error=True)` |
| P1-4 | GDC `expected_sha256` 恒 None：files API 的 `md5sum` 为 32 位，`len==64` 永假 | `stages/acquisition.py:444` | 官方校验和对照静默失效（自算 sha256 仍校验，完整性未破） | 改为 `expected_md5` 对照或删死条件加注释 |
| P1-5 | 缓存无新鲜度机制：平台注释以**目录 URL** 为键、命中即跳过网络，永久 staleness | `geo_annotation.py:183-191`、`acquisition.py:290-354`、`content_cache.py:21-41` | probe→gene 映射/表达矩阵可能陈旧 | metadata 记录 `fetched_at`，易变源加 TTL，或键纳入文件 URL+ETag |
| P2-3 | plan 超时自动批准后 `_pending_user_input_request_id` 残留，可能阻断同 run 内第二次 HIL（`data_correction` 等） | `runtime/manager.py:245-251`、`pipeline/runner.py:555-575` | 边界场景第二次 HIL 被 `raise RuntimeError` 阻断 | resume 持久化时匹配 request_id 清除 pending id |

### 2.2 后端维护漂移

| # | 问题 | 位置 |
|---|---|---|
| P1-6 | 模型元数据多源：`catalog_qwen.py`(688) + `catalog_compatible.py`(367) 与 `model_info/` 仓库双份维护，`get_known_model` 优先旧格式 | `model_config/catalog.py:26` |
| P1-7 | `qwen.py` 合并表（1292 行）与分厂商文件双份维护同 id 模型，改一处漏一处 | `model_info/providers/qwen.py` |
| P1-8 | acquisition 门面回退 `_fetch_json_for_run`/`_download_file_for_run` 三份拷贝；xena 内联 urllib（`xena.py:179-183`） | `gdc.py:92-122`、`pdb.py:60-106`、`xena.py:231-247` |
| P1-9 | 4 个 UA 常量（版本不一致）、4 个限流器实现、Retry-After 解析双实现 | `_download_io.py:31-58`、`crawler.py:48-63,137-196`、`browser_pool.py:23-27`、`geo_annotation.py:178`、`ncbi/client.py:49-97`、`geo.py:30-45` |
| P1-10 | 旧领域模型仍使用：`tools/parse_*`、`cleaning`、`alignment`、`processing` + `pipeline/stages/processing.py:19` | `tools/`、`app/domain/processing.py` |
| P1-11 | `domain/task.py`(129) + `domain/events.py`(59) 生产零引用（仅测试 + re-export） | `domain/__init__.py:14-22` |
| P1-12 | 死代码：`model_info/vendors.py get_vendors`、`api/settings.py VENDORS`(3 项，死)、`catalog.py infer/augment/get_advanced_defaults/list_known_models`、`gdc.py:40-42`+`pdb.py:40-42` 死 `_rate_limit`、`_download_io.py copyfileobj_to_path` | 各文件 |
| P1-13 | GEO supplementary 列表两套解析（结构化 vs 裸正则） | `ncbi/parsers.py` vs `stages/acquisition.py:200-203` |

### 2.3 前端维护漂移

| # | 问题 | 位置 |
|---|---|---|
| P1-14 | 死组件链 8 文件 1289 行 + 2 死测试（生产零引用）：`ModelForm/ModelConnectionSection/ModelDropdown/SettingsDialogs/ContextUsageBar/ContextBudgetControls/ContextBudgetSummary/useModelSettingsDraft` | `components/`、`hooks/useModelSettingsDraft.ts` |
| P1-15 | `SettingsDialogs.tsx` 与 `SettingsPage.tsx:676-915` 内联对话框近乎逐行重复 | 两处 |
| P1-16 | 事件类型注册表三处平行维护（41 类型 Set × 3） | `transport.ts:16-57`、`eventParsers.ts:6-20`、`apiResponseParsers.ts:30-39` |
| P1-17 | 状态标签/状态集合四处定义，文案不一致（failed: "任务执行失败" vs "失败"） | `ChatPanel.tsx:77-94`、`taskStatusMeta.ts:9-22`、`shared.ts:22`、`SessionSidebar.tsx:72` |
| P2-18 | `SettingsPage.tsx`(918) monolith：4 内联对话框 + 模型草稿 + 20+ useState；`reducers/stream.ts`(944) | 建议拆分 |

---

## 3. 复查确认无问题（良好项）

- 无 `eval/exec/pickle/yaml.load` 反序列化风险；sandbox AST 校验 + 子进程隔离合格。
- SSRF 防护合格（`egress_proxy.py` DNS→公网 IP 强制 + 443-only）。
- 路径遍历防护合格（`io.py` 三重检查 + `_verified_artifact_path`）。
- 无朴素 `datetime.now()`；统一 UTC。
- 前端类型纪律零违规（无 `any`/`@ts-ignore`）。
- 下载回退链（pdf_url → Unpaywall → EPMC）完整不静默。
- `warnings_metrics_consistency` 不会因 `geo_probe_unmapped` 失效（派生自同一 `all_warnings`）。
- 事件序列跨 run 无冲突（repository 重新分配 + event_id 去重）。

---

## 4. 建议执行批次（按风险收益）

| 批次 | 内容 | 风险 | 收益 |
|---|---|---|---|
| B1 | P0-1 500k 截断修复（流式清洗 + 截断可见警告 + cleaning_report 记录） | 中（清洗路径核心） | 消除数据静默丢失 |
| B2 | 死代码清理（P1-11/12/14/15）：后端 domain 死模块、settings VENDORS、catalog 死函数、死 `_rate_limit`、copyfileobj_to_path；前端 8 死文件 + 2 死测试 | 低 | 净减 ~1500 行，零功能影响 |
| B3 | P1 小修：GDC md5 校验（P1-4）、GEO 前缀 `.upper()`（skill 层）、事件流 tool_completed 配对（P1-3）、pipeline tool_called arguments 注入 | 低-中 | 消除静默降级与事件不对称 |
| B4 | 设计权衡（P1-1/2、P1-5、P2-3）：checkpoint 复用新鲜度、metadata-only 样本下限、缓存 TTL、plan pending 残留 | 中 | 数据新鲜度与状态一致性 |

## 5. 架构减法建议【待确认】

以下为影响面较大的删减/合并，需人类决策后执行：

1. **模型元数据四源归一**：删 `catalog_qwen.py`/`catalog_compatible.py` 两张大表，`get_known_model` 直连 `model_info` 仓库；`qwen.py` 瘦身为纯 dashscope 模型表（删除其中非 Qwen id）。影响 `/models`、设置页模型展示，需回归。
2. **旧工具链下线**：删除 `tools/parse_pdb.py`、`parse_excel.py`、`parse_geo.py`、`processing.py`、`cleaning.py`、`alignment.py` 及其 `app.domain.processing` 依赖（需先审计 agent 工具引用）。
3. **限流/UA/超时归一**：保留 `crawler.AsyncHostRateLimiter` 唯一实现 + 单 UA 常量；`_download_io.rate_limit` 与 ncbi `AsyncRateLimiter` 删或改薄适配。
4. **compaction 8 文件 → 3 文件**：`runtime/compaction*.py` 合并（types / planning+execution / summary+fallback）。
5. **超时配置真实化**：`RuntimeLimitsSettings` 接入持久化 settings 并从 `RunContext.model_settings` 注入，或删除"伪配置"改回常量表。

---

## 6. 结论

- 架构健康度较 0802 显著提升：reducer 已按事件域拆分（2443→31 行 shim + 分区实现）、事件解析分层、类型纪律优秀。
- 最需优先解决的单一问题：**500k 静默截断**（P0，数据被静默破坏，与用户"清洗整合可靠性"评分直接相关）。
- 其次：死代码/双源维护清理（B2，零风险净减 1500 行）与数据新鲜度（B4 设计权衡）。
