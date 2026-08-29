import { describe, expect, it } from "vitest";

import { highlightJson } from "@/lib/jsonHighlight";

function texts(segments: ReturnType<typeof highlightJson>): string {
  return segments.map((segment) => segment.text).join("");
}

describe("highlightJson", () => {
  it("classifies keys, strings, numbers and literals", () => {
    const segments = highlightJson(
      '{\n  "name": "egfr",\n  "count": 42,\n  "ok": true,\n  "note": null\n}',
    );
    const keyed = segments.find((s) => s.text.startsWith('"name"'));
    expect(keyed?.className).toContain("text-primary");
    const value = segments.find((s) => s.text === '"egfr"');
    expect(value?.className).toContain("text-success");
    const number = segments.find((s) => s.text === "42");
    expect(number?.className).toContain("text-muted-foreground");
    const bool = segments.find((s) => s.text === "true");
    expect(bool?.className).toContain("text-muted-foreground");
    const nul = segments.find((s) => s.text === "null");
    expect(nul?.className).toContain("text-muted-foreground");
  });

  it("keeps plain text between tokens in order", () => {
    const source = '{"a":1,"b":[true,null]}';
    const segments = highlightJson(source);
    expect(texts(segments)).toBe(source);
  });

  it("handles escaped quotes inside strings", () => {
    const segments = highlightJson('{"say":"a\\"b"}');
    const escaped = segments.find((s) => s.text === '"a\\"b"');
    expect(escaped).toBeDefined();
    expect(escaped?.className).toContain("text-success");
  });

  it("treats a string followed by a colon as a key even with unicode", () => {
    const segments = highlightJson('{"主题": ",x"}');
    const key = segments.find((s) => s.text === '"主题":');
    expect(key?.className).toContain("text-primary");
  });

  it("supports negative and exponent numbers", () => {
    const segments = highlightJson('{"a":-1.5e-3}');
    const number = segments.find((s) => s.text === "-1.5e-3");
    expect(number?.className).toContain("text-muted-foreground");
  });

  it("skips highlighting for oversized text", () => {
    const big = "x".repeat(100_001);
    const segments = highlightJson(big);
    expect(segments).toHaveLength(1);
    expect(segments[0].className).toBeUndefined();
  });
});
