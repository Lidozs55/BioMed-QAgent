import { describe, expect, test } from "vitest";

import { errorResult } from "../src/agent/tools/result.js";

describe("shared Agent tool result contract", () => {
  test("preserves structured upstream retryability and status", () => {
    const error = Object.assign(new Error("NCBI temporarily unavailable"), {
      code: "network_error",
      retryable: true,
      statusCode: 503,
    });

    const result = errorResult(error);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "NCBI temporarily unavailable",
      code: "network_error",
      retryable: true,
      status_code: 503,
    });
    expect(result.details).toEqual(JSON.parse(result.content));
  });

  test("classifies unstructured exceptions as non-retryable tool errors", () => {
    const result = errorResult(new TypeError("query is invalid"));
    expect(JSON.parse(result.content)).toEqual({
      error: "query is invalid",
      code: "tool_error",
      retryable: false,
    });
  });

  test("bounds model-visible error text without producing invalid JSON", () => {
    const result = errorResult(new Error("x".repeat(5_000)));
    const parsed = JSON.parse(result.content) as { error: string };
    expect(parsed.error).toHaveLength(2_000);
  });
});
