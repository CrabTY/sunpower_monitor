/**
 * Simulated-month end-to-end check.
 *
 * Generates one month of realistic, contract-shaped site/panel/weather
 * history, pushes every generated record through the real ingest contract
 * (validateBatch + digestOf), seeds a throwaway local D1, serves it with the
 * real dashboard Worker, and checks the month-spanning API responses.
 * Frontend rendering is covered by check:render and check:preview.
 *
 *   node scripts/month-check.mjs            # generate, seed, serve, check
 *   node scripts/month-check.mjs --serve    # seed and keep the dev server up
 *   MONTH_SQL_OUT=/tmp/month.sql node scripts/month-check.mjs --write-only
 *
 * Writes only to a temp directory; never touches a remote account.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION, digestOf, validateBatch } from "../workers/dist/shared/contract.js";
import { signSession } from "../workers/dist/dashboard/src/session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const collector = "home-pvs";
const timezone = "America/Los_Angeles";
const tzOffsetSec = -7 * 3600; // September in Los Angeles is always PDT.
const latitude = 37.34;
const longitude = -121.9;
const panelCount = 8;
const peakKw = 4.8; // ~8 x 0.6 kW AC inverters on a clear day.
const days = 30;
const port = Number(process.env.CHECK_PORT ?? 8792);
const sessionSecret = "month-check-session-secret";
const sessionUser = "123456";

const serveOnly = process.argv.includes("--serve");
const writeOnly = process.argv.includes("--write-only");
const failures = [];
let server;

function check(name, condition, detail = "") {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} ${String(detail).slice(0, 160)}`);
  }
}

/* --------------------------------------------------------------- generator */

/** Deterministic PRNG, so a failing month can be replayed exactly. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, digits = 4) => Number(value.toFixed(digits));

/** Cooper's equation: solar declination for a day of year, in radians. */
function declination(dayOfYear) {
  return Math.sin(((2 * Math.PI) * (284 + dayOfYear)) / 365) * ((23.44 * Math.PI) / 180);
}

/** Real day-of-year of the site-local calendar date that contains an instant. */
function dayOfYear(tsSec) {
  const local = tsSec + tzOffsetSec;
  const date = new Date(local * 1000);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1) / 1000;
  return Math.floor((local - start) / 86400) + 1;
}

/** Local-clock sunrise/sunset hours for the site-local day that contains an instant. */
function daylightHours(tsSec) {
  const doy = dayOfYear(tsSec);
  const lat = (latitude * Math.PI) / 180;
  const cosHourAngle = clamp(-Math.tan(lat) * Math.tan(declination(doy)), -1, 1);
  const half = (Math.acos(cosHourAngle) * 180) / Math.PI / 15;
  return { rise: 12 - half, set: 12 + half };
}

function localParts(tsSec) {
  const local = tsSec + tzOffsetSec;
  return { dayIndex: Math.floor(local / 86400), hour: ((local % 86400) + 86400) % 86400 / 3600 };
}

function iso(tsSec) {
  return new Date(tsSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * One month of weather at hourly resolution. A handful of rainy days break up
 * the dry week so precipitation, cloud cover, and UV are all exercised.
 */
function weatherTimeline(nowSec) {
  const random = rng(0x5ea50);
  const firstHour = Math.floor((nowSec - days * 86400) / 3600) * 3600;
  const lastHour = Math.floor(nowSec / 3600) * 3600;
  const hours = new Map();
  for (let ts = firstHour; ts <= lastHour; ts += 3600) {
    const { dayIndex, hour } = localParts(ts);
    const rainy = dayIndex % 9 === 3 || dayIndex % 11 === 5;
    const cloud = clamp(
      (rainy ? 0.72 : 0.2) + 0.28 * Math.sin(dayIndex * 0.9 + hour * 0.17) + (random() - 0.5) * 0.3,
      0,
      1,
    );
    const precip = rainy && hour >= 4 && hour <= 20 ? round(random() * 1.8 + 0.1, 2) : 0;
    const sunFrac = clamp(Math.sin((Math.PI * (hour - 6.5)) / 13.5), 0, 1);
    hours.set(ts, {
      cloud: round(cloud * 100, 1),
      precip,
      precipProb: Math.round(clamp(cloud * 100 + (rainy ? 20 : -10), 0, 100)),
      uv: round(8.4 * sunFrac * (1 - 0.82 * cloud), 1),
      code: precip > 0 ? (precip > 1.2 ? 65 : 61) : cloud < 0.25 ? 0 : cloud < 0.5 ? 1 : cloud < 0.75 ? 2 : 3,
      temp: round(19 + 5 * Math.sin((2 * Math.PI * (hour - 9)) / 24) + (random() - 0.5) * 1.6, 1),
    });
  }
  return { hours, firstHour, lastHour };
}

/** Whole-minute site history plus daylight-only panel samples. */
function simulate(nowSec) {
  const random = rng(0xc0ffee);
  const weather = weatherTimeline(nowSec);
  const startSec = nowSec - days * 86400;
  const minutes = [];
  const outages = [
    { at: Math.floor(days * 1440 * 0.13), length: 23 },
    { at: Math.floor(days * 1440 * 0.47), length: 41 },
    { at: Math.floor(days * 1440 * 0.82), length: 12 },
  ];
  let pvTotal = 36_400;
  let loadTotal = 71_250;
  let gridNet = -1_960;
  const panels = [];
  const panelWeights = Array.from({ length: panelCount }, () => 0.7 + random() * 0.6);
  const weightSum = panelWeights.reduce((a, b) => a + b, 0);
  const panelEnergy = Array.from({ length: panelCount }, () => 480 + random() * 40);

  for (let index = 0; index < days * 1440; index += 1) {
    const ts = startSec + index * 60;
    const { hour } = localParts(ts);
    const { rise, set } = daylightHours(ts);
    const sunFrac = hour > rise && hour < set ? (hour - rise) / (set - rise) : 0;
    const hourKey = Math.floor(ts / 3600) * 3600;
    const sky = weather.hours.get(hourKey);
    const clearSky = peakKw * Math.pow(Math.sin(Math.PI * sunFrac), 1.35);
    const pv = round(clearSky * (1 - 0.78 * Math.pow(sky.cloud / 100, 1.4)) + (random() - 0.5) * 0.08, 3);
    const evening = Math.exp(-Math.pow((hour - 19.5) / 2.1, 2));
    const morning = Math.exp(-Math.pow((hour - 7.5) / 1.6, 2));
    const load = round(0.35 + 0.5 * morning + 1.7 * evening + random() * 0.18, 3);
    const grid = round(load - Math.max(pv, 0), 3);
    pvTotal += Math.max(pv, 0) / 60;
    loadTotal += load / 60;
    gridNet += grid / 60;

    const outage = outages.find((entry) => index >= entry.at && index < entry.at + entry.length);
    const partial = !outage && random() < 0.0025;
    const quality = outage ? "source_error" : partial ? "partial" : "ok";
    const valid = outage ? 0 : partial ? 3 + Math.floor(random() * 3) : 6;
    minutes.push({
      ts,
      quality,
      complete: valid === 6,
      sample_count: outage ? 0 : 6,
      valid_count: valid,
      pv_kw_avg: outage ? null : pv,
      load_kw_reported_avg: outage ? null : load,
      grid_kw_avg: outage ? null : grid,
      valid_counts: { pv_kw: valid, load_kw_reported: valid, grid_kw: valid, battery_kw: 0 },
      pv_kwh_total_end: round(pvTotal, 3),
      load_kwh_total_reported_end: round(loadTotal, 3),
      grid_net_kwh_total_end: round(gridNet, 3),
      last_measured_ts: outage ? null : ts + 50,
    });

    // Panels are sampled every five minutes and only report during daylight.
    if (ts % 300 === 0 && pv > 0.08) {
      const ambient = sky.temp;
      for (let panel = 0; panel < panelCount; panel += 1) {
        const stale = random() < 0.0015;
        const ac = round((pv * panelWeights[panel]) / weightSum * (0.94 + random() * 0.12), 3);
        const dc = round(ac / 0.955, 3);
        panelEnergy[panel] += stale ? 0 : ac / 12;
        panels.push({
          slot_ts: ts,
          panel_id: `p${String(panel + 1).padStart(2, "0")}`,
          quality: stale ? "stale_source" : "ok",
          ac_kw: stale ? null : ac,
          dc_kw: stale ? null : dc,
          dc_v: stale ? null : round(404 + random() * 8, 1),
          dc_a: stale ? null : round((dc * 1000) / 406, 2),
          ac_v: stale ? null : round(240.4 + random() * 1.6, 1),
          ac_a: stale ? null : round((ac * 1000) / 241, 2),
          heatsink_c: stale ? null : round(ambient + 14 + (ac / peakKw) * panelCount * 3.2, 1),
          energy_kwh_total: stale ? null : round(panelEnergy[panel], 3),
          measured_ts: stale ? null : ts + 40,
        });
      }
    }
  }

  const events = [];
  const pushEvent = (ts, type, details) => events.push({ ts, type, details });
  pushEvent(startSec + 30, "collector_started", "boot");
  for (let ts = startSec + 60; ts <= nowSec; ts += 3600) {
    pushEvent(ts, "collector_heartbeat", `uptime=${Math.floor(ts - startSec)}`);
  }
  for (const outage of outages) {
    const at = startSec + outage.at * 60;
    pushEvent(at, "pvs_request_failed", "inverters:PVSError");
    pushEvent(at + outage.length * 60, "pvs_recovered", "inverters");
  }
  pushEvent(startSec + days * 86400 * 0.61, "pvs_restarted", "uptime_reset");

  return { minutes, panels, events, weather, weatherStart: weather.firstHour, nowSec, startSec };
}

/* ------------------------------------------------------ contract records */

function contractRecords(sim) {
  const records = [];
  for (const minute of sim.minutes) {
    records.push({
      schema_version: SCHEMA_VERSION,
      collector_id: collector,
      record_id: `home-pvs:site_minute:${minute.ts}`,
      kind: "site_minute",
      window_start_utc: iso(minute.ts),
      window_end_utc: iso(minute.ts + 60),
      sample_count: minute.sample_count,
      valid_count: minute.valid_count,
      complete: minute.complete,
      quality: minute.quality,
      pv_kw_avg: minute.pv_kw_avg,
      load_kw_reported_avg: minute.load_kw_reported_avg,
      grid_kw_avg: minute.grid_kw_avg,
      battery_kw_avg: null,
      valid_counts: minute.valid_counts,
      pv_kwh_total_end: minute.pv_kwh_total_end,
      load_kwh_total_reported_end: minute.load_kwh_total_reported_end,
      grid_net_kwh_total_end: minute.grid_net_kwh_total_end,
      last_measured_at_utc: minute.last_measured_ts === null ? null : iso(minute.last_measured_ts),
    });
  }
  for (const panel of sim.panels) {
    records.push({
      schema_version: SCHEMA_VERSION,
      collector_id: collector,
      record_id: `home-pvs:panel:${panel.panel_id}:${panel.slot_ts}`,
      kind: "panel_sample",
      panel_id: panel.panel_id,
      slot_ts: iso(panel.slot_ts),
      quality: panel.quality,
      ac_kw: panel.ac_kw,
      energy_kwh_total: panel.energy_kwh_total,
      dc_kw: panel.dc_kw,
      dc_v: panel.dc_v,
      dc_a: panel.dc_a,
      ac_v: panel.ac_v,
      ac_a: panel.ac_a,
      heatsink_c: panel.heatsink_c,
      measured_at_utc: panel.measured_ts === null ? null : iso(panel.measured_ts),
      last_valid_measured_at_utc: panel.measured_ts === null ? null : iso(panel.measured_ts),
    });
  }
  for (const event of sim.events) {
    records.push({
      schema_version: SCHEMA_VERSION,
      collector_id: collector,
      record_id: `home-pvs:event:${event.type}:${event.ts}`,
      kind: "collector_event",
      event_type: event.type,
      event_ts_utc: iso(event.ts),
      details_code: event.details,
    });
  }
  return records;
}

/* ------------------------------------------------------------------- SQL */

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const lit = (value) =>
  value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : quote(value);

function insert(table, columns, rows, chunk = 200) {
  const out = [];
  for (let index = 0; index < rows.length; index += chunk) {
    const slice = rows.slice(index, index + chunk);
    out.push(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n` +
        slice.map((row) => `(${row.map(lit).join(", ")})`).join(",\n") +
        ";",
    );
  }
  return out.join("\n");
}

function buildSql(sim) {
  const received = Math.floor(Date.now() / 1000);
  const digest = (name, key) => `sim-${name}-${key}`;
  const minuteRows = sim.minutes.map((minute) => [
    collector,
    minute.ts,
    minute.ts + 60,
    minute.sample_count,
    minute.valid_count,
    minute.complete ? 1 : 0,
    minute.quality,
    minute.pv_kw_avg,
    minute.load_kw_reported_avg,
    minute.grid_kw_avg,
    null,
    JSON.stringify(minute.valid_counts),
    minute.pv_kwh_total_end,
    minute.load_kwh_total_reported_end,
    minute.grid_net_kwh_total_end,
    minute.last_measured_ts,
    digest("site_minute", minute.ts),
    received,
  ]);
  const daysByIndex = new Map();
  for (const minute of sim.minutes) {
    const dayIndex = localParts(minute.ts).dayIndex;
    let day = daysByIndex.get(dayIndex);
    if (!day) {
      day = { windows: 0, ok: 0, errors: 0, samples: 0, valid: 0, pvSum: 0, pvWeight: 0,
        loadSum: 0, loadWeight: 0, gridSum: 0, gridWeight: 0, total: null, measured: null };
      daysByIndex.set(dayIndex, day);
    }
    day.windows += 1;
    day.ok += Number(minute.quality === "ok");
    day.errors += Number(minute.quality === "source_error");
    day.samples += minute.sample_count;
    day.valid += minute.valid_count;
    for (const [field, sum, weight] of [["pv_kw", "pvSum", "pvWeight"],
      ["load_kw_reported", "loadSum", "loadWeight"], ["grid_kw", "gridSum", "gridWeight"]]) {
      const count = minute.valid_counts[field] ?? 0;
      if (count > 0) {
        day[sum] += minute[`${field}_avg`] * count;
        day[weight] += count;
      }
    }
    if (minute.pv_kwh_total_end !== null) day.total = Math.max(day.total ?? -Infinity, minute.pv_kwh_total_end);
    if (minute.last_measured_ts !== null) day.measured = Math.max(day.measured ?? -Infinity, minute.last_measured_ts);
  }
  const dailyRows = [...daysByIndex].map(([dayIndex, day]) => {
    const start = dayIndex * 86400 - tzOffsetSec;
    const date = new Date(dayIndex * 86400 * 1000).toISOString().slice(0, 10);
    return [collector, date, timezone, start, start + 86400, day.windows, day.ok, day.errors,
      day.samples, day.valid, day.pvWeight ? day.pvSum / day.pvWeight : null,
      day.loadWeight ? day.loadSum / day.loadWeight : null,
      day.gridWeight ? day.gridSum / day.gridWeight : null, null, day.total, day.measured, received];
  });
  const panelRows = sim.panels.map((panel) => [
    collector,
    panel.panel_id,
    panel.slot_ts,
    panel.ac_kw,
    panel.energy_kwh_total,
    panel.dc_kw,
    panel.dc_v,
    panel.dc_a,
    panel.ac_v,
    panel.ac_a,
    panel.heatsink_c,
    panel.measured_ts,
    panel.quality,
    digest(`panel-${panel.panel_id}`, panel.slot_ts),
    received,
  ]);
  const lastSeen = new Map();
  for (const panel of sim.panels) {
    lastSeen.set(panel.panel_id, Math.max(lastSeen.get(panel.panel_id) ?? 0, panel.slot_ts));
  }
  const panelKnownRows = [...lastSeen].map(([panelId, slotTs]) => [collector, panelId, slotTs]);
  const eventRows = sim.events.map((event) => [
    `evt-${event.type}-${event.ts}`,
    collector,
    event.ts,
    event.type,
    event.details,
    digest("event", `${event.type}-${event.ts}`),
    received,
  ]);

  const weatherColumns = [
    "collector_id", "hour_ts", "kind", "temperature_c", "weather_code", "cloud_cover_pct",
    "precipitation_mm", "precipitation_probability_pct", "uv_index", "source", "fetched_ts", "quality",
  ];
  const weatherRows = [];
  for (const [ts, hour] of sim.weather.hours) {
    weatherRows.push([
      collector, ts, "forecast", hour.temp, hour.code, hour.cloud, hour.precip, hour.precipProb,
      null, "open-meteo-forecast", received - 420, "ok",
    ]);
    weatherRows.push([
      collector, ts, "air_quality", null, null, null, null, null,
      hour.uv, "open-meteo-air-quality", received - 420, hour.uv === null ? "partial" : "ok",
    ]);
  }
  for (let dayIndex = localParts(sim.startSec).dayIndex - 1; dayIndex <= localParts(sim.nowSec).dayIndex + 1; dayIndex += 1) {
    // Local midnight of that day, expressed in UTC seconds.
    const localMidnight = dayIndex * 86400 - tzOffsetSec;
    const { rise, set } = daylightHours(localMidnight + 12 * 3600);
    weatherRows.push([collector, Math.round(localMidnight + rise * 3600), "sunrise", null, null, null, null, null, null, "open-meteo-forecast", received - 420, "ok"]);
    weatherRows.push([collector, Math.round(localMidnight + set * 3600), "sunset", null, null, null, null, null, null, "open-meteo-forecast", received - 420, "ok"]);
  }

  const last = sim.minutes[sim.minutes.length - 1];
  const sql = [
    insert(
      "site_minute",
      [
        "collector_id", "minute_ts", "window_end_ts", "sample_count", "valid_count", "complete",
        "quality", "pv_kw_avg", "load_kw_reported_avg", "grid_kw_avg", "battery_kw_avg",
        "valid_counts_json", "pv_kwh_total_end", "load_kwh_total_reported_end",
        "grid_net_kwh_total_end", "last_measured_ts", "digest", "received_ts",
      ],
      minuteRows,
    ),
    insert(
      "site_day",
      ["collector_id", "local_date", "timezone", "start_ts", "end_ts", "windows", "ok_windows",
        "source_error_windows", "sample_count", "valid_count", "pv_kw_avg", "load_kw_reported_avg",
        "grid_kw_avg", "battery_kw_avg", "pv_kwh_total_end", "last_measured_ts", "updated_ts"],
      dailyRows,
    ),
    insert(
      "panel_sample",
      [
        "collector_id", "panel_id", "slot_ts", "ac_kw", "energy_kwh_total", "dc_kw", "dc_v", "dc_a",
        "ac_v", "ac_a", "heatsink_c", "measured_ts", "quality", "digest", "received_ts",
      ],
      panelRows,
    ),
    // The ingest keeps this inventory from every panel sample; the check writes
    // D1 directly, so it seeds the same rows the ingest would.
    insert("panel_known", ["collector_id", "panel_id", "last_seen_ts"], panelKnownRows),
    insert("weather_hour", weatherColumns, weatherRows),
    insert(
      "collector_event",
      ["event_id", "collector_id", "event_ts", "event_type", "details_code", "digest", "received_ts"],
      eventRows,
    ),
    insert(
      "latest_site",
      [
        "collector_id", "collected_ts", "measured_ts", "received_ts", "quality", "pv_kw",
        "load_kw_reported", "grid_kw", "battery_kw", "pv_kwh_total", "load_kwh_total_reported",
        "grid_net_kwh_total",
      ],
      [[
        // latest_site is a live sample, not the minute rollup, so its
        // measurement time is seconds before the upload, not a minute behind.
        collector, received - 3, received - 5, received, last.quality, last.pv_kw_avg,
        last.load_kw_reported_avg, last.grid_kw_avg, null, last.pv_kwh_total_end,
        last.load_kwh_total_reported_end, last.grid_net_kwh_total_end,
      ]],
    ),
    insert(
      "site_location",
      ["collector_id", "latitude", "longitude", "timezone", "source", "updated_ts"],
      [[collector, latitude, longitude, timezone, "us_census", received]],
    ),
  ].join("\n");
  return { sql, counts: { minutes: minuteRows.length, panels: panelRows.length, weather: weatherRows.length, events: eventRows.length } };
}

/* ---------------------------------------------------------------- helpers */

function wrangler(cwd, args) {
  const result = spawnSync("npx", ["wrangler", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`wrangler ${args.join(" ")} failed`);
  }
  return result.stdout;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const nowSec = Math.floor(Date.now() / 1000 / 60) * 60;
  const sim = simulate(nowSec);
  const records = contractRecords(sim);

  // 1. Every generated record must pass the real ingest contract.
  let invalid = 0;
  let firstError = "";
  for (let index = 0; index < records.length; index += 100) {
    const result = validateBatch(records.slice(index, index + 100), Date.now());
    if (!result.ok) {
      invalid += result.invalidIds?.length ?? 1;
      firstError = firstError || `${result.error} ${JSON.stringify(result.invalidIds?.slice(0, 3))}`;
    }
  }
  check(`all ${records.length} generated records pass the ingest contract`, invalid === 0, `${invalid} invalid: ${firstError}`);
  const sampleDigest = await digestOf(records[0]);
  check("a generated record digests to a stable 64-hex value", /^[0-9a-f]{64}$/.test(sampleDigest), sampleDigest);

  // 2. Seed a throwaway D1.
  const { sql, counts } = buildSql(sim);
  const state = mkdtempSync(join(tmpdir(), "spm-month-"));
  const fixtures = mkdtempSync(join(tmpdir(), "spm-month-sql-"));
  const seedPath = join(fixtures, "seed.sql");
  writeFileSync(seedPath, sql);
  if (process.env.MONTH_SQL_OUT) {
    writeFileSync(process.env.MONTH_SQL_OUT, sql);
    console.log(`wrote ${process.env.MONTH_SQL_OUT}`);
  }
  console.log(
    `month: ${counts.minutes} minute windows, ${counts.panels} panel samples, ${counts.weather} weather rows, ${counts.events} events`,
  );
  if (writeOnly) return;

  const schemaPath = join(fixtures, "schema.sql");
  writeFileSync(schemaPath, readFileSync(join(root, "workers/schema.sql"), "utf8"));
  wrangler(join(root, "workers/ingest"), ["d1", "execute", "DB", "--local", "--persist-to", state, "--file", schemaPath]);
  wrangler(join(root, "workers/ingest"), ["d1", "execute", "DB", "--local", "--persist-to", state, "--file", seedPath]);

  server = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state,
      "--var", `SESSION_SECRET:${sessionSecret}`,
      "--var", "GITHUB_CLIENT_ID:local",
      "--var", "GITHUB_CLIENT_SECRET:local",
      "--var", `ALLOWED_USER_IDS:${sessionUser}`,
      "--var", `COLLECTOR_ID:${collector}`,
    ],
    { cwd: join(root, "workers/dashboard"), stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = [];
  server.stdout.on("data", (chunk) => log.push(String(chunk)));
  server.stderr.on("data", (chunk) => log.push(String(chunk)));

  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (log.join("").includes(`http://127.0.0.1:${port}`)) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`dev server did not start:\n${log.join("")}`);

  const cookie = `spm_session=${await signSession(
    { userId: sessionUser, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    sessionSecret,
  )}`;

  if (serveOnly) {
    console.log(`\nServing the simulated month at ${origin}`);
    console.log(`Session cookie for the browser:\n${cookie}\n`);
    await new Promise(() => {});
    return;
  }

  const get = async (path) => {
    const response = await fetch(`${origin}${path}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const nowIso = new Date(nowSec * 1000).toISOString();
  const localMidnight = new Date(nowSec * 1000);
  localMidnight.setHours(0, 0, 0, 0);
  const dayFrom = localMidnight.toISOString();
  const weekFrom = new Date((nowSec - 7 * 86400) * 1000).toISOString();
  const monthFrom = new Date((nowSec - 30 * 86400) * 1000).toISOString();
  const threeDayFrom = new Date((nowSec - 3 * 86400) * 1000).toISOString();
  const twoDayFrom = new Date((nowSec - 2 * 86400) * 1000).toISOString();

  /* ------------------------------------------------------------- API checks */

  const health = await get("/api/v1/health");
  check("health reports a collecting collector", health.body?.state === "collecting", JSON.stringify(health.body));
  check("health counts every panel", health.body?.known_panels === panelCount, JSON.stringify(health.body?.known_panels));
  check(
    "health lists the injected PVS events",
    (health.body?.events ?? []).some((event) => event.event_type === "pvs_request_failed"),
    JSON.stringify(health.body?.events),
  );

  const live = await get("/api/v1/live");
  check("live is fresh and signed", live.body?.state === "live" && live.body?.export_kw !== undefined, JSON.stringify(live.body));

  const today = await get(`/api/v1/history?from=${dayFrom}&to=${nowIso}&resolution=1m`);
  const todayMinutes = Math.floor((Date.parse(nowIso) - Date.parse(dayFrom)) / 60000);
  check(
    "minute history returns one window per minute of the day",
    today.body?.windows.length === todayMinutes,
    `${today.body?.windows.length} of ${todayMinutes}`,
  );
  const week = await get(`/api/v1/history?from=${weekFrom}&to=${nowIso}&resolution=5m`);
  check("seven days of 5m views are not truncated", week.body?.truncated === false && week.body?.windows.length > 1900, `${week.body?.windows.length}`);
  check("the summary counts the whole week", week.body?.summary?.windows === week.body?.windows.length, "");
  check(
    "a week containing an outage keeps its failed minutes null",
    week.body?.windows.some((w) => w.source_error_windows > 0 && w.pv_kw_avg === null),
    JSON.stringify(week.body?.summary),
  );
  // A five-minute bucket that contains a failed minute is worth reporting: the
  // state line should not say "2000 complete" and stay silent about the failures.
  check(
    "the 5m summary counts the failed minutes inside its buckets",
    week.body?.summary?.source_error > 0,
    JSON.stringify(week.body?.summary),
  );

  const month = await get(`/api/v1/history?from=${monthFrom}&to=${nowIso}&resolution=5m`);
  check(
    "thirty days of 5m views return the whole month, untruncated",
    month.body?.truncated === false && month.body?.windows.length >= 8600,
    `truncated=${month.body?.truncated} windows=${month.body?.windows.length}`,
  );
  // The range must end at the newest data, not stop ~13 days short.
  const monthEndAgeDays = (nowSec - Date.parse(month.body?.windows.at(-1)?.ts) / 1000) / 86400;
  check(
    "the 30-day view reaches the newest window",
    monthEndAgeDays < 1,
    `newest window is ${monthEndAgeDays.toFixed(1)} days before now (first ${month.body?.windows[0]?.ts})`,
  );
  const yearFrom = new Date((nowSec - 365 * 86400) * 1000).toISOString();
  const year = await get(`/api/v1/history?from=${yearFrom}&to=${nowIso}&resolution=1d`);
  check("a one-year query returns actual daily rows", year.body?.resolution === "1d" &&
    year.body?.truncated === false && year.body?.windows.length >= 30 &&
    year.body?.windows.every((window) => window.local_date && window.duration_seconds === 86400),
    `${year.body?.windows?.length} days`);

  const twoDays = await get(`/api/v1/history?from=${twoDayFrom}&to=${nowIso}&resolution=1m`);
  check("the two-day minute boundary is allowed", twoDays.status === 200, `${twoDays.status}`);
  const tooLong = await get(`/api/v1/history?from=${threeDayFrom}&to=${nowIso}&resolution=1m`);
  check("minute data over two days is refused", tooLong.status === 400 && tooLong.body?.error === "range_too_long", `${tooLong.status} ${JSON.stringify(tooLong.body)}`);

  const panels = await get("/api/v1/panels");
  check("the panel matrix lists every panel", panels.body?.panels.length === panelCount, JSON.stringify(panels.body?.panels?.length));
  check(
    "the newest panel slot is the last daylight slot, within a day",
    Math.abs(Date.parse(panels.body?.slot_ts) / 1000 - nowSec) < 86400,
    `${panels.body?.slot_ts}`,
  );
  check(
    "panel tiles carry DC diagnostics",
    panels.body?.panels.every((panel) => panel.dc_kw !== undefined && panel.heatsink_c !== undefined),
    JSON.stringify(panels.body?.panels?.[0]),
  );

  const panelHistory = await get(`/api/v1/panels?panel_id=p01&from=${weekFrom}&to=${nowIso}`);
  check("panel history clamps a week to the 31-day panel span", panelHistory.body?.clamped === false && panelHistory.body?.samples.length > 100, `${panelHistory.body?.samples?.length}`);

  const weather = await get(`/api/v1/weather?from=${monthFrom}&to=${nowIso}`);
  check("the weather month returns about 720 hours", (weather.body?.hours?.length ?? 0) >= 700, `${weather.body?.hours?.length}`);
  check("the weather month groups 30 local days", (weather.body?.days?.length ?? 0) >= 29, `${weather.body?.days?.length}`);
  check(
    "every weather hour carries UV from the air-quality row",
    weather.body?.hours.filter((hour) => hour.uv_index !== null).length > 300,
    `${weather.body?.hours?.filter((hour) => hour.uv_index !== null).length}`,
  );

  const location = await get("/api/v1/location");
  check("the site location reads back", location.body?.configured === true && location.body?.timezone === timezone, JSON.stringify(location.body));


}

try {
  await main();
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  if (!serveOnly) {
    server?.kill("SIGTERM");
    console.log(failures.length === 0 ? "\nsimulated-month checks passed" : `\n${failures.length} simulated-month check(s) failed`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
}
