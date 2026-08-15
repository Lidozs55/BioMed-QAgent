import type { AxeMatchers } from "vitest-axe";

/**
 * vitest-axe 的类型扩展面向 Vitest 1（`Vi.Assertion` 全局命名空间），
 * 在 Vitest 3 下不生效，需通过 `declare module "vitest"` 增强
 * `toHaveNoViolations` matcher 的类型（vitest-axe/dist/extend-expect.d.ts
 * 的 runtime 部分仍由测试文件 `import "vitest-axe/extend-expect"` 提供）。
 *
 * 模块增强的标准写法要求空 interface 与泛型参数，lint 规则按需豁免。
 */
/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
declare module "vitest" {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
/* eslint-enable */