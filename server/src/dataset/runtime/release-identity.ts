import { randomUUID } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

export type CoreRuntimeEnvironment = "production" | "staging" | "dev" | "test";

export interface ResolveCoreReleaseIdentityOptions {
  environment: CoreRuntimeEnvironment;
  configuredIdentity?: string | null;
  buildArtifactDigest?: string | null;
}

export type CoreReleaseIdentityFailureCode =
  | "CORE_RELEASE_IDENTITY_REQUIRED"
  | "CORE_RELEASE_IDENTITY_INVALID";

/** Typed startup refusal when Core cannot establish a safe release identity. */
export class CoreReleaseIdentityStartupError extends Error {
  constructor(
    readonly code: CoreReleaseIdentityFailureCode,
    readonly environment: CoreRuntimeEnvironment,
    message: string,
  ) {
    super(message);
    this.name = "CoreReleaseIdentityStartupError";
  }
}

// Deliberately module-local and never persisted. Reloading this module models a
// process restart and must produce a different identity.
const PROCESS_RELEASE_IDENTITY = `ref:process-${randomUUID()}`;

function canonicalIdentity(value: string, source: "configured identity" | "build artifact digest"): string {
  const candidate = value.trim();
  const digest = candidate.startsWith("sha256:") ? candidate.slice("sha256:".length) : candidate;
  if (SHA256.test(digest)) return `sha256:${digest}`;

  if (source === "configured identity" && candidate.startsWith("ref:")) {
    const ref = candidate.slice("ref:".length);
    if (SAFE_REF.test(ref) && !ref.startsWith("process-")) return `ref:${ref}`;
  }

  throw new CoreReleaseIdentityStartupError(
    "CORE_RELEASE_IDENTITY_INVALID",
    "production",
    `${source} must be a safe canonical release identity (sha256:<64 lowercase hex> or ref:<safe ref>)`,
  );
}

/**
 * Resolve the identity used by Dataset Core operation reuse.
 *
 * Artifact digests are accepted only as verified caller-provided facts; this
 * function does not fingerprint source bytes or imply an artifact closure.
 */
export function resolveCoreReleaseIdentity(
  options: ResolveCoreReleaseIdentityOptions,
): string {
  const { environment, configuredIdentity, buildArtifactDigest } = options;
  if (configuredIdentity !== undefined && configuredIdentity !== null && configuredIdentity.trim() !== "") {
    try {
      return canonicalIdentity(configuredIdentity, "configured identity");
    } catch (error) {
      if (error instanceof CoreReleaseIdentityStartupError) {
        throw new CoreReleaseIdentityStartupError(error.code, environment, error.message);
      }
      throw error;
    }
  }

  if (buildArtifactDigest !== undefined && buildArtifactDigest !== null && buildArtifactDigest.trim() !== "") {
    const digest = buildArtifactDigest.trim();
    if (SHA256.test(digest)) return `sha256:${digest}`;
    throw new CoreReleaseIdentityStartupError(
      "CORE_RELEASE_IDENTITY_INVALID",
      environment,
      "build artifact digest must be a canonical lowercase sha256 identity",
    );
  }

  if (environment === "production" || environment === "staging") {
    throw new CoreReleaseIdentityStartupError(
      "CORE_RELEASE_IDENTITY_REQUIRED",
      environment,
      `${environment} Dataset Core requires a verified release identity at startup`,
    );
  }

  return PROCESS_RELEASE_IDENTITY;
}
