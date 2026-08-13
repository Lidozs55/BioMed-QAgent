import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  PHASE1_SYSTEM_PROMPT,
  phase1ResourceRoots,
} from "../src/agent/phase1-prompt.js";
import {
  FIXTURE_PROFILES,
  createFixtureProfileAdapter,
} from "../src/agent/fixture-profile.js";
import type {
  BioMedAgentAdapter,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import { createExperimentalPiRuntime } from "../src/agent/experimental-pi.js";
import { PHASE1_SYSTEM_PROMPT as EXPECTED_PROMPT } from "../src/agent/phase1-prompt.js";
import { PiAgentAdapter, type PiUpstreamSession } from "../src/agent/pi-adapter.js";

describe("Phase 1F prompt and migration resources", () => {
  test("keeps the system prompt to the five frozen authority constraints", () => {
    expect(PHASE1_SYSTEM_PROMPT).toContain("Dataset Core");
    expect(PHASE1_SYSTEM_PROMPT).toContain("staging/agent/");
    expect(PHASE1_SYSTEM_PROMPT).toContain("validate_dataset_build");
    expect(PHASE1_SYSTEM_PROMPT).toContain("execute_dataset_build");
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/NO_DATA.*rejection.*cancellation.*failure/s);
    expect(PHASE1_SYSTEM_PROMPT).toContain("governed Task Workspace");
    expect(PHASE1_SYSTEM_PROMPT).not.toMatch(/GEO|GDC|Xena|research strategy/i);
  });

  test("ships the curated Phase 2 skill set (dataset-construction plus migrated SOP skills)", async () => {
    const roots = phase1ResourceRoots();
    const dataset = await readFile(
      `${roots.skillRoot}/dataset-construction/SKILL.md`,
      "utf8",
    );
    const geo = await readFile(`${roots.skillRoot}/geo/SKILL.md`, "utf8");

    expect(dataset).toMatch(/validate_dataset_build.*execute_dataset_build/is);
    expect(dataset).toMatch(/Publication.*formal output/is);
    expect(geo).toMatch(/describe_geo/);
    expect(geo).toMatch(/vetting/i);
    expect(geo).not.toMatch(/find_skill|invoke_skill/i);
  });

  test("the Pi boundary alone composes prompt/Skills and bounds missing optional resources", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "phase1f-missing-skill-"));
    const diagnostics: string[] = [];
    let received: BioMedSessionConfig | undefined;
    const upstream: PiUpstreamSession = {
      sessionId: "pi-prompt",
      prompt: async () => undefined,
      subscribe: () => () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
    };
    try {
      const adapter = new PiAgentAdapter({
        phase1SkillRoot: missingRoot,
        onResourceDiagnostic: (message) => diagnostics.push(message),
        createUpstreamSession: async (config) => {
          received = config;
          return upstream;
        },
      });
      const session = await adapter.createSession({
        taskId: "task-prompt",
        runId: "run-prompt",
        cwd: process.cwd(),
      });

      expect(received?.systemPrompt).toBe(EXPECTED_PROMPT);
      expect(received?.skillRoots).toEqual([]);
      expect(diagnostics.join(" ")).toMatch(/optional.*Skill.*unavailable/i);
      await session.dispose();
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }
  });
});

describe("Phase 1F fixture profile selection", () => {
  test("exposes a finite explicit allowlist and never aliases a normal request", () => {
    expect(Object.keys(FIXTURE_PROFILES).sort()).toEqual([
      "dataset_success",
      "spec_rejected",
      "workspace",
      "workspace_cancel",
    ]);
    expect(createFixtureProfileAdapter(undefined)).toBeUndefined();
    expect(createFixtureProfileAdapter(null)).toBeUndefined();
    expect(() => createFixtureProfileAdapter("unknown")).toThrow(/fixture_profile/);
  });

  test("selects an offline adapter only for an explicit fixture_profile", async () => {
    class RecordingAdapter implements BioMedAgentAdapter {
      readonly configs: BioMedSessionConfig[] = [];
      constructor(private readonly prefix: string) {}
      async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        this.configs.push(config);
        return {
          piSessionId: `${this.prefix}-${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          async *run() {
            yield { type: "turn_started" as const };
            yield { type: "turn_completed" as const };
          },
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
      }
    }
    const normal = new RecordingAdapter("normal");
    const fixture = new RecordingAdapter("fixture");
    const values = ["normal-task", "normal-run", "fixture-task", "fixture-run"];
    const runtime = await createExperimentalPiRuntime({
      adapter: normal,
      fixtureProfileAdapter: (profile) => {
        if (profile !== "workspace") throw new Error("unsupported fixture_profile");
        return fixture;
      },
      id: () => values.shift() ?? "extra",
      workspaceFactory: async ({ fixtureProfile }) => ({
        root: process.cwd(),
        tools: [],
        fixtureProfile,
        dispose: async () => undefined,
      }),
    });
    const server = createServer((request, response) => runtime.handle(request, response));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const regular = await fetch(`http://127.0.0.1:${port}/experimental/pi/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "normal" }),
      });
      const offline = await fetch(`http://127.0.0.1:${port}/experimental/pi/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "offline", fixture_profile: "workspace" }),
      });

      expect((await regular.json()) as object).toMatchObject({
        session_id: "normal-task_normal-task",
      });
      expect((await offline.json()) as object).toMatchObject({
        session_id: "fixture-task_fixture-task",
      });
      expect(normal.configs).toHaveLength(1);
      expect(fixture.configs).toHaveLength(1);
    } finally {
      await runtime.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
