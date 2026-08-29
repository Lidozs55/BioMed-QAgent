/**
 * Durable HIL approval-authority settings (three-tier review policy).
 *
 * Persists ``data/settings/hil-approval.json`` and resolves the effective
 * ``HILApprovalMode`` for a request scope. The same store instance is shared
 * between the settings REST surface and the HIL gate so edits take effect
 * immediately for every task, mirroring the agent-permission policy store.
 */
import {
  DEFAULT_HIL_APPROVAL_SETTINGS,
  HIL_APPROVAL_MODES,
  HIL_APPROVAL_SCOPES,
  HIL_HUMAN_MANDATORY_SCOPES,
  parseHilApprovalSettings,
  type HILApprovalMode,
  type HILApprovalScope,
  type HILApprovalSettings,
  type HILKind,
  type HILReviewType,
} from "@biomed/contracts";

import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";

export interface HilApprovalSettingsPatch {
  default_mode?: HILApprovalMode;
  /** A null value clears the scope override back to ``default_mode``. */
  review_modes?: Partial<Record<HILApprovalScope, HILApprovalMode | null>>;
}

export interface HILApprovalPolicyStore {
  getSettings(): Promise<HILApprovalSettings>;
  setSettings(patch: HilApprovalSettingsPatch): Promise<HILApprovalSettings>;
  modeFor(kind: HILKind, reviewType: HILReviewType | null): Promise<HILApprovalMode>;
}

export function scopeOfRequest(
  kind: HILKind,
  reviewType: HILReviewType | null,
): HILApprovalScope {
  if (kind === "permission") return "permission";
  if (reviewType === null) {
    throw new TypeError("review HIL requests must carry a review_type");
  }
  return reviewType;
}

export function isHumanMandatoryScope(scope: HILApprovalScope): boolean {
  return (HIL_HUMAN_MANDATORY_SCOPES as readonly string[]).includes(scope);
}

export interface JsonHilApprovalPolicyStoreOptions {
  now?: () => Date;
}

export class JsonHilApprovalPolicyStore implements HILApprovalPolicyStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, options: JsonHilApprovalPolicyStoreOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
  }

  async getSettings(): Promise<HILApprovalSettings> {
    const value = await readJsonFileOrNull(this.filePath);
    if (value === null) return { ...DEFAULT_HIL_APPROVAL_SETTINGS, review_modes: {} };
    return parseHilApprovalSettings(value);
  }

  /**
   * Merge a validated patch. Human-mandatory scopes (publication boundary,
   * VLM chart evidence, browser evidence acceptance) reject non-human modes:
   * their downstream consumers structurally require ``reviewer === "user"``.
   */
  async setSettings(patch: HilApprovalSettingsPatch): Promise<HILApprovalSettings> {
    const current = await this.getSettings();
    const defaultMode = patch.default_mode ?? current.default_mode;
    if (!(HIL_APPROVAL_MODES as readonly string[]).includes(defaultMode)) {
      throw new TypeError("default_mode must be human_review, llm_pre_review, or auto_approve");
    }
    const reviewModes = { ...current.review_modes, ...patch.review_modes };
    for (const [scope, mode] of Object.entries(reviewModes)) {
      if (!(HIL_APPROVAL_SCOPES as readonly string[]).includes(scope)) {
        throw new TypeError(`review_modes key '${scope}' is not a HIL approval scope`);
      }
      if (mode === undefined || mode === null) {
        delete reviewModes[scope as HILApprovalScope];
        continue;
      }
      if (!(HIL_APPROVAL_MODES as readonly string[]).includes(mode)) {
        throw new TypeError(
          `review_modes.${scope} must be human_review, llm_pre_review, or auto_approve`,
        );
      }
      if (isHumanMandatoryScope(scope as HILApprovalScope) && mode !== "human_review") {
        throw new TypeError(
          `review_modes.${scope} always requires human review ` +
            "(downstream consumers validate reviewer === user)",
        );
      }
    }
    const settings = parseHilApprovalSettings({
      schema_version: "1.0",
      default_mode: defaultMode,
      review_modes: reviewModes,
    });
    await this.persist(settings);
    return settings;
  }

  async modeFor(kind: HILKind, reviewType: HILReviewType | null): Promise<HILApprovalMode> {
    const settings = await this.getSettings();
    return settings.review_modes[scopeOfRequest(kind, reviewType)] ?? settings.default_mode;
  }

  private async persist(settings: HILApprovalSettings): Promise<void> {
    const previous = this.writeChain;
    const current = previous.then(async () => {
      await writeJsonAtomic(this.filePath, {
        ...settings,
        updated_at: this.now().toISOString(),
      });
    });
    this.writeChain = current.catch(() => undefined);
    await current;
  }
}
