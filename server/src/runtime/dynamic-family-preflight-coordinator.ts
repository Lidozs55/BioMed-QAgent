import type { DynamicFamilyPreflightReceipt } from "@biomed/contracts";

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

export interface DynamicFamilyPreflightCoordinator {
  /** Begin a new prepare and synchronously invalidate the prior receipt. */
  beginPrepare(requirementId: string): DynamicFamilyPreflightPreparation;
  /** Commit only the latest in-flight preparation for its build. */
  commitPrepare(
    preparation: DynamicFamilyPreflightPreparation,
    receipt: DynamicFamilyPreflightReceipt,
    submissionDigest: string,
  ): void;
  /** Atomically consume the current receipt before any acquisition side effect. */
  reserve(receipt: DynamicFamilyPreflightReceipt, submissionDigest: string): DynamicFamilyPreflightReservation;
  /** Clear a consumed receipt after success or failure. */
  complete(reservation: DynamicFamilyPreflightReservation): void;
  /** Live generation fence checked by acquisition/transform execution. */
  isCurrent(reservation: DynamicFamilyPreflightReservation): boolean;
}

export function createDynamicFamilyPreflightCoordinator(): DynamicFamilyPreflightCoordinator {
  const states = new Map<string, ExecutionState>();
  const reservations = new WeakMap<object, ReservationState>();

  const stateFor = (requirementId: string): ExecutionState => {
    const existing = states.get(requirementId);
    if (existing !== undefined) return existing;
    const created: ExecutionState = { generation: 0, sequence: 0, hasPrepared: false, active: null };
    states.set(requirementId, created);
    return created;
  };

  return {
    beginPrepare(requirementId): DynamicFamilyPreflightPreparation {
      const state = stateFor(requirementId);
      if (state.hasPrepared) state.generation += 1;
      state.hasPrepared = true;
      state.sequence += 1;
      // A new prepare supersedes both an available and an in-flight receipt.
      state.active = null;
      return Object.freeze({ requirementId, generation: state.generation, sequence: state.sequence });
    },

    commitPrepare(preparation, receipt, submissionDigest): void {
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
      state.active = {
        generation: preparation.generation,
        sequence: preparation.sequence,
        receiptDigest: receipt.receipt_digest,
        submissionDigest,
        consumed: false,
        reservationToken: null,
      };
    },

    reserve(receipt, submissionDigest): DynamicFamilyPreflightReservation {
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
      const reservation = Object.freeze({
        requirementId: receipt.requirement_id,
        generation: receipt.generation,
        receiptDigest: receipt.receipt_digest,
      });
      reservations.set(reservation, { requirementId: receipt.requirement_id, generation: receipt.generation, token });
      return reservation;
    },

    complete(reservation): void {
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
