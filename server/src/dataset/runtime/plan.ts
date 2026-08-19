/**
 * Server-side fixed build skeleton (Python
 * ``app/datasets/runtime/executor.py:build_operation_plan``).
 *
 * The skeleton is fixed in code; the Agent cannot declare steps. Plan order is
 * topological: acquire/parse/canonicalize fan out per source binding, then
 * compatibility gate -> integrate -> validate profile -> publish fan back in.
 */

import type { DatasetBuildSpec } from "../contracts/index.js";
import {
  OperationKind,
  makeOperationSpec,
  type OperationSpec,
} from "./operations.js";

/** Expand the fixed skeleton for one build spec (fan-out per source).
 * The derive slot is server-owned and appears only when a trusted handler is
 * supplied; callers cannot add arbitrary operations. */
export function buildOperationPlan(
  spec: DatasetBuildSpec,
  options: { deriveHandler?: boolean } = {},
): OperationSpec[] {
  const ops: OperationSpec[] = [];
  const bindings = spec.source_bindings;
  for (const binding of bindings) {
    ops.push(
      makeOperationSpec({
        operation_id: `acquire:${binding.binding_id}`,
        kind: OperationKind.ACQUIRE,
        label: `获取 ${binding.source}`,
        category: binding.binding_id,
      }),
    );
  }
  for (const binding of bindings) {
    ops.push(
      makeOperationSpec({
        operation_id: `parse:${binding.binding_id}`,
        kind: OperationKind.PARSE,
        label: `解析 ${binding.source}`,
        category: binding.binding_id,
        upstream: [`acquire:${binding.binding_id}`],
      }),
    );
  }
  for (const binding of bindings) {
    ops.push(
      makeOperationSpec({
        operation_id: `canonicalize:${binding.binding_id}`,
        kind: OperationKind.CANONICALIZE,
        label: `规范化 ${binding.source}`,
        category: binding.binding_id,
        upstream: [`parse:${binding.binding_id}`],
      }),
    );
  }
  const canonicalizeIds = bindings.map(
    (binding) => `canonicalize:${binding.binding_id}`,
  );
  ops.push(
    makeOperationSpec({
      operation_id: "compatibility_gate",
      kind: OperationKind.COMPATIBILITY_GATE,
      label: "兼容性检查",
      upstream: canonicalizeIds,
    }),
  );
  ops.push(
    makeOperationSpec({
      operation_id: "integrate",
      kind: OperationKind.INTEGRATE,
      label: "确定性合并",
      upstream: ["compatibility_gate"],
    }),
  );
  const validationUpstream = options.deriveHandler ? "derive" : "integrate";
  if (options.deriveHandler) {
    ops.push(
      makeOperationSpec({
        operation_id: "derive",
        kind: OperationKind.DERIVE,
        label: "确定性派生",
        upstream: ["integrate"],
      }),
    );
  }
  ops.push(
    makeOperationSpec({
      operation_id: "validate_profile",
      kind: OperationKind.VALIDATE_PROFILE,
      label: "Validation Profile",
      upstream: [validationUpstream],
    }),
  );
  ops.push(
    makeOperationSpec({
      operation_id: "publish",
      kind: OperationKind.PUBLISH,
      label: "原子发布",
      upstream: ["validate_profile"],
    }),
  );
  return ops;
}