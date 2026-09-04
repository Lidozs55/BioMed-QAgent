# REVIEW — 全仓库代码卫生审查（冗余/过度设计/契约漂移）（2026-08-10）

> 审查方式：静态基线（ruff / eslint / tsc 全零告警）+ 4 路并行子代理扫描（后端死代码、后端过度设计、前端冗余、跨层重复与文档漂移）+ 最高优先级结论人工抽样复核
> 范围：`backend/app/`（183 py）· `frontend/src/`（177 ts/tsx）· `docs/` 与 `AGENTS.md` 对照
> 结论：**无架构级重构需求；冗余均为结构级（重复实现、死路径、契约漂移），可小批次安全清理。双管线（V1/V2）为活跃兼容层，非死代码，但需设 V1 下线点。**

---

## 1. 静态基线

| 检查 | 结果 |
| --- | --- |
| 后端 `uv run ruff check app/ tests/ launcher.py` | ✅ 0 告警 |
| 前端 `pnpm lint`（--max-warnings 0） | ✅ 0 |
| 前端 `pnpm tsc`（--noEmit） | ✅ 0 |

语法/未使用局部变量层面干净 → 冗余全部属于结构级。

---

## 2. 确认死代码（可删；删除时同步清理对应 tests）

### 后端

| # | 位置 | 证据 | 风险 |
| --- | --- | --- | --- |
| 1 | `backend/app/datasets/build/chain.py`（`build_expression_dataset` 全文件） | 生产零调用，仅 `build/__init__.py:21,53` 导出；`expression_runner.py:4` docstring 自认是其替代品（超集） | 高 |
| 2 | `backend/app/datasets/build/multi_build.py`（`MultiBuildOrchestrator` ~150 行） | 生产零调用；docstring 自称"为 Phase 7 API 预留"——为未实现功能预置的编排层 | 高 |
| 3 | `backend/app/settings_manager.py`（整模块） | `app/` 内零 import；已被 `app/model_settings.py` 的 `ModelSettingsStore` 取代 | 高 |
| 4 | `backend/app/tools/_registry.py`（整模块） | 生产主链已改用 `build_skill_gateway`（`agent.py:495`），零引用 | 高 |
| 5 | `backend/app/config.py:15-37,67,70`（`crawler_ua` + `stage_timeouts` + `_parse_stage_timeouts` 22 行） | 全仓无生产消费者；UA/限速走硬编码 `BROWSER_UA` / `DEFAULT_RATE_LIMIT_SECONDS` | 高 |
| 6 | `backend/app/core/`（空包，仅 docstring） | 全仓零引用 | 低 |
| 7 | `TaskSpecification.declare_sources`（`domain/contracts/task.py:85-138`） | 零调用点（manager 直接传字段） | 中 |
| 8 | `build_manifest`（`datasets/build/manifest.py:319-338`） | 生产用 `assemble_manifest`/`write_manifest`，该函数仅测试引用 | 中 |
| 9 | `SkillRegistry.list_by_category/list_by_source/get_acquisition_skills/names`（`skills/registry.py:91-124`） | 生产仅用 register/get/list_enabled | 中 |
| 10 | `SkillCatalog.register/remove`（`skills/catalog.py:237-272`） | 生产仅用 replace_all/snapshot | 中 |
| 11 | `ParsedDataset`（`domain/contracts/pipeline.py:55-80`） | V1 内存解析模型已退役（`domain/__init__.py` docstring 声明） | 中 |
| 12 | `TaskRecoveredPayload`（`domain/contracts/events.py:198-205`） | `task_recovered` 事件注册但从未发射（reducer 无分支） | 中 |

### 前端

| # | 位置 | 证据 |
| --- | --- | --- |
| 13 | `components/DataTabs.tsx`（~200 行）+ `ui/toggle.tsx` + `ui/avatar.tsx` + `ui/command.tsx` + `ui/toggle-group.tsx` | 全 src 无外部 import（已复核：仅 toggle-group→toggle 内部链接；DataTabs 是旧设置弹窗 tab 化的遗留） |
| 14 | `lib/contextBudget.ts`（170 行，9 个导出） | 仅被自身单测引用；生产改由后端下发 `context_window`/`safety_reserve_tokens` 等 |
| 15 | `runtime/controller.ts:49 startRuntime`、`lib/eventValidatorHelpers.ts:95 assertRecord`、`lib/databaseDraft.ts` 的 `HTTP_METHODS/HttpMethod/EMPTY_DATABASE`、`lib/apiEnvelopeParsers.ts:15` 冗余 re-export | 全 src 零 import |

### 依赖清理

- `@shadcn/react`、`cmdk`（仅被死文件 `ui/command.tsx` 引用）→ 可移除
- `shadcn`（CLI）→ 应从 dependencies 移入 devDependencies

---

## 3. 过度设计 / 冗余抽象（需权衡，多为中危）

1. **循环导入 workaround**：`datasets/build/adapters.py:736-739` 末尾 `from app.datasets.build.geo_adapter import GeoExpressionAdapter  # noqa: E402`——共享辅助（`_long_row/_rejected/_wide_matrix_mappings/_is_finite_number`）应抽到第三个模块，两 adapter 单向依赖。
2. **GDC/Xena adapter 死参数**：`adapters.py:452,664` 的 `_extract(parameters=...)` 接收不读取（`_extract_matrix`/`_extract_star_counts` 签名根本没有该参数）；唯一消费方是 geo。
3. **NcbiDiscoveryClient Protocol**（`integrations/ncbi/discovery.py:22-29`）：单一实现的接口，仅为测试 stub 存在；成本低可留可删。
4. **`_row_granularity_for` 镜像 schema registry**（`adapters.py:236-248`）：同一事实两处维护，建议 adapter 直接查 registry。
5. **manager.py 事件转发 4 层链**：`_append_status`/`_persist_status`/`_append_completion_status` 大量重叠，可合并为单函数 + `durable_reconcile` 开关（中危，涉运行时状态机，需谨慎）。

---

## 4. 重复实现（确认冗余，收敛即可）

| 重复点 | 位置 | 收敛方案 |
| --- | --- | --- |
| Retry-After 解析 ×2 | `skills/builtin/acquisition/geo.py:36-51` vs `integrations/ncbi/client.py:50-62` | 共享 `parse_retry_after` |
| facade 下载包装 ×3 | `gdc.py:86-116` / `xena.py:343-359` / `pdb.py:80-107` | 并入 `_download_io.py`（其 docstring 自称收敛宿主，但 run 级包装仍散落） |
| gzip 透明打开 ×3 | `datasets/build/adapters.py:92-95` / `tools/io.py:113-124` / `xena.py:362-367` | 统一为魔数检测共享工具 |
| 双下载栈 | `integrations/acquisition.py`（httpx+白名单） vs `_download_io.py`（urllib+限速） | 收敛到单一 transport 选择入口 + 文档化边界 |
| 三套缓存 | `datasets/build/cache.py` / `tools/cache_store.py` / `datasets/build/legacy_cache.py` | 过渡期合理，设 V1 下线日；`_SAFE_SEGMENT` 合并单一来源 |
| 前端事件类型 4 处重复 | `runtime/contracts.ts:422-615` / `lib/apiResponseParsers.ts:36-50` / `lib/eventParsers.ts:6-21` / `runtime/transport.ts:22-71` | 抽单一 `eventTypeRegistry`（**最高风险**：新增事件类型需同步 4 处，遗漏即静默丢事件） |
| 前端解析函数重复 | `parseBuildResult`/`assertStageName`/`assertHex64` 在 eventParsers 系列重复 | 收敛到单一实现 |
| conversation step 外壳 ×10 | `components/conversation/*Step.tsx` 四层 `Message/Bubble` 外壳逐字相同 | 抽 `StepBubble`；`operationMeta` label 复用 `stageLabels.STAGE_LABELS` |
| `transport.ts:172-174` | `value.type === "assistant_reasoning_delta"` 连续重复两次 | 删一行 |

---

## 5. 契约漂移 / 文档漂移（可立即修，零风险）

1. **AGENTS.md 路由表**：`POST /settings`→实际 **PUT**（`api/settings.py:140`）；`GET /models`→实际 **POST**（`settings.py:168`）；`/models/{model_id}`→实际 `/model-info/{model_id}`；缺 /builds、/cache/datasets、/skills 管理面、/import/tasks、/compact、subagent cancel 等 15+ 路由。
2. **AGENTS.md / ARCHITECTURE.md 事件清单**：缺 `publication_created`、`tool_called`、10 个 `subagent_*`；"every `stage_*` event is still emitted and mirrored by an `operation_*` event" 与事实不符——**stage_started/completed/failed/skipped 后端已无任何生产 emit 方**（仅 `stage_progress` 有镜像，`agent_loop/runner.py:937-950`），该表述需改为事实。
3. **ARCHITECTURE.md §14.2**：RuntimeEventType 声称 22 类实际 27 类；"build_spec_ready/source_candidate_found/rejected/compatibility_evaluated/build_result_ready" 清单从未落地；§15 `/tasks/{task_id}/builds` 🚧 实为已实现的全局 `/builds`。
4. **TODO.md:71**："删除 validated_intermediate/validated_final" 代码已无残留，应勾选；TODO.md:58 引用的 `pipeline/runner.py` 已删除。
5. **前后端字段丢失**：`task_completed.build_result`（后端 `events.py:203-207` 有，前端 `contracts.ts:492-501` 与 `eventParsersPipeline.ts:144-153` 未读）；`BuildResult.build_id` 与 `binding_failures`（K2 新增）前端均未解析——NO_DATA 的逐来源失败原因前端不可见。✅ **B3 已修复（2026-08-10，见 §10）**
6. **stage 标签三处同步**：后端 `events.py:611-617 _STAGE_OPERATION_LABELS` / 前端 `stageLabels.ts:3-9` / `operationMeta.ts:36-62` 同一组中文标签写三份，应以 operation 端为唯一事实源。

---

## 6. 兼容期保留（非死代码，但需设过期点）

- **v1_bridge 双写 + routes legacy 双读**：`v1_bridge.py` 在 `dataset_build_tool.py:763-776` 被调用（managed run 镜像）；`legacy_cache.py` 在 `routes.py:41-47,1783-1802,1931-2005` 双读；`routes.py:930-970,973-1058` 的 V1 artifacts 分支经 `_load_validated_manifest`（:1120-1203）。全部有真实调用方。下线条件：全部客户端迁移到 `/builds` + `/cache/datasets` 后。
- **stage_* 事件 + 前端 StageStep/stageLabels/prune 逻辑**：保留到无 legacy events.jsonl 需回放。
- **前后端手写 schema 双份 + 前端逐字段断言校验器**：无类型生成管线的结构性债务，建议 OpenAPI 生成，或至少 contract 变更 PR 时核对 §5.5 漂移点。
- **V1/V2 双 artifact 契约**：`ArtifactManifestEntry`（`domain/contracts/pipeline.py:117-125`）vs `ManifestArtifactEntry`（`datasets/contracts.py:415-421`），随 v1_bridge 下线自然合并。

---

## 7. 清理批次（小批次 + 验证 + 可回滚）

> **B1（零风险删减）与 B2（收敛）已于 2026-08-10 完成**（commit `781d2d2`，
> 见 §9 执行记录），不再列于待办。

| 批次 | 内容 | 验证 | 回滚 |
| --- | --- | --- | --- |
| B3（契约修正） | §5.5 前端补 `build_result`/`binding_failures` 字段 | 前端类型检查 + 事件回放测试 | 独立 commit |
| B4（需评审） | §3 循环导入/死参数/事件转发合并；§6 V1 下线计划 | 先出设计，代码后行 | 单列 |

**停止条件**：每批次全量 `uv run pytest`（当前 2306 通过 + 2 项既有 `test_artifact_api` 失败）+ `pnpm lint && pnpm tsc && pnpm build` 全绿才推进下一批。

---

## 8. 附注（实施时环境状态）

- 本审查期间未修改任何生产代码（纯只读）。
- `main` 本地领先 `origin/main` 2 个提交（上轮 P3/P4/K2/K3 因网络中断未推送），需网络恢复后手动 `git push`。

---

## 9. B1/B2 执行记录（2026-08-10，分支 `chore/b1-b2-code-hygiene`）

### B1 已落地

**后端删除**：
- `datasets/build/chain.py` + `tests/test_dataset_build_chain.py`：同步清理
  `build/__init__.py` 导出（`BuildChainResult` / `build_expression_dataset`）与
  `expression_runner.py` docstring 中 chain 提及。
- `app/settings_manager.py` + `tests/test_settings_manager.py`：
  `test_run_model_settings.py` / `test_model_credentials.py` 移除对
  `settings_manager.get_settings` 的 monkeypatch——生产实际读取 `app.model_settings`，
  原 monkeypatch 是目标不存在的假拦截，删除不改变测试行为。
- `app/tools/_registry.py` + `tests/test_tool_registry.py`：`test_import_api.py`
  的 ensure-import 行一并移除。
- `config.py` 的 `crawler_ua` / `stage_timeouts` / `_parse_stage_timeouts`
  （保留 `rate_limit_seconds`，`main.py:147` 仍消费；同步清理 `.env.example` 注释）。
- `app/core/` 空包（仅一行 docstring，零引用）。

**前端删除**：
- `components/DataTabs.tsx` + `ui/toggle` / `toggle-group` / `avatar` / `command` 死组件链。
- `lib/contextBudget.ts` + 其单测；`eventValidatorHelpers.assertRecord`（`assertObject` 别名，零消费者）；
  `apiEnvelopeParsers.ts` 冗余 re-export；`databaseDraft.HTTP_METHODS` 常量（`HttpMethod` 改手写 union）。
- 依赖：`cmdk` 移除；`shadcn` CLI 从 dependencies 移入 devDependencies。

**文档漂移**：
- AGENTS.md：路由表（`PUT /settings`、`POST /models`、`/model-info/{model_id}`，补 20+ 缺失路由）；
  事件清单补全（`publication_created` / `tool_called` / `task_cancelled` / 10 个 `subagent_*`）；
  `stage_*` 镜像表述改为事实（仅 `stage_progress` 有发射+镜像）。
- ARCHITECTURE.md：§14.2 事件计数 22→27、未落地的 `build_spec_ready` 等清单修正；
  §15 `/tasks/{task_id}/builds` 🚧 → 已实现的全局 `/builds` ✅。
- TODO.md：:71 勾选；:58 引用已删除的 `pipeline/runner.py` 加注。
- backend/README.md 目录树 / 扩展指南（`_registry.py` → 自动发现）；frontend/README.md 组件清单（36→32）。

### 执行中修正的审查误判（原报告 §2 #15、§4 部分条目）

- `EMPTY_DATABASE`（databaseDraft.ts:68）被 `SettingsPage.tsx` 生产引用 → **保留**（原列死代码有误）。
- `startRuntime`（controller.ts:49）被 `runtime-controller.test.ts` 大量使用 → **保留**
  （测试入口，非生产死代码；删除需改大量测试）。
- `@shadcn/react` 被 `ui/message-scroller.tsx` 生产引用 → **保留**（原报告"可移除"有误）。
- `HttpMethod` 类型被 `parseHttpMethod` 返回类型使用 → 仅删 `HTTP_METHODS` 数组常量。
- `xena.py:_decompress_gz` 是落盘解压而非"透明打开"，不属于 gzip 打开重复 → **保留**。

### B2 已落地

- Retry-After 解析合并：`geo.py:_retry_delay` 复用
  `integrations/ncbi/client.py:parse_retry_after`（保留指数退避 fallback）。
- gzip 透明打开统一：`tools/io.py:_open_text` → 公开 `open_text(path, *, encoding, errors, newline)`
  （魔数检测）；`adapters._open_table` 委托之，行为不变量保持
  （adapters 仍传 `encoding="utf-8"` + `newline=""`）。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| 后端 `uv run ruff check app/ tests/ launcher.py` | ✅ 0 告警 |
| 后端定向测试（137 项：config / model_credentials / run_model_settings / import_api / ncbi client / geo adapter / expression_runner） | ✅ 全过 |
| 后端全量 `uv run pytest` | 2306 通过 + 2 项既有 `test_artifact_api` BOM/CRLF 失败（基线问题，与本次改动无关） |
| 前端 `pnpm lint` / `pnpm tsc` | ✅ 0 错误 |
| 前端 `pnpm build` | ✅ |
| 前端 `pnpm test` | ✅ 702 通过 |

### 未执行（保持原决策）

- B1 契约面符号（§2 #7-12）与 `multi_build.py`（Phase 7 预留 seam，设计未完工）**保留**。
- B3（前端补 `build_result` / `binding_failures` 字段）、B4（循环导入 / 死参数 /
  事件转发合并、V1 下线计划）未动，留待后续批次。

---

## 10. B3 执行记录（契约修正，2026-08-10）

### 改动

- **`runtime/contracts.ts`**：新增 `BindingFailureDetail` 接口；`BuildResult` 补
  `build_id?: string | null` 与 `binding_failures?: BindingFailureDetail[]`（可选字段，
  旧事件回放不破坏）；`task_completed` 事件补 `build_result?: BuildResult | null`。
- **解析器三处补齐**：
  - `lib/eventParsersRuntime.ts` `parseBuildResult`：解析 `build_id` + `binding_failures`
    （run_completed 事件路径，K2 真实数据通道）。
  - `lib/apiResponseParsers.ts` `parseBuildResult`：同上（`/builds/{id}` REST 路径）。
  - `lib/eventParsersPipeline.ts` `task_completed`：解析可选 `build_result`
    （契约完整性；该事件后端当前无生产发射方，供旧事件回放与未来 fixture 路径兼容）。
- **UI 可见性**：`BuildResultsViewer.BuildBanner` 对 NO_DATA 展示逐来源失败
  `binding_id / reason_code / message` 列表——修复"逐来源失败原因前端不可见"。

### 边界判断

- `task_completed` 事件后端无生产发射方（Agent 路径统一走 `run_completed`），
  因此 **reducer 未对 fixture 路径新增 build_result 投影**（避免改动 V1 遗留状态机；
  解析器已保证字段可达）。`binding_failures` 的真实可见路径是 `run_completed` →
  `run.summary.build_result` → `BuildResultsViewer`。

### 验证

| 检查 | 结果 |
| --- | --- |
| 前端 `pnpm lint` / `pnpm tsc` | ✅ 0 错误 |
| `api-event-payloads`（39）+ `terminal-state`（10）+ `api`（9）+ `build-results-viewer`（11） | ✅ 69 通过 |
| `pnpm build` | ✅ |

### 待办

- B4（§3 循环导入 / 死参数 / 事件转发合并；§6 V1 下线计划）需评审后推进。
