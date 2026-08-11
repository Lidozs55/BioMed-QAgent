
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
  appends one ``timed_out`` row to the task artifacts ``corrections_todo.csv``
  (T3, D3: append semantics + atomic replace) and returns a degraded
  ``MainInputDecision(timed_out=True, corrections_path=...)`` — it never
  raises for a timeout; a write failure degrades to ``corrections_path=None``.
- Cancellation while paused propagates ``CompactionCancelledError`` (the agent
  loop's cancellation exception, mirroring max_turns).
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.agent_loop.context import UserInputSubmitter
from app.domain.contracts import UserInputRequiredPayload, UserInputResumedPayload
from app.runtime.compaction import CompactionCancelledError

logger = logging.getLogger(__name__)

#: 人工输入等待超时（原 V1 pipeline.runner 常量，随 V1 退役内联）。
_USER_INPUT_TIMEOUT: float = 300.0

_CORRECTIONS_TODO_FILENAME = "corrections_todo.csv"
_CORRECTIONS_TODO_COLUMNS = (
    "request_id",
    "requested_at",
    "expires_at",
    "summary",
    "detail_json",
    "status",
)


@dataclass(frozen=True, slots=True)
class MainInputDecision:
    """Result of one main-run human-input (``data_correction``) request.

    ``resumed`` carries the human (or fixture synthetic) decision when the
    request was answered in time; ``timed_out=True`` means the deadline
    elapsed without a human reply — the broker persists the pending
    correction to ``corrections_todo.csv`` (T3, spec §3-D3) and returns a
    degraded result instead of failing. ``corrections_path`` is the full
    path of that todo file when the write succeeded (a write failure keeps
    it ``None`` and the tool degrades to the bare filename).
    """

    request_id: str
    summary: str
    detail: dict[str, object]
    requested_at: datetime
    expires_at: datetime
    timeout_seconds: float
    timed_out: bool
    resumed: UserInputResumedPayload | None = None
    corrections_path: Path | None = None


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
        default_timeout_seconds: float = _USER_INPUT_TIMEOUT,
        artifacts_dir: Path | None = None,
    ) -> None:
        self._run_id = run_id
        self._fixture = fixture
        self._emit = emit
        self._install_user_input_submitter = install_user_input_submitter
        self._clear_user_input_submitter = clear_user_input_submitter
        self._cancellation_requested = cancellation_requested
        self._default_timeout_seconds = default_timeout_seconds
        self._artifacts_dir = artifacts_dir
        self._counter = 0
        self._pending = False

    @property
    def has_pending_request(self) -> bool:
        """True while one main-run data-correction request is in flight.

        D1 (Phase 4 review): publication-capable sibling tools use this as an
        exclusivity gate — while a correction pause is pending they must not
        build/publish from inputs under correction.
        """

        return self._pending

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

        self._pending = True
        try:
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
            loop = asyncio.get_running_loop()
            # FIX 2 (final review): one immutable monotonic deadline captured at
            # entry, shared by the submitter and the wait loop — the expiry
            # boundary is a single deterministic point.
            deadline = loop.time() + timeout
            claimed_timed_out = False

            def submitter(payload: UserInputResumedPayload) -> bool:
                if payload.request_id != request_id:
                    return False
                # Reject submissions that arrive after the deadline, and anything
                # that races the timeout after the deadline already won the wait
                # (the claim is set synchronously on the timeout path, before any
                # other task can interleave).
                if claimed_timed_out or loop.time() > deadline:
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
                timed_out = await self._wait_for_decision(event, deadline)
            except BaseException:
                self._clear_user_input_submitter(submitter)
                raise

            if timed_out and decision_holder:
                # A submission accepted exactly at the deadline wins. The wait's
                # timeout can fire with an EMPTY done set (``_wait_for_decision``
                # reports timed_out) while a submitter running in the same loop
                # tick already accepted a payload at ``loop.time() <= deadline``.
                # The append is synchronous in the submitter, so the holder is
                # authoritative; it is re-checked synchronously after the wait
                # returns (no await between) and the claimed flag is only set on
                # the actual timeout path — an accepted decision can never be lost
                # to the synthetic timeout. The human path below emits the accepted
                # decision and never writes the todo row (accepted ⇒ human wins;
                # only an unaccepted timeout degrades to the synthetic path).
                timed_out = False
            if timed_out:
                # The deadline won: claim the request so any concurrently-arrived
                # (or late) human submission is rejected, and discard whatever
                # raced into the holder — only the timeout path may write the todo
                # row and emit the synthetic resume.
                claimed_timed_out = True
                decision_holder.clear()
            try:
                if timed_out:
                    corrections_path = self._write_corrections_todo(
                        request_id=request_id,
                        summary=summary,
                        detail=resolved_detail,
                        requested_at=requested_at,
                        expires_at=expires_at,
                    )
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
                        corrections_path=corrections_path,
                    )

                if not decision_holder:
                    raise RuntimeError(
                        "data_correction resume event set without a decision"
                    )
                # Mirror the max_turns path: emit UserInputResumedPayload after
                # waking so the reducer transitions AWAITING_USER_INPUT -> RUNNING
                # before the manager finalizes the Run.
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
            finally:
                # FIX 2 reorder: the submitter is cleared only AFTER the winner is
                # decided and the synthetic/human resumed event is emitted. While
                # the resumed event is being persisted the submitter stays
                # installed, but the claimed flag / deadline check reject anything
                # late — a resume can never be accepted and then discarded.
                self._clear_user_input_submitter(submitter)
        finally:
            self._pending = False

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

    def _write_corrections_todo(
        self,
        *,
        request_id: str,
        summary: str,
        detail: dict[str, object],
        requested_at: datetime,
        expires_at: datetime,
    ) -> Path | None:
        """Append one timed-out request to the task artifacts todo CSV (T3, D3).

        utf-8-sig + ``csv.DictWriter`` match the pipeline artifact convention
        (``app/pipeline/stages/base.py:write_csv``); the write is atomic
        (temp file + ``os.replace``) so a crash never truncates history rows.
        Only timed-out requests are recorded — resumed requests never reach
        this path. A write failure must never crash the Run: log a warning
        and return ``None`` so the caller degrades with
        ``corrections_path=None`` (the degraded message still returns).
        """

        if self._artifacts_dir is None:
            logger.warning(
                "cannot record timed-out data correction to %s: "
                "artifacts_dir is not configured",
                _CORRECTIONS_TODO_FILENAME,
            )
            return None
        path = self._artifacts_dir / _CORRECTIONS_TODO_FILENAME
        tmp = path.with_name(path.name + ".tmp")
        try:
            self._artifacts_dir.mkdir(parents=True, exist_ok=True)
            rows: list[dict[str, object]] = []
            if path.exists():
                with path.open("r", encoding="utf-8-sig", newline="") as handle:
                    rows.extend(csv.DictReader(handle))
            rows.append(
                {
                    "request_id": request_id,
                    "requested_at": requested_at.isoformat(),
                    "expires_at": expires_at.isoformat(),
                    "summary": summary,
                    "detail_json": json.dumps(detail, ensure_ascii=False),
                    "status": "timed_out",
                }
            )
            with tmp.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=_CORRECTIONS_TODO_COLUMNS,
                    extrasaction="raise",
                )
                writer.writeheader()
                writer.writerows(rows)
            os.replace(tmp, path)
            return path
        except (OSError, csv.Error, TypeError, ValueError) as exc:
            logger.warning(
                "failed to write %s: %s", _CORRECTIONS_TODO_FILENAME, exc
            )
            with suppress(OSError):
                tmp.unlink(missing_ok=True)
            return None

    async def _wait_for_decision(
        self,
        event: asyncio.Event,
        deadline: float,
    ) -> bool:
        """Wait for the resume event, cancellation, or the deadline.

        Returns ``True`` when the deadline elapsed without a decision (the
        timeout fired before the resume event was set). The monotonic
        ``deadline`` is captured once by ``request_input`` and shared with the
        submitter, so the expiry boundary is a single deterministic point
        (FIX 2). Raises ``CompactionCancelledError`` when the Run is cancelled
        while paused; ``asyncio.CancelledError`` propagates naturally when the
        worker task itself is cancelled.
        """

        loop = asyncio.get_running_loop()
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
                timeout=max(0.0, deadline - loop.time()),
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
