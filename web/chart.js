/* Shared energy calculations and chart scales for Live and History. */

export var COLORS = { solar: "var(--solar)", home: "var(--muted)", grid: "var(--grid-in)", export: "var(--grid-out)" };
export var RESOLUTION_MS = { "1m": 60000, "5m": 300000, "1d": 86400000 };
export var SERIES = [
  { key: "pv_kw_avg", label: "Solar", color: COLORS.solar },
  { key: "load_kw_reported_avg", label: "Home (estimated)", color: COLORS.home },
  { key: "grid_kw_avg", label: "Grid (estimated, import +)", color: COLORS.grid },
];

/* One right axis per weather metric; never a shared numeric scale. */
export var WEATHER_LAYERS = {
  cloud: { key: "cloud_cover_pct", label: "Cloud cover", unit: "%", digits: 0, color: "#64766e", min: 0, max: 100 },
  temperature: { key: "temperature_c", label: "Temperature", unit: "\u00b0C", digits: 1, color: "#c76b3f" },
  precipitation: { key: "precipitation_mm", label: "Precipitation", unit: "mm", digits: 2, color: "#2f8fbf", min: 0 },
  uv: { key: "uv_index", label: "UV index", unit: "UV", digits: 1, color: "#8e6fc9", min: 0 },
};

export function num(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

/** Fewer points for a long solar trace. An incomplete bucket stays empty. */
export function solarDisplay(windows, resolution, spanMs) {
  var raw = (windows || []).map(function (row) {
    return { ts: Date.parse(row.ts), value: num(row.pv_kw_avg) };
  });
  // A full-day display axis must not hide a handful of early readings behind
  // a three-minute aggregation that cannot yet form complete groups.
  var observedSpan = raw.length > 1 ? raw[raw.length - 1].ts - raw[0].ts : 0;
  if (resolution !== "1m" || observedSpan <= 4 * 3600000) {
    return { times: raw.map(function (row) { return row.ts; }), values: raw.map(function (row) { return row.value; }), step: RESOLUTION_MS[resolution] || 60000, averaged: false };
  }
  var bucketMs = 3 * 60000;
  var buckets = new Map();
  (windows || []).forEach(function (row) {
    var ts = Date.parse(row.ts);
    if (!isFinite(ts)) return;
    var start = Math.floor(ts / bucketMs) * bucketMs;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(row);
  });
  var starts = Array.from(buckets.keys()).sort(function (a, b) { return a - b; });
  return {
    times: starts.map(function (start) { return start + 60000; }),
    values: starts.map(function (start) {
      var rows = buckets.get(start).sort(function (a, b) { return Date.parse(a.ts) - Date.parse(b.ts); });
      if (rows.length !== 3 || rows.some(function (row, index) {
        return Date.parse(row.ts) !== start + index * 60000 || row.quality !== "ok" || num(row.pv_kw_avg) === null;
      })) return null;
      return rows.reduce(function (sum, row) { return sum + row.pv_kw_avg; }, 0) / 3;
    }),
    step: bucketMs,
    averaged: true,
  };
}

/** Site-time-zone offset in milliseconds at an instant; 0 when it cannot be read. */
export function zoneOffsetMs(timezone, whenMs) {
  var fallback = -new Date(whenMs).getTimezoneOffset() * 60000;
  if (!timezone) return fallback;
  try {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(new Date(whenMs));
    var name = "";
    parts.forEach(function (part) {
      if (part.type === "timeZoneName") name = part.value;
    });
    var match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    if (!match) return fallback;
    var sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3])) * 60000;
  } catch (error) {
    return fallback;
  }
}

/**
 * Energy per bucket, the way a utility bill is read: a day (or an hour) of
 * solar production, home use, grid import, and grid export.
 *
 * Solar is the change of the validated lifetime counter inside the bucket.
 * Home, import, and export integrate signed mean power, so they are estimates.
 * Buckets align on `offsetMs` so a "day" means the site's local day.
 */
export function energyBuckets(windows, resolutionMs, bucketMs, offsetMs) {
  var hours = resolutionMs / 3600000;
  var byBucket = {};
  windows.forEach(function (window) {
    var ts = Date.parse(window.ts);
    if (!isFinite(ts)) return;
    var slot = Math.floor((ts + offsetMs) / bucketMs) * bucketMs - offsetMs;
    var bucket = byBucket[slot];
    if (!bucket) {
      bucket = byBucket[slot] = {
        ts: slot,
        counterFirst: null,
        counterLast: null,
        home: 0,
        import: 0,
        export: 0,
        loadWindows: 0,
        gridWindows: 0,
        windows: 0,
      };
    }
    bucket.windows += 1;
    var counter = num(window.pv_kwh_total_end);
    if (counter !== null) {
      if (bucket.counterFirst === null) bucket.counterFirst = counter;
      bucket.counterLast = counter;
    }
    var load = num(window.load_kw_reported_avg);
    if (load !== null) {
      bucket.home += load * hours;
      bucket.loadWindows += 1;
    }
    var grid = num(window.grid_kw_avg);
    if (grid !== null) {
      if (grid > 0) bucket.import += grid * hours;
      else bucket.export += -grid * hours;
      bucket.gridWindows += 1;
    }
  });
  return Object.keys(byBucket)
    .map(function (key) {
      var bucket = byBucket[key];
      return {
        ts: bucket.ts,
        solar: bucket.counterFirst === null ? null : bucket.counterLast - bucket.counterFirst,
        home: bucket.loadWindows === 0 ? null : bucket.home,
        import_kwh: bucket.gridWindows === 0 ? null : bucket.import,
        export_kwh: bucket.gridWindows === 0 ? null : bucket.export,
        windows: bucket.windows,
        expected: Math.round(bucketMs / resolutionMs),
      };
    })
    .sort(function (left, right) {
      return left.ts - right.ts;
    });
}

/** Aligned site energy: one complete reading supplies solar, home and grid together. */
export function alignedEnergy(windows, resolutionMs, fromMs, toMs, timezone) {
  var hours = resolutionMs / 3600000;
  var format = new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, year: "numeric", month: "2-digit", day: "2-digit" });
  var days = new Map();
  var total = { solar: 0, home: 0, import: 0, export: 0, self: 0, valid: 0, expected: Math.max(0, Math.ceil((toMs - fromMs) / resolutionMs)) };
  (windows || []).forEach(function (row) {
    var ts = Date.parse(row.ts);
    var solar = num(row.pv_kw_avg), grid = num(row.grid_kw_avg), reported = num(row.load_kw_reported_avg);
    if (!isFinite(ts) || ts < fromMs || ts >= toMs || row.quality !== "ok" || row.complete !== true || solar === null || grid === null || reported === null) return;
    var home = solar + grid;
    if (solar < 0 || home < -0.1 || -grid > solar + 0.1 || Math.abs(home - reported) > Math.max(0.2, reported * 0.15)) return;
    var parts = format.formatToParts(new Date(ts));
    var part = function (type) { return parts.find(function (item) { return item.type === type; }).value; };
    var key = part("year") + "-" + part("month") + "-" + part("day");
    var day = days.get(key);
    if (!day) { day = { date: key, solar: 0, home: 0, import: 0, export: 0, self: 0, valid: 0 }; days.set(key, day); }
    [total, day].forEach(function (target) {
      target.solar += solar * hours;
      target.home += Math.max(0, home) * hours;
      target.import += Math.max(0, grid) * hours;
      target.export += Math.max(0, -grid) * hours;
      target.self += Math.max(0, solar - Math.max(0, -grid)) * hours;
      target.valid += 1;
    });
  });
  total.days = Array.from(days.values()).sort(function (a, b) { return a.date.localeCompare(b.date); });
  return total;
}

/** Value bounds for signed bars: production and use up, export down. */
export function bucketBounds(buckets) {
  var up = 0;
  var down = 0;
  buckets.forEach(function (bucket) {
    var rising = [bucket.solar, bucket.home, bucket.import_kwh];
    rising.forEach(function (value) {
      var figure = num(value);
      if (figure !== null && figure > up) up = figure;
    });
    var falling = num(bucket.export_kwh);
    if (falling !== null && falling > down) down = falling;
  });
  return { up: up > 0 ? up * 1.1 : 1, down: down > 0 ? down * 1.1 : 0 };
}

/** Right-axis bounds from the hours actually drawn, not the whole forecast. */
export function weatherBounds(hours, layer, fromMs, toMs) {
  var min = null;
  var max = null;
  hours.forEach(function (hour) {
    var ts = Date.parse(hour.ts);
    if (!isFinite(ts) || ts < fromMs || ts > toMs) return;
    var value = num(hour[layer.key]);
    if (value === null) return;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  });
  if (min === null || max === null) return null;
  if (layer.min !== undefined && layer.max !== undefined) return { min: layer.min, max: layer.max };
  if (layer.min !== undefined) min = layer.min;
  if (max === min) return { min: layer.min ?? min - 1, max: max + 1 };
  return { min: min, max: max };
}

/**
 * Energy across the shown windows.
 *
 * Solar comes from the validated lifetime counter. Import, export, and home use
 * are integrated from signed mean power, so they are estimates: a reversal
 * inside one window is invisible to them. Each field reports how many windows
 * it used, and a field with no usable window stays null rather than zero.
 */
export function rangeEnergy(windows, resolutionMs) {
  var hours = resolutionMs / 3600000;
  var totals = { home: 0, import: 0, export: 0 };
  var used = { load: 0, grid: 0 };
  windows.forEach(function (window) {
    var load = num(window.load_kw_reported_avg);
    var grid = num(window.grid_kw_avg);
    if (load !== null) {
      totals.home += load * hours;
      used.load += 1;
    }
    if (grid !== null) {
      if (grid > 0) totals.import += grid * hours;
      else totals.export += -grid * hours;
      used.grid += 1;
    }
  });
  return {
    solar_kwh: counterDelta(windows, "pv_kwh_total_end"),
    home_kwh: used.load === 0 ? null : totals.home,
    import_kwh: used.grid === 0 ? null : totals.import,
    export_kwh: used.grid === 0 ? null : totals.export,
    load_windows: used.load,
    grid_windows: used.grid,
    windows: windows.length,
  };
}

/**
 * Change of a cumulative counter across the shown windows.
 *
 * These counters only add, so first-to-last is the energy the site really
 * recorded; a missing counter is skipped, never read as zero. Fewer than two
 * readings cannot show a change, so that stays unknown.
 */
export function counterDelta(windows, key) {
  var values = [];
  windows.forEach(function (window) {
    var value = num(window[key]);
    if (value !== null) values.push(value);
  });
  if (values.length < 2) return null;
  return values[values.length - 1] - values[0];
}

/** Value bounds for the power series, always including zero. */
export function chartBounds(windows, series) {
  var min = 0;
  var max = 0;
  windows.forEach(function (window) {
    series.forEach(function (item) {
      var value = num(window[item.key]);
      if (value === null) return;
      if (value < min) min = value;
      if (value > max) max = value;
    });
  });
  // Values that round to 0.0 kW stay below 10% of the chart height.
  return { min: min === 0 ? 0 : min * 1.1, max: Math.max(max * 1.1, 0.5) };
}

/**
 * Export statistics for the recent window.
 *
 * Export is `max(-grid_kw, 0)`, so an import minute counts as zero export
 * rather than as a missing value. The low value is the smallest mean of a
 * *complete* five-minute window; a slot with missing minutes is not a window.
 */
export function exportStats(windows, nowMs, minutes) {
  var span = (minutes || 30) * 60000;
  function recent(limit) {
    var entries = [];
    windows.forEach(function (window) {
      var ts = Date.parse(window.ts);
      var grid = num(window.grid_kw_avg);
      // Half-open window: exactly 30 minutes ago belongs to the earlier span.
      if (!isFinite(ts) || ts > nowMs || ts <= nowMs - limit || grid === null) return;
      entries.push({ ts: ts, value: Math.max(-grid, 0) });
    });
    return entries;
  }
  function mean(entries) {
    if (entries.length === 0) return null;
    return entries.reduce(function (total, entry) {
      return total + entry.value;
    }, 0) / entries.length;
  }

  var last30 = recent(30 * 60000);
  var last60 = recent(60 * 60000);
  var slots = {};
  recent(span).forEach(function (entry) {
    var slot = Math.floor(entry.ts / RESOLUTION_MS["5m"]) * RESOLUTION_MS["5m"];
    (slots[slot] = slots[slot] || []).push(entry.value);
  });
  var complete = Object.keys(slots)
    .map(function (key) {
      return slots[key];
    })
    .filter(function (values) {
      return values.length === 5;
    })
    .map(function (values) {
      return values.reduce(function (left, right) {
        return left + right;
      }, 0) / values.length;
    });

  return {
    mean30: mean(last30),
    valid30: last30.length,
    mean60: mean(last60),
    valid60: last60.length,
    low30: complete.length === 0 ? null : Math.min.apply(null, complete),
    low_slots: complete.length,
  };
}
