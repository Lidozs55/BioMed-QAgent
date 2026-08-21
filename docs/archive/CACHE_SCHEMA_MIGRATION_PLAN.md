# 缓存 22 列 Schema 实体中立化迁移计划

> **Status**: Planning（未实施）
> **Trigger**: 当 `pipeline_artifact` namespace 开始被写入，或第三方导出/导入工具开始依赖缓存 schema 时，必须先完成本迁移
> **Scope**: 将 22 列 schema 中带基因假设的列名重命名为实体中立名称，并完成代码、缓存数据、Pipeline `main_data.csv` 的同步迁移
> **关联文档**: [CACHE_DESIGN.md](../architecture/cache-design.md) §3.2.1（D10 语义泛化）、§10 D10 ADR

---

## 1. 背景

D10 决策（2026-07-19）出于兼容性考虑，**只做了语义泛化而未改列名**：
`gene_id_raw` / `gene_id` / `sample_id` / `expression_value` 等列名保持不变，
仅在 IMPORT_INSTRUCTIONS 中将其语义泛化为「主实体 ID / 次实体 ID / 测量值」。

这是一次性折衷：

- **当时** Pipeline 产出的 `main_data.csv` 已用旧列名，缓存与 Pipeline 共享 schema，
  改列名会立即破坏 Pipeline 校验门、Processing 阶段的字段映射、前端可视化等 17 个文件。
- **长期** 旧列名带有强基因假设（`gene_id`），与缓存支持任意生物医学数据
  （药物 / 化合物 / 通路 / 临床 / PDF 段落）的目标语义冲突，会让新用户困惑、
  让 IMPORT 指令需要额外的「泛化解释」段落、让 LLM 在非基因场景下容易误填。

**本计划描述未来某一轮中彻底移除旧列名、完成实体中立化迁移的步骤。**

---

## 2. 目标列名映射

仅重命名「带基因假设」的列，其余列（`record_id` / `dataset_id` / `source_id` /
`asset_id` / `source_logical_file` / `source_line_number` / `source_column_index` /
`source_column_name` / `source_raw_value` / `measurement_type` / `value_semantics` /
`value_scale` / `is_normalized` / `is_integer_expected`）已实体中立，保持不变。

| 旧列名                | 新列名                       | 语义                       |
| --------------------- | ---------------------------- | -------------------------- |
| `gene_id_raw`         | `primary_entity_raw_id`      | 主实体原始 ID              |
| `gene_id`             | `primary_entity_id`          | 主实体规范 ID              |
| `gene_id_namespace`   | `primary_entity_namespace`   | 主实体 ID 命名空间         |
| `gene_id_version`     | `primary_entity_version`     | 主实体 ID 版本             |
| `sample_id`           | `secondary_entity_id`        | 次实体 ID（测量上下文）    |
| `source_sample_alias` | `secondary_entity_alias`     | 次实体原始别名             |
| `expression_value`    | `measurement_value`          | 测量值                     |
| `expression_unit`     | `measurement_unit`           | 测量单位                   |

共 **8 列**重命名，14 列保持不变。

`CACHE_MAIN_DATA_COLUMNS` 元组顺序不变，仅替换对应位置的字符串。

---

## 3. 受影响代码（基于 2026-07-19 快照）

`grep -rln 'gene_id_raw\|gene_id_namespace\|expression_value' backend/` 命中 17 个文件：

### 3.1 必须同步修改的源码（schema 单一来源 + 消费者）

| 文件                                                     | 改动类型                                   |
| -------------------------------------------------------- | ------------------------------------------ |
| `backend/app/tools/cache_store.py`                       | `CACHE_MAIN_DATA_COLUMNS` 元组（单一来源） |
| `backend/app/tools/cache_tools.py`                       | 文档字符串示例                             |
| `backend/app/skills/builtin/acquisition/local_cache.py`  | 查询/展示逻辑中的列名引用                  |
| `backend/app/agent_loop/import_agent.py`                 | IMPORT_INSTRUCTIONS 的 schema 表 + 示例    |
| `backend/app/agent_loop/agent.py`                        | 主 Agent 的 schema 文档                    |
| `backend/app/pipeline/stages/processing.py`              | 产出行时填列                               |
| `backend/app/pipeline/stages/artifact_build.py`          | 拼装 `main_data.csv`                       |
| `backend/app/pipeline/stages/validation.py`              | 校验 22 列 schema                          |
| `backend/app/pipeline/processing/geo_tximport.py`        | GEO tximport 产出行                        |
| `backend/app/domain/contracts/ids.py`                    | 如有 ID 类型常量                           |

### 3.2 测试与 fixture

| 文件                                                     | 改动类型                                   |
| -------------------------------------------------------- | ------------------------------------------ |
| `backend/tests/test_cache_store.py`                      | 列名断言                                   |
| `backend/tests/test_cache_tools.py`                      | 列名断言                                   |
| `backend/tests/agent_loop/test_import_agent.py`          | 指令包含列名的断言                         |
| `backend/tests/pipeline/test_geo_tximport_processing.py` | 行字段断言                                 |
| `backend/tests/pipeline/test_artifact_metadata_correctness.py` | 列名断言                              |
| `backend/tests/pipeline/test_validation_rules.py`        | 校验规则断言                               |
| `backend/tests/fixtures/import/expression_subset.csv`    | fixture 表头                               |

### 3.3 文档

| 文件                                     | 改动类型                  |
| ---------------------------------------- | ------------------------- |
| `docs/architecture/cache-design.md`                   | §3.2 列表 + §3.2.1 泛化表 |
| `docs/ARCHITECTURE.md`                   | 如有 schema 章节          |
| `docs/skills_interface_spec.md`          | 如有列名引用              |
| `backend/AGENTS.md` / `frontend/AGENTS.md` | 如有列名引用            |
| IMPORT_INSTRUCTIONS                      | 移除「泛化解释」段落      |

### 3.4 前端

需 grep `gene_id` / `expression_value` 在 `frontend/src/` 中的引用，
预计主要为 `main_data.csv` 预览组件、列名展示、可视化组件。

---

## 4. 迁移步骤

### 第 1 步：版本分支

```
git checkout -b feat/schema-entity-neutral
```

### 第 2 步：代码层一次性切换

1. 修改 `CACHE_MAIN_DATA_COLUMNS` 元组（单一来源）。
2. 全仓 `grep` 替换 8 个旧列名为新列名（注意只替换 schema 列名上下文，
   不要误伤 `gene_id` 作为变量名 / 函数参数的局部用法 — 需人工 review）。
3. 移除 IMPORT_INSTRUCTIONS 中的「Schema 语义泛化（D10）」段落
   （新列名已天然实体中立，不需要泛化解释）。
4. 移除 [CACHE_DESIGN.md](../architecture/cache-design.md) §3.2.1 的泛化解释表，
   改为「列名已实体中立」的简单陈述。

### 第 3 步：数据层迁移

#### 3.1 缓存数据（`data/cache/records/`）

写一个一次性迁移脚本 `backend/scripts/migrate_cache_schema.py`：

- 遍历 `data/cache/records/<ns>/<id>/main_data.csv`
- 读取表头，若包含旧列名则用 `csv.DictReader` + `csv.DictWriter` 重写，
  将 8 个旧列名替换为新列名
- 同时更新 `manifest.json` 的 `column_count`（仍为 22，但记录已迁移）
- 备份原文件到 `main_data.csv.bak.<timestamp>`

#### 3.2 Pipeline `main_data.csv`（`data/output/<task_id>/artifacts/`）

Pipeline 是即跑即产的，**不需要迁移历史 artifact**：
- 历史 artifact 的 `main_data.csv` 保持旧列名，仅供查阅
- 迁移分支合并后，新跑的 Pipeline 用新列名
- 若需严格一致，可同样跑一遍迁移脚本覆盖历史 artifact

#### 3.3 SQLite 索引

`index.sqlite3` 的 `datasets` 表不存 CSV 列名，**无需迁移**。

### 第 4 步：测试同步

- 更新所有测试中的列名断言
- 更新 fixture `expression_subset.csv` 的表头
- 新增一个迁移脚本测试：构造旧列名 CSV → 跑迁移 → 断言新列名 + 数据完整

### 第 5 步：质量门

按 [AGENTS.md](../AGENTS.md) §7.3：

- `uv run ruff check app/ tests/ launcher.py`
- `uv run pytest`（必须 0 失败，包括 `test_execution.py` 等历史 pre-existing failures 需先解决或与本迁移解耦）
- `pnpm lint && pnpm tsc && pnpm build && pnpm test`
- 清 `__pycache__` 后 `uv run uvicorn app.main:app --reload` 启动正常
- 手动跑一次 IMPORT 任务 + 一次主研究任务，验证端到端

### 第 6 步：文档与 ADR

- 在 [CACHE_DESIGN.md](../architecture/cache-design.md) §10 新增 **D11 — Schema 实体中立化（列名重命名）** ADR
- 在 §3.2 列表中替换为新列名
- 在本计划文档顶部将 Status 改为 `Completed`，记录完成日期与 merge commit

---

## 5. 风险与缓解

| 风险                                            | 缓解                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| 漏改某处列名导致运行时 KeyError                 | 全仓 grep + 强制跑全套 pytest；新增「列名单一来源」断言测试           |
| 历史缓存数据被误读                              | 迁移脚本先备份 `.bak`；`CacheStore._parse_csv_to_rows` 可加旧列名兼容层（一次性，下个版本移除） |
| 第三方已基于旧列名导出数据                      | 在迁移分支合并前公告；导出 ZIP 中的 `main_data.csv` 用新列名          |
| Pipeline 历史 artifact 列名不一致               | 文档说明「迁移点之前的 artifact 保持旧列名」；可视化组件加列名兼容映射 |
| `gene_id` 作为局部变量名被误替换                | 人工 review grep 结果，仅替换 schema 上下文（表头、DictWriter 字段）  |

---

## 6. 触发条件

满足以下任一条件时，应优先排期本迁移：

1. `pipeline_artifact` namespace 开始被自动写入（D7 落地）— 此时缓存与 Pipeline 的 schema 耦合最深，越晚改成本越高
2. 第三方工具开始消费缓存 ZIP 导出 — 列名成为对外契约
3. IMPORT 指令中「泛化解释」段落开始让 LLM 产生混淆（例如 LLM 把 `gene_id` 填到非基因实体上，并在 reasoning 中表达困惑）
4. 出现第二个非基因类数据源（如药物数据库）被频繁导入

若以上条件均未触发，可继续沿用 D10 的语义泛化方案，本计划保持 Planning 状态。

---

## 7. 估算

- 代码改动：17 文件，约 200–300 行 grep 替换 + review
- 迁移脚本：约 80 行 + 1 个测试
- 测试更新：约 50 处断言
- 文档更新：3 处（CACHE_DESIGN.md、IMPORT_INSTRUCTIONS、本计划）

按 AGENTS.md §6「最小实现」原则，不引入 schema 版本号机制、不引入双列名兼容期
（除非触发条件 2 已发生）。一次性切换 + 迁移脚本即可。
