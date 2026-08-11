"""Task-scoped mid-run context injection store.

Users can inject a short piece of text into a running task's context without
interrupting the current answer.  The text is picked up by the agent's next
model call (dynamic instructions) and consumed exactly once.
"""

from __future__ import annotations

import threading
from functools import lru_cache


class ContextInjectionStore:
    """Thread-safe per-task pending-injection lines (in-memory)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._lines: dict[str, list[str]] = {}

    def inject(self, task_id: str, text: str) -> int:
        """Append one injected line for *task_id*; returns the pending count."""

        stripped = text.strip()
        with self._lock:
            lines = self._lines.setdefault(task_id, [])
            if stripped:
                lines.append(stripped)
            return len(lines)

    def pending(self, task_id: str) -> list[str]:
        """Return a snapshot of pending injections without consuming them."""

        with self._lock:
            return list(self._lines.get(task_id, ()))

    def drain(self, task_id: str) -> list[str]:
        """Return and clear the pending injections (one-shot consumption)."""

        with self._lock:
            return self._lines.pop(task_id, [])

    def clear(self, task_id: str) -> None:
        """Drop all pending injections for a task."""

        with self._lock:
            self._lines.pop(task_id, None)


@lru_cache(maxsize=1)
def get_context_injection_store() -> ContextInjectionStore:
    """Return the process-wide injection store (lazily created)."""

    return ContextInjectionStore()


__all__ = ["ContextInjectionStore", "get_context_injection_store"]
