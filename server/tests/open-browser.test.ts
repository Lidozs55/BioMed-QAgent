import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  defaultBrowserCommand,
  openInDefaultBrowser,
} from "../src/dev/open-browser.js";

import * as childProcess from "node:child_process";

const spawnMock = vi.mocked(childProcess.spawn);
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function fakeSpawn(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  spawnMock.mockReturnValueOnce(child as never);
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("defaultBrowserCommand", () => {
  test("uses cmd start with an empty title on windows", () => {
    expect(defaultBrowserCommand("http://127.0.0.1:5173/", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", "http://127.0.0.1:5173/"],
    });
  });

  test("uses open on darwin and xdg-open on linux", () => {
    expect(defaultBrowserCommand("http://x/", "darwin")).toEqual({
      command: "open",
      args: ["http://x/"],
    });
    expect(defaultBrowserCommand("http://x/", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://x/"],
    });
  });

  test("returns undefined on unsupported platforms", () => {
    expect(defaultBrowserCommand("http://x/", "freebsd")).toBeUndefined();
  });
});

describe("openInDefaultBrowser", () => {
  test("spawns detached and resolves true once the process starts", async () => {
    const realPlatform = process.platform;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const child = fakeSpawn();
      const pending = openInDefaultBrowser("http://127.0.0.1:5173/");
      child.emit("spawn");
      await expect(pending).resolves.toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        "xdg-open",
        ["http://127.0.0.1:5173/"],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
      expect(child.unref).toHaveBeenCalled();
    } finally {
      vi.spyOn(process, "platform", "get").mockRestore();
      vi.unstubAllGlobals();
      void realPlatform;
    }
  });

  test("resolves false when the launcher binary is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const child = fakeSpawn();
      const pending = openInDefaultBrowser("http://127.0.0.1:5173/");
      child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.spyOn(process, "platform", "get").mockRestore();
    }
  });

  test("resolves false without spawning on unsupported platforms", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("sunos");
    try {
      await expect(openInDefaultBrowser("http://127.0.0.1:5173/")).resolves.toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      vi.spyOn(process, "platform", "get").mockRestore();
    }
  });
});
