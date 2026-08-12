import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  watch,
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

const roots: string[] = [];

async function fixture(options: { exec?: boolean; limits?: Record<string, number> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-"));
  roots.push(root);
  await Promise.all(
    [
      "source_assets",
      "parsed",
      "normalized",
      "staging/agent",
      "artifacts",
      "state",
      "logs",
    ].map((name) => mkdir(path.join(root, name), { recursive: true })),
  );
  const audit = new InMemoryWorkspaceAuditSink();
  const workspace = await createTaskWorkspace({
    taskId: "task-1",
    runId: "run-1",
    piSessionId: "pi-1",
    root,
    audit,
    limits: options.limits,
    developmentExec: options.exec ? { enabled: true } : undefined,
  });
  return { root, audit, workspace };
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

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  try {
    await access(filePath);
    return;
  } catch {
    // Subscribe below so the wait is event driven.
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const events = watch(path.dirname(filePath), { signal: controller.signal });
    for await (const event of events) {
      if (event.filename === path.basename(filePath)) return;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
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
  const childPath = path.join(root, "staging", "agent", "child.cjs");
  const parentPath = path.join(root, "staging", "agent", "parent.cjs");
  await writeFile(
    childPath,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync('staging/agent/pids.json', JSON.stringify([process.pid, grandchild.pid]));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    parentPath,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "spawn(process.execPath, ['staging/agent/child.cjs'], { stdio: 'ignore' });",
      parentMode === "wait"
        ? "setInterval(() => {}, 1000);"
        : "const timer = setInterval(() => { if (fs.existsSync('staging/agent/pids.json')) { clearInterval(timer); process.exit(0); } }, 5);",
    ].join("\n"),
    "utf8",
  );
  return "staging/agent/parent.cjs";
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeEventually));
});

describe("governed Task Workspace", () => {
  test("reads bounded UTF-8 text and reports a stable relative path", async () => {
    const { root, workspace } = await fixture({ limits: { maxReadBytes: 8 } });
    await writeFile(path.join(root, "parsed", "data.txt"), "abcdefghi", "utf8");

    const result = await workspace.read({ path: "parsed/data.txt", offset: 2, length: 3 });
    const bounded = await workspace.read({ path: "parsed/data.txt" });

    expect(result).toMatchObject({ path: "parsed/data.txt", text: "cde", offset: 2 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toBe("abcdefgh");
  });

  test.each([
    "../outside.txt",
    "..\\outside.txt",
    "parsed/..\\outside.txt",
    "/etc/passwd",
    "C:\\outside.txt",
    "C:outside.txt",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\outside.txt",
    "\\\\.\\pipe\\name",
    "NUL",
    "staging/agent/CON.txt",
  ])("rejects unsafe path representation %s before access", async (candidate) => {
    const { workspace } = await fixture();
    await expect(workspace.read({ path: candidate })).rejects.toBeInstanceOf(
      WorkspacePolicyError,
    );
  });

  test("allows only the explicit state read allowlist and bounds logs", async () => {
    const { root, workspace } = await fixture({ limits: { maxReadBytes: 5 } });
    await writeFile(path.join(root, "state", "task_snapshot.json"), "{}", "utf8");
    await writeFile(path.join(root, "state", "session_items.jsonl"), "secret", "utf8");
    await writeFile(path.join(root, "logs", "runtime.log"), "123456789", "utf8");

    await expect(workspace.read({ path: "state/task_snapshot.json" })).resolves.toMatchObject({
      text: "{}",
    });
    await expect(workspace.read({ path: "state/session_items.jsonl" })).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
    await expect(workspace.list({ path: "state" })).resolves.toMatchObject({
      entries: [{ path: "state/task_snapshot.json", type: "file" }],
    });
    const stateSearch = await workspace.search({ path: "state", query: "secret" });
    expect(stateSearch).toMatchObject({ matches: [], filesScanned: 1 });
    await expect(workspace.read({ path: "logs/runtime.log" })).resolves.toMatchObject({
      text: "12345",
      truncated: true,
    });
  });

  test("lists and searches in stable bounded order", async () => {
    const { root, workspace } = await fixture({
      limits: { maxListEntries: 2, maxSearchResults: 1, maxSearchLineChars: 8 },
    });
    await writeFile(path.join(root, "parsed", "b.txt"), "needle-long-line", "utf8");
    await writeFile(path.join(root, "parsed", "a.txt"), "needle", "utf8");
    await writeFile(path.join(root, "parsed", "c.txt"), "needle", "utf8");

    const listed = await workspace.list({ path: "parsed", depth: 1 });
    const searched = await workspace.search({ path: "parsed", query: "needle" });

    expect(listed.entries.map((entry) => entry.path)).toEqual([
      "parsed/a.txt",
      "parsed/b.txt",
    ]);
    expect(listed.truncated).toBe(true);
    expect(searched.matches).toHaveLength(1);
    expect(searched.matches[0]).toMatchObject({ path: "parsed/a.txt", line: 1 });
    expect(searched.truncated).toBe(true);
  });

  test("does not traverse a symlink or junction escaping the Task root", async ({ skip }) => {
    const { root, workspace } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "biomed-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const link = path.join(root, "parsed", "escape");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("OS privilege policy forbids creating the link fixture");
        return;
      }
      throw error;
    }

    await expect(workspace.read({ path: "parsed/escape/secret.txt" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
    await expect(workspace.list({ path: "parsed", depth: 2 })).resolves.not.toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "parsed/escape/secret.txt" }),
        ]),
      }),
    );
  });

  test("writes atomically and edits only unambiguous staging content", async () => {
    const { root, workspace } = await fixture({ limits: { maxWriteBytes: 12 } });
    await workspace.write({ path: "staging/agent/nested/value.txt", content: "old value" });
    await workspace.edit({
      path: "staging/agent/nested/value.txt",
      oldText: "old",
      newText: "new",
      expectedOccurrences: 1,
    });

    await expect(readFile(path.join(root, "staging", "agent", "nested", "value.txt"), "utf8"))
      .resolves.toBe("new value");
    await expect(
      workspace.write({ path: "staging/agent/large.txt", content: "x".repeat(13) }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await writeFile(path.join(root, "staging", "agent", "ambiguous.txt"), "x x", "utf8");
    await expect(
      workspace.edit({
        path: "staging/agent/ambiguous.txt",
        oldText: "x",
        newText: "y",
        expectedOccurrences: 1,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(readFile(path.join(root, "staging", "agent", "ambiguous.txt"), "utf8"))
      .resolves.toBe("x x");
  });

  test("protected write and edit aliases never change protected bytes", async () => {
    const { root, workspace } = await fixture();
    const protectedPath = path.join(root, "artifacts", "formal.txt");
    await writeFile(protectedPath, "formal", "utf8");
    const before = createHash("sha256").update(await readFile(protectedPath)).digest("hex");
    const alias = process.platform === "win32" ? "ARTIFACTS\\formal.txt" : "artifacts/formal.txt";

    await expect(workspace.write({ path: alias, content: "changed" })).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
    await expect(
      workspace.edit({
        path: alias,
        oldText: "formal",
        newText: "changed",
        expectedOccurrences: 1,
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    const after = createHash("sha256").update(await readFile(protectedPath)).digest("hex");
    expect(after).toBe(before);
  });

  test("development exec is disabled by default and audited without secrets", async () => {
    const { audit, workspace } = await fixture();
    const result = await workspace.exec({
      executable: process.execPath,
      args: ["--token=secret-value"],
    });

    expect(result.policy).toBe("disabled");
    expect(JSON.stringify(result)).not.toContain(process.execPath);
    expect(JSON.stringify(audit.records)).not.toContain("secret-value");
    expect(audit.records.at(-1)).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      piSessionId: "pi-1",
      operation: "exec",
      result: "disabled",
    });
  });

  test("development exec uses fixed cwd, filtered environment, no shell, and bounded output", async () => {
    const previous = process.env.BIOMED_TEST_SECRET;
    process.env.BIOMED_TEST_SECRET = "parent-secret";
    try {
      const { root, workspace } = await fixture({
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
      expect(result.stdout).not.toContain(root);
      expect(result.stdout).not.toContain("parent-secret");
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128);

      const rejected = await workspace.exec({ executable: "node & whoami", args: [] });
      expect(rejected.policy).toBe("rejected");
    } finally {
      if (previous === undefined) delete process.env.BIOMED_TEST_SECRET;
      else process.env.BIOMED_TEST_SECRET = previous;
    }
  });

  test("refuses an unprotected snapshot and restores protected bytes after command mutation", async () => {
    const { root, audit, workspace } = await fixture({
      exec: true,
      limits: { maxSnapshotBytes: 32 },
    });
    const protectedPath = path.join(root, "artifacts", "formal.txt");
    await writeFile(protectedPath, "formal", "utf8");
    const mutation = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('artifacts/formal.txt','changed');",
      "fs.writeFileSync('staging/agent/allowed.txt','allowed');",
    ].join("");

    const denied = await workspace.exec({ executable: process.execPath, args: ["-e", mutation] });
    expect(denied.policy).toBe("rejected");
    expect(audit.records.at(-1)).toMatchObject({ operation: "exec", result: "rejected" });
    await expect(readFile(protectedPath, "utf8")).resolves.toBe("formal");
    await expect(readFile(path.join(root, "staging", "agent", "allowed.txt"), "utf8"))
      .resolves.toBe("allowed");

    await writeFile(path.join(root, "source_assets", "large.bin"), Buffer.alloc(64));
    const refused = await workspace.exec({
      executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('staging/agent/should-not-run','x')"],
    });
    expect(refused.policy).toBe("rejected");
    await expect(access(path.join(root, "staging", "agent", "should-not-run"))).rejects.toThrow();
  });

  test("timeout kills the complete child and grandchild process tree", async () => {
    const { root, workspace } = await fixture({ exec: true });
    const script = await writeProcessTreeFixture(root, "wait");
    const result = await workspace.exec({
      executable: process.execPath,
      args: [script],
      timeoutMs: 300,
    });
    const pids = JSON.parse(
      await readFile(path.join(root, "staging", "agent", "pids.json"), "utf8"),
    ) as number[];

    expect(result).toMatchObject({ timedOut: true, cancelled: false });
    await expectProcessesDead(pids);
  });

  test("AbortSignal and workspace disposal cancel active process trees", async () => {
    const aborted = await fixture({ exec: true });
    const abortedScript = await writeProcessTreeFixture(aborted.root, "wait");
    const abortController = new AbortController();
    const abortedResultPromise = aborted.workspace.exec(
      { executable: process.execPath, args: [abortedScript], timeoutMs: 5_000 },
      abortController.signal,
    );
    const abortedPidsPath = path.join(aborted.root, "staging", "agent", "pids.json");
    await waitForFile(abortedPidsPath);
    abortController.abort();
    const abortedResult = await abortedResultPromise;
    const abortedPids = JSON.parse(await readFile(abortedPidsPath, "utf8")) as number[];
    expect(abortedResult.cancelled).toBe(true);
    expect(aborted.audit.records.at(-1)).toMatchObject({
      operation: "exec",
      result: "cancelled",
    });
    await expectProcessesDead(abortedPids);

    const disposed = await fixture({ exec: true });
    const disposedScript = await writeProcessTreeFixture(disposed.root, "wait");
    const disposedResultPromise = disposed.workspace.exec({
      executable: process.execPath,
      args: [disposedScript],
      timeoutMs: 5_000,
    });
    const disposedPidsPath = path.join(disposed.root, "staging", "agent", "pids.json");
    await waitForFile(disposedPidsPath);
    await disposed.workspace.dispose();
    const disposedResult = await disposedResultPromise;
    const disposedPids = JSON.parse(await readFile(disposedPidsPath, "utf8")) as number[];
    expect(disposedResult.cancelled).toBe(true);
    await expectProcessesDead(disposedPids);
  });

  test("normal completion cleans background descendants and audits without secrets", async () => {
    const { root, audit, workspace } = await fixture({ exec: true });
    const script = await writeProcessTreeFixture(root, "exit-after-child-ready");
    const result = await workspace.exec({
      executable: process.execPath,
      args: [script, "--token=do-not-log"],
    });
    const pids = JSON.parse(
      await readFile(path.join(root, "staging", "agent", "pids.json"), "utf8"),
    ) as number[];

    expect(result).toMatchObject({ exitCode: 0, policy: "allowed" });
    await expectProcessesDead(pids);
    expect(JSON.stringify(audit.records)).not.toContain("do-not-log");
    expect(audit.records.at(-1)).toMatchObject({ operation: "exec", result: "success" });
  });
});
