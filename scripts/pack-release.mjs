#!/usr/bin/env node
// scripts/pack-release.mjs — standalone packager for BioMed-QAgent.
//
// Produces a self-contained, runnable bundle per platform into target/:
//   target/biomed-qagent-<version>-<win|linux|macos>/
//     start.bat / start.sh   launcher (model credentials are configured in the Web settings)
//     server/                compiled Application Host + pruned production node_modules
//     frontend/dist/         compiled SPA, served by the host (--static)
//     database/              stdlib-only Python persistence bridge
//     .pi/                   agent skills
//     runtime/node/          embedded Node.js (portable, nodejs.org)
//     runtime/python/        embedded CPython (python-build-standalone, same distro uv uses)
//                            with the pinned scientific stack preinstalled (PYTHON_EXTRAS)
//
// The target machine needs nothing preinstalled: no Node, no Python, no pnpm, no uv.
// The host resolves the Python interpreter via BIOMED_PYTHON_BIN (see
// server/src/persistence/db-client.ts probePythonBin), which the launcher sets to the
// embedded runtime — that is the only integration point, no source changes needed.
//
// Usage (from the repository root):
//   pnpm run pack [-- --platform=win|linux|macos|all] [--out=<dir>] [--ref=<git-ref>] [--keep-temp]
//   pnpm pack:target --platform=all     (alias; plain `pnpm pack` is pnpm's built-in tarball command)
//
// Cross-packing (building a bundle for a different OS than the host) additionally
// needs any host CPython with pip on PATH — the wheel step never executes target
// code, but the pip process itself must run somewhere (see installPythonExtras).
//
// If runtime downloads fail (e.g. GitHub unreachable), set HTTPS_PROXY and retry:
//   https_proxy=http://127.0.0.1:7897 pnpm run pack

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ---- pinned embedded runtimes ---------------------------------------------

const NODE_VERSION = "22.21.0";
const PYTHON_VERSION = "3.12.14";
const PYTHON_PBS_TAG = "20260825";
// Scientific stack preinstalled into the embedded runtime (see installPythonExtras).
// Fully pinned for reproducible bundles; bump deliberately and keep all three
// platform wheels available (see docs/packaging.md).
const PYTHON_EXTRAS = [
  { name: "numpy", version: "2.5.2" },
  { name: "scipy", version: "1.18.1" },
];
const PYTHON_MAJOR_MINOR = PYTHON_VERSION.split(".").slice(0, 2).join(".");

const NODE_DIST = "https://nodejs.org/dist";
const PBS_DIST =
  "https://github.com/astral-sh/python-build-standalone/releases/download";

const PLATFORMS = {
  win: {
    label: "win-x64",
    nodeAsset: `node-v${NODE_VERSION}-win-x64.zip`,
    nodeBin: "node.exe",
    pyTriple: "x86_64-pc-windows-msvc",
    pythonBin: "python.exe",
    sitePackages: "Lib/site-packages",
    // pip --platform tags matching the cp312 wheels of PYTHON_EXTRAS
    pipPlatforms: ["win_amd64"],
    launcher: "start.bat",
  },
  linux: {
    label: "linux-x64",
    nodeAsset: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    nodeBin: "bin/node",
    pyTriple: "x86_64-unknown-linux-gnu",
    // Versioned real binary, not the bin/python3 symlink: posix runtime
    // tarballs order symlink aliases before their target, so extracting on a
    // Windows host skips them (see tarBinaryFor). The real python3.12 file
    // always lands, and the stdlib/libpython resolution is prefix-relative.
    pythonBin: `bin/python${PYTHON_MAJOR_MINOR}`,
    sitePackages: `lib/python${PYTHON_MAJOR_MINOR}/site-packages`,
    // manylinux_2_28 also matches the manylinux_2_27.manylinux_2_28 compound wheels
    pipPlatforms: ["manylinux_2_28_x86_64"],
    launcher: "start.sh",
  },
  macos: {
    label: "macos-arm64",
    nodeAsset: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeBin: "bin/node",
    pyTriple: "aarch64-apple-darwin",
    pythonBin: `bin/python${PYTHON_MAJOR_MINOR}`,
    sitePackages: `lib/python${PYTHON_MAJOR_MINOR}/site-packages`,
    // numpy ships macosx_11_0, scipy macosx_12_0 — allow both
    pipPlatforms: ["macosx_11_0_arm64", "macosx_12_0_arm64"],
    launcher: "start.sh",
  },
};

// ---- small helpers ---------------------------------------------------------

function fail(message) {
  console.error(`[pack] ERROR: ${message}`);
  process.exit(1);
}

function step(number, message) {
  console.log(`\n[pack] (${number}) ${message}`);
}

function run(command, args, options = {}) {
  const shell = process.platform === "win32";
  const finalArgs = shell
    ? args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg))
    : args;
  const result = spawnSync(command, finalArgs, {
    cwd: options.cwd,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell,
    maxBuffer: 1024 * 1024 * 512,
  });
  if (result.error !== undefined) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  return result;
}

function runOrDie(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result;
}

function download(url, destFile) {
  console.log(`[pack]   downloading ${url}`);
  const result = run("curl", ["-fL", "--retry", "2", "--connect-timeout", "20", "-o", destFile, url]);
  if (result.status !== 0) {
    fail(
      `download failed (curl exit ${result.status}): ${url}\n` +
        "[pack]        If GitHub is unreachable from this network, set HTTPS_PROXY and retry, e.g.:\n" +
        "[pack]        https_proxy=http://127.0.0.1:7897 pnpm run pack",
    );
  }
}

// Windows ships bsdtar (libarchive, reads zip + tar.gz) at System32; MSYS GNU
// tar cannot read .zip. Posix runtime tarballs contain symlink entries that
// bsdtar refuses to extract on Windows (hard error, partial output), while GNU
// tar degrades gracefully: every real file member lands and unresolvable alias
// entries are skipped (exit 2, tolerated by extract for the runtime archives).
// The launcher therefore execs versioned real binaries (bin/node,
// bin/python3.12), never symlink aliases. So: bsdtar for .zip, GNU tar else.
function tarBinaryFor(archiveFile) {
  if (process.platform === "win32") {
    if (archiveFile.endsWith(".zip")) {
      const bsdtar = "C:/Windows/System32/tar.exe";
      if (existsSync(bsdtar)) return bsdtar;
      fail("cannot extract .zip: C:/Windows/System32/tar.exe not found and GNU tar cannot read zip");
    }
    for (const candidate of [
      "tar",
      "C:/Program Files/Git/usr/bin/tar.exe",
      "C:/Program Files (x86)/Git/usr/bin/tar.exe",
    ]) {
      const probe = run(candidate, ["--version"], { capture: true });
      if (probe.status === 0 && String(probe.stdout).includes("GNU tar")) return candidate;
    }
    fail(
      "GNU tar not found: extracting the runtime tarballs on Windows needs Git for Windows' " +
        "usr/bin/tar.exe on PATH (System32 bsdtar cannot extract their symlink entries)",
    );
  }
  return "tar";
}

function extract(archiveFile, destDir, { allowSkippedSymlinks = false } = {}) {
  mkdirSync(destDir, { recursive: true });
  // GNU tar (MSYS) treats "E:\path" as host:path, so tar must never see a
  // drive letter: run it from the archive's directory with relative
  // forward-slash paths (also valid for Windows bsdtar).
  const archiveDir = path.dirname(archiveFile);
  const relArchive = path.basename(archiveFile);
  const relDest = path.relative(archiveDir, destDir).replaceAll("\\", "/");
  const tarBinary = tarBinaryFor(archiveFile);
  const result = run(tarBinary, ["-xf", relArchive, "-C", relDest], { cwd: archiveDir });
  if (result.status === 2 && allowSkippedSymlinks && process.platform === "win32") {
    // GNU tar exit 2 on Windows hosts = symlink alias members it cannot
    // materialize. All real-file members still land; the runtime checks below
    // verify the entrypoints (bin/node, bin/python3.12) are present.
    console.log("[pack]   note: tar skipped symlink alias entries (expected when packing on Windows)");
    return;
  }
  if (result.status !== 0) {
    fail(`${tarBinary} -xf ${relArchive} exited with ${result.status}`);
  }
}

// Interpreter that drives pip. For the host platform the embedded interpreter
// itself runs; when cross-packing (e.g. the linux bundle on a Windows host) the
// embedded binary cannot execute, so fall back to any host CPython. Either way
// target code is never executed — pip only unpacks wheels built for the target
// platform tags into --target.
function resolvePipDriver(key, platform, pythonRoot) {
  if (key === defaultPlatform()) {
    return path.join(pythonRoot, platform.pythonBin);
  }
  for (const name of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const probe = run(name, ["-c", "import sys"], { capture: true });
    if (probe.status === 0) return name;
  }
  fail(`cross-packing ${key} needs a host CPython with pip on PATH (none found)`);
}

// Installs the pinned scientific stack (PYTHON_EXTRAS) into the embedded
// runtime. pip resolves wheels against the TARGET platform tags, downloads
// them, and unpacks straight into the runtime's site-packages via --target —
// no venv, no compilation, reproducible via pinned versions + --no-deps.
function installPythonExtras(key, platform, pythonRoot, pipCacheDir) {
  if (PYTHON_EXTRAS.length === 0) return;
  const sitePackages = path.join(pythonRoot, platform.sitePackages);
  mkdirSync(sitePackages, { recursive: true });
  const driver = resolvePipDriver(key, platform, pythonRoot);
  const requirements = PYTHON_EXTRAS.map((extra) => `${extra.name}==${extra.version}`);
  console.log(
    `[pack]   installing ${requirements.join(" ")} into embedded Python ` +
      `(${platform.pipPlatforms.join(" / ")})`,
  );
  runOrDie(driver, [
    "-m", "pip", "install",
    "--quiet", "--progress-bar", "off",
    ...platform.pipPlatforms.flatMap((tag) => ["--platform", tag]),
    "--python-version", PYTHON_VERSION,
    "--implementation", "cp",
    "--only-binary=:all:",
    "--no-deps",
    "--cache-dir", pipCacheDir,
    "--target", sitePackages,
    ...requirements,
  ]);
  for (const extra of PYTHON_EXTRAS) {
    if (!existsSync(path.join(sitePackages, extra.name))) {
      fail(`embedded Python missing ${extra.name} after pip install`);
    }
  }
  if (key === defaultPlatform()) {
    // Smoke test only possible when the embedded interpreter runs on this host.
    const body = PYTHON_EXTRAS.map((extra) => `print("${extra.name}", ${extra.name}.__version__)`)
      .join("; ");
    const check = runOrDie(
      path.join(pythonRoot, platform.pythonBin),
      ["-c", `import ${PYTHON_EXTRAS.map((extra) => extra.name).join(", ")}; ${body}`],
      { capture: true },
    );
    console.log(`[pack]   import check: ${String(check.stdout).trim().replaceAll("\n", " · ")}`);
  }
}

// Native binding packages (e.g. @napi-rs/canvas behind pdfjs-dist) resolve to
// exactly ONE platform variant when pnpm deploy materializes dependencies —
// the pack host's. Cross-packed posix bundles would then crash at boot
// (observed: "DOMMatrix is not defined" from pdfjs-dist on linux). Extend
// supportedArchitectures so install also fetches the target platform's
// optional bindings; the lockfile already records those variants. NOTE: pnpm
// expects the MAP form (os/cpu/libc lists) — an array of per-platform objects
// parses fine as YAML but is silently ignored by install. Host entries stay
// in the lists because the build step (vite/rollup/esbuild) runs on the host.
const ARCH_SPECS = {
  win:
    "  os:\n    - current\n    - win32\n" +
    "  cpu:\n    - current\n    - x64\n" +
    "  libc:\n    - current\n    - msvc",
  linux:
    "  os:\n    - current\n    - linux\n" +
    "  cpu:\n    - current\n    - x64\n" +
    "  libc:\n    - current\n    - glibc",
  macos:
    "  os:\n    - current\n    - darwin\n" +
    "  cpu:\n    - current\n    - arm64",
};

function injectSupportedArchitectures(srcDir, key) {
  const workspaceYaml = path.join(srcDir, "pnpm-workspace.yaml");
  const text = readFileSync(workspaceYaml, "utf8");
  if (/^supportedArchitectures:/m.test(text)) {
    fail("pnpm-workspace.yaml already defines supportedArchitectures; reconcile with scripts/pack-release.mjs");
  }
  const patched =
    `${text.replace(/\s*$/, "")}\n` +
    "# appended by scripts/pack-release.mjs: install native bindings for the\n" +
    "# bundle target too (deploy otherwise materializes host-platform variants only)\n" +
    `supportedArchitectures:\n${ARCH_SPECS[key]}\n`;
  writeFileSync(workspaceYaml, patched);
}

// pnpm deploy materializes native binding variants for the PACK HOST only,
// even though supportedArchitectures made install fetch the target's variants
// into the workspace store. Copy those target-platform binding packages into
// the staged bundle's .pnpm/node_modules fallback dir — Node's module
// resolution walks through it, so e.g. pdfjs-dist finds the real
// @napi-rs/canvas binding at runtime on the target OS. Native binding
// packages are self-contained (a single prebuilt binary), so no further
// dependency wiring is needed. Win bundles skip this: deploy already staged
// the host's win32 bindings.
function stageTargetNativeBindings(srcDir, packageDir, key) {
  if (key === "win") return;
  const osName = key === "linux" ? "linux" : "darwin";
  const storeDir = path.join(srcDir, "node_modules", ".pnpm");
  const fallbackDir = path.join(packageDir, "server", "node_modules", ".pnpm", "node_modules");
  const variantPattern = new RegExp(`-(?:${osName})-(?:x64|arm64)(?:-(?:gnu|msvc))?@`);
  let staged = 0;
  for (const storeEntry of readdirSafe(storeDir)) {
    if (!storeEntry.isDirectory() || !variantPattern.test(storeEntry.name)) continue;
    if (existsSync(path.join(packageDir, "server", "node_modules", ".pnpm", storeEntry.name))) {
      continue; // deploy already materialized this variant
    }
    const variantNodeModules = path.join(storeDir, storeEntry.name, "node_modules");
    for (const scope of readdirSafe(variantNodeModules)) {
      if (!scope.isDirectory() || scope.name === "node_modules") continue;
      const scopeChildren = scope.name.startsWith("@")
        ? readdirSafe(path.join(variantNodeModules, scope.name))
        : [scope];
      for (const binding of scopeChildren) {
        if (!binding.isDirectory() || binding.name.startsWith(".")) continue;
        const dest = path.join(fallbackDir, scope.name, binding.name);
        if (existsSync(dest)) continue;
        mkdirSync(path.dirname(dest), { recursive: true });
        copyDir(path.join(variantNodeModules, scope.name, binding.name), dest);
        console.log(`[pack]   staged native binding for ${key}: ${scope.name}/${binding.name}`);
        staged += 1;
      }
    }
  }
  if (staged === 0) {
    fail(
      `no ${osName} native binding packages found in the workspace store — ` +
        "supportedArchitectures install fetched no target variants; refusing to ship a bundle that cannot boot",
    );
  }
}

function removeStaleTempDirs(outRoot) {
  for (const entry of readdirSafe(outRoot)) {
    if (entry.isDirectory() && entry.name.startsWith(".tmp-pack-")) {
      rmSync(path.join(outRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function copyDir(from, to) {
  cpSync(from, to, { recursive: true });
}

function statSafe(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function dirSizeBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += statSafe(full)?.size ?? 0;
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

// ---- generated files -------------------------------------------------------

function startBatScript() {
  return [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'set "BIOMED_PYTHON_BIN=%~dp0runtime\\python\\python.exe"',
    '"runtime\\node\\node.exe" --env-file-if-exists=.env server\\dist\\index.js --static',
    "",
  ].join("\r\n");
}

function startShScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    `export BIOMED_PYTHON_BIN="$(pwd)/runtime/python/bin/python${PYTHON_MAJOR_MINOR}"`,
    'exec "./runtime/node/bin/node" --env-file-if-exists=.env server/dist/index.js --static',
    "",
  ].join("\n");
}

function readmeText(version, platform) {
  const nodeBinPath = `runtime/node/${platform.nodeBin}`;
  const extras = PYTHON_EXTRAS.map((extra) => `${extra.name} ${extra.version}`).join(" / ");
  return [
    `BioMed-QAgent v${version} 独立部署包（${platform.label}）`,
    "=============================================================",
    "",
    "本包自包含，目标机无需预装 Node / Python / pnpm / uv。",
    `内嵌运行时：Node.js v${NODE_VERSION} · CPython ${PYTHON_VERSION}`,
    `（python-build-standalone ${PYTHON_PBS_TAG}，与 uv 同源；已预装科学计算栈：${extras}）`,
    "",
    "一、启动步骤",
    "  1. 启动服务：",
    "     Windows：双击 start.bat",
    `     Linux  ：chmod +x start.sh runtime/node/bin/node runtime/python/bin/python${PYTHON_MAJOR_MINOR}`,
    "              然后执行 ./start.sh",
    "     macOS  ：与 Linux 相同",
    "  2. 访问 http://127.0.0.1:5173 （API 在 /api/v1 下，WebSocket 在 /api/v1/ws）。",
    "  3. 首次打开页面后，在「设置 → 模型」添加 Provider/API key，添加并激活主模型；",
    "     图形任务还要选择具备图像能力的视觉模型。模型凭据不会从环境变量自动引导。",
    "     如需修改端口，可自行创建 .env 并设置 PORT（默认 5173）。",
    "",
    "二、注意事项",
    "  1. Agent 浏览器工具基于 Playwright，浏览器内核不随包分发，需要时在目标机安装：",
    `     ${nodeBinPath} server/node_modules/playwright/cli.js install chromium`,
    "  2. Linux/macOS 首次运行必须先执行上面的 chmod +x；从 Windows 分发请打 tar.gz",
    "     （zip 会丢失可执行位）。",
    "  3. 平台要求：Linux 需 glibc >= 2.28（Ubuntu 20.04+ / Debian 11+ 等）；",
    "     macOS 需 Apple Silicon（arm64）与 macOS 12 及以上版本。",
    "  4. 内嵌 Python 已预装 numpy/scipy，分析类脚本可直接运行，无需联网安装。",
    "  5. data/settings 与运行期生成的数据都在本目录内，升级或迁移时整目录备份。",
    "  6. 若安全软件拦截内嵌的 node/python，请将本目录加入信任区。",
    "",
    "三、问题排查",
    "  - 启动即退出：检查端口是否被占用；模型未配置时在 Web 设置中完成配置。",
    "  - Linux/macOS 报 Permission denied：见注意事项第 2 条。",
    "",
  ].join("\n");
}

// ---- main -------------------------------------------------------------------

function defaultPlatform() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

// pnpm run forwards the "--" separator itself (observed on pnpm 11), and
// parseArgs treats everything after a bare "--" as positionals — silently
// dropping every flag (platform/out/ref/keep-temp). Strip stray separators so
// `pnpm run pack -- --platform=all` and `pnpm run pack --platform=all` are
// equivalent.
const scriptArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const { values } = parseArgs({
  args: scriptArgs,
  options: {
    platform: { type: "string" },
    out: { type: "string" },
    ref: { type: "string" },
    "keep-temp": { type: "boolean" },
  },
  strict: false,
});

const platformKeys = (values.platform ?? defaultPlatform()).split(",").map((key) => key.trim());
for (const key of platformKeys) {
  if (key !== "all" && !(key in PLATFORMS)) {
    fail(`unknown platform "${key}" (expected win, linux, macos or all)`);
  }
}
const selected = platformKeys.includes("all") ? Object.keys(PLATFORMS) : platformKeys;

const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const outRoot = path.resolve(values.out ?? path.join(repoRoot, "target"));
const ref = values.ref ?? "HEAD";
const cacheDir = path.join(outRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });
removeStaleTempDirs(outRoot);

console.log(`[pack] BioMed-QAgent v${version} · ref=${ref} · out=${outRoot}`);
console.log(`[pack] platforms: ${selected.map((key) => PLATFORMS[key].label).join(", ")}`);
console.log(`[pack] embedded runtimes: Node v${NODE_VERSION} · CPython ${PYTHON_VERSION} (pbs ${PYTHON_PBS_TAG})`);

for (const key of selected) {
  const platform = PLATFORMS[key];
  const packageDir = path.join(outRoot, `biomed-qagent-${version}-${key}`);
  const tmpDir = path.join(outRoot, `.tmp-pack-${key}-${Date.now()}`);
  const srcDir = path.join(tmpDir, "src");

  console.log(`\n[pack] ===== ${platform.label} → ${packageDir} =====`);

  step(1, "snapshot source (git archive)");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  const archive = runOrDie("git", ["archive", "--format=tar", ref], {
    cwd: repoRoot,
    capture: true,
  });
  const archiveFile = path.join(tmpDir, "src.tar");
  writeFileSync(archiveFile, archive.stdout);
  extract(archiveFile, srcDir);
  rmSync(archiveFile, { force: true });

  step(2, "install workspace dependencies");
  injectSupportedArchitectures(srcDir, key);
  runOrDie("pnpm", ["install", "--frozen-lockfile"], { cwd: srcDir });

  step(3, "build contracts / frontend / server");
  runOrDie("pnpm", ["build"], { cwd: srcDir });
  for (const built of [
    path.join(srcDir, "packages", "contracts", "dist"),
    path.join(srcDir, "frontend", "dist"),
    path.join(srcDir, "server", "dist"),
  ]) {
    if (!existsSync(built)) fail(`expected build output missing: ${built}`);
  }

  step(4, "stage application (pnpm deploy for pruned production deps)");
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });
  // pnpm ≥10 only deploys injected workspaces; --legacy keeps the classic
  // self-contained output without switching the whole workspace to injected
  // installs (which would snapshot contracts BEFORE its dist is built).
  runOrDie(
    "pnpm",
    ["--filter", "@biomed/server", "deploy", "--prod", "--legacy", path.join(packageDir, "server")],
    { cwd: srcDir },
  );
  for (const staged of [
    path.join(packageDir, "server", "dist", "index.js"),
    path.join(packageDir, "server", "node_modules", "@biomed", "contracts", "dist", "index.js"),
  ]) {
    if (!existsSync(staged)) fail(`expected staged file missing after deploy: ${staged}`);
  }
  stageTargetNativeBindings(srcDir, packageDir, key);

  step(5, "stage frontend / database / skills");
  copyDir(path.join(srcDir, "frontend", "dist"), path.join(packageDir, "frontend", "dist"));
  copyDir(path.join(srcDir, "database"), path.join(packageDir, "database"));
  copyDir(path.join(srcDir, ".pi"), path.join(packageDir, ".pi"));
  if (!existsSync(path.join(packageDir, "frontend", "dist", "index.html"))) {
    fail("frontend/dist/index.html missing after staging");
  }

  step(6, `embed runtimes (Node ${NODE_VERSION}, CPython ${PYTHON_VERSION})`);
  const nodeArchive = path.join(cacheDir, platform.nodeAsset);
  if (!existsSync(nodeArchive)) {
    download(`${NODE_DIST}/v${NODE_VERSION}/${platform.nodeAsset}`, nodeArchive);
  }
  const nodeExtract = path.join(tmpDir, "node");
  extract(nodeArchive, nodeExtract, { allowSkippedSymlinks: true });
  const nodeInner = path.join(nodeExtract, platform.nodeAsset.replace(/\.zip$|\.tar\.gz$/, ""));
  if (!existsSync(path.join(nodeInner, platform.nodeBin))) {
    fail(`unexpected Node archive layout: ${nodeInner} lacks ${platform.nodeBin}`);
  }
  mkdirSync(path.join(packageDir, "runtime"), { recursive: true });
  renameSync(nodeInner, path.join(packageDir, "runtime", "node"));

  const pyAsset = `cpython-${PYTHON_VERSION}+${PYTHON_PBS_TAG}-${platform.pyTriple}-install_only.tar.gz`;
  const pyArchive = path.join(cacheDir, pyAsset);
  if (!existsSync(pyArchive)) {
    download(`${PBS_DIST}/${PYTHON_PBS_TAG}/${pyAsset}`, pyArchive);
  }
  const pyExtract = path.join(tmpDir, "python");
  extract(pyArchive, pyExtract, { allowSkippedSymlinks: true });
  const pyInner = path.join(pyExtract, "python");
  if (!existsSync(path.join(pyInner, platform.pythonBin))) {
    fail(`unexpected Python archive layout: ${pyInner} lacks ${platform.pythonBin}`);
  }
  renameSync(pyInner, path.join(packageDir, "runtime", "python"));
  installPythonExtras(key, platform, path.join(packageDir, "runtime", "python"), path.join(cacheDir, "pip"));

  step(7, "write launchers and README");
  writeFileSync(path.join(packageDir, "start.bat"), startBatScript());
  writeFileSync(path.join(packageDir, "start.sh"), startShScript());
  chmodSync(path.join(packageDir, "start.sh"), 0o755);
  writeFileSync(path.join(packageDir, "README.txt"), readmeText(version, platform));

  if (values["keep-temp"] !== true) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n[pack] DONE ${platform.label}: ${packageDir} (${formatBytes(dirSizeBytes(packageDir))})`);
}

console.log(`\n[pack] all done. Bundles are under ${outRoot}`);
