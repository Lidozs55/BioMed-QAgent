import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { SkillIterationError, SkillIterationService } from "../src/agent/skill-iteration/service.js";
import { SKILL_TOOL_MAP } from "../src/agent/skills/skill-tool-map.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "skill-iteration-"));
  roots.push(value);
  return value;
}

async function completedTask(tasksRoot: string, input: string, assistant: string) {
  let id = 0;
  const repository = new DurableTaskRepository(tasksRoot, {
    id: () => "id_" + ++id,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  });
  const accepted = await repository.createTask({
    requestId: "request_" + id,
    input,
    databases: [],
    mode: "agent",
  });
  await repository.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_started" });
  await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
    type: "assistant_delta",
    delta: assistant,
  });
  await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
    type: "run_completed",
  });
  const snapshot = await repository.getSnapshot(accepted.task_id);
  return {
    taskId: accepted.task_id,
    userEvidenceRef: accepted.task_id + ":" + snapshot!.messages[0]!.message_id,
  };
}

async function writeSkillResources(repositoryRoot: string): Promise<string> {
  for (const mapping of SKILL_TOOL_MAP) {
    const directory = path.join(repositoryRoot, ".pi", "skills", mapping.name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      [
        "---",
        "name: " + mapping.name,
        "description: " + mapping.description,
        "---",
        "",
        "# " + mapping.name,
        mapping.tools.map((tool) => String.fromCharCode(96) + tool + String.fromCharCode(96)).join("\n"),
      ].join("\n"),
    );
  }
  const guideDirectory = path.join(
    repositoryRoot,
    "server",
    "src",
    "agent",
    "skill-iteration",
    "personalized-skill-evolver",
  );
  await mkdir(guideDirectory, { recursive: true });
  await writeFile(path.join(guideDirectory, "SKILL.md"), "Use evidence and return strict JSON.");
  return readFile(path.join(repositoryRoot, ".pi", "skills", "geo", "SKILL.md"), "utf8");
}

describe("SkillIterationService", () => {
  test("lists curated targets and terminal history", async () => {
    const repositoryRoot = await root();
    const tasksRoot = path.join(repositoryRoot, "data", "output", "tasks");
    await writeSkillResources(repositoryRoot);
    await completedTask(tasksRoot, "Prefer GEO accession evidence.", "Understood.");
    const service = new SkillIterationService({
      repositoryRoot,
      tasksRoot,
      settingsDir: path.join(repositoryRoot, "data", "settings"),
      resolveModel: async () => ({ provider: "test", modelId: "model", apiKey: "key" }),
      generate: async () => "{}",
    });

    const context = await service.context();
    expect(context.targets).toHaveLength(SKILL_TOOL_MAP.length);
    expect(context.history_tasks).toHaveLength(1);
    expect(context.history_tasks[0]?.message_count).toBe(2);
    expect(context.privacy_notice).toContain("脱敏");
  });

  test("redacts bounded history, validates evidence, and persists a review-only candidate", async () => {
    const repositoryRoot = await root();
    const tasksRoot = path.join(repositoryRoot, "data", "output", "tasks");
    const targetSkill = await writeSkillResources(repositoryRoot);
    const history = await completedTask(
      tasksRoot,
      "Keep provenance. api_key=sk-private-token-123456",
      "I will preserve source identifiers.",
    );
    let capturedPrompt = "";
    const generate = vi.fn(async ({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        summary: "Add provenance-first personalization.",
        signals: [{
          category: "data_processing",
          requirement: "Keep provenance.",
          action: "Record source identifiers at every processing stage.",
          confidence: "explicit",
          evidence_refs: [history.userEvidenceRef],
        }],
        data_processing_preferences: [{
          stage: "provenance",
          method: "Retain accession and processing method.",
          applies_when: "A source enters the processing flow.",
          verification: "Verify against the manifest.",
          evidence_refs: [history.userEvidenceRef],
        }],
        proposed_skill_markdown: targetSkill + "\n## Personalized workflow\nPreserve source identifiers.\n",
        warnings: [],
      });
    });
    const settingsDir = path.join(repositoryRoot, "data", "settings");
    const service = new SkillIterationService({
      repositoryRoot,
      tasksRoot,
      settingsDir,
      resolveModel: async () => ({
        provider: "test",
        modelId: "iteration-model",
        apiKey: "key",
      }),
      generate,
      id: () => "candidate_1",
      now: () => new Date("2026-08-24T01:00:00.000Z"),
    });

    const candidate = await service.iterate({
      schema_version: "1.0",
      target_skill: "geo",
      task_ids: [history.taskId],
      user_focus: "Prioritize reproducible GEO processing.",
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(capturedPrompt).toContain("[REDACTED_SECRET]");
    expect(capturedPrompt).not.toContain("sk-private-token");
    expect(candidate).toMatchObject({
      iteration_id: "skill_iter_candidate_1",
      status: "candidate",
      target_skill: "geo",
      model_id: "iteration-model",
      history_task_ids: [history.taskId],
      history_message_count: 2,
    });
    expect(candidate.warnings.at(-1)).toContain("未自动激活");
    expect(JSON.parse(await readFile(
      path.join(settingsDir, "skill-iterations", "skill_iter_candidate_1.json"),
      "utf8",
    ))).toMatchObject({ status: "candidate", target_skill: "geo" });
  });

  test("rejects evidence references outside the selected transcript", async () => {
    const repositoryRoot = await root();
    const tasksRoot = path.join(repositoryRoot, "data", "output", "tasks");
    const targetSkill = await writeSkillResources(repositoryRoot);
    const history = await completedTask(tasksRoot, "Use GEO.", "Okay.");
    const service = new SkillIterationService({
      repositoryRoot,
      tasksRoot,
      settingsDir: path.join(repositoryRoot, "data", "settings"),
      resolveModel: async () => ({ provider: "test", modelId: "model", apiKey: "key" }),
      generate: async () => JSON.stringify({
        summary: "summary",
        signals: [{
          category: "interaction",
          requirement: "requirement",
          action: "action",
          confidence: "explicit",
          evidence_refs: ["task_other:message_other"],
        }],
        data_processing_preferences: [],
        proposed_skill_markdown: targetSkill,
        warnings: [],
      }),
    });

    await expect(service.iterate({
      schema_version: "1.0",
      target_skill: "geo",
      task_ids: [history.taskId],
      user_focus: "",
    })).rejects.toEqual(expect.objectContaining<Partial<SkillIterationError>>({
      status: 502,
    }));
  });

  test("rejects a candidate that introduces a new path or API surface", async () => {
    const repositoryRoot = await root();
    const tasksRoot = path.join(repositoryRoot, "data", "output", "tasks");
    const targetSkill = await writeSkillResources(repositoryRoot);
    const history = await completedTask(tasksRoot, "Use GEO.", "Okay.");
    const service = new SkillIterationService({
      repositoryRoot,
      tasksRoot,
      settingsDir: path.join(repositoryRoot, "data", "settings"),
      resolveModel: async () => ({ provider: "test", modelId: "model", apiKey: "key" }),
      generate: async () => JSON.stringify({
        summary: "summary",
        signals: [],
        data_processing_preferences: [],
        proposed_skill_markdown: targetSkill + "\nUse /new/control-plane.\n",
        warnings: [],
      }),
    });

    await expect(service.iterate({
      schema_version: "1.0",
      target_skill: "geo",
      task_ids: [history.taskId],
      user_focus: "",
    })).rejects.toEqual(expect.objectContaining<Partial<SkillIterationError>>({
      status: 502,
      message: expect.stringContaining("outside the current Skill"),
    }));
  });
});
