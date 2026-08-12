export type Closer = () => void | Promise<void>;

export interface LifecycleRegistryOptions {
  timeoutMs?: number;
}

interface RegisteredCloser {
  name: string;
  close: Closer;
}

function runWithTimeout(closer: RegisteredCloser, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${closer.name} did not close within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([Promise.resolve().then(closer.close), timedOut]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

export class LifecycleRegistry {
  readonly #closers: RegisteredCloser[] = [];
  readonly #timeoutMs: number;
  #closePromise?: Promise<void>;

  constructor(options: LifecycleRegistryOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  add(name: string, close: Closer): void {
    if (this.#closePromise !== undefined) {
      throw new Error(`Cannot register ${name} after shutdown has started`);
    }
    this.#closers.push({ name, close });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeAll();
    return this.#closePromise;
  }

  async #closeAll(): Promise<void> {
    const errors: Error[] = [];
    for (const closer of this.#closers.reverse()) {
      try {
        await runWithTimeout(closer, this.#timeoutMs);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Application resources did not close cleanly: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
  }
}
