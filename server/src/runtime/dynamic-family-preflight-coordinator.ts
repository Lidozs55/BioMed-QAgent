import type { DynamicFamilyPreflightReceipt } from "@biomed/contracts";

import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";

const DIGEST = /^[0-9a-f]{64}$/u;

export interface DynamicFamilyPreflightPreparation {
  readonly requirementId: string;
  readonly generation: number;
  readonly sequence: number;
}

export interface DynamicFamilyPreflightReservation {
  readonly requirementId: string;
  readonly generation: number;
  readonly receiptDigest: string;
}

interface ActiveReceipt {
  readonly generation: number;
  readonly sequence: number;
  readonly receiptDigest: string;
  readonly submissionDigest: string;
  /** Server-side copy of the prepared submission enabling receipt-only submit. */
  readonly storedSubmission: unknown;
  consumed: boolean;
  reservationToken: object | null;
}

interface ExecutionState {
  generation: number;
  sequence: number;
  hasPrepared: boolean;
  active: ActiveReceipt | null;
}

interface ReservationState {
  readonly requirementId: string;
  readonly generation: number;
  readonly token: object;
}

interface PersistedActiveReceipt {
  readonly generation: number;
  readonly sequence: number;
  readonly receipt_digest: string;
  readonly submission_digest: string;
  readonly stored_submission?: unknown;
  readonly consumed: boolean;
}

interface PersistedExecutionState {
  readonly requirement_id: string;
  readonly generation: number;
  readonly sequence: number;
  readonly has_prepared: boolean;
  readonly active: PersistedActiveReceipt | null;
}

interface PersistedCoordinatorState {
  readonly schema_version: "1.0";
  readonly states: readonly PersistedExecutionState[];
}

export interface DynamicFamilyPreflightCoordinatorOptions {
  /** Optional task-owned state file. Omit for an in-memory test coordinator. */
  readonly stateFile?: string;
}

export interface DynamicFamilyPreflightCoordinator {
  /** Begin a new prepare and synchronously invalidate the prior receipt. */
  beginPrepare(requirementId: string): Promise<DynamicFamilyPreflightPreparation>;
  /** Commit only the latest in-flight preparation for its build. */
  commitPrepare(
    preparation: DynamicFamilyPreflightPreparation,
    receipt: DynamicFamilyPreflightReceipt,
    submissionDigest: string,
    storedSubmission?: unknown,
  ): Promise<void>;
  /**
   * Resolve the server-side prepared submission bound to a live (not yet
   * consumed) receipt. Receipt-only submit uses this instead of re-echoing the
   * whole payload; the returned reference is the exact object passed to
   * commitPrepare, so integrity is anchored by the receipt digest chain.
   */
  resolveSubmission<T = unknown>(receipt: DynamicFamilyPreflightReceipt): Promise<T>;
  /** Atomically consume the current receipt before any acquisition side effect. */
  reserve(receipt: DynamicFamilyPreflightReceipt, submissionDigest: string): Promise<DynamicFamilyPreflightReservation>;
  /** Clear a consumed receipt after success or failure. */
  complete(reservation: DynamicFamilyPreflightReservation): Promise<void>;
  /** Live generation fence checked by acquisition/transform execution. */
  isCurrent(reservation: DynamicFamilyPreflightReservation): boolean;
}

function jsonClone(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("stored dynamic preflight submission must be JSON serializable", { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError("stored dynamic preflight submission must not be undefined");
  }
  return JSON.parse(serialized) as unknown;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`persisted dynamic preflight ${label} is invalid`);
  }
  return value as number;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`persisted dynamic preflight ${label} is invalid`);
  }
  return value;
}

function persistedState(value: unknown): PersistedCoordinatorState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("persisted dynamic preflight state must be an object");
  }
  const object = value as Record<string, unknown>;
  if (object.schema_version !== "1.0" || !Array.isArray(object.states)) {
    throw new TypeError("persisted dynamic preflight state has an invalid schema");
  }
  const states: PersistedExecutionState[] = [];
  const seen = new Set<string>();
  for (const item of object.states) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("persisted dynamic preflight execution state is invalid");
    }
    const entry = item as Record<string, unknown>;
    const requirementId = entry.requirement_id;
    if (typeof requirementId !== "string" || requirementId.length === 0 || seen.has(requirementId)) {
      throw new TypeError("persisted dynamic preflight requirement identity is invalid");
    }
    seen.add(requirementId);
    const activeValue = entry.active;
    let active: PersistedActiveReceipt | null = null;
    if (activeValue !== null) {
      if (activeValue === undefined || typeof activeValue !== "object" || Array.isArray(activeValue)) {
        throw new TypeError("persisted dynamic preflight active receipt is invalid");
      }
      const activeObject = activeValue as Record<string, unknown>;
      const storedSubmission = "stored_submission" in activeObject
        ? jsonClone(activeObject.stored_submission)
        : undefined;
      active = {
        generation: positiveInteger(activeObject.generation, "active generation"),
        sequence: positiveInteger(activeObject.sequence, "active sequence"),
        receipt_digest: requiredDigest(activeObject.receipt_digest, "receipt digest"),
        submission_digest: requiredDigest(activeObject.submission_digest, "submission digest"),
        ...(storedSubmission === undefined ? {} : { stored_submission: storedSubmission }),
        consumed: activeObject.consumed === true,
      };
    }
    const generation = positiveInteger(entry.generation, "generation");
    const sequence = positiveInteger(entry.sequence, "sequence");
    const hasPrepared = entry.has_prepared === true;
    if (active !== null && (!hasPrepared || active.generation !== generation || active.sequence > sequence)) {
      throw new TypeError("persisted dynamic preflight active receipt is inconsistent");
    }
    states.push({
      requirement_id: requirementId,
      generation,
      sequence,
      has_prepared: hasPrepared,
      active,
    });
  }
  return { schema_version: "1.0", states };
}

export function createDynamicFamilyPreflightCoordinator(
  options: DynamicFamilyPreflightCoordinatorOptions = {},
): DynamicFamilyPreflightCoordinator {
  const states = new Map<string, ExecutionState>();
  const reservations = new WeakMap<object, ReservationState>();
  let loaded = options.stateFile === undefined;
  let loadPromise: Promise<void> | null = null;
  let writeChain = Promise.resolve();

  const load = async (): Promise<void> => {
    if (loaded) return;
    if (loadPromise !== null) return loadPromise;
    loadPromise = (async () => {
      const value = await readJsonFileOrNull<unknown>(options.stateFile!);
      if (value !== null) {
        const parsed = persistedState(value);
        for (const entry of parsed.states) {
          states.set(entry.requirement_id, {
            generation: entry.generation,
            sequence: entry.sequence,
            hasPrepared: entry.has_prepared,
            active: entry.active === null ? null : {
              generation: entry.active.generation,
              sequence: entry.active.sequence,
              receiptDigest: entry.active.receipt_digest,
              submissionDigest: entry.active.submission_digest,
              storedSubmission: entry.active.stored_submission,
              // A reservation token is process-local. A consumed receipt is
              // intentionally left consumed after restart (fail closed).
              consumed: entry.active.consumed,
              reservationToken: null,
            },
          });
        }
      }
      loaded = true;
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  };

  const persist = async (): Promise<void> => {
    if (options.stateFile === undefined) return;
    const snapshot: PersistedCoordinatorState = {
      schema_version: "1.0",
      states: [...states.entries()].map(([requirementId, state]) => ({
        requirement_id: requirementId,
        generation: state.generation,
        sequence: state.sequence,
        has_prepared: state.hasPrepared,
        active: state.active === null ? null : {
          generation: state.active.generation,
          sequence: state.active.sequence,
          receipt_digest: state.active.receiptDigest,
          submission_digest: state.active.submissionDigest,
          ...(state.active.storedSubmission === undefined ? {} : {
            stored_submission: jsonClone(state.active.storedSubmission),
          }),
          consumed: state.active.consumed,
        },
      })),
    };
    const write = writeChain.then(() => writeJsonAtomic(options.stateFile!, snapshot));
    writeChain = write.catch(() => undefined);
    await write;
  };

  const stateFor = (requirementId: string): ExecutionState => {
    if (requirementId.trim() === "") throw new TypeError("dynamic preflight requirement id is required");
    const existing = states.get(requirementId);
    if (existing !== undefined) return existing;
    const created: ExecutionState = { generation: 0, sequence: 0, hasPrepared: false, active: null };
    states.set(requirementId, created);
    return created;
  };

  return {
    async beginPrepare(requirementId): Promise<DynamicFamilyPreflightPreparation> {
      if (!loaded) await load();
      const state = stateFor(requirementId);
      if (state.hasPrepared) state.generation += 1;
      state.hasPrepared = true;
      state.sequence += 1;
      // A new prepare supersedes both an available and an in-flight receipt.
      state.active = null;
      await persist();
      return Object.freeze({ requirementId, generation: state.generation, sequence: state.sequence });
    },

    async commitPrepare(preparation, receipt, submissionDigest, storedSubmission): Promise<void> {
      await load();
      const state = states.get(preparation.requirementId);
      if (
        state === undefined
        || !state.hasPrepared
        || state.generation !== preparation.generation
        || state.sequence !== preparation.sequence
        || receipt.requirement_id !== preparation.requirementId
        || receipt.generation !== preparation.generation
      ) {
        throw new Error("dynamic preflight preparation was superseded");
      }
      if (!DIGEST.test(submissionDigest)) throw new TypeError("dynamic preflight submission digest is invalid");
      const clonedSubmission = storedSubmission === undefined ? undefined : jsonClone(storedSubmission);
      state.active = {
        generation: preparation.generation,
        sequence: preparation.sequence,
        receiptDigest: receipt.receipt_digest,
        submissionDigest,
        storedSubmission: clonedSubmission,
        consumed: false,
        reservationToken: null,
      };
      await persist();
    },

    async resolveSubmission<T = unknown>(receipt: DynamicFamilyPreflightReceipt): Promise<T> {
      await load();
      const state = states.get(receipt.requirement_id);
      if (state === undefined || receipt.generation !== state.generation) {
        throw new Error("dynamic preflight receipt has stale generation");
      }
      const active = state.active;
      if (active === null || active.receiptDigest !== receipt.receipt_digest) {
        throw new Error("dynamic preflight receipt is unknown or superseded");
      }
      if (active.consumed) {
        throw new Error("dynamic preflight receipt was already consumed");
      }
      if (active.storedSubmission === undefined) {
        throw new Error("dynamic preflight receipt has no stored submission; echo the prepared_submission instead");
      }
      return jsonClone(active.storedSubmission) as T;
    },

    async reserve(receipt, submissionDigest): Promise<DynamicFamilyPreflightReservation> {
      await load();
      const state = states.get(receipt.requirement_id);
      if (state === undefined || receipt.generation !== state.generation) {
        throw new Error("dynamic preflight receipt has stale generation");
      }
      const active = state.active;
      if (active === null || active.receiptDigest !== receipt.receipt_digest) {
        throw new Error("dynamic preflight receipt is unknown or superseded");
      }
      if (active.submissionDigest !== submissionDigest) {
        throw new Error("dynamic preflight receipt does not match the submitted build facts");
      }
      if (active.consumed) {
        throw new Error("dynamic preflight receipt was already consumed");
      }
      active.consumed = true;
      const token = {};
      active.reservationToken = token;
      await persist();
      const reservation = Object.freeze({
        requirementId: receipt.requirement_id,
        generation: receipt.generation,
        receiptDigest: receipt.receipt_digest,
      });
      reservations.set(reservation, { requirementId: receipt.requirement_id, generation: receipt.generation, token });
      return reservation;
    },

    async complete(reservation): Promise<void> {
      await load();
      const state = states.get(reservation.requirementId);
      const internal = reservations.get(reservation);
      if (state !== undefined && internal !== undefined) {
        const active = state.active;
        if (
          active !== null
          && active.reservationToken === internal.token
          && active.receiptDigest === reservation.receiptDigest
        ) {
          state.active = null;
          await persist();
        }
      }
      reservations.delete(reservation);
    },

    isCurrent(reservation): boolean {
      const state = states.get(reservation.requirementId);
      const internal = reservations.get(reservation);
      const active = state?.active;
      return state !== undefined
        && internal !== undefined
        && state.generation === reservation.generation
        && active !== null
        && active !== undefined
        && active.consumed
        && active.receiptDigest === reservation.receiptDigest
        && active.reservationToken === internal.token;
    },
  };
}
