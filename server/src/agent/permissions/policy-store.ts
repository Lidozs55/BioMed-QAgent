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
 * Round-4 audit: rules persisted before the ``resource_scope`` field existed
 * have no scope binding. Loading them as ``project`` is the fail-safe choice:
 * an old ``/repo/** allow`` keeps working for project targets but can never
 * cover ``sensitive``/``external`` requests, and the settings UI shows the
 * effective scope so the user can recreate a broader rule explicitly.
 */
function normalizeStoredRule(rule: FilePermissionRule): FilePermissionRule {
  if (rule.resource_scope !== undefined) return rule;
  return { ...rule, resource_scope: "project" };
}

/**
 * The settings API maps this to HTTP 409: a mutation that contradicts an
 * active policy invariant must be refused at the store level, never just in
 * the UI (round-3 audit: Restricted ⇒ persistent_exec_allow stays false).
 */
export class PermissionPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionPolicyConflictError";
  }
}

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
  addRule(rule: Omit<FilePermissionRule, "id"> & { id?: string }): Promise<PermissionSettings>;
  removeRule(ruleId: string): Promise<PermissionSettings>;
  matrix(): Promise<PolicyMatrix>;
}

export class JsonPermissionPolicyStore implements PermissionPolicyStore {
  private readonly filePath: string;
  private cached?: PermissionSettings;
  private loadPromise: Promise<PermissionSettings> | null = null;
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

  private load(): Promise<PermissionSettings> {
    // Memoize the first load so a mutation racing the initial read cannot
    // interleave: every caller awaits the same settled promise (round-3
    // audit: first-load vs mutation startup race). After the first read the
    // live cache wins — a save may have replaced it while the read was in
    // flight.
    if (this.cached !== undefined) return Promise.resolve(this.cached);
    this.loadPromise ??= this.loadUncached();
    return this.loadPromise.then(() => this.cached as PermissionSettings);
  }

  private async loadUncached(): Promise<PermissionSettings> {
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
      rules: Array.isArray(stored.rules) ? stored.rules.map(normalizeStoredRule) : [],
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
      if (allowed && settings.preset === "restricted") {
        // Round-3 audit: the Restricted preset is a hard lockdown. The flag
        // must never be persisted under Restricted — otherwise switching
        // back to ask_when_needed later would silently resurrect a
        // permanent exec approval the user believed revoked. Enforced in the
        // store, not just the UI.
        throw new PermissionPolicyConflictError(
          "persistent exec approval cannot be enabled while the preset is restricted",
        );
      }
      return this.save({ ...settings, persistent_exec_allow: allowed });
    });
  }

  async addRule(rule: Omit<FilePermissionRule, "id"> & { id?: string }): Promise<PermissionSettings> {
    return this.enqueue(async () => {
      const settings = await this.load();
      return this.save({
        ...settings,
        rules: [...settings.rules, { id: rule.id ?? `rule_${randomUUID()}`, ...rule }],
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
    if (allowed && this.settings.preset === "restricted") {
      // Same invariant as the JSON store (round-3 audit).
      throw new PermissionPolicyConflictError(
        "persistent exec approval cannot be enabled while the preset is restricted",
      );
    }
    this.settings = { ...this.settings, persistent_exec_allow: allowed };
    return structuredClone(this.settings);
  }

  async addRule(rule: Omit<FilePermissionRule, "id"> & { id?: string }): Promise<PermissionSettings> {
    this.settings = {
      ...this.settings,
      rules: [...this.settings.rules, {
        id: rule.id ?? `rule_${this.settings.rules.length + 1}`,
        ...rule,
      }],
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
