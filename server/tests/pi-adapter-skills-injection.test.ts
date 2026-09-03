import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { BioMedModelConfig } from "../src/agent/contracts.js";
import {
  canonicalSkillRoots,
  curateSkillsOverride,
  PiAgentAdapter,
  PiBioMedAgentSession,
  SKILL_READ_TOOL_NAME,
  skillReadToolDefinition,
} from "../src/agent/pi-adapter.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Offline provider registration only: the session is never prompted, so the
 * endpoint is never contacted. This keeps the test a real Pi-session
 * integration test (real resource loader, real system prompt build) without
 * any network dependency.
 */
const PROBE_MODEL: BioMedModelConfig = {
  provider: "biomed-skill-injection-probe",
  modelId: "probe-model",
  apiKey: "probe-key",
  baseUrl: "http://127.0.0.1:9/v1",
  contextWindow: 131_072,
  maxTokens: 8_192,
};

const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function fixtureSkill(dir: string, name: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\n# ${name}\n`,
  );
}

describe("curated skill filtering (skillsOverride)", () => {
  test("keeps only skills under the curated roots and drops foreign roots", () => {
    const curated = curateSkillsOverride(["/opt/curated/skills"]);
    const skillAt = (baseDir: string) => ({
      name: path.basename(baseDir),
      description: "",
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      sourceInfo: {} as never,
      disableModelInvocation: false,
    });
    const result = curated({
      skills: [
        skillAt("/opt/curated/skills/geo"),
        skillAt("/opt/curated/skills/nested/pubmed"),
        skillAt("/home/user/.agents/skills/bailian-cli"),
        skillAt("/repo/.agents/skills/shadcn"),
      ],
      diagnostics: [],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(["geo", "pubmed"]);
  });

  test("canonicalSkillRoots keeps both resolved and realpath forms", () => {
    const roots = canonicalSkillRoots([path.join(repositoryRoot, ".pi", "skills")]);
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.every((root) => path.isAbsolute(root))).toBe(true);
  });
});

describe("skill read tool", () => {
  test("reads documents inside the skill roots and rejects everything else", async () => {
    const root = await tempDir("biomed-skill-root-");
    const doc = path.join(root, "geo", "SKILL.md");
    await mkdir(path.join(root, "geo"), { recursive: true });
    await writeFile(doc, "---\nname: geo\ndescription: GEO skill.\n---\n# geo\n");

    const read = skillReadToolDefinition([root]);
    expect(read.name).toBe(SKILL_READ_TOOL_NAME);

    const allowed = await read.execute(
      "call-1",
      { path: doc },
      undefined,
      undefined,
      undefined as never,
    );
    expect(allowed.content.some((block) => block.type === "text" && block.text.includes("# geo")))
      .toBe(true);

    await expect(read.execute(
      "call-2",
      { path: path.join(repositoryRoot, "AGENTS.md") },
      undefined,
      undefined,
      undefined as never,
    )).rejects.toThrow(/curated skill documents/u);

    await expect(read.execute(
      "call-3",
      { path: path.join(root, "geo", "..", "..", "escape.md") },
      undefined,
      undefined,
      undefined as never,
    )).rejects.toThrow(/curated skill documents/u);
  });

  test("rejects symlinks that resolve outside the roots", async () => {
    const root = await tempDir("biomed-skill-root-");
    const outside = await tempDir("biomed-outside-");
    const secret = path.join(outside, "secret.md");
    await writeFile(secret, "secret");
    await mkdir(path.join(root, "linked"), { recursive: true });
    await writeFile(
      path.join(root, "linked", "SKILL.md"),
      "---\nname: linked\ndescription: links out.\n---\n",
    );
    const { symlink } = await import("node:fs/promises");
    await symlink(secret, path.join(root, "linked", "escape.md"));

    const read = skillReadToolDefinition([root]);
    await expect(read.execute(
      "call-escape",
      { path: path.join(root, "linked", "escape.md") },
      undefined,
      undefined,
      undefined as never,
    )).rejects.toThrow(/outside the curated skill roots/u);
  });
});

describe("real Pi session skill injection (integration)", () => {
  test("surfaces curated .pi/skills in the system prompt and filters foreign skills", async () => {
    // Junk skills reachable through the loader's ancestor `.agents/skills`
    // scan (project trust defaults to true for in-memory settings): without
    // curateSkillsOverride they would leak into the listing.
    const cwd = await tempDir("biomed-skill-cwd-");
    await fixtureSkill(path.join(cwd, ".agents", "skills"), "zz-junk-fixture-skill");

    const adapter = new PiAgentAdapter();
    const session = await adapter.createSession({
      taskId: "task_skill_probe",
      runId: "run_skill_probe",
      cwd,
      model: PROBE_MODEL,
      tools: [{
        name: "inspect_dataset_execution_routes",
        label: "Inspect Dataset Core routes",
        description: "Inspect formal Dataset Core routes.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: "{}" }),
      }],
      initialToolNames: ["inspect_dataset_execution_routes"],
    });
    try {
      expect(session).toBeInstanceOf(PiBioMedAgentSession);
      const prompt = (session as PiBioMedAgentSession).systemPrompt();
      expect(prompt).not.toBeNull();

      // The Pi read-gate: the listing only renders because the confined
      // `read` tool is part of the active tool set.
      expect(prompt).toContain("<available_skills>");
      expect(prompt).toContain("<name>dataset-construction</name>");
      expect(prompt).toContain("<name>research_data_guidance</name>");
      expect(prompt).toContain("Use the read tool to load a skill's file");

      // Foreign skills must never reach the model.
      expect(prompt).not.toContain("zz-junk-fixture-skill");
      expect(prompt).not.toContain("bailian-cli");

      // The curated catalog points the model at the skills.
      expect(prompt).toContain("load that document with the read tool");
    } finally {
      await session.dispose();
    }
  }, 60_000);
});
