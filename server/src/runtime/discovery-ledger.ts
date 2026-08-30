/**
 * Discovery ledger projection (source coverage evidence, TODO P1 #21).
 *
 * The runtime tool hooks accumulate discovery query observations in memory;
 * this pure projector rebuilds the same ledger from the persisted
 * ``operation_*`` event stream (category ``discovery``), which is how a
 * recovered run re-derives its discovery evidence without any new event type.
 * Replay stability is pinned by tests: the same events always project to the
 * same records.
 */

import type { DiscoveryQueryRecord, DiscoveryQueryStatus, EventEnvelope } from "@biomed/contracts";

const DISCOVERY_QUERY_STATUSES: readonly DiscoveryQueryStatus[] = [
  "success",
  "not_found",
  "failed",
  "skipped",
  "page_fallback",
];

function isDiscoveryQueryStatus(value: string): value is DiscoveryQueryStatus {
  return (DISCOVERY_QUERY_STATUSES as readonly string[]).includes(value);
}

/**
 * Project discovery query records from persisted envelopes. Entries that do
 * not carry the full query detail (source/status/query) are skipped rather
 * than guessed; records are sorted by operation_id for deterministic output.
 */
export function projectDiscoveryQueries(
  envelopes: readonly EventEnvelope[],
): DiscoveryQueryRecord[] {
  const records: DiscoveryQueryRecord[] = [];
  for (const envelope of envelopes) {
    const payload = envelope.payload;
    if (payload.type !== "operation_progress" || payload.kind !== "query") continue;
    const detail = payload.detail;
    if (detail === undefined) continue;
    const source = detail.source;
    const query = detail.query;
    const status = detail.status;
    if (typeof source !== "string" || typeof query !== "string" || typeof status !== "string") {
      continue;
    }
    if (!isDiscoveryQueryStatus(status)) continue;
    records.push({
      operation_id: payload.operation_id,
      source,
      query,
      status,
      result_count: Math.max(0, payload.current),
      requested_limit: null,
      retrieved_at: envelope.timestamp,
    });
  }
  return records.sort((left, right) => left.operation_id.localeCompare(right.operation_id));
}
