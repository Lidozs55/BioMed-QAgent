import type { ParameterSpec } from "@/hooks/useAPI";

/**
 * 校验单个参数值是否满足 spec 的数字类型与 min/max 范围。
 * 返回错误文案；合法时返回 null。仅约束显式存在的值（undefined 视为未设置）。
 */
export function paramValueError(spec: ParameterSpec, value: unknown): string | null {
  if (spec.type !== "integer" && spec.type !== "number") return null;
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${spec.label}必须为数字`;
  }
  if (spec.min != null && value < spec.min) {
    return `${spec.label}不能小于 ${spec.min}`;
  }
  if (spec.max != null && value > spec.max) {
    return `${spec.label}不能大于 ${spec.max}`;
  }
  return null;
}

/**
 * 校验一组参数是否全部落在 spec 范围内；返回第一条错误文案，全部合法返回 null。
 * 供保存入口在提交前做同一套 JS 强制（min/max 不只是 HTML 属性）。
 */
export function paramsValidationError(
  specs: ParameterSpec[],
  params: Record<string, unknown>,
): string | null {
  for (const spec of specs) {
    const error = paramValueError(spec, params[spec.key]);
    if (error) return error;
  }
  return null;
}
