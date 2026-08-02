# BioMed-QAgent 代码库全面审查报告

> **审查日期**: 2026-08-02
> **审查范围**: `backend/app/` 与 `frontend/src/`
> **审查性质**: 只读分析，未做任何代码变更
> **审查依据**: Karpathy 代码风格准则 + 重构原则（消除重复、收敛职责、删除死代码）
> **对比基线**: [2026-07-23-refactor-analysis.md](2026-07-23-refactor-analysis.md)
> **校准说明**: 本报告由自动化审查产出后，逐项对照实际代码 grep/Read 校准。下文凡标注
> "已核实"的发现均经过运行时验证；初始报告中 4 项未经核实的"死代码/循环依赖"结论
> 经验证为**误报**，已在 §八 中记录校准过程，正文不再收录。

---

## 0. 审查方法

本轮审查以只读方式遍历后端 `app/` 与前端 `src/` 全量代码，重点关注：

1. **模块边界与耦合方向** —— 是否存在跨层、反向依赖
2. **代码重复** —— 同一逻辑的多份实现是否可收敛到共享基础设施
3. **死代码** —— 从未被导入/调用的模块、函数、字段
4. **圈复杂度** —— 单方法行数与分支密度
5. **数据正确性** —— 元数据/目录与实际语义是否一致
6. **配置散布** —— 超时、限流等魔法值是否集中可调

> **重要**: 所有"死代码/从未调用"类结论必须经过全仓 grep 验证后才收录。本次校准
> 中发现自动化审查倾向于在局部 scope 内下"无调用"结论，实际跨目录 grep 常推翻之。

---

## 一、整体架构概览

项目采用**双层架构：Agent + 确定性 Pipeline**，整体设计清晰：

- **边界层** (`api/`): FastAPI REST + WebSocket，职责单一
- **持久化运行时** (`runtime/`): 事件溯源的 Task/Run 生命周期，TaskManager + EventStore + EventHub，设计成熟
- **Agent 循环** (`agent_loop/`): 基于 OpenAI Agents SDK，支持流式输出、对话压缩、子 Agent 监督
- **确定性 Pipeline** (`pipeline/`): 五阶段（Discovery → Acquisition → Processing → ArtifactBuild → Validation），带摘要复用、HIL 暂停-恢复、原子发布
- **技能仓库** (`skills/`): 四类 builtin skill + 用户自定义包，通过 Gateway 动态发现
- **领域契约** (`domain/contracts/`): Pydantic v2 权威契约，`extra=forbid`

**架构优点**：事件溯源 + 快照还原机制可靠；Pipeline 的 stage attempt 摘要复用设计精巧；安全边界（路径穿越、符号链接、沙箱）考虑周全。

**核心问题**：新旧模型并存导致领域层割裂；acquisition skill 层的限流/HTTP 回退路径存在重复且未完全收敛到共享基础设施；前端 reducer 持续膨胀成为维护瓶颈。

---

## 二、结构化发现

### P0 级：架构与正确性

#### P0.1 前端 `reducer.ts` 持续膨胀至 2443 行  ✅ 已核实
- **类别**: 可维护性 / 模块边界
- **文件**: [frontend/src/runtime/reducer.ts](file:///d:/Code/BioMedQAgent/frontend/src/runtime/reducer.ts)
- **描述**: 包含全部事件类型投影、ConversationItem 生成、HIL 状态管理、实时流处理。自 2026-07-23 审查以来从 1983 行增长到 2443 行（+460 行），文件本身已成为维护障碍。任何事件契约变更都要在此文件中修改，单测困难。
- **建议**: 按事件域拆分为独立 reducer 模块（pipeline events、runtime events、stream events、hil events），通过组合根聚合。参考后端 `compaction_*.py` 的拆分模式。

#### P0.2 `manager.py:_execute` 方法 230 行  ✅ 已核实
- **类别**: 可维护性 / 圈复杂度
- **文件**: [backend/app/runtime/manager.py:1362](file:///d:/Code/BioMedQAgent/backend/app/runtime/manager.py#L1362)
- **描述**: Task 执行核心方法（1362–1591 行）集中了：锁获取、快照读取、状态校验、run 启动事件、Agent/Pipeline 分派、错误处理、finalization、completion 提交。圈复杂度极高，错误路径众多，单测难以覆盖所有分支。
- **建议**: 拆分为 `_prepare_execution`（锁+快照+状态校验）、`_dispatch_run`（Agent/Pipeline 分派）、`_finalize_run`（completion 提交）三个阶段方法。

#### P0.3 `agent_loop/runner.py:__call__` 方法 273 行  ✅ 已核实
- **类别**: 可维护性 / 圈复杂度
- **文件**: [backend/app/agent_loop/runner.py:778](file:///d:/Code/BioMedQAgent/backend/app/agent_loop/runner.py#L778)
- **描述**: Agent 执行入口（778–1050 行）集中了：模型设置绑定、子 Agent 运行时绑定、流式事件处理、JSON 可疑模式缓冲、max_turns 恢复、no-progress 检测、错误恢复。与同文件的 `_AssistantTextBuffer`（复杂的 JSON 流式截断状态机）耦合紧密。
- **建议**: 将 max_turns 恢复循环、no-progress 检测、流式事件分发拆分为独立方法；`_AssistantTextBuffer` 的 JSON 可疑模式逻辑可提取为独立的 `JsonSuspectBuffer` 类。

---

### P1 级：代码重复与模块边界

#### P1.1 acquisition skill 限流逻辑四份重复  ✅ 已核实
- **类别**: 代码重复
- **文件**: [gdc.py:41](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/gdc.py#L41)、[pdb.py:41](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/pdb.py#L41)、[xena.py:44](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/xena.py#L44)、[_download_io.py:29](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/_download_io.py#L29)
- **描述**: 四个文件各自实现相同的 `_RATE_LIMIT_SECONDS = 2.0` + `global _last_request_ts` + `time.sleep()` 限流。[crawler.py:133](file:///d:/Code/BioMedQAgent/backend/app/tools/crawler.py#L133) 已提供 `AsyncHostRateLimiter` 类但未被这些 skill 复用。
- **现状澄清**（校准）: `_download_io.py` **并非死代码**——它被 [pubchem.py:34](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/pubchem.py#L34) 和 [reactome.py:35](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/reactome.py#L35) 导入（`download_file_for_run`），是一次**只覆盖了 2/5 skill 的部分收敛**。真正的重复是 gdc/pdb/xena 未使用它，各自维护一份限流副本。
- **建议**: 让 gdc/pdb/xena 复用 `_download_io.py` 的限流（或 `crawler.AsyncHostRateLimiter`），将四份收敛为一份。

#### P1.2 acquisition skill urllib HTTP 回退路径重复  ✅ 已核实
- **类别**: 代码重复 / 基础设施复用
- **文件**: [gdc.py](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/gdc.py)、[pdb.py](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/pdb.py)、[xena.py](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/xena.py)
- **描述**: 三个 skill 均采用**双路径设计**:生产路径走 `run_ctx.crawler_facade_or_none` 绑定 facade（TODO §2.1 已完成），但**回退路径**仍各自实现 `_fetch_json`/`_download_file`/`_post_json`（基于 `urllib.request.urlopen`，硬编码 30s/60s 超时）。回退路径的重复代码是本项的关注点。
- **建议**: 评估回退路径是否仍需保留（若仅用于隔离 fixture 测试，可考虑用 httpx mock 替代）；若保留，将其收敛到 `_download_io.py` 或 `crawler.py` 的同步封装。

#### P1.3 新旧领域模型并存  ✅ 已核实
- **类别**: 架构割裂
- **文件**: [backend/app/domain/__init__.py](file:///d:/Code/BioMedQAgent/backend/app/domain/__init__.py)（明确标注"正在迁移中"）
- **描述**: 旧 dataclass 模型（`domain/processing.py`、`events.py`、`task.py`、`output.py`）仍被 7 个 tool 文件使用：`tools/alignment.py`、`cleaning.py`、`parse_excel.py`、`parse_geo.py`、`parse_pdb.py`、`processing.py`、`domain/__init__.py`。新 Pydantic v2 契约在 `domain/contracts/`。两套模型并存导致类型转换开销和认知负担。
- **建议**: 这些 tool 多为 MVP 遗留，已被 Pipeline 专用 processor 取代。评估是否仍需保留这些 tool；若保留，迁移到新契约；若废弃，直接删除（与 §三 S1 联动）。

#### P1.4 DeepSeek 模型 `model_family` 错误  ✅ 已核实
- **类别**: 数据正确性
- **文件**: [backend/app/model_info/providers/qwen.py:42,55,68,81](file:///d:/Code/BioMedQAgent/backend/app/model_info/providers/qwen.py#L42)
- **描述**: `deepseek-chat`(L42)、`deepseek-r1`(L55)、`deepseek-reasoner`(L68)、`deepseek-v3`(L81) 四个模型的 `model_family` 均设为 `"qwen"`，应为 `"deepseek"`。这会导致前端按 family 分组时把 DeepSeek 模型错误归入 Qwen 组。
- **备注**: 该文件中几乎所有模型（含非 Qwen 的）都默认 `model_family="qwen"`，是更广的数据质量问题；但 DeepSeek 四例最为明确且影响前端分组，优先修复。
- **建议**: 修正为 `model_family="deepseek"`。

#### P1.5 Vendor 列表三源并存，API 使用最旧版  ✅ 已核实
- **类别**: 死代码 / 数据失效
- **文件**: [backend/app/api/settings.py:66](file:///d:/Code/BioMedQAgent/backend/app/api/settings.py#L66)、[backend/app/model_config/vendors.py:16](file:///d:/Code/BioMedQAgent/backend/app/model_config/vendors.py#L16)、[backend/app/model_info/repository.py:138](file:///d:/Code/BioMedQAgent/backend/app/model_info/repository.py#L138)
- **描述**: Vendor 列表存在三处定义，互相不一致：
  1. `api/settings.py` 的 `VENDORS` 元组（**3 个**:dashscope/openai/deepseek）—— 被 `/api/v1/vendors` 端点实际使用（[settings.py:172](file:///d:/Code/BioMedQAgent/backend/app/api/settings.py#L172) `list_vendors` 直接返回它）
  2. `model_config/vendors.py` 的 `VENDORS` 列表（**7 个**:上述 3 个 + siliconflow/moonshot/zhipu/baichuan）—— `get_vendors()`/`list_vendors()` 仅在 `__init__.py` 被 re-export，**全仓 grep 确认无任何业务代码或测试调用，是死代码**
  3. `model_info/repository.py:list_vendors()` —— 从实际 model 数据派生

  结果:前端 vendor 选择器只能看到 3 个选项，而 `model_config/vendors.py` 维护的 7-vendor 列表完全失效。
- **建议**: 统一到单一来源。推荐让 `/api/v1/vendors` 改用 `model_info/repository.list_vendors()`（数据驱动，与 model_info 一致），删除 `api/settings.py` 的本地 `VENDORS` 元组与 `model_config/vendors.py` 死代码。

---

### P2 级：硬编码、分层与可维护性

#### P2.1 `tools/io.py` → `agent_loop/context.py` 反向分层依赖  ✅ 已核实（校准自原 P0）
- **类别**: 分层 / 耦合方向
- **文件**: [backend/app/tools/io.py:20](file:///d:/Code/BioMedQAgent/backend/app/tools/io.py#L20)
- **描述**: `io.py` 导入 `from app.agent_loop.context import RunContext`。`io.py` 位于 tools 层（底层基础设施），却依赖 agent_loop 层（高层编排），**依赖方向反转**。
- **校准说明**: 初始报告将其标为"循环依赖"。经核实，`context.py:30` 导入的是 `tools.workdir`（非 `tools.io`），**不存在实际的循环 import**——硬循环已于 2026-07-31 解决（TODO §5.1 记录）。本项降级为 P2 分层关注点:tools 层不应反向依赖 agent_loop 层。
- **建议**: 定义 `WorkDirProvider` Protocol（仅含 `work_dir` 属性），`io.py` 依赖该 Protocol 而非具体 `RunContext`，反转依赖方向。注意:TODO §5.1 已将"循环依赖"条目标记为完成，本项是其遗留的分层洁癖问题，可低优先处理。

#### P2.2 超时值散布  ✅ 已核实
- **类别**: 硬编码 / 配置集中化
- **文件**: [pipeline/runner.py:331](file:///d:/Code/BioMedQAgent/backend/app/pipeline/runner.py#L331)（5s lock）、`recipes/client.py:347`（30s）、[crawler.py:596](file:///d:/Code/BioMedQAgent/backend/app/tools/crawler.py#L596)（30s）、[gdc.py:104](file:///d:/Code/BioMedQAgent/backend/app/skills/builtin/acquisition/gdc.py#L104)（30s/60s）、`pdb.py`、`xena.py`、`browser.py`（120s）等
- **描述**: 超时值散布在 10+ 处，无法统一调优。TODO §5.3 / §8.8 已识别但未实施。
- **建议**: 集中到 `RuntimeLimitsSettings` 或独立 `TimeoutConfig`，按调用类型（lock、HTTP、browser）分类配置。

#### P2.3 超长文件未拆分  ✅ 已核实
- **类别**: 可维护性
- **文件**:
  - [backend/app/pipeline/stages/artifact_build.py](file:///d:/Code/BioMedQAgent/backend/app/pipeline/stages/artifact_build.py)（974 行）
  - [backend/app/pipeline/stages/validation.py](file:///d:/Code/BioMedQAgent/backend/app/pipeline/stages/validation.py)（885 行）
  - [frontend/src/components/SettingsPanel.tsx](file:///d:/Code/BioMedQAgent/frontend/src/components/SettingsPanel.tsx)（935 行）
  - [backend/app/runtime/manager.py](file:///d:/Code/BioMedQAgent/backend/app/runtime/manager.py)（1764 行）
  - [backend/app/agent_loop/runner.py](file:///d:/Code/BioMedQAgent/backend/app/agent_loop/runner.py)（1450 行）
- **描述**: 这些文件虽未到 P0 级别的单方法超长，但整体规模已影响导航和 review 效率。
- **建议**: 按 stage 子步骤或职责拆分。`artifact_build.py` 可按 14 种 CSV 产物分组；`validation.py` 可按 7 项校验拆分。

#### P2.4 `_run_stages_loop` 175 行  ✅ 已核实
- **类别**: 可维护性
- **文件**: [backend/app/pipeline/runner.py:609-784](file:///d:/Code/BioMedQAgent/backend/app/pipeline/runner.py#L609)
- **描述**: 原 `_run_inner`（192 行）已被重构为 7 行入口 + `_run_stages_loop`（175 行）。改进显著，但 `_run_stages_loop` 仍集中了阶段跳过/复用决策、attempt 构建、状态持久化、事件触发、超时处理。
- **建议**: 将"复用决策"（约 lines 619–686）提取为 `_try_reuse_stage` 方法。

---

### P3 级：错误处理

#### P3.1 宽泛异常捕获缺乏分类  ✅ 已核实
- **类别**: 错误处理
- **文件**: 10+ 处 `except Exception:`（[agent_loop/runner.py:417](file:///d:/Code/BioMedQAgent/backend/app/agent_loop/runner.py#L417)、`api/ws.py:30`、`api/ws_events.py:449`、[model_info/repository.py:70](file:///d:/Code/BioMedQAgent/backend/app/model_info/repository.py#L70)、[pipeline/runner.py:658](file:///d:/Code/BioMedQAgent/backend/app/pipeline/runner.py#L658)、[runtime/manager.py:268](file:///d:/Code/BioMedQAgent/backend/app/runtime/manager.py#L268) 等）
- **描述**: 部分位置已添加 `# noqa: BLE001` 注释和 `logger.exception`（如 `manager.py:268`），但仍有未分类的宽泛捕获。`pipeline/runner.py:658` 在 `_collect_stage_output_files` 失败时静默 fallback 到 `None`，可能掩盖真实问题。
- **建议**: 审查每处 `except Exception`，明确预期异常类型；对不可恢复异常应传播而非吞没。

---

## 三、架构减法机会

| # | 减法项 | 理由 | 预期收益 |
|---|--------|------|---------|
| S1 | 评估并删除 `tools/` 下 MVP 遗留 tool（alignment/cleaning/parse_*/processing/export） | 已被 Pipeline 专用 processor 取代，仍依赖旧 dataclass 模型 | 消除旧模型依赖，推动 P1.3 迁移 |
| S2 | 统一 acquisition skill 限流/HTTP 回退到共享 helper | gdc/pdb/xena 各自维护 urllib+限流副本，_download_io 已部分收敛 pubchem/reactome | 减负重复代码 |
| S3 | 收敛超时配置到 `RuntimeLimitsSettings` | 消除 10+ 处硬编码 | 统一调优入口 |
| S4 | 统一 vendor 列表到 `model_info/repository` | 消除三源并存，删除 `model_config/vendors.py` 死代码 | 修复 vendor 选择器只显示 3 个选项的 bug |

---

## 四、Top 优先级排序

| 优先级 | 编号 | 问题 | 影响 | 工作量 |
|--------|------|------|------|--------|
| 1 | P0.1 | `reducer.ts` 2443 行膨胀 | 前端维护瓶颈，持续恶化 | 高 |
| 2 | P0.2 | `manager.py:_execute` 230 行 | 运行时核心难测难维护 | 中 |
| 3 | P0.3 | `runner.py:__call__` 273 行 | Agent 循环核心难测 | 中 |
| 4 | P1.4 | DeepSeek `model_family` 错误 | 前端分组错误 | 极低 |
| 5 | P1.5 | Vendor 列表三源并存 | 前端只显示 3/7 个 vendor | 低 |
| 6 | P1.1+P1.2 | acquisition skill 限流/HTTP 回退重复 | 3 skill 各自维护副本 | 中 |
| 7 | P1.3 | 新旧领域模型并存 | 认知负担，类型转换 | 高 |
| 8 | S1 | 删除 MVP 遗留 tool | 降低噪音，推动模型迁移 | 中 |
| 9 | P2.2 | 超时值散布 | 无法统一调优 | 中 |
| 10 | P3.1 | 宽泛异常捕获 | 可能掩盖真实问题 | 中 |

---

## 五、相比 2026-07-23 审查的进展

**已解决**（6 项）:
- `_run_inner` 192 行 → 7 行（逻辑下放到 `_run_stages_loop`）
- `manager.py` 静默 `except Exception: pass` → 改为 `logger.error`
- `_write_csv` 两份重复 → 已消除（合并到 `pipeline/stages/base.py:write_csv`）
- 前端 `errorDescription` 5 份重复 → 收敛到 `utils.ts`
- 前端 `formatSize` 3 份变体 → 统一到 `fileUtils.ts`
- `agentSelectors.ts` 未使用导出 → 已清理
- `api/settings_router.py` 死代码 → 已删除（TODO §5.1 记录，本次核实文件已不存在）
- `tools/io.py` 硬循环依赖 → 已解决（TODO §5.1 记录，本次核实无实际循环 import）

**仍存在**（5 项）:P0.1 reducer 膨胀（恶化至 2443 行）、P1.1 限流重复、P1.2 HTTP 回退重复、P1.3 新旧模型并存、P2.2 超时散布

**新增问题**（4 项）:DeepSeek `model_family` 错误、Vendor 列表三源并存、`_execute` 230 行、`__call__` 273 行

---

## 六、关键文件路径索引

**后端核心长方法**:
- `backend/app/runtime/manager.py`（1764 行，`_execute` 在 1362 行）
- `backend/app/agent_loop/runner.py`（1450 行，`__call__` 在 778 行）
- `backend/app/pipeline/runner.py`（`_run_stages_loop` 在 609 行）

**重复代码**:
- `backend/app/skills/builtin/acquisition/gdc.py`、`pdb.py`、`xena.py`（urllib 回退 + 限流副本）
- `backend/app/skills/builtin/acquisition/_download_io.py`（部分收敛，被 pubchem/reactome 使用）
- `backend/app/tools/crawler.py`（已有可复用的 `AsyncHostRateLimiter`/`BROWSER_HEADERS`）

**死代码**:
- `backend/app/model_config/vendors.py`（`get_vendors`/`list_vendors` 从未被业务代码调用）

**数据错误**:
- `backend/app/model_info/providers/qwen.py:42,55,68,81`（DeepSeek family 误标为 qwen）
- `backend/app/api/settings.py:66`（VENDORS 元组仅 3 项，遗漏 4 个 vendor）

**前端**:
- `frontend/src/runtime/reducer.ts`（2443 行）
- `frontend/src/components/SettingsPanel.tsx`（935 行）

**新旧模型**:
- `backend/app/domain/__init__.py`（迁移说明）
- 依赖旧模型的 7 个 tool 文件：`tools/alignment.py`、`cleaning.py`、`parse_excel.py`、`parse_geo.py`、`parse_pdb.py`、`processing.py`

---

## 七、建议的执行顺序

遵循"先减法后重构、低风险先行"原则:

1. **第一波（低风险数据修正）**:P1.4 修正 DeepSeek family → P1.5 统一 vendor 来源（删除 `model_config/vendors.py` 死代码）
2. **第二波（重复收敛）**:S2 acquisition skill 限流/HTTP 回退收敛到 `_download_io.py` 或 `crawler.py`
3. **第三波（长方法拆分）**:P0.2 `manager._execute` → P0.3 `runner.__call__` → P2.4 `_run_stages_loop`
4. **第四波（前端拆分）**:P0.1 `reducer.ts` 按事件域拆分
5. **第五波（领域收敛）**:P1.3 评估 MVP 遗留 tool 去留 → S1 删除废弃 tool → 迁移保留 tool 到新契约
6. **第六波（配置集中）**:P2.2/S3 超时值收敛到 `RuntimeLimitsSettings`
7. **第七波（分层洁癖，可选）**:P2.1 `io.py` 引入 `WorkDirProvider` Protocol

每一波应作为独立的功能单元分支合并，合并前通过 AGENTS.md §7.3 的全部 Quality Gates。

---

## 八、审查校准记录（自动化误报修正）

> 本节记录初始自动化审查中未经全仓验证即下结论、经本次校准推翻的条目，作为后续审查的
> 方法论提醒:**"死代码/无调用"类结论必须跨全仓 grep 验证，不可在局部 scope 内推断。**

| 初始结论 | 校准结果 | 证据 |
|---------|---------|------|
| `api/settings_router.py` 是死代码（P1.3） | **误报**——文件已于 2026-07-31 删除 | `Test-Path` = False；`main.py:21` 的 `settings_router` 是 `app.api.settings.router` 的本地别名，非引用已删文件 |
| `workdir.py:raw_file` 无任何调用（P2.2） | **误报**——活跃使用 | 被 gdc.py:527/563、pdb.py、pubchem.py、reactome.py、xena.py、`test_workdir.py` 调用 |
| `_download_io.py` 从未被导入、是死代码（P3.1） | **误报**——活跃使用 | 被 pubchem.py:34、reactome.py:35 导入（`download_file_for_run`）；实际是只覆盖 2/5 skill 的部分收敛 |
| `tools/io.py` → `agent_loop/context.py` 循环依赖（P0.2） | **误报（标签错误）**——无实际循环 | `context.py:30` 导入 `tools.workdir`（非 `tools.io`），无反向引用；硬循环已于 2026-07-31 解决。降级为 P2 分层关注点 |

**教训**: 自动化审查倾向于在单文件/单目录 scope 内下"无调用"结论。跨目录 grep（含 tests/）常推翻之。后续审查应在"死代码"类结论旁附 grep 命令证据。
