/**
 * Tool registry guards (P5-02). The business tool bundle must fail closed on
 * duplicate tool names — the skill-tool-map contract forbids two tools
 * claiming the same name in one Agent session.
 */

export class DuplicateToolNameError extends Error {
  constructor(
    readonly name: string,
    readonly owners: readonly string[],
  ) {
    super(`duplicate tool name "${name}" (registered by ${owners.join(", ")})`);
    this.name = "DuplicateToolNameError";
  }
}

export interface NamedTool {
  readonly name: string;
}

/** Assert unique tool names across a bundle; returns the tools unchanged. */
export function assertUniqueToolNames<T extends NamedTool>(tools: readonly T[], owner = "bundle"): readonly T[] {
  const seen = new Map<string, number>();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new TypeError(`invalid tool name "${tool.name}"`);
    }
    const existing = seen.get(tool.name);
    if (existing !== undefined) {
      throw new DuplicateToolNameError(tool.name, [`${owner}#${existing}`, `${owner}#${tools.indexOf(tool)}`]);
    }
    seen.set(tool.name, tools.indexOf(tool));
  }
  return tools;
}
