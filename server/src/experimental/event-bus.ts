import type { EventEnvelope } from "@biomed/contracts";

type EventListener = (event: EventEnvelope) => void;

export class ExperimentalEventBus {
  private readonly tasks = new Set<string>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly handoff = new Map<string, EventEnvelope[]>();
  private closed = false;

  constructor(private readonly maxHandoffEvents = 64) {
    if (!Number.isInteger(maxHandoffEvents) || maxHandoffEvents <= 0) {
      throw new TypeError("maxHandoffEvents must be a positive integer");
    }
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  registerTask(taskId: string): void {
    if (this.closed) throw new Error("Experimental event bus is closed");
    this.tasks.add(taskId);
  }

  hasTask(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  publish(event: EventEnvelope): void {
    if (this.closed || !this.tasks.has(event.task_id)) return;
    const listeners = this.listeners.get(event.task_id);
    if (listeners === undefined || listeners.size === 0) {
      const queued = this.handoff.get(event.task_id) ?? [];
      if (queued.length >= this.maxHandoffEvents) queued.shift();
      queued.push(event);
      this.handoff.set(event.task_id, queued);
      return;
    }
    for (const listener of listeners) listener(event);
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    if (this.closed || !this.tasks.has(taskId)) {
      throw new Error("Experimental task is unavailable");
    }
    const listeners = this.listeners.get(taskId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    const queued = this.handoff.get(taskId) ?? [];
    this.handoff.delete(taskId);
    for (const event of queued) listener(event);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(taskId);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.handoff.clear();
    this.tasks.clear();
  }
}
