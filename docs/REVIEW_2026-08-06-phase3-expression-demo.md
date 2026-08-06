# REVIEW — Phase 3 表达数据 V2 Demo 链路（组件层）

日期：2026-08-06
分支：`feat/phase3-expression-demo-chain`
结论：**Phase 3 的 P0 组件全部落地并有测试**；与 Legacy runner 的接线留待
Phase 2（执行内核）后完成。P1/P2 部分项见文末"未完成项"。

## 1. 交付内容

新增自包含包 `backend/app/datasets/build/`（纯函数、确定性、无 runtime 依赖）：

| 模块 | 职责 | 对应 Design |
| --- | --- | --- |
| `adapters.py` | GDC（matrix + STAR counts 自动识别）与 Xena matrix 的 fail-closed 解析，产出 source-long DataBatch + adapter-declared FieldMapping | §8.3 parse |
| `canonicalizer.py` | namespace 确权（`ensembl_gene` / `gene_symbol`）、版本拆分、unit/semantics 策略、mapping / normalization / rejected 三层审计 | §8.5 canonicalize |
| `compat_gate.py` | family / granularity / schema / mapping 证据；多源时 unit×scale×semantics 单一性 + namespace 一致性 | §8.4 compatibility gate |
| `integrator.py` | 仅 `append_by_canonical_row`；镜像去重、冲突审计（保留首个来源，确定性） | §8.8 integrate |
| `manifest.py` | role-based DatasetManifest V2（primary / schema / provenance / audit_report）+ `provenance.json` 抽样回溯 | §8.9 / ARCH §3.6-3.7 |
| `profiles.py` | `gene_expression.normalization.v1` + `gene_expression.release.v1`（最低行数、必填字段完整率、数值合法性、单位一致性、provenance closure、列数） | §10 |
| `chain.py` | `build_expression_dataset`：parse[*] → canonicalize[*] → gate → integrate → validate → manifest 的 demo 编排 | §5.1 骨架 |

契约扩展（向后兼容，默认值均为空/None）：

- `DataBatch.declared_mappings: list[FieldMapping] = []`（Adapter 声明正式映射证据）
- 新增 `NormalizationProfile` / `UnitConversionRule` 契约（与 ValidationProfile 骨架对齐）

## 2. 验收对照（Design §16 Phase 3）

| 验收 | 状态 | 证据 |
| --- | --- | --- |
| 单 GDC / 单 Xena / 兼容 GDC+Xena 生成合法主表 | ✅ | `tests/test_dataset_build_chain.py`（7 个端到端用例） |
| 不兼容单位/尺度被拒绝 | ✅ | matrix(expression_value) + STAR(tpm_unstranded) → `measurement_identity_mismatch` |
| provenance 可抽样回溯 | ✅ | `provenance.json` 的 `sample_backtraces`（record → gene_id_raw → 规范化链 → 源文件行/列/原始值） |
| 重跑可复用成功 Operation | ⚠️ 组件级 | 全链确定性 + 内容寻址 digest（同输入同输出同 digest）；**Operation/Attempt 复用机制属 Phase 2 runtime**，未在本阶段实现 |

测试：`tests/test_dataset_{adapters,canonicalizer,compat_gate,integrator,manifest,profiles,build_chain}.py`
共 50 个新用例；`uv run pytest` 全量 2104 passed 无回归；ruff 对新增文件零告警。

## 3. 关键设计决策

1. **Adapter 输出 source-long（18 列），Canonicalizer 输出 canonical（22 列）**。
   宽表→长表转换属"格式理解"放在 Adapter；实体规范化与审计放在 Canonicalizer，
   避免 V1 parser 里宽表解析+命名空间猜测+单位标注混杂一处的旧结构。每个组件职责单一、可独立测试。
2. **单位转换 fail-closed**：`NormalizationProfile.unit_conversions` 提供规则机制但
   **零注册规则**。没有声明规则，不同 unit/semantics/scale 一律不可合并（Design §18.3
   "count 与 TPM 不静默合并"）。GDC/Xena demo 单位均为 `expression_value`，天然兼容。
3. **namespace 确权**：`^ENSG\d{11}(\.\d+)?$` → ensembl_gene（保留版本号）；
   字母符号 → gene_symbol；探针 ID（geo_probe）当前直接 rejected（Phase 5 GEO 迁移时建模）。
   V1 中 "gdc_gene"/"xena_gene" 这种按来源命名空间的旧做法被废止。
4. **STAR counts 的 `__no_feature` 等注释行**：Adapter 层拒绝并写入 parse 级
   `rejected.csv`（不再像 V1 `continue` 静默跳过），Canonicalizer 层另有
   normalization 级 rejected 文件，两层审计分离、均可入 manifest。
5. **Manifest digest 只覆盖数据产物**（primary + schema + provenance + audits），
   不含 manifest JSON 自身与 validation_report，避免循环依赖，保证确定性。

## 4. 集成点（后续阶段）

- **Phase 2**：`build_expression_dataset` 即为未来 `DatasetBuildExecutor` 的固定骨架体；
  现在由调用方传入 `source_assets` / `source_paths`（Acquisition 层职责），Executor 化时
  把 acquire 步骤接入并把每个阶段包成 Operation/Attempt（digest 复用）。
- **Phase 4**：`BuildChainResult.status`（`succeeded` / `rejected` + reason_codes）需映射为
  `BuildResultStatus`（SUCCEEDED / NO_DATA / SPEC_REJECTED / PARTIAL_SUCCESS）；`task_id`
  参数已预留。
- **Phase 8**：`main_data.csv` 固定文件名依赖移除——V2 manifest 已具备 primary_dataset
  角色定位；Legacy runner 仍是唯一还在写 `main_data.csv` 的路径，随 Phase 2/8 下线。

## 5. 坑与教训

- **`.gitignore` 陷阱**：第 29 行 `build/`（Node 产物规则）误伤
  `backend/app/datasets/build/` 源码包，git 静默忽略整个包。修复：
  `!backend/app/datasets/build/` 否定规则必须带完整相对路径（`backend/` 前缀）。
  若后续新增 `backend/app/.../build/` 源码目录，同样处理。
- **`SourceAsset` 在 `app.domain.contracts` 而非 `app.datasets.contracts`**：
  新写 imports 时注意来源，`app.datasets.contracts` 只放 V2 数据集契约。
- **Fixture 对齐真实格式**：GDC STAR-counts 表首列必须是 `gene_id`（真实 files API
  输出），fixture 首版写成 `gene_name` 导致 header 校验失败。

## 6. 未完成项（TODO 原样保留或部分完成）

- [ ] **P1 基因符号映射"优先本地映射"**：namespace 确权已实现（`authorize_namespace`），
      但本地 symbol↔ensembl 映射表（"优先本地映射"）尚未落地；多对一聚合策略已在
      `NormalizationProfile.aggregation_policy` 声明（默认 `keep_all`），规则化执行待 GEO 阶段。
- [ ] **P2 `merge_parsed_datasets` 迁移 / `tools/alignment` 降级**：需要先完成
      Phase 2 执行内核并把 legacy runner 切到 V2 链，才可安全移除旧合并路径。
- [ ] **单位转换规则**：机制就绪、零规则注册；当 demo 需要合并 TPM 与 FPKM 等
      可证明等价单位时按 §8.5 声明 `UnitConversionRule` 即可，无需改代码。
