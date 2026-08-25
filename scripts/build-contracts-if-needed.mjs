import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");

export function filesUnder(inputPath) {
  if (!existsSync(inputPath)) return [];
  if (statSync(inputPath).isFile()) return [inputPath];
  return readdirSync(inputPath, { withFileTypes: true }).flatMap((entry) => {
    const child = join(inputPath, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

export function expectedContractOutputs(sourceRoot, outputRoot) {
  return filesUnder(sourceRoot)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .flatMap((file) => {
      const stem = relative(sourceRoot, file).slice(0, -".ts".length);
      return [join(outputRoot, `${stem}.js`), join(outputRoot, `${stem}.d.ts`)];
    });
}

export function computeInputDigest(inputFiles, root) {
  const fingerprint = createHash("sha256");
  for (const file of inputFiles.toSorted()) {
    fingerprint.update(relative(root, file));
    fingerprint.update("\0");
    fingerprint.update(readFileSync(file));
    fingerprint.update("\0");
  }
  return fingerprint.digest("hex");
}

export function outputsAreReusable(outputFiles, stampPath, inputDigest) {
  try {
    return outputFiles.length > 0
      && outputFiles.every(existsSync)
      && existsSync(stampPath)
      && readFileSync(stampPath, "utf8").trim() === inputDigest;
  } catch {
    return false;
  }
}

export function contractBuildState(root) {
  const contractsRoot = join(root, "packages", "contracts");
  const sourceRoot = join(contractsRoot, "src");
  const outputRoot = join(contractsRoot, "dist");
  const sourceFiles = filesUnder(sourceRoot)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
  const configFiles = [
    join(contractsRoot, "package.json"),
    join(contractsRoot, "tsconfig.json"),
    join(root, "tsconfig.base.json"),
    join(root, "pnpm-lock.yaml"),
  ];
  return {
    contractsRoot,
    inputDigest: computeInputDigest([...sourceFiles, ...configFiles], root),
    outputFiles: expectedContractOutputs(sourceRoot, outputRoot),
    outputRoot,
    stampPath: join(outputRoot, ".build-input-sha256"),
  };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readBuildOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function acquireBuildLock(lockPath, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return token;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM" || error.code === "EBUSY") {
        sleepSync(50);
        continue;
      }
      if (error.code !== "EEXIST") throw error;

      const owner = readBuildOwner(lockPath);
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      const ownerIsLive = Number.isInteger(owner?.pid) && processIsAlive(owner.pid);
      const abandoned = owner !== null ? !ownerIsLive : ageMs > 2_000;
      if (abandoned) {
        const graveyard = `${lockPath}.stale-${randomUUID()}`;
        try {
          renameSync(lockPath, graveyard);
          rmSync(graveyard, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(renameError.code)) {
            sleepSync(50);
            continue;
          }
          throw renameError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the @biomed/contracts build lock");
      }
      sleepSync(50);
    }
  }
}

function releaseBuildLock(lockPath, token) {
  const owner = readBuildOwner(lockPath);
  if (owner?.token === token) rmSync(lockPath, { recursive: true, force: true });
}

function runContractsBuild(state, root) {
  const require = createRequire(join(state.contractsRoot, "package.json"));
  const tsc = require.resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", join(state.contractsRoot, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`@biomed/contracts build exited with status ${result.status ?? "unknown"}`);
  }
}

export function ensureContractsBuilt(root = defaultRoot) {
  let state = contractBuildState(root);
  if (outputsAreReusable(state.outputFiles, state.stampPath, state.inputDigest)) {
    console.log("@biomed/contracts build is up to date; reusing dist.");
    return "reused";
  }

  mkdirSync(state.outputRoot, { recursive: true });
  const lockPath = join(state.outputRoot, ".build-lock");
  const lockToken = acquireBuildLock(lockPath);
  try {
    state = contractBuildState(root);
    if (outputsAreReusable(state.outputFiles, state.stampPath, state.inputDigest)) {
      console.log("@biomed/contracts build completed by another process; reusing dist.");
      return "reused";
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const beforeBuild = contractBuildState(root);
      runContractsBuild(beforeBuild, root);
      const afterBuild = contractBuildState(root);
      const outputsExist = afterBuild.outputFiles.length > 0 && afterBuild.outputFiles.every(existsSync);
      if (!outputsExist) throw new Error("@biomed/contracts build completed without all expected outputs");
      if (beforeBuild.inputDigest === afterBuild.inputDigest) {
        writeFileSync(afterBuild.stampPath, `${afterBuild.inputDigest}\n`, "utf8");
        return "built";
      }
    }
    throw new Error("@biomed/contracts inputs kept changing during the build");
  } finally {
    releaseBuildLock(lockPath, lockToken);
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  try {
    ensureContractsBuilt();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
