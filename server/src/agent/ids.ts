/**
 * Safe task/run/session identifier guard for the agent layer (deduplicated
 * from ``pi-adapter.ts``, ``workspace/context.ts`` and
 * ``workspace/workspace-paths.ts``). This family allows ``.`` (Pi session
 * ids); the runtime family in ``runtime/safe-id.ts`` intentionally does not.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SafeIdOptions {
  /** When true, an undefined value is accepted (used for optional ids). */
  optional?: boolean;
  /** Error message override; defaults to ``<name> must be a safe identifier``. */
  message?: string;
  /** Domain error constructor; defaults to a plain TypeError. */
  errorFactory?: (message: string) => Error;
}

export function requireSafeId(name: string, value: string | undefined, options: SafeIdOptions = {}): void {
  if (options.optional && value === undefined) return;
  if (value === undefined || !SAFE_ID.test(value)) {
    const message = options.message ?? `${name} must be a safe identifier`;
    if (options.errorFactory !== undefined) throw options.errorFactory(message);
    throw new TypeError(message);
  }
}