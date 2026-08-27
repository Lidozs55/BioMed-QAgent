import type { JsonValue, SourceAssetRegistrationReceipt } from "@biomed/contracts";

/**
 * Input presented to a Core-owned provider transform.  The transform receives
 * the verified bytes and the exact task-owned registration receipt; it never
 * receives a workspace path or an Agent-authored parser.
 */
export interface ProviderCarrierTransformInput {
  readonly familyId: string;
  readonly source: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly bindingId: string;
  readonly tableId?: string;
  readonly inputRole?: string;
  readonly schemaRef?: string;
  readonly accession?: string | null;
  readonly assetId: string;
  readonly receipt: SourceAssetRegistrationReceipt;
  readonly bytes: Buffer;
  /** Optional source-binding parameters used only as transform facts. */
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  /** Read-only DatasetExecutionSpec entities used only as transform facts. */
  readonly entities?: Readonly<Record<string, readonly string[]>>;
}

export type ProviderCarrierRows = Readonly<Record<string, readonly object[]>>;
export type ProviderCarrierBatchTransform = (
  inputs: readonly ProviderCarrierTransformInput[],
) => ProviderCarrierRows;

export interface ProviderCarrierTransformRegistration {
  readonly familyId: string;
  readonly transform: ProviderCarrierBatchTransform;
}

/**
 * Core dispatch registry for fixed provider transforms.  The generic runtime
 * only consumes this registry; family modules are injected by the family
 * composition root and are not imported from this module.
 */
export class ProviderCarrierTransformRegistry {
  readonly #transforms = new Map<string, ProviderCarrierTransformRegistration>();

  constructor(initial: readonly ProviderCarrierTransformRegistration[] = []) {
    for (const registration of initial) this.register(registration);
  }

  register(registration: ProviderCarrierTransformRegistration): void {
    if (registration.familyId.trim() === "") {
      throw new Error("provider transform family ID must not be blank");
    }
    if (typeof registration.transform !== "function") {
      throw new TypeError(`provider transform '${registration.familyId}' is missing its handler`);
    }
    if (this.#transforms.has(registration.familyId)) {
      throw new Error(`provider transform '${registration.familyId}' is already registered`);
    }
    this.#transforms.set(registration.familyId, Object.freeze({ ...registration }));
  }

  has(familyId: string): boolean {
    return this.#transforms.has(familyId);
  }

  get(familyId: string): ProviderCarrierTransformRegistration {
    const registration = this.#transforms.get(familyId);
    if (registration === undefined) {
      throw new Error(`dataset family '${familyId}' has no provider transform handler`);
    }
    return registration;
  }

  list(): string[] {
    return [...this.#transforms.keys()].sort();
  }
}

/** Resolve a transform from an explicitly injected registry. */
export function providerCarrierTransformForFamily(
  familyId: string,
  registry: ProviderCarrierTransformRegistry = new ProviderCarrierTransformRegistry(),
): ProviderCarrierBatchTransform | null {
  return registry.has(familyId) ? registry.get(familyId).transform : null;
}
