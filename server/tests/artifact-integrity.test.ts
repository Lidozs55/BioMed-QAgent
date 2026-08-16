import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import {
  DiskWorkspaceManager,
} from "../src/agent/workspace/index.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";
import { packageDigest, type ManifestArtifactEntry } from "../src/dataset/publish/manifest.js";

const roots: string[] = [];

function immediateAdapter(): BioMedAgentAdapter {
  return {
    async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
      return {
        piSessionId: `pi_${config.taskId}`,
        taskId: config.taskId,
        runId: config.runId,
        run: async function* run(): AsyncIterable<BioMedAgentEvent> {
          yield { type: "turn_completed" };
        },
        cancel: async () => undefined,
        dispose: async () => undefined,
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "biomed-artifact-integrity-"));
  roots.push(base);
  const tasksRoot = path.join(base, "output", "tasks");
  const workspacesRoot = path.join(base, "workspaces");
  await mkdir(tasksRoot, { recursive: true });
  const workspaceManager = new DiskWorkspaceManager({ workspacesRoot });
  const runtime = await createDurableAgentRuntime({
    tasksRoot,
    workspaceManager,
    adapter: immediateAdapter(),
    workspaceFactory: async ({ taskId }) => ({
      root: await workspaceManager.ensure(taskId),
      tools: [],
      dispose: async () => undefined,
    }),
  });
  const server: Server = createServer((request, response) => {
    if (!runtime.handle(request, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, tasksRoot, workspacesRoot, runtime, server, baseUrl };
}

function manifestJson(options: {
  taskId: string;
  buildId: string;
  manifestId?: string;
  artifacts: Array<{
    artifact_id: string;
    role: string;
    relative_path: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
  }>;
  sha256?: string;
}): string {
  const digest = options.sha256 ?? packageDigest(options.artifacts.map((entry): ManifestArtifactEntry => ({
    schema_version: "1.0",
    artifact_id: entry.artifact_id,
    role: entry.role as ManifestArtifactEntry["role"],
    relative_path: entry.relative_path,
    media_type: entry.media_type,
    size_bytes: entry.size_bytes,
    sha256: entry.sha256,
  })));
  return JSON.stringify({
    manifest_id: options.manifestId ?? `manifest_${digest.slice(0, 16)}`,
    task_id: options.taskId,
    build_id: options.buildId,
    sha256: digest,
    artifacts: options.artifacts,
  });
}

/** Write publication.json bound to the manifest FILE BYTES (P7 receipt). */
async function writePublication(
  publicationDir: string,
  manifest: { manifest_id: string },
): Promise<void> {
  const manifestBytes = await readFile(path.join(publicationDir, "dataset_manifest.json"));
  await writeFile(path.join(publicationDir, "publication.json"), JSON.stringify({
    publication_id: "publication_one",
    schema_version: "1.1",
    manifest_ref: manifest.manifest_id,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  }), "utf8");
}

async function createTask(baseUrl: string, requestId: string): Promise<{ task_id: string }> {
  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      input: `integrity ${requestId}`,
      databases: [],
      mode: "agent",
    }),
  });
  expect(created.status).toBe(202);
  return await created.json() as { task_id: string };
}

describe("publication integrity hardening (P7)", () => {
  test("an agent workspace file never becomes a Publication automatically", async () => {
    const { baseUrl, runtime, server, workspacesRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_workspace");

    // The agent writes an arbitrary file (even one named like an artifact)
    // into its own workspace.
    const workspaceRoot = path.join(workspacesRoot, taskId);
    await mkdir(path.join(workspaceRoot, "results"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "results", "primary.csv"), "gene_id,value\nTP53,1\n", "utf8");
    await writeFile(path.join(workspaceRoot, "dataset_manifest.json"), "{}", "utf8");

    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ artifacts: [], degraded: false });

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("published artifacts are manifest-registered and hash-verified on every read", async () => {
    const { baseUrl, runtime, server, tasksRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_publish");

    // Simulate the Dataset Core publication path (the ONLY way artifacts
    // appear): manifest + publication.json under the task output.
    const primary = "gene_id,value\nTP53,1\n";
    const sha256 = createHash("sha256").update(primary).digest("hex");
    const publicationDir = path.join(
      tasksRoot,
      taskId,
      "datasets_build",
      "build_one",
      "publish",
      "version_1",
    );
    await mkdir(path.join(publicationDir, "merged"), { recursive: true });
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), primary, "utf8");
    const manifest = JSON.parse(manifestJson({
      taskId,
      buildId: "build_one",
      artifacts: [{
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: Buffer.byteLength(primary),
        sha256,
      }],
    })) as { manifest_id: string };
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");
    await writePublication(publicationDir, manifest);

    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    const listed = await listing.json() as { artifacts: Array<{ artifact_id: string }> };
    expect(listed.artifacts.map((artifact) => artifact.artifact_id)).toContain("artifact_primary");

    // Trust comes from Core + Manifest + Hash (plan §24): a mutation made
    // behind the framework's back (e.g. via allowed process.exec) is detected.
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), "corrupt", "utf8");
    const download = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts/artifact_primary`);
    expect(download.status).toBe(409);
    const body = await download.json() as { detail: string };
    expect(body.detail).toMatch(/integrity/i);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("tampering that rewrites the manifest entry without recomputing the package digest is detected", async () => {
    const { baseUrl, runtime, server, tasksRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_manifest_tamper");

    // Publish a valid publication, then simulate a same-account tamper:
    // the artifact bytes AND its manifest entry (sha256/size) are both
    // rewritten, but the manifest's own package digest / manifest_id are
    // left stale. The reader must recompute the digest from the entries
    // and reject the publication (ADR-026 §3).
    const primary = "gene_id,value\nTP53,1\n";
    const tampered = "gene_id,value\nBRCA1,1\n";
    const sha256 = createHash("sha256").update(primary).digest("hex");
    const publicationDir = path.join(
      tasksRoot,
      taskId,
      "datasets_build",
      "build_one",
      "publish",
      "version_1",
    );
    await mkdir(path.join(publicationDir, "merged"), { recursive: true });
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), primary, "utf8");
    const manifest = JSON.parse(manifestJson({
      taskId,
      buildId: "build_one",
      artifacts: [{
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: Buffer.byteLength(primary),
        sha256,
      }],
    })) as {
      manifest_id: string;
      sha256: string;
      artifacts: Array<{ sha256: string; size_bytes: number }>;
    };
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");
    await writePublication(publicationDir, manifest);

    // Tamper: swap the file content and mirror the new hash/size in the
    // manifest entry — but keep manifest_id and sha256 stale.
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), tampered, "utf8");
    manifest.artifacts[0].sha256 = createHash("sha256").update(tampered).digest("hex");
    manifest.artifacts[0].size_bytes = Buffer.byteLength(tampered);
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");

    const download = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts/artifact_primary`);
    expect(download.status).toBe(409);
    const body = await download.json() as { detail: string };
    expect(body.detail).toMatch(/manifest|hash|digest|integrity/i);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a fully consistent rewrite is outside the same-account trust boundary (ADR-026 §3)", async () => {
    const { baseUrl, runtime, server, tasksRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_forge");

    // An actor with full OS-account write access (Full Access + process.exec)
    // can recompute the whole package digest and rewrite manifest_id +
    // publication.json consistently. ADR-026 §3 documents this boundary:
    // the reader guarantees detection of accidental/partial tampering, not
    // defense against deliberate same-account rewriting.
    const forged = "gene_id,value\nMYC,1\n";
    const sha256 = createHash("sha256").update(forged).digest("hex");
    const publicationDir = path.join(
      tasksRoot,
      taskId,
      "datasets_build",
      "build_one",
      "publish",
      "version_1",
    );
    await mkdir(path.join(publicationDir, "merged"), { recursive: true });
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), forged, "utf8");
    const manifest = JSON.parse(manifestJson({
      taskId,
      buildId: "build_one",
      artifacts: [{
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: Buffer.byteLength(forged),
        sha256,
      }],
    })) as { manifest_id: string };
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");
    await writePublication(publicationDir, manifest);

    const download = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts/artifact_primary`);
    expect(download.status).toBe(200);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("tampering with manifest top-level metadata is detected by the manifest file hash (P7 receipt)", async () => {
    const { baseUrl, runtime, server, tasksRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_meta_tamper");

    // Publish a valid publication, then edit ONLY manifest top-level metadata
    // (validation_summary.status) — packageDigest() hashes only the artifact
    // entries, so this tamper would pass the digest check; the publication
    // receipt binds the manifest FILE BYTES instead and must reject it.
    const primary = "gene_id,value\nTP53,1\n";
    const sha256 = createHash("sha256").update(primary).digest("hex");
    const publicationDir = path.join(
      tasksRoot,
      taskId,
      "datasets_build",
      "build_one",
      "publish",
      "version_1",
    );
    await mkdir(path.join(publicationDir, "merged"), { recursive: true });
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), primary, "utf8");
    const manifest = JSON.parse(manifestJson({
      taskId,
      buildId: "build_one",
      artifacts: [{
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: Buffer.byteLength(primary),
        sha256,
      }],
    })) as { manifest_id: string; validation_summary?: Record<string, unknown> };
    manifest.validation_summary = { status: "passed" };
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");
    await writePublication(publicationDir, manifest);

    // Tamper: flip validation_summary WITHOUT touching artifact entries, the
    // package digest, manifest_id, or the receipt — the file bytes changed,
    // so the receipt check must fail.
    manifest.validation_summary = { status: "passed", note: "edited by attacker" };
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");

    const download = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts/dataset_manifest`);
    expect(download.status).toBe(409);
    const body = await download.json() as { detail: string };
    expect(body.detail).toMatch(/manifest|integrity/i);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("workspace files must be registered as SourceAssets to reach the Core", async () => {
    const { baseUrl, runtime, server, workspacesRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_sourceasset");
    const workspaceRoot = path.join(workspacesRoot, taskId);
    await mkdir(path.join(workspaceRoot, "raw"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "raw", "clinical.tsv"), "a\tb", "utf8");

    // The workspace file exists, but nothing in the framework output
    // references it — the pipeline never sees it as a source.
    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect((await listing.json() as { artifacts: unknown[] }).artifacts).toEqual([]);
    // source_assets (framework-owned) stays empty even though the agent
    // dropped files into its own workspace.
    const sourceAssets = path.join(tasksRootOf(workspacesRoot), taskId, "source_assets");
    await expect(import("node:fs/promises").then(({ readdir }) => readdir(sourceAssets))).rejects.toMatchObject({ code: "ENOENT" });

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a corrupt publication receipt surfaces as 409, never as a silent empty listing", async () => {
    const { baseUrl, runtime, server, workspacesRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_corrupt");
    const publicationDir = await publishSimpleBuild(workspacesRoot, taskId);

    // Corrupt the publication.json AFTER a valid publication exists: the
    // reader must fail closed (ArtifactIntegrityError → 409) instead of
    // pretending there is no publication (round-3 audit).
    await writeFile(path.join(publicationDir, "publication.json"), "{ not json", "utf8");
    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect(listing.status).toBe(409);
    const body = await listing.json() as { detail: string };
    expect(body.detail).toMatch(/publication|corrupt|integrity/i);

    // A 1.1 record whose receipt was stripped is corrupt too.
    await publishSimpleBuild(workspacesRoot, taskId);
    const raw = JSON.parse(await readFile(
      path.join(publicationDir, "publication.json"),
      "utf8",
    )) as Record<string, unknown>;
    delete raw["manifest_sha256"];
    await writeFile(path.join(publicationDir, "publication.json"), JSON.stringify(raw), "utf8");
    const again = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect(again.status).toBe(409);
    expect((await again.json() as { detail: string }).detail).toMatch(/receipt|manifest_sha256/i);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("legacy 1.0 publications stay readable at their pre-P7 trust level", async () => {
    const { baseUrl, runtime, server, workspacesRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_legacy");
    const publicationDir = await publishSimpleBuild(workspacesRoot, taskId);
    // Downgrade the record to the pre-P7 schema: no receipt, but the
    // package digest still binds the artifact entries.
    const raw = JSON.parse(await readFile(
      path.join(publicationDir, "publication.json"),
      "utf8",
    )) as Record<string, unknown>;
    delete raw["manifest_sha256"];
    raw["schema_version"] = "1.0";
    await writeFile(path.join(publicationDir, "publication.json"), JSON.stringify(raw), "utf8");

    // Legacy records remain servable (migration path, round-3 audit): the
    // reader must not silently drop pre-existing publications from the API.
    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect(listing.status).toBe(200);
    expect((await listing.json() as { artifacts: Array<{ artifact_id: string }> }).artifacts.map(
      (artifact) => artifact.artifact_id,
    )).toContain("dataset_manifest");

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function publishSimpleBuild(workspacesRoot: string, taskId: string): Promise<string> {
  // One merged artifact + manifest + 1.1 publication (mirrors the Dataset
  // Core promotion layout). Returns the publication directory.
  const { packageDigest } = await import("../src/dataset/publish/manifest.js");
  const buildDir = path.join(tasksRootOf(workspacesRoot), taskId, "datasets_build", "build_one");
  const publicationDir = path.join(buildDir, "publish", "version_1");
  await mkdir(path.join(publicationDir, "merged"), { recursive: true });
  const primary = "gene_id,value\nTP53,1\n";
  const sha256 = createHash("sha256").update(primary).digest("hex");
  await writeFile(path.join(publicationDir, "merged", "primary.csv"), primary, "utf8");
  const digest = packageDigest([{
    schema_version: "1.0",
    artifact_id: "artifact_primary",
    role: "primary_dataset",
    relative_path: "merged/primary.csv",
    media_type: "text/csv",
    size_bytes: Buffer.byteLength(primary),
    sha256,
  }]);
  const manifest = {
    manifest_id: `manifest_${digest.slice(0, 16)}`,
    task_id: taskId,
    build_id: "build_one",
    sha256: digest,
    artifacts: [{
      artifact_id: "artifact_primary",
      role: "primary_dataset",
      relative_path: "merged/primary.csv",
      media_type: "text/csv",
      size_bytes: Buffer.byteLength(primary),
      sha256,
    }],
  };
  await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify(manifest), "utf8");
  const manifestBytes = await readFile(path.join(publicationDir, "dataset_manifest.json"));
  await writeFile(path.join(publicationDir, "publication.json"), JSON.stringify({
    publication_id: "publication_one",
    schema_version: "1.1",
    manifest_ref: manifest.manifest_id,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  }), "utf8");
  return publicationDir;
}

function tasksRootOf(workspacesRoot: string): string {
  return path.join(path.dirname(workspacesRoot), "output", "tasks");
}
