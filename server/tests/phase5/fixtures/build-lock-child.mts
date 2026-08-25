/**
 * Cross-process build-lock child (I-04 final audit). Runs under tsx:
 * repeatedly acquires the task_1/build_1 lock, holds it briefly, verifies the
 * fence, releases.  Every transition is appended to <lockRoot>/events.log:
 *
 *   <ts> <child-<pid>> acquire|fence-ok|fence-lost|release|failed <detail>
 *
 * The parent test asserts the log never shows overlapping holders.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireBuildLock } from "../../../src/dataset/service/build-lock.js";

const [lockRoot, roundsArg, holdMsArg, readyPath, startPath] = process.argv.slice(2);
const rounds = Number(roundsArg);
const holdMs = Number(holdMsArg);
const logPath = join(lockRoot, "events.log");
const tag = `child-${process.pid}`;

if (readyPath === undefined || startPath === undefined) {
  throw new Error("build-lock child requires ready and start paths");
}

writeFileSync(readyPath, `${tag}\n`);
while (!existsSync(startPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
if (readFileSync(startPath, "utf8").trim() !== "start") process.exit(0);

const log = (line: string): void => {
  appendFileSync(logPath, `${Date.now()} ${tag} ${line}\n`);
};

for (let round = 0; round < rounds; round += 1) {
  let lease: Awaited<ReturnType<typeof acquireBuildLock>> | undefined;
  try {
    lease = await acquireBuildLock(
      {
        lockRoot,
        retryMs: 20_000,
        retryIntervalMs: 20,
        heartbeatMs: 150,
        staleMs: 1_500,
      },
      "task_1",
      "build_1",
      tag,
    );
    log("acquire");
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    log((await lease.assertOwned()) ? "fence-ok" : "fence-lost");
  } catch (error) {
    log(`failed ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    break;
  } finally {
    if (lease !== undefined) {
      await lease.release();
      log("release");
    }
  }
}
