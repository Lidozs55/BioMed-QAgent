import { randomUUID } from "node:crypto";

import {
  DATASET_BRIDGE_VERSION,
  parseDatasetBridgeRequest,
  parseDatasetBridgeResponse,
  type DatasetBridgeRequest,
  type DatasetBridgeResponse,
  type DatasetBuildSpec,
} from "@biomed/contracts";

import { requireLoopbackLegacyUrl } from "./backend-process.js";

const OPERATIONS_PATH = "/internal/migration/pi/dataset/operations";
const SECRET_HEADER = "x-biomed-bridge-secret";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class DatasetCoreBridgeError extends Error {
  readonly code = "bridge_unavailable" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatasetCoreBridgeError";
  }
}

export interface DatasetCoreClientOptions {
  baseUrl: string;
  secret?: string;
  fetch?: Fetch;
  requestId?: () => string;
  cancellationTimeoutMs?: number;
}

interface Identity {
  taskId: string;
  runId: string;
  signal?: AbortSignal;
}

export interface ValidateDatasetBuildInput extends Identity {
  spec: DatasetBuildSpec;
}

export interface ExecuteDatasetBuildInput extends Identity {
  spec: DatasetBuildSpec;
  sourceFiles: Record<string, string>;
  mappingFiles: Record<string, string>;
}

export interface GetBuildResultInput extends Identity {
  buildId: string;
}

export interface DatasetCoreClientLike {
  validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse>;
  execute(input: ExecuteDatasetBuildInput): Promise<DatasetBridgeResponse>;
}

function unavailable(message: string, cause?: unknown): DatasetCoreBridgeError {
  return new DatasetCoreBridgeError(message, cause === undefined ? undefined : { cause });
}

export class DatasetCoreClient implements DatasetCoreClientLike {
  private readonly baseUrl: URL;
  private readonly secret?: string;
  private readonly fetch: Fetch;
  private readonly requestId: () => string;
  private readonly cancellationTimeoutMs: number;

  constructor(options: DatasetCoreClientOptions) {
    this.baseUrl = requireLoopbackLegacyUrl(options.baseUrl);
    this.secret = options.secret;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.requestId = options.requestId ?? (() => `request_${randomUUID()}`);
    this.cancellationTimeoutMs = options.cancellationTimeoutMs ?? 10_000;
  }

  validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse> {
    return this.invoke({
      op: "validate_dataset_build_spec",
      args: { spec: input.spec },
      ...input,
    });
  }

  execute(input: ExecuteDatasetBuildInput): Promise<DatasetBridgeResponse> {
    return this.invoke({
      op: "execute_dataset_build",
      args: {
        spec: input.spec,
        source_files: input.sourceFiles,
        mapping_files: input.mappingFiles,
      },
      ...input,
    });
  }

  getBuildResult(input: GetBuildResultInput): Promise<DatasetBridgeResponse> {
    return this.invoke({
      op: "get_build_result",
      args: { build_id: input.buildId },
      ...input,
    });
  }

  private async invoke(
    input: Identity & Pick<DatasetBridgeRequest, "op" | "args">,
  ): Promise<DatasetBridgeResponse> {
    const requestId = this.requestId();
    const request = parseDatasetBridgeRequest({
      version: DATASET_BRIDGE_VERSION,
      request_id: requestId,
      task_id: input.taskId,
      run_id: input.runId,
      op: input.op,
      args: input.args,
    });
    const responsePromise = this.transportResult(
      this.fetch(new URL(OPERATIONS_PATH, this.baseUrl).toString(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
      }).then((response) => this.readResponse(response, requestId)),
    );

    if (input.signal === undefined) return responsePromise;

    let removeAbortListener = (): void => undefined;
    const abortPromise = new Promise<"aborted">((resolve) => {
      const onAbort = (): void => resolve("aborted");
      if (input.signal?.aborted === true) resolve("aborted");
      else {
        input.signal?.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => input.signal?.removeEventListener("abort", onAbort);
      }
    });
    try {
      const first = await Promise.race([
        responsePromise.then((response) => ({ kind: "response" as const, response })),
        abortPromise.then(() => ({ kind: "aborted" as const })),
      ]);
      if (first.kind === "response") return first.response;

      const cancelPromise = this.fetch(
        new URL(`${OPERATIONS_PATH}/../requests/${requestId}/cancel`, this.baseUrl).toString(),
        { method: "POST", headers: this.headers() },
      ).catch(() => undefined);
      await Promise.race([cancelPromise, this.delay(this.cancellationTimeoutMs)]);
      return await this.withTimeout(responsePromise);
    } finally {
      removeAbortListener();
    }
  }

  private headers(): Record<string, string> {
    return this.secret === undefined
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", [SECRET_HEADER]: this.secret };
  }

  private async readResponse(response: Response, requestId: string): Promise<DatasetBridgeResponse> {
    let value: unknown;
    try {
      value = await response.json();
      return parseDatasetBridgeResponse(value, requestId);
    } catch (error) {
      throw unavailable("Dataset Core bridge returned an invalid response", error);
    }
  }

  private async transportResult(
    promise: Promise<DatasetBridgeResponse>,
  ): Promise<DatasetBridgeResponse> {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof DatasetCoreBridgeError) throw error;
      throw unavailable("Dataset Core bridge is unavailable", error);
    }
  }

  private async withTimeout(
    promise: Promise<DatasetBridgeResponse>,
  ): Promise<DatasetBridgeResponse> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(unavailable("Dataset Core cancellation acknowledgement timed out")),
            this.cancellationTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
