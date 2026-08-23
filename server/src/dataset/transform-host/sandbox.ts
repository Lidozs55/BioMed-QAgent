export interface SandboxAvailability {
  available: false;
  reason: "sandbox_unavailable";
  platform: NodeJS.Platform;
  detail: string;
}

/**
 * No production isolation backend is implemented in this MVP. In particular,
 * Windows is not downgraded to worker_threads, node:vm, or a same-account
 * child process. Callers must keep Agent-authored transforms disabled.
 */
export function detectSandboxAvailability(platform: NodeJS.Platform = process.platform): SandboxAvailability {
  const platformDetail = platform === "win32"
    ? "Windows service-account/ACL + Job Object + network-deny isolation is not implemented"
    : `No approved OS isolation backend is configured for ${platform}`;
  return {
    available: false,
    reason: "sandbox_unavailable",
    platform,
    detail: `${platformDetail}; Agent-authored transforms are disabled`,
  };
}
