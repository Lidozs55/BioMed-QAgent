import { describe, expect, it } from "vitest";

import {
  computeInputCapacity,
  computeSafetyReserveTokens,
  deriveEffectiveBudget,
  isBudgetValid,
  isCompactionRatioValid,
  isContextWindowPositive,
  isPositiveSafeInteger,
  isSafetyReserveRatioValid,
  parseOverrideWindow,
} from "@/lib/contextBudget";

describe("computeSafetyReserveTokens", () => {
  it("ensures minimum floor of 16384", () => {
    expect(computeSafetyReserveTokens(4096, 0.01)).toBe(16384);
    expect(computeSafetyReserveTokens(32768, 0.05)).toBe(16384);
  });

  it("scales above 16384 when context_window * ratio exceeds it", () => {
    expect(computeSafetyReserveTokens(131072, 0.25)).toBe(32768);
    expect(computeSafetyReserveTokens(100000, 0.20)).toBe(20000);
  });

  it("ceil edge: fractional 16384.1 => 16385", () => {
    expect(computeSafetyReserveTokens(16385, 1.0)).toBe(16385);
    expect(computeSafetyReserveTokens(109227, 0.15)).toBe(16385);
  });
});

describe("computeInputCapacity", () => {
  it("returns positive capacity for valid inputs", () => {
    expect(computeInputCapacity(32768, 4096, 16384)).toBe(12288);
    expect(computeInputCapacity(131072, 8192, 16384)).toBe(106496);
  });

  it("returns signed negative result when capacity is exceeded", () => {
    expect(computeInputCapacity(32768, 30000, 16384)).toBe(-13616);
    expect(computeInputCapacity(100, 50, 100)).toBe(-50);
  });

  it("returns zero when capacity is exactly zero", () => {
    expect(computeInputCapacity(100, 50, 50)).toBe(0);
  });
});

describe("isSafetyReserveRatioValid", () => {
  it("accepts 0 through 0.25 inclusive", () => {
    expect(isSafetyReserveRatioValid(0)).toBe(true);
    expect(isSafetyReserveRatioValid(0.05)).toBe(true);
    expect(isSafetyReserveRatioValid(0.25)).toBe(true);
  });

  it("rejects values outside [0, 0.25]", () => {
    expect(isSafetyReserveRatioValid(-0.01)).toBe(false);
    expect(isSafetyReserveRatioValid(0.26)).toBe(false);
    expect(isSafetyReserveRatioValid(1)).toBe(false);
  });
});

describe("isCompactionRatioValid", () => {
  it("accepts 0 < target < trigger < 1", () => {
    expect(isCompactionRatioValid(0.5, 0.8)).toBe(true);
    expect(isCompactionRatioValid(0.01, 0.99)).toBe(true);
    expect(isCompactionRatioValid(0.6, 0.85)).toBe(true);
  });

  it("rejects target >= trigger", () => {
    expect(isCompactionRatioValid(0.8, 0.5)).toBe(false);
    expect(isCompactionRatioValid(0.85, 0.85)).toBe(false);
  });

  it("rejects non-positive values", () => {
    expect(isCompactionRatioValid(0, 0.5)).toBe(false);
    expect(isCompactionRatioValid(-0.1, 0.5)).toBe(false);
  });

  it("rejects trigger >= 1", () => {
    expect(isCompactionRatioValid(0.5, 1)).toBe(false);
    expect(isCompactionRatioValid(0.5, 1.5)).toBe(false);
  });
});

describe("isContextWindowPositive", () => {
  it("accepts positive finite numbers", () => {
    expect(isContextWindowPositive(1)).toBe(true);
    expect(isContextWindowPositive(32768)).toBe(true);
    expect(isContextWindowPositive(1000000)).toBe(true);
  });

  it("rejects zero, negative, NaN, Infinity", () => {
    expect(isContextWindowPositive(0)).toBe(false);
    expect(isContextWindowPositive(-1)).toBe(false);
    expect(isContextWindowPositive(Number.NaN)).toBe(false);
    expect(isContextWindowPositive(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("isPositiveSafeInteger", () => {
  it("accepts positive safe integers", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(32768)).toBe(true);
  });

  it("rejects zero, negative, non-integer, unsafe", () => {
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(-1)).toBe(false);
    expect(isPositiveSafeInteger(1.5)).toBe(false);
    expect(isPositiveSafeInteger(Number.NaN)).toBe(false);
  });
});

describe("isBudgetValid", () => {
  it("accepts a valid budget with catalog 32K model", () => {
    const result = isBudgetValid(32768, 4096, 0.05, 0.6, 0.85);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid budget with large model", () => {
    const result = isBudgetValid(131072, 16384, 0.10, 0.5, 0.80);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-positive context_window", () => {
    const result = isBudgetValid(0, 4096, 0.05, 0.6, 0.85);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects out-of-range safety_reserve_ratio", () => {
    const result = isBudgetValid(32768, 4096, 0.50, 0.6, 0.85);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid compaction ratios", () => {
    const result = isBudgetValid(32768, 4096, 0.05, 0.9, 0.85);
    expect(result.valid).toBe(false);
  });

  it("rejects non-positive capacity", () => {
    const result = isBudgetValid(32768, 30000, 0.05, 0.6, 0.85);
    expect(result.valid).toBe(false);
  });

  it("rejects non-integer max_output_tokens", () => {
    const result = isBudgetValid(32768, 4096.5, 0.05, 0.6, 0.85);
    expect(result.valid).toBe(false);
  });
});

describe("deriveEffectiveBudget", () => {
  it("preserves unavailable unknown-model capacity until a positive override is supplied", () => {
    const result = deriveEffectiveBudget(0, "unknown", 0, false, 4096, 0.05, 0.6, 0.85, "");
    expect(result.source).toBe("unknown");
    expect(result.contextWindow).toBe(0);
    expect(result.safetyReserveTokens).toBe(0);
    expect(result.availableInputTokens).toBe(0);
    expect(result.budgetValid).toBe(false);
  });
});

describe("parseOverrideWindow", () => {
  it("returns 0 for blank or zero string", () => {
    expect(parseOverrideWindow("")).toBe(0);
    expect(parseOverrideWindow("0")).toBe(0);
  });

  it("returns positive integer for valid input", () => {
    expect(parseOverrideWindow("65536")).toBe(65536);
    expect(parseOverrideWindow("32768")).toBe(32768);
  });

  it("returns NaN for fractional input", () => {
    expect(Number.isNaN(parseOverrideWindow("32.5"))).toBe(true);
  });

  it("returns NaN for non-numeric input", () => {
    expect(Number.isNaN(parseOverrideWindow("abc"))).toBe(true);
  });

  it("returns NaN for negative input", () => {
    expect(Number.isNaN(parseOverrideWindow("-1"))).toBe(true);
  });

  it("returns NaN for unsafe integer (beyond Number.MAX_SAFE_INTEGER)", () => {
    expect(Number.isNaN(parseOverrideWindow(String(Number.MAX_SAFE_INTEGER + 1)))).toBe(true);
    expect(Number.isNaN(parseOverrideWindow(String(Number.MIN_SAFE_INTEGER - 1)))).toBe(true);
  });
});

describe("isContextWindowPositive", () => {
  it("rejects unsafe integers", () => {
    expect(isContextWindowPositive(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("rejects fractional values", () => {
    expect(isContextWindowPositive(1.5)).toBe(false);
  });
});
