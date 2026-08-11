import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = process.argv[2];
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const uv = process.platform === "win32" ? "uv.exe" : "uv";
const children = [];
let shutdownPromise;

function start(command, args, environment = process.env) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(`Failed to start ${command}`, error);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (shutdownPromise === undefined) {
      console.error(`${command} exited`, { code, signal });
      void shutdown(code ?? 1);
    }
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await waitForExit(killer, 5_000);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await waitForExit(child, 5_000);
}

function shutdown(exitCode) {
  shutdownPromise ??= (async () => {
    await Promise.allSettled(children.map((child) => stop(child)));
    process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

const phase1Profile = {
  ...process.env,
  APP_HOST: "ts",
  AGENT_RUNTIME: "legacy",
  DATASET_CORE: "python",
  PI_EXPERIMENTAL: "0",
};
const legacyProfile = {
  ...process.env,
  APP_HOST: "fastapi",
  AGENT_RUNTIME: "legacy",
  DATASET_CORE: "python",
  PI_EXPERIMENTAL: "0",
  HOST: "127.0.0.1",
  PORT: process.env.LEGACY_BACKEND_PORT ?? "8000",
};
const legacyBackendArgs = [
  "--directory",
  join(repositoryRoot, "backend"),
  "run",
  "uvicorn",
  "app.main:app",
  "--reload",
];

if (profile === "legacy-backend") {
  start(uv, legacyBackendArgs, legacyProfile);
} else if (profile === "host-proxy-only") {
  start(pnpm, ["--filter", "@biomed/server", "dev"], phase1Profile);
} else if (profile === "legacy-rollback") {
  start(uv, legacyBackendArgs, legacyProfile);
  start(pnpm, ["--filter", "@biomed/frontend", "dev"], process.env);
} else {
  console.error(
    "Usage: node scripts/dev-profile.mjs " +
      "<legacy-backend|host-proxy-only|legacy-rollback>",
  );
  process.exitCode = 2;
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
