import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_COOKIE } from "../src/constants.js";
import dashboard, { type Env } from "../src/index.js";
import {
  RESOLVE_LIMIT,
  allowResolve,
  censusPlaces,
  isValidCoordinate,
  isValidTimezone,
  parseLocationBody,
  parseResolveInput,
  readLocation,
  resolvePlaces,
  saveLocation,
  searchPlaces,
} from "../src/location.js";
import { signSession } from "../src/session.js";

const NOW = Math.floor(Date.parse("2026-09-18T20:00:00Z") / 1000);
const SECRET = "test-session-secret";

class ScriptedDb {
  statements: { sql: string; values: unknown[] }[] = [];
  batches: { sql: string }[][] = [];
  firstRow: Record<string, unknown> | null = null;

  prepare(sql: string) {
    const statement = {
      sql,
      values: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.values = values;
        return statement;
      },
      first: async () => this.firstRow,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
    this.statements.push(statement);
    return statement;
  }

  async batch(input: { sql: string }[]) {
    this.batches.push(input);
    return input.map(() => ({ success: true }));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("coordinates must be finite and inside the globe", () => {
  assert.equal(isValidCoordinate(37.34, -121.89), true);
  assert.equal(isValidCoordinate(-90, 180), true);
  assert.equal(isValidCoordinate(90.1, 0), false);
  assert.equal(isValidCoordinate(0, -180.1), false);
  assert.equal(isValidCoordinate(Number.NaN, 0), false);
  assert.equal(isValidCoordinate("37", "-121"), false);
  assert.equal(isValidCoordinate(null, undefined), false);
});

test("time zones are checked against the runtime zone table", () => {
  assert.equal(isValidTimezone("America/Los_Angeles"), true);
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("Etc/GMT+8"), true);
  assert.equal(isValidTimezone("Mars/Olympus"), false);
  assert.equal(isValidTimezone("not a zone"), false);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone("America/Los_Angeles; DROP TABLE"), false);
  assert.equal(isValidTimezone(`America/${"x".repeat(70)}`), false);
  assert.equal(isValidTimezone(7), false);
});

test("resolve input is trimmed, bounded, and rounded", () => {
  assert.deepEqual(parseResolveInput({ kind: "query", value: "  San Jose, CA " }).value, {
    kind: "query",
    value: "San Jose, CA",
  });
  assert.equal(parseResolveInput({ kind: "query", value: "   " }).error, "value");
  assert.equal(parseResolveInput({ kind: "query", value: "x".repeat(101) }).error, "value_too_long");
  assert.equal(parseResolveInput({ kind: "address", value: "x".repeat(201) }).error, "value_too_long");
  assert.equal(parseResolveInput({ kind: "address", value: "1 Infinite Loop, Cupertino, CA" }).ok, true);
  assert.equal(parseResolveInput({ kind: "postcode", value: "95128" }).error, "kind");
  assert.equal(parseResolveInput(null).error, "body");
  assert.equal(parseResolveInput({ kind: "coordinates", latitude: 91, longitude: 0 }).error, "invalid_coordinates");

  const manual = parseResolveInput({ kind: "coordinates", latitude: 37.33939, longitude: -121.89496 });
  assert.deepEqual(manual.value, { kind: "coordinates", latitude: 37.339, longitude: -121.895, source: "manual" });
  const browser = parseResolveInput({ kind: "coordinates", latitude: 37.3, longitude: -121.9, source: "browser_geolocation" });
  assert.equal((browser.value as { source: string }).source, "browser_geolocation");
});

test("a confirmed location body needs in-range coordinates, a real zone, and a known source", () => {
  const ok = parseLocationBody({ latitude: 37.33939, longitude: -121.89496, timezone: "America/Los_Angeles", source: "us_census" });
  assert.deepEqual(ok.value, {
    latitude: 37.339,
    longitude: -121.895,
    timezone: "America/Los_Angeles",
    source: "us_census",
  });
  assert.equal(parseLocationBody({ latitude: 37.3, longitude: -121.9, timezone: "Mars/Olympus", source: "manual" }).error, "invalid_timezone");
  assert.equal(parseLocationBody({ latitude: 500, longitude: -121.9, timezone: "UTC", source: "manual" }).error, "invalid_coordinates");
  assert.equal(parseLocationBody({ latitude: 37.3, longitude: -121.9, timezone: "UTC", source: "scraped" }).error, "source");
  assert.equal(parseLocationBody("nope").error, "body");
});

test("a city query returns candidates with coordinates and a zone", async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      results: [
        { name: "San Jose", admin1: "California", country: "United States", latitude: 37.33939, longitude: -121.89496, timezone: "America/Los_Angeles" },
        { name: "Broken", latitude: 999, longitude: 0, timezone: "America/Los_Angeles" },
      ],
    })) as unknown as typeof fetch;
  const places = await searchPlaces(fetchImpl, "San Jose");
  assert.deepEqual(places, [
    {
      label: "San Jose, California, United States",
      latitude: 37.339,
      longitude: -121.895,
      timezone: "America/Los_Angeles",
      source: "open_meteo_geocoding",
    },
  ]);
  assert.deepEqual(await searchPlaces((async () => jsonResponse({})) as unknown as typeof fetch, "nowhere"), []);
});

test("a US address falls back to the Census geocoder and then looks up its zone", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("census")) {
      return jsonResponse({
        result: { addressMatches: [{ matchedAddress: "1 INFINITE LOOP, CUPERTINO, CA, 95014", coordinates: { x: -122.03, y: 37.33 } }] },
      });
    }
    return jsonResponse({ timezone: "America/Los_Angeles" });
  }) as unknown as typeof fetch;
  const places = await censusPlaces(fetchImpl, "1 Infinite Loop, Cupertino, CA");
  assert.equal(places.length, 1);
  assert.equal(places[0].source, "us_census");
  assert.equal(places[0].timezone, "America/Los_Angeles");
  assert.match(calls[1], /timezone=auto/);
  assert.match(calls[0], /onelineaddress\?address=1%20Infinite%20Loop/);
});

test("manual coordinates resolve through the zone lookup", async () => {
  const result = await resolvePlaces(
    (async () => jsonResponse({ timezone: "America/Los_Angeles" })) as unknown as typeof fetch,
    { kind: "coordinates", latitude: 37.339, longitude: -121.895, source: "manual" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.[0].label, "37.339, -121.895");

  const failed = await resolvePlaces(
    (async () => jsonResponse({ error: "down" }, 500)) as unknown as typeof fetch,
    { kind: "query", value: "San Jose" },
  );
  assert.deepEqual(failed, { ok: false, error: "geocoder_unavailable" });
  const noZone = await resolvePlaces(
    (async () => jsonResponse({})) as unknown as typeof fetch,
    { kind: "coordinates", latitude: 0, longitude: 0, source: "manual" },
  );
  assert.equal(noZone.value?.[0].timezone, null);
});

test("the resolve counter stops a retry loop without blocking a fresh minute", () => {
  const key = `user-${Math.random()}`;
  for (let attempt = 0; attempt < RESOLVE_LIMIT; attempt += 1) {
    assert.equal(allowResolve(key, NOW), true, `attempt ${attempt}`);
  }
  assert.equal(allowResolve(key, NOW), false);
  assert.equal(allowResolve(key, NOW + 301), true);
});

test("stored locations are validated on read and upserted on write", async () => {
  const db = new ScriptedDb();
  db.firstRow = { latitude: 37.339, longitude: -121.895, timezone: "Mars/Olympus", source: "manual", updated_ts: NOW };
  assert.equal(await readLocation(db as unknown as D1Database, "home-pvs"), null);
  db.firstRow = { latitude: 37.339, longitude: -121.895, timezone: "America/Los_Angeles", source: "manual", updated_ts: NOW };
  assert.equal((await readLocation(db as unknown as D1Database, "home-pvs"))?.timezone, "America/Los_Angeles");

  const write = new ScriptedDb();
  await saveLocation(
    write as unknown as D1Database,
    "home-pvs",
    { latitude: 37.339, longitude: -121.895, timezone: "America/Los_Angeles", source: "us_census" },
    NOW,
  );
  assert.match(write.statements[0].sql, /^INSERT INTO site_location /);
  assert.match(write.statements[0].sql, /ON CONFLICT\(collector_id\) DO UPDATE SET latitude = excluded\.latitude/);
  assert.deepEqual(write.statements[0].values, ["home-pvs", 37.339, -121.895, "America/Los_Angeles", "us_census", NOW]);
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: new ScriptedDb() as unknown as D1Database,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: SECRET,
    ALLOWED_USER_IDS: "123456",
    COLLECTOR_ID: "home-pvs",
    ...overrides,
  };
}

async function cookie(): Promise<string> {
  const session = await signSession({ userId: "123456", expiresAt: Math.floor(Date.now() / 1000) + 600 }, SECRET);
  return `${SESSION_COOKIE}=${session}`;
}

test("location writes need a session and a same-origin request", async () => {
  const body = JSON.stringify({ latitude: 37.3, longitude: -121.9, timezone: "UTC", source: "manual" });
  const anonymous = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location", { method: "PUT", body }),
    env(),
  );
  assert.equal(anonymous.status, 401);

  const crossOrigin = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location", {
      method: "PUT",
      body,
      headers: { Cookie: await cookie(), Origin: "https://evil.example" },
    }),
    env(),
  );
  assert.equal(crossOrigin.status, 403);

  const db = new ScriptedDb();
  const saved = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location", {
      method: "PUT",
      body,
      headers: { Cookie: await cookie(), Origin: "https://solar.example" },
    }),
    env({ DB: db as unknown as D1Database }),
  );
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as Record<string, unknown>).configured, true);
  assert.match(db.statements[0].sql, /^INSERT INTO site_location /);

  const bad = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location", {
      method: "PUT",
      body: JSON.stringify({ latitude: 37.3, longitude: -121.9, timezone: "Mars/Olympus", source: "manual" }),
      headers: { Cookie: await cookie(), Origin: "https://solar.example" },
    }),
    env(),
  );
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as Record<string, unknown>).error, "invalid_timezone");
});

test("an unset location reads as unconfigured rather than a default city", async () => {
  const response = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location", { headers: { Cookie: await cookie() } }),
    env(),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.configured, false);
  assert.equal(payload.latitude, null);
});

test("resolve returns candidates without touching the database", async () => {
  const db = new ScriptedDb();
  let requested = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    requested = String(input);
    return jsonResponse({
      results: [{ name: "San Jose", admin1: "California", country: "United States", latitude: 37.33939, longitude: -121.89496, timezone: "America/Los_Angeles" }],
    });
  }) as unknown as typeof fetch;
  try {
    const response = await dashboard.fetch(
      new Request("https://solar.example/api/v1/location/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: "query", value: "San Jose" }),
        headers: { Cookie: await cookie(), Origin: "https://solar.example" },
      }),
      env({ DB: db as unknown as D1Database }),
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { candidates: { timezone: string }[] };
    assert.equal(payload.candidates[0].timezone, "America/Los_Angeles");
    assert.match(requested, /geocoding-api\.open-meteo\.com/);
    assert.equal(db.statements.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a confirmed location fetches weather once instead of waiting for the cron", async () => {
  const db = new ScriptedDb();
  // The sync reads the stored location back before it calls the providers.
  db.firstRow = { latitude: 37.3, longitude: -121.9 };
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("air-quality-api")) {
      return jsonResponse({ hourly: { time: ["2026-09-18T20:00"], uv_index: [4.1] } });
    }
    return jsonResponse({
      hourly: {
        time: ["2026-09-18T20:00"],
        temperature_2m: [21.5],
        weather_code: [0],
        cloud_cover: [4],
        precipitation: [0],
        precipitation_probability: [0],
      },
      daily: { time: ["2026-09-18"], sunrise: ["2026-09-18T13:52"], sunset: ["2026-09-19T01:12"] },
    });
  }) as unknown as typeof fetch;
  const pending: Promise<unknown>[] = [];
  try {
    const response = await dashboard.fetch(
      new Request("https://solar.example/api/v1/location", {
        method: "PUT",
        body: JSON.stringify({ latitude: 37.3, longitude: -121.9, timezone: "America/Los_Angeles", source: "manual" }),
        headers: { Cookie: await cookie(), Origin: "https://solar.example" },
      }),
      env({ DB: db as unknown as D1Database }),
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    );
    assert.equal(response.status, 200);
    await Promise.all(pending);
    assert.equal(pending.length, 1, "saving a location schedules exactly one sync");
    assert.match(requested.join(" "), /api\.open-meteo\.com/);
    assert.match(requested.join(" "), /air-quality-api\.open-meteo\.com/);
    const weatherWrites = db.batches.flat().filter((statement) => /INSERT INTO weather_hour/.test(statement.sql));
    assert.ok(weatherWrites.length > 0, "the sync must store forecast and daylight rows");
  } finally {
    globalThis.fetch = original;
  }
});

test("an oversized or malformed resolve body is refused", async () => {
  const headers = { Cookie: await cookie(), Origin: "https://solar.example" };
  const oversized = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location/resolve", { method: "POST", body: JSON.stringify({ kind: "query", value: "x".repeat(500) }), headers }),
    env(),
  );
  assert.equal(oversized.status, 400);
  assert.equal(((await oversized.json()) as Record<string, unknown>).error, "value_too_long");

  const malformed = await dashboard.fetch(
    new Request("https://solar.example/api/v1/location/resolve", { method: "POST", body: "{", headers }),
    env(),
  );
  assert.equal(malformed.status, 400);
});
