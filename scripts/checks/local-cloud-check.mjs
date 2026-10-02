/**
 * Opt-in end-to-end check of the dashboard read APIs against real local D1.
 *
 *   npm run check:local
 *
 * Applies the schema, inserts synthetic fixtures, starts `wrangler dev`, then
 * asserts history weighting, panel reads, health, range limits, and the login
 * gate. It never touches a remote account and writes only to a temp directory.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signSession } from "../../workers/dist/dashboard/src/session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.CHECK_PORT ?? 8791);
const sessionSecret = "local-check-session-secret";
const collector = "check-pvs";
const state = mkdtempSync(join(tmpdir(), "spm-local-"));
const fixtures = mkdtempSync(join(tmpdir(), "spm-fixtures-"));
const base = Math.floor(Date.now() / 1000 / 300) * 300 - 900;
const failures = [];
let server;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
}

function wrangler(cwd, args) {
  const result = spawnSync("npx", ["wrangler", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`wrangler ${args[0]} failed`);
  }
  return result.stdout;
}

function sql(value) {
  return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
}

function minuteRow(minute, pv, load, grid, count, quality = "ok", measured = minute + 50) {
  const counts = JSON.stringify({ pv_kw: count, load_kw_reported: count, grid_kw: count, battery_kw: 0 });
  const nulls = quality === "ok" ? "" : "";
  return (
    "INSERT OR REPLACE INTO site_minute (collector_id, minute_ts, window_end_ts, sample_count, valid_count, complete," +
    " quality, pv_kw_avg, load_kw_reported_avg, grid_kw_avg, battery_kw_avg, valid_counts_json, pv_kwh_total_end," +
    " load_kwh_total_reported_end, grid_net_kwh_total_end, last_measured_ts, digest, received_ts) VALUES (" +
    `${sql(collector)}, ${minute}, ${minute + 60}, ${count}, ${count}, ${quality === "ok" ? 1 : 0}, ${sql(quality)}, ` +
    `${pv ?? "NULL"}, ${load ?? "NULL"}, ${grid ?? "NULL"}, NULL, ${sql(counts)}, 12345.6, 67890.1, -4321.0, ${
      quality === "ok" ? measured : "NULL"
    }, ${sql(`digest-${minute}-${quality}`)}, ${Math.floor(Date.now() / 1000)})${nulls};`
  );
}

function panelRow(panel, slot, ac, measured, quality = "ok", energy = ac === null ? null : 500) {
  return (
    "INSERT OR REPLACE INTO panel_sample (collector_id, panel_id, slot_ts, ac_kw, energy_kwh_total, measured_ts, quality," +
    " digest, received_ts) VALUES (" +
    `${sql(collector)}, ${sql(panel)}, ${slot}, ${ac ?? "NULL"}, ${energy ?? "NULL"}, ${
      quality === "ok" ? measured ?? slot : "NULL"
    }, ${sql(quality)}, ${sql(`digest-${panel}-${slot}`)}, ${Math.floor(Date.now() / 1000)});`
  );
}

const WEATHER_COLUMNS =
  "(collector_id, hour_ts, kind, temperature_c, weather_code, cloud_cover_pct, precipitation_mm," +
  " precipitation_probability_pct, uv_index, source, fetched_ts, quality)";
const WEATHER_UPDATE =
  " ON CONFLICT(collector_id, hour_ts, kind) DO UPDATE SET temperature_c = excluded.temperature_c," +
  " weather_code = excluded.weather_code, cloud_cover_pct = excluded.cloud_cover_pct," +
  " precipitation_mm = excluded.precipitation_mm, precipitation_probability_pct = excluded.precipitation_probability_pct," +
  " uv_index = excluded.uv_index, source = excluded.source, fetched_ts = excluded.fetched_ts, quality = excluded.quality;";

function weatherRow(ts, kind, temp, code, cloud, precip, pop, uv, quality) {
  const source = kind === "air_quality" ? "open-meteo-air-quality" : "open-meteo-forecast";
  const value = (item) => (item === null ? "NULL" : item);
  return (
    `(${sql(collector)}, ${ts}, ${sql(kind)}, ${value(temp)}, ${value(code)}, ${value(cloud)}, ${value(precip)},` +
    ` ${value(pop)}, ${value(uv)}, ${sql(source)}, ${now}, ${sql(quality)})`
  );
}

const now = Math.floor(Date.now() / 1000);
const weatherBase = Math.floor(now / 300) * 300 - 900;
const weatherFetched = now - 120;
const noon = Math.floor(now / 86400) * 86400 + 12 * 3600;
const schema = join(fixtures, "schema.sql");
const seed = join(fixtures, "seed.sql");

writeFileSync(
  seed,
  [
    minuteRow(base + 60, 2.0, 1.0, -1.0, 2),
    minuteRow(base + 120, 6.0, 3.0, -3.0, 6),
    minuteRow(base + 360, null, null, null, 0, "source_error"),
    panelRow("p01", base, 0.4, base + 10),
    panelRow("p02", base, 0.3, base + 10),
    // The counter moved 5 kWh between the two stored slots.
    panelRow("p01", base + 300, 0.5, base + 310, "ok", 505),
    panelRow("p02", base + 300, null, null, "stale_source"),
    // Known from the older slot only: it must stay on the page as not reporting.
    panelRow("p03", base, 0.2, base + 10),
    // The ingest keeps this inventory from every panel sample; this check seeds
    // D1 directly, so it writes the rows the ingest would.
    "INSERT OR REPLACE INTO panel_known (collector_id, panel_id, last_seen_ts) VALUES " +
      [
        `(${sql(collector)}, 'p01', ${base + 300})`,
        `(${sql(collector)}, 'p02', ${base + 300})`,
        `(${sql(collector)}, 'p03', ${base})`,
      ].join(", ") +
      ";",
    "INSERT OR REPLACE INTO collector_event (event_id, collector_id, event_ts, event_type, details_code, digest, received_ts)" +
      ` VALUES ('evt-1', ${sql(collector)}, ${base + 240}, 'pvs_request_failed', 'inverters', 'digest-evt-1', ${now});`,
    "INSERT OR REPLACE INTO latest_site (collector_id, collected_ts, measured_ts, received_ts, quality, pv_kw," +
      " load_kw_reported, grid_kw, battery_kw, pv_kwh_total, load_kwh_total_reported, grid_net_kwh_total) VALUES (" +
      `${sql(collector)}, ${now}, ${now - 2}, ${now}, 'ok', 3.2, 1.4, -1.8, NULL, 12345.6, 67890.1, -4321.0);`,
    "INSERT OR REPLACE INTO site_location (collector_id, latitude, longitude, timezone, source, updated_ts) VALUES (" +
      `${sql(collector)}, 37.339, -121.895, 'America/Los_Angeles', 'us_census', ${now});`,
    // The daily view is stored by the ingest cron. Seed a spring DST day to
    // verify that the dashboard reads its actual 23-hour span from D1.
    "INSERT INTO site_day (collector_id, local_date, timezone, start_ts, end_ts, windows, ok_windows," +
      " source_error_windows, sample_count, valid_count, pv_kw_avg, load_kw_reported_avg, grid_kw_avg, updated_ts)" +
      ` VALUES (${sql(collector)}, '2026-03-08', 'America/Los_Angeles', 1772956800, 1773039600,` +
      ` 1380, 1379, 1, 8274, 8274, 2.0, 1.0, -1.0, ${now});`,
    // Two hours and one UV hour in one multi-row upsert, plus a row outside the
    // range that must not leak into the response.
    `INSERT INTO weather_hour ${WEATHER_COLUMNS} VALUES ` +
      [
        weatherRow(weatherBase, "forecast", 21.5, 0, 4, 0, 5, null, "ok"),
        weatherRow(weatherBase + 3600, "forecast", 22.4, 2, 30, 0, null, null, "partial"),
        weatherRow(weatherBase, "air_quality", null, null, null, null, null, 4.1, "ok"),
        weatherRow(weatherBase + 86400, "forecast", 99.9, 0, 0, 0, 0, null, "ok"),
      ].join(", ") +
      WEATHER_UPDATE,
    // The same valid hour written again must overwrite, not duplicate.
    `INSERT INTO weather_hour ${WEATHER_COLUMNS} VALUES ` +
      weatherRow(weatherBase, "forecast", 20.1, 3, 90, 1.5, 60, null, "ok") +
      WEATHER_UPDATE,
    "INSERT INTO weather_sunshine_hour (collector_id, hour_ts, sunshine_seconds) VALUES " +
      `(${sql(collector)}, ${weatherBase}, 1800), (${sql(collector)}, ${weatherBase + 3600}, NULL);`,
    // Three local-day pairs of sunrise/sunset, seven hours apart, so the range
    // always contains one complete local day whatever the test runs at.
    `INSERT INTO weather_hour (collector_id, hour_ts, kind, source, fetched_ts, quality) VALUES ` +
      [-86400, 0, 86400]
        .flatMap((offset) => [
          `(${sql(collector)}, ${noon + offset + 3600}, 'sunrise', 'open-meteo-forecast', ${weatherFetched}, 'ok')`,
          `(${sql(collector)}, ${noon + offset + 8 * 3600}, 'sunset', 'open-meteo-forecast', ${weatherFetched}, 'ok')`,
        ])
        .join(", ") +
      ";",
  ].join("\n"),
);

// Copy the schema out of the repository for wrangler's --file argument.
writeFileSync(schema, spawnSync("cat", [join(root, "workers/schema.sql")], { encoding: "utf8" }).stdout);

wrangler(join(root, "workers/ingest"), ["d1", "execute", "DB", "--local", "--persist-to", state, "--file", schema]);
wrangler(join(root, "workers/ingest"), ["d1", "execute", "DB", "--local", "--persist-to", state, "--file", seed]);

server = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    state,
    "--var",
    `SESSION_SECRET:${sessionSecret}`,
    "--var",
    "GITHUB_CLIENT_ID:local",
    "--var",
    "GITHUB_CLIENT_SECRET:local",
    "--var",
    "ALLOWED_USER_IDS:123456",
    "--var",
    `COLLECTOR_ID:${collector}`,
  ],
  { cwd: join(root, "workers/dashboard"), stdio: ["ignore", "pipe", "pipe"] },
);

const log = [];
server.stdout.on("data", (chunk) => log.push(String(chunk)));
server.stderr.on("data", (chunk) => log.push(String(chunk)));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (log.join("").includes(`http://127.0.0.1:${port}`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  if (!(await waitForServer())) throw new Error(`dev server did not start:\n${log.join("")}`);
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `spm_session=${await signSession(
    { userId: "123456", expiresAt: Math.floor(Date.now() / 1000) + 600 },
    sessionSecret,
  )}`;
  const get = async (path, authenticated = true) => {
    const response = await fetch(`${origin}${path}`, {
      headers: authenticated ? { Cookie: cookie, Accept: "application/json" } : { Accept: "application/json" },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const from = new Date((base - 60) * 1000).toISOString();
  const to = new Date((base + 900) * 1000).toISOString();
  const span = `from=${from}&to=${to}`;

  const anonymous = await get(`/api/v1/history?${span}`, false);
  check("anonymous history is refused", anonymous.status === 401, `status ${anonymous.status}`);

  const minutes = await get(`/api/v1/history?${span}&resolution=1m`);
  check("minute history returns every stored window", minutes.body?.windows.length === 3, JSON.stringify(minutes.body?.summary));
  check("source_error window keeps null power", minutes.body?.windows[2].pv_kw_avg === null);
  check("summary counts the read failure", minutes.body?.summary.source_error === 1, JSON.stringify(minutes.body?.summary));

  const fives = await get(`/api/v1/history?${span}&resolution=5m`);
  const weighted = fives.body?.windows[0];
  check("five-minute power is weighted by valid sample counts", weighted?.pv_kw_avg === 5, `got ${weighted?.pv_kw_avg}`);
  check("missing minutes keep a five-minute slot partial", weighted?.complete === false);
  check("a slot with a failed minute is partial", fives.body?.windows[1].quality === "partial");
  check("partial slot reports its failed minute", fives.body?.windows[1].source_error_windows === 1);

  const daily = await get("/api/v1/history?from=2026-03-08T08:00:00Z&to=2026-03-09T07:00:00Z&resolution=1d");
  check("daily history returns the site-local DST day", daily.body?.timezone === "America/Los_Angeles" &&
    daily.body?.windows.length === 1 && daily.body.windows[0].local_date === "2026-03-08" &&
    daily.body.windows[0].duration_seconds === 23 * 3600, JSON.stringify(daily.body?.windows));
  check("daily history retains failed minutes", daily.body?.summary.source_error === 1 &&
    daily.body?.windows[0].quality === "partial");
  const year = await get("/api/v1/history?from=2025-09-22T00:00:00Z&to=2026-09-22T00:00:00Z&resolution=1d");
  check("a one-year query returns stored daily granularity", year.body?.resolution === "1d" &&
    year.body?.windows.length === 1 && year.body?.truncated === false);

  const matrix = await get("/api/v1/panels");
  check("panel matrix reads the latest slot", matrix.body?.slot_ts === new Date((base + 300) * 1000).toISOString().replace(".000Z", "Z"));
  check("panel matrix keeps a stale panel distinguishable", matrix.body?.panels[1].quality === "stale_source" && matrix.body.panels[1].ac_kw === null);
  check(
    "panel matrix lists a known panel with no row in the latest slot",
    matrix.body?.panels.length === 3 && matrix.body?.panels[2].panel_id === "p03" &&
      matrix.body?.panels[2].quality === null && matrix.body?.panels[2].measured_at_utc === null,
    JSON.stringify(matrix.body?.panels),
  );
  check("panel matrix without a window carries no day total", matrix.body?.energy_from_utc === null && matrix.body?.panels[0].energy_kwh === undefined);

  const dayFrom = new Date((base - 600) * 1000).toISOString();
  const dayTo = new Date((base + 900) * 1000).toISOString();
  const day = await get(`/api/v1/panels?energy_from=${dayFrom}&energy_to=${dayTo}`);
  check(
    "panel day energy is the stored counter delta",
    day.body?.energy_from_utc === dayFrom.replace(".000Z", "Z") && day.body?.panels[0].energy_kwh === 5 &&
      day.body?.energy_coverage_from_utc === new Date(base * 1000).toISOString().replace(".000Z", "Z") &&
      day.body?.panels[0].energy_first_slot_utc === new Date(base * 1000).toISOString().replace(".000Z", "Z") &&
      day.body?.panels[0].energy_last_slot_utc === new Date((base + 300) * 1000).toISOString().replace(".000Z", "Z"),
    JSON.stringify(day.body?.panels),
  );
  check("one stored counter is not a day total", day.body?.panels[1].energy_kwh === null && day.body?.panels[2].energy_kwh === null);
  check("an energy window needs both ends", (await get(`/api/v1/panels?energy_from=${dayFrom}`)).status === 400);
  check("an energy window stays inside a day", (await get(`/api/v1/panels?energy_from=${dayFrom}&energy_to=${new Date((base + 40 * 3600) * 1000).toISOString()}`)).status === 400);

  const history = await get(`/api/v1/panels?panel_id=p01&${span}`);
  check("panel history returns the selected panel only", history.body?.samples.length === 2, JSON.stringify(history.body?.samples));
  check("panel history carries AC power", history.body?.samples[1].ac_kw === 0.5);

  const arrayHistory = await get(`/api/v1/panels?history=all&${span}`);
  check("array history returns every panel in one request", arrayHistory.body?.panels.length === 3 &&
    arrayHistory.body?.panels.find((panel) => panel.panel_id === "p01")?.samples.length === 2,
  JSON.stringify(arrayHistory.body));
  check("array history keeps unavailable power null", arrayHistory.body?.panels.find((panel) => panel.panel_id === "p02")?.samples[1]?.ac_kw === null);
  check("array history is limited to one day", (await get(`/api/v1/panels?history=all&from=${dayFrom}&to=${new Date((base + 40 * 3600) * 1000).toISOString()}`)).status === 400);

  const health = await get("/api/v1/health");
  check("health reports a collecting collector", health.body?.state === "collecting", JSON.stringify(health.body));
  check("health counts known panels", health.body?.known_panels === 3);
  check("health lists the read failure event", health.body?.events[0].event_type === "pvs_request_failed");
  check("health never invents a queue backlog", health.body?.queue_backlog === null);

  const live = await get("/api/v1/live");
  check("live view reports direction and freshness", live.body?.state === "live" && live.body?.export_kw === 1.8, JSON.stringify(live.body));

  const send = async (method, path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const weather = await get(`/api/v1/weather?${span}`);
  const hours = weather.body?.hours ?? [];
  check(
    "weather reports the confirmed location and its zone",
    weather.body?.configured === true && weather.body?.location.timezone === "America/Los_Angeles",
    JSON.stringify(weather.body?.location),
  );
  check(
    "weather merges forecast and UV by valid hour",
    hours.length === 2 && hours[0].uv_index === 4.1 && hours[0].uv_source === "open-meteo-air-quality",
    JSON.stringify(hours),
  );
  check(
    "a newer forecast overwrites the same valid hour",
    hours[0].temperature_c === 20.1 && hours[0].quality === "ok" && hours[0].source === "open-meteo-forecast",
    JSON.stringify(hours[0]),
  );
  check(
    "a missing rain probability stays null and marks the hour partial",
    hours[1].precipitation_probability_pct === null && hours[1].uv_index === null && hours[1].quality === "partial",
    JSON.stringify(hours[1]),
  );
  check("weather retains modeled sunshine duration by hour", hours[0].sunshine_duration_seconds === 1800 && hours[1].sunshine_duration_seconds === null);
  check("weather outside the range is not returned", hours.every((hour) => hour.temperature_c !== 99.9));
  const days = weather.body?.days ?? [];
  check("weather totals modeled sunshine by local day", days.some((day) => day.sunshine_duration_seconds === 1800));
  check(
    "sunrise and sunset group into one local day with a daylight span",
    days.some((day) => day.daylight_seconds === 25200),
    JSON.stringify(days),
  );
  check("fresh weather is not labelled stale", weather.body?.stale === false);

  const location = await get("/api/v1/location");
  check("the stored location reads back", location.body?.configured === true && location.body?.latitude === 37.339);

  const badZone = await send("PUT", "/api/v1/location", { latitude: 37.3, longitude: -121.9, timezone: "Mars/Olympus", source: "manual" });
  check("a made-up time zone is refused", badZone.status === 400 && badZone.body?.error === "invalid_timezone");
  const badCoords = await send("PUT", "/api/v1/location", { latitude: 120, longitude: -121.9, timezone: "UTC", source: "manual" });
  check("out-of-range coordinates are refused", badCoords.status === 400 && badCoords.body?.error === "invalid_coordinates");
  const saved = await send("PUT", "/api/v1/location", { latitude: 37.331, longitude: -121.9, timezone: "America/Los_Angeles", source: "manual" });
  check("a confirmed location is saved", saved.status === 200 && saved.body?.latitude === 37.331, JSON.stringify(saved.body));
  const reread = await get("/api/v1/location");
  check("the saved location replaces the previous one", reread.body?.latitude === 37.331 && reread.body?.source === "manual");

  const anonymousWeather = await get(`/api/v1/weather?${span}`, false);
  check("anonymous weather is refused", anonymousWeather.status === 401);
  const longWeather = await get(
    `/api/v1/weather?from=${new Date((base - 40 * 86400) * 1000).toISOString()}&to=${to}`,
  );
  check("an over-long weather range is refused", longWeather.status === 400 && longWeather.body?.error === "range_too_long");

  const longRange = await get(
    `/api/v1/history?from=${new Date((base - 40 * 86400) * 1000).toISOString()}&to=${to}&resolution=5m`,
  );
  check("an over-long range is refused instead of scanned", longRange.status === 400 && longRange.body?.error === "range_too_long");

  const badPanel = await get(`/api/v1/panels?panel_id=inverter-1&${span}`);
  check("panel ids outside the anonymous format are refused", badPanel.status === 400);

  const page = await fetch(`${origin}/history.html`, { headers: { Cookie: cookie, Accept: "text/html" } });
  const body = await page.text();
  check("the history page is served behind the login gate", page.status === 200 && body.includes('id="chart"'));
  const anonymousPage = await fetch(`${origin}/history.html`, { headers: { Accept: "text/html" }, redirect: "manual" });
  check("the history page cannot be read anonymously", anonymousPage.status === 302);
}

try {
  await main();
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  server?.kill("SIGTERM");
  console.log(failures.length === 0 ? "\nlocal cloud checks passed" : `\n${failures.length} local cloud check(s) failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}
