/**
 * Ingest contract: allowlisted fields, validation, and canonical digests.
 *
 * The cloud never accepts arbitrary path dictionaries. Unknown fields,
 * non-finite numbers, malformed times, and far-future collection times are
 * rejected so a broken collector cannot write junk into history.
 */

export const SCHEMA_VERSION = 1;
export const MAX_BATCH = 100;
export const MAX_BODY_BYTES = 1_000_000;
export const FUTURE_TOLERANCE_MS = 300_000;
export const EARLIEST_MS = Date.parse("2020-01-01T00:00:00Z");

export const QUALITIES = ["ok", "partial", "source_error", "stale_source", "clock_invalid", "offline"] as const;
export type Quality = (typeof QUALITIES)[number];

export const RECORD_FIELDS = {
  site_minute: [
    "schema_version",
    "collector_id",
    "record_id",
    "kind",
    "window_start_utc",
    "window_end_utc",
    "sample_count",
    "valid_count",
    "repeated_count",
    "invalid_count",
    "out_of_window_count",
    "complete",
    "quality",
    "pv_kw_avg",
    "load_kw_reported_avg",
    "grid_kw_avg",
    "battery_kw_avg",
    "valid_counts",
    "pv_kwh_total_end",
    "load_kwh_total_reported_end",
    "grid_net_kwh_total_end",
    "last_measured_at_utc",
  ],
  panel_sample: [
    "schema_version",
    "collector_id",
    "record_id",
    "kind",
    "panel_id",
    "slot_ts",
    "quality",
    "ac_kw",
    "energy_kwh_total",
    "dc_kw",
    "dc_v",
    "dc_a",
    "ac_v",
    "ac_a",
    "heatsink_c",
    "measured_at_utc",
    "last_valid_measured_at_utc",
  ],
  collector_event: [
    "schema_version",
    "collector_id",
    "record_id",
    "kind",
    "event_type",
    "event_ts_utc",
    "details_code",
  ],
} as const;

export type RecordKind = keyof typeof RECORD_FIELDS;

export const LIVE_FIELDS = [
  "schema_version",
  "collector_id",
  "collected_at_utc",
  "measured_at_utc",
  "quality",
  "pv_kw",
  "load_kw_reported",
  "grid_kw",
  "battery_kw",
  "pv_kwh_total",
  "load_kwh_total_reported",
  "grid_net_kwh_total",
] as const;

export type LivePayload = Record<string, unknown>;
export type ValidRecord = Record<string, unknown> & { record_id: string; kind: RecordKind };

export interface Validation<T> {
  ok: boolean;
  value?: T;
  error?: string;
  invalidIds?: string[];
}

const COLLECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NUMBER_FIELDS = [
  "pv_kw",
  "load_kw_reported",
  "grid_kw",
  "battery_kw",
  "pv_kwh_total",
  "load_kwh_total_reported",
  "grid_net_kwh_total",
  "pv_kw_avg",
  "load_kw_reported_avg",
  "grid_kw_avg",
  "battery_kw_avg",
  "pv_kwh_total_end",
  "load_kwh_total_reported_end",
  "grid_net_kwh_total_end",
  "ac_kw",
  "energy_kwh_total",
  "dc_kw",
  "dc_v",
  "dc_a",
  "ac_v",
  "ac_a",
  "heatsink_c",
];
const TIME_FIELDS = [
  "collected_at_utc",
  "measured_at_utc",
  "window_start_utc",
  "window_end_utc",
  "last_measured_at_utc",
  "slot_ts",
  "last_valid_measured_at_utc",
  "event_ts_utc",
];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an ISO 8601 instant, returning epoch milliseconds or null. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkCommon(record: Record<string, unknown>, allowed: readonly string[], nowMs: number): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return `unknown_field:${key}`;
  }
  if (record.schema_version !== SCHEMA_VERSION) return "schema_version";
  if (typeof record.collector_id !== "string" || !COLLECTOR_ID_PATTERN.test(record.collector_id)) {
    return "collector_id";
  }
  for (const field of NUMBER_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return `invalid_number:${field}`;
  }
  for (const field of TIME_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const parsed = parseInstant(value);
    if (parsed === null || parsed < EARLIEST_MS || parsed > nowMs + FUTURE_TOLERANCE_MS) return `invalid_time:${field}`;
  }
  if (record.quality !== undefined && !QUALITIES.includes(record.quality as Quality)) return "quality";
  return null;
}

export function validateLive(payload: unknown, nowMs: number): Validation<LivePayload> {
  if (!isPlainObject(payload)) return { ok: false, error: "body" };
  const error = checkCommon(payload, LIVE_FIELDS, nowMs);
  if (error) return { ok: false, error };
  if (typeof payload.quality !== "string") return { ok: false, error: "quality" };
  if (parseInstant(payload.collected_at_utc) === null) return { ok: false, error: "collected_at_utc" };
  return { ok: true, value: payload };
}

export function validateBatch(records: unknown, nowMs: number, maxBatch = MAX_BATCH): Validation<ValidRecord[]> {
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: "records", invalidIds: [] };
  if (records.length > maxBatch) return { ok: false, error: "batch_too_large", invalidIds: [] };
  const invalidIds: string[] = [];
  for (const record of records) {
    const id = isPlainObject(record) && typeof record.record_id === "string" ? record.record_id : "";
    if (!isPlainObject(record)) {
      invalidIds.push(id);
      continue;
    }
    const kind = record.kind;
    if (typeof kind !== "string" || !(kind in RECORD_FIELDS)) {
      invalidIds.push(id);
      continue;
    }
    const allowed = RECORD_FIELDS[kind as RecordKind];
    const error = checkCommon(record, allowed, nowMs) ?? checkKind(record, kind as RecordKind);
    if (error || id.length === 0 || id.length > 200) invalidIds.push(id);
  }
  if (invalidIds.length > 0) return { ok: false, error: "invalid_record", invalidIds };
  return { ok: true, value: records as ValidRecord[] };
}

function checkKind(record: Record<string, unknown>, kind: RecordKind): string | null {
  if (kind === "site_minute") {
    if (typeof record.quality !== "string") return "quality";
    if (parseInstant(record.window_start_utc) === null) return "window_start_utc";
    if (typeof record.sample_count !== "number" || !Number.isInteger(record.sample_count) || record.sample_count < 0) {
      return "sample_count";
    }
    if (typeof record.valid_count !== "number" || !Number.isInteger(record.valid_count) || record.valid_count < 0) {
      return "valid_count";
    }
    if (typeof record.complete !== "boolean") return "complete";
    return null;
  }
  if (kind === "panel_sample") {
    if (typeof record.quality !== "string") return "quality";
    if (typeof record.panel_id !== "string" || !/^p[0-9]{1,4}$/.test(record.panel_id)) return "panel_id";
    if (parseInstant(record.slot_ts) === null) return "slot_ts";
    return null;
  }
  if (typeof record.event_type !== "string" || !/^[a-z_]{3,40}$/.test(record.event_type)) return "event_type";
  if (parseInstant(record.event_ts_utc) === null) return "event_ts_utc";
  return null;
}

/** Stable JSON with sorted object keys, so a replay hashes identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export async function digestOf(record: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(record));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
