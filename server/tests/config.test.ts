import { describe, expect, test } from "vitest";

import { parseFeatureFlags, parseHostConfig } from "../src/config.js";

describe("feature flags", () => {
  test("accepts every documented Phase 0/1 profile", () => {
    const profiles = [
      ["fastapi", "legacy", "python", "0"],
      ["ts", "legacy", "python", "0"],
      ["ts", "legacy", "python", "1"],
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
    { AGENT_RUNTIME: "pi", PI_EXPERIMENTAL: "0" },
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

  test("uses an explicit proxy-only default and requires TS topology", () => {
    expect(parseHostConfig({})).toMatchObject({
      flags: {
        appHost: "ts",
        agentRuntime: "legacy",
        datasetCore: "python",
        piExperimental: false,
      },
      publicHost: "127.0.0.1",
      publicPort: 5173,
      legacyPrivatePort: 8000,
    });
    expect(() => parseHostConfig({ APP_HOST: "fastapi" })).toThrow(/APP_HOST=ts/);
  });
});
