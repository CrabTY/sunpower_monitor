/**
 * Scheduled Open-Meteo sync: hourly forecast, hourly UV, daily daylight.
 *
 * Both providers are requested with `timezone=UTC`, so every timestamp is an
 * unambiguous instant and no local offset has to be guessed. Rows are keyed by
 * (collector_id, hour_ts, kind), so a newer forecast overwrites the same valid
 * hour while an older hour keeps its last good value. Missing fields stay
 * `null`; the page never reads a missing value as zero.
 *
 * Not every stored hour is rewritten on every sync: the site's own daylight
 * spans decide which hours are worth refreshing, and a finished hour is never
 * rewritten. See `refreshesHour`.
 */

import { isPlainObject } from "./contract.js";

export const FORECAST_SOURCE = "open-meteo-forecast";
export const AIR_QUALITY_SOURCE = "open-meteo-air-quality";
export const FORECAST_KIND = "forecast";
export const AIR_QUALITY_KIND = "air_quality";
export const SUNRISE_KIND = "sunrise";
export const SUNSET_KIND = "sunset";

const FORECAST_HOURLY = [
  "temperature_2m",
  "weather_code",
  "cloud_cover",
  "precipitation",
  "precipitation_probability",
  "sunshine_duration",
] as const;
const AIR_QUALITY_HOURLY = ["uv_index"] as const;
const PAST_DAYS = 1;
const FORECAST_DAYS = 3;
/** Hours this close to now are refreshed every sync, day or night. */
const ACTIVE_SECONDS = 24 * 3600;

/** 12 bound columns per row, so 8 rows stay under D1's 100-parameter limit. */
const ROWS_PER_STATEMENT = 8;

export const WEATHER_COLUMNS = [
  "collector_id",
  "hour_ts",
  "kind",
  "temperature_c",
  "weather_code",
  "cloud_cover_pct",
  "precipitation_mm",
  "precipitation_probability_pct",
  "uv_index",
  "source",
  "fetched_ts",
  "quality",
] as const;

export interface WeatherHourRow {
  hourTs: number;
  kind: typeof FORECAST_KIND | typeof AIR_QUALITY_KIND;
  temperatureC: number | null;
  weatherCode: number | null;
  cloudCoverPct: number | null;
  precipitationMm: number | null;
  precipitationProbabilityPct: number | null;
  sunshineSeconds: number | null;
  uvIndex: number | null;
  source: string;
  quality: "ok" | "partial";
}

export interface DaylightRow {
  kind: typeof SUNRISE_KIND | typeof SUNSET_KIND;
  ts: number;
}

/** One sunrise..sunset span: the hours the page shows with a measured curve. */
export interface DaylightSpan {
  start: number;
  end: number;
}

export interface SyncResult {
  skipped?: string;
  written: number;
  errors: string[];
}

export function forecastUrl(latitude: number, longitude: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${FORECAST_HOURLY.join(",")}&daily=sunrise,sunset,daylight_duration` +
    `&timezone=UTC&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`
  );
}

export function airQualityUrl(latitude: number, longitude: number): string {
  return (
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${AIR_QUALITY_HOURLY.join(",")}&timezone=UTC` +
    `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`
  );
}

/** Open-Meteo times are naive local strings; with `timezone=UTC` they are UTC. */
export function utcSeconds(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function alignHourly(payload: unknown, fields: readonly string[]): Map<number, (number | null)[]> {
  const aligned = new Map<number, (number | null)[]>();
  if (!isPlainObject(payload) || !isPlainObject(payload.hourly)) return aligned;
  const hourly = payload.hourly;
  const times = hourly.time;
  if (!Array.isArray(times)) return aligned;
  for (let index = 0; index < times.length; index += 1) {
    const hourTs = utcSeconds(times[index]);
    if (hourTs === null) continue;
    aligned.set(
      hourTs,
      fields.map((field) => {
        const column = hourly[field];
        return Array.isArray(column) ? numberOrNull(column[index]) : null;
      }),
    );
  }
  return aligned;
}

export function forecastRows(payload: unknown): WeatherHourRow[] {
  const rows: WeatherHourRow[] = [];
  for (const [hourTs, values] of alignHourly(payload, FORECAST_HOURLY)) {
    rows.push({
      hourTs,
      kind: FORECAST_KIND,
      temperatureC: values[0],
      weatherCode: values[1],
      cloudCoverPct: values[2],
      precipitationMm: values[3],
      precipitationProbabilityPct: values[4],
      sunshineSeconds: values[5] !== null && values[5] >= 0 && values[5] <= 3600 ? values[5] : null,
      uvIndex: null,
      source: FORECAST_SOURCE,
      quality: values.slice(0, 5).every((value) => value !== null) ? "ok" : "partial",
    });
  }
  return rows.sort((left, right) => left.hourTs - right.hourTs);
}

export function airQualityRows(payload: unknown): WeatherHourRow[] {
  const rows: WeatherHourRow[] = [];
  for (const [hourTs, values] of alignHourly(payload, AIR_QUALITY_HOURLY)) {
    rows.push({
      hourTs,
      kind: AIR_QUALITY_KIND,
      temperatureC: null,
      weatherCode: null,
      cloudCoverPct: null,
      precipitationMm: null,
      precipitationProbabilityPct: null,
      sunshineSeconds: null,
      uvIndex: values[0],
      source: AIR_QUALITY_SOURCE,
      quality: values[0] === null ? "partial" : "ok",
    });
  }
  return rows.sort((left, right) => left.hourTs - right.hourTs);
}

/**
 * Sunrise and sunset are stored as rows keyed by their own instant; the API
 * derives daylight duration as sunset - sunrise, so weather_hour needs no
 * extra column. `daylight_duration` is still requested from the provider.
 */
export function daylightRows(payload: unknown): DaylightRow[] {
  const rows: DaylightRow[] = [];
  if (!isPlainObject(payload) || !isPlainObject(payload.daily)) return rows;
  const daily = payload.daily;
  const sunrises = daily.sunrise;
  const sunsets = daily.sunset;
  if (!Array.isArray(sunrises) || !Array.isArray(sunsets)) return rows;
  for (let index = 0; index < sunrises.length; index += 1) {
    const rise = utcSeconds(sunrises[index]);
    const set = utcSeconds(sunsets[index]);
    if (rise !== null) rows.push({ kind: SUNRISE_KIND, ts: rise });
    if (set !== null) rows.push({ kind: SUNSET_KIND, ts: set });
  }
  return rows.sort((left, right) => left.ts - right.ts);
}

export function hourStatements(
  db: D1Database,
  collectorId: string,
  rows: WeatherHourRow[],
  fetchedTs: number,
  spans: readonly DaylightSpan[] = [],
): D1PreparedStatement[] {
  const refreshing: WeatherHourRow[] = [];
  const once: WeatherHourRow[] = [];
  for (const row of rows) {
    (refreshesHour(row.hourTs, fetchedTs, spans) ? refreshing : once).push(row);
  }
  return [
    ...chunkStatements(db, collectorId, refreshing, fetchedTs, true),
    ...chunkStatements(db, collectorId, once, fetchedTs, false),
  ];
}

/**
 * An hour is rewritten only while it can still change: hours ahead of now stay
 * fresh because they are still forecasts, and the site's daylight hours are the
 * ones the page judges production against. Everything else - a finished hour,
 * or a night hour more than a day out - is written once and left alone, because
 * D1 counts every rewritten row *and its key index entry* against a 100,000
 * row/day free cap, and a night forecast nobody reads at night is not worth
 * nine thousand rows a day.
 *
 * ponytail: a night hour one to three days out keeps the forecast it was first
 * stored with. Widen `ACTIVE_SECONDS` if a night forecast that far out ever has
 * to track the provider's later runs.
 */
export function refreshesHour(hourTs: number, fetchedTs: number, spans: readonly DaylightSpan[]): boolean {
  if (hourTs + 3600 <= fetchedTs) return false;
  if (hourTs < fetchedTs + ACTIVE_SECONDS) return true;
  return spans.some((span) => hourTs + 3600 > span.start && hourTs < span.end);
}

function chunkStatements(
  db: D1Database,
  collectorId: string,
  rows: WeatherHourRow[],
  fetchedTs: number,
  refresh: boolean,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const updates = WEATHER_COLUMNS.filter((column) => !["collector_id", "hour_ts", "kind"].includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + ROWS_PER_STATEMENT);
    const values = chunk.flatMap((row) => [
      collectorId,
      row.hourTs,
      row.kind,
      row.temperatureC,
      row.weatherCode,
      row.cloudCoverPct,
      row.precipitationMm,
      row.precipitationProbabilityPct,
      row.uvIndex,
      row.source,
      fetchedTs,
      row.quality,
    ]);
    const placeholders = chunk.map(() => `(${WEATHER_COLUMNS.map(() => "?").join(", ")})`).join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO weather_hour (${WEATHER_COLUMNS.join(", ")}) VALUES ${placeholders}` +
            (refresh
              ? ` ON CONFLICT(collector_id, hour_ts, kind) DO UPDATE SET ${updates}`
              : " ON CONFLICT DO NOTHING"),
        )
        .bind(...values),
    );
  }
  return statements;
}

/** Store sunshine by UTC hour; local-day totals can then handle DST correctly. */
export function sunshineStatements(
  db: D1Database,
  collectorId: string,
  rows: WeatherHourRow[],
  fetchedTs: number,
  spans: readonly DaylightSpan[] = [],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const forecast = rows.filter((row) => row.kind === FORECAST_KIND);
  for (const refresh of [true, false]) {
    const group = forecast.filter((row) => refreshesHour(row.hourTs, fetchedTs, spans) === refresh);
    for (let start = 0; start < group.length; start += ROWS_PER_STATEMENT) {
      const chunk = group.slice(start, start + ROWS_PER_STATEMENT);
      statements.push(
        db.prepare(
          `INSERT INTO weather_sunshine_hour (collector_id, hour_ts, sunshine_seconds) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}` +
            (refresh
              ? " ON CONFLICT(collector_id, hour_ts) DO UPDATE SET sunshine_seconds = excluded.sunshine_seconds"
              : " ON CONFLICT DO NOTHING"),
        ).bind(...chunk.flatMap((row) => [collectorId, row.hourTs, row.sunshineSeconds])),
      );
    }
  }
  return statements;
}

/**
 * Daylight rows are replaced, not upserted: a refined forecast can move a
 * sunrise by a minute, and two rows for one local date would be wrong.
 */
export function daylightStatements(
  db: D1Database,
  collectorId: string,
  rows: DaylightRow[],
  fetchedTs: number,
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const earliest = Math.min(...rows.map((row) => row.ts));
  const latest = Math.max(...rows.map((row) => row.ts));
  return [
    db
      .prepare(
        "DELETE FROM weather_hour WHERE collector_id = ? AND kind IN ('sunrise', 'sunset') AND hour_ts >= ? AND hour_ts <= ?",
      )
      .bind(collectorId, earliest - 86400, latest + 86400),
    ...rows.map((row) =>
      db
        .prepare(
          "INSERT INTO weather_hour (collector_id, hour_ts, kind, source, fetched_ts, quality)" +
            " VALUES (?, ?, ?, ?, ?, 'ok') ON CONFLICT(collector_id, hour_ts, kind) DO UPDATE SET" +
            " source = excluded.source, fetched_ts = excluded.fetched_ts, quality = excluded.quality",
        )
        .bind(collectorId, row.ts, row.kind, FORECAST_SOURCE, fetchedTs),
    ),
  ];
}

/** Pair sunrise with the next sunset, so the sync knows the hours that matter. */
export function daylightSpans(rows: DaylightRow[]): DaylightSpan[] {
  const spans: DaylightSpan[] = [];
  let sunrise: number | null = null;
  for (const row of [...rows].sort((left, right) => left.ts - right.ts)) {
    if (row.kind === SUNRISE_KIND) sunrise = row.ts;
    else if (sunrise !== null && row.ts > sunrise) {
      spans.push({ start: sunrise, end: row.ts });
      sunrise = null;
    }
  }
  return spans;
}

export async function storeWeather(
  db: D1Database,
  collectorId: string,
  hours: WeatherHourRow[],
  daylight: DaylightRow[],
  fetchedTs: number,
): Promise<number> {
  const spans = daylightSpans(daylight);
  const statements = [
    ...hourStatements(db, collectorId, hours, fetchedTs, spans),
    ...sunshineStatements(db, collectorId, hours, fetchedTs, spans),
    ...daylightStatements(db, collectorId, daylight, fetchedTs),
  ];
  if (statements.length === 0) return 0;
  await db.batch(statements);
  return hours.length + hours.filter((row) => row.kind === FORECAST_KIND).length + daylight.length;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { "User-Agent": "sunpower-monitor/0.1" } });
  if (!response.ok) throw new Error(`weather_http_${response.status}`);
  return response.json();
}

/**
 * One scheduled run. A provider that fails is reported and skipped: UV trouble
 * must never stop the forecast from being stored, and vice versa.
 */
export async function syncWeather(
  DB: D1Database,
  collectorId: string,
  fetchImpl: typeof fetch = fetch,
  fetchedTs: number = Math.floor(Date.now() / 1000),
): Promise<SyncResult> {
  const location = await DB.prepare(
    "SELECT latitude, longitude FROM site_location WHERE collector_id = ? LIMIT 1",
  )
    .bind(collectorId)
    .first<{ latitude: number | null; longitude: number | null }>();
  if (!location || typeof location.latitude !== "number" || typeof location.longitude !== "number") {
    return { skipped: "no_location", written: 0, errors: [] };
  }
  const hours: WeatherHourRow[] = [];
  const daylight: DaylightRow[] = [];
  const errors: string[] = [];
  try {
    const payload = await getJson(fetchImpl, forecastUrl(location.latitude, location.longitude));
    hours.push(...forecastRows(payload));
    daylight.push(...daylightRows(payload));
  } catch {
    errors.push(FORECAST_KIND);
  }
  try {
    hours.push(...airQualityRows(await getJson(fetchImpl, airQualityUrl(location.latitude, location.longitude))));
  } catch {
    errors.push(AIR_QUALITY_KIND);
  }
  if (hours.length === 0 && daylight.length === 0) return { skipped: "providers_failed", written: 0, errors };
  const written = await storeWeather(DB, collectorId, hours, daylight, fetchedTs);
  return { written, errors };
}
