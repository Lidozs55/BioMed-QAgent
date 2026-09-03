import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// PWA install-ability assets are plain files under public/ — vite copies them
// verbatim into dist/, and the static middleware serves them at the root scope.
// These tests pin the contract browsers rely on (manifest fields, icon sizes,
// a fetch-handling service worker).

const publicDir = path.resolve(__dirname, "../../public");

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  // PNG IHDR: width at byte 16, height at byte 20 (big-endian).
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("PWA install-ability assets", () => {
  test("manifest.json declares a standalone app with sized icons", () => {
    const manifestPath = path.join(publicDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");

    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
    }
  });

  test("declared icon files exist with the exact declared dimensions", () => {
    expect(pngSize(path.join(publicDir, "icons/icon-192.png"))).toEqual({
      width: 192,
      height: 192,
    });
    expect(pngSize(path.join(publicDir, "icons/icon-512.png"))).toEqual({
      width: 512,
      height: 512,
    });
  });

  test("sw.js is a pass-through service worker with a fetch handler", () => {
    const sw = readFileSync(path.join(publicDir, "sw.js"), "utf8");
    expect(sw).toContain("addEventListener(\"fetch\"");
    expect(sw).not.toContain("caches.open");
  });

  test("index.html references the manifest and icons", () => {
    const html = readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.json"');
    expect(html).toContain('rel="icon" type="image/png" href="/icons/icon-192.png"');
    expect(html).toContain('name="theme-color" content="#09090b"');
  });
});
