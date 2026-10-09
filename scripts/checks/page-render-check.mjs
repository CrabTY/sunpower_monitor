/* Small DOM smoke check for the production History, Live, and Panels clients. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(join(here, "../../web", name), "utf8")
  .replace(/^import\b[\s\S]*?from\s+"[^"]+";/gm, "");
const modules = {
  ...await import("../../web/chart.js"),
  ...await import("../../web/energy-plot.js"),
  ...await import("../../web/calibration.js"),
  ...await import("../../web/insights.js"),
  ...await import("../../web/weather-controls.js"),
  chartPalette: () => ({ solar: "#a96508", home: "#64766e", imported: "#315f99", exported: "#167866", text: "#182d27", muted: "#64766e", line: "#dce4dc" }),
  renderEChart(node, option, height) {
    node.chartOption = option;
    node.chartHeight = height;
    node.chartHandlers ||= {};
    return {
      off(name) { delete node.chartHandlers[name]; },
      on(name, handler) { node.chartHandlers[name] = handler; },
    };
  },
  disposeEChart() {},
  clearEChart(node, message) { node.innerHTML = message; node.chartOption = null; },
  chartXValueAt: () => at - 5 * 60000,
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
const result = (value) => Promise.resolve(value instanceof Response ? value : { status: 200, ok: true, json: async () => value });

function page(name, reply, href = "http://localhost/") {
  const elements = new Map();
  const requests = [];
  let focused = null;
  const location = { href, search: new URL(href).search, hash: new URL(href).hash };
  const history = { replaceState(_state, _title, next) {
    location.href = new URL(next, location.href).href;
    location.search = new URL(location.href).search;
    location.hash = new URL(location.href).hash;
  } };
  const get = (id) => {
    if (elements.has(id)) return elements.get(id);
    const node = {
      innerHTML: "", textContent: "", hidden: false, value: "", clientWidth: 640,
      dataset: {}, handlers: {}, attrs: {}, style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
      classList: { toggle() {} },
      querySelectorAll: () => [],
      querySelector: () => null,
      setAttribute(key, value) { node.attrs[key] = value; },
      addEventListener(key, handler) { node.handlers[key] = handler; },
      checkValidity() { return node.value !== ""; },
      focus() { focused = id; },
      getBoundingClientRect: () => ({ left: 0, width: 640 }),
      scrollIntoView() { node.scrolled = true; },
    };
    node.firstChild = {
      handlers: {}, addEventListener(key, handler) { this.handlers[key] = handler; },
      getBoundingClientRect: () => ({ left: 0, width: 640 }), focus() {},
    };
    elements.set(id, node);
    return node;
  };
  const context = {
    document: { getElementById: get },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, innerWidth: 1024, location, history },
    Date, Math, Intl, JSON, URL, URLSearchParams, isNaN, isFinite, ...modules,
    fetch(url, options) { requests.push(url); return Promise.resolve(reply(url, options)).then(result); },
  };
  context.self = context;
  vm.runInNewContext(source(name), context, { filename: name });
  return { get, requests, location, focused: () => focused };
}

const at = Date.now();
const disclosure = {}, phoneMedia = { matches: true, addEventListener(_event, handler) { this.change = handler; } };
modules.initWeatherControls(disclosure, phoneMedia);
assert.equal(disclosure.open, false);
disclosure.open = true;
phoneMedia.matches = false;
phoneMedia.change();
assert.equal(disclosure.open, true);
phoneMedia.matches = true;
phoneMedia.change();
assert.equal(disclosure.open, false);
const rows = [
  { ts: new Date(at - 240000).toISOString(), quality: "ok", complete: true, pv_kw_avg: 3.2, load_kw_reported_avg: 1.4, grid_kw_avg: -1.8, pv_kwh_total_end: 36500.0 },
  { ts: new Date(at - 180000).toISOString(), quality: "ok", complete: true, pv_kw_avg: 3.3, load_kw_reported_avg: 1.4, grid_kw_avg: -1.9, pv_kwh_total_end: 36500.05 },
  { ts: new Date(at - 120000).toISOString(), quality: "source_error", complete: false, pv_kw_avg: null, load_kw_reported_avg: null, grid_kw_avg: null },
  { ts: new Date(at - 60000).toISOString(), quality: "ok", complete: true, pv_kw_avg: 3.4, load_kw_reported_avg: 1.5, grid_kw_avg: -1.9, pv_kwh_total_end: 36500.1 },
];
const historyPayload = {
  resolution: "1m", from_utc: new Date(at - 3600000).toISOString(), to_utc: new Date(at).toISOString(),
  summary: { windows: rows.length, ok: 3, partial: 0, source_error: 1 }, windows: rows,
};
const location = { timezone: "America/Los_Angeles" };
const weather = { configured: true, location, stale: false, days: [], hours: [
  { ts: new Date(at - 3000000).toISOString(), cloud_cover_pct: 20, temperature_c: 21 },
  { ts: new Date(at - 600000).toISOString(), cloud_cover_pct: 35, temperature_c: 24 },
] };

const history = page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : historyPayload,
  "http://localhost/history.html?scenario=day");
await pause();
assert.equal(history.requests.filter((url) => url.startsWith("/api/v1/history")).length, 1);
assert.deepEqual(Array.from(history.get("chart").chartOption.series, (series) => series.name), ["Solar", "Cloud cover", "Grid in", "Grid out"]);
assert.equal(history.get("chart").chartHeight, 410);
assert.equal(history.get("chart").chartOption.xAxis[0].max > history.get("chart").chartOption.xAxis[0].min, true);
assert.match(history.get("energy-warning").textContent, /complete, aligned windows/);
assert.match(history.get("energy-sources").innerHTML, /What powered the home/);
assert.match(history.get("energy-destinations").innerHTML, /Where did solar go/);
assert.match(history.get("interval-values").textContent, /Coverage 3\/4/);
assert.equal(history.get("interval-overlay").hidden, false);
assert.doesNotMatch(history.get("period-span").textContent, /([A-Za-z]{3} \d{1,2})–\1/);
assert.equal(history.get("interval-from").value, String(Math.round((Date.parse(rows[0].ts) - Date.parse(historyPayload.from_utc)) / 60000)));
history.get("interval-from").handlers.input({ target: { value: String(Math.round((Date.parse(rows[2].ts) - Date.parse(historyPayload.from_utc)) / 60000)) } });
assert.match(history.get("interval-values").textContent, /Coverage 1\/2/);
assert.equal(history.get("interval-overlay").style.props["--interval-start"], history.get("interval-range").style.props["--interval-start"]);
const anchoredHistory = page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : historyPayload,
  "http://localhost/history.html#composition");
await pause();
assert.equal(anchoredHistory.get("composition").scrolled, true);
const zeroHistory = page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : {
    ...historyPayload, windows: rows.map((row) => ({ ...row, pv_kw_avg: row.complete ? 0 : null, grid_kw_avg: row.complete ? 1.4 : null })),
  });
await pause();
assert.match(zeroHistory.get("energy-destinations").innerHTML, /Less than 0.1 kWh of solar production/);
assert.doesNotMatch(zeroHistory.get("energy-destinations").innerHTML, /destination-bar/);
assert.match(modules.powerGridOption(rows, [], { width: 640, from: at - 45 * 60000, to: at, resolution: "1m", timezone: "UTC" }).xAxis[1].axisLabel.formatter(at), /\d{1,2}:\d{2} (?:AM|PM)/);
assert.match(modules.powerGridOption(rows, weather.hours, { width: 640, from: at - 3600000, to: at, resolution: "1m", timezone: "UTC", weatherLayer: "temperature" }).yAxis[1].name, /TEMPERATURE · °C/);
history.get("period-options").handlers.click({ target: { closest: () => ({ dataset: { period: "yesterday" } }) } });
assert.match(history.location.search, /scenario=day/);
assert.match(history.location.search, /period=yesterday/);
const restoredHistory = page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : historyPayload,
  history.location.href);
await pause();
assert.equal(restoredHistory.get("period-title").textContent, "Yesterday");
const customHistory = page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : historyPayload,
  `http://localhost/history.html?view=custom&from=${encodeURIComponent(historyPayload.from_utc)}&to=${encodeURIComponent(historyPayload.to_utc)}&metric=energy&weather=temperature`);
await pause();
assert.equal(customHistory.get("chart-title").textContent, "Energy by window");
assert.equal(customHistory.get("interval-controls").hidden, true);
assert.match(customHistory.get("chart-subtitle").textContent, /temperature/);
const weekHistory = page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : historyPayload,
  "http://localhost/history.html?view=7d&measure=home&weather=temperature");
await pause();
assert.equal(weekHistory.get("weather-controls").hidden, false);
assert.equal(weekHistory.get("weather-controls").open, true);
assert.equal(weekHistory.get("energy-legend").hidden, false);
assert.deepEqual(Array.from(weekHistory.get("chart").chartOption.series, (series) => series.name),
  ["Solar", "Home (estimated)", "Temperature", "Grid in", "Grid out"]);
weekHistory.get("weathers").handlers.click({ target: { closest: () => ({ dataset: { weather: "uv" } }) } });
assert.match(weekHistory.location.search, /weather=uv/);
assert.doesNotMatch(weekHistory.location.search, /measure=/);
assert.match(weekHistory.get("chart-note").textContent, /UV peaks/);
assert.equal(weekHistory.get("weather-toggle").textContent, "Weather · UV index");
assert.match(weekHistory.get("chart").chartOption.yAxis[1].name, /UV PEAK/);
page("history.js", (url) =>
  url.startsWith("/api/v1/location") ? location : url.startsWith("/api/v1/weather") ? weather : historyPayload,
  "http://localhost/history.html?view=__proto__");

const live = page("app.js", (url) => {
  if (url.startsWith("/api/v1/history")) return historyPayload;
  if (url.startsWith("/api/v1/weather")) return weather;
  if (url.startsWith("/api/v1/panels")) return { panels: [], slot_ts: new Date(at).toISOString() };
  if (url.startsWith("/api/v1/health")) return { state: "connected", events: [] };
  return { state: "live", measured_at_utc: new Date(at).toISOString(), received_at_utc: new Date(at).toISOString(),
    pv_kw: 3.4, load_kw_reported: 1.5, grid_kw: -1.9, pv_kwh_total: 36500.1 };
}, "http://localhost/index.html?scenario=day&view=hour&weather=temperature");
await pause();
assert.deepEqual(Array.from(live.get("chart").chartOption.series, (series) => series.name), ["Solar", "Temperature", "Grid in", "Grid out"]);
assert.equal(live.get("chart").chartHeight, 410);
assert.match(live.get("chart").chartOption.yAxis[1].name, /TEMPERATURE · °C/);
assert.match(live.get("period-solar").textContent, /kWh/);
assert.match(live.get("period-export").textContent, /kWh/);
assert.match(live.get("flow-grid-label").textContent, /export/i);
assert.equal(live.get("flow-pv").textContent, "3.4 kW");
assert.equal(live.get("flow-grid").textContent, "1.9 kW");
assert.equal(live.get("flow-note").hidden, true);
assert.match(live.get("reading-times").textContent, /Measured and received/);
assert.equal(live.get("weather-legend").hidden, true);
assert.equal(Number.isFinite(live.get("chart").chartOption.xAxis[0].max), true);
live.get("weathers").handlers.click({ target: { closest: () => ({ dataset: { weather: "precipitation" } }) } });
assert.match(live.location.search, /weather=precipitation/);
assert.match(live.get("chart").chartOption.yAxis[1].name, /PRECIPITATION · mm/);
assert.equal(live.get("weather-key").textContent, "Precipitation mm");
live.get("ranges").handlers.click({ target: { closest: () => ({ dataset: { range: "today" } }) } });
assert.match(live.location.search, /scenario=day/);
assert.match(live.location.search, /view=today/);

const staleLive = page("app.js", (url) => {
  if (url.startsWith("/api/v1/history")) return historyPayload;
  if (url.startsWith("/api/v1/weather")) return weather;
  if (url.startsWith("/api/v1/panels")) return { panels: [], slot_ts: new Date(at).toISOString() };
  if (url.startsWith("/api/v1/health")) return { state: "connected", events: [] };
  return { state: "stale", measured_at_utc: new Date(at - 3600000).toISOString(), received_at_utc: new Date(at).toISOString(),
    pv_kw: 3.4, load_kw_reported: 1.5, grid_kw: -1.9, pv_kwh_total: 36500.1 };
});
await pause();
assert.equal(staleLive.get("flow-pv").textContent, "—");
assert.equal(staleLive.get("flow-grid").textContent, "—");
assert.equal(staleLive.get("flow-note").hidden, true);
assert.match(staleLive.get("banner").textContent, /stale/);

const panelSlot = new Date(at - 5 * 60000).toISOString();
const panelReply = (url) => {
  if (url.startsWith("/api/v1/location")) return location;
  if (url.startsWith("/api/v1/live")) return { state: "live", pv_kw: 0.5 };
  const query = new URL(url, "http://localhost").searchParams;
  const historical = Date.parse(query.get("energy_to")) < at;
  const sampleAt = Date.parse(query.get("to")) < at ? Date.parse(query.get("from")) + 12 * 3600000 : at - 5 * 60000;
  if (url.includes("history=all")) return { panels: [
    { panel_id: "p01", samples: [{ ts: new Date(sampleAt - 5 * 60000).toISOString(), quality: "ok", ac_kw: 0.10 }, { ts: new Date(sampleAt).toISOString(), quality: "ok", ac_kw: 0.21 }] },
    { panel_id: "p02", samples: [{ ts: new Date(sampleAt - 5 * 60000).toISOString(), quality: "ok", ac_kw: 0.12 }, { ts: new Date(sampleAt).toISOString(), quality: "ok", ac_kw: 0.22 }] },
  ] };
  if (url.includes("panel_id=")) return { samples: [] };
  if (url.startsWith("/api/v1/weather")) return { days: [], hours: [] };
  return { slot_ts: panelSlot, slot_age_seconds: 300, panels: [
    { panel_id: "p01", ac_kw: 0.21, energy_kwh: historical ? 1 : 1.25, quality: "ok" },
    { panel_id: "p02", ac_kw: 0.22, energy_kwh: historical ? 2 : 2.5, quality: "ok" },
    { panel_id: "p03", ac_kw: null, energy_kwh: null, quality: null },
  ] };
};
const panelPage = page("panels.js", panelReply, "http://localhost/panels.html?scenario=day");
await pause();
assert.equal(panelPage.get("array-energy").textContent, "3.8 kWh");
assert.match(panelPage.get("array-coverage").textContent, /2\/3 panel counters/);
assert.equal(panelPage.get("chart").chartHeight, 360);
panelPage.get("chart").handlers.keydown({ key: "Home", preventDefault() {} });
assert.match(panelPage.get("slot-state").textContent, /Array median 0\.11 kW/);
panelPage.get("chart").handlers.pointermove({ clientX: 100 });
assert.match(panelPage.get("slot-state").textContent, /Array median 0\.21 kW/);
panelPage.get("chart").chartHandlers.mouseover({ seriesType: "line", seriesName: "p01", event: { offsetX: 100 } });
assert.match(panelPage.get("panel-hover-label").textContent, /p01.*0\.21 kW/);
panelPage.get("chart").chartHandlers.click({ seriesType: "line", seriesName: "p01" });
assert.match(panelPage.location.search, /panel=p01/);
assert.equal(panelPage.get("array-total").hidden, false);
assert.equal(panelPage.get("array-energy").textContent, "1.3 kWh");
assert.match(panelPage.get("array-coverage").textContent, /Stored panel counter/);
assert.equal(panelPage.get("chart").chartHeight, 360);
panelPage.get("all-panels").handlers.click();
assert.equal(panelPage.get("array-total").hidden, false);
assert.equal(panelPage.get("array-energy").textContent, "3.8 kWh");
panelPage.get("chart").handlers.keydown({ key: "Home", preventDefault() {} });
panelPage.get("chart").handlers.pointerdown({ clientX: 100, pointerType: "touch" });
assert.match(panelPage.get("slot-state").textContent, /Array median 0\.21 kW/);
panelPage.get("matrix").handlers.click({ target: { closest: () => ({ dataset: { panel: "p03" } }) } });
assert.equal(panelPage.get("array-total").hidden, false);
assert.equal(panelPage.get("array-energy").textContent, "—");
panelPage.get("matrix").handlers.click({ target: { closest: () => ({ dataset: { panel: "p01" } }) } });
panelPage.get("panel-date").value = "2026-03-08";
panelPage.get("panel-date").handlers.change();
assert.equal(panelPage.get("chart").chartOption, null);
assert.equal(panelPage.get("array-energy").textContent, "—");
await pause();
assert.match(panelPage.location.search, /date=2026-03-08/);
assert.match(panelPage.location.search, /panel=p01/);
assert.equal(panelPage.get("array-energy").textContent, "1.0 kWh");
assert.match(panelPage.get("array-label").textContent, /Mar 8/);
assert.equal(panelPage.get("chart").chartOption.xAxis.min, Date.parse("2026-03-08T08:00:00Z"));
assert.equal(panelPage.get("chart").chartOption.xAxis.max, Date.parse("2026-03-09T07:00:00Z"));
assert.match(panelPage.get("matrix").innerHTML, /1\.3 kWh/); // Live tiles keep today's counters.
panelPage.get("all-panels").handlers.click();
assert.equal(panelPage.get("array-energy").textContent, "3.0 kWh");
const restoredPanels = page("panels.js", panelReply, panelPage.location.href);
await pause();
assert.equal(restoredPanels.get("panel-date").value, "2026-03-08");
assert.equal(restoredPanels.get("array-energy").textContent, "3.0 kWh");
for (const invalidDate of ["", "2026-02-30", "2050-01-01"]) {
  panelPage.get("panel-date").value = invalidDate;
  panelPage.get("panel-date").handlers.change();
  assert.equal(panelPage.get("panel-date").value, "2026-03-08");
}
panelPage.get("panel-today").handlers.click();
await pause();
assert.doesNotMatch(panelPage.location.search, /date=/);
assert.equal(panelPage.get("array-energy").textContent, "3.8 kWh");
assert.equal(panelPage.get("array-label").textContent, "Panel production today");

let releaseOldOverview;
const racingPanels = page("panels.js", (url) => url.includes("history=all") && url.includes("2026-03-07T")
  ? new Promise((resolve) => { releaseOldOverview = () => resolve(panelReply(url)); }) : panelReply(url));
await pause();
racingPanels.get("panel-date").value = "2026-03-07";
racingPanels.get("panel-date").handlers.change();
racingPanels.get("panel-date").value = "2026-03-08";
racingPanels.get("panel-date").handlers.change();
await pause();
releaseOldOverview();
await pause();
assert.equal(racingPanels.get("chart").chartOption.xAxis.min, Date.parse("2026-03-08T08:00:00Z"));

const settings = page("settings.js", (url) => {
  if (url.startsWith("/api/v1/calibration")) return { grid_ratio: 1 };
  if (url.startsWith("/api/v1/health")) return { state: "connected", events: [] };
  if (url.startsWith("/api/v1/location")) return { configured: false };
  if (url.startsWith("/api/v1/weather")) return weather;
  return { grid_kw: 1, load_kw_reported: 2 };
});
await pause();
settings.get("grid-ratio").value = "";
settings.get("calibration-form").handlers.submit({ preventDefault() {} });
assert.match(settings.get("grid-ratio-error").textContent, /10 to 200/);
assert.equal(settings.get("grid-ratio").attrs["aria-invalid"], "true");
assert.equal(settings.focused(), "grid-ratio");
assert.equal(settings.get("city-entry").hidden, true);
settings.get("city-toggle").handlers.click();
assert.equal(settings.get("city-entry").hidden, false);
assert.equal(settings.get("city-toggle").attrs["aria-expanded"], "true");
settings.get("city-form").handlers.submit({ preventDefault() {} });
assert.match(settings.get("city-error").textContent, /city or ZIP/);
assert.equal(settings.focused(), "city");
settings.get("city-toggle").handlers.click();
assert.equal(settings.get("city-entry").hidden, true);
assert.equal(settings.get("city-toggle").attrs["aria-expanded"], "false");
const savedSettings = page("settings.js", (url) => {
  if (url.startsWith("/api/v1/location")) return { configured: true, latitude: 37.29, longitude: -122.018, timezone: "America/Los_Angeles", source: "browser_geolocation" };
  if (url.startsWith("/api/v1/calibration")) return { grid_ratio: 1 };
  if (url.startsWith("/api/v1/health")) return { state: "connected", events: [] };
  if (url.startsWith("/api/v1/weather")) return weather;
  return { grid_kw: 1, load_kw_reported: 2 };
});
await pause();
assert.match(savedSettings.get("current").innerHTML, /37\.290° N, 122\.018° W/);
assert.match(savedSettings.get("current").innerHTML, /openstreetmap\.org\/\?mlat=37\.29&mlon=-122\.018/);
let notificationFixture = { configured: false, enabled: false, state: "normal", monitoring: "paused" };
const notificationWrites = [];
let rejectNotification = false;
const notificationPage = page("settings.js", (url, options = {}) => {
  if (url.startsWith("/api/v1/notifications")) {
    if (options.method) {
      notificationWrites.push({ method: options.method, body: options.body && JSON.parse(options.body) });
      if (rejectNotification) return new Response(JSON.stringify({ error: "bark_rejected" }), { status: 502 });
      if (options.method === "PUT") {
        notificationFixture = { ...notificationFixture, configured: true, enabled: JSON.parse(options.body).enabled, test_sent: JSON.parse(options.body).enabled };
      } else if (options.method === "DELETE") notificationFixture = { configured: false, enabled: false, state: "normal", monitoring: "paused" };
      return { ...notificationFixture, test_sent: options.method === "POST" || options.method === "PUT" && notificationFixture.enabled };
    }
    return notificationFixture;
  }
  if (url.startsWith("/api/v1/location")) return { configured: false };
  if (url.startsWith("/api/v1/calibration")) return { grid_ratio: 1 };
  if (url.startsWith("/api/v1/weather")) return weather;
  if (url.startsWith("/api/v1/health")) return { state: "collecting", events: [] };
  return {};
});
await pause();
assert.match(notificationPage.get("notification-facts").innerHTML, /Not configured/);
assert.equal(notificationPage.get("notification-test").hidden, true);
notificationPage.get("notification-form").handlers.submit({ preventDefault() {} });
assert.match(notificationPage.get("bark-key-error").textContent, /Paste your Bark/);
assert.equal(notificationWrites.length, 0);
notificationPage.get("bark-key").value = "synthetic-bark-device";
notificationPage.get("bark-key").handlers.input();
notificationPage.get("notification-form").handlers.submit({ preventDefault() {} });
assert.equal(notificationPage.get("bark-key").value, "");
assert.equal(notificationPage.get("notification-save").disabled, true);
await pause();
assert.deepEqual(notificationWrites[0], { method: "PUT", body: { enabled: true, device_key: "synthetic-bark-device" } });
assert.match(notificationPage.get("notification-status").textContent, /Test submitted/);
assert.equal(notificationPage.get("notification-pause").hidden, false);
notificationPage.get("notification-test").handlers.click();
await pause();
assert.deepEqual(notificationWrites[1], { method: "POST", body: {} });
notificationPage.get("notification-pause").handlers.click();
await pause();
assert.equal(notificationPage.get("notification-pause").hidden, true);
assert.match(notificationPage.get("notification-status").textContent, /paused/);
notificationPage.get("notification-form").handlers.submit({ preventDefault() {} });
await pause();
assert.deepEqual(notificationWrites[3].body, { enabled: true });
rejectNotification = true;
notificationPage.get("notification-test").handlers.click();
await pause();
assert.match(notificationPage.get("notification-status").textContent, /Bark rejected/);
assert.equal(notificationPage.get("notification-test").disabled, false);
rejectNotification = false;
notificationPage.get("notification-delete").handlers.click();
await pause();
assert.match(notificationPage.get("notification-facts").innerHTML, /Not configured/);
assert.equal(notificationPage.get("notification-delete").hidden, true);

const readOnlyNotifications = page("settings.js", (url) => url.startsWith("/api/v1/notifications") ? {
  configured: false, enabled: false, read_only: true,
} : {});
await pause();
assert.equal(readOnlyNotifications.get("bark-key").disabled, true);
assert.equal(readOnlyNotifications.get("notification-save").disabled, true);
console.log("page render checks passed");
