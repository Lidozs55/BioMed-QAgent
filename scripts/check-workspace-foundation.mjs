import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function gitAttributes(path, ...attributes) {
  const output = execFileSync(
    "git",
    ["check-attr", ...attributes, "--", path],
    { cwd: root, encoding: "utf8" },
  );
  return new Map(output.trim().split(/\r?\n/).map((line) => {
    const match = /^[^:]+: ([^:]+): (.+)$/.exec(line);
    assert.ok(match, `Unexpected git check-attr output: ${line}`);
    return [match[1], match[2]];
  }));
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
assert.equal(typeof rootPackage.scripts?.["dev:frontend-standalone"], "string");
// Phase 8: the legacy rollback development profiles are retired.
for (const script of ["dev:legacy-backend", "dev:host-proxy-only", "dev:legacy-rollback"]) {
  assert.ok(
    !Object.hasOwn(rootPackage.scripts ?? {}, script),
    `Retired rollback script must be gone: ${script}`,
  );
}
assert.equal(typeof rootPackage.scripts?.start, "string", "Missing root start script");

requireFile("pnpm-workspace.yaml");
requireFile("scripts/build-contracts-if-needed.mjs");
const workspace = readFileSync(pathFromRoot("pnpm-workspace.yaml"), "utf8");
for (const packagePath of ["frontend", "server", "packages/*"]) {
  assert.match(workspace, new RegExp(`^\\s*- ${packagePath.replace("*", "\\*")}\\s*$`, "m"));
}
for (const setting of [
  "nodeLinker: hoisted",
  "packageImportMethod: copy",
  "injectWorkspacePackages: true",
  "dedupeInjectedDeps: false",
]) {
  assert.match(workspace, new RegExp(`^${setting}$`, "m"), `Missing exFAT-safe pnpm setting: ${setting}`);
}

requireFile("pnpm-lock.yaml");
requireAbsent("frontend/pnpm-lock.yaml");
requireAbsent("frontend/pnpm-workspace.yaml");
requireFile("tsconfig.base.json");

for (const path of [
  "docs/evaluation/gold-v1/.gitattributes",
  "docs/evaluation/gold-v1/cases/gold6.json",
  "docs/evaluation/gold-v1/verify.mjs",
]) {
  const attributes = gitAttributes(path, "text", "eol");
  assert.equal(attributes.get("text"), "set", `${path} must be treated as text`);
  assert.equal(attributes.get("eol"), "lf", `${path} must be checked out with LF bytes`);
}
assert.equal(
  gitAttributes("docs/evaluation/gold-v1/prompts/gold6.txt", "text").get("text"),
  "unset",
  "Frozen Gold prompts must retain their exact binary bytes",
);

const frontendPackage = readJson("frontend/package.json");
assert.equal(frontendPackage.name, "@biomed/frontend");
assert.equal(frontendPackage.dependencies?.["@biomed/contracts"], "file:../packages/contracts");
assert.equal(frontendPackage.dependenciesMeta?.["@biomed/contracts"]?.injected, true);
assert.equal(frontendPackage.packageManager, undefined);
assert.equal(frontendPackage.scripts?.dev, "vite", "Frontend dev behavior must remain Vite");
assert.equal(typeof frontendPackage.scripts?.typecheck, "string");
for (const script of ["predev", "prebuild", "pretest"]) {
  assert.equal(
    frontendPackage.scripts?.[script],
    "node ../scripts/build-contracts-if-needed.mjs",
    `Frontend ${script} must ensure its runtime contracts dependency`,
  );
}

for (const config of ["tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
  const tsconfig = readJson(`frontend/${config}`);
  assert.equal(tsconfig.extends, "../tsconfig.base.json", `${config} must inherit the shared base`);
}

const serverPackage = readJson("server/package.json");
assert.equal(serverPackage.name, "@biomed/server");
assert.equal(serverPackage.dependencies?.["@biomed/contracts"], "file:../packages/contracts");
assert.equal(serverPackage.dependenciesMeta?.["@biomed/contracts"]?.injected, true);
assert.equal(serverPackage.packageManager, undefined);
for (const script of ["predev", "pretest", "prestart"]) {
  assert.equal(
    serverPackage.scripts?.[script],
    "node ../scripts/build-contracts-if-needed.mjs",
    `Server ${script} must ensure its runtime contracts dependency`,
  );
}
assert.equal(readJson("server/tsconfig.json").extends, "../tsconfig.base.json");

const contractsPackage = readJson("packages/contracts/package.json");
assert.equal(contractsPackage.name, "@biomed/contracts");
assert.equal(
  contractsPackage.scripts?.build,
  "node ../../scripts/build-contracts-if-needed.mjs",
  "Contracts build must use the shared cached build entrypoint",
);
assert.equal(contractsPackage.packageManager, undefined);
assert.equal(
  readJson("packages/contracts/tsconfig.json").extends,
  "../../tsconfig.base.json",
);
requireFile("packages/contracts/src/index.ts");

console.log("Workspace foundation checks passed.");
