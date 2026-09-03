
# BioMed-QAgent 架构 — 历史、Demo 与决策记录

> 本文是 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的拆分章节（原 §18、§21-§23、
> 附录 A），章节编号与主文件保持一致。

---

## 18. 迁移状态（historical）

本系统由 V1（Python Pipeline）按**绞杀模式（strangler）**演进而来：V2 引入
自包含 `DatasetBuildSpec` / `DatasetManifest` / `ValidationResult` /
`DatasetPublication` 等契约（§3），逐步接管 Agent、Runtime 与数据处理，最终于
2026-08-14（Phase 0–8）物理删除 legacy Python Runtime、FastAPI、rollback
profile 与 feature flags。当前不存在 V1 运行时、Python Dataset Core 或任何
"双轨"拓扑。

迁移期的中间拓扑与决策记录保留于 [migration/README.md](../migration/README.md) 与
[docs/adr/](../adr/README.md)（ADR-017 起），不再代表当前系统；历史 Review 与
Survey 归档于 `docs/archive/`。Phase 8 执行计划、盘点与验证见
[migration/phase8-python-runtime-retirement.md](../migration/phase8-python-runtime-retirement.md)、
[migration/phase8-retirement-inventory.md](../migration/phase8-retirement-inventory.md)、
[migration/PHASE8_FINAL_VERIFICATION.md](../migration/PHASE8_FINAL_VERIFICATION.md)。

> 决策依据：ADR-016、ADR §26（文档治理）。

### 18.4 Pi / TypeScript Host 迁移边界（Phase 0/1，已归档）

Pi 采用同一绞杀原则替换**模型面对的 Agent 层**，不替换 Dataset Construction
Runtime 的确定性业务语义。Pi Session、BioMed Task、Run 与 DatasetBuild 是四个
不同生命周期；Pi 依赖只允许出现在 `server/src/agent/pi-adapter.ts` 或等价
adapter 边界；TypeScript wire DTO 统一来自 `@biomed/contracts`。迁移期的资源
所有权、桥协议、Workspace 和事件映射记录见 [migration/README.md](../migration/README.md)。

Phase 3/5/6/7 各阶段的实现与验证记录见 [migration/README.md](../migration/README.md)
下的对应文档（`phase3-ts-application-runtime.md`、`phase5-external-capabilities*.md`、
`phase6-model-settings.md`、`phase7-frontend-ts-host.md`、`phase8-*`）。Phase 7
之后的默认拓扑即为当前系统；§18 描述的迁移期中间拓扑只作决策记录，不再适用。

---

## 21. Demo 决策

### 21.1 主案例

`gene_expression` 数据集构建。

### 21.2 来源优先级

GDC、Xena 优先；GEO 在完成平台、probe mapping、尺度和归一化兼容性后加入
（见 §7 来源能力与 §8 字段映射）。

### 21.3 PubMed 角色

- 发现相关研究和 accession；
- 说明数据选择依据；
- 提供来源关系；
- **不作为表达主表行**。

### 21.4 Reactome 角色

独立 `pathway_member` 数据集族，用于证明系统可扩展到第二个 Schema，**不与表达
数据合并**。

### 21.5 必测四种结果

1. **成功**：两来源兼容并合并，发布 DatasetPublication；
2. **部分成功**：一个来源失败但另一个有效，且 Profile 允许发布；
3. **无数据**：来源不适合或无目标记录，返回 `NO_DATA`，不生成假表；
4. **执行失败**：文件损坏或 Parser 异常，`RunStatus=FAILED`，不产生 BuildResult，
   也不发布。

### 21.6 固定真实验收案例（参考）

固定验收案例作为回归基线：

- Topic：`breast cancer gene expression under Hsp70 inhibition`；
- PubMed：PMID `34180400`；
- GEO：`GSE178352`；
- 样本数：12；
- 处理后计数文件：`GSE178352_tximportCounts.txt.gz`（4,597,797 bytes，SHA-256
  `71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55`）。

默认测试使用记录来源与裁剪范围的真实 fixture；标记为 `live` 的集成测试下载完
整官方文件并验证 checksum、样本标识和解析兼容性。Mock Demo 仅作为开发烟雾测
试，不能满足正式验收，也不能在真实流程失败后自动转为成功。

> 决策依据：ADR §24（推荐 Demo 决策）。

---

## 22. 待决问题

以下问题不阻塞第一阶段，但需在实现中形成新 ADR：

### 22.1 主数据文件格式

Demo 使用 CSV；大数据内部是否使用 Parquet，发布是否同时提供 CSV，需要评估内
存、速度和用户可用性。

### 22.2 批次级与记录级 confidence 的继承规则

§11.2 已定"确定性 API 可批次级默认、VLM/LLM 抽取需记录级"。待定的是批次默认
值何时被记录级判定继承或覆盖，以及前端如何呈现。

### 22.3 Provenance sidecar 格式

CSV、JSONL 或 Parquet 的选择需考虑可读性、规模和查询效率。

### 22.4 多 Build 会话模型

一个用户任务是否直接拥有 `builds[]`，还是每次续聊产生独立 Run / Build，需要结
合现有 Runtime 数据模型决定。

### 22.5 GDC 与 Xena 镜像数据去重

两者可能呈现同一上游 TCGA 数据。需要明确 source-of-record、版本差异和重复规
则，不能把镜像当独立证据数量。

### 22.6 聚合粒度

用户有时需要 cohort-level 汇总，而现有表达长表是 gene-sample。应通过版本化 aggregation profile 或 deterministic operator 生成另一个 Schema，不能在同表混合。

### 22.7 人工确认点

字段映射和单位转换的 HIL 触发范围仍需按 Demo 交互成本确定。图表坐标的
精确性不再是开放设计问题：依据 [ADR-043](../adr/043-exact-only-chart-values.md)，
HIL 只能确认 figure/series/axis/legend 语义或来源映射，不能把低置信、数字化或
模型推断的点升级为 exact；没有显式 numeric source-data 时应审计后跳过
`chart_points` 并报告缺口。

### 22.8 内置 Python 解释器分发

当前 `database/` bridge 依赖环境 Python：TS DatabaseClient 按
`BIOMED_PYTHON_BIN` → 仓库 `.venv` → PATH 探测解释器
（`server/src/persistence/db-client.ts`）。规划将 Python 运行时随应用打包
（内置解释器），消除用户安装与版本漂移依赖。需评估分发包体积、平台覆盖、
`.venv` 策略与 bridge 启动方式的变更。

---

## 23. 非目标

- 替换 Pi 或重新引入 OpenAI Agents SDK 作为 Agent 运行时；
- 通用 Workflow Engine 或完整 DAG 引擎；
- 正式 `DatasetRequest` 中间契约；
- 数据集级 `BuildRecipe` 或 Agent 自由生成 nodes / edges；
- 包含 Python、JavaScript、Shell 等任意代码的 WorkflowRecipe；
- 由模型直接生成可进入生产执行的 Python Skill；
- Agent 或 learned Skill 绕过 Spec Validator、Compatibility Gate、Validation
  Profile 或 Publisher；
- 允许 Agent 在 BuildSpec 中设置 `minimum_valid_rows`、
  `allow_empty_primary_dataset` 等 acceptance policy；
- 将 mock 产物当作正式案例；
- 自动生成缺乏数据依据的科研或临床结论；
- 把“多角度研究包”作为同一 DatasetBuild 的主数据；
- 用 warning 解释空主数据；
- 使用 `validated_intermediate` / `validated_final` 等可变 Artifact 状态；
- 通过 Artifact 数量或错误文本判断运行成功；
- 只靠 Prompt 修正架构（Prompt 只保留意图层原则，稳定规则进入契约和服务端
  Validator）；
- 后端事件、BuildResult、Manifest 和 Publication 契约稳定前重写前端。

受控、声明式、非代码的 Acquisition `WorkflowRecipe` **属于目标范围**，但只能由
Core Acquisition 子系统（`CoreAcquisitionRegistry` + `CoreAcquisitionRuntime`）可信
执行并产出 `SourceAsset`。

> 决策依据：ADR §19（被否决或修正的方案）。

---

## 附录 A：被否决或修正的方案

| 方案 | 处置 | 原因 |
| --- | --- | --- |
| 正式 `DatasetRequest` 契约 | 否决 | 与 `DatasetBuildSpec` 语义重复，无独立生命周期、行为或消费方 |
| 数据集级 `BuildRecipe` | 否决 | 与现有 `WorkflowRecipe` 命名和生命周期冲突，重新制造通用编排层 |
| 完整 Research DAG | 否决作为当前核心架构 | 过重、偏离评分、缺少必要场景、Agent 生成图不可靠 |
| Acquisition `WorkflowRecipe` | 保留并收窄 | 只描述受控来源获取，由可信解释器执行并只产出 SourceAsset |
| 多角度 Artifact Package 作为主产品 | 修正 | 可同时存在于一次科研会话，但不应成为同一 DatasetBuild 的同一主数据 |
| 删除全部 Pipeline | 否决 | 会丢失 SourceAsset、Attempt、digest、恢复、Validation 和原子发布 |
| 固定五阶段继续增加组合分支 | 否决 | 短期能接新来源，长期形成指数级状态组合和跨层硬编码 |
| 万能 22 列 Schema | 否决作为全局 Schema | 可作为历史表达 Schema 或表达数据族一个版本保留 |
| `validated_intermediate/final` | 否决 | 混淆 Artifact 验证、Run 结果和当前版本；改用正交状态与 Publication 指针 |
| 发布门禁固定实现清单 | 修正 | 架构层只保留 provenance closure、Profile passed、atomic promotion |
| 辅助产物固定文件清单 | 修正 | Manifest 只定义 Artifact Role，物理文件属于 Publisher 实现 |
| 用 warning 解释空主数据 | 否决 | Warning 不能改变“主表没有目标科学记录”的事实 |
| Agent 设置 acceptance policy | 否决 | 发布阈值和部分成功规则属于服务端版本化 Validation Profile |
| 只靠 Prompt 修正架构 | 否决 | Prompt 不能替代服务端契约、兼容性门禁和发布规则 |
| 通过 Artifact 数量判断运行成功 | 否决 | 应使用 RunStatus、BuildResult、ValidationResult 和 Publication |

> 完整决策记录见 [adr/legacy-decisions-and-lessons.md](../adr/legacy-decisions-and-lessons.md) 的 §19（被否决或修正的方案）。
