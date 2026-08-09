ROUND-1 V1-RETIREMENT REVIEW — Task A: 删除正确性与共享件完整性（READ-ONLY，禁止编辑任何文件）

仓库：/mnt/d/code-linux/BioMed-QAgent，分支 feat/v2-mainline-v1-removal（8 个 commit，base main @ bdd23a6）。你是 fresh-context reviewer，独立审查这次高风险重构（V1 生产路径退役，agent 主线切 V2），不依赖会话历史。

背景：系统原为双执行路径（V1 固定五阶段 run_research_pipeline + V2 dataset-build 内核 execute_dataset_build）。本次分支：① agent INSTRUCTIONS 重写引导 V2（validate_dataset_build_spec + execute_dataset_build）；② 删除 V1 生产代码（app/pipeline/tool.py、runner.py、stages/ 五阶段+validation、processing/ 大部分解析器、app/tools/alignment.py、app/domain/processing.py、app/core/metrics.py）；③ FixtureRunExecutor 改 V2 内核（固定 spec + GDC fixture 文件 → execute_dataset_build → AgentRunExecutor._transfer_pending_publication）；④ 迁移/删除 V1 测试（tests/pipeline/ 42 文件删除、agent_loop 执行框架测试改 V2 语义）；⑤ 顺手修复：cache root 不一致（tool 改从 workdir 推导）、validation_report.json 进 immutable publication（C1d）、下载血缘闭合（真实 DownloadAttempt）。

你的任务（逐条验证，每条给 确认/反驳 + 证据 file:line）：

1. **共享件未被误删且引用完整**：app/pipeline/stages/artifact_build/columns.py（V2 schema_registry 的 _FIELD_DESCRIPTIONS 来源）、app/pipeline/processing/geo_annotation.py（V2 probe_mapping 的 parse_platform_table_text 来源）、app/pipeline/state.py（V2 runtime 的 StageOutputFile/TaskLock + extract_chart_data_vlm skill）、app/tools/cache_store.py（V2 legacy_cache/acquisition/local_cache/cache_tools 使用）——四个文件必须仍存在且它们的 import 者都能导入。
2. **无残留 V1 引用**：`grep -rn "app.pipeline.tool\|app.pipeline.runner\|app.pipeline.stages\|app.domain.processing\|app.tools.alignment\|app.core.metrics\|run_research_pipeline\|PipelineRunner\|_STAGES" app/ tests/ --include="*.py"` 应只剩注释/docstring 级别残留（允许描述性文字，不允许 import/调用）。特别注意 test_execution.py 的 stub（本地 run_research_pipeline function_tool，测执行框架用）与 test_agent_run_e2e.py 是否干净。
3. **FixtureRunExecutor V2 化正确性**：app/agent_loop/runner.py 的 FixtureRunExecutor 是否正确地：复制 fixture 资产进 workdir → 构造合法 spec → 调 execute_dataset_build.on_invoke_tool → AgentRunExecutor._transfer_pending_publication 转移 BuildResult。检查它是否处理了 managed_run_id 绑定（manager._prepare_execution 的 bind_managed_run）与取消路径。tests/runtime/test_fixture_executor.py（4 个测试）语义是否成立。
4. **agent 主线完整性**：app/agent_loop/agent.py 的 INSTRUCTIONS 是否完全引导 V2（无 run_research_pipeline 引导残留）；工具注册表是否含 validate_dataset_build_spec + execute_dataset_build 且无 V1 工具；DatasetBuildSpec 模板/四态 BuildResult/GEO vetting+AdapterParams 指引是否与代码契约一致（对照 app/datasets/contracts.py 的 SourceBinding/AdapterParams 字段与 app/datasets/build/adapters.py 的 adapter_id 注册表）。
5. **下载血缘闭合**：app/pipeline/dataset_build_tool.py 的 source_files 循环是否为每个 binding 构造真实 DownloadAttempt（attempt_id/source_id= binding.source/url=local:///status=succeeded/bytes_received）并 record_download_attempt；provenance.json（app/datasets/build/manifest.py）是否暴露 successful_attempt_id。
6. **C1d 修复**：app/datasets/build/expression_runner.py 的 _publish 是否把 validation_report.json 拷入 version dir；publication.json 的 validation_result_ref 是否可解析。
7. **cache root 修复**：dataset_build_tool.py 的 cache root 推导（run_ctx.work_dir.root.parents[2] / "cache"）与 app/api/routes.py 的 _cache_root（repository.tasks_dir.parent.parent / "cache"）在"tasks_dir=base/tasks"下是否恒等（考虑 work_dir.root = base/tasks/<task_id> 的 parents[2] 语义）。

验证方式：cd /mnt/d/code-linux/BioMed-QAgent/backend && grep/sed/python -c "import ..."。不要跑全量测试（Task B 会跑）。

交付（<500 字）：逐条核对表（确认/反驳+证据）；发现的任何误删/漏删/残留；若某条无法定论说明缺什么证据。结尾一行：R1A verdict: ACCURATE / PARTIALLY-ACCURATE / INACCURATE。
