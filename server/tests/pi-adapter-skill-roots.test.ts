import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import {
  PiAgentAdapter,
  type PiUpstreamSession,
} from "../src/agent/pi-adapter.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repositorySkillsRoot = path.join(repositoryRoot, ".pi", "skills");

const tempDirs: string[] = [];

beforeEach(async () => {
  tempDirs.length = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "biomed-p2-"));
  tempDirs.push(dir);
  return dir;
}

class FakeUpstream implements PiUpstreamSession {
  readonly sessionId = "pi_fake";
  readonly configs: BioMedSessionConfig[] = [];

  async prompt(): Promise<void> {
    // no-op
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async abort(): Promise<void> {
    // no-op
  }

  dispose(): void {
    // no-op
  }
}

function adapterWith(
  upstream: FakeUpstream,
  skillRoot?: string,
): { adapter: PiAgentAdapter; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const adapter = new PiAgentAdapter({
    phase1SkillRoot: skillRoot,
    createUpstreamSession: async (config) => {
      upstream.configs.push(config);
      return upstream;
    },
    onResourceDiagnostic: (message) => diagnostics.push(message),
  });
  return { adapter, diagnostics };
}

describe("PiAgentAdapter skill-root loading (Phase 2)", () => {
  test("loads the curated .pi/skills root when present", async () => {
    const cwd = await tempDir();
    const upstream = new FakeUpstream();
    const { adapter, diagnostics } = adapterWith(upstream, repositorySkillsRoot);

    const session = await adapter.createSession({
      taskId: "task_test",
      runId: "run_test",
      cwd,
    });

    expect(session.piSessionId).toBe("pi_fake");
    const config = upstream.configs[0];
    expect(config?.skillRoots).toContain(repositorySkillsRoot);
    expect(config?.systemPrompt?.length).toBeGreaterThan(0);
    expect(diagnostics).toEqual([]);
  });

  test("a missing skill root degrades gracefully and still creates the session", async () => {
    const cwd = await tempDir();
    const missing = path.join(await tempDir(), "does-not-exist");
    const upstream = new FakeUpstream();
    const { adapter, diagnostics } = adapterWith(upstream, missing);

    const session = await adapter.createSession({
      taskId: "task_test",
      runId: "run_test",
      cwd,
    });

    expect(session.piSessionId).toBe("pi_fake");
    expect(upstream.configs[0]?.skillRoots).toEqual([]);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]).toContain("unavailable");
  });

  test("caller-provided skill roots are preserved alongside the curated root", async () => {
    const cwd = await tempDir();
    const extra = await tempDir();
    const upstream = new FakeUpstream();
    const { adapter } = adapterWith(upstream, repositorySkillsRoot);

    await adapter.createSession({
      taskId: "task_test",
      runId: "run_test",
      cwd,
      skillRoots: [extra],
    });

    const config = upstream.configs[0];
    expect(config?.skillRoots).toContain(repositorySkillsRoot);
    expect(config?.skillRoots).toContain(extra);
  });

  test("injects the tool catalog and first-turn activation markers into the session prompt", async () => {
    const cwd = await tempDir();
    const upstream = new FakeUpstream();
    const { adapter } = adapterWith(upstream, repositorySkillsRoot);
    const tools = [
      {
        name: "execute_dataset_execution",
        label: "Execute DatasetExecution",
        description: "Execute through Dataset Core.",
        parameters: { type: "object" },
        execute: async () => ({ content: "{}" }),
      },
      {
        name: "lookup_gwas_catalog",
        label: "Look up GWAS Catalog",
        description: "Resolve official GWAS Catalog identifiers and records.",
        parameters: { type: "object" },
        execute: async () => ({ content: "{}" }),
      },
    ];

    await adapter.createSession({
      taskId: "task_test",
      runId: "run_test",
      cwd,
      tools,
      initialToolNames: ["execute_dataset_execution"],
    });

    const prompt = upstream.configs[0]?.systemPrompt ?? "";
    expect(prompt).toContain("Available curated skill/tool map");
    expect(prompt).toContain("execute_dataset_execution (active)");
    expect(prompt).toContain("lookup_gwas_catalog");
    expect(prompt).toContain("activate_agent_tools");
  });

  test("a file at the skill-root path degrades like a missing root", async () => {
    const cwd = await tempDir();
    const file = path.join(cwd, "SKILL.md");
    await writeFile(file, "---\nname: nope\n---\n");
    const upstream = new FakeUpstream();
    const { adapter, diagnostics } = adapterWith(upstream, file);

    const session = await adapter.createSession({
      taskId: "task_test",
      runId: "run_test",
      cwd,
    });

    expect(session.piSessionId).toBe("pi_fake");
    expect(upstream.configs[0]?.skillRoots).toEqual([]);
    expect(diagnostics.length).toBe(1);
  });
});
