# REVIEW — Phase 4 全量 Bug Sweep（4a+4b+4c 合并后整体审查与修复）

日期：2026-08-08
分支：`fix/phase4-review-bugs`（基于 `main @ 08c961c`，即 Phase 4a/4b/4c + phase3-p2 integrator 合并后的状态）
结论：**4 个分域评审（A 运行时 / B pipeline+artifacts / C 前端 / D agent loop+HIL）共 30 项 findings；
修复波 1-4 处理 23 项（TDD 全部红→绿），7 项设计级延后记录。** 终态：后端 2377、前端 677。

## 1. 评审方法

- 4 个并行只读分域评审（gpt-5.6-sol），各产出 findings 表（severity / file:line / 失败场景 / 修复方向 / repro 草图）。
- 控制器对高危 claims 逐一复核源码（C1/B8/B9/D1 前提等坐实；D1 前提验证了 agents 0.18.2
  的 `tool_execution.py` 并发执行工具调用）。
- 修复波按风险分层：Wave 1（已确认、低风险：后端 8 + 前端 7）→ Wave 3/4（test-first 风险项：
  后端 6 + 前端 2），每项 TDD（红测试先行），波间跑全门。

## 2. 已修复（23 项，TDD）

### Wave 1 后端（commit `77dfede`，+26 测试）

| ID | 严重度 | 修复 |
| --- | --- | --- |
| B1 | Critical | `DatasetBuildSpec.build_id` / `SourceBinding.binding_id` 路径逃逸 → 复用 TaskWorkDir 严格单组件 ID 校验（模型层拒绝 `../`、绝对路径） |
| B2 | Important | V2 检查点摘要不含源文件内容 → 摘要纳入 sorted binding→SourceAsset.sha256 映射（换源后不再复用陈旧 publication，B 评审探针通过） |
| B7 | Important | artifact 路由 `read_bytes()` 整文件读入内存 → 1 MiB 分块哈希（语义不变，list 时 409 校验保留） |
| B8 | Important | V2 supersedes 链字典序取最大 publication_id → 按 `published_at` 取最新（工具侧 `_latest_publication_id` 同类 bug 一并修） |
| B9 | Important | V1 工具信封缺 `build_result` → completed 结果新增 `build_result`（NO_DATA 在工具边界可区分，加性兼容） |
| D2 | Important | `execute_dataset_build` 不感知取消 + 事件循环同步解析 → 透传 `cancellation_requested`，validate/publish 前检查并返回 cancelled 结果 |
| D3 | Minor | 模型可控 `timeout_seconds` 无界（负数/NaN/inf）→ 工具入口校验有限值 [1, 3600] |
| A8 | Minor | `artifact_count` 无去重 → reducer 按 `(run_id, artifact_id)` 去重（私有键持久化，API 不暴露） |

### Wave 1 前端（commit `dc32b33`，+14 测试）

| ID | 严重度 | 修复 |
| --- | --- | --- |
| C1 | Critical | `publication_created` 缺失于 EVENT_TYPES → 实时 WS 路径确定性丢 publication 链 → 白名单补齐（reducer 原有处理激活） |
| C3 | Important | 终态任务永不退订 → transport 新增 `shouldSubscribe` 对账（终态即退订 + unsubscribe；`continueTask` 显式重订） |
| C4 | Important | cancel 不清 `pendingUserInput` → `run_cancel_requested`/终态事件清除 prompt；非 awaiting_user_input 时弹窗动作禁用 |
| C5 | Important | `user_input_resumed` 身份校验前强转 running → 仅当匹配当前 pending `{runId, requestId}` 才转换状态 |
| C8 | Minor | `expires_at` 过期仍可提交 → 无效/过去时间戳渲染过期态并禁用动作，等待 durable resume 事件关闭 |
| C9 | Minor | 仅表头 CSV 被当有数据 → `rows.length === 0` 渲染空态 |
| C10 | Minor | ArtifactSheet 丢弃 role → `fileType(name, role)` 传参（audit/schema/provenance 分类恢复） |

### Wave 3 后端（commit `9d94a19`，+12 测试）

| ID | 严重度 | 修复 |
| --- | --- | --- |
| A1 | Important | CANCEL_REQUESTED 时 worker 异常可能永久非终态 → `_handle_worker_failure` 对 CANCEL_REQUESTED 追加 RunCancelledPayload 并清理 `_running`（恰一个终态事件） |
| A5 | Minor | 子代理 resume 先于父状态校验 → 任务锁内先校验父状态，父终态 409，broker 路由与清理共享锁 |
| B3+B4 | Important | V2 publication 保留 relative_path；发布前逐件 size+分块 sha256 校验；provenance 精确身份（非仅计数） |
| B5 | Important | V2 空输入报通用 error → 结构化 NO_DATA（status=no_data, valid_row_count=0, 无主发布；空源在 parse 期即捕获 + manifest row_count==0 双信号） |
| B6 | Important | V2 profile 只查表头宽度 → 新增 row_width_matches_schema check（csv.reader 解析，拒绝字段数不符/缺格） |
| D1 | Important | HIL 非独占边界（SDK 并发执行工具调用）→ RunContext `main_input_pending` 门控 execute_dataset_build（best-effort 入口检查，SDK 全序列化超出范围） |

### Wave 4 前端（commit `9f6d75e`，+6 测试）

| ID | 严重度 | 修复 |
| --- | --- | --- |
| C2 | Important | 序列缺口不检测 → 缺口不推进游标 + recoverSubscription（每游标一次，永久 schema 漂移退化为重连防御性重同步） |
| C6 | Important | 四态 UI 只渲染短标签 → ChatPanel 紧凑 RunSummary 块（user_summary / recommended_next_action / 错误码+user_message / 取消阶段） |

## 3. 延后项（设计级，记录不修）

| ID | 严重度 | 说明 | 建议归属 |
| --- | --- | --- | --- |
| A2 | Important | 发布先于终态可持久化（publication 提交与 run_completed 非同一事务；取消/崩溃窗口产生"已发布但 run 非成功"的孤立产物） | 需要 finalize 事务化重构（finalize intent/commit marker + 启动对账），独立任务 |
| A3 | Important | reducer 不校验 run 状态即接受 `publication_created`（受 A2 发射顺序影响；重复事件不比较 `supersedes_publication_id`） | 随 A2 事务化一起设计 |
| A4 | Important | 管理器重启丢弃 pending HIL prompt（恢复为 run_interrupted，无 prompt-invalidated 事件；浏览器重连看到过期 prompt 但 run 已终态） | 需决策：重启恢复 broker 或显式 prompt-invalidated 事件 + 前端丢弃，独立任务 |
| A6 | Minor | `_task_locks` / repository `_task_locks` / EventStore `_checkpoints` 强键字典永不清除（重复建删任务内存增长） | 引用计数/弱引用注册表，独立任务 |
| A7 | Minor | `TaskIndex.list_tasks` active 列表不受 limit 约束（长会话 API 序列化无界） | active 游标/分页，独立任务 |
| C7 | Important | NO_DATA banner/预览按 role 存在性推断归属（task 级 artifact 聚合无法按 run/publication 过滤；4b REVIEW §3-4 已接受） | 前端 store 引入 artifact 归属元数据（与 4a 遗留 `list_artifacts` 暴露 role 一并做） |
| V2-dup | Important | `execute_dataset_build` 的结构化结果（成功/NO_DATA）未写入 durable `execution.build_result`（manager 兑底为通用 NO_DATA；RunContext 不暴露 execution）——B9/B5 在端到端不一致（第二轮 MUST-FIX #10） | 需接线设计：V2 工具结果 → durable Run 结果路径，独立任务 |
| V2-validation_ref | Minor | `DatasetPublication.validation_result_ref → validation_report.json` 未拷贝进 version 目录（发布引用闭包缺口，非 manifest artifact） | 随 A2/A3 publication-integrity 工作一并 |

## 4. 第二轮（最终 re-review MUST-FIX，Wave 5/6）

第一轮 23 项修复后，最终 scoped re-review（gpt-5.6-sol）对 11 项 MUST-FIX 判定：7 项部分/回归 + 4 项未闭合。
Wave 5（后端）+ Wave 6（前端）处理 10 项；#10（V2 结果传播）转 §3 设计级。

### Wave 5 后端（commit 待填）

| 项 | 修复 |
| --- | --- |
| D2 | V2 parse/canonicalize/integrate 同步段 asyncio.to_thread 卸载（取消可中断） |
| D1 | 发布前重检 `main_input_pending`（entry 检查之外的 publication-time 门） |
| B5 | NO_DATA 结构化、attempt 限定（typed 错误码替代子串匹配；混合源不全拒） |
| A1 | 终态化 append 有界重试；成功后才释放 ownership（失败留给恢复路径） |
| B8 | 时区 naive/aware 归一化后再比较（防御 TypeError） |
| A8 | 旧快照去重状态重建 + 冲突重复 artifact 拒绝 |

### Wave 6 前端（commit 待填）

| 项 | 修复 |
| --- | --- |
| C3 | 选择/水合终态历史任务不重订（shouldSubscribe 门控 selection-time subscribe） |
| C2 | 永久缺口快照兑底（有界 recovery 失败 → REST snapshot 水合）；socket 替换清 marker |
| C8 | 弹窗挂载期 deadline 定时重算（setInterval 链） |
| #11 | `operation_*` 四事件入 EVENT_TYPES + reducer 无操作透传（游标前进，状态不变） |

## 5. 验证（终态门，wave1 合并后实测）

| 门 | 结果 |
| --- | --- |
| 后端 pytest | `2377 passed, 2 skipped, 28 deselected` |
| 后端 ruff（全量） | `All checks passed!` |
| `python -c "import app.main"` | OK |
| 前端 test | `677 passed (42 files)` |
| 前端 lint / build | 0 errors / OK（预存 chunk-size warning 除外） |

## 5. 遗留与后续

- A2/A3/A4/A6/A7/C7 见 §3（设计级，独立任务）。
- 4a 遗留：`list_artifacts` 暴露 role 并迁移消费方；`cancelled_at_stage` 在 fixture 路径可确定时填充。
- 4b 遗留：前端 store artifact 归属元数据（§3 C7 依赖）。
- 4c 遗留：`corrections_todo.csv` 不进 publication（Phase 7 manifest-driven 前端）。
