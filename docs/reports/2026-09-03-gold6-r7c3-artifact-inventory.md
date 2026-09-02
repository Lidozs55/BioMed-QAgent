# Gold6 R7c3 正式产物与证据清单

**清单日期：2026-09-03**  
**运行日期：2026-09-02**  
**对应实验报告：** [Gold6 修复与正式重跑实验报告](2026-09-03-gold6-repair-experiment-report.md)

## 1. 清单范围与校验方法

本清单只描述 Gold6 R7c3 的最终正式 Publication 和 Supervisor 证据，不把 provisional、
workspace、quarantine、被 supersede 的中间 Publication 或 `ua_*` 文件计作最终产物。

- Task：`task_ts_cc589f9a-271b-4ea2-85a6-470c1c50a822`
- Run：`run_ts_4ca4e52a-d921-4c04-807d-67c1ad5c4952`
- Publication：`pub_egfr_mutant_inhibition_literature_chart_6cc6bc09c71ca8c5`
- Product commit：`ae271a790b0ace726d6e80f976a4c5df996d2ec9`
- Publication time：2026-09-02 15:26:11.509Z
- Manifest file SHA-256：
  `69d9795817293036610e94626cf61b7b5bffb4e7382710b07f08489ae2d7fb35`
- Package digest：
  `6cc6bc09c71ca8c56eb7b525bad1367bc703ee8bfb4257adaca4098896b8988e`

校验方法：

1. 从 `closure.json`/`artifacts.jsonl` 读取 manifest 声明的 expected size/SHA-256；
2. 对 Supervisor 下载到 `artifacts/` 的 bytes 再算实际 `stat` size 和 SHA-256；
3. 对 runtime 中最终 Publication 同名文件再次计算 size/SHA-256；
4. CSV 数据量通过 Python `csv.reader` 解析，数据记录数不含 header；
5. JSON 的“数据量”按其语义对象计数，不以文本行数代替。

上述三处字节一致；9 个 manifest artifacts 与单独下载的 dataset manifest 均
`file_digest_match=true`。

## 2. 最终 Publication 数据表

| 文件 | Artifact ID | 角色 | 列数 | 记录数 | 大小（bytes） | SHA-256 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `tables/activity_value_records.csv` | `artifact_fb205d5df75181afe654e7070d415fb1` | primary dataset | 13 | **138** | **98,008** | `0c41a401855da8f308eb5f7ce5ee9db2fe75779a142bdb23591f7ff2226e4b15` |
| `tables/paper_records.csv` | `artifact_fe4f949fbd27a1c779999c25c43b4e9b` | supporting dataset | 7 | **3** | 999 | `98959fb476e5feb70f42e8170004b6d07cc285633226b31f65833c786446506a` |
| `tables/experiment_records.csv` | `artifact_408562f9ac17c793cdea466938d07d36` | supporting dataset | 10 | **9** | 9,257 | `9739062943e88d25b7ca6a27fab8f2e89eac76747fbee4cf57565c1c7fd45f30` |
| `tables/chart_series.csv` | `artifact_765399b76cb35a89a84af074cb9b1288` | supporting dataset | 21 | **0** | 351 | `71b4fdb28c073ecff668323b70d86f9691850846da96bcc8be9c0cb44d9c01ed` |
| `tables/chart_points.csv` | `artifact_022c019e3e45095577e405e1725a33a9` | supporting dataset | 15 | **0** | 265 | `1f24e78130f4deb8af1aeadf408628aacc9703711179af624acd68fd7511fb49` |
| `tables/supplementary_asset_records.csv` | `artifact_dc8b6f7601e2c3361719bc9ea6358f3e` | supporting dataset | 13 | **0** | 231 | `76bf42632a75989ee78214649799778c57a6f18404c0b07d9a93efb5193da095` |

### 2.1 CSV 记录解释

- `paper_records`：3 篇，首尾主键为 PMC10408569、PMC5094958；三篇冻结论文均在
  Publication 中有 paper row。
- `experiment_records`：9 个实验。
- `activity_value_records`：138 条；PMC10408569 42 条、PMC5355725 96 条、PMC5094958
  0 条。
- 138 条 activity 的 `extraction_method` 全部是
  `article_table_deterministic_parse_v1`，`confidence` 全为 `high`，`review_status` 全为
  `not_required`；当前 family wire 中 `raw_relation` 全为 `IC50`，`raw_unit` 全为 µM；使用
  2 个唯一 source asset。
- `chart_series`、`chart_points`、`supplementary_asset_records` 均为一个 header record、
  0 个 data record。它们不是文件缺失，也不是“负一行”；对无末尾换行的 header-only CSV
  使用 `wc -l - 1` 会得到错误的 `-1`，因此本清单使用 CSV parser。

### 2.2 精确值示例

| Paper | Experiment/target | Raw value | `raw_relation` / `raw_unit` | 方法 |
| --- | --- | --- | --- | --- |
| PMC10408569 | EGFR WT | `0.358 ± 0.16` | IC50 / µM | deterministic XML table parse |
| PMC10408569 | EGFR T790M | `0.61 ± 0.005` | IC50 / µM | deterministic XML table parse |

这些值具有 source asset 和 table/row/column locator；没有从图像坐标估读。

## 3. 最终 Publication 元数据文件

| 文件 | Artifact ID/性质 | 数据量 | 大小（bytes） | SHA-256 |
| --- | --- | --- | ---: | --- |
| `schema.json` | `artifact_2d3952a924ec6ccfaa32895a6e263986` / schema | 6 个 table schema | 33,904 | `94e89dcd57bb0a365845a7675cb6c028e2fae11aa60b11f133ce7a1247cbcf9f` |
| `provenance.json` | `artifact_cb961c4d218eab10d3fa8ecaa01d1d3a` / provenance | 8 registered assets；8 sources；8 Core acquisition facts；8 Core input facts；3 input receipts；1 OperationResult manifest ID；1 HIL acceptance object | 22,873 | `c1337a375f1f7aa7e18315ff1ef9b951b3f3e0858db66fba4b49d7341dfed6b2` |
| `product_assessment.json` | `artifact_d4e5198c56e3bc405849c66052b83019` / audit report | 6 个评分维度；1 条 human-review evidence；0 missing；0 blockers | 1,386 | `688174a22e6ae7cc4ad017643490e24eb2c87680b76da106d489f3165dc4ca42` |
| `dataset_manifest.json` | manifest（Supervisor 中保存为 `artifacts/dataset_manifest`） | 9 artifacts；6 tables；6 relations；8 sources；primary row_count=138；94 validation checks/0 failed | 14,277 | `69d9795817293036610e94626cf61b7b5bffb4e7382710b07f08489ae2d7fb35` |
| `validation_report.json` | Publication 内部校验报告，不在 9-artifact manifest 清单中 | **94 checks，94 passed，0 failed** | 21,796 | `7a15a216d2327172044e89382dbc7efa872deb5da51c188b98879a9a239b7af9` |
| `publication.json` | Publication envelope，不在 9-artifact manifest 清单中 | 1 publication；指向 manifest/validation；supersedes `pub_…dcfa877512781064` | 447 | `fd8bd261ebfdd3e163b464beb4b1436d9b3250f8bb8d548a48dfbe79bccd961d` |

### 3.1 ProductAssessment 量化结果

| 维度 | 满足/要求 | Score |
| --- | ---: | ---: |
| schema | 6/6 | 1 |
| relations | 6/6 | 1 |
| identifiers | 0/0 | 1 |
| provenance | 8/8 | 1 |
| confidence | 1/1 | 1 |
| reproducibility | 1/1 | 1 |

`product_status=publishable`，`missing_requirements=[]`，`blockers=[]`。

### 3.2 Manifest 与 provenance 口径

- Manifest `row_count=138` 是 primary table `activity_value_records` 的行数，不是所有表的
  总和。
- Provenance coverage：traced 138、untraced 0、coverage ratio 1。
- Manifest 内 6 张表仍完整存在；optional/allow-empty 仅允许对应 CSV 无数据记录，不删除
  schema、relation 或 artifact。
- Manifest 的 9 artifact 大小总和：**167,274 bytes**（163.35 KiB）。
- 9 artifacts + dataset manifest：**181,551 bytes**（177.30 KiB）。
- Publication 目录 12 个文件总和：**203,794 bytes**（199.02 KiB）。

## 4. Supervisor 证据包逐文件清单

证据包在实验机器上的相对位置为
`data/gold/evidence/gold6-r7c3-standard/`。该目录为 runtime evidence，不属于 frozen Gold
input；本报告写作时仍位于易失 `/tmp` worktree，必须另行做耐久归档。

### 4.1 证据控制文件

| 文件 | 数据量/用途 | 大小（bytes） | SHA-256 |
| --- | --- | ---: | --- |
| `closure.json` | 1 个 terminal closure；含 Publication detail、10 个 digest checks、run usage | 26,404 | `d03d32640333a421899ddad8b0e3c8ed0cca545755222c5fa7a66405d91845fc` |
| `events.jsonl` | **19,884 durable events** | **7,829,057** | `30e977c8bffdc7067963ef4f1353ff8dd351bef35f9178f8958108f404217aa0` |
| `artifacts.jsonl` | 10 条重哈希记录：9 artifacts + dataset manifest | 3,596 | `8911e77dcc1ead2269b703a8c8d8efd30042ac7b6e14ee6d8996541b757b17c2` |
| `human-review.jsonl` | 5 条 HIL 决策（1 permission + 4 publication acceptance） | 1,244 | `63b0f8cf6065256a571d9395f4e33e078698bf971f30f401af283d94113d33a5` |
| `human-review.jsonl.lock` | 空 lock 文件 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `HIL-STOP.json` | Supervisor 最近一次 HIL stop 快照；不是未解决 HIL | 9,937 | `15c77ab5b17ff94f6a8d97feef8f75bd266b135ee03d52f92333b2b2083e57b2` |
| `supervisor-events.jsonl` | 5 条 supervisor-level journal 记录 | 29,375 | `afad2c6a35c88c53b2f0389675c29b3bfaf95103f5b8e320a26cb82d1e705bc4` |
| `supervisor-state.json` | 最终 cursor/task/run/stop 状态 | 401 | `cb5462e207a82ed607a446a2f41f88c607984642c23ef331a027c95326844f48` |
| `R7C3-RESULT.json` | 人工整理的轮次摘要；辅助说明，非 formal Publication authority | 3,383 | `4c5468b7bfe84a7d8d9efc01cfb40928f32d0806e0ffa8629564af5c9fec101f` |

### 4.2 Supervisor 下载的正式 artifact bytes

| 文件 | 对应正式文件 | 大小（bytes） | SHA-256 | Match |
| --- | --- | ---: | --- | --- |
| `artifacts/artifact_fb205d5df75181afe654e7070d415fb1` | `activity_value_records.csv` | 98,008 | `0c41a401855da8f308eb5f7ce5ee9db2fe75779a142bdb23591f7ff2226e4b15` | true |
| `artifacts/artifact_fe4f949fbd27a1c779999c25c43b4e9b` | `paper_records.csv` | 999 | `98959fb476e5feb70f42e8170004b6d07cc285633226b31f65833c786446506a` | true |
| `artifacts/artifact_408562f9ac17c793cdea466938d07d36` | `experiment_records.csv` | 9,257 | `9739062943e88d25b7ca6a27fab8f2e89eac76747fbee4cf57565c1c7fd45f30` | true |
| `artifacts/artifact_765399b76cb35a89a84af074cb9b1288` | `chart_series.csv` | 351 | `71b4fdb28c073ecff668323b70d86f9691850846da96bcc8be9c0cb44d9c01ed` | true |
| `artifacts/artifact_022c019e3e45095577e405e1725a33a9` | `chart_points.csv` | 265 | `1f24e78130f4deb8af1aeadf408628aacc9703711179af624acd68fd7511fb49` | true |
| `artifacts/artifact_dc8b6f7601e2c3361719bc9ea6358f3e` | `supplementary_asset_records.csv` | 231 | `76bf42632a75989ee78214649799778c57a6f18404c0b07d9a93efb5193da095` | true |
| `artifacts/artifact_2d3952a924ec6ccfaa32895a6e263986` | `schema.json` | 33,904 | `94e89dcd57bb0a365845a7675cb6c028e2fae11aa60b11f133ce7a1247cbcf9f` | true |
| `artifacts/artifact_cb961c4d218eab10d3fa8ecaa01d1d3a` | `provenance.json` | 22,873 | `c1337a375f1f7aa7e18315ff1ef9b951b3f3e0858db66fba4b49d7341dfed6b2` | true |
| `artifacts/artifact_d4e5198c56e3bc405849c66052b83019` | `product_assessment.json` | 1,386 | `688174a22e6ae7cc4ad017643490e24eb2c87680b76da106d489f3165dc4ca42` | true |
| `artifacts/dataset_manifest` | `dataset_manifest.json` | 14,277 | `69d9795817293036610e94626cf61b7b5bffb4e7382710b07f08489ae2d7fb35` | true |

### 4.3 证据包容量

- 文件数：17。
- 逻辑文件字节总和：**8,084,948 bytes**（7,895.46 KiB；7.710 MiB）。
- 其中 `events.jsonl` 占 7,829,057 bytes（约 96.83%）。
- 该总和包含 artifact 下载副本，不能再与 Publication 目录相加后称为“唯一数据集大小”；
  两处保存的是同一正式 artifact bytes 的运行目录副本和监督归档副本。

## 5. Event 与 HIL 数据量

### 5.1 Event 类型统计

| Event type | 数量 |
| --- | ---: |
| `assistant_reasoning_delta` | 18,432 |
| `assistant_delta` | 1,096 |
| `context_usage` | 75 |
| `tool_started` | 74 |
| `tool_called` | 74 |
| `tool_completed` | 74 |
| `artifact_produced` | 36 |
| `user_input_required` | 5 |
| `user_input_resumed` | 5 |
| `publication_created` | 4 |
| `operation_started` | 2 |
| `operation_progress` | 2 |
| `operation_completed` | 1 |
| `task_created` / `run_queued` / `run_started` / `run_completed` | 各 1 |

合计 19,884，与 closure/event file 一致。

### 5.2 Tool 调用统计

| Tool | 调用数 |
| --- | ---: |
| `preview_core_asset` | 25 |
| `acquire_core_carrier` | 15 |
| `workspace_read` | 11 |
| `prepare_dynamic_family_publication` | 5 |
| `submit_dynamic_family_publication` | 4 |
| `scaffold_dataset_profile` | 3 |
| `workspace_list` | 3 |
| `get_research_data_guidance` | 2 |
| `read_dataset_core_source` | 2 |
| `inspect_dataset_execution_routes` | 1 |
| `activate_agent_tools` | 1 |
| `search_pubmed` | 1 |
| `extract_registered_paper_chart_evidence` | 1 |

总 tool call 数 74。

### 5.3 HIL 决策

| Request | Kind | Review type | Decision |
| --- | --- | --- | --- |
| `hil_8ed45009e6d66095a737b2f0ab291017` | permission | credential | `approve` |
| `hil_3c727dd097972d2c4c30fba8b40d66e0` | data_review | publication_acceptance | `{"action":"accept"}` |
| `hil_56725b56a23dba330f4c7eefd1201fd2` | data_review | publication_acceptance | `{"action":"accept"}` |
| `hil_72dd02a30240b61c182af0950736f08e` | data_review | publication_acceptance | `{"action":"accept"}` |
| `hil_f7b3e3a7ccb6f6f18ea1b54923a9be91` | data_review | publication_acceptance | `{"action":"accept"}` |

最后一条是最终 Publication 的 acceptance evidence。前 3 个被接受的 Publication 随后均被
新 Publication supersede；最终不可变链如下：

1. `pub_…9777739d1d92b066`（96 activity / 6 experiments）；
2. `pub_…bec4e5f258c5f39f`（96 / 6），supersedes #1；
3. `pub_…dcfa877512781064`（138 / 9），supersedes #2；
4. `pub_…6cc6bc09c71ca8c5`（138 / 9），supersedes #3，最终 current publication。

本清单只把 #4 的文件列作最终交付；#1—#3 用于解释同一 run 的不可变版本演进。

### 5.4 历史版本化 Gold6 证据包容量

仓库中仍保留 R1—R4 的版本化证据包；下表按递归普通文件的逻辑字节求和。R6、R7b、
R7c 的完整包原位于后续被重启清空的 `/tmp` worktree，只剩历史记录中的 closure 摘要，
因此不虚构其逐文件大小。

| 轮次目录 | 文件数 | 逻辑字节总和 | Events 文件 |
| --- | ---: | ---: | ---: |
| `data/gold-runs/38d1fe20ccb8-gold6-qwen38flash-r1/` | 36 | 1,035,598 | 983,025 bytes / 2,438 events |
| `data/gold-runs/e17409efb507-gold6-qwen38flash-r2/` | 32 | 3,577,846 | 3,552,131 bytes / 8,847 events |
| `data/gold-runs/e680d4232531-gold6-qwen38flash-r3-standard/` | 31 | 7,625,584 | 7,005,560 bytes / 17,497 events |
| `data/gold-runs/42984ecb1c43-gold6-qwen38flash-r4-standard/` | 170 | 8,870,858 | 4,302,551 bytes / 10,478 events |

这些包均为历史 `blocked_no_publication` 证据，不可与 R7c3 的正式 artifact 拼接成一个成功
run。R4 文件数较多是因为它额外保存了 quarantine、binding closure、source asset、permission
和 SHA inventory 等诊断材料。

## 6. 资源使用

| 指标 | 数量 |
| --- | ---: |
| Model calls | 75 |
| Input tokens | 653,471 |
| Output tokens | 163,999 |
| Cache-read tokens | 9,462,016 |
| Cache-write tokens | 0 |
| Reasoning tokens | 103,529 |
| **Total tokens** | **10,279,486** |
| Durable events | 19,884 |
| 墙钟 | 约 1 小时 13 分 29 秒 |

完整 task 目录逻辑文件字节和为 **52,486,987 bytes**。该数字包括输入 source assets、运行
state、候选/隔离 transform、4 代 Publication 等，不代表最终数据集大小。最终 Publication
自身应使用第 3.2 节的 **203,794 bytes**。

## 7. 完整性边界与待办

1. `chart_series`、`chart_points` 为 0，因此本产物不能作为视觉曲线坐标成功样例；它证明的
   是视觉管线受治理尝试后安全降级，以及精确表格数据可独立闭环。
2. `R7C3-RESULT.json` 是人工摘要，曾记录 2/8/137；本次直接解析正式 bytes 得到 3/9/138。
   本清单以正式 CSV、manifest `row_count=138`、coverage 138/138 为权威。
3. `HIL-STOP.json` 是最后一次 stop 的历史快照；closure 中 terminal 已成功，不能把该文件的
   存在误解为仍有 pending HIL。
4. 完整 evidence/runtime 在写作时仍位于 `/tmp`。需将 17 文件 evidence pack 与最终 12 文件
   Publication 复制到非易失归档，并生成包含相对路径的 `evidence-manifest.sha256`。
5. 如执行复制，必须保留原始 bytes；不得因格式化 JSON、标准化换行或重写 CSV 而改变这里
   记录的 SHA-256。
