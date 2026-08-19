import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHEMBL_FILES_PROVIDER_ID,
  CHEMBL_FILES_URL,
} from "../src/dataset/acquisition/chembl-provider.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient } from "../src/external/network/http-client.js";
import { createPhase3AcquisitionRuntime } from "../src/runtime/phase3-composition.js";

const roots: string[] = [];
const CONTENT = JSON.stringify({ activities: [], page_meta: { total_count: 0 } });

function request(parameters: CoreAcquisitionRequest["parameters"] = {}): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: "request_chembl",
    task_id: "task_chembl",
    build_id: "build_chembl",
    binding_id: "binding_chembl",
    mode: "builtin",
    provider_id: CHEMBL_FILES_PROVIDER_ID,
    recipe_id: null,
    recipe_version: null,
    parameters,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("acquisition-first phase3 composition", () => {
  it("registers the fixed ChEMBL provider and publishes a carrier asset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const executor = vi.fn(async ({ url }: { url: URL }) => {
      expect(url.toString()).toBe(CHEMBL_FILES_URL);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(CONTENT)),
        },
        body: (async function* (): AsyncIterable<Buffer> {
          yield Buffer.from(CONTENT);
        })(),
      };
    });
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
    });

    const result = await runtime.acquire(request());

    expect(result.sourceAsset).toMatchObject({
      task_id: "task_chembl",
      role: "carrier",
    });
    expect(result.attempts).toHaveLength(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("rejects Agent-controlled ChEMBL parameters before network access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const executor = vi.fn(async () => {
      throw new Error("must not execute");
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        executor,
      }),
    });

    await expect(runtime.acquire(request({ limit: 500 }))).rejects.toThrow(
      /parameters must be empty/,
    );
    expect(executor).not.toHaveBeenCalled();
  });
});
