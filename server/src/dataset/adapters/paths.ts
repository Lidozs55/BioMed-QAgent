/**
 * Shared dataset path helpers (deduplicated from ``publish/manifest.ts``,
 * ``publish/publisher.ts``, ``integrator/integrator.ts`` and
 * ``validation/profile.ts``).
 */

/** Normalize a path to POSIX separators. */
export function asPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Join an output directory and file name with a single ``/`` separator. */
export function joinOutput(outputDir: string, name: string): string {
  return `${outputDir.replace(/[\\/]+$/, "")}/${name}`;
}