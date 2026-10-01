/**
 * Weather read model: hourly forecast + UV merged by valid hour, plus daily
 * sunrise/sunset grouped by *site-local* date.
 *
 * Missing is `null`, never zero, and staleness travels with every value so the
 * page can say "insufficient data" instead of judging with an old forecast.
 */

import { isValidTimezone } from "./location.js";
import { instantSeconds, iso, type Validation } from "./query.js";
import { localDay } from "../../shared/site-day.js";

export const WEATHER_STALE_SECONDS = 3 * 3600;
export const MAX_WEATHER_SPAN_SECONDS = 31 * 24 * 3600 + 3600;
export const MAX_WEATHER_ROWS = 2000;
export const DEFAULT_WEATHER_SPAN_SECONDS = 24 * 3600;
/** One slot of slack so a range that starts mid-hour still shows that hour. */
const HOUR_SLACK_SECONDS = 3600;
const DAY_SLACK_SECONDS = 86400;
const FUTURE_LIMIT_SECONDS = 7 * 24 * 3600;

export interface WeatherRange {
  fromTs: number;
  toTs: number;
}

export function parseWeatherRange(params: URLSearchParams, nowSeconds: number): Validation<WeatherRange> {
  const toTs = params.get("to") === null ? nowSeconds : instantSeconds(params.get("to"));
  const fromTs = params.get("from") === null ? (toTs ?? 0) - DEFAULT_WEATHER_SPAN_SECONDS : instantSeconds(params.get("from"));
  if (fromTs === null || toTs === null) return { ok: false, error: "invalid_time" };
  if (toTs <= fromTs) return { ok: false, error: "invalid_range" };
  if (toTs - fromTs > MAX_WEATHER_SPAN_SECONDS) return { ok: false, error: "range_too_long" };
  if (toTs > nowSeconds + FUTURE_LIMIT_SECONDS) return { ok: false, error: "range_in_future" };
  return { ok: true, value: { fromTs, toTs } };
}

/** Site-local calendar date ("2026-09-18") for a UTC instant. */
export function localDate(tsSeconds: number, timezone: string): string {
  return localDay(tsSeconds, isValidTimezone(timezone) ? timezone : "UTC");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { results?: unknown } | null)?.results;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const FORECAST_FIELDS = [
  "temperature_c",
  "weather_code",
  "cloud_cover_pct",
  "precipitation_mm",
  "precipitation_probability_pct",
] as const;

function qualityOf(forecast: Record<string, unknown> | null): string {
  if (forecast === null) return "missing";
  return FORECAST_FIELDS.every((field) => numberOrNull(forecast[field]) !== null) ? "ok" : "partial";
}

export interface WeatherView {
  hours: Record<string, unknown>[];
  days: Record<string, unknown>[];
  newestFetchedTs: number | null;
  stale: boolean;
}

export async function readWeather(
  db: D1Database,
  collectorId: string,
  range: WeatherRange,
  timezone: string,
  nowSeconds: number,
): Promise<WeatherView> {
  const hoursResult = await db
    .prepare(
      "SELECT w.hour_ts, w.kind, w.temperature_c, w.weather_code, w.cloud_cover_pct, w.precipitation_mm," +
        " w.precipitation_probability_pct, w.uv_index, w.source, w.fetched_ts, w.quality, s.sunshine_seconds" +
        " FROM weather_hour AS w LEFT JOIN weather_sunshine_hour AS s" +
        " ON s.collector_id = w.collector_id AND s.hour_ts = w.hour_ts AND w.kind = 'forecast'" +
        " WHERE w.collector_id = ? AND w.kind IN ('forecast', 'air_quality') AND w.hour_ts >= ? AND w.hour_ts < ?" +
        " ORDER BY w.hour_ts LIMIT ?",
    )
    .bind(collectorId, range.fromTs - HOUR_SLACK_SECONDS, range.toTs + HOUR_SLACK_SECONDS, MAX_WEATHER_ROWS)
    .all();
  const daylightResult = await db
    .prepare(
      "SELECT hour_ts, kind, source, fetched_ts FROM weather_hour" +
        " WHERE collector_id = ? AND kind IN ('sunrise', 'sunset') AND hour_ts >= ? AND hour_ts < ?" +
        " ORDER BY hour_ts LIMIT ?",
    )
    .bind(collectorId, range.fromTs - DAY_SLACK_SECONDS, range.toTs + DAY_SLACK_SECONDS, MAX_WEATHER_ROWS)
    .all();

  const hourly = new Map<number, { forecast: Record<string, unknown> | null; air: Record<string, unknown> | null }>();
  let newestFetchedTs: number | null = null;
  for (const row of rowsOf(hoursResult)) {
    const ts = numberOrNull(row.hour_ts);
    if (ts === null) continue;
    const slot = hourly.get(ts) ?? { forecast: null, air: null };
    if (row.kind === "forecast") slot.forecast = row;
    else if (row.kind === "air_quality") slot.air = row;
    hourly.set(ts, slot);
    const fetched = numberOrNull(row.fetched_ts);
    if (fetched !== null) newestFetchedTs = newestFetchedTs === null ? fetched : Math.max(newestFetchedTs, fetched);
  }

  const hours = [...hourly.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([ts, slot]) => {
      // Oldest contributing fetch: if any source is stale, the hour is stale.
      const fetches = [slot.forecast?.fetched_ts, slot.air?.fetched_ts]
        .map(numberOrNull)
        .filter((value): value is number => value !== null);
      const fetched = fetches.length === 0 ? null : Math.min(...fetches);
      const age = fetched === null ? null : Math.max(0, nowSeconds - fetched);
      return {
        ts: iso(ts),
        kind: "forecast",
        temperature_c: numberOrNull(slot.forecast?.temperature_c),
        weather_code: numberOrNull(slot.forecast?.weather_code),
        cloud_cover_pct: numberOrNull(slot.forecast?.cloud_cover_pct),
        sunshine_duration_seconds: numberOrNull(slot.forecast?.sunshine_seconds),
        precipitation_mm: numberOrNull(slot.forecast?.precipitation_mm),
        precipitation_probability_pct: numberOrNull(slot.forecast?.precipitation_probability_pct),
        uv_index: numberOrNull(slot.air?.uv_index),
        source: slot.forecast === null ? null : (slot.forecast.source ?? null),
        uv_source: slot.air === null ? null : (slot.air.source ?? null),
        fetched_at_utc: iso(fetched),
        age_seconds: age,
        // A finished hour is final: the sync no longer rewrites it, so an old
        // fetch time there is not staleness. Staleness means the value can
        // still change, which is true for the hour in progress and later.
        stale: age === null || (ts + HOUR_SLACK_SECONDS > nowSeconds && age > WEATHER_STALE_SECONDS),
        quality: qualityOf(slot.forecast),
      };
    });

  const days = new Map<string, { sunrise: Record<string, unknown> | null; sunset: Record<string, unknown> | null; sunshineSeconds: number | null }>();
  for (const [ts, slot] of hourly) {
    const sunshine = numberOrNull(slot.forecast?.sunshine_seconds);
    if (sunshine === null) continue;
    // The value covers the preceding hour, so midnight's hour belongs to yesterday.
    const key = localDate(ts - 1, timezone);
    const day = days.get(key) ?? { sunrise: null, sunset: null, sunshineSeconds: null };
    day.sunshineSeconds = (day.sunshineSeconds ?? 0) + sunshine;
    days.set(key, day);
  }
  for (const row of rowsOf(daylightResult)) {
    const ts = numberOrNull(row.hour_ts);
    if (ts === null) continue;
    const key = localDate(ts, timezone);
    const day = days.get(key) ?? { sunrise: null, sunset: null, sunshineSeconds: null };
    if (row.kind === "sunrise") day.sunrise = row;
    else if (row.kind === "sunset") day.sunset = row;
    days.set(key, day);
  }
  const firstDate = localDate(range.fromTs, timezone);
  const lastDate = localDate(range.toTs, timezone);

  const dayRows = [...days.entries()]
    .filter(([date]) => date >= firstDate && date <= lastDate)
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([date, slot]) => {
      const sunrise = numberOrNull(slot.sunrise?.hour_ts);
      const sunset = numberOrNull(slot.sunset?.hour_ts);
      const fetched = Math.max(numberOrNull(slot.sunrise?.fetched_ts) ?? 0, numberOrNull(slot.sunset?.fetched_ts) ?? 0) || null;
      const age = fetched === null ? null : Math.max(0, nowSeconds - fetched);
      const daylight = sunrise !== null && sunset !== null && sunset > sunrise ? sunset - sunrise : null;
      return {
        date,
        sunrise_utc: iso(sunrise),
        sunset_utc: iso(sunset),
        // Daylight duration is exactly this span; weather_hour needs no extra column.
        daylight_seconds: daylight,
        sunshine_duration_seconds: slot.sunshineSeconds,
        source: slot.sunrise?.source ?? slot.sunset?.source ?? null,
        fetched_at_utc: iso(fetched),
        stale: age === null || age > WEATHER_STALE_SECONDS,
      };
    });

  const stale = hours.length === 0 || hours.every((hour) => hour.stale === true);
  return { hours, days: dayRows, newestFetchedTs, stale };
}
