# REVIEW — V2 缺口审计 + V1 退役决策（2026-08-09）

分支：`feat/v2-mainline-v1-removal`（base main @ bdd23a6）
结论：**V2 expression DatasetBuild 内核基本完成；V2 acquisition / Agent cutover / Legacy retirement / 非 expression family 尚未完成。**
**决策（用户 2026-08-09 拍板）：Phase 8 遗留的 V1 全部移除，主线只保留 V2。本分支执行。**

---

## 1. 阶段定位（修正"V2 已闭环"的表述）

```
Main Agent
├─ V1 run_research_pipeline          ← 仍是正式产物默认入口（agent.py:120/237-238 强制引导）
│  └─ 固定五阶段 + source combo allowlist + 旧 merge/22列体系
│
└─ V2 execute_dataset_build          ← 已注册（agent.py:463）但 Agent 几乎不会主动走
   └─ 已下载文件 → DatasetBuildSpec → parse → canonicalize → compatibility
      → integrate → validate profile → immutable publication
      ↑ acquisition 这一段实际上还没接通
```

更准确表述：**V2 deterministic dataset-build kernel 已闭环；V2 end-to-end dataset pipeline 尚未闭环。**

## 2. 8/6 最终架构 vs 当前代码（审计差异表）

| 项目 | 8/6 最终设计 | 当前代码 | 判断 |
| --- | --- | --- | --- |
| Agent 正式入口 | Agent 形成 DatasetBuildSpec 走 V2 | Prompt 强制 `run_research_pipeline`（agent.py:117-120,237-244） | **P0 未完成** |
| V1 定位 | 仅迁移期 compatibility facade | runner.py:3-11 自认仍是 default Agent path；`_STAGES` 真实执行 | **P0 未完成** |
| Spec 校验工具 | `validate_dataset_build_spec` → `execute_dataset_build` | SpecValidator 已实现且在 tool 内部调用，**无 Agent-facing 工具** | **接口闭环未完成** |
| V2 Acquisition | Runtime 按 SourceBinding 调 Provider/WorkflowRecipe → 真实 `DownloadAttempt → SourceAsset` | `execute_dataset_build` 要求传 already-acquired 文件；`_acquire()` 只取字典（expression_runner.py:332-352） | **P0 未完成** |
| 下载血缘 | 每个下载先有 DownloadAttempt，成功后返回对应 SourceAsset | dataset_build_tool.py:275 伪造 `successful_attempt_id`，无对应 DownloadAttempt | **血缘不闭合** |
| WorkflowRecipe | PROMOTED recipe 可作 V2 Acquisition Provider | `WorkflowRecipeSourceFetcher` 类+测试存在，生产无消费者 | **组件完成，接线未完成** |
| GEO Provider | dispatcher 进正式 acquisition | `acquire_series_asset` 基本只有测试引用 | **组件完成，生产未接** |
| 单族单粒度 | Compatibility Gate 拒绝不兼容来源 | 已实现 | **完成** |
| BuildResult | 独立于 Run 状态，per-binding rejection | 已实现 + durable Run bridge | **完成** |
| Manifest/Publication | role-based、schema/profile、不可变、supersedes | 主体实现 | **基本完成** |
| Publication 引用闭包 | publication 内引用全部可解析 | `validation_result_ref` 指向的文件未拷入 version dir | **P1 bug（C1d）** |
| V1/V2 隔离 | 同 Run 禁止混用（ARCHITECTURE.md:1113-1122） | 两 tool 同时注册；runner.py:1287-1300 隐式"V1 优先" | **P0 不变量未 enforce** |
| 来源组合 | Adapter+Schema+Profile 扩展，不再枚举组合 | V1 仍执行 `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS`（tool.py:434-460） | **随 V1 未退役** |
| 22列/main_data 退役 | V2 schema 不固定列 | V1 22 列缓存、`alignment.merge_datasets` 仍是生产路径 | **系统级未完成** |
| GEO 多数据集 | 多 GSE → 多独立 Build/Publication | MultiBuildOrchestrator 已实现+测试，无生产调用者 | **语义完成，产品入口未完成** |
| V2 数据族 | 可扩展 expression/mutation/clinical/pathway… | production validator 只注册 gene/probe expression；Adapter 只有 expression | **本质还是 expression V2** |
| GDC mutation / Clinical | 8/6 P1；GDC clinical lineage | tool.py:345-360 明确返回"not implemented" | **未完成** |
| 版本化 TaskSpecification | 新 Run 携带版本化 spec | 无 version 字段 | **未完成（LEFTOVERS B1）** |

补充：8/6 早期的"异构 evidence bundle / 多轮 evidence index"已被当天 ADR 主动推翻（`BioMed-QAgent_Architecture_Decisions_and_Lessons.md:61-70,127-165,604-616`：一 Build 一 family/granularity，复合需求拆多 Build）——**不是漏做，是设计已否决**，不应再实施。

## 3. V1 生产断点诊断（2026-08-09 日志调试，task_31759f39）

4 轮尝试全败（最终闭环 `no_data`）。**全部位于 V1 五阶段链**，按退役决策**不修复**，归档为"V1 已知缺陷"：

| # | 断点 | 根因 | 证据 |
| --- | --- | --- | --- |
| 1 | **validation gate 60662 failures**（run 1 GDC） | discovery 的 source_id（projects URL 派生）写入 `DiscoveryOutput.specification` 后 **runner 从未写回 ctx.specification**；acquisition `dataset.source_id=""` 回退到每文件 data URL 派生 → 主表/asset source_id ≠ source_list → FK 三连败（foreign_keys 60660 + sample_foreign_keys 1/1 + source_asset_integrity 1/1） | discovery.py:471；acquisition.py:427；runner.py:1054（只传给 builder）；ids.py:54 |
| 2 | **Reactome live 100% 失败**（run 2） | `_validate_reactome_content_service_json` 要求顶层 `stId/databaseName/dbId`；真实 API 返回 `{peDbId, displayName, schemaClass, refEntities}`（identifier 在 refEntities 内层）——实测 802/802 全缺 | acquisition.py:542；processing/reactome.py:179；live curl 实测 |
| 3 | **Xena hub 名当 dataset 键**（run 3） | discovery Xena 分支直接信任 agent accession（"GDC Brenner" 是 hub 名），URL 含空格未编码，非 dataset 对象键 | discovery.py:545；acquisition.py:486-491 |
| 4 | **fixture 降级缺资产**（run 4） | fixture 模式请求 GDC 但 `tests/fixtures/ncbi/gse178352/` 无 `gdc_clinical.tsv` → FileNotFoundError | acquisition.py:327-345 |

附带发现：V1 GDC live 只取 `sorted(hits)[0]` 1 个文件（acquisition.py:407）——TCGA-LUAD 585 样本只下 1 样本。

## 4. V1 退役工程顺序（本分支执行）

**Phase A — V2 纵向链补全（先于删除，否则主线断裂）**
1. `validate_dataset_build_spec` Agent 工具（SpecValidator 已存在，包装即可）
2. V2 acquisition：真实 `DownloadAttempt → SourceAsset` 血缘（修 dataset_build_tool.py:275 伪造点；`_acquire` 从字典领取改为按 SourceBinding 调 provider/dispatcher）
3. Acquisition Dispatcher 接线：builtin provider（GDC/Xena/GEO）+ `WorkflowRecipeSourceFetcher`
4. `agent.py` INSTRUCTIONS 切换（正式产物引导 `execute_dataset_build`）
5. V1/V2 fail-fast 隔离（runner.py:1287-1300 隐式 V1 优先 → 工具入口拒绝混用）

**Phase B — V1 删除**
6. `run_research_pipeline` 降级为兼容 facade（翻译旧参数为 DatasetBuildSpec 走 V2 kernel）或直接删除（视调用面）
7. 删 `_STAGES` / `StageName` 业务依赖 / `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 门禁
8. 删 22 列缓存写（CacheStore.commit_dataset / import_agent 链）/ `domain/processing.py` 旧 ParsedDataset / `alignment.merge_datasets` 正式路径
9. 迁移或删除 36 个 V1 依赖测试文件；V2 e2e 全量重跑（BuildResult 四态：SUCCEEDED/PARTIAL_SUCCESS/NO_DATA/SPEC_REJECTED）
10. 全量回归 + 前端回归 + 冒烟

**Phase C — 顺手发布层缺口**
11. `validation_report.json` 拷入 immutable publication（C1d）
12. publication commit 与 run_completed 事务化（C1a，独立任务候选）

## 5. 验证

- 独立编译：`python -m compileall -q app` 通过（审计环境）
- 仓库测试基线（本机 2026-08-08）：后端 2722 passed / 前端 726 passed (47 files)
