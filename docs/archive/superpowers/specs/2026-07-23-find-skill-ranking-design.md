# `find_skill` 确定性检索改进设计

## 背景

当前 `find_skill` 将完整的 `text` 参数作为一个连续子串，在 Skill 名称、展示名、
描述、数据源和 operation 名称拼成的文本中匹配。该行为导致自然语言多词查询
（如 `gene expression search`）、中英文混合查询以及中文意图无法命中已经存在
的 Skill。`source` 过滤还区分大小写，因此 `GEO` 无法匹配 `geo`。

本次改进需要提高现有目录的发现率，同时保持工具契约、数据库 allowlist 和运行时
成本稳定。未来可以接入快速 LLM Agent 或 Embedding 检索，但不在本次实现中调用
模型。

## 目标

- 多词自然语言查询不再依赖整句连续出现。
- 常见中文生物医学意图可以匹配英文 Skill 元数据。
- Skill 名称、数据源和 operation 等强信号优先于描述中的弱信号。
- `source` 过滤大小写不敏感。
- 保持 `find_skill` 的参数和返回 JSON 结构向后兼容。
- 提供受约束的检索策略注入点，供未来 LLM/Embedding 实现复用。

## 非目标

- 本次不创建或调用 LLM 子 Agent。
- 本次不生成 Embedding，不新增向量数据库或网络依赖。
- 不改变 Skill manifest、catalog snapshot 或 `invoke_skill` 契约。
- 不允许检索策略绕过 enabled、allowlist、category 或 source 过滤。

## 架构

新增独立的 Skill 搜索模块，包含：

1. `SkillSearchStrategy`：描述搜索策略的 `Protocol`。它接收已经完成硬过滤的
   `SkillDescriptor` 序列和查询文本，返回按相关度排序的描述符序列。
2. `LexicalSkillSearchStrategy`：默认的无状态确定性实现，负责归一化、分词、
   中英文意图扩展、评分和稳定排序。

`build_skill_gateway` 接受可选的 `search_strategy` 参数；未传入时构造默认词法
策略。Gateway 仍然拥有所有安全和业务过滤，策略只对候选集进行文本检索与排序。

未来的 LLM/Embedding 策略必须实现同一协议，并且只能看到 Gateway 过滤后的候选
集。这样模型策略即使返回异常或不相关结果，也不能发现被禁用或 allowlist 外的
Skill。

## 数据流

`find_skill` 按以下顺序处理请求：

1. 从一个 catalog snapshot 读取一致的 Skill 目录。
2. 排除 disabled 和当前 `RunContext` 不允许的 Skill。
3. 应用 `category` 精确过滤。
4. 对 `source` 和 `supported_sources` 做 Unicode 归一化及大小写不敏感的精确
   过滤。
5. 将剩余候选和 `text` 交给 `SkillSearchStrategy`。
6. 按策略返回顺序序列化原有 manifest，保持响应结构不变。

空 `text` 不执行相关度过滤，保留候选目录的原有稳定顺序。策略不得改变候选对象，
只负责选择和排序。

## 默认词法策略

### 归一化与分词

- 使用 Unicode NFKC 归一化和 `casefold()`。
- 将下划线、连字符和其他非字母数字字符视为分隔符。
- 英文按字母数字 token 匹配。
- 中文查询通过一个小型、代码内置且可测试的领域意图表扩展为目录中的英文术语。
  初始覆盖当前 Skill 明确支持的高频意图：文献、基因表达、差异表达、蛋白结构、
  通路、化合物、图表、PDF/表格和统计分析。
- 当查询只包含检索动词或 Skill 泛称（如 `find`、`search`、`download`、
  `查找`、`搜索`、`检索`、`技能`）时，将其视为空查询并保留目录顺序。
  当动作词与有效能力词同时出现时，动作词可参与 operation 评分，但候选必须至少
  命中一个非动作语义词，避免仅因都支持 `search` 而返回无关 Skill。

意图表只做确定性查询扩展，不修改 Skill manifest，也不尝试通用机器翻译。

### 评分

每个查询 token 在不同字段中命中时使用固定权重：

1. Skill `name`、`display_name`、`supported_sources`：最高权重。
2. operation 名称：中等权重。
3. description：基础权重。

完整归一化查询与名称或数据源相等时获得额外加分。候选至少命中一个有效 token
才会保留；命中 token 越多，分数越高。最终按总分降序、原 catalog 顺序升序排列，
确保同分结果可重复。

本次不实现编辑距离或模糊拼写纠错，避免小目录中出现难以解释的误命中。

## 工具提示

扩充 `find_skill` docstring 和主 Agent 的动态 Skill 发现说明：

- `source` 已知时优先传 `source`，其过滤比自由文本更精确。
- `text` 可传简短自然语言能力描述，无需猜测完整 Skill 名称。
- 返回空结果时应缩短查询、移除具体研究实体，或改用 category/source，而不是
  重复同一查询。

## 错误与兼容性

- `find_skill` 的输入参数保持 `text`、`category`、`source` 不变。
- 响应继续只包含 `status`、`generation` 和 `skills`；不暴露内部 score，避免
  建立新的公共契约。
- 自定义策略若抛出异常，异常按现有 Function Tool 执行路径传播；本次不吞掉编程
  错误，也不静默回退到全目录。
- Gateway 的 allowlist 和 enabled 判断行为保持不变。

## 测试策略

先写失败回归测试并确认 RED，再实现最小代码：

- 多词乱序/非连续查询可命中相应 Skill。
- 常见中文意图可命中英文元数据 Skill。
- `source="GEO"` 与 `source="geo"` 行为一致。
- 名称或数据源强命中的排序高于仅描述命中。
- 同分结果维持 catalog 顺序。
- 空 `text` 保持现有列举行为。
- category、enabled 和 RunContext allowlist 在策略执行前生效。
- 注入的测试策略只收到硬过滤后的候选集。
- 现有 `invoke_skill` 测试全部保持通过。

验证包括聚焦 pytest、完整后端 pytest、Ruff、Python 编译检查，以及仓库要求的
Uvicorn 启动 smoke test。此次无前端变更，不运行前端质量门。

## 文档与交付

实现完成后更新 `docs/ISSUES.md` 最后一条，记录复现、根因、确定性排序修复和未来
策略接入点。该问题在完整质量门通过后标记为已解决。
