#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  EVENT_PAGE_SIZE,
  MAX_EVENT_COUNT,
  loadTaskEvents,
} from "../../docs/evaluation/gold-v1/assert-current-run.mjs";

const BASE_URL = "http://fixture";
const TASK_ID = "task_gold6";
const HOST_EVENT_LIMIT = 1_000;

function event(taskId, sequence) {
  return {
    schema_version: "1.0",
    event_id: `event-${sequence}`,
    type: "task_created",
    task_id: taskId,
    run_id: null,
    stage_attempt_id: null,
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { type: "task_created" },
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function pagedFetch(events, calls) {
  return async (requestUrl) => {
    const url = new URL(requestUrl);
    const after = Number(url.searchParams.get("after_sequence"));
    const limit = Number(url.searchParams.get("limit"));
    calls.push({ after, limit });
    if (limit > HOST_EVENT_LIMIT) return response(422, { detail: "limit too large" });
    return response(200, {
      events: events.filter((candidate) => candidate.sequence > after).slice(0, limit),
    });
  };
}

test("loads more than two pages without exceeding the Host event limit", async () => {
  const events = Array.from({ length: EVENT_PAGE_SIZE * 2 + 1 }, (_, index) => event(TASK_ID, index + 1));
  const calls = [];

  const loaded = await loadTaskEvents(BASE_URL, TASK_ID, {
    fetchImpl: pagedFetch(events, calls),
  });

  assert.equal(loaded.length, events.length);
  assert.deepEqual(loaded, events);
  assert.equal(EVENT_PAGE_SIZE, HOST_EVENT_LIMIT);
  assert.ok(calls.every(({ limit }) => limit <= HOST_EVENT_LIMIT));
  assert.deepEqual(calls, [
    { after: 0, limit: EVENT_PAGE_SIZE },
    { after: EVENT_PAGE_SIZE, limit: EVENT_PAGE_SIZE },
    { after: EVENT_PAGE_SIZE * 2, limit: EVENT_PAGE_SIZE },
  ]);
});

test("stops after an empty page", async () => {
  const calls = [];
  const loaded = await loadTaskEvents(BASE_URL, TASK_ID, {
    fetchImpl: pagedFetch([], calls),
  });

  assert.deepEqual(loaded, []);
  assert.deepEqual(calls, [{ after: 0, limit: EVENT_PAGE_SIZE }]);
});

test("rejects an event for a different task", async () => {
  const fetchImpl = async () => response(200, {
    events: [event("another-task", 1)],
  });

  await assert.rejects(
    loadTaskEvents(BASE_URL, TASK_ID, { fetchImpl }),
    /has task_id another-task; expected task_gold6/,
  );
});

test("rejects non-positive and unsafe sequences", async () => {
  for (const sequence of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const fetchImpl = async () => response(200, {
      events: [event(TASK_ID, sequence)],
    });

    await assert.rejects(
      loadTaskEvents(BASE_URL, TASK_ID, { fetchImpl }),
      new RegExp(`has invalid sequence ${sequence}`),
    );
  }
});

test("rejects a gap between event pages", async () => {
  const fetchImpl = async (requestUrl) => {
    const url = new URL(requestUrl);
    const after = Number(url.searchParams.get("after_sequence"));
    return response(200, {
      events: after === 0 ? [event(TASK_ID, 1), event(TASK_ID, 2)] : [event(TASK_ID, 4)],
    });
  };

  await assert.rejects(
    loadTaskEvents(BASE_URL, TASK_ID, { fetchImpl, pageSize: 2 }),
    /expected sequence 3, received 4/,
  );
});

test("rejects a repeated event sequence", async () => {
  const fetchImpl = async (requestUrl) => {
    const url = new URL(requestUrl);
    const after = Number(url.searchParams.get("after_sequence"));
    return response(200, {
      events: after === 0 ? [event(TASK_ID, 1), event(TASK_ID, 2)] : [event(TASK_ID, 2), event(TASK_ID, 3)],
    });
  };

  await assert.rejects(
    loadTaskEvents(BASE_URL, TASK_ID, { fetchImpl, pageSize: 2 }),
    /expected sequence 3, received 2/,
  );
});

test("rejects reordered events within a page", async () => {
  const fetchImpl = async () => response(200, {
    events: [event(TASK_ID, 2), event(TASK_ID, 1)],
  });

  await assert.rejects(
    loadTaskEvents(BASE_URL, TASK_ID, { fetchImpl, pageSize: 2 }),
    /expected sequence 1, received 2/,
  );
});

test("rejects a full page that does not advance the cursor", async () => {
  const fetchImpl = async () => response(200, {
    events: [event(TASK_ID, 1), event(TASK_ID, 2)],
  });

  await assert.rejects(
    loadTaskEvents(BASE_URL, TASK_ID, { fetchImpl, pageSize: 2 }),
    /full event page did not advance cursor/,
  );
});

test("enforces the explicit total event bound", async () => {
  const events = [event(TASK_ID, 1), event(TASK_ID, 2), event(TASK_ID, 3)];
  const calls = [];

  await assert.rejects(
    loadTaskEvents(BASE_URL, TASK_ID, {
      fetchImpl: pagedFetch(events, calls),
      pageSize: 2,
      maxEvents: 2,
    }),
    /maximum event count of 2/,
  );
  assert.equal(MAX_EVENT_COUNT, 100_000);
});
