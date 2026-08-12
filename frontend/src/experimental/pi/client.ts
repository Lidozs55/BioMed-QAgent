import type {
  ExperimentalPiCancelAccepted,
  ExperimentalPiRunAccepted,
  ExperimentalPiTaskAccepted,
} from "@biomed/contracts";

export interface ExperimentalPiApi {
  createTask(input: string, fixtureProfile?: string | null): Promise<ExperimentalPiTaskAccepted>;
  createRun(taskId: string, input: string): Promise<ExperimentalPiRunAccepted>;
  cancelRun(taskId: string, runId: string): Promise<ExperimentalPiCancelAccepted>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ExperimentalPiClient implements ExperimentalPiApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  createTask(input: string, fixtureProfile?: string | null): Promise<ExperimentalPiTaskAccepted> {
    return this.request("/experimental/pi/tasks", {
      input,
      ...(fixtureProfile === undefined ? {} : { fixture_profile: fixtureProfile }),
    });
  }

  createRun(taskId: string, input: string): Promise<ExperimentalPiRunAccepted> {
    return this.request(
      `/experimental/pi/tasks/${encodeURIComponent(taskId)}/runs`,
      { input },
    );
  }

  cancelRun(taskId: string, runId: string): Promise<ExperimentalPiCancelAccepted> {
    return this.request(
      `/experimental/pi/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }

  private async request<T>(url: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(url, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
      const message = error === undefined ? undefined : error.message;
      throw new Error(typeof message === "string" ? message : "Experimental Pi request failed");
    }
    if (!isRecord(value)) throw new Error("Experimental Pi response is invalid");
    return value as T;
  }
}
