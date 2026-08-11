import type { EventEnvelope } from "@biomed/contracts";

type EventListener = (event: EventEnvelope) => void;

export class ExperimentalEventBus {
  private readonly tasks = new Set<string>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private closed = false;

  registerTask(taskId: string): void {
    if (this.closed) throw new Error("Experimental event bus is closed");
    this.tasks.add(taskId);
  }

  hasTask(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  publish(event: EventEnvelope): void {
    if (this.closed || !this.tasks.has(event.task_id)) return;
    for (const listener of this.listeners.get(event.task_id) ?? []) listener(event);
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    if (this.closed || !this.tasks.has(taskId)) {
      throw new Error("Experimental task is unavailable");
    }
    const listeners = this.listeners.get(taskId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(taskId);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.tasks.clear();
  }
}
