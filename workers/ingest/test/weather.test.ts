import assert from "node:assert/strict";
import { test } from "node:test";
import ingest from "../src/index.js";

import {
  AIR_QUALITY_SOURCE,
  FORECAST_SOURCE,
  airQualityUrl,
  airQualityRows,
  alignHourly,
  daylightRows,
  daylightSpans,
  daylightStatements,
  forecastRows,
  forecastUrl,
  hourStatements,
  refreshesHour,
  sunshineStatements,
  storeWeather,
  syncWeather,
} from "../../shared/weather-sync.js";

/** Just after the fixture's first hour, so "now" sits inside its day. */
const SYNC_AT = Date.parse("2026-09-18T12:05:00Z") / 1000;

/** Provider payload with one deliberately missing UV hour and a null field. */
function forecastPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timezone: "UTC",
    hourly: {
      time: ["2026-09-18T12:00", "2026-09-18T13:00", "2026-09-18T14:00"],
      temperature_2m: [21.5, 22.4, 23.1],
      weather_code: [0, 2, 3],
      cloud_cover: [4, 30, 88],
      precipitation: [0, 0, 1.2],
      precipitation_probability: [0, 10, null],
      sunshine_duration: [1800, 3600, null],
    },
    daily: {
      time: ["2026-09-18", "2026-09-19"],
      sunrise: ["2026-09-18T13:52", "2026-09-19T13:53"],
      sunset: ["2026-09-19T01:12", "2026-09-20T01:11"],
      daylight_duration: [40800, 40680],
    },
    ...overrides,
  };
}

function airQualityPayload(): Record<string, unknown> {
  return {
    timezone: "UTC",
    hourly: {
      time: ["2026-09-18T12:00", "2026-09-18T14:00"],
      uv_index: [4.1, 6.3],
    },
  };
}

test("hourly fields align by valid time, not by array position", () => {
  const payload = forecastPayload();
  (payload.hourly as Record<string, unknown>).time = ["2026-09-18T13:00", "2026-09-18T12:00", "not-a-time"];
  const aligned = alignHourly(payload, ["temperature_2m"]);
  assert.equal(aligned.size, 2);
  // Values follow their own array position; the row is keyed by the time string.
  assert.deepEqual(aligned.get(Date.parse("2026-09-18T13:00Z") / 1000), [21.5]);
  assert.deepEqual(aligned.get(Date.parse("2026-09-18T12:00Z") / 1000), [22.4]);
});

test("a missing precipitation probability is null and marks the hour partial", () => {
  const rows = forecastRows(forecastPayload());
  assert.equal(rows.length, 3);
  const last = rows[2];
  assert.equal(last.precipitationProbabilityPct, null);
  assert.equal(last.precipitationMm, 1.2);
  assert.equal(last.sunshineSeconds, null);
  assert.equal(last.quality, "partial");
  assert.equal(rows[0].sunshineSeconds, 1800);
  assert.equal(rows[1].quality, "ok");
  assert.equal(rows[0].kind, "forecast");
  assert.equal(rows[0].source, FORECAST_SOURCE);
  assert.equal(rows[0].uvIndex, null);
});

test("uv index comes from air quality and is absent when the provider fails", () => {
  const rows = airQualityRows(airQualityPayload());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uvIndex, 4.1);
  assert.equal(rows[0].source, AIR_QUALITY_SOURCE);
  assert.equal(rows[0].temperatureC, null);
  assert.equal(rows[0].kind, "air_quality");

  assert.deepEqual(airQualityRows({ hourly: { time: [] , uv_index: [] } }), []);
  assert.deepEqual(airQualityRows({}), []);
  const missing = airQualityRows({ hourly: { time: ["2026-09-18T12:00"], uv_index: [null] } });
  assert.equal(missing[0].uvIndex, null);
  assert.equal(missing[0].quality, "partial");
});

test("sunrise and sunset are stored as instants and nulls are skipped", () => {
  const rows = daylightRows(forecastPayload());
  assert.deepEqual(
    rows.map((row) => [row.kind, row.ts]),
    [
      ["sunrise", Date.parse("2026-09-18T13:52Z") / 1000],
      ["sunset", Date.parse("2026-09-19T01:12Z") / 1000],
      ["sunrise", Date.parse("2026-09-19T13:53Z") / 1000],
      ["sunset", Date.parse("2026-09-20T01:11Z") / 1000],
    ],
  );
  const polar = daylightRows({ daily: { time: ["2026-12-21"], sunrise: [null], sunset: ["2026-12-21T20:00"] } });
  assert.deepEqual(polar.map((row) => row.kind), ["sunset"]);
  assert.equal(rows[1].ts - rows[0].ts, 40800);
});

test("requests ask for UTC and the daily daylight fields", () => {
  const url = new URL(forecastUrl(37.34, -121.89));
  assert.equal(url.searchParams.get("timezone"), "UTC");
  assert.equal(url.searchParams.get("hourly"), "temperature_2m,weather_code,cloud_cover,precipitation,precipitation_probability,sunshine_duration");
  assert.equal(url.searchParams.get("daily"), "sunrise,sunset,daylight_duration");
  assert.equal(url.searchParams.get("past_days"), "1");
  assert.equal(new URL(airQualityUrl(37.34, -121.89)).searchParams.get("hourly"), "uv_index");
});

class FakeDb {
  batches: { sql: string; values: unknown[] }[][] = [];
  firstRow: unknown = null;

  prepare(sql: string) {
    const statement = {
      sql,
      values: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.values = values;
        return statement;
      },
      first: async () => this.firstRow,
      run: async () => ({ success: true }),
    };
    return statement;
  }

  async batch(input: { sql: string; values: unknown[] }[]) {
    this.batches.push(input);
    return input.map(() => ({ results: [] }));
  }
}

test("hour upserts keep nulls and overwrite the same valid hour", () => {
  const db = new FakeDb();
  const rows = forecastRows(forecastPayload());
  const statements = hourStatements(db as unknown as D1Database, "home-pvs", rows, SYNC_AT, daylightSpans(daylightRows(forecastPayload())));
  assert.equal(statements.length, 1);
  const sql = (statements[0] as unknown as { sql: string }).sql;
  const values = (statements[0] as unknown as { values: unknown[] }).values;
  assert.match(sql, /^INSERT INTO weather_hour \(collector_id, hour_ts, kind, temperature_c,/);
  assert.match(sql, /ON CONFLICT\(collector_id, hour_ts, kind\) DO UPDATE SET temperature_c = excluded\.temperature_c/);
  assert.ok(sql.includes("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),"));
  assert.equal(values.length, rows.length * 12);
  assert.equal(values[10], SYNC_AT);
  assert.equal(values[24 + 7], null); // third row, precipitation_probability
});

test("a night hour away from now and a finished hour are written once, not refreshed", () => {
  const spans = daylightSpans(daylightRows(forecastPayload()));
  const at = (instant: string) => Date.parse(instant) / 1000;
  // The hour in progress and the daylight hours still ahead keep updating...
  assert.equal(refreshesHour(at("2026-09-18T12:00:00Z"), SYNC_AT, spans), true);
  assert.equal(refreshesHour(at("2026-09-19T14:00:00Z"), SYNC_AT, spans), true);
  // ...but a finished hour is final, and a night hour two days out is context.
  assert.equal(refreshesHour(at("2026-09-17T12:00:00Z"), SYNC_AT, spans), false);
  assert.equal(refreshesHour(at("2026-09-20T03:00:00Z"), SYNC_AT, spans), false);

  const db = new FakeDb();
  const night = { ...forecastRows(forecastPayload())[0], hourTs: at("2026-09-20T03:00:00Z") };
  const daylight = { ...forecastRows(forecastPayload())[0], hourTs: at("2026-09-19T14:00:00Z") };
  const statements = hourStatements(db as unknown as D1Database, "home-pvs", [night, daylight], SYNC_AT, spans);
  assert.equal(statements.length, 2);
  const [refreshed, once] = statements as unknown as { sql: string }[];
  assert.match(refreshed.sql, /ON CONFLICT\(collector_id, hour_ts, kind\) DO UPDATE SET temperature_c = excluded\.temperature_c/);
  assert.match(once.sql, /ON CONFLICT DO NOTHING$/);
});

test("hour statements chunk so no statement exceeds the bound-parameter limit", () => {
  const db = new FakeDb();
  const many = Array.from({ length: 9 }, (_value, index) => ({
    ...forecastRows(forecastPayload())[0],
    hourTs: 1_700_000_000 + index * 3600,
  }));
  const statements = hourStatements(db as unknown as D1Database, "home-pvs", many, 1_700_000_000);
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.ok((statement as unknown as { values: unknown[] }).values.length <= 100);
  }
});

test("sunshine duration is retained by hour, including a missing value", () => {
  const db = new FakeDb();
  const rows = forecastRows(forecastPayload());
  const statements = sunshineStatements(db as unknown as D1Database, "home-pvs", rows, SYNC_AT, daylightSpans(daylightRows(forecastPayload())));
  assert.equal(statements.length, 1);
  const statement = statements[0] as unknown as { sql: string; values: unknown[] };
  assert.match(statement.sql, /^INSERT INTO weather_sunshine_hour \(collector_id, hour_ts, sunshine_seconds\)/);
  assert.match(statement.sql, /ON CONFLICT\(collector_id, hour_ts\) DO UPDATE SET sunshine_seconds = excluded\.sunshine_seconds$/);
  assert.deepEqual(statement.values.filter((_value, index) => index % 3 === 2), [1800, 3600, null]);
  const edge = forecastPayload();
  (edge.hourly as Record<string, unknown>).sunshine_duration = [0, 3601, null];
  assert.deepEqual(forecastRows(edge).map((row) => row.sunshineSeconds), [0, null, null]);
});

test("daylight rows replace the covered window instead of accumulating", () => {
  const db = new FakeDb();
  const statements = daylightStatements(
    db as unknown as D1Database,
    "home-pvs",
    daylightRows(forecastPayload()),
    1_700_000_000,
  );
  assert.equal(statements.length, 5);
  const clean = statements[0] as unknown as { sql: string; values: unknown[] };
  assert.match(clean.sql, /^DELETE FROM weather_hour WHERE collector_id = \? AND kind IN \('sunrise', 'sunset'\)/);
  assert.equal(clean.values[1], Date.parse("2026-09-18T13:52Z") / 1000 - 86400);
  const insert = statements[1] as unknown as { sql: string };
  assert.match(insert.sql, /^INSERT INTO weather_hour \(collector_id, hour_ts, kind, source, fetched_ts, quality\)/);
  assert.deepEqual(daylightStatements(db as unknown as D1Database, "home-pvs", [], 1), []);
});

test("storeWeather writes hours and daylight in one batch", async () => {
  const db = new FakeDb();
  const written = await storeWeather(
    db as unknown as D1Database,
    "home-pvs",
    forecastRows(forecastPayload()),
    daylightRows(forecastPayload()),
    1_700_000_000,
  );
  assert.equal(written, 10);
  assert.equal(db.batches.length, 1);
  assert.equal(await storeWeather(db as unknown as D1Database, "home-pvs", [], [], 1), 0);
});

test("syncWeather stops without a location and survives one provider failing", async () => {
  const missing = new FakeDb();
  let called = false;
  const noLocation = await syncWeather(missing as unknown as D1Database, "home-pvs", (async () => {
    called = true;
    throw new Error("should not fetch");
  }) as unknown as typeof fetch, SYNC_AT);
  assert.equal(noLocation.skipped, "no_location");
  assert.equal(called, false);

  const db = new FakeDb();
  db.firstRow = { latitude: 37.34, longitude: -121.89 };
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    urls.push(String(input));
    if (String(input).includes("air-quality")) throw new Error("provider down");
    return new Response(JSON.stringify(forecastPayload()), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await syncWeather(db as unknown as D1Database, "home-pvs", fetchImpl, SYNC_AT);
  assert.deepEqual(result.errors, ["air_quality"]);
  assert.equal(result.written, 10);
  assert.equal(urls.length, 2);
  const written = db.batches[0];
  // All three fixture hours are inside the next day of the sync, so each
  // hourly source stays in one refreshing upsert.
  assert.equal(written.length, 7); // hourly and sunshine upserts + four daylight rows + one cleanup delete
  assert.ok(written.every((statement) => !statement.sql.includes("air_quality")));
});

test("syncWeather reports a fully failed sync without writing", async () => {
  const db = new FakeDb();
  db.firstRow = { latitude: 37.34, longitude: -121.89 };
  const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const result = await syncWeather(db as unknown as D1Database, "home-pvs", failing, 1_700_000_000);
  assert.equal(result.skipped, "providers_failed");
  assert.deepEqual(result.errors, ["forecast", "air_quality"]);
  assert.equal(db.batches.length, 0);
});

test("the :17 scheduled event persists forecast, UV, and daylight", async () => {
  const db = new FakeDb();
  db.firstRow = { latitude: 37.34, longitude: -121.89 };
  const pending: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => new Response(JSON.stringify(
    String(input).includes("air-quality") ? airQualityPayload() : forecastPayload(),
  ));
  try {
    await ingest.scheduled({ cron: "17 * * * *" } as ScheduledController,
      { DB: db as unknown as D1Database, COLLECTOR_ID: "cron-check", UPLOAD_TOKEN: "test-token" },
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext);
    await Promise.all(pending);
    assert.equal(pending.length, 1);
    assert.equal(db.batches.length, 1);
    const values = db.batches[0].flatMap((statement) => statement.values);
    for (const kind of ["forecast", "air_quality", "sunrise", "sunset"]) assert.ok(values.includes(kind), kind);
    assert.ok(db.batches[0].every((statement) => statement.values.includes("cron-check")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
