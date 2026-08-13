# Phase 2：Skills 与通用 Agent 工具迁移

> 状态：✅ 完成（2026-08-13，分支 `feat/phase2-skills-tools-migration`）
> 依据：[BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md)
> §20 Phase 2；待办见 [docs/TODO.md](../TODO.md)。
> 本文记录本阶段的决策与验收映射；实现证据随各 checkpoint 的测试落在仓库内。

## 1. 目标

把 Python 自制 Skill 运行时退役，Skill 内容迁入 Pi 资源目录：

1. `backend/app/skills/builtin/*` 的业务指导内容迁移为 `.pi/skills/<name>/SKILL.md`；
2. 删除/停用 `SkillCatalog` / `SkillGateway` / `SkillRegistry` /
   `LLMRerankingSkillSearchStrategy` / `UserSkillStore`；
3. 业务 Tool 改为**直接具名工具**（legacy Agent 直接注册；Pi 侧通过
   PiAgentAdapter 的 customTools 面注册），并建立 **Skill ↔ Tool 稳定名称映射**；
4. learned skill 规则：明确删除；
5. Skill 管理 UI / `/api/v1/skills`：退役（见决策 D4）。

## 2. 决策（对应 docs/TODO.md Phase 2 的"决策"条目）

### D1 — "Pi Extensions" 在嵌入 SDK 场景的落地形态

Pi 的 `.pi/extensions/*.ts` jiti 自动发现机制服务于 TUI/RPC 运行时；本项目
嵌入 SDK 会话由 `server/src/agent/pi-adapter.ts` 经
`createAgentSession.customTools` 注册工具（`noExtensions: true`）。因此：

- 本项目"注册为 Pi Extension Tool"的语义 = **在 PiAgentAdapter 面注册
  `BioMedAgentTool` 定义**（与 `dataset-build.ts` 相同的 customTools 路径），
  而不是 `.pi/extensions/` 文件。理由：
  1. ADR-021 要求 Pi 依赖只经 `pi-adapter.ts`，扩展文件会引入第二处 Pi 类型依赖；
  2. 工具需要 task/run/session 身份闭包（如 `validate_dataset_build` 的
     runId/piSessionId），是每会话构造的，不适合进程级扩展文件；
  3. 当前嵌入会话本就 `noExtensions: true`，扩展文件不会被加载。
- **Phase 2 交付 Skill ↔ Tool 稳定名称映射 + 工具定义契约**（名称、描述、
  参数 Schema），业务工具实现仍为 Python（Phase 5 迁 TS）。Phase 2 不新建
  loopback skill-op 桥：它会重建一个 Phase 5 立即被 TS 实现替换的
  Python 依赖工具面，且 AGENTS.md 禁止新增对 `backend/app/agent_loop` 的依赖。
  Phase 5 逐源迁移时，各工具按本映射注册为 Pi 工具。

### D2 — Legacy Agent 改为直接具名工具

默认 profile（`AGENT_RUNTIME=legacy`）在 Phase 7 之前仍是正式运行时，删除
gateway 后它必须继续工作。做法：

- `build_agent` 不再构造 `find_skill`/`invoke_skill`，改为直接注册各内置技能
  的 operation 工具（`search_pubmed`、`search_geo`、`download_geo` …）；
- INSTRUCTIONS 删除"动态 Skill 发现协议"，改为直接工具目录；
- `SourceResearchAgent`（子 Agent）直接注册 DISCOVERY+ACQUISITION 工具；
- 前端会话渲染删除 `find_skill`/`invoke_skill` 特判，为直接工具名增加标签。

### D3 — learned skill / create_skill：明确删除

- `backend/app/skills/learned/` 目前只有空包（无写入路径）；Pi 侧 learned
  skill 没有对应物。**明确删除该概念**：`.pi/skills/` 只承载 curated 仓库
  内容，learned skill 若将来需要，以 git 分支/PR 形式进入 `.pi/skills/`。
- 连带删除 `create_skill` 工具、`SkillBuilderAgent` 与 `CreateSkillRuntime`
  绑定（它们是为 learned skill 服务的机制）。
- **保留** `app/recipes/**` 与 `WorkflowRecipeStore`/`RecipeExecutor`：
  `app/datasets/service.py` 的 WorkflowRecipe acquisition 仍依赖它们。

### D4 — Skill 管理 UI / `/api/v1/skills`：退役；`/api/v1/databases` 保留（极薄 adapter）

- `/api/v1/skills*`（zip 包上传、Python 代码执行、rollback、enable/disable）
  整体退役：Pi Skill 是仓库内 `.pi/skills/*/SKILL.md` 文件，由 git 管理，
  运行时上传/执行 Python 代码的机制正是要删除的自制基础设施。
- 前端设置页删除"能力/技能"分区（`SkillsSettingsSection`、skill API 方法、
  `find_skill`/`invoke_skill` 渲染器）。
- `/api/v1/databases` 保留为**极薄声明式数据库存储**（新建
  `app/databases/`）：内置数据库清单（启用开关可持久化）+ 用户声明式
  JSON/HTTP 数据库 CRUD；仅解析声明式 manifest（复用 packages.py 的
  manifest 模型与 HTTP 工具构造，去掉 zip/Python 执行路径）。
  声明式数据库的 operation 作为直接工具注册给 legacy Agent（auth 的 HIL
  审批门保持原语义）。前端"数据库"分区改用 `/api/v1/databases` 接口。
  用户可选择的数据库仍是产品语义（Plan §3.1.7），予以保留。

### D5 — 稳定 Skill ↔ Tool 名称映射

单一事实源：`server/src/agent/skills/skill-tool-map.ts`（TS 表，含 skill 名、
类别、支持数据源、工具名、描述）。用途：

- vitest 校验 `.pi/skills/*/SKILL.md` 引用的工具名全部存在于映射（无幻影工具）；
- Phase 5 注册 Pi 工具与 Phase 8 删除 Python 时的对照契约；
- 文档 `docs/migration/phase2-skill-tool-map.md` 同步生成。

legacy Python 侧的直接工具名与映射中的工具名**必须一致**（Phase 2 内以
`tests/test_builtin_tools.py` 固化）。

## 3. Skill 清单与工具映射（v1）

| Skill 名 | 类别 | 数据源 | 工具（operation 名） | 可进入正式构建 |
| --- | --- | --- | --- | --- |
| pubmed | discovery | pubmed | search_pubmed, download_supplementary | 文献证据 |
| chembl | discovery | chembl | search_chembl | 否（调研） |
| uniprot | discovery | uniprot | search_uniprot | 否（调研） |
| literature_understanding | discovery | pubmed, crossref, arxiv | analyze_papers | 否（调研） |
| geo | acquisition | geo | search_geo, describe_geo, list_geo_supplementary_files, download_geo, download_geo_platform_annotation | 是（geo.expression.v1） |
| gdc | acquisition | gdc | search_gdc, describe_gdc, download_gdc | 是（gdc.expression.v1） |
| xena | acquisition | ucsc_xena | search_xena, download_xena | 是（xena.matrix.v1） |
| pdb | acquisition | pdb | search_pdb, describe_pdb, download_pdb | 否（调研） |
| pubchem | acquisition | pubchem | search_pubchem, get_compound, download_pubchem | 否（调研） |
| reactome | acquisition | reactome | search_reactome, get_pathway, download_reactome | 否（调研） |
| browser_fallback | acquisition | browser | navigate_page, download_from_page | 否（最后手段） |
| local_cache | acquisition | cache | search_local_cache, describe_local_cache, get_cache_dataset | 否（查询缓存） |
| web_visual_capture | acquisition | browser | capture_web_page, capture_page_section | 否（视觉证据） |
| pdf_extraction | processing | pdf, pubmed, pmc | extract_pdf_tables, extract_pdf_metadata | 否（预处理） |
| extract_chart_data_vlm | processing | — | extract_chart_data_vlm | 否（视觉提取） |
| analysis | analysis | csv, tabular | run_differential_expression, generate_heatmap, basic_statistics, generate_correlation_matrix | 否（分析） |
| research_data_guidance | analysis | — | get_research_data_guidance | 否（SOP 指导） |
| dataset-construction | analysis | — | validate_dataset_build, execute_dataset_build | 是（Core 工具） |

> Skill 名以 Python 侧 SkillDef 名为准（`literature_understanding`、`pdf_extraction`、
> `analysis` 等）；`create_skill` 删除（D3）。`dataset-construction` 是既有 `.pi/skills` 内容，
> 对应的受信任 Core 工具 `validate_dataset_build`/`execute_dataset_build` 已
> 经 PiAgentAdapter 注册。

## 4. `.pi/skills/` 目录目标

```text
.pi/skills/
├── research_data_guidance/SKILL.md
├── pubmed/SKILL.md
├── geo/SKILL.md
├── gdc/SKILL.md
├── xena/SKILL.md
├── pdb/SKILL.md
├── pubchem/SKILL.md
├── reactome/SKILL.md
├── chembl/SKILL.md
├── uniprot/SKILL.md
├── browser_fallback/SKILL.md
├── local_cache/SKILL.md
├── web_visual_capture/SKILL.md
├── pdf_extraction/SKILL.md
├── extract_chart_data_vlm/SKILL.md
├── analysis/SKILL.md
├── literature_understanding/SKILL.md
├── dataset-construction/SKILL.md      (既有)
```

SKILL.md 内容 = Python 技能模块的 SOP 知识（何时用、怎么用、失败处理、
业务约束、与 Dataset Core 的边界），工具操作名在正文中引用映射表名称。

## 5. 验收标准映射（Plan §20 Phase 2）

| 验收 | 证据 |
| --- | --- |
| Main Agent 不再调用 find_skill/invoke_skill | `build_agent` 无 gateway；backend 测试断言工具列表不含二者；`app/skills/{gateway,catalog,registry,search,llm_search,store,packages}.py` 删除 |
| Pi 能按任务加载相关 Skill | `pi-adapter` 以 `.pi/skills` 为 skill root；`server/tests/skill-loading.test.ts` 断言 ResourceLoader 发现全部迁移 Skill |
| Skill 缺失不会导致 Runtime 崩溃 | `optionalSkillRoots` 保持可选回退；`server/tests/pi-adapter-skill-roots.test.ts` 断言缺失时会话仍创建 |
| Skill 与 Tool 名称有稳定映射 | `server/src/agent/skills/skill-tool-map.ts` + `server/tests/skill-tool-map.test.ts` + `backend/tests/test_builtin_tools.py` |
| learned skill 默认禁用规则 | 明确删除（D3），`.pi/skills` 为 curated 唯一来源 |

## 6. 实施顺序（TDD checkpoints）

1. ✅ **B/C**（TS）：skill-tool-map + 测试；17 个 SKILL.md 迁移 +
   `skill-manifests.test.ts`；pi-adapter 全量 skill root + 缺失回退测试
   （commit 793633a）。
2. ✅ **D/E/F**（Python）：builtin 模块直接工具表 + `test_builtin_tools.py`；
   `build_agent`/INSTRUCTIONS/子 Agent 改直接工具；声明式数据库存储
   `app/databases/` + API + 测试；skills API/基础设施/create_skill 链删除
   （commit e353458）。
3. ✅ **G**（Frontend）：技能 UI 退役；数据库分区切 `/api/v1/databases`
   （detail + enable/disable）；直接工具名标签（commit 8de5356）。
4. ✅ **H**：文档同步（本 commit）。
5. **I**：全量质量门禁 + review 修复 + 合并（进行中）。
