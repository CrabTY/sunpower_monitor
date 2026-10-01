import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, digestOf, validateBatch, validateLive } from "../../shared/contract.js";
import ingest from "../src/index.js";
import { planWrite, upsertLatestSite, writeRecords } from "../src/store.js";

const NOW = Date.parse("2026-09-18T03:00:10Z");

function live(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    collector_id: "home-pvs",
    collected_at_utc: "2026-09-18T03:00:00Z",
    measured_at_utc: "2026-09-18T02:59:58Z",
    quality: "ok",
    pv_kw: 3.2,
    load_kw_reported: 1.4,
    grid_kw: -1.8,
    battery_kw: null,
    pv_kwh_total: 12345.6,
    load_kwh_total_reported: 67890.1,
    grid_net_kwh_total: -4321.0,
    ...overrides,
  };
}

function minute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    collector_id: "home-pvs",
    record_id: "home-pvs:site_minute:2026-09-18T03:00:00Z",
    kind: "site_minute",
    window_start_utc: "2026-09-18T03:00:00Z",
    window_end_utc: "2026-09-18T03:01:00Z",
    sample_count: 6,
    valid_count: 6,
    repeated_count: 0,
    invalid_count: 0,
    out_of_window_count: 0,
    complete: true,
    quality: "ok",
    pv_kw_avg: 3.2,
    load_kw_reported_avg: 1.4,
    grid_kw_avg: -1.8,
    battery_kw_avg: null,
    valid_counts: { pv_kw: 6, load_kw_reported: 6, grid_kw: 6 },
    pv_kwh_total_end: 12345.6,
    load_kwh_total_reported_end: 67890.1,
    grid_net_kwh_total_end: -4321.0,
    last_measured_at_utc: "2026-09-18T03:00:50Z",
    ...overrides,
  };
}

function panel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    collector_id: "home-pvs",
    record_id: "home-pvs:panel_sample:2026-09-18T03:00:00Z:p01",
    kind: "panel_sample",
    panel_id: "p01",
    slot_ts: "2026-09-18T03:00:00Z",
    quality: "ok",
    ac_kw: 0.42,
    energy_kwh_total: 500.0,
    dc_kw: 0.44,
    dc_v: 41.5,
    dc_a: 10.8,
    ac_v: 241.2,
    ac_a: 1.7,
    heatsink_c: 38.0,
    measured_at_utc: "2026-09-18T03:00:00Z",
    last_valid_measured_at_utc: "2026-09-18T03:00:00Z",
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    collector_id: "home-pvs",
    record_id: "home-pvs:collector_event:collector_started:2026-09-18T03:00:00Z",
    kind: "collector_event",
    event_type: "collector_started",
    event_ts_utc: "2026-09-18T03:00:00Z",
    details_code: "boot",
    ...overrides,
  };
}

test("accepts a well-formed live snapshot", () => {
  const result = validateLive(live(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value?.collector_id, "home-pvs");
});

test("rejects unknown fields, non-finite numbers, and bad times", () => {
  assert.equal(validateLive(live({ pvs_serial: "ZS1" }), NOW).error, "unknown_field:pvs_serial");
  assert.equal(validateLive(live({ pv_kw: Number.NaN }), NOW).error, "invalid_number:pv_kw");
  assert.equal(validateLive(live({ pv_kw: "3.2" }), NOW).error, "invalid_number:pv_kw");
  assert.equal(validateLive(live({ quality: "great" }), NOW).error, "quality");
  assert.equal(validateLive(live({ collector_id: "home pvs" }), NOW).error, "collector_id");
  assert.equal(validateLive(live({ collected_at_utc: "sometime" }), NOW).error, "invalid_time:collected_at_utc");
  const future = new Date(NOW + 3_600_000).toISOString();
  assert.equal(validateLive(live({ collected_at_utc: future }), NOW).error, "invalid_time:collected_at_utc");
  assert.equal(validateLive(live({ schema_version: 2 }), NOW).error, "schema_version");
});

test("accepts each allowlisted history kind", () => {
  const result = validateBatch([minute(), panel(), event()], NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value?.length, 3);
});

test("a stale panel slot is valid with null power", () => {
  const stale = panel({
    quality: "stale_source",
    ac_kw: null,
    energy_kwh_total: null,
    dc_kw: null,
    dc_v: null,
    dc_a: null,
    ac_v: null,
    ac_a: null,
    heatsink_c: null,
    measured_at_utc: null,
  });
  assert.equal(validateBatch([stale], NOW).ok, true);
});

test("reports invalid record ids instead of writing partly", () => {
  const unknown = minute({ serial_number: "ZS99000042" });
  const result = validateBatch([unknown, panel()], NOW);
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalidIds, ["home-pvs:site_minute:2026-09-18T03:00:00Z"]);

  assert.equal(validateBatch([minute({ sample_count: -1 })], NOW).ok, false);
  assert.equal(validateBatch([panel({ panel_id: "inverter-3" })], NOW).ok, false);
  assert.equal(validateBatch([panel({ slot_ts: "" })], NOW).ok, false);
  assert.equal(validateBatch([{ ...event(), kind: "raw_response" }], NOW).ok, false);
  assert.equal(validateBatch([{ record_id: "x" }], NOW).ok, false);
});

test("rejects oversized batches", () => {
  const records = Array.from({ length: 101 }, (_value, index) => minute({ record_id: `id-${index}` }));
  const result = validateBatch(records, NOW);
  assert.equal(result.error, "batch_too_large");
});

test("canonical digests are stable and content sensitive", async () => {
  const first = minute();
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(canonicalJson(reordered), canonicalJson(first));
  assert.equal(await digestOf(reordered), await digestOf(first));
  assert.notEqual(await digestOf(minute({ pv_kw_avg: 3.3 })), await digestOf(first));
});

test("planning maps times to epoch seconds and keeps nulls", async () => {
  const planned = await planWrite(minute() as never, 1_700_000_000);
  assert.equal(planned.table, "site_minute");
  assert.equal(planned.columns.minute_ts, Date.parse("2026-09-18T03:00:00Z") / 1000);
  assert.equal(planned.columns.complete, 1);
  assert.equal(planned.columns.battery_kw_avg, null);
  assert.deepEqual(planned.keyValues, ["home-pvs", Date.parse("2026-09-18T03:00:00Z") / 1000]);

  const slot = await planWrite(
    panel({
      quality: "stale_source",
      ac_kw: null,
      energy_kwh_total: null,
      dc_kw: null,
      heatsink_c: null,
      measured_at_utc: null,
    }) as never,
    1_700_000_000,
  );
  assert.equal(slot.table, "panel_sample");
  assert.equal(slot.columns.ac_kw, null);
  assert.equal(slot.columns.dc_kw, null);
  assert.equal(slot.columns.heatsink_c, null);
  assert.equal(slot.columns.measured_ts, null);
  assert.deepEqual(slot.keyValues, ["home-pvs", "p01", Date.parse("2026-09-18T03:00:00Z") / 1000]);
});

class FakeDb {
  batches: string[][] = [];
  statements: { sql: string; values: unknown[] }[] = [];

  constructor(private responses: { results?: unknown[] }[] = []) {}

  prepare(sql: string) {
    const statement = {
      sql,
      values: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.values = values;
        return statement;
      },
      run: async () => ({ success: true }),
    };
    this.statements.push(statement);
    return statement;
  }

  async batch(input: { sql: string }[]) {
    this.batches.push(input.map((item) => item.sql));
    if (input.every((item) => item.sql.startsWith("SELECT"))) return this.responses;
    return input.map(() => ({ results: [] }));
  }
}

test("writeRecords inserts once and guards against races", async () => {
  const db = new FakeDb([{ results: [] }]);
  const outcome = await writeRecords(db as unknown as D1Database, [minute() as never, panel() as never], 1_700_000_000);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.acceptedIds.length, 2);
  assert.equal(db.batches.length, 2);
  assert.match(db.batches[1][0], /^INSERT INTO site_minute .* ON CONFLICT DO NOTHING$/);
  // The panel sample also adds the panel to the known-panel inventory, which is
  // what the matrix lists panels from. That row is written once per panel: an
  // upsert here would cost 2 rows written per panel per five-minute slot. A
  // minute record adds no such row.
  assert.match(db.batches[1][2], /^INSERT INTO panel_known \(collector_id, panel_id, last_seen_ts\) VALUES \(\?, \?, \?\) ON CONFLICT DO NOTHING$/);
  assert.equal(db.batches[1].length, 3);
  assert.match(db.batches[0][0], /^SELECT digest FROM site_minute WHERE collector_id = \? AND minute_ts = \?$/);
});

test("writeRecords reports conflicts and writes nothing", async () => {
  const db = new FakeDb([{ results: [{ digest: "different" }] }]);
  const outcome = await writeRecords(db as unknown as D1Database, [minute() as never], 1_700_000_000);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.conflictingIds, ["home-pvs:site_minute:2026-09-18T03:00:00Z"]);
  assert.equal(db.batches.length, 1);
});

test("repeat of the same id and digest is accepted without a write", async () => {
  const digest = await digestOf(minute());
  const db = new FakeDb([{ results: [{ digest }] }]);
  const outcome = await writeRecords(db as unknown as D1Database, [minute() as never], 1_700_000_000);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.acceptedIds, ["home-pvs:site_minute:2026-09-18T03:00:00Z"]);
});

test("an old replay marks its existing daily view dirty", async () => {
  const db = new FakeDb([{ results: [] }]);
  const oldTs = Math.floor((Date.now() / 1000 - 3 * 86400) / 60) * 60;
  const old = new Date(oldTs * 1000).toISOString().replace(/\.000Z$/, "Z");
  const oldRecord = minute({
    record_id: `home-pvs:site_minute:${old}`,
    window_start_utc: old,
    window_end_utc: new Date((oldTs + 60) * 1000).toISOString().replace(/\.000Z$/, "Z"),
    last_measured_at_utc: new Date((oldTs + 50) * 1000).toISOString().replace(/\.000Z$/, "Z"),
  });
  const response = await ingest.fetch(new Request("https://ingest.example/api/v1/records", {
    method: "POST",
    headers: { Authorization: "Bearer local-test", "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, collector_id: "home-pvs", records: [oldRecord] }),
  }), { DB: db as unknown as D1Database, UPLOAD_TOKEN: "local-test" });
  assert.equal(response.status, 200);
  const dirty = db.statements.find((statement) => statement.sql.startsWith("UPDATE site_day SET updated_ts = 0"));
  assert.deepEqual(dirty?.values, ["home-pvs", oldTs, oldTs]);
});

test("latest site is only overwritten by a newer collection time", async () => {
  const db = new FakeDb();
  await upsertLatestSite(db as unknown as D1Database, live(), 1_700_000_000);
  const [statement] = db.statements;
  assert.match(statement.sql, /^INSERT INTO latest_site /);
  assert.match(statement.sql, /WHERE excluded\.collected_ts > latest_site\.collected_ts$/);
  assert.equal(statement.values[0], "home-pvs");
  assert.equal(statement.values[7], -1.8);
});
