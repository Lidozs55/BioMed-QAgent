#!/usr/bin/env node
// scripts/pack-release.mjs — standalone packager for BioMed-QAgent.
//
// Produces a self-contained, runnable bundle per platform into target/:
//   target/biomed-qagent-<version>-<win|linux|macos>/
//     start.bat / start.sh        desktop entry: desktop-app.py — pywebview native
//                                 window, system-browser fallback (default entry)
//     start-server.bat / .sh      service entry: host --static --open (no window stack)
//     BioMed-QAgent.exe           Windows double-click entry (win bundle only) — a
//                                 windowed PyInstaller shim, built in-script, that
//                                 runs runtime\python\python.exe desktop-app.py and
//                                 logs to launcher.log (see win-exe-wrapper.py)
//     desktop-app.py              desktop launcher logic (spawn host, open window/browser)
//     assets/icon.ico             app icon (Windows exe / desktop shortcuts)
//     server/                     compiled Application Host + pruned production node_modules
//     frontend/dist/              compiled SPA, served by the host (--static); PWA-installable
//     database/                   stdlib-only Python persistence bridge
//     .pi/                        agent skills
//     runtime/node/               embedded Node.js (portable, nodejs.org)
//     runtime/python/             embedded CPython (python-build-standalone, same distro uv uses)
//                                 with the pinned scientific stack (PYTHON_EXTRAS) and, on
//                                 win/macos, the pywebview desktop stack (DESKTOP_EXTRAS)
//
// The target machine needs nothing preinstalled: no Node, no Python, no pnpm, no uv.
// The host resolves the Python interpreter via BIOMED_PYTHON_BIN (see
// server/src/persistence/db-client.ts probePythonBin), which the launchers set to the
// embedded runtime — that is the only integration point, no source changes needed.
//
// Usage (from the repository root):
//   pnpm run pack [-- --platform=win|linux|macos|all] [--out=<dir>] [--ref=<git-ref>] [--keep-temp] [--no-appimage]
//   pnpm pack:target --platform=all     (alias; plain `pnpm pack` is pnpm's built-in tarball command)
//   --no-appimage: skip the linux single-file AppImage step (dir bundle is always produced)
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
  copyFileSync,
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
// Desktop window stack (pywebview) for the desktop launchers: Windows opens a
// WebView2 window via pythonnet, macOS a WKWebView window via pyobjc. Linux
// gets nothing — PyGObject cannot be pip-installed, so desktop-app.py falls
// back to the system browser there. Runtime deps are listed explicitly
// because the pip step installs with --no-deps; `checkDir` is the
// site-packages directory a package installs (differs from the pip name for
// pyobjc). Pinned like PYTHON_EXTRAS; bump deliberately.
const DESKTOP_EXTRAS = {
  win: [
    { name: "pywebview", version: "5.4.0", checkDir: "webview" },
    { name: "bottle", version: "0.13.2", checkDir: "bottle.py" },
    { name: "proxy-tools", version: "0.1.0", checkDir: "proxy_tools", sdistOnly: true },
    { name: "typing_extensions", version: "4.12.2", checkDir: "typing_extensions.py" },
    { name: "pythonnet", version: "3.0.5" },
    { name: "clr-loader", version: "0.2.6", checkDir: "clr_loader" },
    // clr_loader imports cffi at runtime; cffi pulls pycparser. With --no-deps
    // every transitive module must be listed (verified against a real WebView2
    // window: pythonnet -> clr_loader -> cffi -> pycparser -> .NET Framework).
    { name: "cffi", version: "1.17.1", checkDir: "cffi" },
    { name: "pycparser", version: "2.22", checkDir: "pycparser" },
  ],
  macos: [
    { name: "pywebview", version: "5.4.0", checkDir: "webview" },
    { name: "bottle", version: "0.13.2", checkDir: "bottle.py" },
    { name: "proxy-tools", version: "0.1.0", checkDir: "proxy_tools", sdistOnly: true },
    { name: "typing_extensions", version: "4.12.2", checkDir: "typing_extensions.py" },
    { name: "pyobjc-core", version: "10.3.1", checkDir: "objc" },
    { name: "pyobjc-framework-Cocoa", version: "10.3.1", checkDir: "Cocoa" },
    { name: "pyobjc-framework-WebKit", version: "10.3.1", checkDir: "WebKit" },
  ],
};
const PYTHON_MAJOR_MINOR = PYTHON_VERSION.split(".").slice(0, 2).join(".");

// Windows double-click entry (win bundle only): a windowed PyInstaller shim
// (win-exe-wrapper.py) that runs the bundle's desktop-app.py with the embedded
// runtime python. Built with the uv environment from packaging/windows — its
// lockfile pins the PyInstaller version; the launcher code in that project is
// NOT part of the exe, desktop-app.py stays the single launcher code path.
const WIN_EXE_NAME = "BioMed-QAgent.exe";
const WIN_EXE_WRAPPER = path.join("scripts", "packaging", "win-exe-wrapper.py");
const WIN_EXE_ICON = path.join("assets", "logo", "icon.ico");
const WIN_EXE_PROJECT = path.join("packaging", "windows");

const NODE_DIST = "https://nodejs.org/dist";
const PBS_DIST =
  "https://github.com/astral-sh/python-build-standalone/releases/download";
// Official continuous build; the only AppImage tool we need at pack time.
// Run with --appimage-extract-and-run so build hosts without FUSE work.
const APPIMAGETOOL_URL =
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";
const APPIMAGETOOL_ASSET = "appimagetool-x86_64.AppImage";

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

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Windows Defender / 索引服务会瞬时锁定刚解压出的运行时文件，紧接着的目录
// rename 会撞上 EPERM/EACCES/EBUSY；等待后重试即可恢复。
function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const retryable =
        error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY";
      if (!retryable || attempt >= attempts) throw error;
      console.log(`[pack]   rename busy (${error.code}); retrying in 2s (${attempt}/${attempts - 1})`);
      sleepSync(2_000);
    }
  }
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
// Builds wheels for extras whose PyPI distribution is sdist-only (proxy-tools
// ships no wheel at all) into a local find-links directory. The packages are
// pure Python, so the built py3-none-any wheel is target-independent — the
// pip install below stays --only-binary=:all: (the local wheel satisfies it),
// keeping the no-sdist-execution-at-install-time policy intact.
function ensureLocalWheels(extras, driver, localWheelsDir) {
  const sdistOnly = extras.filter((extra) => extra.sdistOnly === true);
  if (sdistOnly.length === 0) return null;
  mkdirSync(localWheelsDir, { recursive: true });
  for (const extra of sdistOnly) {
    const packageName = extra.name.replaceAll("-", "_");
    const existing = readdirSync(localWheelsDir).find(
      (file) => file.startsWith(`${packageName}-`) && file.endsWith(".whl"),
    );
    if (existing !== undefined) continue;
    console.log(
      `[pack]   building local wheel for sdist-only ${extra.name}==${extra.version}`,
    );
    runOrDie(driver, [
      "-m", "pip", "wheel", "--no-deps",
      "--wheel-dir", localWheelsDir,
      `${extra.name}==${extra.version}`,
    ]);
  }
  return localWheelsDir;
}

function installPythonExtras(key, platform, pythonRoot, pipCacheDir) {
  if (PYTHON_EXTRAS.length === 0) return;
  const sitePackages = path.join(pythonRoot, platform.sitePackages);
  mkdirSync(sitePackages, { recursive: true });
  const driver = resolvePipDriver(key, platform, pythonRoot);
  const extras = [...PYTHON_EXTRAS, ...(DESKTOP_EXTRAS[key] ?? [])];
  const requirements = extras.map((extra) => `${extra.name}==${extra.version}`);
  const localWheels = ensureLocalWheels(
    extras,
    driver,
    path.join(pipCacheDir, "local-wheels"),
  );
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
    ...(localWheels !== null ? ["--find-links", localWheels] : []),
    "--target", sitePackages,
    ...requirements,
  ]);
  for (const extra of extras) {
    const installedDir = extra.checkDir ?? extra.name;
    if (!existsSync(path.join(sitePackages, installedDir))) {
      fail(`embedded Python missing ${extra.name} after pip install`);
    }
  }
  if (key === defaultPlatform()) {
    // Smoke test only possible when the embedded interpreter runs on this host.
    // Only the scientific stack is import-checked: desktop extras (pythonnet,
    // pyobjc) may pull native frameworks that are cheap to import but slow to
    // initialize, and they get their own self-test via desktop-app.py.
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
// even though supportedArchitectures made install fetch the target's variants.
// Two install layouts must be handled here:
//  - hoisted (nodeLinker: hoisted, this repo's exFAT-safe setting): deploy
//    materializes the host==target variant directly under
//    server/node_modules/<pkg>-<os>-<arch> — for cross-packs the target
//    variant sits at the SNAPSHOT's hoisted top level instead;
//  - .pnpm virtual store (classic layout): target variants live under
//    srcDir/node_modules/.pnpm/<entry>/node_modules/... and are copied into
//    the bundle's .pnpm/node_modules fallback dir — Node's module resolution
//    walks through it, so e.g. pdfjs-dist finds the real @napi-rs/canvas
//    binding at runtime on the target OS. Native binding packages are
//    self-contained (a single prebuilt binary), so no further dependency
//    wiring is needed. Win bundles skip this: deploy already staged the
//    host's win32 bindings.
function findHoistedVariant(modulesDir, osName) {
  const variantName = new RegExp(`-(?:${osName})-(?:x64|arm64)(?:-(?:gnu|msvc))?$`);
  for (const entry of readdirSafe(modulesDir)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (variantName.test(entry.name)) return entry.name;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSafe(path.join(modulesDir, entry.name))) {
        if (scoped.isDirectory() && variantName.test(scoped.name)) {
          return `${entry.name}/${scoped.name}`;
        }
      }
    }
  }
  return undefined;
}

function stageTargetNativeBindings(srcDir, packageDir, key) {
  if (key === "win") return;
  const osName = key === "linux" ? "linux" : "darwin";
  const stagedServerModules = path.join(packageDir, "server", "node_modules");
  const fallbackDir = path.join(stagedServerModules, ".pnpm", "node_modules");

  // Same-platform packing with the hoisted linker: deploy already put the
  // target variant at the top level — nothing to stage.
  const hoisted = findHoistedVariant(stagedServerModules, osName);
  if (hoisted !== undefined) {
    console.log(`[pack]   target native binding materialized by deploy: ${hoisted}`);
    return;
  }

  const storeDir = path.join(srcDir, "node_modules", ".pnpm");
  const variantPattern = new RegExp(`-(?:${osName})-(?:x64|arm64)(?:-(?:gnu|msvc))?@`);
  let staged = 0;
  let alreadyDeployed = 0;
  for (const storeEntry of readdirSafe(storeDir)) {
    if (!storeEntry.isDirectory() || !variantPattern.test(storeEntry.name)) continue;
    if (existsSync(path.join(stagedServerModules, ".pnpm", storeEntry.name))) {
      alreadyDeployed += 1; // deploy already materialized this variant
      continue;
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
  // Cross-packing with the hoisted linker: the supportedArchitectures install
  // fetched the target variant into the snapshot's hoisted top level.
  const snapshotHoisted = findHoistedVariant(path.join(srcDir, "node_modules"), osName);
  if (snapshotHoisted !== undefined) {
    const source = path.join(srcDir, "node_modules", snapshotHoisted);
    const dest = path.join(fallbackDir, snapshotHoisted);
    if (!existsSync(dest)) {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyDir(source, dest);
      console.log(`[pack]   staged native binding for ${key}: ${snapshotHoisted}`);
      staged += 1;
    }
  }
  if (staged === 0 && alreadyDeployed === 0) {
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

// Desktop launcher: pywebview native window via desktop-app.py, with an
// automatic system-browser fallback when the platform webview backend is
// unavailable (default entry on every platform).
function desktopStartBatScript() {
  return [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'set "BIOMED_PYTHON_BIN=%~dp0runtime\\python\\python.exe"',
    '"%~dp0runtime\\python\\python.exe" desktop-app.py',
    "",
  ].join("\r\n");
}

function desktopStartShScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    `export BIOMED_PYTHON_BIN="$(pwd)/runtime/python/bin/python${PYTHON_MAJOR_MINOR}"`,
    `exec "./runtime/python/bin/python${PYTHON_MAJOR_MINOR}" desktop-app.py`,
    "",
  ].join("\n");
}

// Headless/service launcher: run the host directly and auto-open the system
// browser (--open); no windowing stack involved. Also the recovery path when
// the embedded Python cannot start desktop-app.py.
function serverStartBatScript() {
  return [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'set "BIOMED_PYTHON_BIN=%~dp0runtime\\python\\python.exe"',
    '"runtime\\node\\node.exe" --env-file-if-exists=.env server\\dist\\index.js --static --open',
    "",
  ].join("\r\n");
}

function serverStartShScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    `export BIOMED_PYTHON_BIN="$(pwd)/runtime/python/bin/python${PYTHON_MAJOR_MINOR}"`,
    'exec "./runtime/node/bin/node" --env-file-if-exists=.env server/dist/index.js --static --open',
    "",
  ].join("\n");
}

// AppImage entry (linux only). The squashfs mount is read-only, so all
// writable state — settings, tasks, workspaces, cache, skill data — is
// relocated by exporting an ABSOLUTE OUTPUT_DIR: the host derives every data
// root from it (dataRoot = tasksRoot/../.., see server/src/bootstrap.ts and
// resolveOutputDir in server/src/config.ts). Relative values would re-anchor
// to the read-only mount, so keep the ${HOME}-based default.
function appRunScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'APPDIR="${APPDIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"',
    'export OUTPUT_DIR="${OUTPUT_DIR:-$HOME/.local/share/biomed-qagent/output}"',
    `exec "$APPDIR/runtime/python/bin/python${PYTHON_MAJOR_MINOR}" "$APPDIR/desktop-app.py"`,
    "",
  ].join("\n");
}

// appimagetool rewrites Exec/Icon to the deployed AppImage path on install;
// these values only need to be present and valid desktop-entry syntax.
function desktopEntryFile() {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=BioMed QAgent",
    "Comment=Biomedical research-question agent with a deterministic dataset core",
    "Exec=bio-med-qagent",
    "Icon=biomed-qagent",
    "Terminal=false",
    "Categories=Science;",
    "",
  ].join("\n");
}

// Assemble the AppImage from the (already self-contained) bundle directory:
// AppRun + .desktop + icon make the bundle a valid AppDir in place.
// Builds the Windows double-click entry (BioMed-QAgent.exe) into the bundle
// root: a windowed onefile PyInstaller shim from win-exe-wrapper.py. The uv
// environment from packaging/windows (versions pinned in its uv.lock) only
// provides the PyInstaller toolchain — no launcher code is collected, so the
// build stays fast and desktop-app.py remains the single launcher code path.
function buildWindowsExeWrapper(srcDir, packageDir, tmpDir) {
  runOrDie("uv", ["sync", "--project", WIN_EXE_PROJECT, "--locked"], { cwd: srcDir });
  runOrDie(
    "uv",
    [
      "run", "--project", WIN_EXE_PROJECT, "--no-sync",
      "pyinstaller",
      "--noconfirm", "--clean", "--onefile", "--windowed",
      "--name", WIN_EXE_NAME.replace(/\.exe$/u, ""),
      "--icon", path.join(srcDir, WIN_EXE_ICON),
      "--distpath", packageDir,
      "--workpath", path.join(tmpDir, "pyinstaller", "work"),
      "--specpath", path.join(tmpDir, "pyinstaller", "spec"),
      path.join(srcDir, WIN_EXE_WRAPPER),
    ],
    { cwd: srcDir },
  );
  if (!existsSync(path.join(packageDir, WIN_EXE_NAME))) {
    fail(`exe wrapper missing after PyInstaller: ${path.join(packageDir, WIN_EXE_NAME)}`);
  }
}

function buildAppImage(packageDir, cacheDir, outRoot, version) {
  const appImage = path.join(outRoot, `BioMed-QAgent-${version}-x86_64.AppImage`);
  if (existsSync(appImage)) rmSync(appImage, { force: true });
  writeFileSync(path.join(packageDir, "AppRun"), appRunScript());
  chmodSync(path.join(packageDir, "AppRun"), 0o755);
  writeFileSync(path.join(packageDir, "biomed-qagent.desktop"), desktopEntryFile());
  copyFileSync(
    path.join(packageDir, "frontend", "dist", "icons", "icon-512.png"),
    path.join(packageDir, "biomed-qagent.png"),
  );
  const appimagetool = path.join(cacheDir, APPIMAGETOOL_ASSET);
  if (!existsSync(appimagetool)) {
    download(APPIMAGETOOL_URL, appimagetool);
  }
  chmodSync(appimagetool, 0o755);
  runOrDie(appimagetool, [
    "--appimage-extract-and-run",
    "--no-appstream",
    "--comp", "zstd",
    packageDir,
    appImage,
  ]);
  const info = statSync(appImage);
  if (!info.isFile() || info.size < 1024 * 1024) {
    fail(`AppImage output missing or suspiciously small: ${appImage}`);
  }
  console.log(`[pack]   AppImage: ${appImage} (${formatBytes(info.size)})`);
  return appImage;
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
    "  1. 启动（推荐，桌面窗口）：",
    "     Windows：双击 BioMed-QAgent.exe，或双击 start.bat（命令行排障更直观）",
    "     Linux  ：chmod +x start.sh runtime/node/bin/node runtime/python/bin/python" + PYTHON_MAJOR_MINOR,
    "              然后执行 ./start.sh",
    "     macOS  ：与 Linux 相同",
    "     桌面窗口基于系统 WebView（Windows: WebView2 / macOS: WKWebView）；",
    "     组件缺失时自动改用系统默认浏览器打开，服务不受影响。",
    "     Linux 包未内嵌窗口组件，将直接以系统浏览器打开。",
    "  2. 服务模式（不开窗口，启动后自动打开浏览器）：",
    "     Windows：双击 start-server.bat；Linux/macOS：执行 ./start-server.sh",
    "  3. 访问地址默认 http://127.0.0.1:5173（API 在 /api/v1 下，WebSocket 在 /api/v1/ws）；",
    "     端口被占用时自动回退，以启动日志打印的 BIOMED_QAGENT_URL 为准。",
    "  4. 首次打开页面后，在「设置 → 模型」添加 Provider/API key，添加并激活主模型；",
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
    "  - 桌面窗口未打开或一闪而过：改用 start-server.bat / start-server.sh",
    "    （浏览器模式，行为等价）。",
    "  - Windows 双击 BioMed-QAgent.exe 无反应或报错：查看同目录 launcher.log；",
    "    该文件在每次通过 exe 启动时重写。",
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
    "no-appimage": { type: "boolean" },
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
  // Source remains part of the supported runtime contract: Phase 1 validates
  // these roots and the read-only source tool reads Dataset Core directly.
  copyDir(path.join(srcDir, "server", "src"), path.join(packageDir, "server", "src"));
  copyDir(
    path.join(srcDir, "packages", "contracts", "src"),
    path.join(packageDir, "packages", "contracts", "src"),
  );
  for (const staged of [
    path.join(packageDir, "server", "dist", "index.js"),
    path.join(packageDir, "server", "node_modules", "@biomed", "contracts", "dist", "index.js"),
    path.join(packageDir, "server", "src", "dataset", "service", "dataset-core.ts"),
    path.join(packageDir, "packages", "contracts", "src", "index.ts"),
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
  renameWithRetry(nodeInner, path.join(packageDir, "runtime", "node"));

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
  renameWithRetry(pyInner, path.join(packageDir, "runtime", "python"));
  installPythonExtras(key, platform, path.join(packageDir, "runtime", "python"), path.join(cacheDir, "pip"));

  step(7, "write launchers, desktop entry and README");
  if (key === "win") {
    writeFileSync(path.join(packageDir, "start.bat"), desktopStartBatScript());
    writeFileSync(path.join(packageDir, "start-server.bat"), serverStartBatScript());
  } else {
    writeFileSync(path.join(packageDir, "start.sh"), desktopStartShScript());
    writeFileSync(path.join(packageDir, "start-server.sh"), serverStartShScript());
    chmodSync(path.join(packageDir, "start.sh"), 0o755);
    chmodSync(path.join(packageDir, "start-server.sh"), 0o755);
  }
  // Desktop entry comes from the git snapshot (not the working tree) so a
  // bundle is reproducible from its --ref; icon.ico is the exe/shortcut icon.
  copyFileSync(
    path.join(srcDir, "scripts", "packaging", "desktop-app.py"),
    path.join(packageDir, "desktop-app.py"),
  );
  mkdirSync(path.join(packageDir, "assets"), { recursive: true });
  copyFileSync(path.join(srcDir, "assets", "logo", "icon.ico"), path.join(packageDir, "assets", "icon.ico"));
  writeFileSync(path.join(packageDir, "README.txt"), readmeText(version, platform));

  step(8, "desktop-app self-test");
  const selfTestPython = resolvePipDriver(key, platform, path.join(packageDir, "runtime", "python"));
  runOrDie(selfTestPython, [path.join(packageDir, "desktop-app.py"), "--self-test"]);

  if (key === "win") {
    step(9, "build BioMed-QAgent.exe (windowed desktop-entry wrapper)");
    buildWindowsExeWrapper(srcDir, packageDir, tmpDir);
  }

  if (key === "linux" && values["no-appimage"] !== true) {
    step(10, "assemble AppImage (single-file linux release)");
    buildAppImage(packageDir, cacheDir, outRoot, version);
  }

  if (values["keep-temp"] !== true) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n[pack] DONE ${platform.label}: ${packageDir} (${formatBytes(dirSizeBytes(packageDir))})`);
}

console.log(`\n[pack] all done. Bundles are under ${outRoot}`);
