import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function pathFromRoot(path) {
  return join(root, ...path.split("/"));
}

function requireFile(path) {
  assert.ok(existsSync(pathFromRoot(path)), `Missing ${path}`);
}

function requireAbsent(path) {
  assert.ok(!existsSync(pathFromRoot(path)), `Unexpected nested workspace file: ${path}`);
}

function readJson(path) {
  requireFile(path);
  return JSON.parse(readFileSync(pathFromRoot(path), "utf8"));
}

const rootPackage = readJson("package.json");
assert.equal(rootPackage.private, true, "Root package must be private");
assert.match(rootPackage.packageManager ?? "", /^pnpm@11\.14\.0(?:\+|$)/);
assert.equal(
  rootPackage.engines?.node,
  ">=22.19.0",
  "Root Node.js floor must satisfy the pinned Pi runtime",
);
for (const script of ["test", "lint", "typecheck", "build"]) {
  assert.equal(typeof rootPackage.scripts?.[script], "string", `Missing root ${script} script`);
}
assert.equal(rootPackage.scripts?.dev, "pnpm --filter @biomed/server dev");
for (const script of [
  "dev:frontend-standalone",
  "dev:legacy-backend",
  "dev:host-proxy-only",
  "dev:legacy-rollback",
]) {
  assert.equal(typeof rootPackage.scripts?.[script], "string", `Missing root ${script} script`);
}
requireFile("scripts/dev-profile.mjs");

requireFile("pnpm-workspace.yaml");
const workspace = readFileSync(pathFromRoot("pnpm-workspace.yaml"), "utf8");
for (const packagePath of ["frontend", "server", "packages/*"]) {
  assert.match(workspace, new RegExp(`^\\s*- ${packagePath.replace("*", "\\*")}\\s*$`, "m"));
}

requireFile("pnpm-lock.yaml");
requireAbsent("frontend/pnpm-lock.yaml");
requireAbsent("frontend/pnpm-workspace.yaml");
requireFile("tsconfig.base.json");

const frontendPackage = readJson("frontend/package.json");
assert.equal(frontendPackage.name, "@biomed/frontend");
assert.equal(frontendPackage.packageManager, undefined);
assert.equal(frontendPackage.scripts?.dev, "vite", "Frontend dev behavior must remain Vite");
assert.equal(typeof frontendPackage.scripts?.typecheck, "string");

for (const config of ["tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
  const tsconfig = readJson(`frontend/${config}`);
  assert.equal(tsconfig.extends, "../tsconfig.base.json", `${config} must inherit the shared base`);
}

const serverPackage = readJson("server/package.json");
assert.equal(serverPackage.name, "@biomed/server");
assert.equal(serverPackage.packageManager, undefined);
for (const script of ["predev", "pretest"]) {
  assert.equal(
    serverPackage.scripts?.[script],
    "pnpm --filter @biomed/contracts build",
    `Server ${script} must build its runtime contracts dependency`,
  );
}
assert.equal(readJson("server/tsconfig.json").extends, "../tsconfig.base.json");

const contractsPackage = readJson("packages/contracts/package.json");
assert.equal(contractsPackage.name, "@biomed/contracts");
assert.equal(contractsPackage.packageManager, undefined);
assert.equal(
  readJson("packages/contracts/tsconfig.json").extends,
  "../../tsconfig.base.json",
);
requireFile("packages/contracts/src/index.ts");

console.log("Workspace foundation checks passed.");
