import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SERVER_SRC = path.join(REPOSITORY_ROOT, "server", "src");

const MODEL_ENV_TOKEN =
  /(?<![A-Z0-9_])(?:DASHSCOPE_API_KEY|DASHSCOPE_BASE_URL|PI_API_KEY|PI_BASE_URL|PI_MODEL|PI_PROVIDER|MODEL_NAME)(?![A-Z0-9_])/u;

const SETUP_AND_PACKAGING_FILES = [
  ".github/workflows/package.yml",
  "AGENTS.md",
  "README.md",
  "docs/DEVELOPER_QUICKSTART.md",
  "docs/packaging.md",
  "scripts/pack-release.mjs",
] as const;

async function collectTypeScriptSources(directory: string): Promise<string[]> {
  const sources: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...await collectTypeScriptSources(full));
    else if (entry.name.endsWith(".ts")) sources.push(full);
  }
  return sources;
}

describe("model environment removal guard", () => {
  test("the deleted env template is not restored", async () => {
    await expect(access(path.join(REPOSITORY_ROOT, ".env.example"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("active setup and packaging surfaces do not require the deleted template or model env variables", async () => {
    const violations: string[] = [];
    for (const relativePath of SETUP_AND_PACKAGING_FILES) {
      const text = await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8");
      if (text.includes(".env.example")) violations.push(`${relativePath}: deleted .env.example reference`);
      const modelEnv = MODEL_ENV_TOKEN.exec(text)?.[0];
      if (modelEnv !== undefined) violations.push(`${relativePath}: model env token ${modelEnv}`);
    }
    expect(violations).toEqual([]);
  });

  test("active server source contains no model configuration env tokens", async () => {
    const violations: string[] = [];
    for (const source of await collectTypeScriptSources(SERVER_SRC)) {
      const text = await readFile(source, "utf8");
      const modelEnv = MODEL_ENV_TOKEN.exec(text)?.[0];
      if (modelEnv !== undefined) {
        violations.push(`${path.relative(SERVER_SRC, source)}: model env token ${modelEnv}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
