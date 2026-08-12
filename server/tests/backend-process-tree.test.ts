import { once } from "node:events";
import { spawn } from "node:child_process";

import { describe, expect, test } from "vitest";

import { terminateLegacyChild } from "../src/legacy/backend-process.js";

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processExists(processId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${processId} remained alive`);
}

describe("legacy backend process-tree ownership", () => {
  test.each([
    ["live parent", false],
    ["exited parent", true],
  ])("terminates a grandchild with %s", async (_label, exitParent) => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid) + '\\n');",
      exitParent ? "process.exit(0);" : "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", script], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const [data] = await once(parent.stdout!, "data") as [Buffer];
    const grandchildId = Number(data.toString("utf8").trim());
    expect(Number.isInteger(grandchildId)).toBe(true);
    if (exitParent) await once(parent, "exit");

    try {
      await terminateLegacyChild(parent, 2_000);
      await waitForExit(grandchildId);
    } finally {
      if (processExists(grandchildId)) process.kill(grandchildId, "SIGKILL");
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    }
  }, 15_000);
});
