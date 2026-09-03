/**
 * `read_dataset_core_source` tool — read-only access to the deterministic
 * Dataset Core implementation so the agent can consult the authoritative
 * contract when a provider/validation/admission rejection is ambiguous.
 *
 * The source code is the most precise description of what a gate accepts.
 * When a tool rejects an input shape, reading the implementing file is more
 * reliable than guessing further parameter forms.
 *
 * Restricted to the repo ``server/src/dataset`` tree; path traversal and
 * non-source files are rejected. Content is bounded.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BioMedAgentTool } from "../contracts.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_SOURCE_BYTES = 96 * 1024;

export function defaultCoreSourceRoot(): string {
  // Repo layout: server/{src|dist}/agent/tools -> ../../../.. -> repo root.
  return path.resolve(MODULE_DIR, "..", "..", "..", "..", "server", "src", "dataset");
}

function resolveWithinRoot(root: string, requested: string): string {
  const candidate = path.resolve(root, requested);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new TypeError(
      `read_dataset_core_source path must stay inside the Dataset Core source tree; got '${requested}'`,
    );
  }
  return candidate;
}

export interface CoreSourceOptions {
  sourceRoot?: string;
}

export const READ_DATASET_CORE_SOURCE_TOOL_NAME = "read_dataset_core_source";

export function createReadDatasetCoreSourceTool(
  options: CoreSourceOptions = {},
): BioMedAgentTool {
  const sourceRoot = options.sourceRoot ?? defaultCoreSourceRoot();
  return {
    name: READ_DATASET_CORE_SOURCE_TOOL_NAME,
    label: "Read Dataset Core source",
    description:
      "Read a TypeScript source file of the deterministic Dataset Core to learn " +
      "the exact contract a gate or provider enforces. Use this when a " +
      "provider, validation, transform-admission, or publication rejection is " +
      "ambiguous and repeated parameter guessing fails: the source is the " +
      "authoritative description of the accepted input shape. Path is relative " +
      "to the Dataset Core root (server/src/dataset), e.g. " +
      "'acquisition/chembl-provider.ts', 'families/gene-expression/...', " +
      "'transform-admission/admission.ts', 'dynamic-family/preflight.ts'. " +
      "Read-only; only files under the Dataset Core tree are accessible.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path relative to server/src/dataset, e.g. " +
            "'acquisition/chembl-provider.ts'. Directory listings are not " +
            "supported; read a specific file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { path?: unknown };
      const requested = typeof record.path === "string" ? record.path : "";
      if (requested.trim() === "") {
        throw new TypeError("read_dataset_core_source requires a non-empty 'path'");
      }
      const filePath = resolveWithinRoot(sourceRoot, requested);
      const info = await stat(filePath).catch(() => null);
      if (info === null || !info.isFile()) {
        throw new TypeError(
          `read_dataset_core_source: '${requested}' is not a readable Dataset Core source file`,
        );
      }
      if (info.size > MAX_SOURCE_BYTES) {
        throw new TypeError(
          `read_dataset_core_source: '${requested}' is ${info.size} bytes; only files up to ${MAX_SOURCE_BYTES} bytes are returned`,
        );
      }
      const text = await readFile(filePath, "utf8");
      return { content: text };
    },
  };
}
