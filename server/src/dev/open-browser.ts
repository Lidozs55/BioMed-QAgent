/**
 * Opens a URL in the platform default browser.
 *
 * Used by the `--open` host flag so bundle launchers can drop the user
 * straight into the UI without copying the printed URL by hand. Failure is
 * reported (not thrown): a missing `xdg-open` on a headless box must never
 * take the host down.
 */

import { spawn } from "node:child_process";

export interface BrowserCommand {
  command: string;
  args: string[];
}

export function defaultBrowserCommand(
  url: string,
  platform: NodeJS.Platform,
): BrowserCommand | undefined {
  if (platform === "win32") {
    // `start "" <url>` — the empty title argument keeps `start` from treating
    // a quoted URL as the window title.
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  return undefined;
}

export function openInDefaultBrowser(url: string): Promise<boolean> {
  const target = defaultBrowserCommand(url, process.platform);
  if (target === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(target.command, target.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
