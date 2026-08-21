# WP-F：声明式 Family Registry 与 Family Host

## 1. 目的

将当前编译期静态 `DatasetFamilyRegistry` 演进为可加载、可验证、可版本化的 Family Host，同时保留当前静态 Registry 兼容路径和 Core admission。

## 2. 前置条件

不得把 Family Host 作为当前 Gold closure 的先决条件。启动 L2/L3 前必须有：

- 至少一个表达清晰的 versioned FamilySpec/projection contract；
- 至少一个 streaming/disk-backed generic primitive；
- 至少两个真实消费者证明同一 primitive 不是单 case 特例；
- runtime extension trust、resource limit、receipt/provenance 和 rollback 语义；
- 旧 family/manifest/publication compatibility fixtures。

## 3. Package 形态

首选纯声明式 package：

```text
families/<family-id>/<version>/
  family.json
  schemas/*.schema.json
  relations.json
  capabilities.json
  integration.json
  validation.json
  README.md
  runtime.json       # 仅引用已注册 extension，不包含代码
```

`family.json` 至少包含：family id/version、schema refs、projection/table roles、granularity、source capabilities、adapter refs、relation refs、integration policy refs、validation/assessment refs、runtime requirement、extension refs、scope。

## 4. Scope 与版本

```text
builtin > curated > user > task
```

- builtin：随程序发布，仓库维护；
- curated：维护者审核安装；
- user：用户持久保存；
- task：默认由 Agent 创建，仅当前 task 生效。

同 scope+id+version 不得静默覆盖；语义变化 bump version；历史 Publication 保留解析所需的 package/schema version 和 digest。

## 5. Loader / Validator / Resolver

### F1：Package loader

只允许从配置的 package roots 加载；canonical containment、文件 hash、大小/数量/嵌套深度限制；不执行 package 中任意代码。

### F2：FamilySpec parser

复用严格 contract parser，拒绝未知字段、未知 schema、重复 ID、错误 family ownership、错误 relation、未注册 adapter/profile、未授权 extension、无效 primary key、缺 runtime capability。

### F3：Capability index

建立 source -> adapter -> schema/projection -> status/version/digest 的索引。把 `declared`、`fixture_verified`、`trusted_e2e_verified`、`production_activated` 分开。

### F4：Capability resolver

输入任务需求和 allowed scope，输出 Core 可执行的 resolved capability set。它必须检查：requested schema subset、source capability、compatibility partition、required/optional/allow-empty、resource estimate、extension trust、activation status。

### F5：Registry migration

先将现有 builtin family 转换为 loader 可读的等价 package，保留 `createDefaultDatasetFamilyRegistry()` 作为 compatibility facade；所有旧 tests 通过后，再移除散落的 `PRODUCTION_RUNTIME_BY_FAMILY` 依赖。

## 6. Runtime Extension

允许 package 引用已安装的 fixed extension，不允许 package 携带 arbitrary TS/JS/Shell。Extension 必须有稳定 ID/version、implementation digest、input/output contract、resource/network/permission boundary、deterministic replay 和显式 trust/install approval。

Task Family 默认只能使用 declarative generic runtime；缺少 trusted extension 时 fail closed，不能由 Agent 动态上传代码补齐。

## 7. 并行与依赖

- F1/F2 可用 generic fixture 独立开发，但不能接 production default Registry。
- F3 依赖 A 的 projection/schema capability 定义和 D 的 capability status。
- F4 依赖 B/C/E 的 execution/validation policy；不能只由 Agent tool schema 推导。
- F5 必须等待现有 family compatibility matrix 完成。
- G（Agent interface）依赖 F2/F4 的 stable parser/resolver。

## 8. 验收

- 新增纯声明式 task Family 不修改 Dataset Core 业务源码即可 parse/validate/register（仅在 task scope）；
- 不能通过 package 逃逸 path、执行代码、读取未注册 workspace 或直接发布；
- builtin/curated/user/task scope 冲突和版本解析 deterministic；
- loader failure、unknown capability、untrusted extension、resource overflow 均 fail closed；
- 旧静态 family tests、legacy manifest parser、历史 publication reader 和 rollback path 通过。
