import assert from "node:assert/strict";
import { test } from "node:test";

import dashboard, { type Env } from "../src/index.js";
import { SESSION_COOKIE } from "../src/constants.js";
import { signSession } from "../src/session.js";
import { MAX_WEATHER_SPAN_SECONDS, WEATHER_STALE_SECONDS, localDate, parseWeatherRange, readWeather } from "../src/weather.js";

const NOW = Math.floor(Date.parse("2026-09-18T20:00:00Z") / 1000);
const SECRET = "test-session-secret";
const TZ = "America/Los_Angeles";

class ScriptedDb {
  allRows: Record<string, unknown>[][];
  statements: { sql: string; values: unknown[] }[] = [];
  firstRow: Record<string, unknown> | null = null;
  private cursor = 0;

  constructor(allRows: Record<string, unknown>[][] = []) {
    this.allRows = allRows;
  }

  prepare(sql: string) {
    const statement = {
      sql,
      values: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.values = values;
        return statement;
      },
      all: async () => ({ results: this.allRows[this.cursor++] ?? [] }),
      first: async () => this.firstRow,
      run: async () => ({ success: true }),
    };
    this.statements.push(statement);
    return statement;
  }
}

function forecastRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hour_ts: Date.parse("2026-09-18T12:00:00Z") / 1000,
    kind: "forecast",
    temperature_c: 21.5,
    weather_code: 0,
    cloud_cover_pct: 4,
    sunshine_seconds: 1800,
    precipitation_mm: 0,
    precipitation_probability_pct: 0,
    uv_index: null,
    source: "open-meteo-forecast",
    fetched_ts: NOW - 600,
    quality: "ok",
    ...overrides,
  };
}

test("weather ranges default to a day and refuse empty, long, or far-future spans", () => {
  const defaulted = parseWeatherRange(new URLSearchParams(), NOW);
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.value?.toTs, NOW);
  assert.equal(defaulted.value?.fromTs, NOW - 24 * 3600);
  assert.equal(parseWeatherRange(new URLSearchParams({ from: "nope" }), NOW).error, "invalid_time");
  assert.equal(
    parseWeatherRange(new URLSearchParams({ from: "2026-09-18T00:00:00Z", to: "2026-09-17T00:00:00Z" }), NOW).error,
    "invalid_range",
  );
  const long = new Date((NOW - MAX_WEATHER_SPAN_SECONDS - 60) * 1000).toISOString();
  assert.equal(parseWeatherRange(new URLSearchParams({ from: long, to: new Date(NOW * 1000).toISOString() }), NOW).error, "range_too_long");
  const future = new Date((NOW + 20 * 24 * 3600) * 1000).toISOString();
  assert.equal(parseWeatherRange(new URLSearchParams({ to: future }), NOW).error, "range_in_future");
});

test("local dates follow the site zone across both DST shifts", () => {
  // Spring forward 2026-03-08 10:00Z: 01:59 PST then 03:00 PDT, same local day.
  assert.equal(localDate(Date.parse("2026-03-08T07:00:00Z") / 1000, TZ), "2026-03-07");
  assert.equal(localDate(Date.parse("2026-03-08T09:59:00Z") / 1000, TZ), "2026-03-08");
  assert.equal(localDate(Date.parse("2026-03-08T10:00:00Z") / 1000, TZ), "2026-03-08");
  // Fall back 2026-11-01 09:00Z: 01:59 PDT then 01:00 PST, still 2026-11-01.
  assert.equal(localDate(Date.parse("2026-11-01T08:59:00Z") / 1000, TZ), "2026-11-01");
  assert.equal(localDate(Date.parse("2026-11-01T09:00:00Z") / 1000, TZ), "2026-11-01");
  // A zone the runtime does not know must not throw; it falls back to UTC.
  assert.equal(localDate(Date.parse("2026-03-08T10:00:00Z") / 1000, "Mars/Olympus"), "2026-03-08");
});

test("hourly forecast and UV merge by valid hour, not by position", async () => {
  const db = new ScriptedDb([
    [
      forecastRow(),
      forecastRow({ hour_ts: Date.parse("2026-09-18T14:00:00Z") / 1000, sunshine_seconds: null, precipitation_probability_pct: null, quality: "partial" }),
      {
        hour_ts: Date.parse("2026-09-18T12:00:00Z") / 1000,
        kind: "air_quality",
        uv_index: 4.1,
        source: "open-meteo-air-quality",
        fetched_ts: NOW - 300,
      },
    ],
    [],
  ]);
  const view = await readWeather(
    db as unknown as D1Database,
    "home-pvs",
    { fromTs: NOW - 24 * 3600, toTs: NOW },
    TZ,
    NOW,
  );
  assert.equal(view.hours.length, 2);
  const [first, second] = view.hours;
  assert.equal(first.temperature_c, 21.5);
  assert.equal(first.sunshine_duration_seconds, 1800);
  assert.equal(first.uv_index, 4.1);
  assert.equal(first.uv_source, "open-meteo-air-quality");
  assert.equal(first.source, "open-meteo-forecast");
  assert.equal(first.quality, "ok");
  assert.equal(first.stale, false);
  assert.equal(first.age_seconds, 600);
  // UV missing for the second hour is null, never zero.
  assert.equal(second.uv_index, null);
  assert.equal(second.uv_source, null);
  assert.equal(second.precipitation_probability_pct, null);
  assert.equal(second.sunshine_duration_seconds, null);
  assert.equal(second.quality, "partial");
  assert.equal(second.temperature_c, 21.5);
  assert.equal(view.newestFetchedTs, NOW - 300);
  assert.equal(view.stale, false);
});

test("an old fetch is reported stale instead of being used as current weather", async () => {
  const old = NOW - WEATHER_STALE_SECONDS - 60;
  const db = new ScriptedDb([
    [forecastRow({ hour_ts: NOW, fetched_ts: old })],
    [],
  ]);
  const view = await readWeather(db as unknown as D1Database, "home-pvs", { fromTs: NOW - 3600, toTs: NOW }, TZ, NOW);
  assert.equal(view.hours[0].stale, true);
  assert.equal(view.stale, true);

  // An hour that already ended cannot change any more, so its fetch age stops
  // meaning staleness: the row is the last forecast made for that hour.
  const finished = new ScriptedDb([[forecastRow({ hour_ts: NOW - 8 * 3600, fetched_ts: old })], []]);
  const past = await readWeather(
    finished as unknown as D1Database,
    "home-pvs",
    { fromTs: NOW - 24 * 3600, toTs: NOW },
    TZ,
    NOW,
  );
  assert.equal(past.hours[0].stale, false);
  assert.equal(past.stale, false);

  const empty = await readWeather(new ScriptedDb([[], []]) as unknown as D1Database, "home-pvs", { fromTs: NOW - 3600, toTs: NOW }, TZ, NOW);
  assert.deepEqual(empty.hours, []);
  assert.equal(empty.stale, true);
  assert.equal(empty.newestFetchedTs, null);
});

test("sunrise and sunset group into one local day with a derived daylight span", async () => {
  const sunrise = Date.parse("2026-09-18T13:52:00Z") / 1000;
  const sunset = Date.parse("2026-09-19T01:12:00Z") / 1000;
  const db = new ScriptedDb([
    [],
    [
      { hour_ts: sunrise, kind: "sunrise", source: "open-meteo-forecast", fetched_ts: NOW - 600 },
      { hour_ts: sunset, kind: "sunset", source: "open-meteo-forecast", fetched_ts: NOW - 600 },
      { hour_ts: Date.parse("2026-09-19T13:53:00Z") / 1000, kind: "sunrise", source: "open-meteo-forecast", fetched_ts: NOW - 600 },
    ],
  ]);
  const view = await readWeather(
    db as unknown as D1Database,
    "home-pvs",
    { fromTs: Date.parse("2026-09-18T07:00:00Z") / 1000, toTs: Date.parse("2026-09-19T07:00:00Z") / 1000 },
    TZ,
    NOW,
  );
  assert.deepEqual(view.days, [
    {
      date: "2026-09-18",
      sunrise_utc: "2026-09-18T13:52:00Z",
      sunset_utc: "2026-09-19T01:12:00Z",
      daylight_seconds: 40800,
      sunshine_duration_seconds: null,
      source: "open-meteo-forecast",
      fetched_at_utc: "2026-09-18T19:50:00Z",
      stale: false,
    },
    {
      date: "2026-09-19",
      sunrise_utc: "2026-09-19T13:53:00Z",
      sunset_utc: null,
      daylight_seconds: null,
      sunshine_duration_seconds: null,
      source: "open-meteo-forecast",
      fetched_at_utc: "2026-09-18T19:50:00Z",
      stale: false,
    },
  ]);
});

test("sunshine totals follow the ending hour's site-local date", async () => {
  const db = new ScriptedDb([[
    forecastRow({ hour_ts: Date.parse("2026-09-19T07:00:00Z") / 1000, sunshine_seconds: 1800 }),
    forecastRow({ hour_ts: Date.parse("2026-09-19T08:00:00Z") / 1000, sunshine_seconds: 900 }),
    forecastRow({ hour_ts: Date.parse("2026-09-19T09:00:00Z") / 1000, sunshine_seconds: null }),
  ], []]);
  const view = await readWeather(
    db as unknown as D1Database,
    "home-pvs",
    { fromTs: Date.parse("2026-09-18T07:00:00Z") / 1000, toTs: Date.parse("2026-09-19T10:00:00Z") / 1000 },
    TZ,
    Date.parse("2026-09-19T10:00:00Z") / 1000,
  );
  assert.deepEqual(view.days.map((day) => [day.date, day.sunshine_duration_seconds]), [
    ["2026-09-18", 1800],
    ["2026-09-19", 900],
  ]);
});

test("the weather route reports an unconfigured site without querying weather", async () => {
  const db = new ScriptedDb([]);
  const env: Env = {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    SESSION_SECRET: SECRET,
    ALLOWED_USER_IDS: "123456",
    COLLECTOR_ID: "home-pvs",
  };
  const session = await signSession({ userId: "123456", expiresAt: Math.floor(Date.now() / 1000) + 600 }, SECRET);
  const response = await dashboard.fetch(
    new Request("https://solar.example/api/v1/weather", { headers: { Cookie: `${SESSION_COOKIE}=${session}` } }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.configured, false);
  assert.equal(payload.stale, true);
  assert.deepEqual(payload.hours, []);
  assert.equal(db.statements.length, 1); // location lookup only
});

test("the weather route returns merged hours for a configured site", async () => {
  const db = new ScriptedDb([[forecastRow()], []]);
  db.firstRow = { latitude: 37.339, longitude: -121.895, timezone: TZ, source: "us_census", updated_ts: NOW - 86400 };
  const env: Env = {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    SESSION_SECRET: SECRET,
    ALLOWED_USER_IDS: "123456",
    COLLECTOR_ID: "home-pvs",
  };
  const session = await signSession({ userId: "123456", expiresAt: Math.floor(Date.now() / 1000) + 600 }, SECRET);
  const from = new Date((NOW - 3600) * 1000).toISOString();
  const to = new Date(NOW * 1000).toISOString();
  const response = await dashboard.fetch(
    new Request(`https://solar.example/api/v1/weather?from=${from}&to=${to}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${session}` },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { hours: Record<string, unknown>[]; location: Record<string, unknown> };
  assert.equal(payload.hours[0].temperature_c, 21.5);
  assert.equal(payload.location.timezone, TZ);

  const anonymous = await dashboard.fetch(new Request(`https://solar.example/api/v1/weather?from=${from}&to=${to}`), env);
  assert.equal(anonymous.status, 401);
});
