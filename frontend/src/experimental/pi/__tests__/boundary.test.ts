import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const modules = [
  "../ExperimentalPiApp.tsx",
  "../client.ts",
  "../config.ts",
  "../state.ts",
  "../transport.ts",
] as const;

describe("experimental Pi frontend boundary", () => {
  test("does not import the legacy controller, transport, reducer, or store", () => {
    const source = modules
      .map((module) => readFileSync(new URL(module, import.meta.url), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/@\/runtime\/(?:controller|transport|reducer)/);
    expect(source).not.toContain("@/stores/agentStore");
    expect(source).not.toContain("useAgentStream");
    expect(source).not.toContain("after_sequence");
  });
});
