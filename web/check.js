/* Static checks for the production pages: no demo credentials, wired element ids. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { daylightVerdict, formatDaylightDuration, weatherText } from "./insights.js";
import { calibrateHistory, calibrateLive } from "./calibration.js";
import { COLORS, alignedEnergy, chartBounds, counterDelta, energyBuckets, exportStats, num, rangeEnergy, solarDisplay } from "./chart.js";
import { dailySiteOption, dailySiteRows, powerGridOption } from "./energy-plot.js";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];

/* The animated power flow must ship with its accessibility guard. */
const stylesheet = readFileSync(join(here, "style.css"), "utf8");
if (!stylesheet.includes("@keyframes power-flow")) failures.push("style.css lost the power-flow animation");
if (!stylesheet.includes("prefers-reduced-motion")) {
  failures.push("the power-flow animation must stop under prefers-reduced-motion");
}

const pages = [
  {
    html: "index.html",
    script: "app.js",
    apis: ["/api/v1/live", "/api/v1/health", "/api/v1/weather", "/api/v1/history", "/api/v1/panels"],
  },
  { html: "history.html", script: "history.js", apis: ["/api/v1/history", "/api/v1/weather"] },
  { html: "panels.html", script: "panels.js", apis: ["/api/v1/panels", "/api/v1/live"] },
  { html: "settings.html", script: "settings.js", apis: ["/api/v1/location", "/api/v1/location/resolve", "/api/v1/health", "/api/v1/calibration", "/api/v1/live"] },
];

// A production page must not carry a demo credential or stand in for a real API.
const FORBIDDEN = ["localstorage", "demo", "bearer ", "api_key", "token", "simulat"];

for (const page of pages) {
  const html = readFileSync(join(here, page.html), "utf8");
  const script = readFileSync(join(here, page.script), "utf8");
  execFileSync(process.execPath, ["--check", join(here, page.script)], { stdio: "pipe" });

  for (const asset of ["/style.css", `/${page.script}`]) {
    if (!html.includes(asset)) failures.push(`${page.html} does not reference ${asset}`);
  }
  if (!html.includes('name="robots" content="noindex"')) {
    failures.push(`${page.html} must stay out of search indexes`);
  }
  const referenced = new Set([...script.matchAll(/el\("([a-z-]+)"\)/g)].map((match) => match[1]));
  if (referenced.size < 4) failures.push(`${page.script} does not look like a page client`);
  for (const id of referenced) {
    if (!html.includes(`id="${id}"`)) failures.push(`${page.script} uses #${id}, which ${page.html} does not define`);
  }
  for (const forbidden of FORBIDDEN) {
    if (script.toLowerCase().includes(forbidden.toLowerCase())) {
      failures.push(`${page.script} must not contain "${forbidden}"`);
    }
  }
  for (const forbidden of ["demo", "token", "Bearer "]) {
    if (html.toLowerCase().includes(forbidden.toLowerCase())) {
      failures.push(`${page.html} must not contain "${forbidden}"`);
    }
  }
  for (const api of page.apis) {
    if (!script.includes(api)) failures.push(`${page.script} does not read ${api}`);
  }
}

/* The daylight judgment is the one browser rule that must fail closed. */
const DAY = { sunriseUtc: "2026-09-18T13:52:00Z", sunsetUtc: "2026-09-19T01:12:00Z" };
const DAYLIGHT_NOW = Date.parse("2026-09-18T20:00:00Z");

function verdict(overrides = {}) {
  return daylightVerdict({
    hasLocation: true,
    weatherStored: true,
    sunriseUtc: DAY.sunriseUtc,
    sunsetUtc: DAY.sunsetUtc,
    nowUtc: DAYLIGHT_NOW,
    weatherStale: false,
    powerFresh: true,
    pvKw: 3.2,
    ...overrides,
  }).state;
}

const rules = [
  ["no location is not a production judgment", verdict({ hasLocation: false }), "no_location"],
  ["before sunrise is night", verdict({ nowUtc: Date.parse("2026-09-18T10:00:00Z") }), "outside_daylight"],
  ["after sunset is night", verdict({ nowUtc: Date.parse("2026-09-19T03:00:00Z") }), "outside_daylight"],
  ["measured output is producing", verdict({}), "producing"],
  ["daylight with fresh zero power is no production", verdict({ pvKw: 0 }), "no_production"],
  ["stale weather blocks the judgment", verdict({ pvKw: 0, weatherStale: true }), "insufficient"],
  ["stale power blocks the judgment", verdict({ pvKw: 0, powerFresh: false }), "insufficient"],
  ["missing power blocks the judgment", verdict({ pvKw: null }), "insufficient"],
  ["missing daylight blocks the judgment", verdict({ pvKw: 0, sunriseUtc: null }), "insufficient"],
];

for (const [name, actual, expected] of rules) {
  if (actual !== expected) failures.push(`daylight verdict: ${name} (got ${actual}, want ${expected})`);
}
if (formatDaylightDuration(40800) !== "11h 20m") failures.push("daylight duration formatting changed");
if (weatherText(0) !== "Clear" || weatherText(null) !== "No condition data") {
  failures.push("weather text must name the condition and never guess a missing one");
}

/* No stored weather yet is a waiting state, not a claim about the site. */
const waiting = daylightVerdict({
  hasLocation: true,
  weatherStored: false,
  sunriseUtc: null,
  sunsetUtc: null,
  nowUtc: DAYLIGHT_NOW,
  weatherStale: true,
  powerFresh: true,
  pvKw: 0,
});
if (waiting.state !== "insufficient" || !/not been stored/.test(waiting.message)) {
  failures.push(`an empty weather table must read as waiting, got "${waiting.message}"`);
}
const noDaylight = daylightVerdict({
  hasLocation: true,
  weatherStored: true,
  sunriseUtc: null,
  sunsetUtc: null,
  nowUtc: DAYLIGHT_NOW,
  weatherStale: false,
  powerFresh: true,
  pvKw: 0,
});
if (!/unavailable for this site/.test(noDaylight.message)) {
  failures.push("stored weather without a daylight window keeps its own wording");
}

/* Export statistics: import minutes count as zero export, missing minutes are
 * not zero, and only a full five-minute slot can be a "complete window". */
const STATS_NOW = Date.parse("2026-09-21T07:30:00Z");
const minuteWindow = (minutesAgo, grid) => ({
  ts: new Date(STATS_NOW - minutesAgo * 60000).toISOString(),
  grid_kw_avg: grid,
});
const hour = [];
for (let index = 0; index < 60; index += 1) hour.push(minuteWindow(index, index < 30 ? -2 : 1));
const stats = exportStats(hour, STATS_NOW, 30);
if (stats.mean30 !== 2) failures.push(`mean export over 30 minutes should be 2 kW, got ${stats.mean30}`);
if (stats.mean60 !== 1) failures.push(`mean export over 60 minutes should be 1 kW, got ${stats.mean60}`);
if (stats.valid30 !== 30 || stats.valid60 !== 60) failures.push("valid minute counts are wrong");
// A 30-minute half-open window holds five whole five-minute slots plus its edges.
if (stats.low30 !== 2 || stats.low_slots !== 5) failures.push("lowest complete five-minute mean is wrong");

const partial = [minuteWindow(0, -2), minuteWindow(1, -2), minuteWindow(2, null)];
const partialStats = exportStats(partial, STATS_NOW, 30);
if (partialStats.mean30 !== 2) failures.push("a missing minute must be skipped, not counted as zero export");
if (partialStats.valid30 !== 2) failures.push("missing minutes must not count as valid");
if (partialStats.low30 !== null || partialStats.low_slots !== 0) {
  failures.push("a slot with missing minutes is not a complete five-minute window");
}
const staleExport = exportStats([minuteWindow(45, -9)], STATS_NOW, 30);
if (staleExport.mean30 !== null) failures.push("a window older than 30 minutes must not enter the 30-minute mean");

/* Range energy keeps the two sides apart and never invents a missing side. */
const energyWindows = [
  { ts: new Date(STATS_NOW - 120000).toISOString(), pv_kwh_total_end: 10, load_kw_reported_avg: 2, grid_kw_avg: 1 },
  { ts: new Date(STATS_NOW - 60000).toISOString(), pv_kwh_total_end: null, load_kw_reported_avg: 2, grid_kw_avg: -3 },
  { ts: new Date(STATS_NOW).toISOString(), pv_kwh_total_end: 11.5, load_kw_reported_avg: null, grid_kw_avg: null },
];
const energy = rangeEnergy(energyWindows, 60000);
if (energy.solar_kwh !== 1.5) failures.push(`solar energy must come from the counter, got ${energy.solar_kwh}`);
// Two windows report 2 kW for one minute each, so home use is 4/60 kWh.
if (Math.abs(energy.home_kwh - 4 / 60) > 1e-9) failures.push("home energy integrates the reported load over valid windows");
if (Math.abs(energy.import_kwh - 1 / 60) > 1e-9 || Math.abs(energy.export_kwh - 3 / 60) > 1e-9) {
  failures.push("grid import and export must split the signed mean power");
}
if (energy.load_windows !== 2 || energy.grid_windows !== 2 || energy.windows !== 3) {
  failures.push("energy coverage must count the windows each side actually used");
}
const onlyLoad = rangeEnergy([{ ts: new Date(STATS_NOW).toISOString(), load_kw_reported_avg: 2 }], 60000);
if (onlyLoad.import_kwh !== null || onlyLoad.export_kwh !== null) {
  failures.push("a side with no windows stays unknown, never zero");
}

/* Range energy reads the lifetime counter, which only adds. */
const counterWindows = [
  { ts: new Date(STATS_NOW - 120000).toISOString(), pv_kwh_total_end: 36498.0 },
  { ts: new Date(STATS_NOW - 60000).toISOString(), pv_kwh_total_end: null },
  { ts: new Date(STATS_NOW).toISOString(), pv_kwh_total_end: 36500.5 },
];
if (counterDelta(counterWindows, "pv_kwh_total_end") !== 2.5) {
  failures.push("range energy must be the first-to-last counter change, skipping missing readings");
}
if (counterDelta([counterWindows[0]], "pv_kwh_total_end") !== null) {
  failures.push("one counter reading cannot show a change");
}

/* Billed-style buckets: solar from the counter, import above and export below. */
const bucketWindows = [
  { ts: new Date(STATS_NOW - 120000).toISOString(), pv_kwh_total_end: 10, load_kw_reported_avg: 2, grid_kw_avg: 1 },
  { ts: new Date(STATS_NOW - 60000).toISOString(), pv_kwh_total_end: 11, load_kw_reported_avg: 2, grid_kw_avg: -3 },
];
const buckets = energyBuckets(bucketWindows, 60000, 3600000, 0);
if (buckets.length !== 1) failures.push(`both minutes belong to one hour bucket, got ${buckets.length}`);
else {
  const bucket = buckets[0];
  if (bucket.solar !== 1) failures.push(`bucket solar must be the counter change, got ${bucket.solar}`);
  if (Math.abs(bucket.home - 4 / 60) > 1e-9) failures.push("bucket home use integrates the reported load");
  if (Math.abs(bucket.import_kwh - 1 / 60) > 1e-9) failures.push("bucket import sums the positive grid minutes");
  if (Math.abs(bucket.export_kwh - 3 / 60) > 1e-9) failures.push("bucket export sums the negative grid minutes");
}
const dayBuckets = energyBuckets(
  [
    { ts: "2026-09-21T06:30:00Z", pv_kwh_total_end: 1 },
    { ts: "2026-09-21T07:30:00Z", pv_kwh_total_end: 2 },
  ],
  60000,
  86400000,
  -7 * 3600000,
);
if (dayBuckets.length !== 2) failures.push("a local-day boundary must split the buckets, not merge them");

/* Sparse periods keep calendar positions and distinguish future from a bad reading. */
const alignedRows = [
  { ts: "2026-09-23T14:00:00Z", quality: "ok", complete: true, pv_kw_avg: 2, load_kw_reported_avg: 1, grid_kw_avg: -1 },
  { ts: "2026-09-23T14:01:00Z", quality: "partial", complete: false, pv_kw_avg: 2, load_kw_reported_avg: null, grid_kw_avg: -1 },
];
const from = Date.parse("2026-09-23T07:00:00Z"), to = from + 86400000;
const sparse = powerGridOption(alignedRows, [], { from, to, now: Date.parse(alignedRows[1].ts), resolution: "1m", width: 640, timezone: "America/Los_Angeles" });
if (sparse.xAxis[0].min !== from || sparse.xAxis[0].max !== to) failures.push("sparse power must retain the full day axis");
const combined = powerGridOption(alignedRows, [], { from, to, resolution: "1m", layout: "combined", timezone: "America/Los_Angeles",
  daylightDays: [{ sunrise_utc: "2026-09-23T13:50:00Z", sunset_utc: "2026-09-24T02:10:00Z" }] });
if (sparse.grid.length !== 2 || combined.grid.length !== 1 || combined.yAxis[0].min >= 0 || combined.series[3].yAxisIndex !== 0) failures.push("combined power must share one signed kW axis");
if (combined.series[0].markLine?.data.length !== 2 || combined.tooltip.axisPointer.type !== "line") failures.push("daylight markers and hover guide must remain visible");
if (!sparse.series[0].markArea || !sparse.series[0].markArea.data.some((area) => area[1].xAxis === to)) failures.push("future time must be marked separately");
if (!sparse.series[0].data.some((point) => point[1] === null)) failures.push("an incomplete reading must break the solar line");
if (sparse.series[3].data.length !== 1 || sparse.series[3].data[0].value[1] !== -1) failures.push("complete grid export must remain negative");
const aligned = alignedEnergy(alignedRows, 60000, Date.parse(alignedRows[0].ts), Date.parse(alignedRows[1].ts) + 60000, "America/Los_Angeles");
if (aligned.valid !== 1 || aligned.expected !== 2 || Math.abs(aligned.self - 1 / 60) > 1e-8) failures.push("energy composition must use complete, aligned readings only");
const week = dailySiteRows(alignedRows, from, from + 7 * 86400000, 60000, "America/Los_Angeles");
const weekOption = dailySiteOption(week, [], { width: 640, timezone: "America/Los_Angeles", measure: "solar", selected: 0, now: from + 2 * 3600000 });
if (week.length !== 7 || weekOption.option.xAxis[0].data.length !== 7) failures.push("sparse week must retain seven calendar slots");
if (!weekOption.option.series[0].markArea) failures.push("upcoming days must be marked separately from missing days");
if (num(0) !== 0 || num("1") !== null || num(Number.NaN) !== null) failures.push("num() must reject non-numbers");
if (COLORS.solar !== "var(--solar)") failures.push("series colors moved out of the shared chart module");
const quietSolar = chartBounds([{ pv_kw_avg: 0 }, { pv_kw_avg: 0.003 }], [{ key: "pv_kw_avg" }]);
if (quietSolar.max !== 0.5 || quietSolar.min !== 0) failures.push("nighttime watts must not fill a 0.0 kW chart");
const daytimeSolar = chartBounds([{ pv_kw_avg: 4 }], [{ key: "pv_kw_avg" }]);
if (daytimeSolar.max !== 4.4) failures.push("the solar scale must still follow daytime output");

/* Grid correction applies once to both directions and preserves source data. */
const rawLive = { grid_kw: -0.465, load_kw_reported: 1.5, pv_kw: 1.965,
  calibration: { grid_ratio: 0.465 } };
const correctedLive = calibrateLive(rawLive);
if (Math.abs(correctedLive.grid_kw + 1) > 1e-9 || Math.abs(correctedLive.load_kw_reported - 0.965) > 1e-9) {
  failures.push("export calibration must correct grid and home together");
}
if (rawLive.grid_kw !== -0.465 || correctedLive.pv_kw !== rawLive.pv_kw) {
  failures.push("calibration must not change raw input or solar");
}
const correctedHistory = calibrateHistory({ calibration: { grid_ratio: 0.465 }, windows: [
  { grid_kw_avg: 0.465, load_kw_reported_avg: 2, pv_kw_avg: 1.535 },
  { grid_kw_avg: null, load_kw_reported_avg: 2 },
] });
if (Math.abs(correctedHistory.windows[0].grid_kw_avg - 1) > 1e-9 ||
    Math.abs(correctedHistory.windows[0].load_kw_reported_avg - 2.535) > 1e-9 ||
    correctedHistory.windows[0].pv_kw_avg !== 1.535 || correctedHistory.windows[1].load_kw_reported_avg !== null) {
  failures.push("history calibration must preserve solar and treat missing grid as missing home");
}
const calibratedEnergy = rangeEnergy(correctedHistory.windows.slice(0, 1), 60000);
if (Math.abs(calibratedEnergy.import_kwh - 1 / 60) > 1e-9 ||
    Math.abs(calibratedEnergy.home_kwh - 2.535 / 60) > 1e-9) {
  failures.push("history energy must integrate calibrated grid and home");
}
if (calibrateLive({ grid_kw: null, load_kw_reported: 2 }).load_kw_reported !== 2) {
  failures.push("100% calibration must preserve raw home when grid is missing");
}

const solarMinutes = Array.from({ length: 9 }, (_, index) => ({
  ts: new Date(Date.parse("2026-09-22T12:00:00Z") + index * 60000).toISOString(),
  quality: index === 4 ? "source_error" : "ok",
  pv_kw_avg: index === 4 ? null : 1 + Math.floor(index / 3),
}));
const daySolar = solarDisplay(solarMinutes, "1m", 12 * 3600000);
if (daySolar.averaged || daySolar.values.length !== 9) failures.push("a sparse day must show its original minute readings");
const longSolar = solarDisplay([...solarMinutes, {
  ts: new Date(Date.parse(solarMinutes[0].ts) + 5 * 3600000).toISOString(), quality: "ok", pv_kw_avg: 4,
}], "1m", 12 * 3600000);
if (!longSolar.averaged || longSolar.values[0] !== 1 || longSolar.values[1] !== null ||
    longSolar.values[2] !== 3 || longSolar.step !== 180000) {
  failures.push("long observed plots average complete three-minute windows and leave failed windows empty");
}
if (solarDisplay(solarMinutes, "1m", 3600000).averaged) {
  failures.push("short solar plots keep the original minute readings");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`web checks passed (${pages.length} pages, ${rules.length} daylight rules, export statistics)`);
