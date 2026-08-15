import { describe, expect, test } from "vitest";

import { parseHostConfig, resolveOutputDir } from "../src/config.js";
import path from "node:path";

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

describe("resolveOutputDir (Phase 8 final audit)", () => {
  // path.resolve("/repo")：Windows 下避免字面量根路径的盘符差异
  const root = path.resolve("/repo");

  test("defaults to <repositoryRoot>/data/output when unset or empty", () => {
    expect(resolveOutputDir(root, undefined)).toBe(path.join(root, "data", "output"));
    expect(resolveOutputDir(root, "  ")).toBe(path.join(root, "data", "output"));
  });

  test("keeps absolute paths unchanged", () => {
    expect(resolveOutputDir(root, "/abs/data/output")).toBe(path.resolve("/abs/data/output"));
  });

  test("anchors relative paths to repositoryRoot, not the process cwd", () => {
    // 回归：根 .env 用相对值 OUTPUT_DIR=data/output，若按 cwd 解析，
    // 在 server/ 目录下运行 server 包脚本会把数据写到 server/data/。
    expect(resolveOutputDir(root, "data/output")).toBe(path.join(root, "data", "output"));
    expect(resolveOutputDir(root, "./data/output")).toBe(path.join(root, "data", "output"));
  });
});
