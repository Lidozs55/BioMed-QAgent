/**
 * Strict runtime parsers for the source coverage evidence boundary
 * (TODO P1 "可验证的 QueryPlan / SourceCoverage 证据").
 *
 * The full wire report parser lives in ``@biomed/contracts``; this module adds
 * the Dataset Core domain semantics (exact keys, safe ids, ISO timestamps) for
 * the runtime→Core discovery-ledger handoff, which is the only external input
 * to an otherwise Core-derived report.
 */

import type { DiscoveryQueryRecord } from "@biomed/contracts";

import {
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertSafeId,
  assertString,
  assertIsoDateTime,
} from "./primitives.js";

const DISCOVERY_QUERY_RECORD_KEYS = [
  "operation_id",
  "source",
  "query",
  "status",
  "result_count",
  "requested_limit",
  "retrieved_at",
] as const;

const DISCOVERY_QUERY_STATUSES: readonly string[] = [
  "success",
  "not_found",
  "failed",
  "skipped",
  "page_fallback",
];

const MAX_OPERATION_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;
const MAX_QUERY_LENGTH = 2_048;

export function parseDiscoveryQueryRecordStrict(
  value: unknown,
  name = "discovery_query_record",
): DiscoveryQueryRecord {
  const record = assertRecord(value, name);
  assertExactKeys(record, DISCOVERY_QUERY_RECORD_KEYS, name);
  const operationId = assertString(record.operation_id, `${name}.operation_id`);
  if (operationId.length === 0 || operationId.length > MAX_OPERATION_ID_LENGTH) {
    throw new TypeError(`${name}.operation_id must be 1..${MAX_OPERATION_ID_LENGTH} characters`);
  }
  const source = assertSafeId(record.source, `${name}.source`);
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new TypeError(`${name}.source must be at most ${MAX_SOURCE_LENGTH} characters`);
  }
  const query = assertNonEmptyString(record.query, `${name}.query`);
  if (query.length > MAX_QUERY_LENGTH) {
    throw new TypeError(`${name}.query must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  const status = assertString(record.status, `${name}.status`);
  if (!DISCOVERY_QUERY_STATUSES.includes(status)) {
    throw new TypeError(`${name}.status must be one of ${DISCOVERY_QUERY_STATUSES.join(", ")}`);
  }
  return {
    operation_id: operationId,
    source,
    query,
    status: status as DiscoveryQueryRecord["status"],
    result_count: assertNonNegativeInt(record.result_count, `${name}.result_count`),
    requested_limit: requested_limit_value(record.requested_limit, name),
    retrieved_at: assertIsoDateTime(record.retrieved_at, `${name}.retrieved_at`),
  };
}

function requested_limit_value(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  return assertNonNegativeInt(value, `${name}.requested_limit`);
}

/**
 * Parse a discovery ledger handed over by the runtime. Operation ids must be
 * unique: a duplicated id means the ledger was double-counted, which would
 * inflate discovery totals, so the input is rejected instead of merged.
 */
export function parseDiscoveryQueryLedger(
  value: unknown,
  name = "discovery_queries",
): DiscoveryQueryRecord[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  const seen = new Set<string>();
  const records = value.map((item, index) => {
    const record = parseDiscoveryQueryRecordStrict(item, `${name}[${index}]`);
    if (seen.has(record.operation_id)) {
      throw new TypeError(`${name} duplicates operation_id '${record.operation_id}'`);
    }
    seen.add(record.operation_id);
    return record;
  });
  return records;
}
