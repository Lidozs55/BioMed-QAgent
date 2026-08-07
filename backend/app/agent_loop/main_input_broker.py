"""Main-run human-input broker — the tool → execution channel for Phase 4c.

Mirrors ``AgentRunExecutor._await_max_turns_resume`` (UserInputSubmitter +
``asyncio.Event`` + emit-required-then-resumed) for
``prompt_kind="data_correction"``, adding an explicit deadline so an
unanswered correction request degrades instead of blocking forever.

Semantics (docs/archive/superpowers/specs/2026-08-07-phase4c-hil-correction-design.md
§3-D1):

- Fixture runs never block: the request is informational
  (``fixture_exempt=True``) and a synthetic approve decision is returned
  immediately.
- Live runs pause via ``UserInputRequiredPayload`` and wait for
  ``POST /runs/{run_id}/resume`` (routed through ``RunExecution.submit_user_input``
  to the submitter installed here); on resume the human decision is emitted as
  ``UserInputResumedPayload`` (reducer ``AWAITING_USER_INPUT -> RUNNING``) and
  returned.
- On timeout the broker emits a synthetic auto-approved resume (mirroring the
  plan-confirmation timeout convention, REVIEW 2026-08-05 §3.3) so the Run can
  leave ``AWAITING_USER_INPUT`` (FINALIZING from it is an illegal transition),
  and returns a degraded ``MainInputDecision(timed_out=True)`` — it never
  raises for a timeout (the T3 corrections_todo.csv path handles degradation).
- Cancellation while paused propagates ``CompactionCancelledError`` (the agent
  loop's cancellation exception, mirroring max_turns).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.agent_loop.context import UserInputSubmitter
from app.domain.contracts import UserInputRequiredPayload, UserInputResumedPayload
from app.pipeline.runner import USER_INPUT_TIMEOUT
from app.runtime.compaction import CompactionCancelledError


@dataclass(frozen=True, slots=True)
class MainInputDecision:
    """Result of one main-run human-input (``data_correction``) request.

    ``resumed`` carries the human (or fixture synthetic) decision when the
    request was answered in time; ``timed_out=True`` means the deadline
    elapsed without a human reply — the caller persists the pending
    correction (T3 ``corrections_todo.csv``) and continues with a degraded
    result instead of failing.
    """

    request_id: str
    summary: str
    detail: dict[str, object]
    requested_at: datetime
    expires_at: datetime
    timeout_seconds: float
    timed_out: bool
    resumed: UserInputResumedPayload | None = None


class MainInputBroker:
    """Route one main-run human-input request to the durable resume channel.

    Installed per Run by ``AgentRunExecutor`` (``_bind_main_input_broker``);
    each Run gets its own request-id counter. Subagent contexts never install
    a broker — ``RunContext.request_main_input`` fails explicitly there.
    """

    def __init__(
        self,
        *,
        run_id: str,
        fixture: bool,
        emit: Callable[[object], Awaitable[None]],
        install_user_input_submitter: Callable[[UserInputSubmitter], None],
        clear_user_input_submitter: Callable[[UserInputSubmitter], None],
        cancellation_requested: asyncio.Event | None = None,
        default_timeout_seconds: float = USER_INPUT_TIMEOUT,
    ) -> None:
        self._run_id = run_id
        self._fixture = fixture
        self._emit = emit
        self._install_user_input_submitter = install_user_input_submitter
        self._clear_user_input_submitter = clear_user_input_submitter
        self._cancellation_requested = cancellation_requested
        self._default_timeout_seconds = default_timeout_seconds
        self._counter = 0

    async def request_input(
        self,
        *,
        summary: str,
        detail: dict[str, object] | None = None,
        timeout_seconds: float | None = None,
    ) -> MainInputDecision:
        """Pause the main Run for a human data-correction decision.

        Returns the human decision, a fixture synthetic approval, or a
        degraded ``timed_out`` decision. Never raises for a timeout; raises
        ``CompactionCancelledError`` when the Run is cancelled while paused.
        """

        timeout = (
            self._default_timeout_seconds
            if timeout_seconds is None
            else timeout_seconds
        )
        request_id = f"data_correction-{self._run_id}-{self._counter}"
        self._counter += 1
        requested_at = datetime.now(UTC)
        expires_at = requested_at + timedelta(seconds=timeout)
        resolved_detail = dict(detail or {})

        if self._fixture:
            return await self._fixture_approve(
                request_id=request_id,
                summary=summary,
                detail=resolved_detail,
                requested_at=requested_at,
                expires_at=expires_at,
                timeout=timeout,
            )

        event: asyncio.Event = asyncio.Event()
        decision_holder: list[UserInputResumedPayload] = []

        def submitter(payload: UserInputResumedPayload) -> bool:
            if payload.request_id != request_id:
                return False
            decision_holder.append(payload)
            event.set()
            return True

        self._install_user_input_submitter(submitter)
        try:
            await self._emit(
                UserInputRequiredPayload(
                    request_id=request_id,
                    prompt_kind="data_correction",
                    summary=summary,
                    detail=resolved_detail,
                    expires_at=expires_at,
                    fixture_exempt=False,
                )
            )
            timed_out = await self._wait_for_decision(event, timeout)
        finally:
            self._clear_user_input_submitter(submitter)

        if timed_out:
            await self._emit(
                UserInputResumedPayload(
                    request_id=request_id,
                    decision="approve",
                    detail={
                        "auto_approved": True,
                        "auto_approve_reason": "data_correction_timeout",
                        "timeout_seconds": timeout,
                    },
                )
            )
            return MainInputDecision(
                request_id=request_id,
                summary=summary,
                detail=resolved_detail,
                requested_at=requested_at,
                expires_at=expires_at,
                timeout_seconds=timeout,
                timed_out=True,
            )

        if not decision_holder:
            raise RuntimeError("data_correction resume event set without a decision")
        # Mirror the max_turns path: emit UserInputResumedPayload after waking
        # so the reducer transitions AWAITING_USER_INPUT -> RUNNING before the
        # manager finalizes the Run.
        await self._emit(decision_holder[0])
        return MainInputDecision(
            request_id=request_id,
            summary=summary,
            detail=resolved_detail,
            requested_at=requested_at,
            expires_at=expires_at,
            timeout_seconds=timeout,
            timed_out=False,
            resumed=decision_holder[0],
        )

    async def _fixture_approve(
        self,
        *,
        request_id: str,
        summary: str,
        detail: dict[str, object],
        requested_at: datetime,
        expires_at: datetime,
        timeout: float,
    ) -> MainInputDecision:
        """Fixture mode: informational request + synthetic approve, no block."""

        await self._emit(
            UserInputRequiredPayload(
                request_id=request_id,
                prompt_kind="data_correction",
                summary=summary,
                detail=detail,
                expires_at=expires_at,
                fixture_exempt=True,
            )
        )
        resumed = UserInputResumedPayload(
            request_id=request_id,
            decision="approve",
            detail={
                **detail,
                "fixture_exempt": True,
                "fixture_note": "fixture mode synthetic approval",
            },
        )
        await self._emit(resumed)
        return MainInputDecision(
            request_id=request_id,
            summary=summary,
            detail=detail,
            requested_at=requested_at,
            expires_at=expires_at,
            timeout_seconds=timeout,
            timed_out=False,
            resumed=resumed,
        )

    async def _wait_for_decision(
        self,
        event: asyncio.Event,
        timeout: float,
    ) -> bool:
        """Wait for the resume event, cancellation, or the deadline.

        Returns ``True`` when the deadline elapsed without a decision.
        Raises ``CompactionCancelledError`` when the Run is cancelled while
        paused; ``asyncio.CancelledError`` propagates naturally when the
        worker task itself is cancelled.
        """

        loop = asyncio.get_running_loop()
        wait_deadline = loop.time() + timeout
        input_waiter = asyncio.create_task(event.wait())
        waiters: set[asyncio.Task[bool]] = {input_waiter}
        cancellation_waiter: asyncio.Task[bool] | None = None
        if self._cancellation_requested is not None:
            cancellation_waiter = asyncio.create_task(
                self._cancellation_requested.wait()
            )
            waiters.add(cancellation_waiter)
        try:
            done, _ = await asyncio.wait(
                waiters,
                timeout=max(0.0, wait_deadline - loop.time()),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                return True
            if (
                cancellation_waiter is not None
                and cancellation_waiter in done
                and not input_waiter.done()
            ):
                raise CompactionCancelledError(
                    "data correction request was cancelled while paused"
                )
            return False
        finally:
            for waiter in waiters:
                if not waiter.done():
                    waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
