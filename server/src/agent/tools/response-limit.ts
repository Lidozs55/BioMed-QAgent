export interface BoundedJsonOptions {
  source: string;
  intrinsicMaxBytes: number;
  configuredMaxBytes?: number;
}

/**
 * Runtime settings may tighten a curated tool's response budget but cannot
 * raise its tool-specific intrinsic ceiling.
 */
export function resolveToolResponseLimit(
  intrinsicMaxBytes: number,
  configuredMaxBytes?: number,
): number {
  for (const [name, value] of [
    ["intrinsicMaxBytes", intrinsicMaxBytes],
    ["configuredMaxBytes", configuredMaxBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return Math.min(intrinsicMaxBytes, configuredMaxBytes ?? intrinsicMaxBytes);
}

export function formatByteLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : `${bytes} bytes`;
}

export async function readBoundedJson(
  body: AsyncIterable<Buffer>,
  options: BoundedJsonOptions,
): Promise<unknown> {
  const maxBytes = resolveToolResponseLimit(
    options.intrinsicMaxBytes,
    options.configuredMaxBytes,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`${options.source} response exceeds ${formatByteLimit(maxBytes)}`);
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
