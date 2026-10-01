/* Panels page: array overview, selectable panel detail, and stored facts. */

import { num, zoneOffsetMs } from "./chart.js";
import { chartPalette, chartXValueAt, clearEChart, renderEChart } from "./chart-engine.bundle.js";

var DASH = "\u2014";
var DAY_MS = 24 * 3600000;
var HOUR_MS = 3600000;
// A tile or an array is producing only above this floor. A sleeping
// microinverter and the site reading still show a watt or two, so anything
// under a few tens of watts is night, not production. Tune with real readings.
var PRODUCING_KW = 0.05;
// The existing collector uploads a slot on the next five-minute read.
var CURRENT_SLOT_SECONDS = 10 * 60;
// One weather layer at a time on the daily chart. Each is the day's own
// aggregate of the hourly forecast rows: cloud and temperature average, UV
// peaks, rain sums.
var WEATHER_DAILY = {
  cloud: { key: "cloud_cover_pct", label: "Cloud cover", unit: "%", digits: 0, aggregate: "mean", color: "#2f8fbf", min: 0, max: 100 },
  temperature: { key: "temperature_c", label: "Temperature", unit: "\u00b0C", digits: 1, aggregate: "mean", color: "#c76b3f" },
  uv: { key: "uv_index", label: "UV index", unit: "", digits: 1, aggregate: "max", color: "#8e6fc9", min: 0 },
  precipitation: { key: "precipitation_mm", label: "Precipitation", unit: "mm", digits: 2, aggregate: "sum", color: "#2f8fbf", min: 0 },
};
// One word per state, and the same word in the colour key on the page.
var STATE_NOTE = {
  producing: "producing",
  done: "finished today",
  pending: "no panel readings today",
  idle: "no production recorded",
  problem: "not reporting",
};
var state = {
  timezone: null,
  dayFrom: null,
  dayTo: null,
  chartDate: null,
  chartEnergy: null,
  overviewRequestId: 0,
  live: null,
  latest: null,
  daylight: null,
  panelId: null,
  overview: null,
  problemIds: [],
  history: null,
  hover: null,
  scale: null,
  daily: { days: 7, from: null, to: null, range: "preset", samples: null, weather: null, hover: null, scale: null, layer: "cloud", requestId: 0 },
};
var initialQuery = new URLSearchParams(window.location.search);

function el(id) {
  return document.getElementById(id);
}

function writeUrl() {
  var url = new URL(window.location.href);
  ["panel", "date", "measure", "days", "from", "to", "weather"].forEach(function (key) { url.searchParams.delete(key); });
  if (state.panelId) url.searchParams.set("panel", state.panelId);
  if (state.chartDate) url.searchParams.set("date", state.chartDate);
  if (state.daily.range === "custom") {
    url.searchParams.set("from", dayDate(state.daily.from));
    url.searchParams.set("to", dayDate(state.daily.to));
  } else if (state.daily.days !== 7) url.searchParams.set("days", String(state.daily.days));
  if (state.daily.layer !== "cloud") url.searchParams.set("weather", state.daily.layer);
  window.history.replaceState(null, "", url);
}

function restoreUrl() {
  var date = initialQuery.get("date");
  var start = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? siteDayFromInput(date) : null;
  if (start !== null && dayDate(start) === date && start <= state.dayFrom) {
    state.chartDate = start === state.dayFrom ? null : date;
  }
  el("panel-date").value = state.chartDate || dayDate(state.dayFrom);
  el("panel-date").max = dayDate(state.dayFrom);
  state.daily.days = initialQuery.get("days") === "30" ? 30 : 7;
  if (Object.prototype.hasOwnProperty.call(WEATHER_DAILY, initialQuery.get("weather"))) state.daily.layer = initialQuery.get("weather");
  var fromText = initialQuery.get("from"), toText = initialQuery.get("to");
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromText || "") && /^\d{4}-\d{2}-\d{2}$/.test(toText || "")) {
    var from = siteDayFromInput(fromText), to = siteDayFromInput(toText);
    if (from !== null && to !== null && dayDate(from) === fromText && dayDate(to) === toText && to > from && to - from <= 31 * DAY_MS + HOUR_MS) {
      state.daily.from = from;
      state.daily.to = to;
      state.daily.range = "custom";
      state.daily.days = Math.round((to - from) / DAY_MS);
      el("daily-from").value = fromText;
      el("daily-to").value = toText;
    }
  }
  ["daily-ranges", "daily-weathers"].forEach(function (id) {
    el(id).querySelectorAll("button").forEach(function (button) {
      var active = id === "daily-ranges" ? state.daily.range !== "custom" && Number(button.dataset.days) === state.daily.days :
          button.dataset.weather === state.daily.layer;
      button.setAttribute("aria-pressed", String(active));
    });
  });
}

function formatKw(value) {
  var figure = num(value);
  return figure === null ? DASH : figure.toFixed(2) + " kW";
}

function formatKwh(value) {
  var figure = num(value);
  return figure === null ? DASH : figure.toFixed(1) + " kWh";
}

function formatNumber(value, digits, unit) {
  var figure = num(value);
  return figure === null ? DASH : figure.toFixed(digits) + (unit ? " " + unit : "");
}

/**
 * AC/DC is a ratio of two readings taken at the same measured time, never a
 * measured efficiency, and it needs both sides to exist.
 */
function ratioText(panel) {
  var ac = num(panel.ac_kw);
  var dc = num(panel.dc_kw);
  if (ac === null || dc === null || dc <= 0) return "unavailable without fresh AC and DC readings";
  return (ac / dc).toFixed(2) + " \u00b7 AC/DC ratio of two readings, not measured efficiency";
}

function formatTime(iso) {
  if (!iso) return DASH;
  var when = new Date(iso);
  if (isNaN(when.getTime())) return DASH;
  return when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Time of day only, in the site's zone, for labels that sit in a narrow tile. */
function formatClock(timestamp) {
  var when = new Date(timestamp);
  if (isNaN(when.getTime())) return DASH;
  return when.toLocaleString([], { hour: "2-digit", minute: "2-digit", timeZone: state.timezone || undefined });
}

/** Hour mark on the day axis, so a curve can be placed against the clock. */
function formatHour(timestamp) {
  var when = new Date(timestamp);
  if (isNaN(when.getTime())) return DASH;
  return when.toLocaleString([], { hour: "numeric", timeZone: state.timezone || undefined });
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

function fact(label, value) {
  return '<p><span class="fact-label">' + label + "</span> <span>" + value + "</span></p>";
}

function samplesOf(panel) {
  return (panel && panel.samples) || [];
}

function hasPowerSample(panel) {
  return samplesOf(panel).some(function (sample) { return sample.quality === "ok" && num(sample.ac_kw) !== null; });
}

/**
 * The site's day as [from, to) in milliseconds: the same zone offset the
 * History page buckets by, falling back to the browser's zone.
 */
function siteDay(timezone, now) {
  now = now === undefined ? Date.now() : now;
  var from = dayStartFor(timezone, now);
  return { from: from, to: dayStartFor(timezone, from + DAY_MS + HOUR_MS) };
}

/**
 * What one tile means: producing, finished, awaiting today's readings, no
 * recorded production, or a real problem. A panel missing from the latest stored slot is
 * only a problem while the array is producing; at night the same gap is the
 * sun going down, not a fault. `anyProducing` is the site's own reading, not
 * this slot's peak: the newest slot holds only the panels whose measurement
 * moved, so its peak drops to a few watts long before the sun sets.
 */
function panelState(panel, anyProducing, hasTodaySlot, beforeSunrise) {
  var value = num(panel.ac_kw);
  var today = num(panel.energy_kwh);
  if (!anyProducing && !(today > 0) && (beforeSunrise || !hasTodaySlot)) return "pending";
  if (!panel.quality) return anyProducing ? "problem" : today > 0 ? "done" : "idle";
  if (panel.quality !== "ok") return "problem";
  if (value !== null && value > PRODUCING_KW) return "producing";
  return today !== null && today > 0 ? "done" : "idle";
}

function renderProduction() {
  var source = state.chartDate ? state.chartEnergy : state.latest;
  var panels = (source && source.panels) || [];
  var energies = panels.filter(function (panel) { return !state.panelId || panel.panel_id === state.panelId; })
    .map(function (panel) { return num(panel.energy_kwh); })
    .filter(function (value) { return value !== null; });
  el("array-total").hidden = false;
  el("array-label").textContent = "Panel production " + (state.chartDate ? "· " + formatDay() : "today");
  el("array-energy").textContent = energies.length
    ? formatKwh(energies.reduce(function (sum, value) { return sum + value; }, 0)) : DASH;
  el("array-coverage").textContent = energies.length
    ? (state.panelId ? "Stored panel counter" : energies.length + "/" + panels.length + " panel counters") + " · partial day"
    : source ? "No panel energy recorded for this day" : "Loading panel energy…";
}

/** The matrix reads today: the current reading and the day's stored counter. */
function renderMatrix() {
  var latest = state.latest;
  if (!latest) return;
  var panels = latest.panels || [];
  if (panels.length === 0) {
    state.problemIds = [];
    el("matrix").innerHTML = "";
    el("matrix-state").textContent =
      "No panel samples are stored yet. An absent list is not the same as panels being offline.";
    return;
  }
  el("panel-picker-label").textContent = "Panel list (" + panels.length + ")";
  var slotTime = Date.parse(latest.slot_ts);
  var hasTodaySlot = isFinite(slotTime) && slotTime >= state.dayFrom && slotTime < state.dayTo;
  var sunrise = state.daylight && Date.parse(state.daylight.sunrise_utc);
  var beforeSunrise = Number.isFinite(sunrise) && Date.now() < sunrise;
  el("pending-key").textContent = beforeSunrise ? "Waiting for daylight" : "No panel readings today";
  var slotCurrent = latest.slot_age_seconds !== null && latest.slot_age_seconds <= CURRENT_SLOT_SECONDS;
  var peak = 0;
  panels.forEach(function (panel) {
    var value = num(panel.ac_kw);
    if (slotCurrent && value !== null && value > peak) peak = value;
  });
  // Whether a missing row is a fault is the site's question, not this slot's:
  // its own reading keeps moving while the inverter tree lags. Without that
  // reading, this slot's peak is all the page has to go on.
  var site = state.live || {};
  var siteKw = num(site.pv_kw);
  var siteFresh = site.state === "live" || site.state === "delayed";
  var anyProducing = siteFresh && siteKw !== null ? siteKw > PRODUCING_KW : slotCurrent && peak > PRODUCING_KW;

  var counts = { producing: 0, done: 0, pending: 0, idle: 0, problem: 0 };
  var names = panels.map(function (panel) {
    var name = panelState(slotCurrent ? panel : { ...panel, quality: null }, anyProducing, hasTodaySlot, beforeSunrise);
    counts[name] += 1;
    return name;
  });
  state.problemIds = panels.filter(function (_panel, index) { return names[index] === "problem"; })
    .map(function (panel) { return panel.panel_id; });
  el("matrix-state").textContent =
    (anyProducing
      ? counts.producing + " of " + panels.length + " producing now"
      : hasTodaySlot ? panels.length + " panels tracked today" : panels.length + " known panels") +
    (beforeSunrise ? " \u00b7 waiting for daylight" : !hasTodaySlot ? " \u00b7 no panel readings today" : "") +
    (counts.problem ? " \u00b7 " + counts.problem + " not reporting" : "") +
    " \u00b7 last slot " + formatTime(latest.slot_ts) +
    (hasTodaySlot && latest.energy_from_utc
      ? " \u00b7 energy" +
        (latest.energy_coverage_from_utc ? " since " + formatClock(Date.parse(latest.energy_coverage_from_utc))
          : " in the stored interval") + " (partial day)"
      : "");
  el("matrix").innerHTML = panels
    .map(function (panel, index) {
      var value = slotCurrent ? num(panel.ac_kw) : null;
      var today = num(panel.energy_kwh);
      var name = names[index];
      // A panel with no reading in the stored slot did not produce now, and the
      // old reading is never carried forward as if it had.
      var note = (name === "pending" && beforeSunrise ? "waiting for daylight" : STATE_NOTE[name]) +
        (name === "problem" && slotCurrent && panel.quality ? " \u00b7 " + panel.quality : "");
      return (
        '<button type="button" class="panel-tile state-' + name + '" data-panel="' + panel.panel_id +
        '" aria-pressed="' + String(panel.panel_id === state.panelId) + '">' +
        "<strong>" + panel.panel_id + "</strong>" +
        '<span class="panel-readings"><span class="panel-value">' +
          (value === null ? DASH : Math.round(value * 1000) + " W") +
        '</span><span class="panel-energy">' +
          (today === null ? DASH : today.toFixed(1) + " kWh") + "</span></span>" +
        '<small class="note">' + note + "</small>" +
        "</button>"
      );
    })
    .join("");
}

/** Month-day label for one panel's day, so the chart title states the day. */
function formatDay() {
  if (state.dayFrom === null) return DASH;
  return new Date(chartWindow().from).toLocaleDateString([], { month: "short", day: "numeric", timeZone: state.timezone || undefined });
}

function chartWindow() {
  var from = state.chartDate ? siteDayFromInput(state.chartDate) : state.dayFrom;
  return { from: from, to: state.chartDate ? dayStartOf(from + DAY_MS + HOUR_MS) : state.dayTo };
}

function drawChart() {
  var container = el("chart");
  el("panel-hover-label").hidden = true;
  var panels = ((state.overview && state.overview.panels) || []).filter(hasPowerSample);
  if (!state.overview || !panels.length) {
    clearEChart(container, state.overview
      ? "No panel history for this day yet. Panels are sampled during daylight."
      : "Loading panel curves\u2026");
    state.scale = null;
    return;
  }
  var window = chartWindow();
  var from = window.from === null ? Date.now() - DAY_MS : window.from;
  var to = window.to === null ? from + DAY_MS : window.to;
  var palette = chartPalette();
  var byTime = new Map();
  var peak = 0;
  function pointsFor(samples) {
    var points = [];
    samples.forEach(function (sample) {
      var time = Date.parse(sample.ts);
      if (!isFinite(time)) return;
      var value = sample.quality === "ok" ? num(sample.ac_kw) : null;
      if (value !== null && value > peak) peak = value;
      if (points.length && time - points[points.length - 1][0] > 450000) points.push([points[points.length - 1][0] + 300000, null]);
      points.push([time, value]);
      if (value !== null) {
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time).push(value);
      }
    });
    return points;
  }
  var series = panels.map(function (panel) {
    var selected = panel.panel_id === state.panelId;
    return {
      name: panel.panel_id, type: "line", data: pointsFor(samplesOf(panel)), connectNulls: false,
      showSymbol: false, triggerLineEvent: true, cursor: "pointer", z: selected ? 4 : 1,
      lineStyle: { color: selected ? palette.solar : palette.muted, width: selected ? 3 : 1.2,
        opacity: selected ? 1 : state.panelId ? .23 : .35 },
      itemStyle: { color: selected ? palette.solar : palette.muted },
      emphasis: { focus: "series", lineStyle: { color: palette.solar, width: 3, opacity: 1 } },
    };
  });
  var median = Array.from(byTime, function (entry) {
    var values = entry[1].sort(function (a, b) { return a - b; });
    var middle = Math.floor(values.length / 2);
    return { ts: new Date(entry[0]).toISOString(), ac_kw: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      count: values.length };
  }).sort(function (a, b) { return Date.parse(a.ts) - Date.parse(b.ts); });
  if (!state.panelId && median.length) series.push({
    name: "Array median", type: "line", data: pointsFor(median.map(function (row) { return { ...row, quality: "ok" }; })),
    connectNulls: false, showSymbol: false, silent: true, z: 3,
    lineStyle: { color: palette.text, width: 2.6 }, itemStyle: { color: palette.text },
  });
  var samples = state.panelId ? samplesOf(state.history) : median;
  var times = samples.map(function (sample) { return Date.parse(sample.ts); });
  var values = samples.map(function (sample) { return num(sample.ac_kw); });
  var index = state.hover === null ? samples.length - 1 : state.hover;
  var highlighted = state.panelId ? series.find(function (item) { return item.name === state.panelId; }) : series[series.length - 1];
  if (highlighted && index >= 0 && index < samples.length) {
    highlighted.markLine = { silent: true, symbol: "none", label: { show: false },
      lineStyle: { color: palette.text, type: "dashed", width: 1 }, data: [{ xAxis: times[index] }] };
    if (values[index] !== null) series.push({ name: "Selected slot", type: "line", silent: true,
      data: [[times[index], values[index]]], showSymbol: true, symbolSize: 8, z: 9,
      lineStyle: { opacity: 0 }, itemStyle: { color: state.panelId ? palette.solar : palette.text,
        borderColor: palette.card, borderWidth: 2 } });
  }
  if (series.length && Date.now() < to && Date.now() > from) series[0].markArea = {
    silent: true, itemStyle: { color: palette.exported, opacity: .07 },
    label: { show: true, formatter: "UPCOMING", color: palette.muted, position: "insideTop", fontSize: 10 },
    data: [[{ xAxis: Date.now() }, { xAxis: to }]],
  };
  var chart = renderEChart(container, {
    aria: { enabled: false },
    grid: { left: 50, right: 20, top: 35, bottom: 36 },
    xAxis: { type: "time", min: from, max: to, boundaryGap: false, interval: 6 * HOUR_MS,
      axisLine: { lineStyle: { color: palette.line } }, axisTick: { show: false },
      axisLabel: { color: palette.muted, hideOverlap: true, formatter: function (value) { return formatHour(value); } },
      splitLine: { show: true, lineStyle: { color: palette.line, type: "dashed" } } },
    yAxis: { type: "value", min: 0, max: peak > 0 ? peak * 1.1 : 1, name: "AC POWER · kW",
      nameTextStyle: { color: palette.text, fontWeight: 700, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: palette.muted, formatter: function (value) { return value.toFixed(2); } },
      splitLine: { lineStyle: { color: palette.line } } },
    series: series,
  }, container.clientWidth < 520 ? 226 : 360);
  chart.off("click", selectPanelFromChart);
  chart.on("click", selectPanelFromChart);
  chart.off("mouseover", showPanelHover);
  chart.on("mouseover", showPanelHover);
  chart.off("mousemove", showPanelHover);
  chart.on("mousemove", showPanelHover);
  chart.off("mouseout", hidePanelHover);
  chart.on("mouseout", hidePanelHover);
  state.scale = { from: from, to: to, times: times, values: values, samples: samples };
}

/** Nearest stored slot to the pointer, so a hover always names a real sample. */
function nearestSlot(times, at) {
  var best = 0;
  var gap = Infinity;
  for (var index = 0; index < times.length; index += 1) {
    var distance = Math.abs(times[index] - at);
    if (distance < gap) {
      gap = distance;
      best = index;
    }
  }
  return best;
}

function renderFacts() {
  if (!state.panelId) {
    el("panel-detail-summary").hidden = true;
    el("facts").innerHTML = "";
    var points = state.scale && state.scale.samples || [];
    var position = state.hover === null ? points.length - 1 : state.hover;
    var point = points[position];
    el("slot-state").textContent = point
      ? "Array median " + formatKw(point.ac_kw) + " at " + formatTime(point.ts) +
        " \u00b7 " + point.count + " panels with readings"
      : "No panel readings in this range. Missing data is not zero.";
    return;
  }
  el("panel-detail-summary").hidden = false;
  var samples = samplesOf(state.history);
  var index = state.hover === null ? samples.length - 1 : state.hover;
  var sample = samples[index];
  var latestSample = samples[samples.length - 1];
  var rows = [];
  if (sample) {
    rows.push(fact("Selected slot", formatTime(sample.ts)));
    rows.push(fact("AC power", formatKw(sample.ac_kw)));
    rows.push(fact("Lifetime counter at that slot", formatKwh(sample.energy_kwh_total)));
    rows.push(fact("Measurement time", formatTime(sample.measured_at_utc)));
    rows.push(fact("Stored quality", sample.quality || DASH));
  }
  if (latestSample) {
    // The latest snapshot keeps its own label: scrubbing never rewrites it.
    rows.push(fact("Latest stored slot for this day", formatTime(latestSample.ts)));
    rows.push(fact("Latest AC power", formatKw(latestSample.ac_kw)));
  }
  var latestPanel = latestPanelFor();
  el("panel-detail-summary").innerHTML = [
    ["AC power now", latestPanel ? formatKw(latestPanel.ac_kw) : DASH],
    ["Energy today", latestPanel ? formatKwh(latestPanel.energy_kwh) : DASH],
    ["DC power now", latestPanel ? formatKw(latestPanel.dc_kw) : DASH],
    ["AC / DC", latestPanel && num(latestPanel.ac_kw) !== null && num(latestPanel.dc_kw) > 0
      ? Math.round(latestPanel.ac_kw / latestPanel.dc_kw * 100) + "%" : DASH],
  ].map(function (pair) { return '<div><span>' + pair[0] + '</span><strong>' + pair[1] + '</strong></div>'; }).join("");
  if (latestPanel) {
    var hasElectrical = false;
    if (state.latest && state.latest.energy_from_utc) {
      rows.push(
        fact(
          "Recorded energy",
          formatKwh(latestPanel.energy_kwh) +
            (latestPanel.energy_first_slot_utc && latestPanel.energy_last_slot_utc
              ? " \u00b7 stored counter " + formatClock(Date.parse(latestPanel.energy_first_slot_utc)) + " \u2192 " +
                formatClock(Date.parse(latestPanel.energy_last_slot_utc))
              : " \u00b7 stored lifetime counter"),
        ),
      );
    }
    if (num(latestPanel.dc_kw) !== null) {
      rows.push(fact("Latest DC power", formatNumber(latestPanel.dc_kw, 2, "kW")));
      hasElectrical = true;
    }
    if (num(latestPanel.dc_v) !== null || num(latestPanel.dc_a) !== null) {
      rows.push(fact("Latest DC voltage / current", formatNumber(latestPanel.dc_v, 1, "V") + " / " + formatNumber(latestPanel.dc_a, 2, "A")));
      hasElectrical = true;
    }
    if (num(latestPanel.ac_v) !== null || num(latestPanel.ac_a) !== null) {
      rows.push(fact("Latest AC voltage / current", formatNumber(latestPanel.ac_v, 1, "V") + " / " + formatNumber(latestPanel.ac_a, 2, "A")));
      hasElectrical = true;
    }
    if (num(latestPanel.heatsink_c) !== null) {
      rows.push(fact("Heatsink temperature", formatNumber(latestPanel.heatsink_c, 1, "\u00b0C")));
      hasElectrical = true;
    }
    if (num(latestPanel.ac_kw) !== null && num(latestPanel.dc_kw) !== null) rows.push(fact("AC/DC", ratioText(latestPanel)));
    if (!hasElectrical) rows.push(fact("Electrical diagnostics", "Not available in the latest stored slot"));
  }
  el("facts").innerHTML = rows.join("");
  el("slot-state").textContent = sample
    ? (state.hover === null ? "Latest stored slot " : "Pointed slot ") + formatTime(sample.ts) + " \u00b7 " + formatKw(sample.ac_kw) +
      (sample.quality === "ok" ? "" : " \u00b7 " + (sample.quality || "unknown"))
    : "No stored slot for this panel on this day; missing readings are not zero.";
}

/** The selected panel's row in the latest stored slot; null when absent. */
function latestPanelFor() {
  var panels = (state.latest && state.latest.panels) || [];
  for (var index = 0; index < panels.length; index += 1) {
    if (panels[index].panel_id === state.panelId) return panels[index];
  }
  return null;
}

function renderAll() {
  renderMatrix();
  renderProduction();
  var samples = samplesOf(state.history);
  var curves = ((state.overview && state.overview.panels) || []).filter(hasPowerSample);
  el("panel-title").textContent = state.panelId
    ? "Panel " + state.panelId + " \u00b7 " + formatDay()
    : "All panel power \u00b7 " + formatDay();
  el("all-panels").setAttribute("aria-pressed", String(state.panelId === null));
  el("chart").setAttribute("aria-label", state.panelId
    ? "Panel " + state.panelId + (samples.length ? " highlighted against the array; use arrow keys to inspect stored slots" : " has no stored slots for this day; other panels are gray")
    : "All measured panel curves and array median; choose a panel below or use arrow keys to inspect stored slots");
  el("daily-card").hidden = state.panelId === null;
  el("panel-diagnostics").hidden = state.panelId === null;
  el("chart-state").textContent = !state.overview ? "Loading panel history\u2026"
    : !curves.length ? "No measured panel curve for this day yet"
    : (state.panelId
      ? (samples.length ? samples.length + " measured slots" : "No stored samples for this panel") +
        " \u00b7 other panels are gray" : curves.length + " panel curves \u00b7 dark line is the array median") +
      (!state.chartDate && state.problemIds.length ? " \u00b7 " + state.problemIds.join(", ") + " not reporting" : "") +
      (state.overview.truncated ? " \u00b7 oldest slots omitted" : "");
  drawChart();
  renderFacts();
  el("chart-state").hidden = !curves.length;
  el("slot-state").hidden = !curves.length;
}

function loadPanel(panelId) {
  state.panelId = panelId === state.panelId ? null : panelId;
  writeUrl();
  state.hover = null;
  state.history = state.panelId ? ((state.overview && state.overview.panels) || [])
    .find(function (panel) { return panel.panel_id === state.panelId; }) || { samples: [] } : null;
  if (state.panelId) loadDaily();
  else {
    state.daily.requestId += 1;
    state.daily.rows = [];
  }
  renderAll();
}

function selectPanelFromChart(event) {
  if (event.seriesType !== "line") return;
  var panel = ((state.overview && state.overview.panels) || []).find(function (item) {
    return item.panel_id === event.seriesName;
  });
  if (panel) loadPanel(panel.panel_id);
}

function showPanelHover(event) {
  if (event.seriesType !== "line") return;
  var panel = ((state.overview && state.overview.panels) || []).find(function (item) {
    return item.panel_id === event.seriesName;
  });
  if (!panel) return;
  var at = event.event && chartXValueAt(el("chart"), el("chart").getBoundingClientRect().left + event.event.offsetX);
  var samples = samplesOf(panel).filter(function (sample) { return sample.quality === "ok" && num(sample.ac_kw) !== null; });
  var sample = samples.length && Number.isFinite(at) ? samples[nearestSlot(samples.map(function (row) { return Date.parse(row.ts); }), at)] : null;
  var label = el("panel-hover-label");
  label.textContent = panel.panel_id + (sample ? " · " + formatClock(sample.ts) + " · " + formatKw(sample.ac_kw) : "") + " · click to focus";
  label.hidden = false;
}

function hidePanelHover() {
  el("panel-hover-label").hidden = true;
}

function loadOverview() {
  if (state.dayFrom === null || state.dayTo === null) return;
  var requestId = ++state.overviewRequestId;
  var window = chartWindow();
  var from = new Date(window.from).toISOString(), to = new Date(window.to).toISOString();
  return Promise.all([
    getJson("/api/v1/panels?history=all&from=" + from + "&to=" + to),
    state.chartDate ? getJson("/api/v1/panels?energy_from=" + from + "&energy_to=" + to) : Promise.resolve(state.latest),
  ])
    .then(function (both) {
      if (requestId !== state.overviewRequestId || !both[0] || !both[1]) return;
      var data = both[0];
      state.overview = data;
      state.chartEnergy = both[1];
      state.history = state.panelId ? (data.panels || []).find(function (panel) {
        return panel.panel_id === state.panelId;
      }) || { samples: [] } : null;
      renderAll();
    })
    .catch(function () {
      if (requestId !== state.overviewRequestId) return;
      el("banner").hidden = false;
      el("banner").textContent = "Could not read the array's history. Values are unknown, not zero.";
      el("array-coverage").textContent = "Panel energy unavailable";
    });
}

function loadLatest() {
  getJson("/api/v1/location")
    .catch(function () {
      return null;
    })
    .then(function (location) {
      state.timezone = location && location.timezone ? location.timezone : null;
      var day = siteDay(state.timezone);
      state.dayFrom = day.from;
      state.dayTo = day.to;
      restoreUrl();
      return Promise.all([
        getJson("/api/v1/live").catch(function () { return null; }),
        getJson(
          "/api/v1/panels?energy_from=" + new Date(day.from).toISOString() +
            "&energy_to=" + new Date(day.to).toISOString(),
        ),
      ]);
    })
    .then(function (both) {
      state.live = both[0];
      var data = both[1];
      if (!data) return;
      state.latest = data;
      var panels = data.panels || [];
      var selected = panels.find(function (panel) { return panel.panel_id === initialQuery.get("panel"); });
      state.panelId = selected ? selected.panel_id : null;
      el("state").textContent = panels.length === 0
        ? "No panel samples" : panels.length + " panels \u00b7 latest slot " + formatTime(data.slot_ts);
      if (state.panelId) loadDaily();
      renderAll();
      loadOverview();
    })
    .catch(function () {
      el("state").textContent = "Cloud unreachable";
      el("banner").hidden = false;
      el("banner").textContent = "Could not read /api/v1/panels from this browser. Values are unknown, not zero.";
    });
}

/* --------------------------------------------------- daily production chart */

/** Local day boundary for an instant, in the site's zone. */
function dayStartFor(timezone, timestamp) {
  var offset = zoneOffsetMs(timezone, timestamp);
  var localMidnight = Math.floor((timestamp + offset) / DAY_MS) * DAY_MS;
  var start = localMidnight - offset;
  // The offset at midnight can differ from the offset later that day.
  return localMidnight - zoneOffsetMs(timezone, start);
}

function dayStartOf(timestamp) {
  return dayStartFor(state.timezone, timestamp);
}

/** A site-local date as "YYYY-MM-DD", the key the weather day rows use. */
function dayDate(dayStart) {
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: state.timezone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(dayStart));
  return parts;
}

/** Short date under a bar, e.g. "9/15". */
function dayLabel(dayStart) {
  return new Date(dayStart).toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
    timeZone: state.timezone || undefined,
  });
}

/**
 * One row per local day: the stored counter delta, the slots behind it, and the
 * daylight that day had. A day with fewer than two stored counters has no
 * total, and neither has one whose counter went backwards.
 */
function dailyRows(samples, from, to) {
  var buckets = new Map();
  samples.forEach(function (sample) {
    var ts = Date.parse(sample.ts);
    if (!isFinite(ts)) return;
    var key = dayStartOf(ts);
    var bucket = buckets.get(key);
    if (!bucket) {
      bucket = { first: null, last: null, firstTs: null, lastTs: null, slots: 0 };
      buckets.set(key, bucket);
    }
    bucket.slots += 1;
    var counter = num(sample.energy_kwh_total);
    if (counter === null) return;
    bucket.last = counter;
    bucket.lastTs = ts;
    if (bucket.first === null) {
      bucket.first = counter;
      bucket.firstTs = ts;
    }
  });
  var rows = [];
  var cursor = dayStartOf(from);
  var stop = dayStartOf(to - 1);
  // A day is stepped to at 01:00 local, so a 23 or 25 hour day still moves on.
  for (var guard = 0; cursor <= stop && guard < 400; guard += 1) {
    var bucket = buckets.get(cursor);
    var moved = null;
    if (bucket && bucket.first !== null && bucket.last !== null && bucket.firstTs !== bucket.lastTs) {
      moved = bucket.last - bucket.first;
      if (moved < 0) moved = null;
    }
    rows.push({
      day: cursor,
      kwh: moved,
      slots: bucket ? bucket.slots : 0,
      spanMs: bucket && bucket.firstTs !== null ? bucket.lastTs - bucket.firstTs : 0,
      cloud: null,
      daylightMs: null,
    });
    cursor = dayStartOf(cursor + DAY_MS + HOUR_MS);
  }
  return rows;
}

/** Per-day weather totals plus the daylight each day actually had. */
function weatherByDay(hours, dayRows, rows) {
  var totals = new Map();
  (hours || []).forEach(function (hour) {
    var ts = Date.parse(hour.ts);
    if (!isFinite(ts)) return;
    var key = dayStartOf(ts);
    var total = totals.get(key) || {};
    Object.keys(WEATHER_DAILY).forEach(function (name) {
      var value = num(hour[WEATHER_DAILY[name].key]);
      if (value === null) return;
      var slot = total[name] || (total[name] = { sum: 0, count: 0, max: null });
      slot.sum += value;
      slot.count += 1;
      if (slot.max === null || value > slot.max) slot.max = value;
    });
    totals.set(key, total);
  });
  var daylight = new Map();
  var sunshine = new Map();
  (dayRows || []).forEach(function (row) {
    var seconds = num(row.daylight_seconds);
    if (row.date && seconds !== null) daylight.set(row.date, seconds * 1000);
    var sunny = num(row.sunshine_duration_seconds);
    if (row.date && sunny !== null) sunshine.set(row.date, sunny);
  });
  rows.forEach(function (row) {
    var total = totals.get(row.day) || {};
    row.weather = {};
    Object.keys(WEATHER_DAILY).forEach(function (name) {
      var layer = WEATHER_DAILY[name];
      var slot = total[name];
      if (!slot) {
        row.weather[name] = null;
        return;
      }
      if (layer.aggregate === "max") row.weather[name] = slot.max;
      else if (layer.aggregate === "sum") row.weather[name] = slot.sum;
      else row.weather[name] = slot.sum / slot.count;
    });
    row.daylightMs = daylight.get(dayDate(row.day)) || null;
    row.sunshineSeconds = sunshine.get(dayDate(row.day)) ?? null;
  });
  return rows;
}

/** Value each day shows for the layer on the chart right now. */
function weatherValue(row, name) {
  return num((row.weather || {})[name]);
}

/** Right-axis bounds for the chosen layer: fixed where the scale means something. */
function weatherBoundsFor(rows, name) {
  var layer = WEATHER_DAILY[name];
  if (layer.min !== undefined && layer.max !== undefined) return { min: layer.min, max: layer.max };
  var low = null;
  var high = null;
  rows.forEach(function (row) {
    var value = weatherValue(row, name);
    if (value === null) return;
    if (low === null || value < low) low = value;
    if (high === null || value > high) high = value;
  });
  if (low === null || high === null) return null;
  var floor = layer.min === undefined ? Math.min(low, 0) : layer.min;
  return { min: floor, max: high > floor ? high : floor + 1 };
}

/** Bars of daily production with the day's cloud cover on the right axis. */
function drawDaily() {
  var container = el("daily-chart"), rows = state.daily.rows || [];
  if (!rows.length) return;
  var palette = chartPalette(), layer = WEATHER_DAILY[state.daily.layer];
  var weatherBounds = weatherBoundsFor(rows, state.daily.layer);
  var peak = Math.ceil(Math.max(1, ...rows.map(function (row) { return num(row.kwh) || 0; })) * 1.15 * 2) / 2;
  var categories = rows.map(function (row) { return dayLabel(row.day); });
  var future = rows.findIndex(function (row) { return row.day > Date.now(); });
  var energySeries = { name: "Panel energy", type: "bar", barMaxWidth: 30,
    data: rows.map(function (row) {
      var value = num(row.kwh);
      if (value === null) return null;
      return { value: value, itemStyle: { opacity: row.daylightMs && row.spanMs < row.daylightMs * .6 ? .4 : .9 } };
    }), itemStyle: { color: palette.solar, borderRadius: [3, 3, 0, 0] } };
  if (future >= 0) energySeries.markArea = {
    silent: true, itemStyle: { color: palette.exported, opacity: .07 },
    label: { show: rows.length - future > 1, formatter: "UPCOMING", color: palette.muted, position: "insideTop", fontSize: 10 },
    data: [[{ xAxis: categories[future] }, { xAxis: categories[categories.length - 1] }]],
  };
  if (state.daily.hover !== null && rows[state.daily.hover]) energySeries.markLine = {
    silent: true, symbol: "none", label: { show: false }, lineStyle: { color: palette.text, type: "dashed", width: 1 },
    data: [{ xAxis: categories[state.daily.hover] }],
  };
  renderEChart(container, {
    aria: { enabled: false },
    grid: { left: 51, right: 52, top: 36, bottom: 39 },
    xAxis: { type: "category", data: categories, boundaryGap: true,
      axisLine: { lineStyle: { color: palette.line } }, axisTick: { show: false },
      axisLabel: { color: palette.muted, hideOverlap: true, interval: Math.max(0, Math.ceil(rows.length / 8) - 1) },
      splitLine: { show: false } },
    yAxis: [{ type: "value", min: 0, max: peak, name: "ENERGY · kWh",
      nameTextStyle: { color: palette.text, fontWeight: 700, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: palette.muted, formatter: function (value) { return value.toFixed(1); } },
      splitLine: { lineStyle: { color: palette.line } } },
      { type: "value", position: "right", min: weatherBounds ? weatherBounds.min : 0,
        max: weatherBounds ? weatherBounds.max : 100, name: weatherBounds ? layer.label.toUpperCase() + " · " + layer.unit : "",
        nameTextStyle: { color: palette.text, fontWeight: 700, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: !!weatherBounds, color: palette.muted, formatter: function (value) { return value.toFixed(layer.digits); } },
        splitLine: { show: false } }],
    series: [energySeries,
      { name: layer.label, type: "line", yAxisIndex: 1,
        data: rows.map(function (row) { return weatherValue(row, state.daily.layer); }), connectNulls: false,
        showSymbol: false, lineStyle: { color: layer.color, type: "dashed", width: 1.8 }, itemStyle: { color: layer.color } }],
  }, container.clientWidth < 520 ? 226 : 350);
  state.daily.scale = { from: dayStartOf(rows[0].day), to: dayStartOf(rows[rows.length - 1].day) + DAY_MS };
}

function renderDailyState() {
  var rows = state.daily.rows || [];
  var layer = WEATHER_DAILY[state.daily.layer];
  var kWh = rows.filter(function (row) {
    return num(row.kwh) !== null;
  });
  var weather = rows.filter(function (row) {
    return weatherValue(row, state.daily.layer) !== null;
  });
  el("daily-state").textContent =
    rows.length + " days \u00b7 " + kWh.length + " with a stored counter \u00b7 " +
    weather.length + " with weather \u00b7 bars are this panel's own stored counter, the line is that day's " +
    (layer.aggregate === "max" ? "peak " : layer.aggregate === "sum" ? "total " : "mean ") + layer.label.toLowerCase() +
    (state.daily.range === "custom" ? " \u00b7 chosen range" : "") +
    (state.daily.hover !== null && rows[state.daily.hover] && rows[state.daily.hover].sunshineSeconds !== null
      ? " \u00b7 " + dayLabel(rows[state.daily.hover].day) + " sunshine forecast " +
        (rows[state.daily.hover].sunshineSeconds / 3600).toFixed(1) + " h" : "");
}

/** The key under the daily chart names the layer the line is drawing. */
function renderWeatherKey() {
  var layer = WEATHER_DAILY[state.daily.layer];
  var key = el("daily-weather-key");
  key.textContent = layer.label + (layer.unit ? " " + layer.unit : "");
  key.style.setProperty("--weather", layer.color);
}

function loadDaily() {
  if (state.panelId === null) return;
  var panelId = state.panelId;
  var requestId = ++state.daily.requestId;
  var window = dailyRequestWindow();
  var from = window.from;
  var to = window.to;
  state.daily.window = window;
  el("daily-title").textContent = "Panel " + panelId + " \u00b7 daily production";
  getJson(
    "/api/v1/panels?panel_id=" + encodeURIComponent(panelId) +
      "&from=" + new Date(from).toISOString() + "&to=" + new Date(to).toISOString(),
  )
    .then(function (data) {
      if (requestId !== state.daily.requestId) return;
      var rows = dailyRows(samplesOf(data), from, to);
      state.daily.rows = rows;
      state.daily.hover = null;
      return getJson(
        "/api/v1/weather?from=" + new Date(from).toISOString() + "&to=" + new Date(to).toISOString(),
      ).catch(function () {
        return null;
      }).then(function (weather) {
        if (requestId !== state.daily.requestId) return;
        var days = (weather && weather.days) || [];
        var today = days.find(function (day) {
          var sunrise = Date.parse(day.sunrise_utc);
          return isFinite(sunrise) && sunrise >= state.dayFrom && sunrise < state.dayTo;
        });
        if (today) {
          state.daylight = today;
          renderMatrix();
        }
        weatherByDay(weather && weather.hours, weather && weather.days, rows);
        drawDaily();
        renderWeatherKey();
        renderDailyState();
      });
    })
    .catch(function () {
      el("banner").hidden = false;
      el("banner").textContent = "Could not read this panel's daily production. Values are unknown, not zero.";
    });
}

/** Site-local midnight for a date typed into the custom range. */
function siteDayFromInput(value) {
  var midnightUtc = Date.parse(value + "T00:00:00Z");
  if (!isFinite(midnightUtc)) return null;
  return dayStartOf(midnightUtc - zoneOffsetMs(state.timezone, midnightUtc) + HOUR_MS);
}

el("matrix").addEventListener("click", function (event) {
  var tile = event.target.closest("button[data-panel]");
  if (!tile) return;
  loadPanel(tile.dataset.panel);
  if (window.innerWidth < 700 && typeof el("panel-detail").scrollIntoView === "function") {
    el("panel-picker").open = false;
    el("panel-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

el("all-panels").addEventListener("click", function () {
  if (state.panelId) loadPanel(state.panelId);
});

function setChartDate(value) {
  var from = /^\d{4}-\d{2}-\d{2}$/.test(value) ? siteDayFromInput(value) : null;
  if (from === null || dayDate(from) !== value || from > state.dayFrom) {
    el("panel-date").value = state.chartDate || dayDate(state.dayFrom);
    return;
  }
  state.chartDate = from === state.dayFrom ? null : value;
  state.overview = null;
  state.chartEnergy = null;
  state.history = null;
  state.hover = null;
  el("banner").hidden = true;
  writeUrl();
  renderAll();
  loadOverview();
}

el("panel-date").addEventListener("change", function () {
  setChartDate(el("panel-date").value);
});

el("panel-today").addEventListener("click", function () {
  el("panel-date").value = dayDate(state.dayFrom);
  setChartDate(el("panel-date").value);
});

/** Hover, drag, or tap: one handler so a phone can read the curve without a slider. */
function pickDaySlot(event) {
  var scale = state.scale;
  if (!scale || scale.times.length === 0) return;
  var at = chartXValueAt(el("chart"), event.clientX);
  if (at === null) return;
  var index = nearestSlot(scale.times, at);
  if (index === state.hover) return;
  state.hover = index;
  drawChart();
  renderFacts();
}

el("chart").addEventListener("pointermove", pickDaySlot);
el("chart").addEventListener("pointerdown", function (event) {
  if (event.pointerType !== "mouse") pickDaySlot(event);
});
el("chart").addEventListener("keydown", function (event) {
  var rows = state.scale && state.scale.samples || [];
  if (rows.length === 0) return;
  var current = state.hover === null ? rows.length - 1 : state.hover;
  if (event.key === "ArrowLeft") state.hover = Math.max(0, current - 1);
  else if (event.key === "ArrowRight") state.hover = Math.min(rows.length - 1, current + 1);
  else if (event.key === "Home") state.hover = 0;
  else if (event.key === "End") state.hover = rows.length - 1;
  else return;
  event.preventDefault();
  drawChart();
  renderFacts();
});

el("chart").addEventListener("pointerleave", function () {
  hidePanelHover();
  if (state.hover === null) return;
  state.hover = null;
  drawChart();
  renderFacts();
});

/** Pointing at a bar reads that day: the range chart has no slider either. */
function pickDaily(event) {
  var scale = state.daily.scale;
  var rows = state.daily.rows || [];
  if (!scale || rows.length === 0) return;
  var slot = chartXValueAt(el("daily-chart"), event.clientX);
  if (slot === null) return;
  var index = Math.min(rows.length - 1, Math.max(0, Math.round(slot)));
  if (index === state.daily.hover) return;
  state.daily.hover = index;
  drawDaily();
  renderDailyState();
}

el("daily-chart").addEventListener("pointermove", pickDaily);
el("daily-chart").addEventListener("pointerdown", pickDaily);
el("daily-chart").addEventListener("keydown", function (event) {
  var rows = state.daily.rows || [];
  if (rows.length === 0) return;
  var current = state.daily.hover === null ? rows.length - 1 : state.daily.hover;
  if (event.key === "ArrowLeft") state.daily.hover = Math.max(0, current - 1);
  else if (event.key === "ArrowRight") state.daily.hover = Math.min(rows.length - 1, current + 1);
  else if (event.key === "Home") state.daily.hover = 0;
  else if (event.key === "End") state.daily.hover = rows.length - 1;
  else return;
  event.preventDefault();
  drawDaily();
  renderDailyState();
});

el("daily-chart").addEventListener("pointerleave", function () {
  if (state.daily.hover === null) return;
  state.daily.hover = null;
  drawDaily();
  renderDailyState();
});

function setDailyDays(days, button) {
  state.daily.days = days;
  state.daily.from = null;
  state.daily.to = null;
  state.daily.range = "preset";
  writeUrl();
  el("daily-ranges").querySelectorAll("button").forEach(function (item) {
    item.setAttribute("aria-pressed", String(item === button));
  });
  loadDaily();
}

el("daily-ranges").addEventListener("click", function (event) {
  var button = event.target.closest("button[data-days]");
  if (button) setDailyDays(Number(button.dataset.days), button);
});

el("daily-weathers").addEventListener("click", function (event) {
  var button = event.target.closest("button[data-weather]");
  if (!button) return;
  state.daily.layer = button.dataset.weather;
  writeUrl();
  el("daily-weathers").querySelectorAll("button").forEach(function (item) {
    item.setAttribute("aria-pressed", String(item === button));
  });
  drawDaily();
  renderWeatherKey();
  renderDailyState();
});

el("daily-custom").addEventListener("submit", function (event) {
  event.preventDefault();
  var from = siteDayFromInput(el("daily-from").value);
  var to = siteDayFromInput(el("daily-to").value);
  var longest = 31 * DAY_MS + HOUR_MS;
  if (from === null || to === null || to <= from) {
    el("banner").hidden = false;
    el("banner").textContent = "Pick a start and an end date, with the end after the start.";
    return;
  }
  if (to - from > longest) {
    el("banner").hidden = false;
    el("banner").textContent = "The panel history keeps 31 days; choose a shorter range.";
    return;
  }
  el("banner").hidden = true;
  state.daily.from = from;
  state.daily.to = to;
  state.daily.range = "custom";
  state.daily.days = Math.max(1, Math.round((to - from) / DAY_MS));
  writeUrl();
  el("daily-ranges").querySelectorAll("button").forEach(function (item) {
    item.setAttribute("aria-pressed", "false");
  });
  loadDaily();
});

/** The chosen range feeds the history request directly, day boundaries and all. */
function dailyRequestWindow() {
  var to = state.daily.to === null ? (state.dayTo === null ? siteDay(state.timezone).to : state.dayTo) : state.daily.to;
  var from = state.daily.from === null ? dayStartOf(to - state.daily.days * DAY_MS + HOUR_MS) : state.daily.from;
  return { from: from, to: to };
}

var widePicker = window.innerWidth >= 700;
el("panel-picker").open = widePicker;
loadLatest();
var resizeTimer = null;
window.addEventListener("resize", function () {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(function () {
    var wide = window.innerWidth >= 700;
    if (wide !== widePicker) el("panel-picker").open = wide;
    widePicker = wide;
    drawChart();
    drawDaily();
  }, 150);
});
