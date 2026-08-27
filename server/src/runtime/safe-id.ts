/**
 * Shared safe-identifier guard for task/run/build identifiers that become
 * filesystem names. This single implementation replaces copies that used to
 * live in ``task-repository.ts``, ``hil-store.ts``, ``execution-continuation.ts``,
 * ``artifact-store.ts``, ``durable-agent-runtime.ts`` and
 * ``product/publication-store.ts`` (identical regex + identical error).
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function requireSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new TypeError(`${name} must be a safe identifier`);
}