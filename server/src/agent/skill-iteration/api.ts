import type { IncomingMessage, ServerResponse } from "node:http";

import type { StartSkillIterationRequest } from "@biomed/contracts";

import type { BioMedModelConfig } from "../contracts.js";
import { readJsonBody } from "../../http/body.js";
import { sendError, sendJson } from "../../http/response.js";
import { asRecord } from "../../http/validation.js";
import {
  SkillIterationError,
  SkillIterationService,
  type SkillIterationServiceOptions,
} from "./service.js";

export interface SkillIterationApiOptions {
  repositoryRoot: string;
  tasksRoot: string;
  settingsDir: string;
  resolveModel: () => Promise<BioMedModelConfig>;
  service?: Pick<SkillIterationService, "context" | "iterate">;
  generate?: SkillIterationServiceOptions["generate"];
}

function parseRequest(value: unknown): StartSkillIterationRequest {
  const object = asRecord(value);
  const taskIds = Reflect.get(object, "task_ids");
  return {
    schema_version: Reflect.get(object, "schema_version") as "1.0",
    target_skill: Reflect.get(object, "target_skill") as string,
    task_ids: Array.isArray(taskIds) ? [...taskIds] as string[] : [],
    user_focus: Reflect.get(object, "user_focus") as string,
  };
}

export function createSkillIterationApi(options: SkillIterationApiOptions): {
  handle: (request: IncomingMessage, response: ServerResponse) => boolean;
} {
  const service = options.service ?? new SkillIterationService({
    repositoryRoot: options.repositoryRoot,
    tasksRoot: options.tasksRoot,
    settingsDir: options.settingsDir,
    resolveModel: options.resolveModel,
    ...(options.generate === undefined ? {} : { generate: options.generate }),
  });

  return {
    handle(request, response) {
      const pathname = new URL(request.url ?? "/", "http://application-host").pathname;
      if (
        pathname !== "/api/v1/skill-iterations" &&
        pathname !== "/api/v1/skill-iterations/context"
      ) {
        return false;
      }
      const method = request.method ?? "GET";
      void (async () => {
        if (pathname === "/api/v1/skill-iterations/context" && method === "GET") {
          sendJson(response, 200, await service.context());
          return;
        }
        if (pathname === "/api/v1/skill-iterations" && method === "POST") {
          const controller = new AbortController();
          request.once("aborted", () => controller.abort());
          const body = parseRequest(await readJsonBody(request));
          sendJson(response, 201, await service.iterate(body, controller.signal));
          return;
        }
        sendError(response, 405, "Method not allowed");
      })().catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        if (error instanceof SkillIterationError) {
          sendError(response, error.status, error.message);
        } else if (error instanceof SyntaxError || error instanceof TypeError) {
          sendError(response, 422, "Invalid skill iteration request");
        } else {
          console.error("skill_iteration.request_failed", error);
          sendError(response, 500, "Internal server error");
        }
      });
      return true;
    },
  };
}
