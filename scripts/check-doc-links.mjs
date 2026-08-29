import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([
  ".git",
  ".pytest_cache",
  ".ruff_cache",
  "data",
  "dist",
  "node_modules",
  ".venv",
  ".omo",
  ".sisyphus",
  ".superpowers",
  ".worktree",
  ".worktrees",
]);
const historicalRoots = [
  resolve(repoRoot, "docs/archive"),
  resolve(repoRoot, "docs/migration"),
];

function isHistorical(path) {
  return historicalRoots.some(
    (root) => path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`),
  );
}

function collectMarkdown(directory, output = []) {
  if (isHistorical(directory)) return output;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") return output;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectMarkdown(path, output);
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
  }
  return output;
}

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (!target || /^(?:https?:|mailto:|#)/i.test(target)) return null;
  const path = target.split("#", 1)[0];
  if (!path || path.startsWith("file:")) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const failures = [];
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;

for (const file of collectMarkdown(repoRoot)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(markdownLink)) {
    const target = localTarget(match[1]);
    if (target === null) continue;
    if (!existsSync(resolve(dirname(file), target))) {
      failures.push(`${relative(repoRoot, file)} -> ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Broken local documentation links (${failures.length}):`);
  for (const failure of failures.sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Documentation links: OK");
}
