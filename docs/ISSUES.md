# 问题/issue 收集文档

- [X] (260721-60880a41a8f68cba552c9c513d4d84ee407902c8) 正常启动前后端后输入 prompt，前端直接显示“任务执行失败”，控制台和前端均未显示具体原因。

  - 状态：已解决（2026-07-21）。
  - 根因：动态 instructions callable 只有 `(context)` 一个参数，不符合 OpenAI Agents SDK 0.18.2 要求的 `(context, agent)` 契约，首轮模型调用前即失败。
  - 修复：补齐二参数签名，并由 `tests/test_agent.py::test_dynamic_instructions_resolve_through_sdk` 通过 SDK 公共解析边界提供回归保护。详细诊断见 `docs/ARCHITECTURE.md` §8.5。
- [ ] (260721)设置界面skill选项卡下无法正常调整skill（主要包括 用户skill的引入、已引入skills的启停）

- 注：数据库这个界面我不懂，我就只提skill这里的（意为设置界面问题可能并不全面
- 状态：未解决

- [X] (260721)完成模型设置后，主页面工作区模型选择存在问题。

- 状态：已解决
- 具体说明：问题在于只要配置apikey后就会显示Qwen系列的四个模型，即使你接入ds的模型。进一步说明这里的没有发挥任何配置作用
- 修改意见：建议保留最初设计，让这里同步为设置界面的model list，如果考虑到qwen主体地位，建议在检索到qwen模型时优先展示，并将最强基座模型标注为推荐模型
- **原因** ：`App.tsx` 从未把 settings 里配置的模型数据传给 `ChatPanel` → `AgentComposer.tsx` 收不到 `models` prop 就走进了回退分支，永远显示硬编码的四个 Qwen 模型，不管用户配了什么 API Key 或换了什么供应商。
- **修复** ：在 `App.tsx` 里：

1. 启动时调 `api.fetchSettings()` 拿到 `base_url`、`model_name`、`api_key_configured`
2. 如果有 API Key，再调 `api.fetchModels({ baseUrl })` 从后端发现实际可用的模型列表（Qwen / DeepSeek / OpenAI 按配置返回）
3. 把 `models`、`hasApiKey`、`selectedModelId`、`onModelChange` 逐层传到 `AgentComposer`
4. 设置面板关闭时自动重新拉取，保持同步
5. 用户在下拉菜单选模型时，`onModelChange` 回调会调 `api.saveSettings({ model_name })` 持久化

> NOTE by modenc：这地方应该是哪次 merge 把不该 merge 的 合进去了。 我们称之为 merge drift.

- [X] (260721)主页面工作区附件上传

- 状态：已解决
- 具体说明：文件上传文字应该是“上传文件（从本地缓存）”吧，原文为“上传文件到本地缓存”，同时文件上传功能未实现
-  **原因** ：

1. `DropdownMenu` 用的是 `@base-ui/react/menu`，不是 Radix UI。`MenuPrimitive.Item` 不识别 `onSelect`，回调被静默丢弃，点击"上传文件"无反应。
1. 任务进行中的延续 composer 缺少 `onSubmitFiles`／`onAttachmentError`／`importPending`，上传按钮一直 disabled。
1. 文件选择器未做类型过滤，默认 `*.*`
1. 图片与文件共享同一输入框，后续难以单独接入 VL 模型。

*  **修复** ：

1. `AgentComposer.tsx` 中 `onSelect` → `onClick`，使 Base UI DropdownMenuItem 回调正常触发
2. `ChatPanel.tsx` 延续 composer 补上 `onSubmitFiles={...}`、`onAttachmentError={setDraftError}`、`pending={continuationPending || importPending}`
3. 文件输入框加上 `accept=".pdf,.xlsx,.xls,.csv,.tsv,.json,.xml,.txt,.pdb,.zip,.md"`，屏蔽 `*.*`
4. 独立图片输入框（`accept="image/*"` + `imageInputRef`），"上传图片"菜单项从 `disabled` 改为激活，与文件上传解耦

- [ ] （260721）模型设置界面模型上下文窗口显示错误

- 状态：未解决
- 具体说明：所有模型显示的模型上下文窗口固定为0，失去其存在价值，考虑到后续上下文管理，考虑是否保留更正

- [ ] （260721）主页面模型记录部分问题逻辑

- 状态：未解决
- 具体说明：模型记录部分会将对话左侧标注为红色问题对话标识，但判断逻辑存在一定不合理：未生成产物并不代表模型为完成工作，具体讲：当给出一个综述性问题时（“请你帮我研究一下有哪些蛋白可能诱发糖尿病，数据库没有偏好“）模型判断无需给出结构化产物，此时对话仍被标注为红色

- [ ] （260721）*不确定问题*：对话在进行时窗口显示不稳定

- 状态：待验证
- 具体说明：在模型进行思考工作时，如果窗口未跟随最新进度，可能会跳转到最初对话条目，具体触发条件未查明

- [ ] （260721）*不确定问题*：按键响应

- 状态：待验证
- 具体说明：在点击界面深浅风格按键时，可能会出现一次点击两次判定（？）或未判定问题。其他按键也存在同样问题。更详细的，一般突然的点击速度提升或者突然的点击可能触发

- [ ] (260722)**优化**：主界面工作区右上角三个ui建议添加tooltip显示按键说明

- 状态：未优化

- [X] (260723)**优化**：后端 `find_skill` 查找效率低下，经常找不到对应 Skill。
  - 状态：已解决（2026-07-23）。
  - 根因：旧实现把完整 `text` 当作一个连续子串匹配，且 `source` 区分大小写；
    自然多词、中文意图和 `GEO` 等大小写变体因此返回空目录。
  - 修复：新增确定性 `SkillSearchStrategy`，默认实现执行 NFKC/大小写归一化、
    中英文领域意图扩展、字段加权评分和稳定排序；Gateway 在策略运行前保留
    enabled、数据库 allowlist、category 和 source 硬过滤。
  - 扩展：未来可注入快速 LLM/Embedding 策略，但本次不调用模型、不新增网络依赖。

---

## 2026-08-03 Agent 工具调用受阻根因分析

> 来源：task_df9e953d（"下载清洗 METTL5 在胰腺癌的差异表达"，2026-08-03 12:32
> 启动，1.5 分钟后 failed，260 事件）。Agent 4 次 pipeline 调用失败、2 个工具
> 完全不可用、GEO suppl 下载 5 次全空。下述 1-3 已修复，4-7 待处理。

- [X] (260803) `run_research_pipeline` 的 `databases` 参数被 Qwen 序列化为 JSON 字符串导致 4 次重试全失败。
  - 状态：已修复（2026-08-03）。
  - 根因：Qwen 把 list 参数序列化成 str（`'["geo","pubmed"]'`），SDK
    strict_schema 在调用函数前就用 Pydantic 校验，`databases: list[str]`
    不接受 str，报 `list_type` 错误。函数体内的 `isinstance` 修复根本
    没有机会执行。
  - 修复：① `tool.py` L205 参数类型改为 `list[str] | str | None`（strict_schema
    支持 anyOf，见 `agents/strict_schema.py` L82-88），让 SDK 接受 str；
    ② L218-232 函数体内 `isinstance(databases, str)` 时 `json.loads` 解析，
    解析失败返回 `invalid_input`。回归测试：
    `test_pipeline_function_tool_accepts_json_string_databases`。

- [X] (260803) `databases=null` 时 Pipeline 因 preferred_sources 含 PDB/PubChem 被整体拒绝。
  - 状态：已修复（2026-08-03）。
  - 根因：`tool.py` 原 L218-219 `databases = list(preferred_sources)` 直接
    采用用户 UI 勾选的所有数据库；L260-269 把 RESEARCH_ONLY（PDB/PubChem）
    加入 `rejected` 后**直接拒绝整个调用**（`unsupported_databases`,
    `retryable: false`），而非过滤掉 RESEARCH_ONLY 继续。Agent 被迫传 null，
    却又触发此路径，陷入死锁。
  - 修复：回退到 preferred_sources 时静默过滤掉非 PIPELINE_SUPPORTED
    数据库；仅当过滤后为空才返回 `invalid_input`。Agent 显式传 RESEARCH_ONLY
    时仍走原拒绝逻辑（保留 capability 告知）。

- [X] (260803) `review_query_strategy` / `compress_query_log` 因 instructions callable 签名错误完全不可用。
  - 状态：已修复（2026-08-03）。
  - 根因：OpenAI Agents SDK 0.18.2 `Agent.get_system_prompt`
    （`agents/agent.py` L947）强制 instructions callable 接受 `(context, agent)`
    二参数；`backend/app/agent_loop/reviewer.py` L22 与
    `summarizer.py` L25 的 `_xxx_instructions(ctx)` 仅接受 1 参数，调用即抛
    `TypeError: 'instructions' callable must accept exactly 2 arguments`。
    这是 260721 同类 bug 的回归——当时只修了 `test_agent.py` 的动态
    instructions，漏了这两个 as_tool 子 Agent。
  - 修复：两个函数签名改为 `async def _xxx_instructions(ctx, agent)`，
    `agent` 参数未使用但必须存在以满足契约。47 个相关测试通过。

- [X] (260803) `download_geo` 的 `filename` 参数虽是 `Optional[str]=None`，invoke_skill 网关仍报 `'filename' is a required property`。
  - 状态：已修复（2026-08-03）。
  - 根因：`backend/app/skills/gateway.py` L208-212 的 defaulted 检测只看
    schema properties 的 `default` 键；但 Pydantic 对 `Optional[X] = None`
    **不写 `default` 字段**（`download_geo` 的 filename schema 仅有
    `anyOf: [{string}, {null}]`，无 default）。导致 gateway 修复失效，
    filename 仍被标 required。Agent 必须瞎猜 filename。
  - 修复：gateway 新增 `_is_nullable_union` 辅助函数，检测 `anyOf`/`oneOf`
    含 `{"type":"null"}` 分支的字段，视为可选并从 required 列表移除。
    覆盖所有 `Optional[X]=None` 参数（filename、expected_size 等）。

- [X] (260803) `describe_geo` 无法列举 supplementary 文件，Agent 只能瞎猜 filename。
  - 状态：已修复（2026-08-03）。
  - 根因：`backend/app/skills/builtin/acquisition/geo.py` L336 `describe_geo`
    只接受 `accession`，不返回 suppl 文件列表；其 `note` 字段误导 Agent
    "用 download_geo(file_type='suppl') 列举"，但 `download_geo` 只能下载
    不能列举（`_resolve_download` L216-217 多候选时抛 "multiple files found"，
    L215 无候选时抛 "no matching file found"）。Agent 调
    `describe_geo(include_supplementary_files=true)` 又因 schema 不接受
    附加属性被拒。
  - 修复：新增 `list_geo_supplementary_files(accession)` function_tool，HTTP GET
    GEO FTP suppl/ 目录列表并返回 filename/url/media_type/data_level 清单。
    geo_skill 升级到 0.3.0，instructions 指导 Agent "suppl 下载前先调
    list_geo_supplementary_files 获取确切 filename"。

- [X] (260803) GEO 老数据集（GSE28735/GSE15471）supplementary 表达矩阵下载全空。
  - 状态：已修复（2026-08-03，配合问题 5）。
  - 根因：① Agent 把 matrix 文件名（`GSE28735_series_matrix.txt.gz`）误传给
    `file_type=suppl`（语义错误，suppl 目录下无此文件）；② 这两个老数据集
    可能确实未上传标准 suppl 表达矩阵文件，仅 RAW.tar 或无 suppl。即使
    Agent 正确传 `file_type=matrix`，series_matrix.txt.gz 的表达值当前
    也无法被 processing 解析（`_build_minimal_parsed_dataset` 仅提取样本 ID）。
  - 修复：① 新增 `list_geo_supplementary_files` 工具（见上一条）避免瞎猜；
    ② `_resolve_download` 在 filename 不匹配或无候选时，错误消息中返回
    `available files: [...]` 候选列表，帮助 Agent 自纠正而非重复试错；
    ③ series matrix 表达值解析器（`docs/RESEARCH_SYSTEM_REVIEW_2026-08-03.md`
    §9.1）由工作区未提交的 geo_tximport.py 提供。

- [X] (260803) `search_geo` 参数名 `term` 与 `search_pubmed` 的 `query` 不一致，Agent 首次调用猜错。
  - 状态：已修复（2026-08-03）。
  - 根因：`geo.py` L323 `search_geo(term, ...)` 用 `term`，但
    `search_pubmed` 用 `query`；Agent 直觉用 `query` 调 search_geo，报
    `'term' is a required property`，浪费一轮工具调用。
  - 修复：search_geo 参数改为 `query: str = "", term: str = ""`，函数内
    `effective_term = query or term`，两者任一非空即可。description 标注
    `query` 为推荐参数名，`term` 为 legacy alias。

- [ ] (260803) RNA-seq 数据集 series_matrix 表达块为空时，pipeline 未下载 suppl 表达矩阵文件。
  - 状态：未解决（API 任务流验证发现）。
  - 根因：现代 GEO RNA-seq 数据集（如 GSE174503）的 `*_series_matrix.txt.gz`
    表达块常为空（只有 header），真实表达数据在 supplementary 文件中
    （如 `GSE174503_*_counts.csv.gz` / `*_TPM.txt.gz`）。
    `process_geo_series_matrix_expression` 正确检测空块并返回 None，
    fallback 到 `_build_minimal_parsed_dataset`（仅 sample_metadata 行），
    导致 `core_data_existence` 检查失败（expression_value 0/5 non-empty）。
    Agent 随后尝试 `download_geo(file_type="series_matrix")` 但 file_type
    只支持 matrix/soft/suppl，不支持 series_matrix（语义上 matrix 已覆盖）。
  - 影响：所有 series_matrix 表达块为空的 RNA-seq 数据集都无法通过 validation。
  - 修复建议（pipeline 增强，非 series matrix 解析器问题）：
    ① processing 阶段检测到 series_matrix 表达块为空时，调用
    `list_geo_supplementary_files` 枚举 suppl 文件，启发式选取 counts/TPM
    表达矩阵文件并下载解析；或 ② Agent prompt 指导其在 series_matrix
    表达块为空时改用 suppl 文件路径。
