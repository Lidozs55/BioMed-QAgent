import { describe, expect, it } from "vitest";

import {
  TOKEN_UNIT_MULTIPLIER,
  decomposeTokenCount,
  formatContextWindow,
  formatTokenCount,
} from "@/lib/tokenFormat";

describe("formatTokenCount (base-10 units)", () => {
  it("renders raw token counts below 1K without a unit", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(512)).toBe("512");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("uses base-10 K (1,000), not base-2 K (1,024)", () => {
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(8_192)).toBe("8.2K"); // 8192/1024 would be 8K under base-2
    expect(formatTokenCount(32_768)).toBe("32.8K");
    expect(formatTokenCount(128_000)).toBe("128K");
    expect(formatTokenCount(999_999)).toBe("1000K");
  });

  it("uses base-10 M (1,000,000)", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });

  it("drops a trailing .0 on exact unit values", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(64_000)).toBe("64K");
  });
});

describe("formatContextWindow", () => {
  it("formats valid token counts", () => {
    expect(formatContextWindow(32_000)).toBe("32K");
    expect(formatContextWindow(131_072)).toBe("131.1K");
  });

  it("falls back to 未知 for missing or invalid values", () => {
    expect(formatContextWindow(null)).toBe("未知");
    expect(formatContextWindow(undefined)).toBe("未知");
    expect(formatContextWindow(0)).toBe("未知");
    expect(formatContextWindow(-5)).toBe("未知");
  });
});

describe("decomposeTokenCount + TOKEN_UNIT_MULTIPLIER (base-10)", () => {
  it("maps units to base-10 multipliers", () => {
    expect(TOKEN_UNIT_MULTIPLIER).toEqual({ B: 1, K: 1_000, M: 1_000_000 });
  });

  it("decomposes exact base-10 K/M values into number + unit", () => {
    expect(decomposeTokenCount(32_000)).toEqual({ num: "32", unit: "K" });
    expect(decomposeTokenCount(1_000_000)).toEqual({ num: "1", unit: "M" });
    expect(decomposeTokenCount(512_000)).toEqual({ num: "512", unit: "K" });
  });

  it("keeps non-exact values as raw B to preserve round-trip fidelity", () => {
    expect(decomposeTokenCount(131_072)).toEqual({ num: "131072", unit: "B" });
    expect(decomposeTokenCount(1_024)).toEqual({ num: "1024", unit: "B" }); // 1024 ≠ 1K (base-10)
    expect(decomposeTokenCount(0)).toEqual({ num: "0", unit: "B" });
  });
});
