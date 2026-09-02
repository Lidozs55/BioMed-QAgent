import { describe, expect, it } from "vitest";

import {
  readBoundedJson,
  resolveToolResponseLimit,
} from "../src/agent/tools/response-limit.js";

function body(...chunks: string[]): AsyncIterable<Buffer> {
  return (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
}

describe("curated tool response limits", () => {
  it("lets the host setting tighten but never loosen an intrinsic cap", () => {
    expect(resolveToolResponseLimit(8 * 1024 * 1024, 2 * 1024 * 1024))
      .toBe(2 * 1024 * 1024);
    expect(resolveToolResponseLimit(2 * 1024 * 1024, 16 * 1024 * 1024))
      .toBe(2 * 1024 * 1024);
  });

  it("rejects a JSON body above the effective host cap", async () => {
    await expect(readBoundedJson(body('{"value":"', "abcdefgh", '"}'), {
      source: "fixture",
      intrinsicMaxBytes: 1024,
      configuredMaxBytes: 12,
    })).rejects.toThrow("fixture response exceeds 12 bytes");
  });

  it("parses a body within the effective cap", async () => {
    await expect(readBoundedJson(body('{"ok":', "true}"), {
      source: "fixture",
      intrinsicMaxBytes: 1024,
      configuredMaxBytes: 64,
    })).resolves.toEqual({ ok: true });
  });

  it("rejects invalid configured limits before consuming the response", async () => {
    await expect(readBoundedJson(body("{}"), {
      source: "fixture",
      intrinsicMaxBytes: 1024,
      configuredMaxBytes: 0,
    })).rejects.toThrow(/configuredMaxBytes must be a positive safe integer/);
  });
});
