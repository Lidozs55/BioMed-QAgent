# Task 2B Report: Lifespan live hub and WebSocket dual-channel delivery

## Scope

- Added one lifespan-owned `AssistantStreamHub`, configured with the durable
  subscriber queue size and closed through the existing nested shutdown chain.
- Added one assistant-stream subscription and sender per WebSocket connection.
- Applied subscribe and unsubscribe commands to both subscriptions under the
  existing shared send lock.
- Preserved durable replay ordering and watermark behavior while sending live
  frames without repository access or replay.
- Added exact assistant-stream overflow and shutdown close responses.

No Agent Runner or model integration production code was changed.

## RED evidence

Command, run before production changes:

```text
backend/.venv/Scripts/python.exe -m pytest tests/api/test_websocket_replay.py tests/test_main.py -q
```

Result:

```text
6 failed, 21 passed in 16.34s
```

The failures were caused by the missing lifespan state, missing live WebSocket
subscription/delivery, and absent assistant-stream overflow/shutdown handling.
The unsubscribe barrier test initially passed because the server had no live
subscription to queue against; before implementation, the test was tightened
to require the live subscription and later to verify that its task filter was
removed after the unsubscribe/ping barrier.

## GREEN evidence

Focused command:

```text
backend/.venv/Scripts/python.exe -m pytest tests/api/test_websocket_replay.py tests/test_main.py -q
```

Result:

```text
27 passed in 4.20s
```

Lint command:

```text
backend/.venv/Scripts/ruff.exe check app/ tests/ launcher.py
```

Result:

```text
All checks passed!
```

Broader backend regression command:

```text
backend/.venv/Scripts/python.exe -m pytest -q
```

Result:

```text
968 passed, 18 deselected in 109.88s
```

## Self-review

- The connection creates exactly one durable and one assistant-stream
  subscription, and the `finally` path closes both even if the first close
  raises.
- Both filters are installed while the shared send lock is held before durable
  replay starts; a live frame queued during replay cannot acquire the lock
  until replay completes.
- Live sends only serialize `frame.model_dump(mode="json")`; they do not query
  the repository or mutate `last_sent`.
- Unsubscribe removes both filters and the active task while holding the send
  lock, so the subsequent ping is a barrier for queued durable and live data.
- Durable events, live frames, controls, errors, and close calls all use the
  same connection send lock.
- Durable overflow/shutdown behavior and reasons remain unchanged. Assistant
  stream overflow uses 1013 with
  `assistant stream overflow; reconnect and replay durable events`; assistant
  stream hub shutdown uses 1012 with `assistant stream hub shutdown`.
- Internal failures retain the stable public error and do not expose exception
  details.

## Concerns

None within Task 2B scope. The live hub has no production publisher until the
separate Agent Runner/model integration task.
