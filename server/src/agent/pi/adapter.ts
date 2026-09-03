/**
 * ``PiAgentAdapter`` — the ``BioMedAgentAdapter`` implementation assembled
 * from the pi package modules: optional skill-root discovery, Phase-1 system
 * prompt + tool catalog + frozen context composition, config validation, and
 * upstream-session construction.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  BioMedAgentError,
  type BioMedAgentAdapter,
  type BioMedAgentSession,
  type BioMedSessionConfig,
} from "../contracts.js";
import { PHASE1_SYSTEM_PROMPT, SYSTEM_BRIEFING, phase1ResourceRoots } from "../phase1-prompt.js";
import { systemContextSection, toolCatalogPrompt } from "./prompt.js";
import { validateSessionConfig } from "./session-config.js";
import { PiBioMedAgentSession } from "./session.js";
import type { PiAgentAdapterOptions, PiUpstreamSession } from "./types.js";
import { createRealUpstreamSession } from "./upstream-session.js";

export class PiAgentAdapter implements BioMedAgentAdapter {
  private readonly createUpstreamSession: (
    config: BioMedSessionConfig,
  ) => Promise<PiUpstreamSession>;
  private readonly phase1SkillRoot: string;
  private readonly phase1CodeReadRoots: readonly string[];
  private readonly onResourceDiagnostic: (message: string) => void;

  constructor(options: PiAgentAdapterOptions = {}) {
    this.createUpstreamSession =
      options.createUpstreamSession ??
      ((config) =>
        createRealUpstreamSession(config, options.resolveModel));
    this.phase1SkillRoot = options.phase1SkillRoot ?? phase1ResourceRoots().skillRoot;
    this.phase1CodeReadRoots =
      options.phase1CodeReadRoots ?? phase1ResourceRoots().codeReadRoots;
    this.onResourceDiagnostic = options.onResourceDiagnostic ?? (() => undefined);
  }

  private async optionalSkillRoots(): Promise<string[]> {
    try {
      const info = await stat(this.phase1SkillRoot);
      if (!info.isDirectory()) throw new Error("not a directory");
      const entries = await readdir(this.phase1SkillRoot, { withFileTypes: true });
      const hasSkills = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            stat(path.join(this.phase1SkillRoot, entry.name, "SKILL.md"))
              .then(() => true)
              .catch(() => false),
          ),
      );
      if (!hasSkills.some(Boolean)) throw new Error("no skills found");
      return [path.resolve(this.phase1SkillRoot)];
    } catch {
      this.onResourceDiagnostic(
        "Optional Pi Skill resources are unavailable; continuing without them".slice(
          0,
          256,
        ),
      );
      return [];
    }
  }

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    let validated: BioMedSessionConfig | undefined;
    try {
      const optionalSkillRoots = await this.optionalSkillRoots();
      validated = await validateSessionConfig({
        ...config,
        systemPrompt:
          SYSTEM_BRIEFING +
          "\n\n" +
          PHASE1_SYSTEM_PROMPT +
          toolCatalogPrompt(config.tools ?? [], config.initialToolNames ?? (config.tools ?? []).map((tool) => tool.name)) +
          systemContextSection(config.systemContext),
        skillRoots: [...optionalSkillRoots, ...(config.skillRoots ?? [])],
        codeReadRoots: [
          ...this.phase1CodeReadRoots,
          ...(config.codeReadRoots ?? []),
        ],
      });
      const upstream = await this.createUpstreamSession(validated);
      return new PiBioMedAgentSession(upstream, validated);
    } catch (error) {
      await (validated?.cleanup ?? config.cleanup)?.();
      if (error instanceof BioMedAgentError) throw error;
      throw new BioMedAgentError(
        "UPSTREAM_FAILURE",
        "Agent session creation failed",
        { cause: error },
      );
    }
  }
}
