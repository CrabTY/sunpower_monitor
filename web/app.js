/* Live page: real /api/v1/live, /api/v1/history, /api/v1/health, and /api/v1/weather data only. */

import { daylightVerdict, formatDaylightDuration, weatherText } from "./insights.js";
import { calibrateHistory, calibrateLive, gridRatio } from "./calibration.js";
import { initWeatherControls } from "./weather-controls.js";
import { powerGridOption } from "./energy-plot.js";
import { chartPalette, chartXValueAt, clearEChart, renderEChart } from "./chart-engine.bundle.js";
import {
  RESOLUTION_MS,
  WEATHER_LAYERS,
  alignedEnergy,
  counterDelta,
  exportStats,
  num,
  weatherBounds,
} from "./chart.js";

var POLL_MS = 10000;
var HEALTH_MS = 30000;
var WEATHER_MS = 600000;
var WEATHER_WINDOW_MS = 36 * 3600000;
// Three minutes, not one: the stored curve is a minute-resolution record, and
// every poll re-reads its whole range. At one minute with a day on screen that
// was about two million D1 row reads a day against a five million free budget.
var HISTORY_MS = 180000;
var HISTORY_WINDOW_MS = 60 * 60000;
var HOVER_HINT = "Tap or hover the chart to read one window. Keyboard: focus chart, then use arrow keys.";
var DASH = "\u2014";
var DISPLAY_KW = 0.05;

var state = { live: null, health: null, weather: null, history: null, panels: null, range: "sofar", weatherLayer: "cloud" };

function el(id) {
  return document.getElementById(id);
}

function localInput(moment) {
  return new Date(moment.getTime() - moment.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function readUrl() {
  var params = new URLSearchParams(window.location.search);
  var view = params.get("view");
  if (["hour", "sofar", "daylight", "today"].includes(view)) state.range = view;
  if (view === "custom") {
    var from = new Date(params.get("from") || "");
    var to = new Date(params.get("to") || "");
    if (isFinite(from.getTime()) && isFinite(to.getTime()) && to > from) {
      state.range = "custom";
      el("from").value = localInput(from);
      el("to").value = localInput(to);
    }
  }
  state.weatherLayer = Object.prototype.hasOwnProperty.call(WEATHER_LAYERS, params.get("weather")) ? params.get("weather") : "cloud";
  el("ranges").querySelectorAll("button").forEach(function (button) {
    button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
  });
  el("weathers").querySelectorAll("button").forEach(function (button) {
    button.setAttribute("aria-pressed", String(button.dataset.weather === state.weatherLayer));
  });
}

function writeUrl() {
  var url = new URL(window.location.href);
  ["view", "weather", "layout", "from", "to"].forEach(function (key) { url.searchParams.delete(key); });
  if (state.range !== "sofar") url.searchParams.set("view", state.range);
  if (state.range === "custom") {
    var chosen = rangeWindow("custom");
    if (chosen) {
      url.searchParams.set("from", chosen.from.toISOString());
      url.searchParams.set("to", chosen.to.toISOString());
    }
  }
  if (state.weatherLayer !== "cloud") url.searchParams.set("weather", state.weatherLayer);
  window.history.replaceState(null, "", url);
}

function formatKw(value) {
  var figure = num(value);
  return figure === null ? DASH : figure.toFixed(1) + " kW";
}

function formatKwh(value) {
  var figure = num(value);
  return figure === null ? DASH : figure.toFixed(1) + " kWh";
}

function formatTime(iso) {
  if (!iso) return DASH;
  var when = new Date(iso);
  if (isNaN(when.getTime())) return DASH;
  return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

function round(value, digits) {
  return value === null ? DASH : value.toFixed(digits);
}

function label(current) {
  if (current === "live") return "Live";
  if (current === "delayed") return "Delayed";
  if (current === "stale") return "Stale";
  return "No data";
}

function getJson(path) {
  return fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" }).then(function (response) {
    if (response.status === 401) {
      window.location.href = "/auth/login";
      return null;
    }
    if (!response.ok) throw new Error("status " + response.status);
    return response.json();
  });
}

function renderLive() {
  var data = state.live;
  if (!data) return;
  var current = data.state || "unavailable";
  el("calibration-note").textContent = "Grid/home estimates use " +
    (gridRatio(data) * 100).toFixed(1) + "% calibration.";
  var measuredAt = formatTime(data.measured_at_utc);
  el("state").textContent = window.innerWidth <= 520
    ? label(current) + " \u00b7 " + (measuredAt === DASH ? DASH : new Date(data.measured_at_utc).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))
    : label(current) + " \u00b7 measured " + measuredAt;
  el("state").title = label(current) + " \u00b7 measured " + measuredAt;
  el("state").dataset.state = current;

  var grid = num(data.grid_kw);
  var measured = formatTime(data.measured_at_utc), received = formatTime(data.received_at_utc);
  el("reading-times").textContent = measured === received
    ? "Measured and received " + measured
    : "Measured " + measured + " · received " + received;
  el("last-known").textContent =
    grid === null ? DASH : formatKw(Math.abs(grid)) + " (" + formatTime(data.measured_at_utc) + ")";
  el("last-known-row").hidden = (current === "live" || current === "delayed") || grid === null;
  el("lifetime").textContent = formatKwh(data.pv_kwh_total);
  renderFlow();

  var banner = el("banner");
  if (current === "stale") {
    banner.hidden = false;
    banner.textContent = "Readings are stale: the last PVS measurement is " + data.age_seconds + " seconds old.";
  } else if (current === "unavailable") {
    banner.hidden = false;
    banner.textContent = "No cloud readings yet. The collector has not uploaded a measurement time.";
  } else {
    banner.hidden = true;
  }
  renderSolarNote();
}

function statText(value, note) {
  if (value === null) return DASH;
  return value.toFixed(2) + " kW \u00b7 " + note;
}

function weatherHours() {
  return state.weather && state.weather.configured && state.weather.hours ? state.weather.hours : [];
}

/** The forecast hour closest to a chart point, so hover shows the same hour. */
function weatherNear(ts) {
  var best = null;
  var distance = Infinity;
  weatherHours().forEach(function (hour) {
    var when = Date.parse(hour.ts);
    if (!isFinite(when)) return;
    var gap = Math.abs(when - ts);
    if (gap < distance) {
      distance = gap;
      best = hour;
    }
  });
  return distance <= 90 * 60000 ? best : null;
}

function renderWeatherLegend() {
  var layer = WEATHER_LAYERS[state.weatherLayer];
  el("weather-toggle").textContent = "Weather · " + layer.label;
  el("weather-key").textContent = layer.label + " " + layer.unit;
  // The swatch, the line, and the right axis share one colour.
  el("weather-key").style.setProperty("--weather", layer.color);
  var weather = state.weather;
  var note = el("weather-legend");
  if (!weather) {
    note.textContent = "Forecast unavailable; power readings are unaffected.";
    note.hidden = false;
    return;
  }
  if (!weather.configured) {
    note.textContent = "Confirm the site location in Settings to show weather.";
    note.hidden = false;
    return;
  }
  var route = rangeWindow(state.range);
  if (route === null || weatherBounds(weatherHours(), layer, route.from.getTime(), route.to.getTime()) === null) {
    note.textContent = "No forecast for this range.";
    note.hidden = false;
    return;
  }
  note.textContent = weather.stale ? "Forecast may be out of date." : "";
  note.hidden = !weather.stale;
}

/** Offset of the site time zone right now, so "today" means the site's day. */
function siteOffsetMs() {
  var timezone = state.weather && state.weather.location ? state.weather.location.timezone : null;
  if (!timezone) return new Date().getTimezoneOffset() * -60000;
  try {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(new Date());
    var name = "";
    parts.forEach(function (part) {
      if (part.type === "timeZoneName") name = part.value;
    });
    var match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    if (!match) return 0;
    var sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3])) * 60000;
  } catch (error) {
    return new Date().getTimezoneOffset() * -60000;
  }
}

function localMidnight(now) {
  var offset = siteOffsetMs();
  return new Date(Math.floor((now.getTime() + offset) / 86400000) * 86400000 - offset);
}

/** The window the chart asks for; null means this range cannot be shown yet. */
function rangeWindow(name) {
  var now = new Date();
  if (name === "sofar") {
    var midnight = localMidnight(now);
    return { from: midnight, to: now, axisTo: new Date(midnight.getTime() + 86400000), label: "day so far" };
  }
  if (name === "daylight") {
    var day = dayEntry();
    if (day === null || !day.sunrise_utc || !day.sunset_utc) return null;
    var rise = Date.parse(day.sunrise_utc);
    var set = Date.parse(day.sunset_utc);
    if (!isFinite(rise) || !isFinite(set) || set <= rise) return null;
    // The whole daylight window stays on the axis; the hours after now are blank.
    return { from: new Date(rise), to: new Date(set), label: "today's daylight" };
  }
  if (name === "today") {
    var midnight = localMidnight(now);
    // A full day means 00:00 to 24:00 in the site's time zone, not 00:00 to now.
    return { from: midnight, to: new Date(midnight.getTime() + 86400000), label: "today" };
  }
  if (name === "custom") {
    var from = el("from").value ? new Date(el("from").value) : null;
    var to = el("to").value ? new Date(el("to").value) : null;
    if (from === null || to === null || isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return null;
    return { from: from, to: to, label: "the chosen range" };
  }
  return { from: new Date(now.getTime() - HISTORY_WINDOW_MS), to: now, label: "last 60 minutes" };
}

function windowText(window) {
  if (window.quality !== "ok" || window.complete !== true) {
    return formatTime(window.ts) + " \u00b7 no complete reading (" + (window.quality || "unknown") + ")";
  }
  var layer = WEATHER_LAYERS[state.weatherLayer];
  var hour = weatherNear(Date.parse(window.ts));
  var weather = hour && num(hour[layer.key]) !== null ? " \u00b7 " + layer.label + " " + num(hour[layer.key]).toFixed(layer.digits) + " " + layer.unit : "";
  return (
    formatTime(window.ts) +
    " \u00b7 Solar " + formatKw(window.pv_kw_avg) +
    " \u00b7 Home " + formatKw(window.load_kw_reported_avg) +
    " \u00b7 Grid " + formatKw(window.grid_kw_avg) +
    weather +
    (window.quality === "ok" ? "" : " \u00b7 " + (window.quality || "unknown"))
  );
}

function renderChart() {
  var container = el("chart");
  var data = state.history;
  var windows = (data && data.windows) || [];
  var route = rangeWindow(state.range);
  var label = route === null ? state.range : route.label;
  var stats = exportStats(windows, Date.now(), 30);
  var failed = windows.filter(function (window) {
    return window.quality !== "ok";
  }).length;

  el("export-mean30").textContent = statText(stats.mean30, stats.valid30 + " valid minutes");
  el("export-mean60").textContent = statText(stats.mean60, stats.valid60 + " valid minutes");
  el("export-low").textContent =
    stats.low30 === null
      ? DASH
      : stats.low30.toFixed(2) + " kW \u00b7 " + stats.low_slots + " complete 5-minute windows";

  var energy = counterDelta(windows, "pv_kwh_total_end");
  el("energy-label").textContent = state.range === "sofar" ? "Solar energy today" : "Solar energy \u00b7 " + label;
  el("range-energy").textContent = energy === null ? DASH : energy.toFixed(1) + " kWh \u00b7 lifetime counter";

  if (windows.length === 0) {
    clearEChart(container, "No stored windows yet. Missing data is not zero.");
    el("period-coverage").textContent = "No stored readings";
    ["solar", "home", "import", "export"].forEach(function (key) { el("period-" + key).textContent = DASH; });
    el("chart-state").textContent = data === null ? "Loading\u2026" : "No stored minute records for " + label + ".";
    el("chart-state").hidden = false;
    el("chart-detail").textContent = HOVER_HINT;
    return;
  }

  el("chart-title").textContent = window.innerWidth <= 520 ? "Solar & grid" : "Solar shape & grid direction · " + label;
  var times = windows.map(function (row) { return Date.parse(row.ts); });
  var start = route.from.getTime();
  var span = Math.max((route.axisTo || route.to).getTime() - start, 60000);
  var step = RESOLUTION_MS[(data && data.resolution) || "1m"] || 60000;
  var compact = container.clientWidth < 520;
  el("solar-key").textContent = "Solar power";
  renderEChart(container, powerGridOption(windows, weatherHours(), {
    width: container.clientWidth || 640, from: start, to: start + span,
    resolution: (data && data.resolution) || "1m",
    timezone: state.weather && state.weather.location && state.weather.location.timezone,
    weatherLayer: state.weatherLayer, layout: "combined",
    plotHeight: compact ? 174 : 320,
    daylightDays: state.weather && state.weather.configured ? state.weather.days : [],
    palette: chartPalette(),
  }), compact ? 258 : 410);
  container.tabIndex = 0;
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Solar power, grid direction, and forecast weather; use arrow keys for stored readings");
  container.setAttribute("aria-describedby", "chart-detail");
  var energyTotals = alignedEnergy(windows, step, start, Math.min(start + span, Date.now()),
    state.weather && state.weather.location && state.weather.location.timezone);
  ["solar", "home", "import", "export"].forEach(function (key) {
    var target = el("period-" + key);
    target.textContent = energyTotals.valid ? energyTotals[key].toFixed(1) + " kWh" : DASH;
  });
  el("period-coverage").textContent = energyTotals.valid + "/" + energyTotals.expected + " complete";
  var missingMinutes = failed * step / 60000;
  el("chart-state").textContent = (failed === 0 ? "" :
    missingMinutes + (missingMinutes === 1 ? " minute has" : " minutes have") +
      " no PVS reading in this range; the gap is not zero.") +
    (data && data.truncated ? " Range truncated; choose a shorter range." : "");
  el("chart-state").hidden = !el("chart-state").textContent;
  el("chart-detail").textContent = HOVER_HINT;
  if (state.range !== "hour") {
    el("weather-current").textContent = "Forecast weather is shown on the same time axis as solar output.";
  }
  renderWeatherLegend();

  var focusedIndex = windows.length - 1;
  function showWindow(index, event) {
    focusedIndex = index;
    var reading = windowText(windows[index]);
    el("chart-detail").textContent = reading;
    var tip = el("chart-tooltip");
    tip.hidden = !event;
    if (event) {
      tip.textContent = reading;
      tip.style.left = Math.min(window.innerWidth - 200, event.clientX + 12) + "px";
      tip.style.top = Math.max(8, event.clientY - 48) + "px";
    }
  }
  function pickPointer(event) {
    var wanted = chartXValueAt(container, event.clientX);
    if (wanted === null) return;
    var index = 0;
    var best = Infinity;
    times.forEach(function (ts, position) {
      var distance = Math.abs(ts - wanted);
      if (distance < best) {
        best = distance;
        index = position;
      }
    });
    showWindow(index, event);
  }
  container.onpointermove = pickPointer;
  container.onpointerdown = pickPointer;
  container.onfocus = function () { showWindow(focusedIndex, null); };
  container.onkeydown = function (event) {
    if (event.key === "ArrowLeft") focusedIndex = Math.max(0, focusedIndex - 1);
    else if (event.key === "ArrowRight") focusedIndex = Math.min(windows.length - 1, focusedIndex + 1);
    else if (event.key === "Home") focusedIndex = 0;
    else if (event.key === "End") focusedIndex = windows.length - 1;
    else return;
    event.preventDefault();
    showWindow(focusedIndex, null);
  };
  container.onpointerleave = function () {
    el("chart-detail").textContent = HOVER_HINT;
    el("chart-tooltip").hidden = true;
  };
}

/** What the numbers say happened now: no recommendation, no charger control. */
function renderFlow() {
  var live = state.live;
  if (!live) return;
  var pv = num(live.pv_kw);
  var home = num(live.load_kw_reported);
  var grid = num(live.grid_kw);
  var stale = live.state !== "live" && live.state !== "delayed";
  if (stale) pv = home = grid = null;
  var balance = pv === null || home === null ? null : pv - home;
  el("flow-pv").textContent = formatKw(pv);
  el("flow-home").textContent = formatKw(home);
  el("flow-grid").textContent = formatKw(grid === null ? null : Math.abs(grid));
  el("flow-grid-label").textContent =
    grid === null || Math.abs(grid) < DISPLAY_KW ? "Grid (estimated)" : grid > 0 ? "Grid import (estimated)" : "Grid export (estimated)";
  // The link travels towards home, and flips when the site is importing.
  flowLink("flow-solar-link", stale || pv === null || pv < DISPLAY_KW ? "idle" : "forward");
  flowLink("flow-grid-link", stale || grid === null || Math.abs(grid) < DISPLAY_KW ? "idle" : grid > 0 ? "reverse" : "forward");
  // Solar minus home should equal minus grid; a mismatch is reported, not hidden.
  var note = el("flow-note");
  note.textContent = balance !== null && grid !== null && Math.abs(balance + grid) > 0.05
    ? "Solar, home and grid estimates do not balance right now."
    : "";
  note.hidden = !note.textContent;
}

function flowLink(id, direction) {
  var base = id === "flow-grid-link" ? "energy-link grid-link" : "energy-link";
  el(id).setAttribute("class", base + " " + direction);
}

function renderError() {
  el("state").textContent = "Cloud unreachable";
  el("state").dataset.state = "unavailable";
  el("flow-pv").textContent = DASH;
  el("flow-home").textContent = DASH;
  el("flow-grid").textContent = DASH;
  el("flow-grid-label").textContent = "Grid (estimated)";
  flowLink("flow-solar-link", "idle");
  flowLink("flow-grid-link", "idle");
  el("flow-note").textContent = "";
  el("flow-note").hidden = true;
  var banner = el("banner");
  banner.hidden = false;
  banner.textContent = "Could not read /api/v1/live from this browser. Values are unknown, not zero.";
}

function siteDate(iso) {
  var timezone = state.weather && state.weather.location ? state.weather.location.timezone : null;
  if (!timezone) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso),
    );
  } catch (error) {
    return iso.slice(0, 10);
  }
}

function dayEntry() {
  if (!state.weather || !state.weather.configured) return null;
  var today = siteDate(new Date().toISOString());
  var days = state.weather.days || [];
  for (var index = 0; index < days.length; index += 1) {
    if (days[index].date === today) return days[index];
  }
  return null;
}

function hourEntry() {
  var hours = (state.weather && state.weather.hours) || [];
  var now = Date.now();
  var found = null;
  for (var index = 0; index < hours.length; index += 1) {
    if (Date.parse(hours[index].ts) <= now) found = hours[index];
  }
  return found || hours[0] || null;
}

function renderWeather() {
  var weather = state.weather;
  if (!weather) return;
  if (!weather.configured) {
    el("weather-now").textContent = "No site location yet. Confirm one on the Settings page.";
    el("weather-current").textContent = "Weather unavailable until a site location is confirmed.";
    el("weather-brief").textContent = "Forecast unavailable";
  } else {
    var hour = hourEntry();
    var stored = (weather.hours || []).length;
    if (hour === null) {
      el("weather-now").textContent =
        stored === 0 ? "Waiting for the first hourly sync (about :17)." : "No stored forecast for this hour.";
      el("weather-current").textContent = "No forecast hour stored for now.";
      el("weather-brief").textContent = "Waiting for forecast";
    } else {
      el("weather-current").textContent = "Forecast now · " + round(num(hour.temperature_c), 1) + " °C · UV " +
        round(num(hour.uv_index), 1) + " · cloud " + round(num(hour.cloud_cover_pct), 0) + "%";
      el("weather-now").textContent =
        "Cloud " + round(num(hour.cloud_cover_pct), 0) + "%" +
        " · rain " + round(num(hour.precipitation_mm), 1) + " mm (" +
        round(num(hour.precipitation_probability_pct), 0) + "%)" +
        " · UV " + round(num(hour.uv_index), 1);
      el("weather-brief").textContent = weatherText(hour.weather_code) + " · " + round(num(hour.temperature_c), 0) + " °C";
    }
  }
  var day = dayEntry();
  el("sunshine-brief").textContent = day && num(day.sunshine_duration_seconds) !== null
    ? formatDaylightDuration(day.sunshine_duration_seconds) : "Not recorded";
  el("daylight").textContent = !day || !day.sunrise_utc || !day.sunset_utc ? DASH :
    formatTime(day.sunrise_utc) + " – " + formatTime(day.sunset_utc) + " · " +
    formatDaylightDuration(day.daylight_seconds);
  renderPanels();
  renderSolarNote();
}

function renderSolarNote() {
  var note = el("solar-note");
  if (!state.live || !state.weather) {
    note.hidden = true;
    return;
  }
  var day = dayEntry();
  var freshness = state.live.state;
  var verdict = daylightVerdict({
    hasLocation: Boolean(state.weather.configured),
    weatherStored: Boolean(
      state.weather && ((state.weather.hours || []).length > 0 || (state.weather.days || []).length > 0),
    ),
    sunriseUtc: day === null ? null : day.sunrise_utc,
    sunsetUtc: day === null ? null : day.sunset_utc,
    nowUtc: Date.now(),
    weatherStale: Boolean(state.weather.stale || (day !== null && day.stale)),
    powerFresh: freshness === "live" || freshness === "delayed",
    pvKw: num(state.live.pv_kw),
  });
  var show = verdict.state === "insufficient" || verdict.state === "no_production" || verdict.state === "no_location";
  note.hidden = !show;
  note.dataset.state = verdict.state;
  note.textContent = show ? verdict.message : "";
}

function renderOnboarding() {
  var health = state.health;
  if (!health) return;
  var steps = [
    {
      done: health.authenticated_upload === true,
      title: "Authenticated upload from the Pi",
      detail: health.authenticated_upload
        ? "Last upload " + formatTime(health.last_received_at_utc)
        : "Waiting for the first signed upload from the Pi.",
    },
    {
      done: health.valid_measurement === true,
      title: "Valid PVS measurement",
      detail: health.valid_measurement
        ? "Last measurement " + formatTime(health.last_measured_at_utc) + " \u00b7 quality " + (health.latest_quality || "unknown")
        : "Waiting for a site reading with a usable measurement time.",
    },
    {
      done: health.panels_discovered === true,
      title: "Panel list",
      detail: health.panels_discovered
        ? health.known_panels + " panels stored; last slot " + formatTime(health.last_panel_slot_at_utc)
        : "Waiting for the panel list. An absent list is not the same as offline panels.",
    },
  ];
  el("steps").innerHTML = steps
    .map(function (step) {
      return (
        '<li class="step" data-done="' + String(step.done) + '"><strong>' + (step.done ? "Done" : "Pending") +
        "</strong> \u00b7 " + step.title + '<br /><span class="note">' + step.detail + "</span></li>"
      );
    })
    .join("");
  // Stay visible until the panel list arrives too: a list that has not arrived
  // is not the same as panels being offline.
  el("onboarding").hidden =
    health.authenticated_upload === true && health.valid_measurement === true && health.panels_discovered === true;
}

function refreshLive() {
  getJson("/api/v1/live")
    .then(function (data) {
      if (data) {
        state.live = calibrateLive(data);
        renderLive();
      }
    })
    .catch(renderError);
}

function refreshHistory() {
  var window = rangeWindow(state.range);
  if (window === null) {
    state.history = { windows: [] };
    el("chart-detail").textContent = HOVER_HINT;
    renderChart();
    el("chart-state").textContent =
      state.range === "daylight"
        ? "Daylight needs a confirmed site location and stored sunrise/sunset."
        : "Pick a start and end time, with the end after the start.";
    el("chart-state").hidden = false;
    return;
  }
  // No resolution parameter: the Worker picks 1m up to two days, then 5m.
  var path =
    "/api/v1/history?from=" + window.from.toISOString() + "&to=" + window.to.toISOString();
  getJson(path)
    .then(function (data) {
      if (data) {
        state.history = calibrateHistory(data);
        renderChart();
      }
    })
    .catch(function () {
      el("chart-state").textContent = "Could not read /api/v1/history from this browser.";
      el("chart-state").hidden = false;
    });
}

function renderPanels() {
  var data = state.panels;
  if (!data) return;
  var panels = data.panels || [];
  var reported = panels.filter(function (panel) {
    return typeof panel.measured_at_utc === "string" && panel.measured_at_utc.length > 0;
  }).length;
  var day = dayEntry();
  var night = day && (Date.now() < Date.parse(day.sunrise_utc) || Date.now() > Date.parse(day.sunset_utc));
  el("panel-status").textContent = panels.length === 0
    ? "No panel samples stored yet."
    : night
      ? panels.length + " panels tracked today \u00b7 last daytime slot " + formatTime(data.slot_ts)
      : reported + " / " + panels.length + " reported in latest slot " + formatTime(data.slot_ts);
}

function refreshPanels() {
  getJson("/api/v1/panels")
    .then(function (data) {
      if (data) {
        state.panels = data;
        renderPanels();
      }
    })
    .catch(function () {});
}

function refreshHealth() {
  getJson("/api/v1/health")
    .then(function (data) {
      if (data) {
        state.health = data;
        renderOnboarding();
      }
    })
    .catch(function () {});
}

function refreshWeather() {
  var now = Date.now();
  var path =
    "/api/v1/weather?from=" + new Date(now - WEATHER_WINDOW_MS).toISOString() +
    "&to=" + new Date(now + WEATHER_WINDOW_MS).toISOString();
  getJson(path)
    .then(function (data) {
      if (data) {
        state.weather = data;
        renderWeather();
        renderWeatherLegend();
        renderChart();
        if (state.range === "daylight") refreshHistory();
      }
    })
    .catch(function () {});
}

el("ranges").addEventListener("click", function (event) {
  var button = event.target.closest("button[data-range]");
  if (!button) return;
  state.range = button.dataset.range;
  writeUrl();
  [].forEach.call(el("ranges").querySelectorAll("button"), function (item) {
    item.setAttribute("aria-pressed", String(item === button));
  });
  refreshHistory();
});

el("custom").addEventListener("submit", function (event) {
  event.preventDefault();
  if (!rangeWindow("custom")) {
    el("chart-state").textContent = "Pick a start and end time, with the end after the start.";
    el("chart-state").hidden = false;
    return;
  }
  state.range = "custom";
  writeUrl();
  [].forEach.call(el("ranges").querySelectorAll("button"), function (item) {
    item.setAttribute("aria-pressed", "false");
  });
  refreshHistory();
});

el("weathers").addEventListener("click", function (event) {
  var button = event.target.closest("button[data-weather]");
  if (!button) return;
  state.weatherLayer = button.dataset.weather;
  writeUrl();
  [].forEach.call(el("weathers").querySelectorAll("button"), function (item) {
    item.setAttribute("aria-pressed", String(item === button));
  });
  renderChart();
});

initWeatherControls(el("weather-controls"), window.matchMedia("(max-width: 1000px)"));
readUrl();
refreshLive();
refreshHistory();
refreshHealth();
refreshWeather();
refreshPanels();
window.setInterval(refreshLive, POLL_MS);
window.setInterval(refreshHistory, HISTORY_MS);
window.setInterval(refreshHealth, HEALTH_MS);
window.setInterval(refreshWeather, WEATHER_MS);
window.setInterval(refreshPanels, 5 * 60000);
var resizeTimer = null;
window.addEventListener("resize", function () {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(function () { renderLive(); renderChart(); }, 150);
});
