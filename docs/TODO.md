# BioMed-QAgent 开发 TODO

> 本清单的目标：**全部条目完成后，项目与新版 [ARCHITECTURE.md](ARCHITECTURE.md) 一致**。
> 主线按实现规格 [BioMed-QAgent_Pipeline_Refactor_Design.md](BioMed-QAgent_Pipeline_Refactor_Design.md)
> §16 的 Phase 1-8 组织；每个 Phase 的验收标准以该文档为准，此处不重复。
> 原 Design §16 Phase 0（冻结与特征测试）面向云端无法运行的环境；本地仓库已具备
> 运行环境，其基线意图由"全程保持既有测试通过（AGENTS.md §7.3 质量门）"与既有
> REVIEW 固定案例（ARCHITECTURE §21.6）覆盖，故不单列。
> 架构决策依据见 [BioMed-QAgent_Architecture_Decisions_and_Lessons.md](BioMed-QAgent_Architecture_Decisions_and_Lessons.md)
> （ADR-004/010/012 为 V2 状态与执行模型的权威）。
> 已完成项、根因与结论见 `docs/REVIEW_*.md` 与 git 历史；本文件只保留未完成项。

---

## Phase 1：引入 V2 数据集契约和 Schema Registry

> 目标：新增自包含 `DatasetBuildSpec`（**不新增 DatasetRequest**）与四正交状态契约；
> 不修改旧 Pipeline 执行。验收见 Design §16 Phase 1。
> ✅ 已完成（commit 待定）：`app/datasets/` 包，27 项单元测试通过，全量 pytest 无回归。

- [x] **P0** 新增 `DatasetBuildSpec`（dataset_family / row_granularity / schema_ref /
      required_fields / source_bindings / normalization_profile_ref / merge_strategy /
      validation_profile_ref），Agent 不得内嵌验收阈值（契约 `extra="forbid"` 拒绝）
- [x] **P0** 新增 `DatasetSchema`、`DataBatch`、`SourceBinding`、`FieldMapping`、
      `ProvenanceRecord`、`ConfidenceRecord` 契约
- [x] **P0** 新增 `BuildResult`、`ValidationResult`、`DatasetManifest`、`DatasetPublication`
      契约（四正交状态；**删除 BuildOutcome 概念**）
- [x] **P0** 实现 Schema Registry，注册 `gene_expression.long.v1`
- [x] **P0** 编写 Spec Validator：未知 Schema / family 不匹配 / required_fields 不在
      Schema / Profile 不在服务端 allowlist 均返回结构化 reason_code；复合请求拆分
      与 Adapter 参数 Schema 校验属 Agent 层 / Phase 3
- [x] **P0** 将验收阈值与部分成功策略放入服务端版本化 Validation Profile（契约骨架，
      完整 Profile 校验归 Phase 3/6）
- [x] **P1** `_FIELD_DESCRIPTIONS` 迁移为 Schema Registry 字段元数据
      （`build_gene_expression_schema()` 从 V1 字段描述构建 22 列表达 Schema；Builder/
      Validation 侧切换归 Phase 3）
- [x] **P2** Spec Validator 与 Schema 注册的单元测试（`tests/test_dataset_contracts.py`
      / `test_schema_registry.py` / `test_spec_validator.py`）

---

## Phase 2：抽取可信执行内核

> 目标：从 PipelineRunner 抽取可靠性内核为服务端固定 `DatasetBuildExecutor` 骨架；
> `PipelineRunner` 变 Legacy facade。验收见 Design §16 Phase 2。
> ✅ 已完成第一批（Step 2.1）：`app/datasets/runtime/`（operations / checkpoint / executor）
> + OPERATION_* 事件 + 10 项 runtime 测试；全量 pytest 无回归。
> ✅ 第二批：`rerun_from`（resume_from 受控重跑）+ `agent_results/` 查询审计持久化。
> 剩余项依赖 Phase 3（真实 Operation 执行器与 Publication）后继续。

- [x] **P0** 抽取通用任务锁、Attempt、digest、checkpoint、超时、取消、事件逻辑到
      `datasets/runtime/`（Operation / OperationAttempt / BuildCheckpoint；
      任务锁复用 V1 `TaskLock`；digest 复用 + checkpoint 文件 hash 校验 + 崩溃恢复）
- [x] **P0** 实现固定骨架：`acquire[*] → parse[*] → canonicalize[*] → compatibility gate
      → integrate → validate profile → publish`；来源 fan-out / fan-in 用 Operation 记录
      （`build_operation_plan` + `DatasetBuildExecutor`；Operation 执行器可注入，
      真实 Adapter 归 Phase 3）
- [x] **P0** `PipelineRunner` 降级为 Legacy facade；**不定义 BuildRecipe / 公开 BuildStep**
      （V1 不动；`app/pipeline/runner.py` docstring 标注 `[V1 Legacy facade — Phase 2/8]`；
      新 V2 入口为 `execute_dataset_build` function_tool（`app/pipeline/dataset_build_tool.py`，
      spec JSON + source_files 包装为 content-addressed SourceAsset 后走
      `ExpressionBuildRunner` + `DatasetBuildExecutor`）
- [x] **P0** 新 Run 支持携带版本化 `TaskSpecification`（原 §1.6）✅（2026-08-09, feat/leftovers-p1 commits 767d0ba/f69537c：`RunQueuedPayload`/`RunRecord` 携带可选 spec + `POST /tasks` 接受并持久化，向后兼容）
- [x] **P0** 完整重跑完成新版本 Publication 的原子发布与旧版本保留（supersedes 链）
      （`expression_runner._publish` 写 `publication.json`：`publication_id` / manifest_ref /
      validation_result_ref / `published_at` / `supersedes_publication_id`（`_find_latest_publication`
      按版本目录字典序取最新）；新版本不修改旧版本目录）
- [x] **P1** 受控局部重跑 `rerun_from` + 依赖一致性测试；禁止 Agent 任意 `skip_stages`（原 §1.6）
      （`DatasetBuildExecutor.resume_from`：服务端受控起点，目标 Operation 强制重跑、
      下游经 digest 闭包重新校验，起点外 Operation 不得被跳过；4 项测试）
- [ ] **P2** 删除 `validated_intermediate` / `validated_final` 状态（ADR-010 否决），
      任务/会话改为 `current_publication_id`（归 Phase 4，随 Publication 一起）
- [x] **P2** Agent 决策日志持久化 `agent_results/`（吸收原 §1.5.5）
      （`TaskWorkDir.agent_results/query_log.jsonl`：`log_query` 追加持久化，
      `compress_log` 后磁盘仍保留全量查询审计；2 项测试）

---

## Phase 2.5：补齐 WorkflowRecipe Acquisition 闭环

> 目标：`WorkflowRecipe` 只服务 Acquisition；生产 Build 只消费 PROMOTED Recipe。
> 验收见 Design §16 Phase 2.5。

- [x] **P0** 明确 `WorkflowRecipe` 边界：只产出 `SourceAsset`，不得产生 DataBatch、
      声明跨来源依赖、决定合并、选择 Profile 或发布（Design §9.3；契约层由类型化
      step 与固定 SourceAsset 映射结构性保证）
- [x] **P0** 实现 `WorkflowRecipeSourceFetcher`；`SourceBinding` 支持 `recipe_id + version`
- [x] **P0** 生产发现只返回 `PROMOTED`；`VERIFIED` 仅限受限试用或 HIL 确认
- [x] **P0** 修复 `RecipeExecutor.execute()`、Store 发现与 promotion 状态不一致
      （当前 execute/find_verified 只面向 VERIFIED，PROMOTED 后反不可达）
- [x] **P0** Recipe 输出经 Workspace 校验提交为 `SourceAsset` 后再交给 Adapter
- [x] **P1** 统一 SourceAsset 契约：PDB 下载路径走 `acquire_source()`；
      所有 acquisition skill 产出合规 SourceAsset（原 §2.4）
      （browser 属任意 URL 兜底、不走 HTTPS 白名单，见 skills_interface_spec §browser_fallback）
- [x] **P1** PubMed XML 注册为 SourceAsset；`download_supplementary` 走
      `acquire_source()` + 大文件 progress 事件（原 §2.5）

---

## Phase 3：实现表达数据 V2 Demo 链路

> 目标：GDC + Xena 表达路径迁移为 Adapter + Canonicalizer + Integrator + Profile，
> 主数据不再依赖 `main_data.csv` 固定文件名。验收见 Design §16 Phase 3。
> ✅ 组件层已完成（`app/datasets/build/`，commit 0ff757d，50 个新测试；全量 pytest 无回归）：
> Adapter / Canonicalizer / Compatibility Gate / Integrator / role-based Manifest V2 /
> `gene_expression.release.v1` Profile / demo 编排链。与 Legacy runner 的接线待 Phase 2。
> 详细记录见 docs/REVIEW_2026-08-06-phase3-expression-demo.md。

- [x] **P0** Adapter 化 GDC 与 Xena（获取逻辑进 Acquisition Provider，解析进 Adapter）
      — 解析侧：`gdc.expression.v1`（matrix + STAR counts）/ `xena.matrix.v1`；
      获取侧仍属 Acquisition（Phase 2.5）
- [x] **P0** 实现文件型 canonicalization：字段映射、实体 ID 标准化（namespace 确权
      + 版本保留）、单位策略（可证明等价转换机制就绪、零规则注册 fail-closed）；
      保留原值/转换规则/版本；生成 mapping / normalization / rejected 审计
- [x] **P0** 实现表达 Compatibility Gate（单位/尺度/主键语义/映射证据）
- [x] **P0** 实现显式 append/dedup 合并规则（`append_by_canonical_row`，镜像去重 + 冲突审计）
- [x] **P0** 生成 role-based DatasetManifest V2（primary / schema / provenance /
      audit_report；supporting 暂无侧表）
- [x] **P0** 实现表达 Validation Profile（`gene_expression.release.v1`：最低行数 /
      必填字段完整率 / 数值合法性 / 单位一致性 / provenance closure / 列数）
- [x] **P1** 基因符号映射：namespace 确权已完成（ensembl_gene / gene_symbol，
      geo_probe 待 GEO 阶段）；**本地 symbol↔ensembl 映射表已落地**
      （`app/datasets/build/gene_maps.py` 随包携带，无在线依赖；canonicalizer
      可选 `gene_symbol_map` 参数：命中转 ensembl_gene + normalization_log 审计，
      未命中保留原 namespace 不丢弃，statistics 记 `gene_symbol_mapped_count`；
      多对一聚合策略保持 NormalizationProfile `keep_all` 声明；6 项测试）
- [x] **P2** `merge_parsed_datasets`（GDC+Xena 确定性合并）迁移为 Integrator 路径，
      `tools/alignment` 降级为候选生成器（待 Phase 2 执行内核后执行）
      （V2 chain 已用 `integrator.integrate()`；新增 `datasets/build/expression_runner.py`
      把整链拆为 Operation 粒度真实执行器并接入 `DatasetBuildExecutor`——
      parse/canonicalize/compat/integrate/validate/publish 六类 handler + digest 复用 +
      重跑 SKIPPED；`tools/alignment.merge_datasets` 标注 V1 Legacy 保留至 Phase 8，
      `align_fields`/`normalize_field_names` 作候选生成器）

---

## Phase 4：修复空表和终态语义

> 目标：`BuildResult` 显式化、Publication 版本链、服务端 RunSummary。
> 验收见 Design §16 Phase 4。

- [x] **P0** 删除 metadata-only 主表占位路径（GEO 无表达矩阵时 `sample_metadata`
      占位表达行；ADR-011）（4b 完成 2026-08-07）
- [x] **P0** 引入 `BuildResult`；`RunStatus` 不再由 artifact 数量推导
- [x] **P0** 增加不可变 Publication 与 `current_publication_id`；新版本不修改旧版本状态
- [x] **P0** 服务端始终生成 `RunSummary`：COMPLETED 附 BuildResult、FAILED 附稳定
      错误分类、CANCELLED 附取消点；Agent 文本不再是唯一输出
- [x] **P0** 前端直接展示 NO_DATA / PARTIAL_SUCCESS / SPEC_REJECTED，删除通过错误
      字符串猜测 no_data 的路径
- [x] **P1** 审计产物（source list / quality / search / rejected）通过
      `audit_report` Artifact Role 发布，不在架构层固定单独文件名
- [x] **P2** `request_human_correction` function_tool + UserInputDialog
      `data_correction` 分支 + 超时退化为 `corrections_todo.csv`（原 §1.7，HIL 为
      Agent 层工具，pipeline 内自动 HIL 已否决）（4c 完成 2026-08-07）

---

## Phase 5：迁移 GEO

> 目标：GEO 按 Acquisition Provider + Adapter 拆分，多 GSE 独立发布。
> 验收见 Design §16 Phase 5。

- [x] **P0** GEO acquisition/parser 按 Acquisition Provider 与 Adapter 拆分（5 完成 2026-08-08）
- [x] **P0** 正式建模 platform、probe mapping、value scale 与 normalization（5 完成 2026-08-08）
- [x] **P0** 多 GSE 各数据集独立发布（不做跨数据集行级合并），`source_relations`（5 完成 2026-08-08）
      记录双侧关系（原 §1.5.6）
- [x] **P1** 只有通过 Compatibility Gate 的 GEO 数据才能与其他表达数据整合；（5 完成 2026-08-08）
      映射失败保留审计报告或 NO_DATA，不伪装 gene-level 数据
- [x] **P1** 消除 `_resolve_gse` 静默截断（原 §1.5.6）（5 完成 2026-08-08）
- [x] **P2** `sample_metadata` 结构化 tumor/normal 分组与配对 ID（原 §1.5.8）（5 完成 2026-08-08）

---

## Phase 6：Validation、Confidence、图表通道

> 目标：架构层固定三项发布不变量；具体规则迁入 Profile；置信度与模型提取准入
> 落地。验收见 Design §16 Phase 6。

- [x] **P0** 架构层固定"provenance closure + Profile passed + atomic promotion"
      三项发布不变量（ADR-012）
      （`datasets/build/invariants.py`：`check_release_invariants` 纯函数——
      provenance 文档在盘且覆盖全部 source asset、validation status 必须 passed、
      publish 目录 temp+rename 原子写且不重写旧版本；expression_runner 的 publish
      Operation 作为发布前 gate，失败拒绝 promotion）
- [x] **P0** 将 CSV 编码/列数、字段完整率、probe mapping 覆盖率、bbox 等具体规则
      迁入版本化 Validation Profile
      （`csv_encoding_utf8` 已入 `gene_expression.release.v1`：非 UTF-8 主表 FAILED
      且前置短路避免下游崩溃；列数/字段完整率已有；probe mapping 覆盖率待 Phase 5
      GEO 迁移后入 Profile；bbox/model 元数据由 chart 提取准入门禁承担）
- [x] **P0** 实现 Confidence Contract 与确定性统计检测器（benford_distance /
      last_digit_chi2 / detect_constant_column / detect_arithmetic_progression /
      aggregate_confidence_metrics，含 `is_benford_applicable` 前置判定）（原 §6.1）
      （✅ 检测器纯函数已落地：`app/datasets/build/confidence.py` + 24 项单元测试；
      阈值由 Profile 持有 `ConfidenceThresholds`；契约侧已落地——manifest
      `confidence_summary` 由 `build_confidence_summary` 汇总 `confidence_report.csv`
      异常计数，无报告时为全零）
- [x] **P0** 为 VLM 图表点填充置信度、页码/bbox/model 元数据；建立模型提取准入
      门禁（缺置信度或 source-of-record 时对应 Profile 失败）
      （`extract_chart_data_vlm`：L1 点带 confidence + chart 行 page_number/bbox/
      extraction_tier 元数据；新增 `validate_chart_extraction` 准入——L1 点缺
      confidence 或缺 model_name → 整批拒绝、不落盘；L2/L3 确定性兜底豁免；
      9 项新测试）
- [x] **P1** 产出 `confidence_report.csv`；validation 增加 data_confidence 补充检查
      （低分 → valid_with_warnings）（原 §6.1）
      （`ExpressionValidationProfile` 增加 data_confidence check：统计异常仅作
      warning（v1 不阻断发布，SURVEY §7），报告写入 validation_report.json 的
      warnings 字段并产出 `confidence_report.csv`；5 项新测试）
- [x] **P1** 单位不一致检测写入 `warnings.csv`（原 §2.7.2）
- [x] **P1** `chart_data` 完整性校验（原 §2.7.1）
- [x] **P2** 通用 provenance coverage 统计
      （`manifest.compute_provenance_coverage`：primary 行 `traced_rows` / `untraced_rows` /
      `coverage_ratio`，asset 集合来自 provenance.json 的 source assets；coverage 写入
      `dataset_manifest.json` 的 `provenance_summary.coverage`）
- [x] **P2** `extract_tables` OCR 回退 + 中文支持（原 §2.7.3）
      （Qwen-VL 已替代传统 OCR（pyproject 注释）；落地为扫描 PDF 无文本层诊断 + VLM 通道
      warning + regex 回退 CJK/UTF-16 解码；修复 `_decompress_pdf_streams` FlateDecode
      匹配 bug——原 decompression 为静默 no-op）
- [x] **P2** DE 分析 BH FDR 校正与 `padj` 输出（原 §2.7.4）
      （`run_differential_expression`：BH 校正全集 p 值（截断前），DEG 条目新增 `padj`，
      排序保持原始 pvalue，NaN 收敛为 1.0；10 项新测试）
- [x] **P2** `extract_tables` 真实 pdfplumber 路径测试与最小 PDF fixture（原 §2.7.5）
      （`tests/fixtures/pdf/minimal_table.pdf` + `scanned_image.pdf`，真实解析无 mock）

---

## Phase 7：Cache、前端与 API 完整迁移

> 目标：Schema-aware Cache、Manifest-driven 前端、通用 operation 事件、API 状态分离。
> 验收见 Design §16 Phase 7。

- [x] **P0** V2 Dataset Cache：`cache/datasets/<namespace>/<dataset_id>/`
      （manifest + data + schema + provenance）；键含 family / Schema version /
      source binding / Adapter version / normalization profile / query / asset digest；
      关键词仅用于检索
      （✅ 最小实现已落地：`datasets/build/cache.py`——`DatasetCacheV2` 内容寻址
      `dataset_id`（`derive_dataset_id` 覆盖 family/schema_ref/bindings/adapter/
      normalization/merge/asset digests，关键词仅检索）、原子写（staging+rename）、
      幂等 commit；`execute_dataset_build` 发布成功后 commit 到 `build` namespace；
      6 项测试。✅ API/检索端点（Phase 7 T2）已落地：`GET /cache/datasets` /
      `GET /cache/datasets/{id}` / 缓存 artifact 下载 + 旧 artifact API 双读双写迁移）
- [x] **P0** Manifest-driven ResultsViewer：读 `dataset_manifest.json`，展示 family /
      row grain / Schema / 有效行数 / 来源覆盖 / Validation / confidence /
      provenance 覆盖率 / 部分成功或 NO_DATA 原因（原 §3.1 改写）
      （Phase 7 T4：`BuildResultsViewer`——`GET /builds/{build_id}` + `?task_id=`，
      family/grain/schema 徽章、有效行数、来源覆盖、validation、confidence、
      provenance 覆盖率；NO_DATA/partial/spec-rejected 横幅带原因，NO_DATA 用
      sky/info 样式绝不红色；`useTaskBuildId` 从最新 run 派生 build_id；11 项测试）
- [x] **P0** 通用 operation events 前端渲染（`operation_id` / `label` / `category`，
      替代固定 StageName union；兼容期保留旧 `stage_*`）
      （Phase 7 T3 后端 + T5 前端：复用既有 `operation_started/progress/completed/
      failed` 事件类型（label/category 可选，旧 events.jsonl 回放走 pydantic 默认
      `""`，reducer 纯游标推进）；pipeline stage 发射侧镜像；前端按 operation_id
      归组为 `OperationItem`（label→operation_id→category 回退、分类图标/色、状态徽章）
      + 完成后自动折叠为可展开摘要行（`tool_completed` 归组，保留手动开关））
- [x] **P0** API 分别返回 RunStatus / BuildResult / ValidationResult / Publication；
      新增 builds 端点（BuildResult 与 manifest 产物）
      （Phase 7 T1：`GET /builds`（分页 BuildResult + manifest 指针）、
      `GET /builds/{build_id}`（BuildResult + manifest + publication + artifacts，
      支持 `?task_id=` 消歧）、`GET /builds/{build_id}/artifacts/{artifact_id}`；
      durable `execution.build_result`：`execute_dataset_build` 安装 PendingDatasetBuild，
      executor `_transfer_dataset_build_outcome` 写入 `execution.build_result` 并发射
      真实 PublicationCreatedPayload；F4：V2 probe-primary 发布发射 PlatformRecord
      （`platform_audit.csv` + NOT_ATTEMPTED 记录））
- [x] **P1** 旧缓存与旧 artifact API 双读双写迁移；旧 `main_data.csv` 包装为
      `gene_expression.long.legacy.v1`（Phase 7 T2：`build/legacy_cache.py` 只读投影 +
      `build/v1_bridge.py` 双写 artifacts/ 面 + artifact API 双读；测试见
      `test_legacy_cache_wrapper.py` / `test_cache_api.py` / `test_artifact_api.py`）
- [x] **P1** 前端：ResultsViewer Tabs 分离主数据/来源/处理/警告（原 §3.1）
      （Phase 7 T4：shadcn Tabs 主数据/来源/处理/警告，复用 Table/CsvPreview；
      legacy 无 manifest 路径保留回退）
      报告卡约定（2026-08-10）：事件/API parser 保留 `BuildResult.build_id`，reducer 以
      `report:<runId>` 投影每轮独立卡片；卡片使用紧凑 `CsvPreview.maxRows=10` 和 `detail.artifacts` 文件列表（按 artifact_id 保留重复文件名，展示文件名/大小），展示来源/处理/警告摘要、Dialog tabs 与全量下载；会话列表在包装 `MessageScrollerItem` 前过滤已由 report card 接管的 `artifact` item，runtime artifact projection 仍供 legacy ResultsViewer/ArtifactSheet 使用；`ArtifactFab` 仅作为无 V2 build 时的 legacy fallback。
- [x] **P1** 前端：对话流任务节点自动折叠（以 `tool_completed` 归组）（原 §3.4）
      （Phase 7 T5：operation/tool 事件按完成归组折叠为紧凑摘要行，手动开关保留）
- [x] **P2** `toolLabels` 新增 `invoke_skill` / `find_skill` formatter（原 §3.2）
      （T6 核实：工具标签映射已含两者（19 项测试），无需新增）
- [x] **P2** 模型搜索框恢复与 `LEGACY_MODELS` 硬编码清理（原 §3.3）
      （Phase 7 T6：删除死 `LEGACY_MODELS` 分支，搜索框始终走真实 `GET /models`
      端点 + 4 项小离线回退 `lib/modelChoices.ts`）
- [~] **P2** 通用 UI 改进（command/menubar、缓存导出按钮、对话路由等）（原 §3.5）
      （Phase 7 T6 部分完成：缓存导出按钮已接线（sidebar + settings，复用既有
      `GET /cache/export`）；command/menubar 跳过（无现有模式、成本高）与对话路由
      延后——见 REVIEW §5 遗留）

---

## Phase 8：清理 Legacy

> 前提：V2 闭环通过四种必测结果（成功/部分成功/无数据/执行失败）。
> 删除清单见 Design §16 Phase 8 与 ARCHITECTURE §2。
> 收窄执行（2026-08-08，见 REVIEW_2026-08-08-phase8-legacy-cleanup.md）：
> 审计发现大部分删除目标**已不存在**或**依赖 V1 生产路径退役**（未决架构决策，
> 见下「遗留」）。本阶段勾选已完成的清理项 + 全量回归；未决项标注 `[~]` 遗留。

- [x] **P1** 删除固定 `_STAGES`、`StageName` 业务依赖、
      `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 语义门禁（可保留来源级安全 allowlist）
      （✅ V1 退役后完成：`_STAGES` 已删、`StageName` 枚举保留供 runtime/skills/events；
      兼容门禁及守卫测试随 review R2 删除）
- [x] **P1** 删除 22 列缓存硬编码写入接口与 `domain/processing.py` 旧 ParsedDataset
      （✅ `domain/processing.py` 已随 V1 退役删除；`CacheStore.commit_dataset`
      写入接口仍保留——由 `cache_tools.commit_to_cache`（import_agent 生产路径）
      调用，P2 重审 22 列写入面）
- [x] **P1** 正式路径删除 `tools/alignment.merge_datasets`（保留为映射候选生成器）
      （✅ V1 退役后完成：`tools/alignment` 已删，V2 合并由 integrator
      的 append_by_canonical_row 策略承担）
- [x] **P1** 删除 metadata-only 占位与 `run_research_pipeline` 旧参数面
      （✅ metadata-only 占位已在 Phase 4b 删除；`run_research_pipeline`
      已随 V1 退役删除（agent 主线切换 `execute_dataset_build`））
- [x] **P1** 删除遗留死代码：`tools/parse_pdb.py` / `parse_geo.py` / `parse_excel.py` /
      `cleaning.py` 及相关测试（`test_processing.py`、`test_config.py` 的 openpyxl
      依赖检查）——依据 REVIEW §5.2 结论
      （审计确认：四文件均不存在；`test_processing.py` 不存在；openpyxl/xlrd 不在
      `pyproject.toml` 依赖且 app/tests 零导入；`test_config.py:144-160` 死依赖检查
      仅覆盖 biopython/geoparse 且已通过。REVIEW §5.2 删除清单已达成，仅剩
      `domain/processing.py` 与 `tools/alignment.py`——见上遗留项）
- [x] **P2** 删除任何 V2 `DatasetRequest` / `BuildRecipe` 临时实现
      （审计确认：代码中已不存在，仅 docs 提及（TODO/ARCHITECTURE/design 与
      `datasets/runtime/operations.py:6` 注释））
- [x] **P2** 全量回归：`uv run pytest`、Ruff、前端 `pnpm lint/tsc/build/test` 通过，
      `uvicorn app.main:app` 干净启动；ARCHITECTURE 标记与代码一致
      （2026-08-08 收尾：后端 2722 passed / ruff clean / import OK；前端 726
      passed (47 files) / lint 0 / tsc 0 / build OK。ARCHITECTURE 顶注已诚实标注
      「代码仍为 V1、V2 绞杀模式」，无需改动）

**Phase 8 遗留（已决策并执行）**：V1 生产路径退役——已拍板全移除并合并
（见 LEFTOVERS A1，main @ 9a7f19d + review R2 收尾）。agent 主线已切到
V2 `execute_dataset_build`（INSTRUCTIONS 全量引导 + `validate_dataset_build_spec`
预检），e2e 已走 V2 且四种必测结果有测试。下方 `[x]` 项均已达成；
后续批次：P3 前端（B3/B5/C2a/C3e/E 类 UI）、P4 测试补强与性能（D1-D5/
C5a/C5b/C6a）——真实遗留项见 LEFTOVERS。

---

## 独立维护项（不阻塞 V2 主线，随阶段推进）

- [x] **P1** 结构化日志（structlog / python-json-logger）（原 §4.4）
      （零新依赖标准库实现 `app/logging_setup.py`：`JsonFormatter` 输出
      `logs/app.jsonl` JSON 行 + `RotatingFileHandler` 轮转（1MB×5）；
      `set_log_context` 基于 contextvars 绑定 task_id/run_id/stage，
      manager `_execute` 绑定 task/run、runner `_run_stage` 绑定 stage
      （`asyncio.to_thread` 自动传播 context 到 stage 线程）；控制台保持
      人类可读文本；事件审计 pipeline.jsonl 通道不变；7 项新测试。
      附带修复：`_recover` 补发 PublicationCreatedPayload 时
      `request_fingerprint="recovery"` 违反 `^[0-9a-f]{64}$` 契约导致
      带历史 marker 数据启动崩溃 → 改确定性 sha256 指纹）
- [x] **P1** Xena 403 修复：移除 `test_all_data_sources_live.py` 的 xfail（原 §2.2）
      （根因是 S3 ListObjectsV2 桶策略拒绝（403）；`search_xena` 改走官方
      hub 查询 API `POST https://toil.xenahubs.net/data/`（all-datasets，
      text/plain body，xenaPython 同款查询），S3 XML 列表保留为兜底；
      crawler `api_request` 新增 `raw_body` 支持；live xfail 移除；
      END-TO-END 实测返回 27 个 TCGA 数据集）
- [x] **P2** 监控并发 Chromium 实例数，超阈值排队（原 §5.2）
      （BrowserPool 已由 Semaphore 保证排队；补充监控：`active_operations` /
      `queued_operations` / `max_contexts` 只读属性，`_begin_operation` 维护
      排队计数（acquire 取消时正确归还），1 项新测试验证 2 active + 2 queued）
- [x] **P2** `config.py` 扩展（crawler_ua / rate_limit / stage_timeouts）、
      `DASHSCOPE_API_KEY` 启动校验、`OUTPUT_DIR` 绝对路径默认值（原 §5.3）
      （`Settings` 新增 crawler_ua / rate_limit_seconds / stage_timeouts（frozen
      dataclass 用 `field(default_factory=...)` 解析 `STAGE_TIMEOUTS` JSON）；
      `main.py` lifespan 接线 `CrawlerFacade(min_interval=rate_limit_seconds)`
      并校验 `DASHSCOPE_API_KEY` 缺失告警；`tool.py` 新增
      `_stage_timeouts_from_settings` 映射 StageName；`OUTPUT_DIR` 默认解析为
      绝对路径；`.env.example` 补充文档；5 项新测试）
- [ ] **P2** Agent INSTRUCTIONS 增加"达到 max_turns 后输出 `[MAX_TURNS_REACHED]`"
      指导（原 §4.5）
- [x] **P2** 新增 UniProt / ChEMBL 等 Agent-only 来源能力（不接入 Pipeline）（原 §1.4）
      ✅ 已修（2026-08-09, feat/leftovers-p2, commit 7d5893a）
