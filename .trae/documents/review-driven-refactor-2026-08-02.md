# 审查驱动重构方案（2026-08-02）

## Context（背景）

[REVIEW_2026-08-02-comprehensive-codebase.md](../../docs/REVIEW_2026-08-02-comprehensive-codebase.md) 完成全面审查后，用户要求"一次性根据审查报告进行完整修复"，并将 prompt 中 pipeline 重试次数从 2 上调至 5。

本方案在 plan mode 中经只读核实 + Plan agent 设计后定稿。核实中发现审查报告 **P1.3 误报**：MVP tool（alignment/cleaning/parse_*/processing）并非死代码——[pipeline/stages/processing.py](../../backend/app/pipeline/stages/processing.py) 活跃导入 `app.tools.alignment`（align_fields/merge_datasets/normalize_field_names）并以 `OldParsedDataset` 别名使用旧契约。删除会直接破坏 Pipeline，故 **P1.3/S1 排除**（需先完成契约迁移，属更大工作）。

用户已确认：P0.1（reducer.ts 完整拆分）与 P2.3（artifact_build/validation 拆分）均纳入本次。

## 范围

**纳入**（12 项）：P1.4 DeepSeek family、P1.5 vendor 统一、retry 2→5、P2.4 _try_reuse_stage、P0.2 manager._execute 拆分、P0.3 runner.__call__ 拆分、P2.1 io.py Protocol、P1.1 限流收敛、P1.2 urllib 回退收敛、P2.2 超时集中、P2.3 两个大文件拆分、P0.1 reducer 拆分。
**排除**：P1.3/S1（MVP tool 非死代码，核实见上）、P3.1（7 处异常捕获经核实**全部是合理顶层边界**，无需收窄类型，仅补充注释——并入各相关项一并完成，不单列）。

## 执行阶段（低风险先行）

### 阶段 1：独立低风险项（并行）

**J. DeepSeek family + vendor 统一 + retry 2→5**
- [qwen.py:42,55,68,81](../../backend/app/model_info/providers/qwen.py#L42)：`model_family="qwen"` → `"deepseek"`（deepseek-chat/r1/reasoner/v3）
- 删除 [model_config/vendors.py](../../backend/app/model_config/vendors.py)；将 `Vendor`+`VENDORS`(7 项)+`get_vendors`/`list_vendors` 迁移到新 `model_info/vendors.py`；[api/settings.py:66-88](../../backend/app/api/settings.py#L66) 删除本地 3-vendor 元组，[settings.py:172 list_vendors](../../backend/app/api/settings.py#L172) 改用 `model_info.vendors.list_vendors()`；grep 修正所有 `from app.model_config.vendors` 导入者
- [agent.py:123,127](../../backend/app/agent_loop/agent.py#L123)："2 次"→"5 次"；[tool.py:290](../../backend/app/pipeline/tool.py#L290) `>= 2`→`>= 5`；[tool.py:295](../../backend/app/pipeline/tool.py#L295) "attempted 2 times"→"5 times"

**F. io.py WorkDirProvider Protocol**
- [tools/io.py:20](../../backend/app/tools/io.py#L20)：定义 `WorkDirProvider` Protocol（`root: Path` + `agent_staging_file(path) -> Path`），替换 `RunContext` 类型注解，删除 `from app.agent_loop.context import RunContext`。`TaskWorkDir` 结构性满足。纯分层清理，无行为变化。

**G. 超时集中**
- 扩展 [model_config/schemas.py:10 RuntimeLimitsSettings](../../backend/app/model_config/schemas.py#L10)：新增 `lock_timeout_seconds=5.0`、`http_timeout_seconds=30.0`、`http_download_timeout_seconds=60.0`、`browser_timeout_seconds=120.0`（均 `gt=0`）
- 替换硬编码：pipeline/runner.py:331(5s→lock)、gdc/pdb/xena(30/60s)、_download_io.py:52、pubmed.py:332/381、crawler.py:596、acquisition.py:292。`DEFAULT_STAGE_TIMEOUTS` 保持独立（stage 墙钟预算与单请求超时是不同概念）
- urllib 回退路径通过 `run_ctx.model_settings.runtime_limits` 读取

### 阶段 2：复用模式验证

**D. _try_reuse_stage 抽取**
- [pipeline/runner.py:619-686](../../backend/app/pipeline/runner.py#L619) 抽出为 `_try_reuse_stage(stage, input_digest, parameter_digest, stage_outputs, reuse_allowed) -> tuple[bool, Any]`。返回 `(True, output)` 则 `continue`，`(False, None)` 则运行新 stage。行为保持。

### 阶段 3：acquisition 收敛（依赖 G）

**E. 限流 + urllib 回退收敛**
- 以 [_download_io.py](../../backend/app/skills/builtin/acquisition/_download_io.py) 为规范宿主：`_rate_limit`→公开 `rate_limit()`；gdc/pdb/xena 删除各自的 `_RATE_LIMIT_SECONDS`/`_last_request_ts`/`_rate_limit`，改 `from ._download_io import rate_limit, fetch_json, download_file`
- 在 `_download_io.py` 合并出 `fetch_json(url, *, method="GET", json_body=None, timeout=30.0)` 与 `download_file(url, dest, *, timeout=60.0)`（吸收 gdc._fetch_json + pdb._get_json/_post_json + 各 _download_file）
- 各 skill 的 `*_for_run` 异步包装保留（含 facade 方法调用，skill 特定），其 urllib 回退委托给共享 helper
- **注意**：合并后单一全局 `_last_request_ts` 跨 gdc/pdb/xena 共享，比当前各自独立 2s 窗口**更严格**——符合 AGENTS.md "2s per request" 全局约束

### 阶段 4：后端长方法拆分（中风险）

**B. manager._execute 拆分**
- [manager.py:1362-1591](../../backend/app/runtime/manager.py#L1362) 拆为 `_prepare_execution` / `_dispatch_run` / `_finalize_run`，用冻结 `_ExecutionState` dataclass 传递状态
- **关键**：多个 `return`（1461/1468/1524/1530/1560/1570）与 `finally` 块交互——`try/finally` 必须留在 `_execute`，`_dispatch_run` 放 `try` 内，清理逻辑放 `finally`
- 补测试：`_running` 在每条早返回路径都被清理；"agent 完成但无 artifact"路径（1507-1524）

**C. runner.__call__ 拆分 + JsonSuspectBuffer**
- [runner.py:778-1050](../../backend/app/agent_loop/runner.py#L778)：抽出 `_run_agent_loop`（852-1010 主循环）。max_turns/no-progress/stream-dispatch **已是独立方法**（`_await_max_turns_resume`/`_await_no_progress_resume`/`_consume_events`），无需再抽
- 从 `_AssistantTextBuffer` 抽出 `JsonSuspectBuffer` 类（JSON 可疑模式状态 + `_add_to_json_suspect`/`_flush_json_suspect_as_text`），通过 `flush_callback=self._add_raw` 回写。`add()`/`end()` 的编排仍留 `_AssistantTextBuffer`
- 补测试："`{` 后非 JSON 文本"重发路径、tool_call 丢弃路径

### 阶段 5：前端 reducer 拆分（大型，机械）

**A. reducer.ts → reducers/ 子模块**
- 新建 `frontend/src/runtime/reducers/`：`shared.ts`（先抽，断环）、`stream.ts`、`runtime.ts`、`pipeline.ts`、`hil.ts`、`index.ts`
- **保持 `reducer.ts` 作为公开入口**（re-export 自 `reducers/`），20 个消费者（agentStore + 3 组件 + 16 测试）零改动
- 子 reducer 统一签名：`(task, envelope, payload) => TaskProjection`，与现有 `applyXxxEvent` 形态一致
- 依赖层次：shared←{stream←{runtime,pipeline,hil}}←index，无反向边
- `reduceRuntimeEvent` 主 switch（2335-2426）留在 index 作分发器
- 回归网：`runtime-reducer.test.ts`、`realtime-stream-reducer.test.ts`、`hydrate-compat.test.ts`、`items-ordering.test.ts`

### 阶段 6：大文件拆分（最大，机械，最后做）

**H. artifact_build.py + validation.py 拆分**

artifact_build（974 行，CSV builder 已在 248-661 抽出，剩余 `run_artifact_build` 665-974 ~310 行编排）：
- 新建 `pipeline/stages/artifact_build/`：`columns.py`、`samples.py`、`warnings.py`、`relations.py`、`catalog.py`、`field_mapping.py`、`cleaning.py`、`builder.py`（编排）、`__init__.py`（re-export）

validation（885 行，`_validate_package` 411-829 是 418 行单体，含 10 项 Reactome 内联检查）：
- 新建 `pipeline/stages/validation/`：`publish.py`、`checks_common.py`、`checks/{main_data,reactome,sample_metadata,source_assets,lineage}.py`、`package.py`（编排）、`runner.py`、`__init__.py`
- **关键**：`_validate_package` 有 ~15 个共享局部变量（main_rows/dataset_ids/sample_ids/source_ids/asset_ids 等）——引入 `ValidationContext` dataclass 承载已加载 CSV，传给各 check 函数
- 补回归测试：已知 fixture 上拆分前后 check 列表完全一致

## P3.1 异常捕获（并入各相关项）

经核实 7 处 `except Exception` **全部是合理顶层边界**，不收窄类型，仅补注释说明为何是边界：
- runner.py:417（best-effort emit）、ws.py:30（WS 适配器最外层）、ws_events.py:449/462/471（连接已坏的 best-effort close）、repository.py:70（隔离 provider 加载失败）、manager.py:268（非持久化 frame 发布）
- pipeline/runner.py:658（`_collect_stage_output_files` 静默 fallback None）：保留 `except Exception`，确保日志为 WARNING 级并含 stage 名（已基本到位），不传播（传播会破坏 digest 命中的良性复用）

## 验证（AGENTS.md §7.3）

**后端**（每触及 `backend/app/` 的项之后）：
- `uv run ruff check app/ tests/ launcher.py`（0 warning）
- `uv run pytest`（0 失败，排除 `@pytest.mark.live`）
- 清 `__pycache__` 后 `uv run uvicorn app.main:app --reload` 正常启动，`/api/v1/health` 返回 200

**前端**（项 A 之后）：
- `pnpm lint`（0 warning）、`pnpm tsc`（0 error）、`pnpm build` 成功、`pnpm test` 全过

## 风险标记（非纯行为保持，需额外测试）

1. **B（manager._execute）**：`return`×`finally` 交互，必须保留 try/finally 在 _execute
2. **C（JsonSuspectBuffer）**：`add()`/`end()` 交织 code-fence 与 JSON-suspect 状态，用 callback 回写而非干净分离
3. **H（validation 拆分）**：~15 共享变量，必须 ValidationContext 承载；需 fixture 回归测试对比拆分前后 check 列表
4. **E（限流合并）**：单一全局比当前各自独立更严格（可接受，符合 AGENTS.md）

## 分支与合并策略

单一功能分支 `refactor/review-2026-08-02`，按阶段 1→6 顺序提交。全部 Quality Gate 通过后作为一次完整功能单元合并到 main（符合 AGENTS.md §7.2 "一个功能一次合并"）。每阶段提交后运行对应验证，失败即停。
