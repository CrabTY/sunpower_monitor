import { WEATHER_LAYERS, alignedEnergy, num, solarDisplay, weatherBounds } from "./chart.js";

const DAY = 86400000;
const HOUR = 3600000;
const DEFAULT = { solar: "#e97400", solarText: "#b95300", home: "#5e7180", imported: "#377eb8", exported: "#43a340", muted: "#5e7180", text: "#152330", line: "#d9e2e8", danger: "#984ea3" };

function localClock(ms, timezone, span) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", ...(span < 2 * HOUR ? { minute: "2-digit" } : {}), timeZone: timezone || undefined }).format(ms);
}

function dateKey(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function spacedLine(times, values, step) {
  const data = [];
  times.forEach((time, index) => {
    if (index && time - times[index - 1] > step * 1.5) data.push([times[index - 1] + step, null]);
    data.push([time, values[index]]);
  });
  return data;
}

function valueAxis(name, min, max, palette, side = "left", gridIndex = 0, split = true) {
  return {
    type: "value", gridIndex, position: side, min, max, name,
    nameTextStyle: { color: palette.text, fontSize: 11, fontWeight: 700, padding: [0, 0, 4, 0] },
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { color: palette.muted, fontSize: 11, formatter: (value) => Number(value).toFixed(Math.abs(max) < 10 ? 1 : 0) },
    splitLine: { show: split, lineStyle: { color: palette.line } },
    splitNumber: 2,
  };
}

function futureArea(from, to, now, palette) {
  if (!(now < to)) return undefined;
  return {
    silent: true,
    itemStyle: { color: palette.exported, opacity: 0.07 },
    label: { show: to - Math.max(from, now) > 2 * HOUR, formatter: "UPCOMING", color: palette.muted, fontSize: 10, fontWeight: 700, position: "insideTop" },
    data: [[{ xAxis: Math.max(from, now) }, { xAxis: to }]],
  };
}

/** A fixed time axis; measured points retain their actual spacing. */
export function powerGridOption(windows, hours, options) {
  const { from, to, resolution, timezone, selected } = options;
  const combined = options.layout === "combined";
  const palette = { ...DEFAULT, ...options.palette };
  const layer = WEATHER_LAYERS[options.weatherLayer] || WEATHER_LAYERS.cloud;
  const span = Math.max(1, to - from), mobile = (options.width || 640) < 520;
  const complete = (windows || []).map((row) => row.quality === "ok" && row.complete === true &&
    num(row.pv_kw_avg) !== null && num(row.grid_kw_avg) !== null && num(row.load_kw_reported_avg) !== null
    ? row : { ...row, pv_kw_avg: null });
  const solar = solarDisplay(complete, resolution, span);
  const solarPeak = Math.ceil(Math.max(6, ...solar.values.filter((value) => value !== null).map((value) => value * 1.1)) / 2) * 2;
  const weather = (hours || []).filter((hour) => Date.parse(hour.ts) >= from && Date.parse(hour.ts) < to && num(hour[layer.key]) !== null);
  const weatherScale = weatherBounds(weather, layer, from, to) || { min: layer.min ?? 0, max: layer.max ?? 100 };
  const grain = span > 6 * HOUR ? 15 * 60000 : 5 * 60000;
  const buckets = new Map();
  (windows || []).forEach((row) => {
    const ts = Date.parse(row.ts), value = num(row.grid_kw_avg);
    if (!Number.isFinite(ts) || ts < from || ts >= to) return;
    const key = Math.floor((ts - from) / grain), bucket = buckets.get(key) || { sum: 0, count: 0 };
    if (row.quality === "ok" && row.complete === true && value !== null && num(row.pv_kw_avg) !== null && num(row.load_kw_reported_avg) !== null) {
      bucket.sum += value; bucket.count++;
    }
    buckets.set(key, bucket);
  });
  const gridPeak = Math.max(6, ...Array.from(buckets.values()).filter((bucket) => bucket.count).map((bucket) => Math.abs(bucket.sum / bucket.count) * 1.1));
  const expected = Math.max(1, Math.round(grain / (resolution === "5m" ? 300000 : 60000)));
  const importData = [], exportData = [];
  buckets.forEach((bucket, key) => {
    if (!bucket.count) return;
    const value = bucket.sum / bucket.count, datum = { value: [from + (key + .5) * grain, value], itemStyle: { opacity: bucket.count < expected ? 0.45 : 0.9 } };
    (value >= 0 ? importData : exportData).push(datum);
  });
  const left = mobile ? 41 : 56, right = mobile ? 43 : 57;
  const xAxis = (combined ? [0] : [0, 1]).map((gridIndex) => ({
    type: "time", gridIndex, min: from, max: to, boundaryGap: false,
    axisLine: { show: combined || gridIndex === 1, lineStyle: { color: palette.line } },
    axisTick: { show: false },
    axisLabel: { show: combined || gridIndex === 1, color: palette.muted, fontSize: 11, hideOverlap: true, formatter: (value) => localClock(value, timezone, span) },
    splitLine: { show: false }, splitNumber: mobile ? 3 : 4,
  }));
  const solarSeries = {
    name: "Solar", type: "line", xAxisIndex: 0, yAxisIndex: 0,
    data: spacedLine(solar.times, solar.values, solar.step), connectNulls: false,
    showSymbol: solar.values.filter((value) => value !== null).length < 3,
    symbolSize: 7, lineStyle: { color: palette.solar, width: 3 }, itemStyle: { color: palette.solar },
    markArea: futureArea(from, to, options.now ?? Date.now(), palette),
  };
  const bad = [];
  const stepMs = resolution === "5m" ? 300000 : resolution === "1d" ? DAY : 60000;
  (windows || []).forEach((row) => {
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < from || ts >= to) return;
    if (row.quality === "ok" && row.complete === true && num(row.pv_kw_avg) !== null && num(row.grid_kw_avg) !== null && num(row.load_kw_reported_avg) !== null) return;
    const previous = bad[bad.length - 1];
    if (previous && ts <= previous[1].xAxis + stepMs / 2) previous[1].xAxis = Math.min(to, ts + stepMs);
    else bad.push([{ xAxis: ts, itemStyle: { color: palette.danger, opacity: 0.14 }, label: { show: false } }, { xAxis: Math.min(to, ts + stepMs) }]);
  });
  if (bad.length) {
    if (!solarSeries.markArea) solarSeries.markArea = { silent: true, label: { show: false }, data: [] };
    solarSeries.markArea.data.unshift(...bad);
  }
  const daylight = span <= 2 * DAY ? (options.daylightDays || []).flatMap((day) =>
    [[day.sunrise_utc, "Sunrise"], [day.sunset_utc, "Sunset"]].flatMap(([iso, name]) => {
      const time = Date.parse(iso);
      return Number.isFinite(time) && time > from && time < to ? [{
        name, xAxis: time,
        lineStyle: { color: palette.solar, type: "dotted", width: 1, opacity: 0.75 },
        label: { show: true, formatter: `${name} ${localClock(time, timezone, 0)}`, color: palette.solarText, fontSize: 10, position: "end", rotate: 0, distance: 5 },
      }] : [];
    })) : [];
  if (Number.isFinite(selected) && selected >= from && selected < to) daylight.push({
    xAxis: selected, lineStyle: { color: palette.text, type: "dashed", width: 1 }, label: { show: false },
  });
  if (daylight.length) solarSeries.markLine = { silent: true, symbol: "none", data: daylight };
  const weatherData = spacedLine(weather.map((hour) => Date.parse(hour.ts)), weather.map((hour) => hour[layer.key]), HOUR);
  const gridAxis = combined ? 0 : 1, gridValueAxis = combined ? 0 : 2;
  return {
    grid: combined ? [{ left, right, top: 38, height: options.plotHeight ?? 252 }] : [{ left, right, top: 38, height: 139 }, { left, right, top: 216, height: 78 }],
    xAxis,
    yAxis: [
      valueAxis(combined ? "POWER · kW   grid in + / out −" : "SOLAR · kW", combined ? -gridPeak : 0, Math.max(solarPeak, combined ? gridPeak : 0), palette),
      valueAxis(`${layer.label.toUpperCase()} · ${layer.unit}`, weatherScale.min, weatherScale.max, palette, "right", 0, false),
      ...(combined ? [] : [valueAxis("GRID · kW   in + / out −", -gridPeak, gridPeak, palette, "left", 1)]),
    ],
    tooltip: { trigger: "axis", triggerOn: "mousemove|click", showContent: false,
      axisPointer: { type: "line", snap: false, lineStyle: { color: palette.text, width: 1, opacity: 0.55 } } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    series: [
      solarSeries,
      { name: layer.label, type: "line", xAxisIndex: 0, yAxisIndex: 1, data: weatherData, connectNulls: false, showSymbol: false, lineStyle: { color: layer.key === "cloud_cover_pct" ? palette.muted : layer.color, type: "dashed", width: 1.8 }, itemStyle: { color: layer.color } },
      { name: "Grid in", type: "bar", xAxisIndex: gridAxis, yAxisIndex: gridValueAxis, data: importData, barMaxWidth: combined ? 12 : 26, barMinWidth: 2, itemStyle: { color: palette.imported, borderRadius: [2, 2, 0, 0] } },
      { name: "Grid out", type: "bar", xAxisIndex: gridAxis, yAxisIndex: gridValueAxis, data: exportData, barMaxWidth: combined ? 12 : 26, barMinWidth: 2, itemStyle: { color: palette.exported, borderRadius: [0, 0, 2, 2] } },
    ],
  };
}

/** Calendar dates stay present even when every site reading for a day is missing. */
export function dailySiteRows(windows, from, to, resolutionMs, timezone) {
  const aligned = alignedEnergy(windows, resolutionMs, from, to, timezone);
  const byDate = new Map(aligned.days.map((day) => [day.date, day]));
  const first = dateKey(from, timezone), last = dateKey(to - 1, timezone), rows = [];
  for (let cursor = Date.parse(`${first}T12:00:00Z`), guard = 0; guard < 370; cursor += DAY, guard++) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    rows.push(byDate.get(key) || { date: key, solar: null, home: null, import: null, export: null, self: null, valid: 0 });
    if (key === last) break;
  }
  return rows;
}

export function dailySiteOption(rows, weatherHours, options) {
  const { timezone, selected } = options;
  const layer = WEATHER_LAYERS[options.weatherLayer] || WEATHER_LAYERS.cloud;
  const palette = { ...DEFAULT, ...options.palette };
  const mobile = (options.width || 640) < 520;
  const first = mobile && rows.length > 7 ? Math.max(0, Math.min(rows.length - 7, selected - 3)) : 0;
  const shown = mobile ? rows.slice(first, first + 7) : rows;
  const peak = Math.max(1, ...rows.map((day) => Math.max(day.solar || 0, day.home || 0))) * 1.12;
  const gridPeak = Math.max(1, ...rows.map((day) => Math.max(day.import || 0, day.export || 0))) * 1.18;
  const weather = new Map();
  (weatherHours || []).forEach((hour) => {
    const ts = Date.parse(hour.ts), value = num(hour[layer.key]);
    if (!Number.isFinite(ts) || value === null) return;
    const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, hour: "numeric", hourCycle: "h23" }).format(ts));
    if (layer.key !== "precipitation_mm" && (localHour < 7 || localHour >= 19)) return;
    const key = dateKey(ts, timezone), bucket = weather.get(key) || { sum: 0, count: 0, peak: 0 };
    bucket.sum += value; bucket.count++; bucket.peak = Math.max(bucket.peak, value); weather.set(key, bucket);
  });
  const weatherData = shown.map((day) => {
    const bucket = weather.get(day.date);
    return !bucket ? null : layer.key === "precipitation_mm" ? bucket.sum
      : layer.key === "uv_index" ? bucket.peak : bucket.sum / bucket.count;
  });
  const weatherScale = weatherBounds(shown.map((day, index) => ({ ts: `${day.date}T12:00:00Z`, [layer.key]: weatherData[index] })), layer, -Infinity, Infinity)
    || { min: 0, max: 100 };
  if (layer.key === "precipitation_mm" || layer.key === "uv_index") {
    weatherScale.min = 0; weatherScale.max = Math.max(1, weatherScale.max);
  }
  const weatherName = mobile ? layer.label.toUpperCase()
    : layer.key === "precipitation_mm" ? "DAILY PRECIPITATION"
      : layer.key === "uv_index" ? "DAYTIME UV PEAK" : `DAYTIME ${layer.label.toUpperCase()}`;
  const weatherAxis = valueAxis(`${weatherName} · ${layer.unit}`, weatherScale.min, weatherScale.max, palette, "right", 0, false);
  weatherAxis.axisLabel.formatter = (value) => Number(value).toFixed(layer.digits);
  const today = dateKey(options.now ?? Date.now(), timezone);
  const firstFuture = shown.findIndex((day) => day.date > today);
  const future = firstFuture < 0 ? undefined : {
    silent: true, itemStyle: { color: palette.exported, opacity: 0.07 },
    label: { show: shown.length - firstFuture > 1, formatter: "UPCOMING", color: palette.muted, position: "insideTop", fontSize: 10, fontWeight: 700 },
    data: [[{ xAxis: firstFuture - 0.5 }, { xAxis: shown[shown.length - 1].date }]],
  };
  const categories = shown.map((day) => day.date);
  const xAxis = [0, 1].map((gridIndex) => ({
    type: "category", gridIndex, data: categories, boundaryGap: true,
    axisLine: { show: gridIndex === 1, lineStyle: { color: palette.line } }, axisTick: { show: false },
    axisLabel: { show: gridIndex === 1, color: palette.muted, fontSize: 11, hideOverlap: true, interval: Math.max(0, Math.ceil(shown.length / (mobile ? 6 : 10)) - 1), formatter: (value) => value.slice(5) },
    splitLine: { show: false },
  }));
  return {
    option: {
      grid: [{ left: mobile ? 41 : 56, right: mobile ? 43 : 57, top: 38, height: mobile ? 139 : 185 },
        { left: mobile ? 41 : 56, right: mobile ? 43 : 57, top: mobile ? 216 : 265, height: mobile ? 78 : 105 }],
      xAxis,
      yAxis: [valueAxis("SOLAR / HOME · kWh", 0, peak, palette),
        weatherAxis,
        valueAxis("GRID · kWh   in + / out −", -gridPeak, gridPeak, palette, "left", 1)],
      series: [
        ...["solar", "home"].map((measure) => ({
          name: measure === "home" ? "Home (estimated)" : "Solar", type: "bar", xAxisIndex: 0, yAxisIndex: 0,
          data: shown.map((day) => day.valid ? day[measure] : null), barMaxWidth: 28,
          itemStyle: { color: palette[measure], borderRadius: [3, 3, 0, 0] }, ...(measure === "solar" ? { markArea: future } : {}),
        })),
        { name: layer.label, type: "line", xAxisIndex: 0, yAxisIndex: 1, data: weatherData,
          connectNulls: false, showSymbol: false, lineStyle: { color: layer.key === "cloud_cover_pct" ? palette.muted : layer.color, type: "dashed", width: 1.8 }, itemStyle: { color: layer.color } },
        { name: "Grid in", type: "bar", xAxisIndex: 1, yAxisIndex: 2,
          data: shown.map((day) => day.valid ? day.import : null), stack: "grid", barMaxWidth: 28, itemStyle: { color: palette.imported, borderRadius: [2, 2, 0, 0] } },
        { name: "Grid out", type: "bar", xAxisIndex: 1, yAxisIndex: 2,
          data: shown.map((day) => day.valid ? -day.export : null), stack: "grid", barMaxWidth: 28, itemStyle: { color: palette.exported, borderRadius: [0, 0, 2, 2] } },
      ],
    }, first, shown: shown.length,
  };
}
