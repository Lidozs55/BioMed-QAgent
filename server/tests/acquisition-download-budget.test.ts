import { describe, expect, test } from "vitest";

import { clampAcquisitionDownloadBudget } from "../src/dataset/acquisition/runtime.js";

describe("clampAcquisitionDownloadBudget (2026-09-02 audit P0-6/P0-7)", () => {
  test("clamps provider maxBytes down to max_download_mib", () => {
    expect(
      clampAcquisitionDownloadBudget(
        { maxBytes: 4 * 1024 * 1024 * 1024, timeoutMs: undefined },
        { maxDownloadBytes: 512 * 1024 * 1024 },
      ),
    ).toEqual({ maxBytes: 512 * 1024 * 1024, timeoutMs: undefined });
  });

  test("keeps the provider cap when it is stricter than the setting", () => {
    expect(
      clampAcquisitionDownloadBudget(
        { maxBytes: 16 * 1024 * 1024, timeoutMs: undefined },
        { maxDownloadBytes: 8192 * 1024 * 1024 },
      ).maxBytes,
    ).toBe(16 * 1024 * 1024);
  });

  test("leaves maxBytes untouched when no budget is configured", () => {
    expect(
      clampAcquisitionDownloadBudget(
        { maxBytes: 4 * 1024 * 1024 * 1024, timeoutMs: undefined },
        {},
      ).maxBytes,
    ).toBe(4 * 1024 * 1024 * 1024);
  });

  test("raises a provider timeout floor to download_timeout_seconds", () => {
    expect(
      clampAcquisitionDownloadBudget(
        { maxBytes: 1024, timeoutMs: 45 * 60_000 },
        { downloadTimeoutMs: 7200 * 1000 },
      ).timeoutMs,
    ).toBe(7200 * 1000);
  });

  test("keeps the provider floor when the setting is lower", () => {
    expect(
      clampAcquisitionDownloadBudget(
        { maxBytes: 1024, timeoutMs: 45 * 60_000 },
        { downloadTimeoutMs: 600 * 1000 },
      ).timeoutMs,
    ).toBe(45 * 60_000);
  });

  test("leaves plans without a floor on the generic HTTP timeout", () => {
    expect(
      clampAcquisitionDownloadBudget(
        { maxBytes: 1024, timeoutMs: undefined },
        { downloadTimeoutMs: 3600 * 1000 },
      ).timeoutMs,
    ).toBeUndefined();
  });
});
