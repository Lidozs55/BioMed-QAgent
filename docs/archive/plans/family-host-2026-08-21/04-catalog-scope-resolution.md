# Examples Catalog、Scope、Trust、Resolution 与 Shadow

## 1. Examples 是检索目录，不是 runtime package

目标目录：

```text
examples/families/
  gene-expression/
  literature-evidence/
  target-evidence/
  variant-evidence/
  protein-structure/
  bioactivity-measurement/
```

每个 example 可包含：

```text
README.md
family-spec.example.json
transform/
fixtures/
expected/
retrieval-metadata.json
```

`examples/` 不得被 Core import、启动时扫描、自动注册为 production capability，目录存在也不产生执行权限。Agent 使用 `search_family_examples` / `inspect_family_example` / `clone_family_example` 获取参考，不是把六族全部塞入 prompt。

## 2. 四个维度必须分开

### 2.1 Scope

建议 scope：

```text
example | task | user | curated | system
```

- `example`：只读检索；
- `task`：当前 task 临时 proposal；
- `user`：用户显式保存；
- `curated`：维护者审核的可复用目录；
- `system`：随产品发布的 Core policy/SDK capability，而非领域 Family 代码。

### 2.2 Trust / execution status

scope 不等于信任。Transform/Family 分开记录：

```text
submitted
sandbox_executable
fixture_verified
shadow_verified
trusted_e2e_verified
activated
revoked
retired
```

`curated` 不自动等于 `activated`；`task` 可以在 sandbox 中执行，但不因此得到 publication trust；`example` 永不直接执行。

### 2.3 Resolution

生产引用必须是：

```text
scope-qualified id + exact version + exact digest
```

未限定名称有多个候选时返回 ambiguity；不允许按 scope 排序自动选中。ID/version 相同而 digest 不同必须拒绝或要求显式新版本。

### 2.4 Shadow execution

Shadow 是并行比较，不是名称覆盖：

- 与 legacy runtime 使用相同冻结输入；
- 新 output 使用独立 quarantine/output root；
- 不修改 current publication，不进入 default answer；
- 比较 schema、rows、relations、provenance、assessment、resource 和 digest；
- 差异生成 audit evidence；
- 通过 trusted E2E + rollback rehearsal 后才可 activation。

## 3. Catalog API 计划

```text
search_family_examples
inspect_family_example
clone_family_example
create_family_spec
validate_family_spec
search_transforms
inspect_transform
submit_transform
validate_transform
run_transform_fixture
attach_transform
```

`promote_transform`、`save_user_family`、`activate_capability` 不属于 Batch 0–2 默认 API；它们必须有明确审核、撤销和兼容策略。

所有 API 返回 source/evidence refs、scope、version、digest、status 和是否可执行；不能只返回 `available: true`。

## 4. Reusable transform 与 trust

统一 ABI 不等于统一权限：

- built-in/server transform 可在受控 Core slot 中运行；
- example/task/user transform 先经过 Transform Host；
- promotion 影响复用、缓存或资源策略，不跳过 sandbox 和 Core validation；
- activated 只表示某个 exact capability 在某个 policy/version 下通过 trusted E2E，可撤销；
- transform 被 revoke 后，历史 Publication 仍可读，新的 invocation fail closed。

## 5. 检索 few-shot 规则

Agent 检索依据：数据形态、实体/关系、输入 media type、已有 output schema、source capability、资源等级和验证状态。example 的说明和 fixture 是参考证据，不是 production requirement；Agent 必须生成自己的 FamilySpec/Transform digest，不能复制目录身份冒充已激活 capability。

## 6. 验收

- example 目录不会产生 Registry side effect；
- 同名不同 scope 不静默 shadow；
- exact digest resolution 可重现；
- shadow output 与 legacy output 的差异可定位；
- revoke 阻止新执行但不篡改旧 Publication；
- catalog 缺少真实 capability 时返回 unsupported/blocked，而不是诱导 Agent 生成 arbitrary URL/parser。
