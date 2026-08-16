import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  InMemoryWorkspaceAuditSink,
  WorkspacePolicyError,
  createTaskWorkspace,
} from "../src/agent/workspace/index.js";
import { createPermissionFixture } from "./helpers/permission-fixture.js";
import { canonicalizeWithAncestor } from "../src/agent/permissions/path-normalizer.js";

const roots: string[] = [];

async function fixture(options: {
  exec?: boolean;
  limits?: Record<string, number>;
  preset?: "restricted" | "ask_when_needed" | "full_access";
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-"));
  roots.push(base);
  const workspaceRoot = path.join(base, "workspace");
  const taskOutputRoot = path.join(base, "output");
  await mkdir(workspaceRoot, { recursive: true });
  await Promise.all(

    ["state", "logs", "artifacts"].map((name) =>
      mkdir(path.join(taskOutputRoot, name), { recursive: true })),

  );
  const audit = new InMemoryWorkspaceAuditSink();
  const permissionFixture = createPermissionFixture({
    taskId: "task-1",
    runId: "run-1",
    taskOutputRoot,
  });
  if (options.preset !== undefined) {
    await permissionFixture.policyStore.setPreset(options.preset);
  } else if (options.exec === true) {
    // Exec tests run real commands: grant command execution up front.
    await permissionFixture.policyStore.setPersistentExecAllow(true);
  }
  const permissions = permissionFixture.broker;
  const workspace = await createTaskWorkspace({
    taskId: "task-1",
    runId: "run-1",
    piSessionId: "pi-1",
    workspaceRoot,
    taskOutputRoot,
    dataRoot: base,
    repositoryRoot: base,
    permissions,
    audit,
    limits: options.limits,
  });
  return { base, workspaceRoot, taskOutputRoot, audit, workspace, permissionFixture };
}

async function writeNested(target: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function removeEventually(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

/**
 * Poll until ``filePath`` contains a fully written, parseable JSON array.
 * Waiting only for the file to *exist* races with the fixture child writing
 * ``pids.json``: under CI load the file can be observed half-written and
 * ``JSON.parse`` then fails with "Unexpected end of JSON input".
 */
async function waitForJson(filePath: string, timeoutMs = 30_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`timed out waiting for parseable JSON at ${filePath}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessesDead(pids: number[], timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(pids.filter(processAlive)).toEqual([]);
}

async function writeProcessTreeFixture(
  root: string,
  parentMode: "wait" | "exit-after-child-ready",
): Promise<string> {
  const childPath = path.join(root, "scripts", "child.cjs");
  const parentPath = path.join(root, "scripts", "parent.cjs");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    childPath,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync('pids.json', JSON.stringify([process.pid, grandchild.pid]));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    parentPath,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "spawn(process.execPath, ['scripts/child.cjs'], { stdio: 'ignore' });",
      parentMode === "wait"
        ? "setInterval(() => {}, 1000);"
        : "const timer = setInterval(() => { if (fs.existsSync('pids.json')) { clearInterval(timer); process.exit(0); } }, 5);",
    ].join("\n"),
    "utf8",
  );
  return "scripts/parent.cjs";
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeEventually));
});

describe("governed Task Workspace (data/workspaces/<taskId>)", () => {
  test("reads bounded UTF-8 text and reports a stable relative path", async () => {
    const { workspaceRoot, workspace } = await fixture({ limits: { maxReadBytes: 8 } });
    await writeNested(path.join(workspaceRoot, "notes", "data.txt"), "abcdefghi");

    const result = await workspace.read({ path: "notes/data.txt", offset: 2, length: 3 });
    const bounded = await workspace.read({ path: "notes/data.txt" });

    expect(result).toMatchObject({ path: "notes/data.txt", text: "cde", offset: 2 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toBe("abcdefgh");
  });

  test.each([
    "../outside.txt",
    "..\\outside.txt",
  ])("relative traversal outside the workspace goes through the permission system: %s", async (candidate) => {
    const { workspace, permissionFixture } = await fixture();
    // ``../`` escape is no longer an input error: it resolves to an absolute
    // path, classifies as project scope, and is gated by the broker
    // (ask_when_needed → ask → suspend).
    const requested = workspace.read({ path: candidate });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionFixture.broker.hasPending("run-1")).toBe(true);
    const requestId = (permissionFixture.events.at(-1) as { request_id: string }).request_id;
    await permissionFixture.broker.resolve("run-1", requestId, "deny");
    await expect(requested).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  test.each(["NUL", "notes/CON.txt"])(
    "rejects reserved path aliases: %s",
    async (candidate) => {
      const { workspace } = await fixture();
      await expect(workspace.read({ path: candidate })).rejects.toBeInstanceOf(
        WorkspacePolicyError,
      );
    },
  );

  test("in-workspace parent traversal collapses safely instead of being rejected", async () => {
    const { workspaceRoot, workspace } = await fixture();
    await writeNested(path.join(workspaceRoot, "notes", "a.txt"), "inside");
    await expect(workspace.read({ path: "notes/../notes/a.txt" })).resolves.toMatchObject({
      text: "inside",
    });
  });

  test("absolute paths enter the permission system instead of being hard-rejected", async () => {
    const external = path.join(os.tmpdir(), "biomed-perm-gate", "clinical.csv");
    const { workspace, permissionFixture } = await fixture();
    // Default ask_when_needed: an external read suspends the tool call.
    const requested = workspace.read({ path: external });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionFixture.broker.hasPending("run-1")).toBe(true);
    const requestId = (permissionFixture.events.at(-1) as { request_id: string }).request_id;
    await permissionFixture.broker.resolve("run-1", requestId, "deny");
    await expect(requested).rejects.toMatchObject({ name: "PermissionDeniedError" });

    // full_access: the same path is allowed and simply does not exist.
    const open = await fixture({ preset: "full_access" });
    await expect(open.workspace.read({ path: external })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("every workspace-relative path is freely readable (no business dir protocol)", async () => {
    const { workspaceRoot, workspace } = await fixture({ limits: { maxReadBytes: 5 } });
    await writeNested(path.join(workspaceRoot, "raw", "input.csv"), "a,b");
    await writeNested(path.join(workspaceRoot, "downloads", "clinical.tsv"), "x1y");

    await expect(workspace.read({ path: "raw/input.csv" })).resolves.toMatchObject({
      text: "a,b",
    });
    await expect(workspace.read({ path: "downloads/clinical.tsv" })).resolves.toMatchObject({
      text: "x1y",
    });
    await expect(workspace.list({ path: ".", depth: 2 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "raw/input.csv", type: "file" }),
        expect.objectContaining({ path: "downloads/clinical.tsv", type: "file" }),
      ]),
    });
  });

  test("reads tool outputs under agent_results", async () => {
    const { workspaceRoot, workspace } = await fixture();
    await mkdir(path.join(workspaceRoot, "agent_results"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "agent_results", "gdc_manifest.json"),
      '{"source":"gdc"}',
      "utf8",
    );

    await expect(workspace.read({ path: "agent_results/gdc_manifest.json" })).resolves.toMatchObject(
      { text: '{"source":"gdc"}' },
    );
    const searched = await workspace.search({ path: "agent_results", query: "gdc" });
    expect(searched.matches).toHaveLength(1);
  });

  test("searches a single file path directly", async () => {
    const { workspaceRoot, workspace } = await fixture();
    const filePath = "parsed/single.txt";
    await mkdir(path.join(workspaceRoot, "parsed"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "parsed", "single.txt"), "needle-on-line-one\nother", "utf8");

    const searched = await workspace.search({ path: filePath, query: "needle" });
    expect(searched).toMatchObject({ path: filePath, matches: [{ path: filePath, line: 1 }], filesScanned: 1 });
  });

  test("lists and searches in stable bounded order", async () => {
    const { workspaceRoot, workspace } = await fixture({
      limits: { maxListEntries: 2, maxSearchResults: 1, maxSearchLineChars: 8 },
    });
    await writeNested(path.join(workspaceRoot, "analysis", "b.txt"), "needle-long-line");
    await writeNested(path.join(workspaceRoot, "analysis", "a.txt"), "needle");
    await writeNested(path.join(workspaceRoot, "analysis", "c.txt"), "needle");

    const listed = await workspace.list({ path: "analysis", depth: 1 });
    const searched = await workspace.search({ path: "analysis", query: "needle" });

    expect(listed.entries.map((entry) => entry.path)).toEqual([
      "analysis/a.txt",
      "analysis/b.txt",
    ]);
    expect(listed.truncated).toBe(true);
    expect(searched.matches).toHaveLength(1);
    expect(searched.matches[0]).toMatchObject({ path: "analysis/a.txt", line: 1 });
    expect(searched.truncated).toBe(true);
  });

  test("a symlink escaping the workspace resolves to its canonical scope", async ({ skip }) => {
    const { workspaceRoot, workspace, permissionFixture } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "biomed-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const link = path.join(workspaceRoot, "notes", "escape");
    await mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("OS privilege policy forbids creating the link fixture");
        return;
      }
      throw error;
    }

    // The escaped target is classified external → ask → deny.
    const requested = workspace.read({ path: "notes/escape/secret.txt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionFixture.broker.hasPending("run-1")).toBe(true);
    const requestId = (permissionFixture.events.at(-1) as { request_id: string }).request_id;
    await permissionFixture.broker.resolve("run-1", requestId, "deny");
    await expect(requested).rejects.toMatchObject({ name: "PermissionDeniedError" });

    // Listing never follows the link.
    await expect(workspace.list({ path: "notes", depth: 2 })).resolves.not.toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "notes/escape/secret.txt" }),
        ]),
      }),
    );
  });

  test("writes atomically and edits anywhere inside the workspace", async () => {
    const { workspaceRoot, workspace } = await fixture({ limits: { maxWriteBytes: 12 } });
    await workspace.write({ path: "scripts/nested/value.txt", content: "old value" });
    await workspace.edit({
      path: "scripts/nested/value.txt",
      oldText: "old",
      newText: "new",
      expectedOccurrences: 1,
    });

    await expect(readFile(path.join(workspaceRoot, "scripts", "nested", "value.txt"), "utf8"))
      .resolves.toBe("new value");
    await expect(
      workspace.write({ path: "scripts/large.txt", content: "x".repeat(13) }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await writeNested(path.join(workspaceRoot, "scripts", "ambiguous.txt"), "x x");
    await expect(
      workspace.edit({
        path: "scripts/ambiguous.txt",
        oldText: "x",
        newText: "y",
        expectedOccurrences: 1,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(readFile(path.join(workspaceRoot, "scripts", "ambiguous.txt"), "utf8"))
      .resolves.toBe("x x");
  });

  test("framework-protocol names inside the workspace are ordinary files", async () => {
    // The workspace carries no business directory protocol (plan §44): a
    // file named artifacts/… inside the agent workspace is just a file.
    const { workspaceRoot, workspace } = await fixture();
    await workspace.write({ path: "artifacts/formal.txt", content: "agent file" });
    await expect(readFile(path.join(workspaceRoot, "artifacts", "formal.txt"), "utf8"))
      .resolves.toBe("agent file");
    await expect(workspace.read({ path: "artifacts/formal.txt" })).resolves.toMatchObject({
      text: "agent file",
    });
  });

  test("execution requires permission by default and is audited without secrets", async () => {
    const { audit, workspace, permissionFixture } = await fixture();
    const resultPromise = workspace.exec({
      executable: process.execPath,
      args: ["--token=secret-value"],
    });
    // Default ask_when_needed: the exec request suspends until resolved.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionFixture.broker.hasPending("run-1")).toBe(true);
    const requestId = (permissionFixture.events.at(-1) as { request_id: string }).request_id;
    await permissionFixture.broker.resolve("run-1", requestId, "deny");
    const result = await resultPromise;

    expect(result.policy).toBe("rejected");
    expect(result.stderr).toContain("Permission denied");
    expect(JSON.stringify(audit.records)).not.toContain("secret-value");
    expect(audit.records.at(-1)).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      piSessionId: "pi-1",
      operation: "exec",
      result: "rejected",
    });
  });

  test("development exec uses fixed cwd, filtered environment, no shell, and bounded output", async () => {
    const previous = process.env.BIOMED_TEST_SECRET;
    process.env.BIOMED_TEST_SECRET = "parent-secret";
    try {
      const { workspaceRoot, workspace } = await fixture({
        exec: true,
        limits: { maxExecOutputBytes: 128 },
      });
      const result = await workspace.exec({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.BIOMED_TEST_SECRET})); process.stderr.write('e'.repeat(256))",
        ],
      });

      expect(result).toMatchObject({
        exitCode: 0,
        policy: "allowed",
        timedOut: false,
        cancelled: false,
        truncated: true,
      });
      expect(result.stdout).toContain('"cwd":"[workspace]"');
      expect(result.stdout).not.toContain(workspaceRoot);
      expect(result.stdout).not.toContain("parent-secret");
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128);

      const rejected = await workspace.exec({ executable: "node & whoami", args: [] });
      expect(rejected.policy).toBe("rejected");
    } finally {
      if (previous === undefined) delete process.env.BIOMED_TEST_SECRET;
      else process.env.BIOMED_TEST_SECRET = previous;
    }
  });

  test("exec writes inside the agent-owned workspace persist (no snapshot rollback)", async () => {
    const { workspaceRoot, audit, workspace } = await fixture({ exec: true });
    await writeNested(path.join(workspaceRoot, "analysis", "formal.txt"), "formal");
    await writeNested(path.join(workspaceRoot, "scripts", ".keep"), "");
    const mutation = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('analysis/formal.txt','changed');",
      "fs.writeFileSync('scripts/allowed.txt','allowed');",
    ].join("");

    const result = await workspace.exec({ executable: process.execPath, args: ["-e", mutation] });
    expect(result).toMatchObject({ exitCode: 0, policy: "allowed" });
    expect(audit.records.at(-1)).toMatchObject({ operation: "exec", result: "success" });
    // The workspace is agent-owned (plan §3.1): command writes persist and
    // are not rolled back by any snapshot machinery.
    await expect(readFile(path.join(workspaceRoot, "analysis", "formal.txt"), "utf8"))
      .resolves.toBe("changed");
    await expect(readFile(path.join(workspaceRoot, "scripts", "allowed.txt"), "utf8"))
      .resolves.toBe("allowed");
  });

  test("timeout kills the complete child and grandchild process tree", async () => {
    const { workspaceRoot, workspace } = await fixture({ exec: true });
    const script = await writeProcessTreeFixture(workspaceRoot, "wait");
    const result = await workspace.exec({
      executable: process.execPath,
      args: [script],
      timeoutMs: 300,
    });
    const pids = await waitForJson(
      path.join(workspaceRoot, "pids.json"),
      30_000,
    ) as number[];

    expect(result).toMatchObject({ timedOut: true, cancelled: false });
    await expectProcessesDead(pids);
  });

  test("AbortSignal and workspace disposal cancel active process trees", async () => {
    const aborted = await fixture({ exec: true });
    const abortedScript = await writeProcessTreeFixture(aborted.workspaceRoot, "wait");
    const abortController = new AbortController();
    const abortedResultPromise = aborted.workspace.exec(
      { executable: process.execPath, args: [abortedScript], timeoutMs: 5_000 },
      abortController.signal,
    );
    const abortedPidsPath = path.join(aborted.workspaceRoot, "pids.json");
    const abortedPids = await waitForJson(abortedPidsPath, 30_000) as number[];
    abortController.abort();
    const abortedResult = await abortedResultPromise;
    expect(abortedResult.cancelled).toBe(true);
    expect(aborted.audit.records.at(-1)).toMatchObject({
      operation: "exec",
      result: "cancelled",
    });
    await expectProcessesDead(abortedPids);

    const disposed = await fixture({ exec: true });
    const disposedScript = await writeProcessTreeFixture(disposed.workspaceRoot, "wait");
    const disposedResultPromise = disposed.workspace.exec({
      executable: process.execPath,
      args: [disposedScript],
      timeoutMs: 5_000,
    });
    const disposedPidsPath = path.join(disposed.workspaceRoot, "pids.json");
    const disposedPids = await waitForJson(disposedPidsPath, 30_000) as number[];
    await disposed.workspace.dispose();
    const disposedResult = await disposedResultPromise;
    expect(disposedResult.cancelled).toBe(true);
    await expectProcessesDead(disposedPids);
  });

  test("normal completion cleans background descendants and audits without secrets", async () => {
    const { workspaceRoot, audit, workspace } = await fixture({ exec: true });
    const script = await writeProcessTreeFixture(workspaceRoot, "exit-after-child-ready");
    const result = await workspace.exec({
      executable: process.execPath,
      args: [script, "--token=do-not-log"],
    });
    // The descendant writes pids.json after the direct child exits; wait for
    // a fully written manifest under parallel CI load instead of racing it.
    const pidsPath = path.join(workspaceRoot, "pids.json");
    const pids = await waitForJson(pidsPath, 30_000) as number[];

    expect(result).toMatchObject({ exitCode: 0, policy: "allowed" });
    await expectProcessesDead(pids);
    expect(JSON.stringify(audit.records)).not.toContain("do-not-log");
    expect(audit.records.at(-1)).toMatchObject({ operation: "exec", result: "success" });
  });

  test("round-3 audit: the approval card shows the FULL executable path, not a basename", async () => {
    const { workspace, permissionFixture } = await fixture();
    const running = workspace.exec({
      executable: process.execPath,
      args: ["--version"],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const request = permissionFixture.events.at(-1) as { command: string } | undefined;
    expect(request?.command).toBeDefined();
    // Two different executables named python.exe must be distinguishable:
    // the command the user approves carries the canonical absolute path.
    const canonical = await canonicalizeWithAncestor(process.execPath);
    expect(request?.command).toContain(canonical);
    expect(request?.command.split(" ")[0]).not.toBe("node");
    await permissionFixture.broker.resolve(
      "run-1",
      (permissionFixture.events.at(-1) as { request_id: string }).request_id,
      "allow",
      "once",
    );
    await running;
  });

  test("round-4 audit: sanitizedCommand resolves bare names via PATH and relative paths at the workspace root", async () => {
    const { workspaceRoot } = await fixture();
    const { sanitizedCommand } = await import("../src/agent/workspace/exec.js");

    // Bare name: the card must show the REAL binary (PATH lookup), never a
    // fabricated <workspace>/name that spawn would never execute.
    const [bare] = await sanitizedCommand("node", [], workspaceRoot);
    expect(bare).not.toBe("node");
    expect(bare).not.toContain(workspaceRoot);
    expect(bare.toLowerCase()).toMatch(/node(?:\.exe)?$/u);

    // Relative path with a separator: resolved against the spawn cwd (the
    // workspace root), not the server cwd.
    const script = path.join(workspaceRoot, "scripts", "tool.py");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "print('x')", "utf8");
    const [relative] = await sanitizedCommand("./scripts/tool.py", [], workspaceRoot);
    const canonicalScript = await canonicalizeWithAncestor(script);
    expect(relative.toLowerCase()).toBe(canonicalScript.toLowerCase());

    // Unknown bare name: explicit label instead of a fake path.
    const [missing] = await sanitizedCommand("definitely-not-a-real-binary-xyz", [], workspaceRoot);
    expect(missing).toBe("definitely-not-a-real-binary-xyz (resolved via PATH)");
  });

  test("round-4 audit: stateful argv redaction covers --token value and --api-key value forms", async () => {
    const { workspaceRoot } = await fixture();
    const { sanitizedCommand } = await import("../src/agent/workspace/exec.js");
    const command = await sanitizedCommand(process.execPath, [
      "--token",
      "SECRET_ONE",
      "--api-key=SECRET_TWO",
      "--password",
      "SECRET_THREE",
      "plain.csv",
      "--token",
      "SECRET_FOUR",
    ], workspaceRoot);
    expect(command.slice(1)).toEqual([
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "plain.csv",
      "[redacted]",
      "[redacted]",
    ]);
  });

  test("workspace hash integrity: protected file bytes are untouched by policy violations", async () => {
    const { workspaceRoot, workspace } = await fixture({ preset: "restricted" });
    const target = path.join(workspaceRoot, "notes", "keep.txt");
    await writeNested(target, "keep me");
    const before = createHash("sha256").update(await readFile(target)).digest("hex");

    // ``../`` now resolves into the permission system; under the Restricted
    // preset the project-scoped write is denied without touching bytes.
    await expect(workspace.write({ path: "../escape", content: "x" })).rejects.toMatchObject({
      name: "PermissionDeniedError",
    });
    const after = createHash("sha256").update(await readFile(target)).digest("hex");
    expect(after).toBe(before);
  });

  test("round-3 audit: a read approved for one canonical target fails if the target was swapped (TOCTOU)", async () => {
    const { base, workspace, permissionFixture } = await fixture();
    const safeDir = path.join(base, "external", "safe");
    const secretDir = path.join(base, "external", "secret");
    await mkdir(safeDir, { recursive: true });
    await mkdir(secretDir, { recursive: true });
    await writeNested(path.join(safeDir, "current.csv"), "safe data");
    await writeNested(path.join(secretDir, "current.csv"), "secret data");
    const link = path.join(base, "external", "link.csv");
    try {
      await symlink(path.join(safeDir, "current.csv"), link);
    } catch (error) {
      // No symlink privilege (e.g. Windows without developer mode): the
      // verification logic itself is covered by the unit test below.
      if ((error as NodeJS.ErrnoException).code === "EPERM" ||
          (error as NodeJS.ErrnoException).code === "EACCES") {
        return;
      }
      throw error;
    }

    const reading = workspace.read({ path: link });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionFixture.broker.hasPending("run-1")).toBe(true);
    // While the approval waits, the link is swapped to the OTHER target.
    await rm(link);
    await symlink(path.join(secretDir, "current.csv"), link);
    const requestId = permissionFixture.events.at(-1) as { request_id: string };
    await permissionFixture.broker.resolve("run-1", requestId.request_id, "allow", "once");

    // The approved read must NOT follow the new target: it fails closed.
    await expect(reading).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  test("round-3 audit: verifyAgentPathUnchanged rejects a stale approval", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-verify-"));
    roots.push(base);
    const workspaceRoot = path.join(base, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const taskOutputRoot = path.join(base, "output");
    await mkdir(path.join(taskOutputRoot, "state"), { recursive: true });
    const { createWorkspaceContext } = await import("../src/agent/workspace/context.js");
    const { verifyAgentPathUnchanged, resolveAgentPath } = await import(
      "../src/agent/workspace/path-policy.js",
    );
    const permissionFixture = createPermissionFixture({
      taskId: "task-1",
      runId: "run-1",
      taskOutputRoot,
    });
    const context = await createWorkspaceContext({
      taskId: "task-1",
      runId: "run-1",
      workspaceRoot,
      taskOutputRoot,
      dataRoot: base,
      repositoryRoot: base,
      permissions: permissionFixture.broker,
      audit: new InMemoryWorkspaceAuditSink(),
    });
    const target = path.join(base, "external", "a.csv");
    await mkdir(path.dirname(target), { recursive: true });
    await writeNested(target, "x");
    // A real resolution passes verification. (external read asks; approve it)
    const resolution = resolveAgentPath(context, target, "fs.read");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const request = permissionFixture.events.at(-1) as { request_id: string };
    await permissionFixture.broker.resolve("run-1", request.request_id, "allow", "once");
    const resolved = await resolution;
    await expect(verifyAgentPathUnchanged(context, resolved)).resolves.toBeUndefined();
    // A fabricated stale approval (canonical pointing elsewhere) is rejected.
    await expect(verifyAgentPathUnchanged(context, {
      ...resolved,
      canonical: path.join(base, "external", "b.csv"),
      scope: "external",
    })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });
});
