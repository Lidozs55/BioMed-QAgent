#!/usr/bin/env node
/**
 * Cross-platform UTF-8 environment bootstrap for repository commands.
 *
 * Usage:
 *   node scripts/utf8-env.mjs print
 *   node scripts/utf8-env.mjs exec pnpm test
 *
 * The parent shell cannot be modified by a child Node process. Use the .cmd,
 * .ps1, or .sh wrapper when initializing a terminal; use `exec` for commands
 * launched from scripts or CI.
 */
import { spawn } from "node:child_process";
import process from "node:process";

export const UTF8_ENV = Object.freeze({
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});

export function utf8Environment(base = process.env) {
  return { ...base, ...UTF8_ENV };
}

function printEnvironment() {
  for (const [key, value] of Object.entries(UTF8_ENV)) {
    console.log(`${key}=${value}`);
  }
  if (process.platform === "win32") {
    console.log("Windows console: run scripts\\utf8-init.cmd or .\\scripts\\utf8-init.ps1");
  } else {
    console.log("POSIX shell: source scripts/utf8-init.sh");
  }
}

function run(command, args) {
  const child = spawn(command, args, {
    env: utf8Environment(),
    stdio: "inherit",
    shell: false,
    windowsHide: false,
  });
  child.once("error", (error) => {
    console.error(`[utf8-env] failed to start ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

const [mode, command, ...args] = process.argv.slice(2);
if (mode === "print") {
  printEnvironment();
} else if (mode === "exec" && command !== undefined) {
  run(command, args);
} else {
  console.error("Usage: node scripts/utf8-env.mjs print | exec <command> [...args]");
  process.exitCode = 2;
}
