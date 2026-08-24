import { APIError } from "@/api/errors";

/** Whether a manual-compaction request failed because there is nothing to compact. */
export function isNothingToCompactError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    /no conversation to compact|Nothing to compact|Already compacted/i.test(error.message)
  );
}
