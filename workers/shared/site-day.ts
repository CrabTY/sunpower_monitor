/** Site-local daily views over retained minute rows. Raw history stays intact. */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localDay(ts: number, timezone: string): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ts * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
}

/** Binary search handles 23/25-hour days and zones that change offset at midnight. */
export function dayBounds(day: string, timezone: string): { start: number; end: number } {
  function midnight(target: string): number {
    const guess = Date.parse(`${target}T00:00:00Z`) / 1000;
    let low = guess - 36 * 3600;
    let high = guess + 36 * 3600;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (localDay(middle, timezone) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  return { start: midnight(day), end: midnight(nextDay(day)) };
}

const DAILY_SQL =
  "SELECT COUNT(*) AS windows, SUM(CASE WHEN quality = 'ok' THEN 1 ELSE 0 END) AS ok_windows," +
  " SUM(CASE WHEN quality = 'source_error' THEN 1 ELSE 0 END) AS source_error_windows," +
  " COALESCE(SUM(sample_count), 0) AS sample_count, COALESCE(SUM(valid_count), 0) AS valid_count," +
  [
    ["pv_kw", "pv_kw_avg"], ["load_kw_reported", "load_kw_reported_avg"],
    ["grid_kw", "grid_kw_avg"], ["battery_kw", "battery_kw_avg"],
  ].map(([field, column]) =>
    ` SUM(${column} * json_extract(valid_counts_json, '$.${field}'))` +
    ` / NULLIF(SUM(json_extract(valid_counts_json, '$.${field}')), 0) AS ${column},`
  ).join("") +
  " MAX(pv_kwh_total_end) AS pv_kwh_total_end, MAX(last_measured_ts) AS last_measured_ts" +
  " FROM site_minute WHERE collector_id = ? AND minute_ts >= ? AND minute_ts < ?";

async function rollupDay(db: D1Database, collectorId: string, timezone: string, day: string, now: number): Promise<void> {
  const { start, end } = dayBounds(day, timezone);
  // One statement makes the aggregate and the dirty-marker replacement atomic
  // with respect to a concurrent late replay.
  await db.prepare(
    "INSERT INTO site_day (collector_id, local_date, timezone, start_ts, end_ts, windows, ok_windows," +
    " source_error_windows, sample_count, valid_count, pv_kw_avg, load_kw_reported_avg, grid_kw_avg," +
    " battery_kw_avg, pv_kwh_total_end, last_measured_ts, updated_ts)" +
    " SELECT ?, ?, ?, ?, ?, summary.windows, COALESCE(summary.ok_windows, 0)," +
    " COALESCE(summary.source_error_windows, 0), summary.sample_count, summary.valid_count," +
    " summary.pv_kw_avg, summary.load_kw_reported_avg, summary.grid_kw_avg, summary.battery_kw_avg," +
    " summary.pv_kwh_total_end, summary.last_measured_ts, ? FROM (" + DAILY_SQL + ") AS summary WHERE true" +
    " ON CONFLICT(collector_id, local_date) DO UPDATE SET" +
    " timezone = excluded.timezone, start_ts = excluded.start_ts, end_ts = excluded.end_ts," +
    " windows = excluded.windows, ok_windows = excluded.ok_windows," +
    " source_error_windows = excluded.source_error_windows, sample_count = excluded.sample_count," +
    " valid_count = excluded.valid_count, pv_kw_avg = excluded.pv_kw_avg," +
    " load_kw_reported_avg = excluded.load_kw_reported_avg, grid_kw_avg = excluded.grid_kw_avg," +
    " battery_kw_avg = excluded.battery_kw_avg, pv_kwh_total_end = excluded.pv_kwh_total_end," +
    " last_measured_ts = excluded.last_measured_ts, updated_ts = excluded.updated_ts",
  ).bind(collectorId, day, timezone, start, end, now, collectorId, start, end).run();
}

/** Refresh today and yesterday; fill up to seven older missing days per cron. */
export async function refreshSiteDays(db: D1Database, collectorId: string, now: number): Promise<void> {
  const location = await db.prepare("SELECT timezone FROM site_location WHERE collector_id = ?").bind(collectorId).first<{ timezone: string }>();
  const timezone = location?.timezone ?? "UTC";
  const span = await db.prepare(
    "SELECT MIN(minute_ts) AS first_ts FROM site_minute WHERE collector_id = ?",
  ).bind(collectorId).first<{ first_ts: number | null }>();
  if (span?.first_ts == null) return;
  const today = localDay(now, timezone);
  const first = localDay(span.first_ts, timezone);
  const existing = await db.prepare(
    "SELECT local_date, timezone, end_ts, updated_ts FROM site_day WHERE collector_id = ? ORDER BY local_date",
  ).bind(collectorId).all<{ local_date: string; timezone: string; end_ts: number; updated_ts: number }>();
  const byDay = new Map((existing.results ?? []).map((row) => [row.local_date, row]));
  const pending: string[] = [];
  for (let day = first; day <= today; day = nextDay(day)) {
    const row = byDay.get(day);
    if (!row || row.timezone !== timezone || row.updated_ts === 0) pending.push(day);
    if (pending.length >= 7) break;
  }
  const yesterday = previousDay(today);
  const previous = byDay.get(yesterday);
  if (previous && previous.timezone === timezone && previous.updated_ts < previous.end_ts && !pending.includes(yesterday)) {
    pending.push(yesterday);
  }
  if (!pending.includes(today)) pending.push(today);
  for (const day of pending) await rollupDay(db, collectorId, timezone, day, now);
}
