import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

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

export interface DynamicFamilyPreflightCoordinatorOptions {
  readonly statePath?: string;
}

export interface DynamicFamilyPreflightCoordinator {
  /** Begin a new prepare and synchronously invalidate the prior receipt. */
  beginPrepare(requirementId: string): DynamicFamilyPreflightPreparation;
  /** Commit only the latest in-flight preparation for its build. */
  commitPrepare(
    preparation: DynamicFamilyPreflightPreparation,
    receipt: DynamicFamilyPreflightReceipt,
    submissionDigest: string,
    storedSubmission?: unknown,
  ): void;
  /**
   * Resolve the server-side prepared submission bound to a live (not yet
   * consumed) receipt. Receipt-only submit uses this instead of re-echoing the
   * whole payload; the returned reference is the exact object passed to
   * commitPrepare, so integrity is anchored by the receipt digest chain.
   */
  resolveSubmission<T = unknown>(receipt: DynamicFamilyPreflightReceipt): T;
  /** Atomically consume the current receipt before any acquisition side effect. */
  reserve(receipt: DynamicFamilyPreflightReceipt, submissionDigest: string): DynamicFamilyPreflightReservation;
  /** Clear a consumed receipt after success or failure. */
  complete(reservation: DynamicFamilyPreflightReservation): void;
  /** Live generation fence checked by acquisition/transform execution. */
  isCurrent(reservation: DynamicFamilyPreflightReservation): boolean;
}

function loadStates(statePath: string | undefined): Map<string, ExecutionState> {
  if (statePath === undefined) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error("dynamic preflight durable state is unreadable", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dynamic preflight durable state is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== "1.0" || !Array.isArray(record.states)) {
    throw new Error("dynamic preflight durable state is invalid");
  }
  const states = new Map<string, ExecutionState>();
  for (const raw of record.states) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("dynamic preflight durable state entry is invalid");
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.requirement_id !== "string"
      || !Number.isSafeInteger(entry.generation)
      || !Number.isSafeInteger(entry.sequence)
      || typeof entry.has_prepared !== "boolean"
      || states.has(entry.requirement_id)
    ) {
      throw new Error("dynamic preflight durable state entry is invalid");
    }
    let active: ActiveReceipt | null = null;
    if (entry.active !== null) {
      if (entry.active === undefined || typeof entry.active !== "object" || Array.isArray(entry.active)) {
        throw new Error("dynamic preflight durable active receipt is invalid");
      }
      const candidate = entry.active as Record<string, unknown>;
      if (
        !Number.isSafeInteger(candidate.generation)
        || !Number.isSafeInteger(candidate.sequence)
        || typeof candidate.receipt_digest !== "string"
        || !/^[0-9a-f]{64}$/.test(candidate.receipt_digest)
        || typeof candidate.submission_digest !== "string"
        || !/^[0-9a-f]{64}$/.test(candidate.submission_digest)
        || typeof candidate.consumed !== "boolean"
      ) {
        throw new Error("dynamic preflight durable active receipt is invalid");
      }
      active = {
        generation: candidate.generation as number,
        sequence: candidate.sequence as number,
        receiptDigest: candidate.receipt_digest,
        submissionDigest: candidate.submission_digest,
        storedSubmission: candidate.stored_submission,
        consumed: candidate.consumed,
        reservationToken: null,
      };
    }
    states.set(entry.requirement_id, {
      generation: entry.generation as number,
      sequence: entry.sequence as number,
      hasPrepared: entry.has_prepared,
      active,
    });
  }
  return states;
}

export function createDynamicFamilyPreflightCoordinator(
  options: DynamicFamilyPreflightCoordinatorOptions = {},
): DynamicFamilyPreflightCoordinator {
  const states = loadStates(options.statePath);
  const reservations = new WeakMap<object, ReservationState>();

  const persist = (): void => {
    if (options.statePath === undefined) return;
    const snapshot = {
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
          stored_submission: state.active.storedSubmission,
          consumed: state.active.consumed,
        },
      })),
    };
    mkdirSync(path.dirname(options.statePath), { recursive: true });
    const temporary = `${options.statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(temporary, options.statePath);
  };

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
      persist();
      return Object.freeze({ requirementId, generation: state.generation, sequence: state.sequence });
    },

    commitPrepare(preparation, receipt, submissionDigest, storedSubmission): void {
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
        storedSubmission,
        consumed: false,
        reservationToken: null,
      };
      persist();
    },

    resolveSubmission<T = unknown>(receipt: DynamicFamilyPreflightReceipt): T {
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
      return active.storedSubmission as T;
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
      persist();
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
          try {
            persist();
          } catch (error) {
            console.error("dynamic_preflight_state_cleanup_failed", error);
          }
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
