import { describe, expect, test } from "vitest";

import { parseFeatureFlags, parseHostConfig } from "../src/config.js";

describe("feature flags", () => {
  test("accepts every documented Phase 0/1 profile", () => {
    const profiles = [
      ["fastapi", "legacy", "python", "0"],
      ["ts", "legacy", "python", "0"],
      ["ts", "legacy", "python", "1"],
      ["ts", "pi", "python", "0"],
      ["ts", "pi", "python", "1"],
    ] as const;

    for (const [appHost, agentRuntime, datasetCore, piExperimental] of profiles) {
      expect(
        parseFeatureFlags({
          APP_HOST: appHost,
          AGENT_RUNTIME: agentRuntime,
          DATASET_CORE: datasetCore,
          PI_EXPERIMENTAL: piExperimental,
        }),
      ).toEqual({
        appHost,
        agentRuntime,
        datasetCore,
        piExperimental: piExperimental === "1",
      });
    }
  });

  test.each([
    { DATASET_CORE: "ts" },
    { APP_HOST: "fastapi", PI_EXPERIMENTAL: "1" },
    { APP_HOST: "fastapi", AGENT_RUNTIME: "pi", PI_EXPERIMENTAL: "1" },
    { APP_HOST: "unknown" },
  ])("rejects invalid flag combination %#", (override) => {
    expect(() =>
      parseFeatureFlags({
        APP_HOST: "ts",
        AGENT_RUNTIME: "legacy",
        DATASET_CORE: "python",
        PI_EXPERIMENTAL: "0",
        ...override,
      }),
    ).toThrow();
  });

  test("uses the normal Phase 1 transition by default and requires TS topology", () => {
    expect(parseHostConfig({})).toMatchObject({
      flags: {
        appHost: "ts",
        agentRuntime: "legacy",
        datasetCore: "python",
        piExperimental: true,
      },
      publicHost: "127.0.0.1",
      publicPort: 5173,
      legacyPrivatePort: 0,
      workspaceDevExec: false,
    });
    expect(() => parseHostConfig({
      APP_HOST: "fastapi",
      PI_EXPERIMENTAL: "0",
    })).toThrow(/APP_HOST=ts/);
  });

  test("requires an explicit validated development exec flag", () => {
    expect(parseHostConfig({ WORKSPACE_DEV_EXEC: "1" }).workspaceDevExec).toBe(true);
    expect(() => parseHostConfig({ WORKSPACE_DEV_EXEC: "true" })).toThrow(
      /WORKSPACE_DEV_EXEC/,
    );
  });
});
