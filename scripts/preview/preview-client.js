/* Location fixture: public San Francisco city center, not a device location. */
/* Loaded only by preview.mjs, before the real page modules. */
(() => {
  const NativeDate = Date;
  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const OFFSET = 7 * HOUR; // Fixed September fixture: America/Los_Angeles is PDT.
  const START = NativeDate.parse("2026-08-24T07:00:00Z");
  const NIGHT = NativeDate.parse("2026-09-23T07:45:00Z");
  const DAYTIME = NativeDate.parse("2026-09-22T21:00:00Z");
  const iso = (time) => new NativeDate(time).toISOString();

  function fixture(mode) {
    const now = mode === "night" ? NIGHT : DAYTIME;
    const minuteRows = [];
    let counter = 36500;
    for (let time = START, index = 0; time <= now; time += MINUTE, index += 1) {
      const local = new NativeDate(time - OFFSET);
      const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
      const daylight = Math.max(0, Math.sin(Math.PI * (hour - 6.83) / 12.34));
      const cloud = local.getUTCDate() === 19 ? 0.65 : 1;
      const pv = mode === "idle" && local.getUTCDate() === 22 ? 0
        : daylight ? 6 * daylight ** 1.6 * cloud : index % 7 === 0 ? 0.003 : 0;
      const home = 0.9 + (hour >= 17 && hour < 22 ? 0.8 : 0.3);
      const gap = time >= NativeDate.parse("2026-09-21T17:30:00Z") && time < NativeDate.parse("2026-09-21T18:05:00Z");
      counter += pv / 60;
      minuteRows.push({
        ts: iso(time), quality: gap ? "source_error" : "ok", complete: !gap,
        sample_count: gap ? 0 : 6, valid_count: gap ? 0 : 6,
        pv_kw_avg: gap ? null : +pv.toFixed(4),
        load_kw_reported_avg: gap ? null : +home.toFixed(3),
        grid_kw_avg: gap ? null : +(home - pv).toFixed(4),
        pv_kwh_total_end: gap ? null : +counter.toFixed(5),
      });
    }
    const latest = minuteRows.at(-1);
    const siteDayStart = Math.floor((now - OFFSET) / DAY) * DAY + OFFSET;
    const sunrise = siteDayStart + 6 * HOUR + 50 * MINUTE;
    const panelSlot = mode === "night" ? NativeDate.parse("2026-09-23T02:15:00Z") : now - 5 * MINUTE;
    const panelReading = minuteRows.find((row) => row.ts === iso(panelSlot));
    const sunriseReading = minuteRows.find((row) => row.ts === iso(sunrise));
    const panelScale = (index) => 1 - index * 0.006;
    const panelTotal = (row, index) => 500 + index * 10 + (row.pv_kwh_total_end - 36500) / 21 * panelScale(index);
    const dayRows = Array.from({ length: 31 }, (_, index) => {
      const start = START + index * DAY;
      return {
        date: iso(start - OFFSET).slice(0, 10), sunrise_utc: iso(start + 6 * HOUR + 50 * MINUTE),
        sunset_utc: iso(start + 19 * HOUR + 10 * MINUTE), daylight_seconds: 44400,
        sunshine_duration_seconds: (index % 5 === 0 ? 7.2 : 10.4) * HOUR / 1000,
        source: "simulated-forecast", stale: false,
      };
    });
    const weatherHours = Array.from({ length: 31 * 24 }, (_, index) => {
      const time = START + index * HOUR;
      const hour = new NativeDate(time - OFFSET).getUTCHours();
      return {
        ts: iso(time), temperature_c: +(14 + 9 * Math.sin(Math.PI * (hour - 6) / 18)).toFixed(1),
        uv_index: +(Math.max(0, Math.sin(Math.PI * (hour - 7) / 12)) * 7).toFixed(1),
        cloud_cover_pct: hour > 10 && hour < 16 ? 22 : 38,
        precipitation_mm: 0, precipitation_probability_pct: 0, weather_code: 1,
        source: "simulated-forecast", quality: "ok", stale: false,
      };
    });
    const panels = Array.from({ length: 21 }, (_, index) => {
      const active = mode === "idle" || mode === "day" && index < 19;
      return {
        panel_id: "p" + String(index + 1).padStart(2, "0"),
        ac_kw: active ? +(panelReading.pv_kw_avg / 21 * panelScale(index)).toFixed(3) : null,
        energy_kwh: active ? +((panelReading.pv_kwh_total_end - sunriseReading.pv_kwh_total_end) / 21 * panelScale(index)).toFixed(2) : null,
        energy_kwh_total: active ? +panelTotal(panelReading, index).toFixed(4) : null,
        measured_at_utc: active ? iso(panelSlot) : null,
        quality: active ? "ok" : null,
        dc_kw: active ? +(panelReading.pv_kw_avg / 21 * panelScale(index) * 1.04).toFixed(3) : null,
        dc_v: active ? 41.5 : null, dc_a: active ? 8.1 : null,
        ac_v: active ? 240.5 : null, ac_a: active ? 1.2 : null,
        heatsink_c: active ? 36 : null,
      };
    });

    function history(query) {
      const from = NativeDate.parse(query.get("from")) || START;
      const to = NativeDate.parse(query.get("to")) || now;
      const resolution = query.get("resolution") || (to - from <= 2 * DAY ? "1m" : to - from <= 31 * DAY ? "5m" : "1d");
      let windows = minuteRows.filter((row) => {
        const time = NativeDate.parse(row.ts);
        return time >= from && time < to;
      });
      if (resolution === "5m") {
        const groups = new Map();
        windows.forEach((row) => {
          const start = Math.floor(NativeDate.parse(row.ts) / (5 * MINUTE)) * (5 * MINUTE);
          if (!groups.has(start)) groups.set(start, []);
          groups.get(start).push(row);
        });
        windows = [...groups].map(([start, rows]) => {
          const good = rows.filter((row) => row.quality === "ok" && row.complete);
          const mean = (key) => good.length ? +(good.reduce((sum, row) => sum + row[key], 0) / good.length).toFixed(4) : null;
          const complete = rows.length === 5 && good.length === 5;
          return {
            ts: iso(start), quality: complete ? "ok" : good.length ? "partial" : "source_error",
            complete, windows: rows.length, ok_windows: good.length,
            pv_kw_avg: mean("pv_kw_avg"), load_kw_reported_avg: mean("load_kw_reported_avg"),
            grid_kw_avg: mean("grid_kw_avg"), pv_kwh_total_end: good.at(-1)?.pv_kwh_total_end ?? null,
          };
        });
      }
      if (resolution === "1d") {
        const groups = new Map();
        windows.forEach((row) => {
          const start = Math.floor((NativeDate.parse(row.ts) - OFFSET) / DAY) * DAY + OFFSET;
          if (!groups.has(start)) groups.set(start, []);
          groups.get(start).push(row);
        });
        windows = [...groups].map(([start, rows]) => {
          const valid = rows.filter((row) => row.pv_kw_avg !== null);
          const mean = (key) => valid.reduce((sum, row) => sum + row[key], 0) / Math.max(valid.length, 1);
          return {
            ts: iso(start), quality: valid.length === 1440 ? "ok" : "partial",
            complete: valid.length === 1440, windows: rows.length, ok_windows: valid.length,
            pv_kw_avg: +mean("pv_kw_avg").toFixed(3),
            load_kw_reported_avg: +mean("load_kw_reported_avg").toFixed(3),
            grid_kw_avg: +mean("grid_kw_avg").toFixed(3),
            pv_kwh_total_end: rows.at(-1).pv_kwh_total_end,
          };
        });
      }
      const ok = windows.filter((row) => row.quality === "ok").length;
      return {
        resolution, from_utc: iso(from), to_utc: iso(to), truncated: false,
        calibration: { grid_ratio: 1 }, windows,
        summary: {
          windows: windows.length, ok, partial: windows.length - ok, source_error: 0,
          first_ts: windows[0]?.ts || null, last_ts: windows.at(-1)?.ts || null,
        },
      };
    }

    function panelHistory(query) {
      const from = NativeDate.parse(query.get("from")) || START;
      const to = NativeDate.parse(query.get("to")) || now;
      const panelId = query.get("panel_id");
      const index = Math.max(0, Number(panelId.slice(1)) - 1);
      if (mode === "day" && index >= 19) return { panel_id: panelId, resolution: "5m", samples: [] };
      const samples = minuteRows.filter((row) => {
        const time = NativeDate.parse(row.ts);
        return time >= from && time < to && time <= panelSlot && time % (5 * MINUTE) === 0 &&
          (row.pv_kw_avg > 0.05 || mode === "idle" && time >= sunrise);
      }).map((row) => ({
        ts: row.ts, ac_kw: +(row.pv_kw_avg / 21 * panelScale(index)).toFixed(3),
        energy_kwh_total: +panelTotal(row, index).toFixed(4),
        measured_at_utc: row.ts, quality: "ok",
      }));
      return { panel_id: panelId, resolution: "5m", samples };
    }

    function allPanelHistory(query) {
      return {
        resolution: "5m", truncated: false,
        panels: panels.map((panel) => {
          const one = new URLSearchParams(query);
          one.set("panel_id", panel.panel_id);
          return panelHistory(one);
        }).filter((panel) => panel.samples.length),
      };
    }

    function api(path, query) {
      if (path === "/api/v1/live") return {
        state: "live", age_seconds: 0, measured_at_utc: latest.ts, received_at_utc: latest.ts,
        pv_kw: latest.pv_kw_avg, load_kw_reported: latest.load_kw_reported_avg,
        grid_kw: latest.grid_kw_avg, pv_kwh_total: latest.pv_kwh_total_end,
        calibration: { grid_ratio: 1 },
      };
      if (path === "/api/v1/history") return history(query);
      if (path === "/api/v1/weather") {
        const from = NativeDate.parse(query.get("from")) || START;
        const to = NativeDate.parse(query.get("to")) || now + DAY;
        return {
          configured: true, stale: false, newest_fetched_at_utc: iso(now),
          location: { latitude: 37.7749, longitude: -122.4194, timezone: "America/Los_Angeles" },
          hours: weatherHours.filter((row) => NativeDate.parse(row.ts) >= from - HOUR && NativeDate.parse(row.ts) <= to + HOUR),
          days: dayRows,
        };
      }
      if (path === "/api/v1/panels" && query.get("history") === "all") return allPanelHistory(query);
      if (path === "/api/v1/panels") return query.has("panel_id") ? panelHistory(query) : {
        slot_ts: iso(panelSlot), slot_age_seconds: Math.floor((now - panelSlot) / 1000),
        energy_from_utc: iso(siteDayStart), energy_coverage_from_utc: mode === "night" ? null : iso(sunrise),
        panels,
      };
      if (path === "/api/v1/location") return {
        configured: true, latitude: 37.7749, longitude: -122.4194,
        timezone: "America/Los_Angeles", source: "manual", updated_at_utc: iso(START),
      };
      if (path === "/api/v1/notifications") return { configured: false, enabled: false, read_only: true, state: "normal", monitoring: "paused", last_error: null, last_checked_at_utc: null, last_sent_at_utc: null };
      if (path === "/api/v1/calibration") return { grid_ratio: 1, updated_at_utc: null };
      if (path === "/api/v1/health") return {
        state: "connected", authenticated_upload: true, valid_measurement: true,
        panels_discovered: true, known_panels: 21, latest_quality: "ok",
        first_minute_at_utc: iso(START), last_minute_at_utc: latest.ts,
        last_measured_at_utc: latest.ts, last_received_at_utc: latest.ts,
        last_panel_slot_at_utc: iso(panelSlot), events: [],
      };
      return null;
    }
    return { now, api };
  }

  if (typeof window === "undefined") {
    if (process.argv.includes("--check")) {
      const night = fixture("night");
      const day = fixture("day");
      const idle = fixture("idle");
      const recent = night.api("/api/v1/history", new URLSearchParams({ from: iso(night.now - HOUR), to: iso(night.now) })).windows;
      if (!recent.some((row) => row.pv_kw_avg > 0 && row.pv_kw_avg < 0.05)) throw Error("night noise missing");
      if (night.api("/api/v1/panels", new URLSearchParams()).slot_ts >= iso(night.now - HOUR)) throw Error("night panel slot is current");
      if (day.api("/api/v1/live", new URLSearchParams()).pv_kw <= 1) throw Error("daytime solar missing");
      const dayPanels = day.api("/api/v1/panels", new URLSearchParams());
      const daySamples = day.api("/api/v1/panels", new URLSearchParams({ panel_id: "p01" })).samples;
      const arrayHistory = day.api("/api/v1/panels", new URLSearchParams({ history: "all", from: iso(day.now - 12 * HOUR), to: iso(day.now) }));
      if (arrayHistory.panels.length !== 19 || arrayHistory.panels.some((panel) => !panel.samples.length)) {
        throw Error("array preview needs 19 measured traces and two missing panels");
      }
      if (daySamples.at(-1).ts !== dayPanels.slot_ts ||
          Math.abs(daySamples.at(-1).energy_kwh_total - dayPanels.panels[0].energy_kwh_total) > 0.001) {
        throw Error("panel card and history differ");
      }
      if (idle.api("/api/v1/live", new URLSearchParams()).pv_kw !== 0 ||
          idle.api("/api/v1/panels", new URLSearchParams()).panels.some((panel) => panel.energy_kwh !== 0)) {
        throw Error("daytime no-production fixture differs");
      }
      console.log("preview fixture check passed");
    }
    return;
  }

  const chosen = new URLSearchParams(location.search).get("scenario");
  if (["day", "night", "idle"].includes(chosen)) localStorage.setItem("preview-scenario", chosen);
  const mode = localStorage.getItem("preview-scenario") || "night";
  const data = fixture(mode);
  class PreviewDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [data.now])); }
    static now() { return data.now; }
  }
  window.Date = PreviewDate;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/v1/")) return realFetch(input, options);
    if (url.pathname.startsWith("/api/v1/notifications") && options.method && options.method !== "GET") {
      return Promise.resolve(new Response(JSON.stringify({ error: "preview_read_only" }), { status: 403, headers: { "Content-Type": "application/json" } }));
    }
    const method = options.method || (typeof input === "string" ? "GET" : input.method);
    const body = method === "GET" ? data.api(url.pathname, url.searchParams) : null;
    return Promise.resolve(new Response(JSON.stringify(body || { error: "Preview is read only" }), {
      status: body ? 200 : method === "GET" ? 404 : 405,
      headers: { "content-type": "application/json" },
    }));
  };
  window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("preview-mode").textContent = mode === "night" ? "Night · Sep 23, 12:45 AM PDT"
      : mode === "idle" ? "Day without output · Sep 22, 2:00 PM PDT" : "Day · Sep 22, 2:00 PM PDT";
  });
})();
