import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  computeInputDigest,
  expectedContractOutputs,
  outputsAreReusable,
  syncInstalledContracts,
} from "../../scripts/build-contracts-if-needed.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("contracts build cache", () => {
  test("refreshes physical installed contract copies after a source build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "contracts-sync-"));
    roots.push(root);
    const sourceRoot = path.join(root, "packages", "contracts");
    const installedRoot = path.join(root, "node_modules", "@biomed", "contracts");
    for (const base of [sourceRoot, installedRoot]) {
      await mkdir(path.join(base, "src"), { recursive: true });
      await mkdir(path.join(base, "dist"), { recursive: true });
    }
    await writeFile(path.join(sourceRoot, "package.json"), '{"name":"@biomed/contracts","version":"new"}\n');
    await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const value = 'new';\n");
    await writeFile(path.join(sourceRoot, "dist", "index.js"), "export const value = 'new';\n");
    await writeFile(path.join(installedRoot, "package.json"), '{"name":"@biomed/contracts","version":"old"}\n');
    await writeFile(path.join(installedRoot, "src", "index.ts"), "export const value = 'old';\n");
    await writeFile(path.join(installedRoot, "dist", "index.js"), "export const value = 'old';\n");

    expect(syncInstalledContracts(root)).toEqual([installedRoot]);
    expect(await readFile(path.join(installedRoot, "package.json"), "utf8")).toContain('"version":"new"');
    expect(await readFile(path.join(installedRoot, "src", "index.ts"), "utf8")).toContain("'new'");
    expect(await readFile(path.join(installedRoot, "dist", "index.js"), "utf8")).toContain("'new'");
  });

  test("reuses only when every JavaScript/declaration output matches the input digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "contracts-cache-"));
    roots.push(root);
    const sourceRoot = path.join(root, "src");
    const outputRoot = path.join(root, "dist");
    await mkdir(path.join(sourceRoot, "runtime"), { recursive: true });
    await mkdir(outputRoot, { recursive: true });
    const source = path.join(sourceRoot, "runtime", "model.ts");
    await writeFile(source, "export const model = 1;\n", "utf8");

    const outputs = expectedContractOutputs(sourceRoot, outputRoot);
    expect(outputs).toEqual([
      path.join(outputRoot, "runtime", "model.js"),
      path.join(outputRoot, "runtime", "model.d.ts"),
    ]);
    for (const output of outputs) {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "generated\n", "utf8");
    }

    const digest = computeInputDigest([source], root);
    const stamp = path.join(outputRoot, ".build-input-sha256");
    await writeFile(stamp, `${digest}\n`, "utf8");
    expect(outputsAreReusable(outputs, stamp, digest)).toBe(true);

    await rm(outputs[0]);
    expect(outputsAreReusable(outputs, stamp, digest)).toBe(false);

    await writeFile(outputs[0], "generated\n", "utf8");
    await writeFile(source, "export const model = 2;\n", "utf8");
    const changedDigest = computeInputDigest([source], root);
    expect(changedDigest).not.toBe(digest);
    expect(outputsAreReusable(outputs, stamp, changedDigest)).toBe(false);

    expect(await readFile(source, "utf8")).toContain("model = 2");
  });
});
