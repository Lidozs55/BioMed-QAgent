/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import "vitest";
import type { AxeMatchers } from "vitest-axe";

/**
 * vitest-axe@0.1.0 augments the legacy `declare global namespace Vi.Assertion`,
 * which vitest 3.x no longer uses (it re-exports vitest's Assertion). Bridge
 * the axe matcher onto `vitest`'s Assertion — same pattern as
 * @testing-library/jest-dom — so `tsc -b` accepts
 * `expect(results).toHaveNoViolations()`. Runtime `expect.extend(matchers)`
 * in accessibility-axe.test.tsx already registers the matcher.
 */
declare module "vitest" {
  interface Assertion<T = any> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
