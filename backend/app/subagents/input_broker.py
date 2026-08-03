"""Request-keyed human-input routing for managed child agents."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from app.domain.contracts import (
    SubagentInputRequiredPayload,
    SubagentInputResumedPayload,
)


@dataclass(frozen=True, slots=True)
class PendingSubagentInput:
    task_id: str
    run_id: str
    subagent_id: str
    payload: SubagentInputRequiredPayload
    future: asyncio.Future[SubagentInputResumedPayload]


class SubagentInputBroker:
    """Route one resume decision to one globally unique child request."""

    def __init__(self) -> None:
        self._pending: dict[str, PendingSubagentInput] = {}
        self._lock = asyncio.Lock()

    async def request(
        self,
        *,
        task_id: str,
        run_id: str,
        payload: SubagentInputRequiredPayload,
        on_registered: Callable[[], Awaitable[None]] | None = None,
    ) -> SubagentInputResumedPayload:
        future = asyncio.get_running_loop().create_future()
        pending = PendingSubagentInput(
            task_id=task_id,
            run_id=run_id,
            subagent_id=payload.subagent_id,
            payload=payload,
            future=future,
        )
        async with self._lock:
            if payload.request_id in self._pending:
                raise ValueError(f"duplicate request_id: {payload.request_id}")
            self._pending[payload.request_id] = pending

        try:
            if on_registered is not None:
                await on_registered()
            return await asyncio.shield(future)
        except BaseException:
            async with self._lock:
                if self._pending.get(payload.request_id) is pending:
                    self._pending.pop(payload.request_id)
                    if not future.done():
                        future.cancel()
            raise

    async def try_resume(
        self,
        *,
        task_id: str,
        run_id: str,
        request_id: str,
        decision: Literal["approve", "reject"],
        detail: dict[str, object] | None = None,
    ) -> bool:
        return (
            await self._resolve(
                task_id=task_id,
                run_id=run_id,
                request_id=request_id,
                decision=decision,
                detail=detail,
            )
            is not None
        )

    async def resume(
        self,
        *,
        task_id: str,
        run_id: str,
        request_id: str,
        decision: Literal["approve", "reject"],
        detail: dict[str, object] | None = None,
    ) -> SubagentInputResumedPayload:
        resumed = await self._resolve(
            task_id=task_id,
            run_id=run_id,
            request_id=request_id,
            decision=decision,
            detail=detail,
        )
        if resumed is None:
            raise LookupError(request_id)
        return resumed

    async def cancel_subagent(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
    ) -> None:
        await self._cancel_matching(
            lambda pending: (
                pending.task_id == task_id
                and pending.run_id == run_id
                and pending.subagent_id == subagent_id
            )
        )

    async def cancel_run(self, *, task_id: str, run_id: str) -> None:
        await self._cancel_matching(
            lambda pending: (
                pending.task_id == task_id and pending.run_id == run_id
            )
        )

    async def _resolve(
        self,
        *,
        task_id: str,
        run_id: str,
        request_id: str,
        decision: Literal["approve", "reject"],
        detail: dict[str, object] | None,
    ) -> SubagentInputResumedPayload | None:
        async with self._lock:
            pending = self._pending.get(request_id)
            if pending is None:
                return None
            if (pending.task_id, pending.run_id) != (task_id, run_id):
                raise ValueError(
                    f"request_id {request_id} does not belong to "
                    f"task {task_id} run {run_id}"
                )
            resumed = SubagentInputResumedPayload(
                subagent_id=pending.subagent_id,
                request_id=request_id,
                decision=decision,
                detail=detail or {},
            )
            self._pending.pop(request_id)
            pending.future.set_result(resumed)
            return resumed

    async def _cancel_matching(
        self,
        matches: Callable[[PendingSubagentInput], bool],
    ) -> None:
        async with self._lock:
            request_ids = [
                request_id
                for request_id, pending in self._pending.items()
                if matches(pending)
            ]
            for request_id in request_ids:
                pending = self._pending.pop(request_id)
                pending.future.cancel()
