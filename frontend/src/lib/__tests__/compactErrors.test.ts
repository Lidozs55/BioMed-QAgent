import { describe, expect, it } from "vitest";

import { APIError } from "@/api/errors";
import { isNothingToCompactError } from "@/lib/compactErrors";

describe("compact error classification", () => {
  it("classifies the no-conversation 409 as informational", () => {
    expect(isNothingToCompactError(
      new APIError(409, "Task has no conversation to compact"),
    )).toBe(true);
  });

  it("keeps other compaction failures as errors", () => {
    expect(isNothingToCompactError(new APIError(502, "Agent runtime failed"))).toBe(false);
    expect(isNothingToCompactError(new Error("boom"))).toBe(false);
  });
});
