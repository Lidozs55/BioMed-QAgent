/**
 * Cooperative cancellation for long-running Core operations (M2 I-03/I-04).
 *
 * The TS Dataset Core build chain is deterministic and mostly synchronous by
 * design (golden parity with the Python V2 Core).  Wall-clock operation
 * timeouts and HTTP cancels cannot interrupt a synchronous CPU/IO section,
 * because the timeout callback itself needs the event loop to run.  This
 * module gives the heavy sections of the real Core (adapter parse,
 * canonicalize, integrate, validation, publish) two hooks:
 *
 * - ``throwIfAborted`` — a synchronous check at await boundaries; throws
 *   ``OperationAbortedError`` as soon as the operation-level AbortSignal
 *   fired (wall-clock timeout or user cancel).
 * - ``checkpoint`` — yields to the event loop (``setImmediate``) so pending
 *   timers (operation timeouts) and I/O completions get a chance to run,
 *   then re-checks the signal.  Long loops call it every N rows; async file
 *   I/O goes through ``node:fs/promises`` / streams, which keep the loop
 *   responsive between chunks.
 *
 * The executor converts ``OperationAbortedError`` into ``BuildCancelledError``
 * so a cancelled build finalizes as ``cancelled`` and a timed-out build as
 * ``failed``/``timeout`` (see ``runtime/executor.ts``).
 */

/** Raised when an operation's AbortSignal aborted between checkpoints. */
export class OperationAbortedError extends Error {
  constructor(message = "operation aborted by timeout or cancel") {
    super(message);
    this.name = "OperationAbortedError";
  }
}

/** Synchronous abort check — call at every await boundary. */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal !== undefined && signal !== null && signal.aborted) {
    throw new OperationAbortedError("operation aborted by timeout or cancel");
  }
}

/** Yield to the event loop, then re-check the signal. */
export async function checkpoint(signal?: AbortSignal | null): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

/** Row/iteration stride between cooperative yields inside long loops. */
export const CHECKPOINT_STRIDE = 4096;
