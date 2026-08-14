import { describe, expect, test } from "vitest";

import { parseHostConfig } from "../src/config.js";

describe("host config (Phase 8: runtime parameters only)", () => {
  test("uses the default full-TypeScript profile", () => {
    expect(parseHostConfig({})).toEqual({
      publicHost: "127.0.0.1",
      publicPort: 5173,
      shutdownTimeoutMs: 10000,
      workspaceDevExec: false,
    });
  });

  test("parses explicit runtime parameters", () => {
    expect(parseHostConfig({
      HOST: "0.0.0.0",
      PORT: "8080",
      SHUTDOWN_TIMEOUT_MS: "5000",
      WORKSPACE_DEV_EXEC: "1",
    })).toEqual({
      publicHost: "0.0.0.0",
      publicPort: 8080,
      shutdownTimeoutMs: 5000,
      workspaceDevExec: true,
    });
  });

  test("rejects invalid ports and timeouts", () => {
    expect(() => parseHostConfig({ PORT: "70000" })).toThrow(/PORT/);
    expect(() => parseHostConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => parseHostConfig({ SHUTDOWN_TIMEOUT_MS: "0" })).toThrow(/SHUTDOWN_TIMEOUT_MS/);
  });

  test("rejects an empty HOST", () => {
    expect(() => parseHostConfig({ HOST: "  " })).toThrow(/HOST/);
  });

  test("requires an explicit validated development exec flag", () => {
    expect(parseHostConfig({ WORKSPACE_DEV_EXEC: "1" }).workspaceDevExec).toBe(true);
    expect(() => parseHostConfig({ WORKSPACE_DEV_EXEC: "true" })).toThrow(
      /WORKSPACE_DEV_EXEC/,
    );
  });

  test("ignores retired migration feature flags (no rollback profiles)", () => {
    // Phase 8: APP_HOST / AGENT_RUNTIME / DATASET_CORE / PI_EXPERIMENTAL /
    // LEGACY_* are no longer parsed — the architecture is fixed.
    const config = parseHostConfig({
      APP_HOST: "fastapi",
      AGENT_RUNTIME: "legacy",
      DATASET_CORE: "python",
      PI_EXPERIMENTAL: "1",
      LEGACY_BACKEND_PORT: "8000",
      LEGACY_BACKEND_URL: "http://127.0.0.1:8000",
      LEGACY_READINESS_TIMEOUT_MS: "30000",
      PI_DATASET_BRIDGE_SECRET: "secret",
    });
    expect(config).toEqual({
      publicHost: "127.0.0.1",
      publicPort: 5173,
      shutdownTimeoutMs: 10000,
      workspaceDevExec: false,
    });
  });
});
