import { describe, expect, it } from "vitest";

import { APIError, parseJsonTextStrict } from "../src/index.js";

describe("parseJsonTextStrict", () => {
  it("parses ordinary JSON without changing its values", () => {
    const value = parseJsonTextStrict(
      '{"text":"e\\u0301","negativeZero":-0,"nested":{"ok":true},"items":[null,1.5e2]}',
    ) as Record<string, unknown>;
    expect(value).toEqual({
      text: "e\u0301",
      negativeZero: -0,
      nested: { ok: true },
      items: [null, 150],
    });
    expect(Object.is(value.negativeZero, -0)).toBe(true);
  });

  it("rejects duplicate decoded keys at every object depth", () => {
    for (const text of [
      '{"a":1,"a":2}',
      '{"outer":{"a":1,"a":2}}',
      '{"a":1,"\\u0061":2}',
      '{"\\uD83D\\uDE00":1,"😀":2}',
    ]) {
      expect(() => parseJsonTextStrict(text)).toThrow(/duplicate object key/);
    }
    expect(parseJsonTextStrict('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("enforces the JSON grammar instead of relying on a duplicate-key regex", () => {
    for (const text of [
      "",
      "{a:1}",
      '{"a":01}',
      '{"a":NaN}',
      '{"a":1,}',
      "[1,]",
      '"unterminated',
      '"bad\\xescape"',
      "true false",
      "1e9999",
    ]) {
      expect(() => parseJsonTextStrict(text), text).toThrow(APIError);
    }
  });

  it("fails closed on character, nesting, and node budgets", () => {
    expect(() => parseJsonTextStrict('{"a":1}', { maxChars: 6 })).toThrow(/exceeds/);
    expect(() => parseJsonTextStrict('{"a":{"b":1}}', { maxDepth: 1 })).toThrow(/nesting/);
    expect(() => parseJsonTextStrict("[1,2,3]", { maxNodes: 3 })).toThrow(/node count/);
  });

  it("validates parser limits", () => {
    expect(() => parseJsonTextStrict("{}", { maxChars: -1 })).toThrow(TypeError);
    expect(() => parseJsonTextStrict("{}", { maxDepth: -1 })).toThrow(TypeError);
    expect(() => parseJsonTextStrict("{}", { maxNodes: 0 })).toThrow(TypeError);
  });
});
