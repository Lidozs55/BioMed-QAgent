"""Bounded live event fan-out for WebSocket connections."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable

from app.domain.contracts import EventEnvelope


DEFAULT_SUBSCRIBER_QUEUE_SIZE = 1000


class SubscriberOverflowError(RuntimeError):
    """Raised when a connection falls behind its bounded event queue."""


class SubscriptionClosedError(RuntimeError):
    """Raised when a closed connection subscription has no events left."""


class EventSubscription:
    """One connection's task filters, event queue, and serialized send path."""

    def __init__(
        self,
        hub: EventHub,
        *,
        task_ids: Iterable[str],
        queue_size: int,
    ) -> None:
        self._hub = hub
        self._task_ids = set(task_ids)
        self._queue: asyncio.Queue[EventEnvelope] = asyncio.Queue(maxsize=queue_size)
        self._send_lock = asyncio.Lock()
        self._closed = False
        self._overflowed = False
        self._closed_event = asyncio.Event()

    @property
    def task_ids(self) -> frozenset[str]:
        return frozenset(self._task_ids)

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def overflowed(self) -> bool:
        return self._overflowed

    async def subscribe_task(self, task_id: str) -> None:
        if not task_id:
            raise ValueError("task_id must not be blank")
        async with self._hub._lock:
            self._ensure_open()
            self._task_ids.add(task_id)

    async def unsubscribe_task(self, task_id: str) -> None:
        async with self._hub._lock:
            self._ensure_open()
            self._task_ids.discard(task_id)

    async def receive(self) -> EventEnvelope:
        if not self._queue.empty():
            return self._queue.get_nowait()
        if self._overflowed:
            raise SubscriberOverflowError("subscriber event queue overflowed")
        if self._closed:
            raise SubscriptionClosedError("subscription is closed")
        queued_event = asyncio.create_task(self._queue.get())
        closed = asyncio.create_task(self._closed_event.wait())
        try:
            done, _ = await asyncio.wait(
                {queued_event, closed},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            pending = [task for task in (queued_event, closed) if not task.done()]
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        if queued_event in done:
            return queued_event.result()
        if self._overflowed:
            raise SubscriberOverflowError("subscriber event queue overflowed")
        raise SubscriptionClosedError("subscription is closed")

    async def send(
        self,
        sender: Callable[[EventEnvelope], Awaitable[None]],
        event: EventEnvelope,
    ) -> None:
        async with self._send_lock:
            self._ensure_open()
            await sender(event)

    async def close(self) -> None:
        await self._hub._remove(self, overflowed=False)

    def _matches(self, event: EventEnvelope) -> bool:
        return event.task_id in self._task_ids

    def _ensure_open(self) -> None:
        if self._closed:
            raise SubscriptionClosedError("subscription is closed")


class EventHub:
    """Publish events without allowing a slow subscriber to block producers."""

    def __init__(
        self,
        *,
        subscriber_queue_size: int = DEFAULT_SUBSCRIBER_QUEUE_SIZE,
    ) -> None:
        if subscriber_queue_size < 1:
            raise ValueError("subscriber_queue_size must be positive")
        self.subscriber_queue_size = subscriber_queue_size
        self._subscribers: set[EventSubscription] = set()
        self._lock = asyncio.Lock()

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def subscribe(
        self,
        *,
        task_ids: Iterable[str] = (),
    ) -> EventSubscription:
        subscription = EventSubscription(
            self,
            task_ids=task_ids,
            queue_size=self.subscriber_queue_size,
        )
        async with self._lock:
            self._subscribers.add(subscription)
        return subscription

    async def publish(self, event: EventEnvelope) -> None:
        async with self._lock:
            overflowed: list[EventSubscription] = []
            for subscription in self._subscribers:
                if not subscription._matches(event):
                    continue
                try:
                    subscription._queue.put_nowait(event)
                except asyncio.QueueFull:
                    subscription._closed = True
                    subscription._overflowed = True
                    subscription._closed_event.set()
                    overflowed.append(subscription)
            self._subscribers.difference_update(overflowed)

    async def close(self) -> None:
        async with self._lock:
            subscribers = tuple(self._subscribers)
            self._subscribers.clear()
            for subscription in subscribers:
                subscription._closed = True
                subscription._closed_event.set()

    async def _remove(
        self,
        subscription: EventSubscription,
        *,
        overflowed: bool,
    ) -> None:
        async with self._lock:
            self._subscribers.discard(subscription)
            subscription._closed = True
            subscription._overflowed = overflowed
            subscription._closed_event.set()


__all__ = [
    "DEFAULT_SUBSCRIBER_QUEUE_SIZE",
    "EventHub",
    "EventSubscription",
    "SubscriberOverflowError",
    "SubscriptionClosedError",
]
