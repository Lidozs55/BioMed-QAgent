import {
  BioMedAgentError,
  type BioMedAgentAdapter,
  type BioMedAgentSession,
  type BioMedSessionConfig,
} from "./contracts.js";

export class SessionRegistry {
  private readonly sessions = new Map<string, BioMedAgentSession>();
  private readonly pending = new Map<string, Promise<BioMedAgentSession>>();
  private readonly disposals = new Map<string, Promise<void>>();
  private closing = false;

  constructor(private readonly adapter: BioMedAgentAdapter) {}

  get size(): number {
    return this.sessions.size;
  }

  get(runId: string): BioMedAgentSession | undefined {
    return this.sessions.get(runId);
  }

  async create(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    if (
      this.closing ||
      this.sessions.has(config.runId) ||
      this.pending.has(config.runId) ||
      this.disposals.has(config.runId)
    ) {
      throw new BioMedAgentError(
        "DUPLICATE_RUN",
        `An active session already exists for run ${config.runId}`,
      );
    }
    const creation = this.adapter.createSession(config).then(
      (session) => {
        if (this.pending.get(config.runId) === creation) {
          this.pending.delete(config.runId);
          this.sessions.set(config.runId, session);
        }
        return session;
      },
      (error: unknown) => {
        if (this.pending.get(config.runId) === creation) {
          this.pending.delete(config.runId);
        }
        throw error;
      },
    );
    this.pending.set(config.runId, creation);
    return creation;
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(runId) ?? (await this.pending.get(runId));
    if (session === undefined) {
      throw new BioMedAgentError("RUN_NOT_FOUND", `No session exists for run ${runId}`);
    }
    await session.cancel(reason);
    await this.disposeOne(runId);
  }

  disposeOne(runId: string): Promise<void> {
    const existing = this.disposals.get(runId);
    if (existing !== undefined) return existing;
    const disposal = (async () => {
      const pending = this.pending.get(runId);
      const session = this.sessions.get(runId) ?? (pending === undefined ? undefined : await pending);
      this.pending.delete(runId);
      this.sessions.delete(runId);
      await session?.dispose();
    })().finally(() => this.disposals.delete(runId));
    this.disposals.set(runId, disposal);
    return disposal;
  }

  async disposeAll(): Promise<void> {
    if (this.closing && this.sessions.size === 0 && this.pending.size === 0) return;
    this.closing = true;
    const runIds = new Set([...this.sessions.keys(), ...this.pending.keys()]);
    const results = await Promise.allSettled(
      [...runIds].map((runId) => this.disposeOne(runId)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Experimental Pi session cleanup failed");
    }
  }
}
