ROUND-1 V1-RETIREMENT REVIEW — Task B: 测试迁移正确性与回归（READ-ONLY，禁止编辑任何文件）

仓库：/mnt/d/code-linux/BioMed-QAgent，分支 feat/v2-mainline-v1-removal。你是 fresh-context reviewer，独立审查本次高风险重构的测试面，不依赖会话历史。

背景：V1 生产路径退役（agent 主线切 V2）后，测试面做了大规模迁移：
- 删除 tests/pipeline/ 42 个 V1 文件 + tests/api/test_artifact_api.py + tests/integration/test_subagent_research_flow.py + tests/live/test_pipeline_live.py
- tests/runtime/test_fixture_executor.py 从 1314 行 V1 桥接语义重写为 4 个 V2 语义测试
- tests/agent_loop/ 执行框架测试（test_execution/test_agent_run_e2e/test_max_turns_continue/test_no_progress_detector/test_qwen_function_args_retry）从"V1 PipelineRunner 模拟"迁移为共享 helper（tests/agent_loop/_v2_build_helpers.py：GDC fixture 复制进 workdir → 固定 spec → execute_dataset_build.on_invoke_tool → PendingDatasetBuild）
- 删除 5 个 V1 专属测试（plan HIL 3 个 + pretransfer abort + publish-once）与 6 个 V1 产物面测试（artifact_produced/run_manifest/.runtime-publication.json marker 语义）
- tests/api/test_rest_control.py 的 fixture 测试改 V2 断言（DatasetManifest 格式、build_id=fixture_build、row_count=4）
- tests/test_prompt_shape_integration.py 改 INSTRUCTIONS prompt gate 断言

基线：全量 `uv run pytest` = 2233 passed（原 2722，删除 V1 后净减 489，其中约 470 来自 tests/pipeline/）。

你的任务：

1. **关键不变量是否仍有覆盖**（对照删除清单，逐项判断"删掉的行为是否在 V2 语义下有等价测试"）：
   - 成功路径事件顺序（started < finalizing < publication < completed）——test_agent_run_e2e 改造后是否仍断言
   - 无产物路径 NO_DATA + warning（artifact_manifest_missing）——test_agent_run_e2e 后两个测试
   - max_turns/no_progress/qwen retry 的 HIL 语义（approve/reject/timeout 分支）
   - executor 转移逻辑（_transfer_pending_publication 的 V2 分支）——test_execution 的 transfer 测试
   - 取消路径（fixture 模式的 cancel → cancelled/failed）
2. **`_v2_build_helpers.py` 的正确性**：固定 spec 是否合法（对照 SpecValidator 的校验规则与 VALIDATION_PROFILES 注册表 app/datasets/build/profiles.py）；header_only 分支是否真的产生 NO_DATA 而不是 invalid_input。
3. **潜在语义缺口**：被删除的测试中是否有"只在 V1 测试里覆盖、V2 无等价物"的关键行为（列出并给出严重度评估——注意：V1 行为本身已退役，只在"该行为映射到 V2 的哪个机制"意义上评估）。
4. **独立验证**：运行关键测试子集并报告：`uv run pytest tests/agent_loop/ tests/runtime/ tests/api/ tests/test_dataset_expression_runner.py tests/test_dataset_build_tool.py -q`（预期全绿）。若你环境无法跑（依赖问题），说明并退化为静态审查。

验证方式：cd /mnt/d/code-linux/BioMed-QAgent/backend && uv run pytest ...（或 .venv/bin/python -m pytest）。注意不要跑 live 测试。

交付（<500 字）：(1) 不变量覆盖表（不变量→V2 等价测试→覆盖/缺失）；(2) helper 正确性结论；(3) 语义缺口清单（若有）；(4) 你跑的测试结果。结尾一行：R1B verdict: ADEQUATE / INADEQUATE。
