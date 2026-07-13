from __future__ import annotations

import asyncio
import importlib

import pytest

from app.domain.contracts import AssistantDeltaPayload, build_event


@pytest.mark.asyncio
async def test_slow_subscriber_is_evicted_without_blocking_fanout() -> None:
    hub_module = importlib.import_module("app.runtime.hub")
    hub = hub_module.EventHub(subscriber_queue_size=1)
    subscription = await hub.subscribe(task_ids={"task_123"})

    first = build_event(
        task_id="task_123",
        run_id="run_123",
        sequence=1,
        payload=AssistantDeltaPayload(delta="first"),
    )
    second = build_event(
        task_id="task_123",
        run_id="run_123",
        sequence=2,
        payload=AssistantDeltaPayload(delta="second"),
    )

    await hub.publish(first)
    await hub.publish(second)

    assert await subscription.receive() == first
    with pytest.raises(hub_module.SubscriberOverflowError):
        await subscription.receive()
    assert hub.subscriber_count == 0


@pytest.mark.asyncio
async def test_subscription_serializes_connection_sends() -> None:
    hub_module = importlib.import_module("app.runtime.hub")
    hub = hub_module.EventHub()
    subscription = await hub.subscribe(task_ids={"task_123"})
    first = build_event(
        task_id="task_123",
        run_id="run_123",
        sequence=1,
        payload=AssistantDeltaPayload(delta="first"),
    )
    second = build_event(
        task_id="task_123",
        run_id="run_123",
        sequence=2,
        payload=AssistantDeltaPayload(delta="second"),
    )
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    active_sends = 0
    maximum_active_sends = 0
    sent_sequences: list[int] = []

    async def send(event) -> None:
        nonlocal active_sends, maximum_active_sends
        active_sends += 1
        maximum_active_sends = max(maximum_active_sends, active_sends)
        if event.sequence == 1:
            first_entered.set()
            await release_first.wait()
        sent_sequences.append(event.sequence)
        active_sends -= 1

    first_send = asyncio.create_task(subscription.send(send, first))
    await first_entered.wait()
    second_send = asyncio.create_task(subscription.send(send, second))
    await asyncio.sleep(0)

    assert not second_send.done()
    assert maximum_active_sends == 1

    release_first.set()
    await asyncio.gather(first_send, second_send)
    assert sent_sequences == [1, 2]


@pytest.mark.asyncio
async def test_hub_close_wakes_blocked_subscription_receiver() -> None:
    hub_module = importlib.import_module("app.runtime.hub")
    hub = hub_module.EventHub()
    subscription = await hub.subscribe(task_ids={"task_123"})
    receiver = asyncio.create_task(subscription.receive())
    await asyncio.sleep(0)

    await hub.close()

    with pytest.raises(hub_module.SubscriptionClosedError):
        await asyncio.wait_for(receiver, timeout=1)


@pytest.mark.asyncio
async def test_connection_can_change_task_filters_without_replacing_queue() -> None:
    hub_module = importlib.import_module("app.runtime.hub")
    hub = hub_module.EventHub()
    subscription = await hub.subscribe(task_ids={"task_first"})
    second_task_event = build_event(
        task_id="task_second",
        run_id="run_second",
        sequence=1,
        payload=AssistantDeltaPayload(delta="second"),
    )
    first_task_event = build_event(
        task_id="task_first",
        run_id="run_first",
        sequence=1,
        payload=AssistantDeltaPayload(delta="first"),
    )

    await subscription.subscribe_task("task_second")
    await hub.publish(second_task_event)
    assert await subscription.receive() == second_task_event

    await subscription.unsubscribe_task("task_second")
    await hub.publish(second_task_event)
    await hub.publish(first_task_event)
    assert await subscription.receive() == first_task_event
    assert subscription.task_ids == frozenset({"task_first"})
