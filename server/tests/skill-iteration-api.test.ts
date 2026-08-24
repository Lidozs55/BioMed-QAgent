import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createSkillIterationApi } from "../src/agent/skill-iteration/api.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("skill iteration API", () => {
  test("serves context and forwards a typed candidate request", async () => {
    const context = {
      schema_version: "1.0" as const,
      targets: [],
      history_tasks: [],
      defaults: { max_tasks: 12, max_messages_per_task: 20 },
      privacy_notice: "notice",
    };
    const candidate = {
      schema_version: "1.0" as const,
      iteration_id: "skill_iter_1",
      status: "candidate" as const,
      created_at: "2026-08-24T00:00:00Z",
      target_skill: "geo",
      source_digest: "a".repeat(64),
      model_id: "model",
      history_task_ids: ["task_1"],
      history_message_count: 2,
      summary: "summary",
      signals: [],
      data_processing_preferences: [],
      proposed_skill_markdown: "skill",
      warnings: [],
    };
    const iterate = vi.fn().mockResolvedValue(candidate);
    const api = createSkillIterationApi({
      repositoryRoot: ".",
      tasksRoot: ".",
      settingsDir: ".",
      resolveModel: async () => ({ provider: "test", modelId: "model", apiKey: "key" }),
      service: {
        context: vi.fn().mockResolvedValue(context),
        iterate,
      },
    });
    const server = createServer((request, response) => {
      if (!api.handle(request, response)) response.writeHead(404).end("Not Found");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1";

    expect(await (await fetch(base + "/skill-iterations/context")).json()).toEqual(context);
    const response = await fetch(base + "/skill-iterations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        target_skill: "geo",
        task_ids: ["task_1"],
        user_focus: "Preserve provenance.",
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(candidate);
    expect(iterate).toHaveBeenCalledWith({
      schema_version: "1.0",
      target_skill: "geo",
      task_ids: ["task_1"],
      user_focus: "Preserve provenance.",
    }, expect.any(AbortSignal));
  });
});
