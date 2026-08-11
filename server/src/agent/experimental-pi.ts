import type { IncomingMessage, ServerResponse } from "node:http";

import {
  BioMedAgentError,
  type BioMedAgentAdapter,
  type BioMedAgentEvent,
  type BioMedAgentSession,
  type BioMedAgentTool,
} from "./contracts.js";
import { SessionRegistry } from "./session-registry.js";

export interface ExperimentalPiRuntime {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
  close(): Promise<void>;
}

export interface ExperimentalPiRuntimeOptions {
  adapter: BioMedAgentAdapter;
  workspaceFactory: (identity: {
    taskId: string;
    runId: string;
  }) => Promise<{
    root: string;
    tools: readonly BioMedAgentTool[];
    dispose(): Promise<void>;
  }>;
}

interface JsonBody {
  task_id?: unknown;
  run_id?: unknown;
  input?: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new BioMedAgentError(
        "INVALID_SESSION_CONFIG",
        "Experimental request body is too large",
      );
    }
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as JsonBody;
  } catch (error) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      "Experimental request body must be valid JSON",
      { cause: error },
    );
  }
}

function requireString(body: JsonBody, field: keyof JsonBody): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

async function collect(events: AsyncIterable<BioMedAgentEvent>): Promise<BioMedAgentEvent[]> {
  const values: BioMedAgentEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function errorStatus(error: BioMedAgentError): number {
  if (error.code === "DUPLICATE_RUN" || error.code === "SESSION_BUSY") return 409;
  if (error.code === "RUN_NOT_FOUND") return 404;
  if (error.code === "INVALID_CONFIGURATION") return 503;
  if (error.code === "UPSTREAM_FAILURE") return 502;
  return 400;
}

export async function createOptionalExperimentalPiRuntime(
  enabled: boolean,
  factory: () => Promise<ExperimentalPiRuntime>,
): Promise<ExperimentalPiRuntime | undefined> {
  return enabled ? factory() : undefined;
}

export async function createExperimentalPiRuntime(
  options: ExperimentalPiRuntimeOptions,
): Promise<ExperimentalPiRuntime> {
  const registry = new SessionRegistry(options.adapter);
  const workspaceDisposals = new Map<string, () => Promise<void>>();

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://application-host");
      if (request.method === "POST" && url.pathname === "/experimental/pi/sessions") {
        const body = await readJsonBody(request);
        const taskId = requireString(body, "task_id");
        const runId = requireString(body, "run_id");
        const input = requireString(body, "input");
        const workspace = await options.workspaceFactory({ taskId, runId });
        let disposePromise: Promise<void> | undefined;
        const cleanup = (): Promise<void> => {
          workspaceDisposals.delete(runId);
          disposePromise ??= workspace.dispose();
          return disposePromise;
        };
        workspaceDisposals.set(runId, cleanup);
        let session: BioMedAgentSession;
        try {
          session = await registry.create({
            taskId,
            runId,
            cwd: workspace.root,
            tools: workspace.tools,
            cleanup,
          });
        } catch (error) {
          await cleanup();
          throw error;
        }
        const events = await collect(session.run(input));
        sendJson(response, 201, {
          task_id: taskId,
          run_id: runId,
          pi_session_id: session.piSessionId,
          events,
          durable: false,
        });
        return;
      }
      const turnMatch = /^\/experimental\/pi\/sessions\/([^/]+)\/turns$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && turnMatch !== null) {
        const runId = decodeURIComponent(turnMatch[1] ?? "");
        const session = registry.get(runId);
        if (session === undefined) {
          throw new BioMedAgentError(
            "RUN_NOT_FOUND",
            `No session exists for run ${runId}`,
          );
        }
        const body = await readJsonBody(request);
        const events = await collect(session.run(requireString(body, "input")));
        sendJson(response, 200, {
          task_id: session.taskId,
          run_id: session.runId,
          pi_session_id: session.piSessionId,
          events,
          durable: false,
        });
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not Found" } });
    } catch (error) {
      const bounded =
        error instanceof BioMedAgentError
          ? error
          : new BioMedAgentError(
              "UPSTREAM_FAILURE",
              "Experimental Pi request failed",
              { cause: error },
            );
      sendJson(response, errorStatus(bounded), {
        error: { code: bounded.code, message: bounded.message },
      });
    }
  }

  return {
    handle(request, response) {
      const pathname = new URL(
        request.url ?? "/",
        "http://application-host",
      ).pathname;
      if (
        pathname !== "/experimental/pi" &&
        !pathname.startsWith("/experimental/pi/")
      ) {
        return false;
      }
      void dispatch(request, response);
      return true;
    },
    close: async () => {
      let registryError: unknown;
      try {
        await registry.disposeAll();
      } catch (error) {
        registryError = error;
      }
      const results = await Promise.allSettled(
        [...workspaceDisposals.values()].map((dispose) => dispose()),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (registryError !== undefined) errors.unshift(registryError);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Experimental Pi Workspace cleanup failed");
      }
    },
  };
}
