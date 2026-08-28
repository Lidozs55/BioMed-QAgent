import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readJsonFile, writeJsonAtomic } from "../src/persistence/atomic-json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biomed-atomic-json-"));
  roots.push(dir);
  return dir;
}

describe("writeJsonAtomic", () => {
  test("writes and reads back a value atomically", async () => {
    const dir = await makeDir();
    const target = path.join(dir, "state.json");
    await writeJsonAtomic(target, { hello: "world" });
    expect(await readJsonFile<{ hello: string }>(target)).toEqual({ hello: "world" });
  });

  test("sweeps stale temp leftovers from crashed writes but keeps fresh ones", async () => {
    const dir = await makeDir();
    const target = path.join(dir, "model-registry.json");
    await mkdir(dir, { recursive: true });

    // A leftover temp file from a crashed write (> 1h old) must be swept.
    const stale = `${target}.999999.deadbeef-dead-beef-dead-beefdeadbeef.tmp`;
    await writeFile(stale, "{}", "utf8");
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, staleTime, staleTime);

    // A temp file that is mid-flight in another process (< 1h old) must be
    // preserved — only stale leftovers are swept.
    const fresh = `${target}.111111.0f0e0d0c-0b0a-0908-0706-050403020100.tmp`;
    await writeFile(fresh, "{}", "utf8");

    await writeJsonAtomic(target, { value: 1 });

    const remaining = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(remaining).toEqual([path.basename(fresh)]);
    expect(await stat(target)).toBeTruthy();
    expect(await readJsonFile<{ value: number }>(target)).toEqual({ value: 1 });
  });
});
