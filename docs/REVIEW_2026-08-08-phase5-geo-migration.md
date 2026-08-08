# REVIEW — Phase 5 GEO 迁移（Provider + Adapter + 实体级契约 + 多 GSE）

日期：2026-08-08
分支：`feat/phase5-geo-migration`（base main @ b813cf7，22 commits）
结论：**TODO Phase 5 六项全部落地（T1-T8，TDD 红→绿）；Design §16 Phase 5 三项验收全达；最终整体 review PASS + 1 项 MUST-FIX（F1）已修复。** 终态：后端 2638 passed / 前端 687 passed / ruff 全量门 clean。

## 1. 交付内容

对应 `docs/TODO.md` Phase 5 六项与 Design §16 Phase 5 验收
（设计文档：`docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md`，spec v3 经两轮 review 定稿）：

| TODO Phase 5 | 交付 | 任务 |
| --- | --- | --- |
| P0 GEO acquisition/parser 按 Provider 与 Adapter 拆分 | `geo.series.v1`/`geo.platform.v1` provider（普通模块函数 + dispatcher，无插件注册表）+ `geo.expression.v1` Adapter（tximport/series_matrix/supplementary 三格式，fail-closed） | T2、T3 |
| P0 正式建模 platform、probe mapping、value scale 与 normalization | `PlatformRecord`/`ProbeMappingSummary`/`ValueScale`/`AdapterParams` 契约（跨字段 validator）；`gene_expression.probe_long.v1` schema 注册；`NormalizationProfile.allowed_value_scales`；measurement identity 三元组 | T1、T2、T3、T4 |
| P0 多 GSE 独立发布，`source_relations` 双侧关系 | `MultiBuildOrchestrator`（失败隔离 + no-supersede）+ build-scoped supersede + 双向 inverse relation rows | T6 |
| P1 Gate 后才整合；映射失败审计或 NO_DATA | unknown×unknown 门 + 实体级矩阵 + `probe_coverage_required_gene_level`；D5 四行结果 E2E（NO_DATA-with-audit、`probe_mapping_unavailable_required_gene_level`） | T5、T7 |
| P1 消除 `_resolve_gse` 静默截断 | `geo_accession.py` finditer 全候选检测；>1 显式 raise；跨字段（query+dataset）检测 | T6 |
| P2 `sample_metadata` tumor/normal 分组与配对 | `geo.sample-group.v1` 版本化词汇表 + 显式 pairing key；artifact 增列 + warning 持久化 | T8 |

## 2. 实现事实（T1-T8，均 TDD 红→绿）

- **T1 契约层**（`0cd7179`）：`ValueScale`/`AdapterParams`/`AnnotationStatus`/`PlatformRecord`/`ProbeMappingStatus`/`ProbeMappingSummary`（D3 全量跨字段 validator + 序列化往返）+ `gene_expression.probe_long.v1` 注册（granularity `probe_sample_measurement`，PK `(probe_id,platform_id,sample_id)`）+ `DatasetBuildSpec.target_entity_level` + source-long `gene_id_namespace_declared` 内部列。
- **T2 Adapter**（`6bc34b5`）：`GeoExpressionAdapter` 三格式；`AdapterParams` 经 SpecValidator 校验 + runner/chain 透传 + **per-binding parameter digest**（改参不复用 checkpoint）；canonicalizer 消费 declared namespace（不再外形猜测，T1 xfail 摘除）；GDC/Xena 输出字节级不变。
- **T3 Provider + platform→sample 关联**（`245faf3`）：`geo_provider.py`/`geo_association.py`；D8 证据关联（每 sample 声明 GPL，GPL A 映射绝不用于 GPL B 样本；多平台无证据 fail-closed；单平台全系列窄 fallback）；`_load_geo_gene_map` 收敛 + `platform_audit.csv`/`sample_platform_evidence.csv`。
- **T4 ValueScale/identity**（`c261238`）：`allowed_value_scales` + canonicalizer scale 校验（`unknown_scale` 拒绝、`unknown` 不推 log2）；`MeasurementIdentity` 原语；`ValidationProfile.required_entity_level` + `gene_expression.probe_release.v1`。
- **T5 Gate 矩阵**（`ba6e779`）：D4 全表；**unknown×unknown 跨源 FAIL**（measurement_identity_mismatch）；实体级 schema/granularity 矩阵；`probe_coverage_required_gene_level`（gene 要求 coverage==1.0 FAILED；probe warning-only）；Agent 经参数走私阈值被拒。
- **T6 多 GSE 编排**（`887b234`）：`MultiBuildOrchestrator`（`BuildExecutionSummary`，无 BuildOutcome）+ build-scoped supersede（`find_latest_publication(publish_dir, build_id)`）+ 双向 relation generator（`article_describes_dataset`/`dataset_described_by_article`、`related_series` 有据双向、`ext:pubmed`）+ raise-not-truncate（跨字段全候选）。
- **T7 E2E**（`0b4a938`）：per-binding fan-out（phase A 捕获 BindingRejection、phase B 只收存活 binding）；pipeline/tool 分层（gene 要求 + 零可发布行 → 4b NO_DATA 路径；coverage<1 → Profile FAILED；tool 分类器 → `probe_mapping_unavailable_required_gene_level`）；`ProbeMappingSummary` 真实链路发射；D5 四行 E2E（copy-dir + 损坏资产）。
- **T8 tumor/normal**（`f06b76f`）：`geo.sample-group.v1` 词汇表（高置信 key 优先级、冲突→unknown+warning、原值保留）；显式 pairing key（禁 GSM 序/标题推断）；artifact 四列 + warning 进 `warnings.csv`。
- **修复波**（`2449cad`）：F1 SpecValidator 工具入口接线（entity 级不匹配 production 拒绝 invalid_input）；F2 mapping asset sha 双向不变量；F3 ambiguous probe 检测（多 DISTINCT 目标 → ambiguous 不映射）；F6 T8 warning 持久化。

## 3. 与规格的偏差

1. **F4（接受）**：D5 行 2 的 probe-primary publication 未发射 `PlatformRecord`（仅 ProbeMappingSummary + audits；V1 由 T3 覆盖，V2 记录为 Phase 7 项）。
2. **F5（接受，wave-7 一致性）**：D5 行 3 的"多 binding 有存活 gene 源 → partial"在 coverage<1.0 场景未实现 per-binding 排除（整 build NO_DATA）——与 wave-7"中止混合源不判 PARTIAL_SUCCESS"一致，文档化。
3. **T7 语义变化（有测试 pin）**：corrupted/all-rejected 源现产 NO_DATA 信封（`parse_error:<id>` 码）替代旧通用 retryable error；T1 时代"gene schema 拒绝 geo_probe 行"的 canonicalizer 断言改为 validation 层执行（D2/D5）。
4. **relations 校验扩展**：`validation/checks/relations.py` 超出 T6 seam 列表——V1 check 消费 `source_relations.csv`，不识别新 inverse 类型会破坏 `source_relation_evidence`（双向关系的正当后果）。
5. **T8 warning 证据列表**：conflict warning 在 artifact 时间点只含主原始证据（`GeoSampleMetadata` 未保留全证据列表，T8 边界局限，文档化）。

## 4. 验证结果（终态门）

| 门 | 结果 |
| --- | --- |
| 后端 pytest | `2638 passed, 2 skipped, 28 deselected` |
| 后端 ruff（全量 `app/ tests/ launcher.py`） | `All checks passed!`（零告警） |
| `python -c "import app.main"` | OK |
| uvicorn 冒烟 | `/api/v1/health` → `{"status":"ok",...}` |
| 前端 test | `687 passed (42 files)`（Phase 5 纯后端，无回归） |
| 前端 lint / build | 0 errors / OK |

## 5. 遗留与后续

- **Provider dispatcher 是 forward seam**：`geo.series.v1`/`geo.platform.v1` 的 `resolve_provider` dispatcher 与 `acquire_series_asset` 目前**零 production 消费者**（仅 `test_geo_provider.py`）——V1 直接 import URL/fixture helper（`geo_provider`/`geo_annotation` 的模块函数），Phase 7 build API 将接线 dispatcher。`normalize_series_accession` 经 `series_suppl_directory_url`/`series_matrix_url`/`series_family_soft_url` 传递生产消费（非零消费者）；`fetch_platform_annotation`（geo_annotation）已被 `acquire_platform_annotation`（geo_provider）取代，保留为 test-only seam。GPL-prefix 规则为单一实现：`platform_dir_prefix` 规范化后委托 `geo_annotation.geo_platform_dir`（review-loop R2b-02）。（review-loop R3-1/R3-3/R2b-05）
- **F4/F5** 见 §3（文档化偏差，Phase 7/后续）。
- **Phase 6 P0 接线项**：probe mapping 覆盖率阈值入 Profile（Phase 5 已交付 `probe_coverage_required_gene_level` 语义完整性检查；校准门槛留 Phase 6 后续）。
- **Phase 7 承接**：`PlatformRecord` V2 publication 发射、corrections_todo/audit 可见性、build API（`MultiBuildOrchestrator` 为接缝）、operation event UI。
- **V2-dup 延后项**：`execute_dataset_build` 结构化结果 → durable `execution.build_result` 接线仍开放（bug-sweep REVIEW §3）。
- **fixture 资产**：新增的 probe/GPL 关联与 tumor/normal 样例均基于 copy-dir + 合成资产（未改共享 fixture、无 live network 依赖）。
