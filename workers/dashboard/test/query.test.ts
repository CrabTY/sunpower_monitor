import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_ROWS,
  MAX_SPAN_SECONDS,
  PANEL_SPAN_SECONDS,
  RESOLUTION_SECONDS,
  fiveMinuteSql,
  parseRange,
  readAllPanelHistory,
  readHealth,
  readHistory,
  readPanelDayEnergy,
  readPanelHistory,
  readPanelsLatest,
} from "../src/query.js";

const NOW = Math.floor(Date.parse("2026-09-18T03:00:00Z") / 1000);

class ScriptedDb {
  statements: { sql: string; values: unknown[] }[] = [];
  private cursor = 0;

  constructor(
    private allRows: Record<string, unknown>[][] = [],
    private batchRows: Record<string, unknown>[][] = [],
  ) {}

  prepare(sql: string) {
    const statement = {
      sql,
      values: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.values = values;
        return statement;
      },
      all: async () => ({ results: this.allRows[this.cursor++] ?? [] }),
      first: async () => (this.allRows[this.cursor++] ?? [])[0] ?? null,
      run: async () => ({ success: true }),
    };
    this.statements.push(statement);
    return statement;
  }

  async batch(input: { sql: string }[]) {
    return input.map((_statement, index) => ({ results: this.batchRows[index] ?? [] }));
  }
}

function db(all: Record<string, unknown>[][] = [], batch: Record<string, unknown>[][] = []) {
  return new ScriptedDb(all, batch) as unknown as D1Database;
}

test("range parsing defaults, bounds, and resolution choice", () => {
  const defaulted = parseRange(new URLSearchParams(), NOW);
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.value?.toTs, NOW);
  assert.equal(defaulted.value?.fromTs, NOW - 24 * 3600);
  assert.equal(defaulted.value?.resolution, "1m");

  const week = parseRange(new URLSearchParams({ from: "2026-09-11T03:00:00Z", to: "2026-09-18T03:00:00Z" }), NOW);
  assert.equal(week.value?.resolution, "5m");

  assert.equal(parseRange(new URLSearchParams({ from: "nope", to: "2026-09-18T03:00:00Z" }), NOW).error, "invalid_time");
  assert.equal(
    parseRange(new URLSearchParams({ from: "2026-09-18T03:00:00Z", to: "2026-09-18T02:00:00Z" }), NOW).error,
    "invalid_range",
  );
  assert.equal(
    parseRange(new URLSearchParams({ from: "2026-09-01T00:00:00Z", to: "2026-09-18T00:00:00Z", resolution: "1m" }), NOW).error,
    "range_too_long",
  );
  assert.equal(
    parseRange(new URLSearchParams({ from: "2025-09-01T00:00:00Z", to: "2026-09-18T00:00:00Z", resolution: "5m" }), NOW).error,
    "range_too_long",
  );
  assert.equal(
    parseRange(new URLSearchParams({ from: "2026-08-18T00:00:00Z", to: "2026-09-18T00:00:00Z", resolution: "1d" }), NOW).value?.resolution,
    "1d",
  );
  assert.equal(
    parseRange(new URLSearchParams({ from: "2025-09-18T00:00:00Z", to: "2026-09-18T00:00:00Z" }), NOW).value?.resolution,
    "1d",
  );
  assert.equal(
    parseRange(new URLSearchParams({ from: "2025-09-01T00:00:00Z", to: "2026-09-18T00:00:00Z", resolution: "1d" }), NOW).error,
    "range_too_long",
  );
  assert.equal(
    parseRange(new URLSearchParams({ from: "2026-08-18T00:00:00Z", to: "2026-09-18T00:00:00Z", resolution: "1w" }), NOW).error,
    "unsupported_resolution",
  );
});

test("five-minute query weights every power by its own valid count", () => {
  const sql = fiveMinuteSql();
  assert.match(sql, /json_extract\(valid_counts_json, '\$\.pv_kw'\)/);
  assert.match(sql, /json_extract\(valid_counts_json, '\$\.grid_kw'\)/);
  assert.match(sql, /NULLIF\(SUM\(json_extract\(valid_counts_json, '\$\.load_kw_reported'\)\), 0\)/);
  assert.match(sql, /GROUP BY slot_ts ORDER BY slot_ts LIMIT \?/);
});

test("minute history reports quality, coverage, and truncation", async () => {
  const rows = [
    {
      minute_ts: NOW - 120,
      quality: "ok",
      complete: 1,
      sample_count: 6,
      valid_count: 6,
      pv_kw_avg: 3.2,
      load_kw_reported_avg: 1.4,
      grid_kw_avg: -1.8,
      battery_kw_avg: null,
      pv_kwh_total_end: 36498.9,
      last_measured_ts: NOW - 65,
    },
    {
      minute_ts: NOW - 60,
      quality: "source_error",
      complete: 0,
      sample_count: 0,
      valid_count: 0,
      pv_kw_avg: null,
      load_kw_reported_avg: null,
      grid_kw_avg: null,
      battery_kw_avg: null,
      last_measured_ts: null,
    },
  ];
  const view = await readHistory(db([rows]), "home-pvs", { fromTs: NOW - 3600, toTs: NOW, resolution: "1m" });
  assert.equal(view.windows.length, 2);
  assert.equal(view.windows[0].quality, "ok");
  assert.equal(view.windows[0].complete, true);
  assert.equal(view.windows[0].pv_kw_avg, 3.2);
  assert.equal(view.windows[0].pv_kwh_total_end, 36498.9);
  assert.equal(view.windows[0].measured_at_utc ?? view.windows[0].last_measured_at_utc, "2026-09-18T02:58:55Z");
  assert.equal(view.windows[1].quality, "source_error");
  assert.equal(view.windows[1].pv_kw_avg, null);
  assert.equal(view.windows[1].complete, false);
  assert.deepEqual(view.summary, {
    windows: 2,
    ok: 1,
    partial: 0,
    source_error: 1,
    clock_invalid: 0,
    first_ts: "2026-09-18T02:58:00Z",
    last_ts: "2026-09-18T02:59:00Z",
    truncated: false,
  });
  assert.equal(view.truncated, false);
});

test("five-minute windows are complete only with all fields and no errors", async () => {
  const complete = {
    slot_ts: NOW - 600,
    windows: 5,
    ok_windows: 5,
    partial_windows: 0,
    source_error_windows: 0,
    sample_count: 30,
    valid_count: 30,
    last_measured_ts: NOW - 600,
    pv_kw_avg: 3.1,
    load_kw_reported_avg: 1.3,
    grid_kw_avg: -1.8,
    battery_kw_avg: null,
  };
  const withError = { ...complete, slot_ts: NOW - 300, source_error_windows: 1, ok_windows: 4 };
  const view = await readHistory(db([[complete, withError]]), "home-pvs", {
    fromTs: NOW - 3600,
    toTs: NOW,
    resolution: "5m",
  });
  assert.equal(view.windows[0].complete, true);
  assert.equal(view.windows[0].quality, "ok");
  assert.equal(view.windows[0].windows, 5);
  assert.equal(view.windows[1].complete, false);
  assert.equal(view.windows[1].quality, "partial");
  assert.equal(view.windows[1].source_error_windows, 1);
  assert.equal(view.windows[1].battery_kw_avg, null);
  // The header counts presented windows; a 5m row has no quality of its own, so
  // its failed minutes come from source_error_windows (1 minute in this case).
  assert.deepEqual(view.summary, {
    windows: 2,
    ok: 1,
    partial: 1,
    source_error: 1,
    clock_invalid: 0,
    first_ts: new Date((NOW - 600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    last_ts: new Date((NOW - 300) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    truncated: false,
  });
});

test("site-local daily windows use their actual DST length", async () => {
  const start = Date.parse("2026-03-08T08:00:00Z") / 1000;
  const end = Date.parse("2026-03-09T07:00:00Z") / 1000;
  const row = {
    local_date: "2026-03-08", slot_ts: start, end_ts: end, windows: 1380,
    ok_windows: 1379, source_error_windows: 1, sample_count: 8274, valid_count: 8274,
    pv_kw_avg: 2, load_kw_reported_avg: 1, grid_kw_avg: -1,
  };
  const view = await readHistory(db([[row]]), "home-pvs", { fromTs: start, toTs: end, resolution: "1d" }, "America/Los_Angeles");
  assert.equal(view.windows[0].duration_seconds, 23 * 3600);
  assert.equal(view.windows[0].quality, "partial");
  assert.equal(view.summary.source_error, 1);
  const complete = await readHistory(db([[{ ...row, ok_windows: 1380, source_error_windows: 0 }]]), "home-pvs", {
    fromTs: start, toTs: end, resolution: "1d",
  }, "America/Los_Angeles");
  assert.equal(complete.windows[0].complete, true);
});

test("the row cap fits the longest allowed range", () => {
  // Truncation keeps the oldest rows, so a cap below the widest accepted range
  // would quietly drop the newest data a monitoring page needs.
  const widest = MAX_SPAN_SECONDS["5m"] / RESOLUTION_SECONDS["5m"];
  assert.ok(MAX_ROWS > widest, `MAX_ROWS ${MAX_ROWS} must fit ${widest} five-minute windows`);
});

test("truncated history is labelled", async () => {
  const rows = Array.from({ length: MAX_ROWS }, (_value, index) => ({ minute_ts: NOW - index, quality: "ok" }));
  const view = await readHistory(db([rows]), "home-pvs", { fromTs: NOW - 3600, toTs: NOW, resolution: "1m" });
  assert.equal(view.truncated, true);
  assert.equal(view.summary.truncated, true);
});

test("panel matrix returns the latest stored slot", async () => {
  const rows = [
    {
      panel_id: "p01",
      slot_ts: NOW - 120,
      ac_kw: 0.4,
      energy_kwh_total: 500,
      dc_kw: 0.44,
      dc_v: 41.5,
      dc_a: 10.8,
      ac_v: 241.2,
      ac_a: 1.7,
      heatsink_c: 38,
      measured_ts: NOW - 120,
      quality: "ok",
    },
    { panel_id: "p02", slot_ts: NOW - 120, ac_kw: null, energy_kwh_total: null, measured_ts: null, quality: "stale_source" },
    // A known panel with no row in the latest slot comes back from the left
    // join as nulls with a null quality: listed, but never called offline.
    { panel_id: "p03", slot_ts: NOW - 120, ac_kw: null, energy_kwh_total: null, measured_ts: null, quality: null },
  ];
  const view = await readPanelsLatest(db([rows]), "home-pvs", NOW);
  assert.equal(view.slot_ts, "2026-09-18T02:58:00Z");
  assert.equal(view.slot_age_seconds, 120);
  assert.deepEqual(view.panels, [
    {
      panel_id: "p01",
      ac_kw: 0.4,
      energy_kwh_total: 500,
      dc_kw: 0.44,
      dc_v: 41.5,
      dc_a: 10.8,
      ac_v: 241.2,
      ac_a: 1.7,
      heatsink_c: 38,
      measured_at_utc: "2026-09-18T02:58:00Z",
      quality: "ok",
    },
    {
      panel_id: "p02",
      ac_kw: null,
      energy_kwh_total: null,
      dc_kw: null,
      dc_v: null,
      dc_a: null,
      ac_v: null,
      ac_a: null,
      heatsink_c: null,
      measured_at_utc: null,
      quality: "stale_source",
    },
    {
      panel_id: "p03",
      ac_kw: null,
      energy_kwh_total: null,
      dc_kw: null,
      dc_v: null,
      dc_a: null,
      ac_v: null,
      ac_a: null,
      heatsink_c: null,
      measured_at_utc: null,
      quality: null,
    },
  ]);

  const empty = await readPanelsLatest(db([[]]), "home-pvs", NOW);
  assert.equal(empty.slot_ts, null);
  assert.deepEqual(empty.panels, []);
});

test("panel day energy subtracts the first and last stored counter", async () => {
  const rows = [
    { panel_id: "p01", first_ts: NOW - 3600, last_ts: NOW - 300, first_kwh: 500, last_kwh: 505.25 },
    // One stored counter shows movement, not a total, so the panel has none.
    { panel_id: "p02", first_ts: NOW - 300, last_ts: NOW - 300, first_kwh: 700, last_kwh: 700 },
    { panel_id: "p03", first_ts: NOW - 600, last_ts: NOW, first_kwh: null, last_kwh: null },
    // A counter that went backwards restarted; that is not negative energy.
    { panel_id: "p04", first_ts: NOW - 1800, last_ts: NOW - 60, first_kwh: 1534.47, last_kwh: 1489 },
  ];
  const energy = await readPanelDayEnergy(db([rows]), "home-pvs", NOW - 86400, NOW);
  assert.deepEqual(energy.get("p01"), { kwh: 5.25, firstTs: NOW - 3600, lastTs: NOW - 300 });
  assert.equal(energy.get("p02")?.kwh, null);
  assert.equal(energy.get("p03")?.kwh, null);
  assert.equal(energy.get("p04")?.kwh, null);
  assert.equal(energy.get("p05"), undefined, "a panel with no stored counter is absent, not zero");

  // Nothing stored in the window is an empty map, never a zero total.
  const none = await readPanelDayEnergy(db([[]]), "home-pvs", NOW - 86400, NOW);
  assert.equal(none.size, 0);
});

test("panel history clamps very long ranges", async () => {
  const database = new ScriptedDb([[{ slot_ts: NOW - 300, ac_kw: 0.2, energy_kwh_total: 1, measured_ts: NOW - 300, quality: "ok" }]]);
  const view = await readPanelHistory(database as unknown as D1Database, "home-pvs", "p01", NOW - 90 * 24 * 3600, NOW);
  assert.equal(view.clamped, true);
  assert.equal((view.samples as unknown[]).length, 1);
  assert.equal(database.statements[0].values[2], NOW - PANEL_SPAN_SECONDS);
});

test("array history uses one time-range scan and keeps gaps unknown", async () => {
  const database = new ScriptedDb([[
    { panel_id: "p02", slot_ts: NOW - 300, ac_kw: null, energy_kwh_total: null, measured_ts: null, quality: "source_error" },
    { panel_id: "p01", slot_ts: NOW - 300, ac_kw: 0.2, energy_kwh_total: 5, measured_ts: NOW - 300, quality: "ok" },
    { panel_id: "p01", slot_ts: NOW - 600, ac_kw: 0.1, energy_kwh_total: 4.9, measured_ts: NOW - 600, quality: "ok" },
  ]]);
  const view = await readAllPanelHistory(database as unknown as D1Database, "home-pvs", NOW - 900, NOW);
  assert.equal(database.statements.length, 1);
  assert.match(database.statements[0].sql, /slot_ts >= \? AND slot_ts < \? ORDER BY slot_ts DESC, panel_id DESC/);
  assert.deepEqual(database.statements[0].values, ["home-pvs", NOW - 900, NOW, MAX_ROWS + 1]);
  const panels = view.panels as Array<{ panel_id: string; samples: Array<{ ts: string; ac_kw: number | null }> }>;
  assert.deepEqual(panels.map((panel) => [panel.panel_id, panel.samples.length]), [["p01", 2], ["p02", 1]]);
  assert.equal(panels[0].samples[0].ts, new Date((NOW - 600) * 1000).toISOString().replace(".000Z", "Z"));
  assert.equal(panels[1].samples[0].ac_kw, null);
  assert.equal(view.truncated, false);
});

test("health distinguishes a missing collector from a stalled one", async () => {
  const empty = await readHealth(db([], [[], [], [], [], []]), "home-pvs", NOW);
  assert.equal(empty.state, "waiting_for_collector");
  assert.equal(empty.queue_backlog, null);
  assert.equal(empty.first_minute_at_utc, null);

  const batch = [
    [{ collected_ts: NOW - 5, measured_ts: NOW - 6, received_ts: NOW - 4, quality: "ok" }],
    [{ first_minute_ts: NOW - 86400, last_minute_ts: NOW - 60 }],
    [{ panels: 21 }],
    [{ last_slot_ts: NOW - 120 }],
    [{ event_ts: NOW - 30, event_type: "pvs_request_failed", details_code: "inverters" }],
  ];
  const healthy = await readHealth(db([], batch), "home-pvs", NOW);
  assert.equal(healthy.state, "collecting");
  assert.equal(healthy.known_panels, 21);
  assert.equal(healthy.first_minute_at_utc, "2026-09-17T03:00:00Z");
  assert.equal(healthy.last_minute_at_utc, "2026-09-18T02:59:00Z");
  assert.equal(healthy.last_received_at_utc, "2026-09-18T02:59:56Z");
  assert.deepEqual(healthy.events, [
    { event_ts_utc: "2026-09-18T02:59:30Z", event_type: "pvs_request_failed", details_code: "inverters" },
  ]);

  const stalled = await readHealth(
    db([], [[{ collected_ts: NOW - 4000, measured_ts: NOW - 4000, received_ts: NOW - 4000, quality: "stale_source" }], [], [], [], []]),
    "home-pvs",
    NOW,
  );
  assert.equal(stalled.state, "stalled");
});
