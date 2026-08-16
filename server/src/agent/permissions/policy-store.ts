import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "../../persistence/atomic-json.js";
import {
  DEFAULT_PERMISSION_SETTINGS,
  PRESET_MATRICES,
  type FilePermissionRule,
  type PermissionPolicy,
  type PermissionPreset,
  type PermissionSettings,
  type PolicyMatrix,
} from "./types.js";

/**
 * Persistent permission settings (plan §36).
 *
 * Permission configuration is user settings, not task workspace data:
 *
 * ```text
 * data/settings/agent-permissions.json
 * ```
 *
 * Task-scoped temporary grants live in Runtime memory (grants.ts); only
 * persistent rules (and the preset) are written here.
 */
export interface PermissionPolicyStore {
  getSettings(): Promise<PermissionSettings>;
  setPreset(preset: PermissionPreset): Promise<PermissionSettings>;
  setPersistentExecAllow(allowed: boolean): Promise<PermissionSettings>;
  addRule(rule: Omit<FilePermissionRule, "id">): Promise<PermissionSettings>;
  removeRule(ruleId: string): Promise<PermissionSettings>;
  matrix(): Promise<PolicyMatrix>;
}

export class JsonPermissionPolicyStore implements PermissionPolicyStore {
  private readonly filePath: string;
  private cached?: PermissionSettings;
  /** Serializes read-modify-write mutations so concurrent grants never lose rules. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<PermissionSettings> {
    if (this.cached !== undefined) return this.cached;
    const stored = await readJsonFile<PermissionSettings>(this.filePath);
    if (stored === undefined || stored.schema_version !== 1) {
      this.cached = structuredClone(DEFAULT_PERMISSION_SETTINGS);
      return this.cached;
    }
    const preset: PermissionPreset = (stored.preset in PRESET_MATRICES)
      ? stored.preset
      : DEFAULT_PERMISSION_SETTINGS.preset;
    this.cached = {
      schema_version: 1,
      preset,
      rules: Array.isArray(stored.rules) ? stored.rules : [],
      persistent_exec_allow: stored.persistent_exec_allow === true,
    };
    return this.cached;
  }

  /** Apply + persist one mutation. The cache is replaced only after the disk
   * write succeeds, so a failed write never leaves the process with "saved"
   * permissions that differ from what a restart would reload (audit fix). */
  private async save(next: PermissionSettings): Promise<PermissionSettings> {
    await writeJsonAtomic(this.filePath, next);
    this.cached = next;
    return structuredClone(next);
  }

  async getSettings(): Promise<PermissionSettings> {
    return structuredClone(await this.load());
  }

  async setPreset(preset: PermissionPreset): Promise<PermissionSettings> {
    return this.enqueue(async () => {
      const settings = await this.load();
      // Switching to Restricted revokes a previously granted persistent exec
      // approval (audit fix: the flag must never silently survive a stricter
      // preset). The evaluator also hard-denies exec under Restricted, so this
      // is an explicit-state cleanup, not the only line of defense.
      const persistent_exec_allow =
        preset === "restricted" ? false : settings.persistent_exec_allow;
      return this.save({ ...settings, preset, persistent_exec_allow });
    });
  }

  async setPersistentExecAllow(allowed: boolean): Promise<PermissionSettings> {
    return this.enqueue(async () => {
      const settings = await this.load();
      return this.save({ ...settings, persistent_exec_allow: allowed });
    });
  }

  async addRule(rule: Omit<FilePermissionRule, "id">): Promise<PermissionSettings> {
    return this.enqueue(async () => {
      const settings = await this.load();
      return this.save({
        ...settings,
        rules: [...settings.rules, { id: `rule_${randomUUID()}`, ...rule }],
      });
    });
  }

  async removeRule(ruleId: string): Promise<PermissionSettings> {
    return this.enqueue(async () => {
      const settings = await this.load();
      return this.save({
        ...settings,
        rules: settings.rules.filter((rule) => rule.id !== ruleId),
      });
    });
  }

  async matrix(): Promise<PolicyMatrix> {
    const settings = await this.load();
    return PRESET_MATRICES[settings.preset];
  }
}

/** In-memory policy store for tests. */
export class InMemoryPermissionPolicyStore implements PermissionPolicyStore {
  private settings: PermissionSettings = structuredClone(DEFAULT_PERMISSION_SETTINGS);

  async getSettings(): Promise<PermissionSettings> {
    return structuredClone(this.settings);
  }

  async setPreset(preset: PermissionPreset): Promise<PermissionSettings> {
    this.settings = {
      ...this.settings,
      preset,
      persistent_exec_allow:
        preset === "restricted" ? false : this.settings.persistent_exec_allow,
    };
    return structuredClone(this.settings);
  }

  async setPersistentExecAllow(allowed: boolean): Promise<PermissionSettings> {
    this.settings = { ...this.settings, persistent_exec_allow: allowed };
    return structuredClone(this.settings);
  }

  async addRule(rule: Omit<FilePermissionRule, "id">): Promise<PermissionSettings> {
    this.settings = {
      ...this.settings,
      rules: [...this.settings.rules, { id: `rule_${this.settings.rules.length + 1}`, ...rule }],
    };
    return structuredClone(this.settings);
  }

  async removeRule(ruleId: string): Promise<PermissionSettings> {
    this.settings = {
      ...this.settings,
      rules: this.settings.rules.filter((rule) => rule.id !== ruleId),
    };
    return structuredClone(this.settings);
  }

  async matrix(): Promise<PolicyMatrix> {
    return PRESET_MATRICES[this.settings.preset];
  }
}

export function describePolicy(policy: PermissionPolicy): string {
  return policy;
}
