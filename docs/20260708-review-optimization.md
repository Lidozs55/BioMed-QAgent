# 减法式架构审查与优化报告

> 审查日期：2026-07-08
> 审查范围：BioMedQAgent 全项目（backend / frontend / docs / data 脚本）
> 审查方法：全局架构理解 → 架构减法审查 → 代码级逐文件审查

---

## 阅读指引

本报告分两大类：

- **第一部分 架构减法建议**：涉及架构根本性变更（模块/服务/抽象层的增删合并），**必须经人类审查确认后方可执行**，不得自动修改。每条标注 `[需人类决策]`。
- **第二部分 代码级问题**：在架构减法方向确认后可直接进入修改流程的代码问题（冗余/死代码/重复逻辑/耦合）。每条标注 `[可直接修改]`，并附影响程度。

影响程度分级：🔴高 / 🟡中 / 🟢低。

---

# 第一部分　架构减法建议（需人类决策）

> 以下条目均涉及架构根本性变更。请逐条审阅并给出"批准/驳回/保留"决策。**未获批准前不执行任何此类修改。**

## A1. skills/ 自演化旁路系统 —— 整体移除或大幅瘦身 `[需人类决策]`

- **位置**：[backend/app/skills/](../backend/app/skills/)（10 文件，约 2437 行）+ [backend/app/api/routes/skills.py](../backend/app/api/routes/skills.py)（97 行）+ [backend/tests/test_skills_*.py](../backend/tests/)（8 文件）
- **问题描述**：
  - skills 模块是一个"工具元数据发现 + 技能自演化"的双层旁路系统，**完全未接入主流水线**。
  - 生产引用仅 3 处：`main.py` 启动期 `register_all_skills()`（只记日志）+ `api/__init__.py` 挂载 skills 路由 + `skills.py` 路由本身。
  - Orchestrator 与全部 8 个 Agent 对 skills **零引用**（grep 0 匹配）。主流水线直接调用 ToolRegistry，绕过 skills。
  - skills 仅暴露 5 个**只读**端点（list/categories/count/get/search），**无 execute/repair/promote 写端点**，自我迭代闭环（SkillRepairAgent → CandidateRunner → PromotionManager）**仅被测试调用**，生产不可达。
  - **前端对 skills 5 个端点零调用**（无 UI）。
  - skills 的 executor 闭包反向调用 ToolRegistry，形成"ToolRegistry → skills → ToolRegistry"的循环依赖（仅元数据层，无运行期价值）。
- **影响程度**：🔴高（2437 行代码 + 8 测试文件 + 1 路由的存废）
- **建议方向**（三选一，需人类决策）：
  1. **整体移除**（推荐，最彻底）：删除 `app/skills/` 全目录 + `api/routes/skills.py` + 8 个 test_skills_*.py + main.py 中的 register_all_skills 调用。ToolRegistry._TOOLS_METADATA 若仅服务于 skills 派生则一并评估。可减约 2700+ 行。
  2. **保留发现面板，删除自演化层**：保留 registry/definitions/retriever + skills 路由（工具目录展示），删除 evaluator/repair/candidate/promotion（自演化闭环，约 697 行）。
  3. **保留并正式接入**：在 Orchestrator 规划阶段引入 SkillRetriever 做 LLM 工具选择，暴露 execute 端点。工作量最大，且与当前 ToolRegistry 直接调用的简洁架构相悖。
- **依赖连锁**：若选方案 1 移除 skills，则 A7（13 个仅供 skills 的 facade）一并转为死代码可删除。

## A2. 17 个 dormant BaseDataSource 子类 —— 整体移除 `[需人类决策]`

- **位置**：[backend/app/tools/datasources/](../backend/app/tools/datasources/) 下 17 个纯类文件：
  biogrid / cbioportal / chembl / depmap / enrichr / genecards / gprofiler / lincs / omim / openfda / pdc / reactome / ucsc_xena / ensembl / hgnc / opentargets / uniprot
- **问题描述**：
  - 这 17 个文件**仅定义 BaseDataSource 子类，无模块级函数**，共约 3155 行。
  - 主路径（SearchAgent / Orchestrator）从不调用；仅可通过 `ToolRegistry.run_datasource` 的 dormant 分支（`name ∈ _DORMANT_DS_NAMES`）触发，而 SearchAgent 的默认源与实体源均走活跃模块函数路径，**dormant 分支主流程不可达**。
  - ARCHITECTURE.md 已显式声明"dormant，orchestrator 不使用"。
  - 这些类仅被 2 个测试文件（test_datasources_pdc_lincs / test_datasources_stage3）引用。
- **影响程度**：🔴高（3155 行死代码 + base_ds.py 基础设施 295 行）
- **建议方向**（二选一）：
  1. **整体移除**（推荐）：删除 17 个 dormant 文件 + base_ds.py 中的 BaseDataSource/DataSourceRegistry/get_datasource_registry + ToolRegistry 的 dormant 分支 + _DORMANT_DS_NAMES。保留 base_ds.py 中活跃的 make_record/utc_now 工具函数。
  2. **保留作扩展桩**：维持现状但需在 ARCHITECTURE.md 明确"扩展占位，非活跃"，并清理 registry.py 中"13 个"的过时注释（实为 17 个）。
- **依赖连锁**：若移除，A3（base_ds 基础设施）随之处理；test_datasources_pdc_lincs / test_datasources_stage3 需删除或重写。

## A3. BaseDataSource / DataSourceRegistry 基础设施 —— 随 A2 处理 `[需人类决策]`

- **位置**：[backend/app/tools/datasources/base_ds.py](../backend/app/tools/datasources/base_ds.py)（295 行）
- **问题描述**：
  - `BaseDataSource` 抽象基类、`DataSourceRegistry`、`get_datasource_registry`、`_register_all` 构成 dormant 插件体系，仅服务于 A2 的 17 个子类。
  - `DataSourceRegistry.search` 便捷方法**无任何调用者**。
  - 文件内 `make_record()` / `utc_now()` 是活跃工具函数（被各活跃 search 函数 + llm_extractor 使用），需保留。
- **影响程度**：🟡中（295 行，部分保留）
- **建议方向**：随 A2 决策。若 A2 移除，则将 make_record/utc_now 迁移至 utils 或保留为独立小模块，删除其余。

## A4. DataRecord Pydantic 模型 —— 移除 `[需人类决策]`

- **位置**：[backend/app/models/data_record.py](../backend/app/models/data_record.py)（52 行）+ [backend/app/models/__init__.py](../backend/app/models/__init__.py)
- **问题描述**：
  - `DataRecord` / `SourceReference` 两个 Pydantic 类**从未被实例化**。运行时统一用裸 dict + JSON Schema。
  - 全 backend 仅 `models/__init__.py` 做 re-export，无任何其他模块 import 这两个类。
  - ARCHITECTURE.md 已声明"dormant，运行时用 dict"，列为 P3 限制。
- **影响程度**：🟢低（52 行）
- **建议方向**（二选一）：
  1. **移除**（推荐）：删除 data_record.py + __init__.py 中的 re-export。运行时已用 dict + schema，无类型安全损失。
  2. **激活**：将运行时 records 改用 DataRecord。工作量大，与当前 dict-based 数据流冲突，不建议。

## A5. reflection_loop.py —— 移除 `[需人类决策]`

- **位置**：[backend/app/tools/optimization/reflection_loop.py](../backend/app/tools/optimization/reflection_loop.py)（285 行）
- **问题描述**：
  - 提供 record/decide/finalize 三个领域函数，被 ToolRegistry 包装为 reflection_record/reflection_decide/reflection_finalize 三个 facade。
  - **这三个 facade 无任何调用者**（Agent 层、Skills 层均未调用）——其中 reflection_decide / reflection_finalize 是完全死代码，reflection_record 仅在 skills 元数据中登记但无调用。
  - Stage Gate 的实际收敛逻辑已由 `stage_evaluator` + `IterationDecisionAgent`（活跃）替代。
  - ARCHITECTURE.md 已声明"reflection_loop 文件版 dormant"。
- **影响程度**：🟡中（285 行 + 3 facade）
- **建议方向**：**移除**（推荐）。删除 reflection_loop.py + ToolRegistry 中 reflection_record/reflection_decide/reflection_finalize 三个 facade。收敛逻辑已由 stage_evaluator 覆盖。

## A6. drugbank.py / disgenet.py 中的 dormant 子类 —— 清理半 dormant `[需人类决策]`

- **位置**：[backend/app/tools/datasources/drugbank.py](../backend/app/tools/datasources/drugbank.py)（354 行）、[backend/app/tools/datasources/disgenet.py](../backend/app/tools/datasources/disgenet.py)（353 行）
- **问题描述**：
  - 两文件均为**混合**：既有活跃模块函数（search_drugbank / search_disgenet，被 _get_ds_func 加载），又有 dormant BaseDataSource 子类（DrugBankSource / DisGeNETSource）。
  - dormant 类经 run_datasource **永远不可达**（活跃函数优先返回），属半 dormant。
- **影响程度**：🟡中
- **建议方向**：随 A2 决策。若 A2 移除 dormant 体系，则删除两文件中的 DrugBankSource / DisGeNETSource 类定义，保留活跃模块函数。

## A7. 仅供 skills 使用的 ToolRegistry facade —— 随 A1 处理 `[需人类决策]`

- **位置**：[backend/app/tools/registry.py](../backend/app/tools/registry.py)
- **问题描述**：以下 13 个 facade 主流水线（Agent 层）不调用，仅经 skills 层动态调度后通过 API 暴露：
  - IO（4）：csv_to_json / excel_to_json / json_to_csv / merge_json
  - Optimization（3）：expand_keywords / evaluate_stage / reflection_record（前两个被 IterationDecisionAgent 绕过 facade 直接导入，详见 B4）
  - Viz（4）：plot_enrichment_bubble / plot_heatmap / plot_network / plot_volcano（AnalysisAgent 只产出 chart_data dict 由前端渲染，不生成图表文件）
  - Export（2）：export_excel / export_markdown_report（Orchestrator 只用 export_csv）
- **影响程度**：🟡中
- **建议方向**：随 A1 决策。若 A1 选方案 1（移除 skills），则这 13 个 facade 转为死代码可一并删除（viz 的 extract_chart_data 仍活跃，需保留）；若 A1 保留 skills 发现面板，则保留。

---

# 第二部分　代码级问题（可直接修改）

> 以下条目为代码层面的冗余、死代码、重复逻辑、耦合问题。在架构减法方向确认后，可直接进入修改流程。

## B1. Orchestrator 与 BaseAgent 去重逻辑重复 `[可直接修改]`

- **位置**：[backend/app/agents/orchestrator.py](../backend/app/agents/orchestrator.py) `_dedup_round`（约 500-512 行）vs [backend/app/agents/base.py](../backend/app/agents/base.py) `_dedup_by_id`（约 111-124 行）
- **问题描述**：两者按 record_id 去重的逻辑完全相同，orchestrator 未复用 BaseAgent 的静态方法，重新写了一份。
- **影响程度**：🟡中（双重维护）
- **建议方向**：`_dedup_round` 直接调用 `BaseAgent._dedup_by_id`，删除重复实现。

## B2. Orchestrator 重复定义 _set_stage / _emit / _to_thread `[可直接修改]`

- **位置**：[backend/app/agents/orchestrator.py](../backend/app/agents/orchestrator.py)（约 666-682 行）vs [backend/app/agents/base.py](../backend/app/agents/base.py)
- **问题描述**：Orchestrator 不继承 BaseAgent，但复制了 BaseAgent 的 `_set_stage`/`_emit`/`_to_thread` 三个辅助方法的实现，双重维护。
- **影响程度**：🟡中
- **建议方向**：将这三个辅助方法提取为模块级函数或 mixin，Orchestrator 与 BaseAgent 共用；或让 Orchestrator 复用 BaseAgent 的静态方法（_to_thread/_emit 可改为模块级）。

## B3. ErrorDecisionAgent 破坏统一 execute 契约 `[可直接修改]`

- **位置**：[backend/app/agents/error_decision.py](../backend/app/agents/error_decision.py)（248 行）+ [backend/app/agents/orchestrator.py](../backend/app/agents/orchestrator.py)（约 440-446 行）
- **问题描述**：
  - ErrorDecisionAgent.execute() 抛 NotImplementedError（满足 BaseAgent ABC），实际通过 decide() 调用。
  - Orchestrator 中需 `assert isinstance(decision_agent, ErrorDecisionAgent)` + `# type: ignore[attr-defined]` 调用 decide()，破坏统一 execute 契约。
- **影响程度**：🟡中（接口不一致，类型安全弱化）
- **建议方向**：ErrorDecisionAgent 不应继承 BaseAgent / 不应注册到 AgentRegistry（它不是流水线阶段 Agent）。改为普通工具类，Orchestrator 直接持有实例调用 decide()，移除 @AgentRegistry.register 装饰器与 execute() 桩。

## B4. IterationDecisionAgent 绕过 ToolRegistry facade `[可直接修改]`

- **位置**：[backend/app/agents/iteration_decision.py](../backend/app/agents/iteration_decision.py) `_evaluate_stage`（约 188 行）、`_build_fallback_queries`（约 401 行）
- **问题描述**：直接 `from app.tools.optimization... import` 领域函数（stage_evaluator.evaluate / keyword_expander.expand_keywords），未走 `self.tools.evaluate_stage` / `self.tools.expand_keywords` facade。注释写"内存直调，不走文件 facade"。这破坏了"Agent 一律通过 ToolRegistry 调用工具"的统一约定，导致这两个 facade 仅 skills 使用。
- **影响程度**：🟡中（架构不一致）
- **建议方向**：改为通过 `self.tools.evaluate_stage` / `self.tools.expand_keywords` 调用，统一 facade 约定。若 A1 移除 skills，则这两个 facade 唯一调用者变为 IterationDecisionAgent，facade 仍有存在价值。

## B5. 2 个完全死代码 facade `[可直接修改]`

- **位置**：[backend/app/tools/registry.py](../backend/app/tools/registry.py) `reflection_decide`（约 805-818 行）、`reflection_finalize`（约 820-834 行）
- **问题描述**：全代码库无任何调用者（Agent 层、Skills 层均未调用）。
- **影响程度**：🟢低
- **建议方向**：直接删除（与 A5 reflection_loop.py 一并处理）。

## B6. export 领域逻辑过重内联在 Orchestrator `[可直接修改]`

- **位置**：[backend/app/agents/orchestrator.py](../backend/app/agents/orchestrator.py) `_write_merged_csv` / `_classify_record` / `_get_group_columns`（约 686-795 行，共 110 行）
- **问题描述**：export 阶段的按实体类型分组、列头标准化属"导出领域逻辑"，超出 Orchestrator"输入解析 + 结果组装"的编排职责。ARCHITECTURE.md 说 export 由 Orchestrator 持有，但这部分是实现细节而非编排。
- **影响程度**：🟡中（职责越界）
- **建议方向**：将这三方法迁移至 [backend/app/tools/export/](../backend/app/tools/export/)（新建 merge_csv.py 或并入 to_csv.py），Orchestrator 的 `_stage_export` 调用工具函数。注意：ARCHITECTURE.md 4.1 说 export 由 Orchestrator 直接持有，迁移后需同步更新文档说明。

## B7. definitions.py 内部死代码 `[可直接修改]`

- **位置**：[backend/app/skills/definitions.py](../backend/app/skills/definitions.py)
- **问题描述**：
  - 第 9 行：`from typing import Any` —— Any 全文未使用（未使用导入）
  - 第 490 行：`_EXECUTOR_SKIP: set[str]` —— 定义后全文无读取（死变量）
  - 第 36 行：`"drugbank": [...]` 与第 58 行重复键，前者被覆盖（死键）
  - 第 37 行：`"disgenet": [...]` 与第 60 行重复键，前者被覆盖（死键）
  - repair.py 第 136 行：`_llm_repair(manifest, report, llm, execution_result)` 的 `execution_result` 参数函数体内从未使用（死参数）
- **影响程度**：🟢低
- **建议方向**：若 A1 移除 skills 则一并消失；若保留 skills 则逐项清理。

## B8. browser_agent._shutdown_browser 死函数 `[可直接修改]`

- **位置**：[backend/app/tools/browser_agent.py](../backend/app/tools/browser_agent.py) `_shutdown_browser`（约 53 行）
- **问题描述**：定义但从未被调用，无 atexit 注册。浏览器单例靠进程退出回收。
- **影响程度**：🟢低
- **建议方向**：删除该函数，或在 registry crawl_web 路径结束时调用以显式释放资源。

## B9. registry.py 过时注释与 _DORMANT_DS_NAMES 死条目 `[可直接修改]`

- **位置**：[backend/app/tools/registry.py](../backend/app/tools/registry.py)
- **问题描述**：
  - 第 1016 行注释"dormant 13 个"已过时，实际纯类 dormant 文件为 17 个。
  - `_DORMANT_DS_NAMES`（约 75-80 行）含 `cnki` / `wanfang` 两个无对应 .py 文件的死条目（走 web_crawler/browser 路径）。
- **影响程度**：🟢低
- **建议方向**：随 A2 决策。若移除 dormant 体系则 _DORMANT_DS_NAMES 整体删除；若保留则修正注释为 17 个并移除 cnki/wanfang 死条目。

## B10. data/ 目录调试脚本清理 `[可直接修改]`

- **位置**：[data/](../data/) 下 9 个 .py 文件
- **问题描述与分类**：
  | 文件 | 分类 | 理由 |
  |------|------|------|
  | check_data.py | 删除 | 硬编码任务 ID 的 API 调试 |
  | check_pdf_url.py | 删除 | 引用已失效路径 Te51dd48e |
  | check_prov.py | 删除 | 硬编码失效 ID + 访问私有属性 |
  | check_records.py | 删除 | 访问私有属性的一次性诊断 |
  | check_status.py | 删除 | 默认 ID 已失效的状态查询 |
  | list_tasks.py | 删除 | 极简 API 调试 |
  | backfill_records.py | 删除 | 一次性数据回填，使命已完成 |
  | run_test.py | 移位到 backend/tests/ | E2E 冒烟测试，改造为 pytest |
  | verify_api.py | 移位到 backend/tests/ | API 端点验证，改造为 pytest |
- **影响程度**：🟢低（清理 7 个 + 归位 2 个）
- **建议方向**：删除 7 个调试脚本，将 run_test.py / verify_api.py 移入 backend/tests/ 并改造为 pytest 用例。

## B11. DASHSCOPE.md 冗余文档 `[可直接修改]`

- **位置**：[DASHSCOPE.md](../DASHSCOPE.md)（237 行）
- **问题描述**：阿里云百炼官方 API 文档的大段粘贴（含多语言代码示例、CSS 噪声），内容公开可查。ARCHITECTURE.md 4.6 已记录模型分工与 DashScopeClient 方法，实际调用逻辑在 client.py。
- **影响程度**：🟢低
- **建议方向**：删除。如需离线参考，精简为"本项目使用的模型 + base_url 配置"一页。

## B12. docs/ 下 3 份过时设计文档归档 `[可直接修改]`

- **位置**：[docs/](../docs/)
- **问题描述与分类**：
  | 文档 | 状态 | 建议 |
  |------|------|------|
  | agent_browser_integration.md | 严重过时（自称"未实现"但已全部实现） | 归档/删除 |
  | multi_round_search_iteration.md | 严重过时（自称"待实施"但已 100% 落地且 ARCHITECTURE.md 已更新） | 归档/删除 |
  | literature_search_gap_analysis.md | 部分过时（P0/P1/P2 已实施，仅 R5 待办） | 归档，R5 转任务板 |
  | multiomics_network_pharmacology_api_matrix.md | 未过时，与 ARCHITECTURE.md 4.3 部分重复 | 保留作扩展路线图 |
- **影响程度**：🟢低
- **建议方向**：前 3 份移至 docs/archive/ 或删除；第 4 份保留。

## B13. test_skills_error_decision.py 命名错误 `[可直接修改]`

- **位置**：[backend/tests/test_skills_error_decision.py](../backend/tests/test_skills_error_decision.py)
- **问题描述**：文件名前缀 test_skills_ 但实际测试 ErrorDecisionAgent（agents 模块），与 skills 模块无关，易误导搜索。
- **影响程度**：🟢低
- **建议方向**：重命名为 test_error_decision.py。若 A1 移除 skills，则此文件名更应修正。

## B14. 前端 Stage Gate 阈值硬编码且用错 `[可直接修改]`

- **位置**：[frontend/src/components/task/IterationPanel.tsx](../frontend/src/components/task/IterationPanel.tsx) 第 26-32 行
- **问题描述**：前端硬编码 clean 阶段单一阈值（coverage≥0.8/confidence≥0.8/conflict≤0.2/sources≥2），却用同一套阈值对所有阶段的 stage_gate_evaluation 事件做"达标/未达标"着色。后端实际按 6 个阶段分别定义不同阈值。后端事件载荷已含 `passed` 字段，前端又重复计算且用错阈值。
- **影响程度**：🔴高（5/6 阶段的 Stage Gate 指标着色错误）
- **建议方向**：删除前端 THRESHOLDS 硬编码，直接使用后端事件载荷的 `passed` 字段做达标判定。

## B15. 前端 TaskStatus 缺 awaiting_confirmation `[可直接修改]`

- **位置**：[frontend/src/api/types.ts](../frontend/src/api/types.ts) 第 3-6 行 + [frontend/src/components/task/TaskList.tsx](../frontend/src/components/task/TaskList.tsx) 第 8-32 行
- **问题描述**：前端 TaskStatus 联合类型与 STATUS_COLOR/STATUS_LABEL 均未包含 awaiting_confirmation。任务进入该状态时 Tag 无颜色、显示原始字符串。
- **影响程度**：🟡中（人在回路确认状态 UI 异常）
- **建议方向**：types.ts 补充 awaiting_confirmation；TaskList.tsx 的 STATUS_COLOR/STATUS_LABEL 补充对应映射。

## B16. 前端 FeedbackPanel 阶段选项与后端校验不一致 `[可直接修改]`

- **位置**：[frontend/src/components/feedback/FeedbackPanel.tsx](../frontend/src/components/feedback/FeedbackPanel.tsx) 第 17-25 行 vs [backend/app/api/routes/tasks.py](../backend/app/api/routes/tasks.py) 第 183 行
- **问题描述**：前端 STAGE_OPTIONS 含 planning，后端 from_stage 合法集合为 {search,acquire,parse,clean,analyze,review}（不含 planning）。用户选"规划"重试时后端返回 400。
- **影响程度**：🟡中
- **建议方向**：前端 STAGE_OPTIONS 移除 planning（与后端合法集合对齐）。

## B17. 前端 AnalysisView drug_target 键名错误 `[可直接修改]`

- **位置**：[frontend/src/components/analysis/AnalysisView.tsx](../frontend/src/components/analysis/AnalysisView.tsx) 第 175-182 行
- **问题描述**：typeNames 用 `drug_target`（单数），后端与 ResearchReport 均用 `drug_targets`（复数）。导致分析卡片中文标题无法显示，回退为原始 key。
- **影响程度**：🟡中
- **建议方向**：改为 `drug_targets`（复数）。

## B18. 前端 4 个死 API 方法 `[可直接修改]`

- **位置**：[frontend/src/api/client.ts](../frontend/src/api/client.ts)
- **问题描述**：getTaskStatus（第 36 行）、health（第 86 行）、listTools（第 87 行）、listFiles（第 88-90 行）定义但从未被调用。
- **影响程度**：🟢低
- **建议方向**：删除 4 个死方法。注意 getTaskStatus 与 B19 的后端冗余端点一并处理。

## B19. 后端 get_task 与 get_task_status 端点冗余 `[可直接修改]`

- **位置**：[backend/app/api/routes/tasks.py](../backend/app/api/routes/tasks.py) get_task（第 137-144 行）vs get_task_status（第 240-257 行）
- **问题描述**：两者字段重叠 5 项（status/stages/total_records/errors/pending_checkpoint），get_task_status 额外的 is_running/checkpoint_payload 可并入 to_summary()。前端只用 get_task，/status 端点事实冗余。
- **影响程度**：🟡中
- **建议方向**：将 is_running/checkpoint_payload 并入 Task.to_summary()，删除 get_task_status 端点 + 前端 getTaskStatus 方法。WS snapshot 的 stages 序列化也统一用 to_summary()。

## B20. main.py 游离端点归入 routes/ `[可直接修改]`

- **位置**：[backend/app/main.py](../backend/app/main.py) 第 110/120/127 行
- **问题描述**：health / tools / files 三个端点直接挂在 app 对象上，游离于 routes/ 目录外，与 tasks.py 等路由模块职责割裂（files 端点属 tasks 域）。
- **影响程度**：🟢低
- **建议方向**：health/tools 可新建 routes/system.py 或并入现有模块；files 端点迁入 routes/tasks.py。

## B21. data.py 路由职责混杂 `[可直接修改]`

- **位置**：[backend/app/api/routes/data.py](../backend/app/api/routes/data.py)（253 行）
- **问题描述**：同时承载数据查询、导出、报告获取、报告重生成四类职能。get_report / regenerate_report 语义上更接近 tasks 域。export_data 内手写 CSV 扁平化逻辑，与 tools/export/to_csv.py 职能重叠。
- **影响程度**：🟡中
- **建议方向**：将 report 相关端点迁入 tasks.py；export_data 的 CSV 扁平化复用 to_csv.py 逻辑。

## B22. feedback.py 反馈未建模（hack 式存储）`[可直接修改]`

- **位置**：[backend/app/api/routes/feedback.py](../backend/app/api/routes/feedback.py) 第 39-52 行
- **问题描述**：用 hasattr/setattr 动态挂 `_feedbacks` 到 Task 模型，反馈未正式建模。
- **影响程度**：🟢低
- **建议方向**：在 Task 模型上正式增加 feedbacks 字段，或新建 Feedback 模型。本项可延后，非本次必须。

## B23. context 无 schema，各 Agent 裸 dict 访问 `[可直接修改]`（可选）

- **位置**：[backend/app/agents/](../backend/app/agents/) 各 Agent + orchestrator.py
- **问题描述**：context dict 的 key（entities/search_queries/recommended_sources/round_idx/...）散落多处裸访问，无统一 schema 或访问器，隐式契约耦合。
- **影响程度**：🟡中（维护风险）
- **建议方向**：引入 PipelineContext dataclass 或 TypedDict 统一 context 结构。**此项工作量较大且属"加法"，与本次"减法"主题相悖，建议延后单独处理，本次不动。**

---

# 第三部分　修改执行计划

## 阶段一：架构减法

| 编号 | 条目 | 决策 |
|------|------|--------|
| A1 | skills/ 旁路系统 | 自演化系统暂时移除，skills暂时保留 并检查：1. backend中是否有其它与skill脚本职能类似的代码？2. 如果有 这些职能类似的代码是否被调用了？职能是否完全一致？3. 如果没有 skill保留。4. 如果那些职能类似的脚本/代码与skill脚本有重合也有不一致的地方 将skill内脚本迁移补充过去 |
| A2 | 17 个 dormant 数据源类 | 移除 |
| A3 | base_ds 基础设施 | 随 A2 移除 |
| A4 | DataRecord Pydantic | 移除 |
| A5 | reflection_loop.py | 保留 并另写一个文档说明reflection_loop存在的问题 我们期望LLM在环能提高输出质量 即通过多轮反思循环来完善输出 |
| A6 | drugbank/disgenet 半 dormant | 随 A2 移除 |
| A7 | 13 个 skills-only facade | 随 A1 |

## 阶段二：代码级修改（架构方向确认后批量执行）

- 高优先级（🔴）：B14（Stage Gate 阈值）
- 中优先级（🟡）：B1/B2/B3/B4/B6/B15/B16/B17/B19/B21
- 低优先级（🟢）：B5/B7/B8/B9/B10/B11/B12/B13/B18/B20/B22
- 延后（可选）：B23

## 阶段三：文档同步

- 更新 ARCHITECTURE.md（删除已移除模块描述，反映职能迁移）
- 更新 README.md（说明本次优化范围）
- git commit + push
