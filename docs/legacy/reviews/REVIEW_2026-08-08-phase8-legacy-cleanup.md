# REVIEW — Phase 8 清理 Legacy（收窄执行）

日期：2026-08-08
分支：`docs/phase8-closeout`（base main @ 86aafd4）
结论：**P1 死代码清理 / P2 临时实现 / P2 全量回归完成；V1 退役删除项标注遗留（依赖产品决策）。**

## 1. 执行方式

按用户决策（Option A，收窄 Phase 8）：先全面审计删除目标现状，只勾选已完成/已不存在的清理项；删除清单中依赖 V1 生产路径退役的项标注 `[~]` 遗留并写明原因，不强行删除。

## 2. 审计方法

- Explore agent（40 tool uses）对 6 类删除目标做 file:line 级引用审计（app/ + tests/ + launcher.py + frontend）；
- 父核验关键结论：agent INSTRUCTIONS（`app/agent_loop/agent.py`）、V1 多源合并触发条件（`stages/processing.py:569-600`）、V2 工具注册引导程度；
- 结论均可在代码中复现（下方每项附证据位）。

## 3. 已完成清理项（勾选）

| TODO | 审计证据 |
| --- | --- |
| P1 死代码 parse_pdb/parse_geo/parse_excel/tools.cleaning | 四文件均不存在（`find` 确认）；`test_processing.py` 不存在；测试中的 `parse_geo_*` 均为**活跃**解析器（`pipeline/processing/geo_tximport.py`、`integrations/ncbi/parsers.py:124`），MUST-KEEP；openpyxl/xlrd 不在 `pyproject.toml` 且 app/tests 零导入；`test_config.py:144-160` 死依赖检查仅覆盖 biopython/geoparse |
| P1 metadata-only 占位 | Phase 4b T1 已删除；剩余引用均为注释/回归测试守卫（`test_metadata_only_package.py` 等），KEEP |
| P2 V2 DatasetRequest/BuildRecipe 临时实现 | 代码中不存在，仅 docs 提及（TODO/ARCHITECTURE/design + `datasets/runtime/operations.py:6` 注释） |
| P2 全量回归 | 后端 2722 passed / ruff clean / import OK；前端 726 passed (47 files) / lint 0 / tsc 0 / build OK；uvicorn 冒烟在前阶段验证。ARCHITECTURE 顶注（§0）已诚实标注「代码仍为 V1、V2 绞杀模式」，与代码一致，无需改动 |

## 4. 遗留项（`[~]`，依赖 V1 生产路径退役）

| TODO | 现状证据 | 遗留原因 |
| --- | --- | --- |
| P1 `_STAGES`/`StageName`/`SUPPORTED_...` 门禁 | `_STAGES` def `runner.py:167-173` 被 `_run_stages_loop:781` 消费；`StageName` 遍布 runner/state/stages/skills/events 12 文件 + 12 测试文件；门禁调用 `tool.py:434`（准入）+ `discovery.py:47`（preflight） | V1 runner 仍是 agent 生产主线；`StageName` 是活跃业务协议非死依赖。门禁本身符合 TODO「可保留来源级安全 allowlist」 |
| P1 22 列写入接口 + `domain/processing.py` | `CacheStore.commit_dataset`（`tools/cache_store.py:112`）被 `cache_tools.commit_to_cache`（`import_agent.py:37` 生产）调用；`ParsedDataset` 链挂 `merge_datasets` | 写入接口为 V1 处理路径一部分；ParsedDataset 链连锁依赖第 3 项 |
| P1 `merge_datasets` 正式路径 | `stages/processing.py:630` → `merge_parsed_datasets:344` → `merge_datasets:217`，仍为生产 V1 合并路径；`test_multisource_merge.py` 守卫 | 非死代码；删除=行为变更（V1 多源合并失效），须先 V1 退役 |
| P1 `run_research_pipeline` 旧参数面 | 9 参数全活（`tool.py:239`；`agent.py:27,461` 注册；12+ 测试） | agent INSTRUCTIONS（`:120/:237/:397`）仍引导 V1 为正式产物入口 |

## 5. 未决架构决策：V1 生产路径退役

**发现**：TODO Phase 8 前提「V2 闭环通过四种必测结果」已达成（e2e 测试覆盖 SUCCEEDED / NO_DATA / partial_success / failed），但 V2 `execute_dataset_build` 在 `app/agent_loop/agent.py` 仅导入+注册（`:26/:463`），**INSTRUCTIONS 零引导**；V1 `run_research_pipeline` 仍是 agent 主线。删除清单实质全部指向「V1 退役」，这是产品行为变更而非清理。

**决策点**（用户已选 Option A：收窄，V1 退役暂缓）：
- 暂缓 V1 退役；agent 主线维持 V1，V2 并行可用（e2e 已走 V2）。
- 后续若推进退役（Option B/C 曾列于会话），候选方案：
  1. 重写 agent INSTRUCTIONS 引导 `execute_dataset_build`（含 spec 自包含、来源选择、失败策略），工具注册重排；
  2. V1 runner/state/stages 降级为兼容 facade 或删除；`merge_datasets` 正式路径移除、保留 `normalize_field_names`/`align_fields` 为映射候选生成器；
  3. 迁移/删除 36 个 V1 依赖测试文件；`CacheStore.commit_dataset` 写入链改走 V2 `DatasetCacheV2.commit`；
  4. 全量 e2e 复跑 + 前端回归。

## 6. 验证门（收尾，全部通过）

- 后端：`uv run pytest` 2722 passed / ruff clean / `import app.main` OK
- 前端：`pnpm lint` 0 / `pnpm tsc` 0 / `pnpm test` 726 passed (47 files) / `pnpm build` OK
- git：分支 `docs/phase8-closeout` 合并 main、推送；工作区干净
