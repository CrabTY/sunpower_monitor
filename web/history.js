/* History page: real /api/v1/history and /api/v1/weather data, gaps left disconnected. */

import { weatherText } from "./insights.js";
import { calibrateHistory, gridRatio } from "./calibration.js";
import { initWeatherControls } from "./weather-controls.js";
import { powerGridOption, dailySiteRows, dailySiteOption } from "./energy-plot.js";
import { chartPalette, chartXValueAt, clearEChart, disposeEChart, renderEChart } from "./chart-engine.bundle.js";
import {
  COLORS,
  RESOLUTION_MS,
  WEATHER_LAYERS,
  alignedEnergy,
  bucketBounds,
  chartBounds,
  counterDelta,
  energyBuckets,
  solarDisplay,
  weatherBounds,
  zoneOffsetMs,
} from "./chart.js";

var DASH = "\u2014";
var state = { range: "today", period: "today", metric: "power", weatherLayer: "cloud", data: null, weather: null, interval: null, selectedIndex: -1, selectedDay: -1 };

(function () {
  "use strict";
  var pendingCompositionAnchor = window.location.hash === "#composition";

  function el(id) {
    return document.getElementById(id);
  }

  function iso(moment) {
    return moment.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  var PERIODS = {
    today: [["today", "Today"], ["yesterday", "Yesterday"], ["past24", "Past 24 hours"]],
    "7d": [["thisWeek", "This week"], ["lastWeek", "Last week"], ["past7", "Past 7 days"]],
    "30d": [["thisMonth", "This month"], ["lastMonth", "Last month"], ["past30", "Past 30 days"]],
    "12m": [["past12", "Past 12 months"]],
  };

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var view = params.get("view") || "today";
    if (Object.prototype.hasOwnProperty.call(PERIODS, view)) {
      state.range = view;
      state.period = PERIODS[view].some(function (choice) { return choice[0] === params.get("period"); })
        ? params.get("period") : PERIODS[view][0][0];
    } else if (view === "custom") {
      var from = new Date(params.get("from") || "");
      var to = new Date(params.get("to") || "");
      if (isFinite(from.getTime()) && isFinite(to.getTime()) && to > from) {
        state.range = "custom";
        state.custom = { from: from, to: to };
        state.metric = params.get("metric") === "energy" ? "energy" : "power";
      }
    }
    state.weatherLayer = Object.prototype.hasOwnProperty.call(WEATHER_LAYERS, params.get("weather")) ? params.get("weather") : "cloud";
  }

  function writeUrl() {
    var url = new URL(window.location.href);
    ["view", "period", "metric", "measure", "weather", "layout", "from", "to"].forEach(function (key) { url.searchParams.delete(key); });
    if (state.range !== "today") url.searchParams.set("view", state.range);
    if (state.range === "custom" && state.custom) {
      url.searchParams.set("from", iso(state.custom.from));
      url.searchParams.set("to", iso(state.custom.to));
      if (state.metric === "energy") url.searchParams.set("metric", "energy");
    } else if (state.range !== "custom" && state.period !== PERIODS[state.range][0][0]) {
      url.searchParams.set("period", state.period);
    }
    if (state.weatherLayer !== "cloud") url.searchParams.set("weather", state.weatherLayer);
    window.history.replaceState(null, "", url);
  }

  function dayStart(at) {
    var timezone = state.timezone || (state.weather && state.weather.location && state.weather.location.timezone);
    var offset = zoneOffsetMs(timezone, at);
    var local = Math.floor((at + offset) / 86400000) * 86400000;
    return local - zoneOffsetMs(timezone, local - offset);
  }

  function monthStart(at, shift) {
    var timezone = state.timezone || (state.weather && state.weather.location && state.weather.location.timezone);
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, year: "numeric", month: "numeric" }).formatToParts(new Date(at));
    var year = Number(parts.find(function (part) { return part.type === "year"; }).value);
    var month = Number(parts.find(function (part) { return part.type === "month"; }).value);
    var utc = Date.UTC(year, month - 1 + shift, 1);
    return utc - zoneOffsetMs(timezone, utc);
  }

  function rangeFor(name) {
    if (name === "custom" && state.custom) {
      var span = state.custom.to - state.custom.from;
      return { from: state.custom.from, to: state.custom.to, resolution: span > 31 * 86400000 ? "1d" : span > 2 * 86400000 ? "5m" : "1m" };
    }
    var now = new Date();
    var today = dayStart(now.getTime());
    var choice = state.period;
    if (choice === "yesterday") return { from: new Date(dayStart(today - 3600000)), to: new Date(today), resolution: "1m" };
    if (choice === "past24") return { from: new Date(now.getTime() - 86400000), to: now, resolution: "1m" };
    if (choice === "lastWeek" || choice === "thisWeek") {
      var localDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: state.timezone || undefined }).format(now);
      var monday = dayStart(today - (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(localDay)) * 86400000);
      return choice === "lastWeek"
        ? { from: new Date(monday - 7 * 86400000), to: new Date(monday), resolution: "5m" }
        : { from: new Date(monday), to: now, axisTo: new Date(dayStart(monday + 7 * 86400000 + 3600000)), resolution: "5m" };
    }
    if (choice === "past7") return { from: new Date(now.getTime() - 7 * 86400000), to: now, resolution: "5m" };
    if (choice === "thisMonth") return { from: new Date(monthStart(now.getTime(), 0)), to: now, axisTo: new Date(monthStart(now.getTime(), 1)), resolution: "5m" };
    if (choice === "lastMonth") return { from: new Date(monthStart(now.getTime(), -1)), to: new Date(monthStart(now.getTime(), 0)), resolution: "5m" };
    if (choice === "past30") return { from: new Date(now.getTime() - 30 * 86400000), to: now, resolution: "5m" };
    if (name === "12m") {
      var yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      return { from: yearAgo, to: now, resolution: "1d" };
    }
    return { from: new Date(today), to: now, axisTo: new Date(dayStart(today + 86400000 + 3600000)), resolution: "1m" };
  }

  function windows() {
    return (state.data && state.data.windows) || [];
  }

  function valueAt(window, series) {
    if (window.quality !== "ok" || window.complete !== true) return null;
    var value = window[series.key];
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  function clock(isoString) {
    if (!isoString) return DASH;
    var when = new Date(isoString);
    return isNaN(when.getTime()) ? DASH : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function weatherHours() {
    return state.weather && state.weather.configured && state.weather.hours ? state.weather.hours : [];
  }

  /* The forecast hour closest to a chart point, so hover shows the same hour. */
  function weatherNear(ts) {
    var best = null;
    var distance = Infinity;
    weatherHours().forEach(function (hour) {
      var gap = Math.abs(Date.parse(hour.ts) - ts);
      if (gap < distance) {
        distance = gap;
        best = hour;
      }
    });
    return distance <= 90 * 60000 ? best : null;
  }

  function renderWeatherLegend() {
    var weather = state.weather;
    var layer = WEATHER_LAYERS[state.weatherLayer];
    el("weather-toggle").textContent = "Weather · " + layer.label;
    el("weather-key").textContent = layer.label + " " + layer.unit;
    el("weather-key-energy").textContent = layer.label + " " + layer.unit;
    // The swatch and the line share one colour, so the right axis is findable.
    el("weather-key").style.setProperty("--weather", layer.color);
    el("weather-key-energy").style.setProperty("--weather", layer.color);
    var note = el("weather-legend");
    if (!weather) {
      note.textContent = state.data && state.data.resolution === "1d" ? "" : "Forecast unavailable; power readings are unaffected.";
      note.hidden = !note.textContent;
      return;
    }
    if (!weather.configured) {
      note.textContent = "Confirm the site location in Settings to show weather.";
      note.hidden = false;
      return;
    }
    note.textContent = weather.stale ? "Forecast may be out of date." : "";
    note.hidden = !weather.stale;
  }

  var SERIES = [
    { key: "pv_kw_avg", label: "Solar", color: COLORS.solar },
    { key: "load_kw_reported_avg", label: "Home (estimated)", color: COLORS.home },
    { key: "grid_kw_avg", label: "Grid (estimated)", color: COLORS.grid },
  ];

  /* Bar order per bucket, left to right; "grid" draws import up and export down. */
  var ENERGY_BARS = [
    { key: "solar", label: "Solar", color: COLORS.solar },
    { key: "home", label: "Home (estimated)", color: COLORS.home },
    { key: "grid", label: "Grid (estimated)", color: COLORS.grid },
  ];

  function formatKw(value) {
    return value === null ? DASH : value.toFixed(1) + " kW";
  }

  function formatTime(ts, spanMs) {
    var moment = new Date(ts);
    if (spanMs <= 36 * 3600000) {
      return moment.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return moment.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function renderPeriodControls(range) {
    var names = PERIODS[state.range] || [];
    var current = names.find(function (choice) { return choice[0] === state.period; });
    el("period-title").textContent = current ? current[1] : "Chosen period";
    var timezone = state.timezone || (state.weather && state.weather.location && state.weather.location.timezone);
    var date = function (value) { return value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: timezone || undefined }); };
    var shortDate = function (value) { return value.toLocaleDateString([], { month: "short", day: "numeric", timeZone: timezone || undefined }); };
    var displayTo = range.axisTo || range.to;
    var endDate = new Date(displayTo.getTime() - 1);
    var sameDay = date(range.from) === date(endDate);
    var sameYear = range.from.toLocaleDateString([], { year: "numeric", timeZone: timezone || undefined }) ===
      endDate.toLocaleDateString([], { year: "numeric", timeZone: timezone || undefined });
    var fullSpan = (sameDay ? date(range.from) : date(range.from) + " – " + date(endDate)) +
      (range.axisTo ? " · measured through " + date(range.to) + " " :
        " · " + range.from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: timezone || undefined }) + " to ") +
      range.to.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: timezone || undefined });
    var compactSpan = sameDay ? date(range.from) : sameYear
      ? shortDate(range.from) + "–" + shortDate(endDate) + ", " + endDate.toLocaleDateString([], { year: "numeric", timeZone: timezone || undefined })
      : date(range.from) + "–" + date(endDate);
    el("period-span").textContent = compactSpan +
      (range.axisTo ? " · through " + shortDate(range.to) + ", " :
        " · " + range.from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: timezone || undefined }) + "–") +
      range.to.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: timezone || undefined });
    el("period-span").setAttribute("aria-label", fullSpan);
    el("period-span").title = fullSpan;
    el("period-options").innerHTML = names.map(function (choice) {
      return '<button type="button" data-period="' + choice[0] + '" aria-pressed="' + (choice[0] === state.period) + '">' + choice[1] + "</button>";
    }).join("");
    var ranges = ["today", "7d", "30d", "12m"];
    el("scope-slider").value = String(Math.max(0, ranges.indexOf(state.range)));
    el("ranges").querySelectorAll("button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
    });
    el("daily-navigation").hidden = state.range !== "30d";
    el("metrics").hidden = state.range !== "custom";
    el("weather-controls").hidden = state.range === "12m";
    ["metrics", "weathers"].forEach(function (id) {
      el(id).querySelectorAll("button").forEach(function (button) {
        var key = id === "metrics" ? "metric" : "weather";
        var value = id === "weathers" ? state.weatherLayer : state[key];
        button.setAttribute("aria-pressed", String(button.dataset[key] === value));
      });
    });
  }

  function drawPowerChart() {
    var rows = windows(), container = el("chart"), data = state.data;
    if (!rows.length) { clearEChart(container, "No stored windows in this period."); el("interval-controls").hidden = true; return; }
    el("power-chart-card").style.setProperty("--plot-left", container.clientWidth < 520 ? "41px" : "56px");
    el("power-chart-card").style.setProperty("--plot-right", container.clientWidth < 520 ? "43px" : "57px");
    var from = Date.parse(data.from_utc), to = (rangeFor(state.range).axisTo || new Date(data.to_utc)).getTime();
    var selected = state.selectedIndex < 0 || state.selectedIndex >= rows.length ? rows.length - 1 : state.selectedIndex;
    state.selectedIndex = selected;
    renderEChart(container, powerGridOption(rows, weatherHours(), {
      width: container.clientWidth || 640, from: from, to: to, resolution: data.resolution,
      timezone: state.timezone,
      weatherLayer: state.weatherLayer, layout: "combined",
      plotHeight: container.clientWidth < 520 ? 252 : 320,
      daylightDays: state.weather && state.weather.configured ? state.weather.days : [],
      selected: Date.parse(rows[selected].ts),
      palette: chartPalette(),
    }), container.clientWidth < 520 ? 338 : 410);
    container.tabIndex = 0;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Solar power, grid direction, and forecast weather; use arrow keys for stored readings");
    container.setAttribute("aria-describedby", "detail");
    el("interval-controls").hidden = false;
    el("interval-overlay").hidden = false;
    if (!state.interval || state.interval.end >= rows.length) state.interval = { start: Math.max(0, rows.length - Math.round(8 * 3600000 / (RESOLUTION_MS[data.resolution] || 60000))), end: rows.length - 1 };
    renderInterval();
    showDetail(selected, null);
    function point(event) {
      var wanted = chartXValueAt(container, event.clientX);
      if (wanted === null) return;
      var best = 0, distance = Infinity;
      rows.forEach(function (row, index) { var gap = Math.abs(Date.parse(row.ts) - wanted); if (gap < distance) { best = index; distance = gap; } });
      state.selectedIndex = best;
      showDetail(best, event);
      if (event.type === "pointerdown") drawPowerChart();
    }
    container.onpointermove = point;
    container.onpointerdown = point;
    container.onfocus = function () { showDetail(state.selectedIndex, null); };
    container.onkeydown = function (event) {
      if (event.key === "ArrowLeft") state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      else if (event.key === "ArrowRight") state.selectedIndex = Math.min(rows.length - 1, state.selectedIndex + 1);
      else if (event.key === "Home") state.selectedIndex = 0;
      else if (event.key === "End") state.selectedIndex = rows.length - 1;
      else return;
      event.preventDefault(); drawPowerChart(); container.focus();
    };
    container.onpointerleave = function () { el("chart-tooltip").hidden = true; };
  }

  function renderInterval() {
    var rows = windows();
    if (!rows.length || !state.interval) return;
    var start = state.interval.start, end = state.interval.end, step = RESOLUTION_MS[state.data.resolution] || 60000;
    var from = Date.parse(rows[start].ts), to = Date.parse(rows[end].ts) + step;
    var axisFrom = Date.parse(state.data.from_utc);
    var axisTo = (rangeFor(state.range).axisTo || new Date(state.data.to_utc)).getTime();
    var span = Math.max(step, axisTo - axisFrom);
    var slots = Math.ceil(span / step);
    ["interval-from", "interval-to"].forEach(function (id) { el(id).max = String(slots); });
    el("interval-from").value = String(Math.round((from - axisFrom) / step));
    el("interval-to").value = String(Math.round((to - axisFrom) / step));
    el("interval-range").hidden = rows.length < 2;
    var startPct = Math.max(0, Math.min(100, (from - axisFrom) / span * 100)) + "%";
    var endPct = Math.max(0, Math.min(100, (to - axisFrom) / span * 100)) + "%";
    ["interval-range", "interval-overlay"].forEach(function (id) {
      el(id).style.setProperty("--interval-start", startPct);
      el(id).style.setProperty("--interval-end", endPct);
    });
    var energy = alignedEnergy(rows.slice(start, end + 1), step, from, to, state.timezone);
    el("interval-values").textContent = clock(rows[start].ts) + " – " + clock(new Date(to).toISOString()) +
      "  ·  Solar " + (energy.valid ? energy.solar.toFixed(1) : DASH) + " kWh" +
      "  ·  Grid in " + (energy.valid ? energy.import.toFixed(1) : DASH) + " kWh" +
      "  ·  Grid out " + (energy.valid ? energy.export.toFixed(1) : DASH) + " kWh" +
      "  ·  Coverage " + energy.valid + "/" + energy.expected;
  }

  function drawDailyChart() {
    var container = el("chart"), data = state.data, from = Date.parse(data.from_utc);
    var to = (rangeFor(state.range).axisTo || new Date(data.to_utc)).getTime();
    var timezone = state.timezone;
    var rows = dailySiteRows(windows(), from, to, RESOLUTION_MS[data.resolution] || 300000, timezone);
    state.dailyRows = rows;
    if (!rows.length) { clearEChart(container, "No days in this period."); return; }
    if (state.selectedDay < 0 || state.selectedDay >= rows.length) state.selectedDay = Math.max(0, rows.findLastIndex(function (day) { return day.valid; }));
    var chart = dailySiteOption(rows, weatherHours(), { width: container.clientWidth || 640, timezone: timezone, weatherLayer: state.weatherLayer, selected: state.selectedDay, palette: chartPalette() });
    renderEChart(container, chart.option, container.clientWidth < 520 ? 338 : 410);
    container.tabIndex = 0;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Daily solar, home, and grid energy; use arrow keys for dates");
    container.setAttribute("aria-describedby", "detail");
    el("daily-window").textContent = rows[chart.first].date.slice(5) + " – " + rows[chart.first + chart.shown - 1].date.slice(5);
    el("daily-prev").disabled = chart.first === 0;
    el("daily-next").disabled = chart.first + chart.shown >= rows.length;
    el("interval-controls").hidden = true;
    showDay(state.selectedDay);
    function point(event) {
      var x = chartXValueAt(container, event.clientX);
      if (x === null) return;
      state.selectedDay = Math.max(chart.first, Math.min(chart.first + chart.shown - 1, chart.first + Math.round(x)));
      drawDailyChart();
    }
    container.onpointerdown = point;
    container.onpointermove = null;
    container.onkeydown = function (event) {
      if (event.key === "ArrowLeft") state.selectedDay = Math.max(0, state.selectedDay - 1);
      else if (event.key === "ArrowRight") state.selectedDay = Math.min(rows.length - 1, state.selectedDay + 1);
      else if (event.key === "Home") state.selectedDay = 0;
      else if (event.key === "End") state.selectedDay = rows.length - 1;
      else return;
      event.preventDefault(); drawDailyChart(); container.focus();
    };
  }

  function showDay(index) {
    var day = state.dailyRows[index];
    if (!day) return;
    el("detail").innerHTML = '<strong>' + day.date + ' · daily energy</strong><div class="point-values">' +
      '<span>Solar <b>' + (day.valid ? day.solar.toFixed(1) : DASH) + ' kWh</b></span>' +
      '<span>Home <b>' + (day.valid ? day.home.toFixed(1) : DASH) + ' kWh</b> estimated</span>' +
      '<span>Grid in <b>' + (day.valid ? day.import.toFixed(1) : DASH) + ' kWh</b></span>' +
      '<span>Grid out <b>' + (day.valid ? day.export.toFixed(1) : DASH) + ' kWh</b></span>' +
      '<span>Coverage <b>' + day.valid + ' complete windows</b></span></div>';
  }

  function drawChart() {
    el("interval-overlay").hidden = true;
    if (state.data && state.data.resolution !== "1d" && (state.range === "7d" || state.range === "30d")) return drawDailyChart();
    if (state.data && state.data.resolution !== "1d" && state.metric === "power") return drawPowerChart();
    var container = el("chart"), rows = windows(), data = state.data || {};
    if (!rows.length) { clearEChart(container, "No stored windows in this range."); return; }
    var times = rows.map(function (row) { return Date.parse(row.ts); });
    var from = Date.parse(data.from_utc), to = (rangeFor(state.range).axisTo || new Date(data.to_utc)).getTime();
    var span = Math.max(1, to - from), step = RESOLUTION_MS[data.resolution] || 60000;
    var energy = state.metric === "energy";
    var palette = chartPalette();
    var solar = solarDisplay(rows.map(function (row) {
      return valueAt(row, SERIES[0]) === null ? { ...row, pv_kw_avg: null } : row;
    }), data.resolution, span);
    el("solar-key").textContent = solar.averaged ? "Solar · 3-minute mean" : "Solar · stored reading";
    var bucketMs = span > 36 * 3600000 ? 86400000 : 3600000;
    var buckets = energy ? energyBuckets(rows, step, bucketMs, zoneOffsetMs(state.timezone, from)) : [];
    var limits = energy ? bucketBounds(buckets) : null;
    var bounds = energy ? { min: -Math.max(1, limits.down), max: limits.up }
      : chartBounds(solar.values.map(function (value) { return { pv_kw_avg: value }; }), [SERIES[0]]);
    var layer = WEATHER_LAYERS[state.weatherLayer];
    var weather = weatherHours().filter(function (hour) {
      var ts = Date.parse(hour.ts);
      return ts >= from && ts < to && typeof hour[layer.key] === "number" && isFinite(hour[layer.key]);
    });
    var weatherRange = weatherBounds(weather, layer, from, to);
    var line = [], last = null;
    solar.times.forEach(function (time, index) {
      if (last !== null && time - last > solar.step * 1.5) line.push([last + solar.step, null]);
      line.push([time, solar.values[index]]); last = time;
    });
    var series = [];
    if (energy) {
      var bucketPoints = function (key, sign) {
        return buckets.map(function (bucket) {
          var value = bucket[key];
          return [bucket.ts + bucketMs / 2, value === null ? null : sign * value];
        });
      };
      [["Solar", "solar", 1, palette.solar], ["Home", "home", 1, palette.home],
        ["Grid in", "import_kwh", 1, palette.imported], ["Grid out", "export_kwh", -1, palette.exported]].forEach(function (item) {
        series.push({ name: item[0], type: "bar", data: bucketPoints(item[1], item[2]),
          barMaxWidth: 23, itemStyle: { color: item[3] } });
      });
    } else {
      series.push({ name: "Solar", type: "line", data: line, connectNulls: false,
        showSymbol: solar.values.filter(function (value) { return value !== null; }).length < 3,
        symbolSize: 7, lineStyle: { color: palette.solar, width: 3 }, itemStyle: { color: palette.solar } });
    }
    if (weatherRange && data.resolution !== "1d") {
      series.push({ name: layer.label, type: "line", yAxisIndex: 1,
        data: weather.map(function (hour) { return [Date.parse(hour.ts), hour[layer.key]]; }),
        connectNulls: false, showSymbol: false,
        lineStyle: { color: layer.key === "cloud_cover_pct" ? palette.muted : layer.color, type: "dashed", width: 1.8 },
        itemStyle: { color: layer.color } });
    }
    if (Date.now() < to) series[0].markArea = {
      silent: true, itemStyle: { color: palette.exported, opacity: .07 },
      label: { show: to - Date.now() > 2 * 3600000, formatter: "UPCOMING", color: palette.muted, position: "insideTop", fontSize: 10 },
      data: [[{ xAxis: Math.max(from, Date.now()) }, { xAxis: to }]],
    };
    renderEChart(container, {
      grid: { left: container.clientWidth < 520 ? 43 : 58, right: weatherRange ? 52 : 20, top: 40, bottom: 36 },
      xAxis: { type: "time", min: from, max: to, boundaryGap: false, splitNumber: container.clientWidth < 520 ? 2 : 4,
        axisLine: { lineStyle: { color: palette.line } }, axisTick: { show: false },
        axisLabel: { color: palette.muted, hideOverlap: true, formatter: function (value) { return formatTime(value, span); } },
        splitLine: { show: false } },
      yAxis: [{ type: "value", min: bounds.min, max: bounds.max, name: energy ? "ENERGY · kWh" : "SOLAR · kW",
        nameTextStyle: { color: palette.text, fontWeight: 700, fontSize: 11 },
        axisLabel: { color: palette.muted, formatter: function (value) { return value.toFixed(energy ? 0 : 1); } },
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: palette.line } } },
        { type: "value", min: weatherRange ? weatherRange.min : 0, max: weatherRange ? weatherRange.max : 100,
          name: weatherRange ? layer.label.toUpperCase() + " · " + layer.unit : "", position: "right",
          nameTextStyle: { color: palette.text, fontWeight: 700, fontSize: 11 },
          axisLabel: { show: !!weatherRange, color: palette.muted },
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } }],
      series: series,
    }, container.clientWidth < 520 ? 278 : 410);
    container.tabIndex = 0;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", (energy ? "Energy" : "Solar power") + " by time; use arrow keys for stored readings");
    container.setAttribute("aria-describedby", "detail");
    var focusedIndex = rows.length - 1;
    function point(event) {
      var wanted = chartXValueAt(container, event.clientX);
      if (wanted === null) return;
      var index = 0, best = Infinity;
      times.forEach(function (ts, position) {
        var distance = Math.abs(ts - wanted);
        if (distance < best) { best = distance; index = position; }
      });
      focusedIndex = index; showDetail(index, event);
    }
    container.onpointermove = point;
    container.onpointerdown = point;
    container.onfocus = function () { showDetail(focusedIndex, null); };
    container.onkeydown = function (event) {
      if (event.key === "ArrowLeft") focusedIndex = Math.max(0, focusedIndex - 1);
      else if (event.key === "ArrowRight") focusedIndex = Math.min(rows.length - 1, focusedIndex + 1);
      else if (event.key === "Home") focusedIndex = 0;
      else if (event.key === "End") focusedIndex = rows.length - 1;
      else return;
      event.preventDefault(); showDetail(focusedIndex, null);
    };
    container.onpointerleave = function () { el("chart-tooltip").hidden = true; };
  }

  function showDetail(index, pointer) {
    var rows = windows();
    var window = rows[index];
    if (!window) return;
    var when = new Date(window.ts);
    var label = window.local_date ? window.local_date + " (" + (state.data.timezone || "UTC") + ")" : when.toLocaleString();
    var quality = window.quality + (window.complete ? " / complete" : " / incomplete");
    var coverage = window.windows
      ? window.ok_windows + " of " + window.windows + " minutes ok"
      : (window.valid_count || 0) + " of " + (window.sample_count || 0) + " samples used";
    var values = SERIES.map(function (series) {
      return series.label + " " + formatKw(valueAt(window, series));
    }).join(" \u00b7 ");
    var hour = weatherNear(Date.parse(window.ts));
    var weatherLine = "";
    if (hour) {
      var layer = WEATHER_LAYERS[state.weatherLayer];
      weatherLine =
        "<p>Weather " + weatherText(hour.weather_code) +
        " \u00b7 " + fmt(hour.temperature_c, 1) + " \u00b0C \u00b7 cloud " + fmt(hour.cloud_cover_pct, 0) + "%" +
        " \u00b7 rain " + fmt(hour.precipitation_mm, 1) + " mm (" + fmt(hour.precipitation_probability_pct, 0) + "%)" +
        " \u00b7 UV " + fmt(hour.uv_index, 1) +
        " \u00b7 " + layer.label + " " + fmt(hour[layer.key], layer.digits) + " " + layer.unit +
        " \u00b7 " + (hour.source || "no source") + (hour.stale ? " (stale)" : "") + "</p>";
    } else if (state.weather && state.weather.configured) {
      weatherLine = "<p>No stored weather hour for this window.</p>";
    }
    el("detail").innerHTML =
      "<p><strong>" + label + "</strong> \u00b7 " + quality + "</p><p>" + values + "</p><p>" + coverage +
      (window.source_error_windows ? " \u00b7 " + window.source_error_windows + " failed minute(s) in this window" : "") +
      "</p>" + weatherLine;
    // The same reading follows the pointer, so the chart itself is readable.
    var tip = el("chart-tooltip");
    tip.hidden = pointer === null;
    tip.innerHTML = el("detail").innerHTML;
    if (pointer !== null) {
      tip.style.left = Math.min(globalThis.window.innerWidth - 200, pointer.clientX + 12) + "px";
      tip.style.top = Math.max(8, pointer.clientY - 48) + "px";
    }
  }

  function fmt(value, digits) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(digits) : DASH;
  }

function render() {
    var data = state.data;
    if (!data) return;
    var fromMs = Date.parse(data.from_utc);
    var toMs = Date.parse(data.to_utc);
    var span = isFinite(fromMs) && isFinite(toMs) && toMs > fromMs ? toMs - fromMs : 0;
    var selectedRange = rangeFor(state.range);
    renderPeriodControls(span ? { from: new Date(fromMs), to: new Date(toMs), axisTo: selectedRange.axisTo } : selectedRange);
    state.aligned = data.resolution === "1d" ? null : alignedEnergy(
      windows(), RESOLUTION_MS[data.resolution] || 60000, fromMs, toMs,
      state.timezone,
    );
    el("calibration-note").textContent = "Grid and home are estimates using " +
      (gridRatio(data) * 100).toFixed(1) + "% PVS / utility grid flow. Change in Settings.";
    [].forEach.call(el("metrics").querySelectorAll("button[data-metric]"), function (item) {
      if (item.dataset.metric === "energy") {
        item.disabled = data.resolution === "1d";
        item.title = item.disabled ? "Choose a range up to 31 days for energy" : "";
      }
    });
    if (data.resolution === "1d" && state.metric === "energy") {
      state.metric = "power";
      writeUrl();
      [].forEach.call(el("metrics").querySelectorAll("button"), function (item) {
        item.setAttribute("aria-pressed", String(item.dataset.metric === "power"));
      });
    }
    var rows = windows();
    var summary = data.summary || {};
    el("state").textContent =
      (state.range === "custom" ? "Custom range · " : "") +
      summary.ok + " complete of " + summary.windows + " stored windows";
    el("state").dataset.state = summary.source_error ? "delayed" : "live";
    // The bucket size follows the requested range, which the chart axis shows.
    var isDailyEnergy = state.range === "7d" || state.range === "30d";
    var isCustomEnergy = state.range === "custom" && state.metric === "energy";
    var weatherName = WEATHER_LAYERS[state.weatherLayer].label.toLowerCase();
    el("chart-title").textContent =
      data.resolution === "1d" ? "Daily average solar power" :
        state.range === "7d" || state.range === "30d" ? "Day-by-day energy" :
          isCustomEnergy ? "Energy by window" : "Solar shape & grid direction";
    el("chart-subtitle").textContent = data.resolution === "1d"
      ? "Only stored daily averages are available here. The blank part has no history."
      : state.range === "7d" || state.range === "30d"
        ? "Daily solar and home energy share one date axis with forecast " + weatherName + "; grid direction sits below."
        : isCustomEnergy
          ? "Solar, home, and grid energy by window; forecast " + weatherName + " uses the right axis."
          : "Solar and signed grid power share the kW axis; forecast " + weatherName + " uses the right axis.";
    el("power-legend").hidden = data.resolution === "1d" || isDailyEnergy || isCustomEnergy;
    el("energy-legend").hidden = data.resolution === "1d" || !el("power-legend").hidden;
    el("composition").hidden = data.resolution === "1d";
    el("interval-controls").hidden = data.resolution === "1d" || isCustomEnergy;
    var banner = el("banner");
    if (summary.windows === 0) {
      banner.hidden = false;
      banner.textContent = "No stored windows for this range. Missing data is not zero.";
    } else if (summary.truncated) {
      banner.hidden = false;
      banner.textContent = "This range was truncated by the server; narrow it for the full picture.";
    } else if (summary.source_error) {
      var longest = { start: null, count: 0 };
      var run = { start: null, count: 0 };
      rows.forEach(function (row) {
        if (row.quality === "source_error") {
          if (run.count === 0) run.start = row.ts;
          run.count += 1;
          if (run.count > longest.count) longest = { start: run.start, count: run.count };
        } else {
          run.count = 0;
        }
      });
      var stepMs = RESOLUTION_MS[data.resolution] || 60000;
      var minutes = Math.round(longest.count * stepMs / 60000);
      var end = longest.start ? new Date(Date.parse(longest.start) + longest.count * stepMs).toISOString() : null;
      banner.hidden = false;
      banner.textContent = longest.start
        ? "Readings unavailable " + clock(longest.start) + "–" + clock(end) +
          " (" + Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") +
          "m largest gap). Averages use valid readings only; missing values are not zero."
        : "Some PVS readings are missing. Averages use valid readings only; missing values are not zero.";
    } else {
      banner.hidden = true;
    }
    var aligned = state.aligned;
    var yearSolar = data.resolution === "1d" ? counterDelta(windows(), "pv_kwh_total_end") : null;
    var metrics = [
      [data.resolution === "1d" ? "Solar in stored records" : "Solar produced", aligned && aligned.valid ? aligned.solar : yearSolar],
      ["Home used · estimate", aligned && aligned.valid ? aligned.home : null],
      ["Grid imported", aligned && aligned.valid ? aligned.import : null],
      ["Grid exported", aligned && aligned.valid ? aligned.export : null],
    ];
    el("summary").classList.toggle("year-summary", data.resolution === "1d");
    el("summary").innerHTML = (data.resolution === "1d" ? metrics.slice(0, 1) : metrics).map(function (metric) {
      return '<article><span>' + metric[0] + '</span><strong>' + (metric[1] === null ? DASH : metric[1].toFixed(1)) +
        ' <small>kWh</small></strong></article>';
    }).join("");
    renderEnergy();
    drawChart();
    renderWeatherLegend();
    // Say what a bar is, which series is measured, and that the labels on the
    // line belong to the right axis.
    el("chart-note").textContent = data.resolution === "1d"
      ? "The solar total covers the stored dates only; it is not a total for the entire selected year."
      : state.range === "7d" || state.range === "30d"
        ? "Each date keeps its calendar position. Shaded dates are upcoming; earlier blank bars have no complete readings. The forecast line shows " + (state.weatherLayer === "precipitation" ? "daily precipitation totals" : state.weatherLayer === "uv" ? "daytime UV peaks" : "daytime " + weatherName + " averages") + "."
        : isCustomEnergy
          ? "Each bar covers one measured window; blank spans have no complete reading."
          : "";
    // When the requested range reaches back before the first stored record, say
    // so: a blank stretch is missing history, not a quiet site.
    if (rows.length > 0 && span > 0) {
      var covered = Date.parse(rows[rows.length - 1].ts) - Date.parse(rows[0].ts);
      if (covered < span * 0.9) {
        el("chart-note").textContent =
          "Stored records start " + formatTime(Date.parse(rows[0].ts), span) + "; the blank part of this range has no history. " +
          el("chart-note").textContent;
      }
    }
    el("chart-note").hidden = !el("chart-note").textContent;
  }

  /**
   * Sources and destinations for the same range, never normalised to match:
   * the page shows both totals and how far apart they are.
   */
  function renderEnergy() {
    var data = state.data || {};
    disposeEChart(document.getElementById("source-donut"));
    disposeEChart(document.getElementById("destination-bar"));
    if (data.resolution === "1d") {
      el("energy-sources").textContent = "A source split needs complete site readings.";
      el("energy-destinations").textContent = "Choose a period of 31 days or less.";
      el("energy-note").textContent = "Daily averages cannot show grid direction changes within each day.";
      el("energy-warning").hidden = true;
      return;
    }
    var energy = state.aligned;
    var incomplete = energy.valid < energy.expected;
    el("energy-warning").hidden = !incomplete;
    if (incomplete) {
      el("energy-warning").textContent = "Partial estimate · " + energy.valid + "/" + energy.expected +
        " complete, aligned windows. Missing time is excluded from every share.";
    }
    if (!energy.valid) {
      el("energy-sources").textContent = "No complete readings for a source split.";
      el("energy-destinations").textContent = "Missing readings remain unknown, not zero.";
      el("energy-note").textContent = "";
      return;
    }
    var kwh = function (value) { return value.toFixed(1) + " kWh"; };
    var solarShare = energy.home > 0 ? energy.self / energy.home * 100 : 0;
    var solarUsed = energy.solar > 0 ? energy.self / energy.solar * 100 : 0;
    el("energy-sources").innerHTML = energy.home < 0.05 ?
      '<h3>What powered the home?</h3><p class="note">Less than 0.1 kWh of home use in this period.</p>' :
      '<h3>What powered the home?</h3><p class="note">Estimated share of measured home use</p>' +
      '<div class="source-composition"><div class="source-donut-wrap"><div class="source-donut" id="source-donut" role="img" aria-label="' + solarShare.toFixed(0) +
      '% solar on site, ' + (100 - solarShare).toFixed(0) + '% grid import"></div><span class="donut-center"><strong>' +
      kwh(energy.home) + '</strong><small>home use</small></span></div><div class="source-labels">' +
      '<p><span>Solar on site</span><b>' + solarShare.toFixed(0) + '% · ' + kwh(energy.self) + '</b></p>' +
      '<p><span>Grid import</span><b>' + (100 - solarShare).toFixed(0) + '% · ' + kwh(energy.import) + '</b></p></div></div>';
    el("energy-destinations").innerHTML = energy.solar < 0.05 ?
      '<h3>Where did solar go?</h3><p class="note">Less than 0.1 kWh of solar production in this period.</p>' :
      '<h3>Where did solar go?</h3><p class="note">Estimated destinations of measured production</p>' +
      '<p class="destination-total"><strong>' + kwh(energy.solar) + '</strong> solar produced</p>' +
      '<div class="destination-bar" id="destination-bar" role="img" aria-label="' + solarUsed.toFixed(0) + '% used at home, ' +
      (100 - solarUsed).toFixed(0) + '% exported"></div>' +
      '<div class="destination-labels"><p>Used at home <strong>' + kwh(energy.self) + '</strong></p>' +
      '<p>Sent to grid <strong>' + kwh(energy.export) + '</strong></p></div>';
    var palette = chartPalette();
    if (energy.home >= 0.05) {
      var sourceChart = document.getElementById("source-donut");
      renderEChart(sourceChart, {
      aria: { enabled: false },
      series: [{ name: "Home energy sources", type: "pie", radius: ["76%", "92%"], center: ["50%", "50%"],
        label: { show: false }, labelLine: { show: false }, emphasis: { disabled: true },
        data: [{ name: "Solar on site", value: solarShare, itemStyle: { color: palette.solar } },
          { name: "Grid import", value: Math.max(0, 100 - solarShare), itemStyle: { color: palette.imported } }] }],
      }, Math.min(150, sourceChart.clientWidth || 150));
    }
    if (energy.solar >= 0.05) renderEChart(document.getElementById("destination-bar"), {
      aria: { enabled: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { type: "value", min: 0, max: 100, show: false },
      yAxis: { type: "category", data: [""], show: false },
      series: [{ name: "Used at home", type: "bar", stack: "solar", barWidth: 18,
        data: [solarUsed], itemStyle: { color: palette.solar } },
      { name: "Sent to grid", type: "bar", stack: "solar", barWidth: 18,
        data: [Math.max(0, 100 - solarUsed)], itemStyle: { color: palette.exported } }],
    }, 22);
    el("energy-note").textContent =
      "Shares use only complete site readings. Direction reversals inside one stored window remain an estimate.";
  }

  function counterLabel(value) {
    return value === null ? DASH : value.toFixed(1) + " kWh (lifetime counter)";
  }

  /* Weather is a separate request: its absence must never blank the power chart. */
  function loadWeather(from, to, requestId) {
    if (to - from > 31 * 86400000) {
      state.weather = null;
      renderWeatherLegend();
      return;
    }
    fetch("/api/v1/weather?from=" + iso(from) + "&to=" + iso(to), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(function (response) {
        if (response.status === 401) {
          window.location.href = "/auth/login";
          return null;
        }
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (requestId !== state.requestId) return;
        state.weather = data;
        renderWeatherLegend();
        if (state.data) render();
      })
      .catch(function () {
        if (requestId !== state.requestId) return;
        state.weather = null;
        if (state.data) render();
      });
  }

  function load() {
    var requestId = state.requestId = (state.requestId || 0) + 1;
    var range = rangeFor(state.range);
    state.data = null;
    state.weather = null;
    el("from").value = toLocalInput(range.from);
    el("to").value = toLocalInput(range.to);
    loadWeather(range.from, range.to, requestId);
    fetch(
      "/api/v1/history?from=" + iso(range.from) + "&to=" + iso(range.to) + "&resolution=" + range.resolution,
      { headers: { Accept: "application/json" }, cache: "no-store" },
    )
      .then(function (response) {
        if (response.status === 401) {
          window.location.href = "/auth/login";
          return null;
        }
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data && requestId === state.requestId) {
          state.data = calibrateHistory(data);
          render();
          if (pendingCompositionAnchor && !el("composition").hidden) {
            pendingCompositionAnchor = false;
            el("composition").scrollIntoView({ block: "start" });
          }
        }
      })
      .catch(function () {
        if (requestId !== state.requestId) return;
        el("banner").hidden = false;
        el("banner").textContent = "Could not read history. Values are unknown, not zero.";
      });
  }

  function toLocalInput(moment) {
    var offset = moment.getTime() - moment.getTimezoneOffset() * 60000;
    return new Date(offset).toISOString().slice(0, 16);
  }

  el("ranges").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-range]");
    if (!button) return;
    state.range = button.dataset.range;
    state.period = PERIODS[state.range][0][0];
    state.metric = "power";
    state.selectedIndex = -1;
    state.selectedDay = -1;
    state.interval = null;
    writeUrl();
    [].forEach.call(el("ranges").querySelectorAll("button"), function (item) {
      item.setAttribute("aria-pressed", String(item === button));
    });
    load();
  });

  el("scope-slider").addEventListener("input", function (event) {
    var range = ["today", "7d", "30d", "12m"][Number(event.target.value)];
    var button = el("ranges").querySelector('[data-range="' + range + '"]');
    if (button && range !== state.range) button.click();
  });

  el("period-options").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-period]");
    if (!button || button.dataset.period === state.period) return;
    state.period = button.dataset.period;
    state.selectedIndex = -1;
    state.selectedDay = -1;
    state.interval = null;
    writeUrl();
    load();
  });

  ["daily-prev", "daily-next"].forEach(function (id) {
    el(id).addEventListener("click", function () {
      var rows = state.dailyRows || [];
      if (!rows.length) return;
      state.selectedDay = Math.max(0, Math.min(rows.length - 1, state.selectedDay + (id === "daily-prev" ? -7 : 7)));
      drawDailyChart();
    });
  });

  ["interval-from", "interval-to"].forEach(function (id) {
    el(id).addEventListener("input", function (event) {
      if (!state.interval) return;
      var rows = windows(), step = RESOLUTION_MS[state.data.resolution] || 60000;
      var wanted = Date.parse(state.data.from_utc) + Number(event.target.value) * step;
      var edge = id === "interval-to" ? step : 0;
      var best = 0, distance = Infinity;
      rows.forEach(function (row, index) {
        var gap = Math.abs(Date.parse(row.ts) + edge - wanted);
        if (gap < distance) { best = index; distance = gap; }
      });
      if (id === "interval-from") state.interval.start = Math.min(best, state.interval.end);
      else state.interval.end = Math.max(best, state.interval.start);
      renderInterval();
    });
  });

  el("metrics").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-metric]");
    if (!button) return;
    if (state.data && state.data.resolution === "1d" && button.dataset.metric === "energy") return;
    state.metric = button.dataset.metric;
    writeUrl();
    [].forEach.call(el("metrics").querySelectorAll("button"), function (item) {
      item.setAttribute("aria-pressed", String(item === button));
    });
    render();
  });

  el("weathers").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-weather]");
    if (!button) return;
    state.weatherLayer = button.dataset.weather;
    writeUrl();
    [].forEach.call(el("weathers").querySelectorAll("button"), function (item) {
      item.setAttribute("aria-pressed", String(item === button));
    });
    render();
  });

  el("custom").addEventListener("submit", function (event) {
    event.preventDefault();
    var from = new Date(el("from").value);
    var to = new Date(el("to").value);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) {
      el("banner").hidden = false;
      el("banner").textContent = "Enter a start before the end.";
      return;
    }
    state.range = "custom";
    state.custom = { from: from, to: to };
    state.selectedIndex = -1;
    state.selectedDay = -1;
    state.interval = null;
    [].forEach.call(el("ranges").querySelectorAll("button"), function (item) {
      item.setAttribute("aria-pressed", "false");
    });
    writeUrl();
    load();
  });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(drawChart, 200);
  });

  initWeatherControls(el("weather-controls"), window.matchMedia("(max-width: 1000px)"));
  readUrl();
  fetch("/api/v1/location", { headers: { Accept: "application/json" }, cache: "no-store" })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (location) { state.timezone = location && location.timezone; load(); })
    .catch(load);
})();
