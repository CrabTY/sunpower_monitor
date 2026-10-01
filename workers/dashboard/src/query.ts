/**
 * History, panel, and health read models.
 *
 * Resolution limits follow the architecture: raw minute rows for at most two
 * days, five-minute views for at most 31 days, and stored site-local daily
 * views for at most one year. A year request never scans a year of minutes.
 */

export type Resolution = "1m" | "5m" | "1d";

export const RESOLUTION_SECONDS: Record<Resolution, number> = { "1m": 60, "5m": 300, "1d": 86400 };
export const MAX_SPAN_SECONDS: Record<Resolution, number> = {
  "1m": 2 * 24 * 3600,
  "5m": 31 * 24 * 3600,
  "1d": 366 * 24 * 3600 + 3600,
};
export const DEFAULT_SPAN_SECONDS = 24 * 3600;
// The cap must fit the widest range the API accepts, or truncation silently
// hides the newest windows: 31 days of five-minute slots is 8,928 rows.
export const MAX_ROWS = 9000;
export const PANEL_SPAN_SECONDS = 31 * 24 * 3600 + 3600;
// A day of panel energy, plus the extra hour a daylight-saving day can have.
export const MAX_ENERGY_SPAN_SECONDS = 25 * 3600;

export interface TimeRange {
  fromTs: number;
  toTs: number;
  resolution: Resolution;
}

export interface Validation<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function parseRange(params: URLSearchParams, nowSeconds: number): Validation<TimeRange> {
  const toTs = params.get("to") === null ? nowSeconds : instantSeconds(params.get("to"));
  const fromTs = params.get("from") === null ? (toTs ?? 0) - DEFAULT_SPAN_SECONDS : instantSeconds(params.get("from"));
  if (fromTs === null || toTs === null) return { ok: false, error: "invalid_time" };
  if (toTs <= fromTs) return { ok: false, error: "invalid_range" };
  const requested = params.get("resolution");
  if (requested !== null && requested !== "1m" && requested !== "5m" && requested !== "1d") {
    return { ok: false, error: "unsupported_resolution" };
  }
  const resolution: Resolution = requested === "1m" || requested === "5m" || requested === "1d"
    ? requested : toTs - fromTs > MAX_SPAN_SECONDS["5m"] ? "1d" : toTs - fromTs > MAX_SPAN_SECONDS["1m"] ? "5m" : "1m";
  if (toTs - fromTs > MAX_SPAN_SECONDS[resolution]) return { ok: false, error: "range_too_long" };
  return { ok: true, value: { fromTs, toTs, resolution } };
}

export function instantSeconds(value: string | null): number | null {
  if (value === null || value.length === 0 || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function clampSpan(fromTs: number, toTs: number, limit: number): { fromTs: number; toTs: number; clamped: boolean } {
  if (toTs - fromTs <= limit) return { fromTs, toTs, clamped: false };
  return { fromTs: toTs - limit, toTs, clamped: true };
}

const MINUTE_COLUMNS =
  "minute_ts, quality, complete, sample_count, valid_count, pv_kw_avg, load_kw_reported_avg," +
  " grid_kw_avg, battery_kw_avg, pv_kwh_total_end, last_measured_ts";

const WEIGHTED_POWERS = [
  ["pv_kw", "pv_kw_avg"],
  ["load_kw_reported", "load_kw_reported_avg"],
  ["grid_kw", "grid_kw_avg"],
  ["battery_kw", "battery_kw_avg"],
] as const;

/** Five-minute views are weighted per field by that field's valid minute count. */
export function fiveMinuteSql(): string {
  const weighted = WEIGHTED_POWERS.map(
    ([field, column]) =>
      `SUM(${column} * json_extract(valid_counts_json, '$.${field}'))` +
      ` / NULLIF(SUM(json_extract(valid_counts_json, '$.${field}')), 0) AS ${column}`,
  ).join(", ");
  return (
    `SELECT (minute_ts / 300) * 300 AS slot_ts, COUNT(*) AS windows,` +
    " SUM(CASE WHEN quality = 'ok' THEN 1 ELSE 0 END) AS ok_windows," +
    " SUM(CASE WHEN quality = 'partial' THEN 1 ELSE 0 END) AS partial_windows," +
    " SUM(CASE WHEN quality = 'source_error' THEN 1 ELSE 0 END) AS source_error_windows," +
    " SUM(CASE WHEN quality = 'clock_invalid' THEN 1 ELSE 0 END) AS clock_invalid_windows," +
    " SUM(sample_count) AS sample_count, SUM(valid_count) AS valid_count, MAX(last_measured_ts) AS last_measured_ts," +
    ` ${weighted},` +
    // The cumulative counter only grows, so a slot's end value is its maximum.
    " MAX(pv_kwh_total_end) AS pv_kwh_total_end" +
    " FROM site_minute" +
    " WHERE collector_id = ? AND minute_ts >= ? AND minute_ts < ?" +
    " GROUP BY slot_ts ORDER BY slot_ts LIMIT ?"
  );
}

export function minuteSql(): string {
  return (
    `SELECT ${MINUTE_COLUMNS} FROM site_minute` +
    " WHERE collector_id = ? AND minute_ts >= ? AND minute_ts < ? ORDER BY minute_ts LIMIT ?"
  );
}

export function daySql(): string {
  return (
    "SELECT local_date, start_ts AS slot_ts, end_ts, windows, ok_windows, source_error_windows," +
    " sample_count, valid_count, pv_kw_avg, load_kw_reported_avg, grid_kw_avg, battery_kw_avg," +
    " pv_kwh_total_end, last_measured_ts FROM site_day" +
    " WHERE collector_id = ? AND timezone = ? AND start_ts < ? AND end_ts > ?" +
    " ORDER BY start_ts LIMIT ?"
  );
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { results?: unknown } | null)?.results;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export interface HistoryView {
  resolution: Resolution;
  fromTs: number;
  toTs: number;
  truncated: boolean;
  windows: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

export async function readHistory(
  db: D1Database,
  collectorId: string,
  range: TimeRange,
  timezone = "UTC",
): Promise<HistoryView> {
  const statement =
    range.resolution === "1m"
      ? db.prepare(minuteSql()).bind(collectorId, range.fromTs, range.toTs, MAX_ROWS)
      : range.resolution === "5m"
        ? db.prepare(fiveMinuteSql()).bind(collectorId, range.fromTs, range.toTs, MAX_ROWS)
        : db.prepare(daySql()).bind(collectorId, timezone, range.toTs, range.fromTs, MAX_ROWS);
  const result = await statement.all();
  const rows = rowsOf(result);
  const windows = rows.map((row) => presentWindow(row, range.resolution));
  return {
    resolution: range.resolution,
    fromTs: range.fromTs,
    toTs: range.toTs,
    truncated: rows.length >= MAX_ROWS,
    windows,
    // Summarise the presented windows: a raw 5m row carries ok_windows, not
    // quality, so counting raw rows reported "0 complete" for every range.
    summary: summarise(windows, rows.length >= MAX_ROWS),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function presentWindow(row: Record<string, unknown>, resolution: Resolution): Record<string, unknown> {
  const ts = numberOrNull(row.ts ?? row.minute_ts ?? row.slot_ts);
  const window: Record<string, unknown> = {
    ts: iso(ts),
    pv_kw_avg: numberOrNull(row.pv_kw_avg),
    load_kw_reported_avg: numberOrNull(row.load_kw_reported_avg),
    grid_kw_avg: numberOrNull(row.grid_kw_avg),
    battery_kw_avg: numberOrNull(row.battery_kw_avg),
    pv_kwh_total_end: numberOrNull(row.pv_kwh_total_end),
    sample_count: numberOrNull(row.sample_count),
    valid_count: numberOrNull(row.valid_count),
    last_measured_at_utc: iso(numberOrNull(row.last_measured_ts)),
  };
  if (resolution === "1m") {
    window.quality = row.quality;
    window.complete = row.complete === 1 || row.complete === true;
  } else {
    const windows = numberOrNull(row.windows) ?? 0;
    const ok = numberOrNull(row.ok_windows) ?? 0;
    // Storage is optional: only the three site powers must be present.
    const missing = ["pv_kw_avg", "load_kw_reported_avg", "grid_kw_avg"].some(
      (column) => numberOrNull(row[column]) === null,
    );
    window.windows = windows;
    window.ok_windows = ok;
    window.source_error_windows = numberOrNull(row.source_error_windows) ?? 0;
    const expected = resolution === "1d"
      ? ((numberOrNull(row.end_ts) ?? 0) - (numberOrNull(row.slot_ts) ?? 0)) / 60
      : 5;
    window.complete = windows === expected && ok === windows && !missing;
    window.quality = window.complete ? "ok" : "partial";
    if (resolution === "1d") {
      window.local_date = row.local_date;
      window.duration_seconds = expected * 60;
    }
  }
  return window;
}

function summarise(rows: Record<string, unknown>[], truncated: boolean): Record<string, unknown> {
  const counts: Record<string, number> = { ok: 0, partial: 0, source_error: 0, clock_invalid: 0, other: 0 };
  for (const row of rows) {
    const quality = typeof row.quality === "string" ? row.quality : "other";
    counts[quality in counts ? quality : "other"] += 1;
    // A five-minute window is labelled ok/partial, so its failed minutes live
    // only in source_error_windows; without this the header claimed "0 PVS
    // failures" for every range longer than two days. Counting minutes keeps
    // the same meaning as the 1m view, where each source_error row is a minute.
    counts.source_error += numberOrNull(row.source_error_windows) ?? 0;
  }
  const timestamps = rows
    .map((row) => numberOrNull(row.minute_ts ?? row.slot_ts ?? null) ?? instantSeconds(typeof row.ts === "string" ? row.ts : null))
    .filter((value): value is number => value !== null);
  return {
    windows: rows.length,
    ok: counts.ok,
    partial: counts.partial,
    source_error: counts.source_error,
    clock_invalid: counts.clock_invalid,
    first_ts: iso(timestamps.length > 0 ? Math.min(...timestamps) : null),
    last_ts: iso(timestamps.length > 0 ? Math.max(...timestamps) : null),
    truncated,
  };
}

export async function readPanelsLatest(db: D1Database, collectorId: string, nowSeconds: number): Promise<Record<string, unknown>> {
  // Every known panel is listed, not only the ones in the newest slot: a panel
  // that stopped reporting must stay visible instead of quietly vanishing from
  // the array. A panel with no row in that slot comes back null with a null
  // quality, which pages read as "not reporting" rather than "offline".
  //
  // The panel list comes from the inventory table the ingest maintains, and the
  // newest slot from panel_sample_by_slot. Reading both out of panel_sample
  // meant a distinct-scan plus a max over the collector's whole retained
  // history on every call, which is most of the free row-read budget when a
  // page polls this every five minutes.
  const result = await db
    .prepare(
      "WITH latest AS (SELECT MAX(slot_ts) AS slot_ts FROM panel_sample WHERE collector_id = ?)," +
        " known AS (SELECT panel_id FROM panel_known WHERE collector_id = ?)" +
        " SELECT known.panel_id, latest.slot_ts, sample.ac_kw, sample.energy_kwh_total, sample.dc_kw, sample.dc_v," +
        " sample.dc_a, sample.ac_v, sample.ac_a, sample.heatsink_c, sample.measured_ts, sample.quality" +
        " FROM known CROSS JOIN latest LEFT JOIN panel_sample AS sample" +
        " ON sample.collector_id = ? AND sample.panel_id = known.panel_id AND sample.slot_ts = latest.slot_ts" +
        " ORDER BY known.panel_id LIMIT ?",
    )
    .bind(collectorId, collectorId, collectorId, MAX_ROWS)
    .all();
  const rows = rowsOf(result);
  const slot = numberOrNull(rows[0]?.slot_ts ?? null);
  return {
    slot_ts: iso(slot),
    slot_age_seconds: slot === null ? null : Math.max(0, nowSeconds - slot),
    panels: rows.map((row) => ({
      panel_id: row.panel_id,
      ac_kw: numberOrNull(row.ac_kw),
      energy_kwh_total: numberOrNull(row.energy_kwh_total),
      dc_kw: numberOrNull(row.dc_kw),
      dc_v: numberOrNull(row.dc_v),
      dc_a: numberOrNull(row.dc_a),
      ac_v: numberOrNull(row.ac_v),
      ac_a: numberOrNull(row.ac_a),
      heatsink_c: numberOrNull(row.heatsink_c),
      measured_at_utc: iso(numberOrNull(row.measured_ts)),
      quality: row.quality,
    })),
  };
}

export interface PanelDayEnergy {
  kwh: number | null;
  firstTs: number;
  lastTs: number;
}

/**
 * Energy each panel moved inside a stored window, as the difference between its
 * first and last stored lifetime counter, with those two slot times kept so a
 * page can say what the number actually covers. One counter cannot show
 * movement, and a counter that went backwards has restarted (seen 2026-09-19 to
 * 2026-09-21), so neither has a total rather than zero or a negative one.
 */
export async function readPanelDayEnergy(
  db: D1Database,
  collectorId: string,
  fromTs: number,
  toTs: number,
): Promise<Map<string, PanelDayEnergy>> {
  // CROSS JOIN is deliberate: it is an inner join the planner must not
  // reorder, so the grouped subquery stays outermost. Left to choose, SQLite
  // drives from panel_sample and rescans the collector's whole history for
  // every slot it reads - 3.3M rows read for one day of energy instead of the
  // day's rows.
  const result = await db
    .prepare(
      "SELECT bounds.panel_id, bounds.first_ts, bounds.last_ts, first_row.energy_kwh_total AS first_kwh," +
        " last_row.energy_kwh_total AS last_kwh" +
        " FROM (SELECT panel_id, MIN(slot_ts) AS first_ts, MAX(slot_ts) AS last_ts FROM panel_sample" +
        " WHERE collector_id = ? AND slot_ts >= ? AND slot_ts < ? AND energy_kwh_total IS NOT NULL" +
        " GROUP BY panel_id) AS bounds" +
        " CROSS JOIN panel_sample AS first_row ON first_row.collector_id = ? AND first_row.panel_id = bounds.panel_id" +
        " AND first_row.slot_ts = bounds.first_ts" +
        " CROSS JOIN panel_sample AS last_row ON last_row.collector_id = ? AND last_row.panel_id = bounds.panel_id" +
        " AND last_row.slot_ts = bounds.last_ts",
    )
    .bind(collectorId, fromTs, toTs, collectorId, collectorId)
    .all();
  const energy = new Map<string, PanelDayEnergy>();
  for (const row of rowsOf(result)) {
    const firstTs = numberOrNull(row.first_ts);
    const lastTs = numberOrNull(row.last_ts);
    const first = numberOrNull(row.first_kwh);
    const last = numberOrNull(row.last_kwh);
    if (firstTs === null || lastTs === null) continue;
    const moved = first === null || last === null || lastTs === firstTs ? null : Math.round((last - first) * 1000) / 1000;
    energy.set(String(row.panel_id), { kwh: moved !== null && moved < 0 ? null : moved, firstTs, lastTs });
  }
  return energy;
}

export async function readPanelHistory(
  db: D1Database,
  collectorId: string,
  panelId: string,
  fromTs: number,
  toTs: number,
): Promise<Record<string, unknown>> {
  const span = clampSpan(fromTs, toTs, PANEL_SPAN_SECONDS);
  const result = await db
    .prepare(
      "SELECT slot_ts, ac_kw, energy_kwh_total, measured_ts, quality FROM panel_sample" +
        " WHERE collector_id = ? AND panel_id = ? AND slot_ts >= ? AND slot_ts < ? ORDER BY slot_ts LIMIT ?",
    )
    .bind(collectorId, panelId, span.fromTs, span.toTs, MAX_ROWS)
    .all();
  const rows = rowsOf(result);
  return {
    panel_id: panelId,
    resolution: "5m",
    from_utc: iso(span.fromTs),
    to_utc: iso(span.toTs),
    clamped: span.clamped,
    samples: rows.map((row) => ({
      ts: iso(numberOrNull(row.slot_ts)),
      ac_kw: numberOrNull(row.ac_kw),
      energy_kwh_total: numberOrNull(row.energy_kwh_total),
      measured_at_utc: iso(numberOrNull(row.measured_ts)),
      quality: row.quality,
    })),
  };
}

/** One slot-range scan for every panel's day curve, newest slots first if capped. */
export async function readAllPanelHistory(
  db: D1Database,
  collectorId: string,
  fromTs: number,
  toTs: number,
): Promise<Record<string, unknown>> {
  const result = await db
    .prepare(
      "SELECT panel_id, slot_ts, ac_kw, energy_kwh_total, measured_ts, quality FROM panel_sample" +
        " WHERE collector_id = ? AND slot_ts >= ? AND slot_ts < ?" +
        " ORDER BY slot_ts DESC, panel_id DESC LIMIT ?",
    )
    .bind(collectorId, fromTs, toTs, MAX_ROWS + 1)
    .all();
  const rows = rowsOf(result);
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows.slice(0, MAX_ROWS).reverse()) {
    const id = String(row.panel_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id)?.push({
      ts: iso(numberOrNull(row.slot_ts)),
      ac_kw: numberOrNull(row.ac_kw),
      energy_kwh_total: numberOrNull(row.energy_kwh_total),
      measured_at_utc: iso(numberOrNull(row.measured_ts)),
      quality: row.quality,
    });
  }
  return {
    resolution: "5m",
    from_utc: iso(fromTs),
    to_utc: iso(toTs),
    truncated: rows.length > MAX_ROWS,
    panels: Array.from(grouped, ([panel_id, samples]) => ({ panel_id, samples })),
  };
}

export async function readHealth(db: D1Database, collectorId: string, nowSeconds: number): Promise<Record<string, unknown>> {
  const results = await db.batch([
    db.prepare("SELECT collected_ts, measured_ts, received_ts, quality FROM latest_site WHERE collector_id = ? LIMIT 1").bind(collectorId),
    // The stored span, not a row count: COUNT(*) walks every retained minute,
    // and this page polls it every thirty seconds. Each end is its own scalar
    // subquery on purpose - one SELECT with MIN and MAX together is a full walk,
    // because SQLite's min/max index seek only applies to a lone aggregate.
    db
      .prepare(
        "SELECT (SELECT MIN(minute_ts) FROM site_minute WHERE collector_id = ?) AS first_minute_ts," +
          " (SELECT MAX(minute_ts) FROM site_minute WHERE collector_id = ?) AS last_minute_ts",
      )
      .bind(collectorId, collectorId),
    db.prepare("SELECT COUNT(*) AS panels FROM panel_known WHERE collector_id = ?").bind(collectorId),
    // The newest slot comes from the samples, not from the roster: the ingest
    // writes a known-panel row once, so its `last_seen_ts` is first sighting,
    // not the last slot. A lone MAX is an index seek on panel_sample_by_slot.
    db.prepare("SELECT MAX(slot_ts) AS last_slot_ts FROM panel_sample WHERE collector_id = ?").bind(collectorId),
    // Hourly heartbeats are liveness, not incidents; keep them out of the
    // recent-event list so a quiet system does not push real events out.
    db
      .prepare(
        "SELECT event_ts, event_type, details_code FROM collector_event" +
          " WHERE collector_id = ? AND event_type != 'collector_heartbeat'" +
          " ORDER BY event_ts DESC LIMIT 10"
      )
      .bind(collectorId),
  ]);
  const latest = rowsOf(results[0])[0] ?? null;
  const minutes = rowsOf(results[1])[0] ?? {};
  const panels = rowsOf(results[2])[0] ?? {};
  const newestSlot = rowsOf(results[3])[0] ?? {};
  const events = rowsOf(results[4]);
  const receivedTs = latest === null ? null : numberOrNull(latest.received_ts);
  const age = receivedTs === null ? null : Math.max(0, nowSeconds - receivedTs);
  const measuredTs = latest === null ? null : numberOrNull(latest.measured_ts);
  // Onboarding needs these two apart: an authenticated upload proves the Pi
  // reached the cloud, a measurement time proves the PVS returned a reading.
  const measuredQuality = latest === null ? null : (latest.quality ?? null);
  return {
    collector_id: collectorId,
    state: latest === null ? "waiting_for_collector" : age !== null && age > 120 ? "stalled" : "collecting",
    authenticated_upload: receivedTs !== null,
    valid_measurement: measuredTs !== null && measuredQuality !== "clock_invalid",
    last_received_at_utc: iso(receivedTs),
    last_collected_at_utc: latest === null ? null : iso(numberOrNull(latest.collected_ts)),
    last_measured_at_utc: iso(measuredTs),
    latest_quality: latest === null ? null : latest.quality,
    first_minute_at_utc: iso(numberOrNull(minutes.first_minute_ts ?? null)),
    last_minute_at_utc: iso(numberOrNull(minutes.last_minute_ts ?? null)),
    known_panels: numberOrNull(panels.panels),
    panels_discovered: (numberOrNull(panels.panels) ?? 0) > 0,
    last_panel_slot_at_utc: iso(numberOrNull(newestSlot.last_slot_ts ?? null)),
    events: events.map((row) => ({
      event_ts_utc: iso(numberOrNull(row.event_ts)),
      event_type: row.event_type,
      details_code: row.details_code ?? null,
    })),
    // The Pi queue backlog is never uploaded; the cloud cannot report it.
    queue_backlog: null,
  };
}
