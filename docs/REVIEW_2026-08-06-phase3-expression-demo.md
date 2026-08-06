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
- **`hashlib.file_digest(handle)` 必须用 with 关闭句柄**：直接 `file_digest(path.open("rb"))`
  泄漏句柄，pytest warnings-as-errors 会以 ResourceWarning 挂掉测试。统一走
  `app/datasets/build/hashing.py:sha256_file`。

## 6. 评审修复（2026-08-06 三轮对抗性评审后）

三轮平行评审（正确性 / 测试质量 / 架构）共 30+ 发现，已落地修复：

1. **非有限数值统一策略**（HIGH）：blank/NaN/Inf 全部按行级 rejected 审计
   （`non_finite_value`），不再静默进入主表，也不再使整个来源致命失败；
   canonicalizer 与 `gene_expression.release.v1` 的数值检查改用 `math.isfinite`；
   integrator 的 `_numerically_equal` 对 NaN 镜像按去重而非冲突处理。
2. **拒绝重跑不再残留旧产物**（HIGH）：chain 起始清空构建工作区，
   被 gate/validation 拒绝后不会遗留上一轮的 `primary.csv` / `dataset_manifest.json`。
3. **manifest 单次落盘**（HIGH）：拆分 `assemble_manifest`（纯）+ `write_manifest`，
   chain 先 assemble（占位 validation 仅喂 digest，不落盘）→ validate → 带真实结果
   assemble → 只写一次；崩溃不可能留下"已通过但零检查"的假 manifest。
4. **GDC 注释列**：`gene_name` / `gene_type` / `gene_version` 从样本列中剔除，
   列定位改用 `header.index()`（真实 files-API 导出矩阵可解析）。
5. **STAR 行 `source_sample_alias` 置空**（不再误填指标列名）；
   **record_id 改用 `gene_id_raw`**（ENSG 不同版本不再碰撞，与 adapter 一致）。
6. **零行来源拒绝**：任一来源 canonical 0 行 → `source_yielded_no_rows`，
   不再"成功但吞掉来源"；缺 binding 时抛 `BuildError` 而非裸 `KeyError`。
7. **流式哈希**：`sha256_file` 取代全文件 `read_bytes()`（GB 级矩阵只流式读一遍）。
8. **宽表提取合并**：GDC/Xena matrix 共用 `_wide_matrix_mappings` +
   `_emit_matrix_cells`（消除 ~70 行重复；空行策略差异保留局部）。
9. **测试增强**：NaN/Inf、`.gz`、STAR `unstranded` 回退、GDC 注释列、空行策略、
   `1.0` vs `1` 去重、measurement_type 参与 identity、NaN 镜像去重、
   同目录拒绝清理、零行来源、缺 binding——新增 ~25 个用例。
10. **Xena fixture 与 GDC 去同**：`xena_matrix.tsv` 改为差异化值（TP53/S2=9.9），
    镜像去重测试改用同一 fixture 双 binding，避免自证式测试掩盖列偏移 bug。

测试：数据集 75 用例 + 全量 `uv run pytest` 2116 passed；ruff 新增文件零告警。

## 7. 未完成项（TODO 原样保留或部分完成）

- [ ] **P1 基因符号映射"优先本地映射"**：namespace 确权已实现（`authorize_namespace`），
      但本地 symbol↔ensembl 映射表（"优先本地映射"）尚未落地；多对一聚合策略已在
      `NormalizationProfile.aggregation_policy` 声明（默认 `keep_all`），规则化执行待 GEO 阶段。
- [ ] **P2 `merge_parsed_datasets` 迁移 / `tools/alignment` 降级**：需要先完成
      Phase 2 执行内核并把 legacy runner 切到 V2 链，才可安全移除旧合并路径。
- [ ] **单位转换规则**：机制就绪、零规则注册；当 demo 需要合并 TPM 与 FPKM 等
      可证明等价单位时按 §8.5 声明 `UnitConversionRule` 即可，无需改代码。
