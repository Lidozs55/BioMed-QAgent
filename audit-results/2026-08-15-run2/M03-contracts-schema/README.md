# M03 Contracts、Schema Registry 与 wire DTO 审计结果（Run #2）

- 审计人: root
- 基线: be78a1a
- 状态: PASS

## 结论（本拉取重点改动）

- wire 解析器/校验器统一收进 `@biomed/contracts` runtime：`frontend/src/lib/eventValidatorHelpers.ts` -> `packages/contracts/src/runtime/primitives.ts`，`settingsParsers.ts` -> `runtime/settings.ts`。
- 新增 `packages/contracts/src/databases.ts`、`model-registry.ts`、`settings.ts`、`runtime/dataset-build.ts`、`runtime/errors.ts`。
- contracts 14/14 通过；server/frontend 全量测试通过（跨包 DTO 无重复定义，迁移后引用一致）。
- 前端的 `settingsContracts.ts` 删除，`settings.ts` 契约上移。
