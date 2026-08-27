/**
 * Offline (CI-safe) unit tests for the Gold acquisition diagnostics:
 * fine-grained transport failure classification, per-plan large-carrier
 * timeout budgets, and the per-binding diagnostics attached to
 * CoreAcquisitionError. Live provider reachability lives in
 * phase5/provider-live-smoke.test.ts behind BIOMED_LIVE_SMOKE=1.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CoreAcquisitionError,
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
} from "../src/dataset/acquisition/runtime.js";
import {
  GOLD9_IMPLEMENTATION_DIGESTS,
  GOLD9_PROVIDER_IDS,
  createGold9AcquisitionProviders,
} from "../src/dataset/acquisition/gold9-providers.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient, type RequestExecutor } from "../src/external/network/http-client.js";
import { classifyTransportFailure, httpFailureCode } from "../src/external/network/errors.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("transport failure classification", () => {
  it("maps Node errnos to fine-grained codes through the cause chain", () => {
    const errno = (code: string, message: string): Error & { code: string } =>
      Object.assign(new Error(message), { code }) as Error & { code: string };
    expect(classifyTransportFailure(errno("ENOTFOUND", "getaddrinfo ENOTFOUND x.test"))).toBe("dns_failure");
    expect(classifyTransportFailure(errno("EAI_AGAIN", "dns lookup EAI_AGAIN"))).toBe("dns_failure");
    expect(classifyTransportFailure(errno("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"))).toBe("connect_refused");
    expect(classifyTransportFailure(errno("ETIMEDOUT", "connect ETIMEDOUT"))).toBe("connect_timeout");
    expect(classifyTransportFailure(errno("EHOSTUNREACH", "no route"))).toBe("connect_timeout");
    expect(classifyTransportFailure(errno("ECONNRESET", "read ECONNRESET"))).toBe("connection_reset");
    expect(classifyTransportFailure(errno("EPIPE", "write EPIPE"))).toBe("connection_reset");
    expect(classifyTransportFailure(errno("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "cert chain"))).toBe("tls_failure");
    expect(classifyTransportFailure(errno("ERR_TLS_CERT_ALTNAME_INVALID", "hostname mismatch"))).toBe("tls_failure");
    expect(classifyTransportFailure(errno("CERT_HAS_EXPIRED", "expired"))).toBe("tls_failure");
    const wrapped = new Error("fetch failed", { cause: errno("ENOTFOUND", "getaddrinfo") });
    expect(classifyTransportFailure(wrapped)).toBe("dns_failure");
  });

  it("returns null for non-transport errnos so callers keep internal_error", () => {
    const fsError = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    expect(classifyTransportFailure(fsError)).toBeNull();
    expect(classifyTransportFailure(new Error("plain"))).toBeNull();
    expect(classifyTransportFailure(null)).toBeNull();
  });

  it("splits HTTP statuses into retryable server vs deterministic client failures", () => {
    expect(httpFailureCode(500)).toBe("http_server_error");
    expect(httpFailureCode(503)).toBe("http_server_error");
    expect(httpFailureCode(408)).toBe("http_server_error");
    expect(httpFailureCode(429)).toBe("http_server_error");
    expect(httpFailureCode(404)).toBe("http_client_error");
    expect(httpFailureCode(405)).toBe("http_client_error");
  });
});

describe("Gold9 Orphanet large-carrier timeout budget", () => {
  it("plans explicit wall-clock budgets for both Orphanet products", async () => {
    const providers = new Map(createGold9AcquisitionProviders().map((provider) => [provider.providerId, provider]));
    const request = (providerId: string): CoreAcquisitionRequest => ({
      schema_version: "1.0",
      request_id: `request_budget_${providerId}`,
      task_id: "task_budget",
      requirement_id: "req_budget",
      binding_id: "binding_orphanet",
      mode: "builtin",
      provider_id: providerId,
      recipe_id: null,
      recipe_version: null,
      parameters: {
        source: providerId === GOLD9_PROVIDER_IDS.orphanetProduct1 ? "orphanet_en_product1" : "orphanet_en_product6",
        accession: providerId === GOLD9_PROVIDER_IDS.orphanetProduct1 ? "en_product1" : "en_product6",
        entities: {},
      },
    });
    const product1 = await providers.get(GOLD9_PROVIDER_IDS.orphanetProduct1)!.plan(request(GOLD9_PROVIDER_IDS.orphanetProduct1));
    expect(product1.timeoutMs).toBe(45 * 60_000);
    const product6 = await providers.get(GOLD9_PROVIDER_IDS.orphanetProduct6)!.plan(request(GOLD9_PROVIDER_IDS.orphanetProduct6));
    expect(product6.timeoutMs).toBe(20 * 60_000);
    // The budgets must be smaller than the 256 MB plan cap context and, above
    // all, larger than the measured worst-case transfer time (~35 min).
    expect(product1.timeoutMs!).toBeGreaterThan(35 * 60_000);
    expect(GOLD9_IMPLEMENTATION_DIGESTS.orphanetProduct1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps other Gold9 providers on the default HTTP timeout", async () => {
    const providers = new Map(createGold9AcquisitionProviders().map((provider) => [provider.providerId, provider]));
    const hgnc = await providers.get(GOLD9_PROVIDER_IDS.hgncApproved)!.plan({
      schema_version: "1.0",
      request_id: "request_budget_hgnc",
      task_id: "task_budget",
      requirement_id: "req_budget",
      binding_id: "binding_hgnc",
      mode: "builtin",
      provider_id: GOLD9_PROVIDER_IDS.hgncApproved,
      recipe_id: null,
      recipe_version: null,
      parameters: { source: "hgnc_approved", accession: "current", entities: {} },
    });
    expect(hgnc.timeoutMs).toBeUndefined();
  });
});

describe("CoreAcquisitionError per-binding diagnostics", () => {
  async function failingRuntime(executor: RequestExecutor): Promise<CoreAcquisitionRuntime> {
    const root = await mkdtemp(path.join(os.tmpdir(), "acq-diag-"));
    roots.push(root);
    const registry = new CoreAcquisitionRegistry();
    for (const provider of createGold9AcquisitionProviders()) registry.registerProvider(provider);
    const assets = new SourceAssetRegistry("task_diag", root);
    return new CoreAcquisitionRuntime({
      taskId: "task_diag",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], executor }),
      sourceAssetRegistry: assets,
      registry,
      maxAttempts: 2,
    });
  }

  const request = (): CoreAcquisitionRequest => ({
    schema_version: "1.0",
    request_id: "request_diag",
    task_id: "task_diag",
    requirement_id: "req_diag",
    binding_id: "binding_hgnc",
    mode: "builtin",
    provider_id: GOLD9_PROVIDER_IDS.hgncApproved,
    recipe_id: null,
    recipe_version: null,
    parameters: { source: "hgnc_approved", accession: "current", entities: {} },
  });

  it("attaches binding/provider/host/elapsed to a DNS-classified failure", async () => {
    const runtime = await failingRuntime(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND ftp.ensembl.org"), { code: "ENOTFOUND" });
    });
    const failure = await runtime.acquire(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreAcquisitionError);
    const details = (failure as CoreAcquisitionError).details;
    expect(details.error_code).toBe("dns_failure");
    expect(details.provider_id).toBe(GOLD9_PROVIDER_IDS.hgncApproved);
    expect(details.binding_id).toBe("binding_hgnc");
    expect(details.endpoint_host).toBe("storage.googleapis.com");
    expect(details.url).toContain("hgnc_complete_set.txt");
    expect(typeof details.elapsed_ms).toBe("number");
    expect(details.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(details.timeout_stage).toBeNull();
  });

  it("marks the wall-clock stage on timeout failures", async () => {
    const runtime = await failingRuntime(async () => {
      throw Object.assign(new Error("HTTP request timed out after 300ms"), { name: "TimeoutError" });
    });
    const failure = await runtime.acquire(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreAcquisitionError);
    const details = (failure as CoreAcquisitionError).details;
    expect(details.error_code).toBe("timeout");
    expect(details.timeout_stage).toBe("wall_clock");
    expect(details.binding_id).toBe("binding_hgnc");
  });
});
