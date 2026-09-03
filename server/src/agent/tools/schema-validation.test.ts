import { describe, expect, test } from "vitest";

import { errorResult, firstPartyStack } from "./result.js";
import { ToolHttpError } from "../../external/network/errors.js";
import { collectSchemaIssues, validateToolArgumentsOrThrow } from "./schema-validation.js";

const SAMPLE_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 2 },
    max_results: { type: "integer", minimum: 1 },
    source: { enum: ["gdc", "xena"] },
    genes: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["query"],
  additionalProperties: false,
};

describe("collectSchemaIssues", () => {
  test("accepts valid arguments", () => {
    expect(collectSchemaIssues({ query: "luad", source: "gdc" }, SAMPLE_SCHEMA)).toEqual([]);
  });

  test("reports missing required field FastAPI-style", () => {
    const issues = collectSchemaIssues({}, SAMPLE_SCHEMA);
    expect(issues).toEqual([{ loc: ["query"], msg: "Field required", type: "missing" }]);
  });

  test("reports wrong type with received type name and bounded input echo", () => {
    const issues = collectSchemaIssues({ query: 42 }, SAMPLE_SCHEMA);
    expect(issues[0]).toMatchObject({ loc: ["query"], type: "string_type", input: "42" });
    expect(issues[0].msg).toContain("received integer");
  });

  test("reports extra field with allowed-field hint", () => {
    const issues = collectSchemaIssues({ query: "ok", quer: "typo" }, SAMPLE_SCHEMA);
    expect(issues[0]).toMatchObject({ loc: ["quer"], type: "extra_forbidden" });
    expect(issues[0].msg).toContain("allowed fields: query, max_results, source, genes");
  });

  test("reports enum, minLength and item-level issues with nested loc", () => {
    const issues = collectSchemaIssues(
      { query: "a", source: "dbgap", genes: ["TP53", 7] },
      SAMPLE_SCHEMA,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ loc: ["query"], type: "string_too_short" }),
        expect.objectContaining({ loc: ["source"], type: "enum" }),
        expect.objectContaining({ loc: ["genes", 1], type: "string_type" }),
      ]),
    );
  });

  test("non-object root reports a root-level type issue", () => {
    const issues = collectSchemaIssues("nope", SAMPLE_SCHEMA);
    expect(issues[0]).toMatchObject({ loc: [], type: "object_type" });
  });

  test("validateToolArgumentsOrThrow throws with code and retryable markers", () => {
    expect(() => validateToolArgumentsOrThrow({ quer: "x" }, SAMPLE_SCHEMA)).toThrowError(
      /quer: Extra inputs are not permitted/,
    );
    try {
      validateToolArgumentsOrThrow({ quer: "x" }, SAMPLE_SCHEMA);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_arguments", retryable: false });
    }
  });
});

describe("errorResult", () => {
  test("passes through detail and code of ArgumentValidationError", () => {
    try {
      validateToolArgumentsOrThrow({}, SAMPLE_SCHEMA);
      expect.unreachable();
    } catch (error) {
      const result = errorResult(error);
      expect(result.isError).toBe(true);
      const details = result.details as { code: string; retryable: boolean; detail: unknown[] };
      expect(details.code).toBe("invalid_arguments");
      expect(details.retryable).toBe(false);
      expect(details.detail).toEqual([{ loc: ["query"], msg: "Field required", type: "missing" }]);
    }
  });

  test("serializes ToolHttpError with url, status and retryable classification", () => {
    const error = new ToolHttpError("https://api.gdc.cancer.gov/projects", 429);
    const details = errorResult(error).details as {
      code: string;
      retryable: boolean;
      status_code: number;
      error: string;
    };
    expect(details).toMatchObject({
      code: "upstream_http_error",
      retryable: true,
      status_code: 429,
    });
    expect(details.error).toContain("https://api.gdc.cancer.gov/projects");
    expect(details.error).toContain("429");
  });

  test("ToolHttpError classifies 4xx as non-retryable", () => {
    const details = errorResult(new ToolHttpError("https://x.test/", 404)).details as {
      retryable: boolean;
    };
    expect(details.retryable).toBe(false);
  });

  test("includes bounded first-party stack frames", () => {
    const error = new Error("boom");
    const details = errorResult(error).details as { stack?: string[] };
    expect(Array.isArray(details.stack)).toBe(true);
    expect(details.stack!.length).toBeGreaterThan(0);
    expect(details.stack!.join("\n")).toContain("schema-validation.test.ts");
  });

  test("firstPartyStack returns null when no first-party frames exist", () => {
    const error = new Error("clean");
    error.stack = "Error: clean\n    at node:internal/process/task_queues:95:5";
    expect(firstPartyStack(error)).toBeNull();
  });
});
