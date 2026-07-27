# BioMed-QAgent 开发 TODO

> 基于 PROBLEM.md 赛题要求（XH-202619 赛道二方向1 选题A）。
> 目标：完成本 TODO 后可作为初步赛题成果提交。
> 上一版本归档于 git history（2026-07-23 之前）。

---

## 1. 管道核心能力（P0）

> 确定性 Pipeline 清洗、对齐、验证能力的完整性。

### 1.1 清洗能力接入 Pipeline

- [x] **P0** `pipeline/stages/processing.py` 按当前文件型 `ParsedDataset` 契约执行清洗并产出 `CleaningReportModel`
- [x] **P0** 生成 `cleaning_report.csv` artifact
- [x] **P0** 将 `CleaningReportModel.anomaly_flags` 写入 `warnings.csv`
- [x] **P0** `validation.py` 增加 cleaning_report 存在性与异常计数一致性校验

### 1.2 字段对齐能力接入

- [ ] **P0** Pipeline 中调用 `alignment.align_fields`（多源数据合并时）
- [ ] **P0** Pipeline 中调用 `alignment.merge_datasets`（多源数据合并）
- [ ] **P0** 生成 `field_mapping.csv` 的真实映射关系（当前部分硬编码）

### 1.3 清洗测试

- [x] **P0** 新增 `tests/pipeline/test_processing_cleaning.py`，验证缺失/重复/类型异常被正确标记到 warnings.csv

### 1.4 数据源硬门控解除

> Pipeline 当前通过两道硬门控强制只用 PubMed+GEO。

- [ ] **P0** `pipeline/tool.py:30-31` + `domain/contracts/runtime.py:112-119` 解除硬门控（或 `/databases` 响应加 `pipeline_supported: bool` 区分 Pipeline / Agent 直调）
- [ ] **P1** `pipeline/stages/acquisition.py:113-207` 为 PubMed 新增 SourceAsset 产出分支
- [ ] **P2** 新增 EuropePMC/Unpaywall/UniProt/ChEMBL 等 skill（需先核对 PROBLEM.md 确认必选）

### 1.5 人在回路：数据修正闭环

> 依赖 §1.1 清洗能力接入。（共享暂停原语已在 §A.10 完成）

- [ ] **P2** 新增 `request_human_correction` function_tool，包装 `CleaningReport.anomaly_flags` 为 `UserInputRequiredPayload(prompt_kind="data_correction")`
- [ ] **P2** `UserInputDialog` 增加 `data_correction` 分支渲染（异常条目表格 + 修正输入）
- [ ] **P2** 超时退化为批处理：生成 `corrections_todo.csv` 供离线修正

---

## 2. 数据源完备性（P0/P1）

> 多源数据接入、合规化与契约统一。

### 2.1 Acquisition Skills 合规化（接入 crawler.py）

- [ ] **P1** GDC skill 接入 `crawler.py`（替换 `urllib.request.urlopen` → `httpx_fetch`，获得限速 + BROWSER_UA + Referer）
- [ ] **P1** PDB skill 接入 `crawler.py`
- [ ] **P1** Xena skill 接入 `crawler.py` + 改用 `BROWSER_UA`（删除 `_USER_AGENT = "BioMed-QAgent/0.1"`）

### 2.2 Xena 403 修复

- [ ] **P1** 切换 download host 到 `toil.xenabrowser.net` 或加 browser fallback
- [ ] **P1** 更新 `integrations/acquisition.py:_ALLOWED_HOSTS` 域名白名单
- [ ] **P1** 更新 `test_skill_xena.py` 的 URL 硬断言
- [ ] **P1** 移除 `test_all_data_sources_live.py:200-208` 的 xfail

### 2.3 补全 download 工具

- [ ] **P1** PubChem 增加 `download_pubchem`（SDF/MOL，走 `acquire_source()` → `SourceAsset`）
- [ ] **P1** Reactome 增加 `download_reactome`（participants TSV / SBGN，走 `acquire_source()` → `SourceAsset`）

### 2.4 统一 SourceAsset 契约

- [ ] **P1** GDC/PDB/Xena/browser 下载路径走 `acquire_source()`（当前只有 GEO 走完整 verified streaming）
- [ ] **P1** 所有 acquisition skill 产出合规 `SourceAsset`

### 2.5 PubMed XML 注册为 SourceAsset + download_log 完整性

- [ ] **P1** `download_supplementary` 改为走 `acquire_source()` 产出 `SourceAsset`
- [ ] **P1** `acquire_source` 返回所有 attempt（含失败），当前只返回最终一次
- [ ] **P1** `download_log.csv` 记录失败 attempt 与 reason（完整回退链路可见）
- [ ] **P1** 大文件下载增加 progress 事件（>100MB 当前无反馈）

### 2.6 删除旧 domain 模型（dataclass）

> 旧 `app.domain/output.py`、`processing.py` 仍被 `tools/` 引用。

- [ ] **P1** 迁移 `tools/export.py` 到新 Pydantic 契约
- [ ] **P1** 迁移或删除 `scripts/demo_workflow.py` 旧 `SourceRecord(...)` 实例化
- [ ] **P1** 删除 `app/domain/output.py` 的旧 `SourceRecord` dataclass
- [ ] **P1** 清理 `app/domain/__init__.py` 顶层导出
- [ ] **P1** 同步更新 `tests/test_output.py`

### 2.7 赛题加分项

#### 2.7.1 图表数据提取

- [ ] **P2** `validation.py` 新增 `chart_data` 完整性校验（每行有 source_asset_id，每个 point 有 chart_id）

#### 2.7.2 单位不一致检测

- [ ] **P2** `cleaning.py` 新增 `detect_unit_inconsistencies`
- [ ] **P2** 单位冲突写入 `warnings.csv`

#### 2.7.3 OCR 能力

- [ ] **P2** `extract_tables.py` 增加 `ocr_fallback`（pytesseract 可选依赖）
- [ ] **P2** 中文支持 `lang='chi_sim+eng'`

#### 2.7.4 DE 分析 FDR 校正

- [ ] **P2** `stats.py:run_differential_expression` 增加 BH FDR 校正
- [ ] **P2** 火山图增加 `padj` 阈值线
- [ ] **P2** 输出 `padj` 字段
- [ ] **P2** 移除 `stats.py:638` 的 `# type: ignore[arg-type]`

#### 2.7.5 extract_tables 测试覆盖

- [ ] **P2** `tests/test_skill_extract_tables.py` 增加真实 pdfplumber 路径测试
- [ ] **P2** 在 `tests/fixtures/` 放置最小真实 PDF（1 页 1 表）

#### 2.7.6 视觉采集与 VLM 联调

- [ ] **P2** `web_visual_capture` 与 `extract_chart_data_vlm` 联调（集成测试：capture → VLM → CSV）
- [ ] **P2** BrowserPool 接入 `crawler.py`（切换为 `pool.acquire_context()`）

### 2.8 GEO 主产物数据恢复

> 现有 live Acquisition 可能下载 tximport counts，但 Processing 将其按 series matrix
> 解析，无法恢复样本时会生成零行占位数据。Validation Gate 已拒绝零行
> `main_data.csv`，但真实表达数据恢复仍需修正 acquisition/processing 契约。

- [ ] **P0** 保证 GEO Discovery accession、下载资产与 `dataset_id` 一致，并同时获取表达矩阵所需的权威样本元数据
- [ ] **P0** Processing 按资产类型路由 tximport counts 解析器，产出真实表达记录而非 `geo_minimal_placeholder`
- [ ] **P0** 新增 live fixture 回归：GEO counts + 样本元数据经 Pipeline 后 `main_data.csv` 至少包含一条表达记录

---

## 3. 前端体验与呈现（P1/P2）

### 3.1 产物/结果展示

- [ ] **P1** `ResultsViewer` 增加 `field_descriptions.csv` 专门视图（表格：field_name / data_type / description / unit / nullable / example）
- [ ] **P1** `ResultsViewer` 增加 `source_list.csv` / `source_relations.csv` 专门视图
- [ ] **P1** `ResultsViewer` 用 Tabs 分离主数据/来源/处理/警告（14 个 artifact 当前平铺）
- [ ] **P2** `SettingsPanel` Tab 移至左侧垂直布局（当前水平排列 Model/Databases/Skills）

### 3.2 invoke_skill / find_skill 前端呈现

> 当前 `invoke_skill` 统一显示为"调用 invoke_skill"，无法体现实操；输出 JSON 纯单行无换行滚动。

- [ ] **P2** `toolLabels.ts` 新增 `invoke_skill` formatter：从 `args.operation`（如 `search_xena`）读取技能名，按前缀推测 verb（`search_*` → "检索"）
- [ ] **P2** `toolLabels.ts` 新增 `find_skill` formatter：从 `args.intent` 显示意图
- [ ] **P2** `ToolCallStep` 紧凑化：缩小 padding、完成态图标调灰（`text-muted-foreground`）、字体降级
- [ ] **P2** `ToolCallStep` 输出区域改造：自动换行 + 垂直滚动 + 隐藏滚动条（超 200px 时 `max-h-48 overflow-y-auto [scrollbar-width:none]`）+ JSON 自动格式化

### 3.3 模型搜索框恢复

> 当前受 `hasApiKey && sortedModels.length > 0` 守卫控制；降级分支无搜索。

- [ ] **P1** 排查 `hasApiKey` / `sortedModels` 不满足条件的原因，修复上游传值
- [ ] **P2** 降级分支（旧 `DropdownMenu`）也加入搜索输入框
- [ ] **P2** 清理 `LEGACY_MODELS` 硬编码列表，改为从 API 动态获取

### 3.4 对话流任务节点自动折叠

> 详见 `docs/REVIEW_2026-07-20-llm-output-hygiene.md` §3。参考 TRAE SOLO 模式。

- [ ] **P1** 节点边界：以 `tool_completed` 到达为界，`[assistant_segment, tool_call]` 归组为"任务节点"
- [ ] **P1** 自动折叠：节点完成后折叠为单行摘要（`✓ <工具标签> · <一句话结论>`）；活跃节点保持展开；可点击展开
- [ ] **P1** 前端实现：`types.ts` 新增 `TaskNode` 投影；`reducer.ts` 归组逻辑；`TaskNodeItem.tsx` 新组件
- [ ] **P1** 摘要生成：工具标签来自 `formatToolCall()`；结论来自后续 `assistant_segment` 首句 / 工具 output `summary` 字段
- [ ] **P1** 降级：归组失败时保持逐项展示

### 3.5 通用 UI 改进

- [ ] **P2** 引入 shadcn command / context-menu / menubar 组件
- [ ] **P2** 优化思维链呈现 / 产物呈现
- [ ] **P2** 引入对话路由（便于调试 & 厘清页面关系）
- [ ] **P2** 缓存导出按钮放到设置页面
- [ ] **P2** 优化边栏底部（当前信息过于杂乱）

---

## 4. 可靠性与可观测性（P0/P1）

### 4.1 静默吞错修复

- [ ] **P0** `runtime/manager.py:331-334` `_commit_task` 失败增加 logger.error（当前 `except Exception: pass`）
- [ ] **P0** `agent_loop/runner.py:324` 限制 `except BaseException` 范围到 `except Exception`

### 4.2 Pipeline artifact 降级路径

- [ ] **P1** `agent_loop/runner.py:115` 指纹未变时仍发射 `artifact_produced`（或标记 `artifact_unchanged` 让前端走 HTTP 拉取）
- [ ] **P1** `routes.py:548-549` `.runtime-publication.json` 缺失时回退到 manifest 文件本身（加 `degraded=true` 标记）

### 4.3 错误日志增强

- [ ] **P1** `pipeline/state.py:228` `load_stage_output` 异常返回 None 时增加 `logger.warning`
- [ ] **P1** `pipeline/runner.py:617` `_collect_stage_output_files` 异常时增加警告日志
- [ ] **P1** `api/ws_events.py:362, 375, 381` WebSocket 错误路径增加 WARN 日志

### 4.4 结构化日志

- [ ] **P1** `main.py` 引入 structlog 或 python-json-logger，所有日志带 `task_id`/`run_id`/`stage` 上下文
- [ ] **P2** 新增 `docs/observability.md`

### 4.5 Agent max_turns 后续

- [ ] **P2** INSTRUCTIONS 新增"达到 max_turns 后应输出 `[MAX_TURNS_REACHED]` 标记"指导

---

## 5. 工程基础设施（P1/P2）

### 5.1 消除死代码与重复

- [ ] **P1** 删除 `api/settings_router.py`（仅被 `test_settings_api.py` 引用，已迁移后可移除）
- [ ] **P1** 前端删除 `agentSelectors.ts` 未使用导出（`selectActiveRuns` 等）
- [ ] **P1** 提取共享 `_write_csv` 到 `tools/io.py`（`artifact_build.py` + `validation.py` 各一份）
- [ ] **P2** 前端提取 `errorDescription` 到 `lib/utils.ts`（5 处重复）
- [ ] **P2** 前端统一 `formatSize` 到 `fileUtils.ts`（3 份不一致的变体）
- [ ] **P2** 修正 `tools/io.py` → `agent_loop/context.py` 循环依赖

### 5.2 并发与资源管理

- [ ] **P1** `crawler.py` 引入 BrowserPool（单例 Chromium + 多 context，4 并发共享）
- [ ] **P2** 监控并发 Chromium 实例数，超阈值时排队

### 5.3 配置硬编码治理

- [ ] **P2** `config.py` 扩展配置项（`crawler_ua` / `crawler_rate_limit_seconds` / `compaction_*` / `stage_timeouts` / `max_download_bytes`）
- [ ] **P2** 启动时校验 `DASHSCOPE_API_KEY` 非空（fail fast）
- [ ] **P2** `OUTPUT_DIR` 改为绝对路径默认值（当前相对路径 cwd 依赖）
