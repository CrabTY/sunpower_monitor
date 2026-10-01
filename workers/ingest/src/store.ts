/** D1 writes for ingested records: conflict detection first, then one batch. */

import { type ValidRecord, digestOf, parseInstant } from "../../shared/contract.js";

export interface PlannedWrite {
  table: string;
  recordId: string;
  digest: string;
  keyColumns: string[];
  keyValues: unknown[];
  columns: Record<string, unknown>;
}

export interface WriteOutcome {
  ok: boolean;
  acceptedIds: string[];
  conflictingIds: string[];
  error?: string;
}

function epochSeconds(value: unknown): number | null {
  const parsed = parseInstant(value);
  return parsed === null ? null : Math.floor(parsed / 1000);
}

export async function planWrite(record: ValidRecord, receivedTs: number): Promise<PlannedWrite> {
  const digest = await digestOf(record);
  if (record.kind === "site_minute") {
    const minute = epochSeconds(record.window_start_utc) as number;
    return {
      table: "site_minute",
      recordId: record.record_id,
      digest,
      keyColumns: ["collector_id", "minute_ts"],
      keyValues: [record.collector_id, minute],
      columns: {
        collector_id: record.collector_id,
        minute_ts: minute,
        window_end_ts: epochSeconds(record.window_end_utc),
        sample_count: record.sample_count,
        valid_count: record.valid_count,
        complete: record.complete ? 1 : 0,
        quality: record.quality,
        pv_kw_avg: record.pv_kw_avg ?? null,
        load_kw_reported_avg: record.load_kw_reported_avg ?? null,
        grid_kw_avg: record.grid_kw_avg ?? null,
        battery_kw_avg: record.battery_kw_avg ?? null,
        valid_counts_json: JSON.stringify(record.valid_counts ?? null),
        pv_kwh_total_end: record.pv_kwh_total_end ?? null,
        load_kwh_total_reported_end: record.load_kwh_total_reported_end ?? null,
        grid_net_kwh_total_end: record.grid_net_kwh_total_end ?? null,
        last_measured_ts: epochSeconds(record.last_measured_at_utc),
        digest,
        received_ts: receivedTs,
      },
    };
  }
  if (record.kind === "panel_sample") {
    const slot = epochSeconds(record.slot_ts) as number;
    return {
      table: "panel_sample",
      recordId: record.record_id,
      digest,
      keyColumns: ["collector_id", "panel_id", "slot_ts"],
      keyValues: [record.collector_id, record.panel_id, slot],
      columns: {
        collector_id: record.collector_id,
        panel_id: record.panel_id,
        slot_ts: slot,
        ac_kw: record.ac_kw ?? null,
        energy_kwh_total: record.energy_kwh_total ?? null,
        dc_kw: record.dc_kw ?? null,
        dc_v: record.dc_v ?? null,
        dc_a: record.dc_a ?? null,
        ac_v: record.ac_v ?? null,
        ac_a: record.ac_a ?? null,
        heatsink_c: record.heatsink_c ?? null,
        measured_ts: epochSeconds(record.measured_at_utc),
        quality: record.quality,
        digest,
        received_ts: receivedTs,
      },
    };
  }
  return {
    table: "collector_event",
    recordId: record.record_id,
    digest,
    keyColumns: ["event_id"],
    keyValues: [record.record_id],
    columns: {
      event_id: record.record_id,
      collector_id: record.collector_id,
      event_ts: epochSeconds(record.event_ts_utc),
      event_type: record.event_type,
      details_code: record.details_code ?? null,
      digest,
      received_ts: receivedTs,
    },
  };
}

function insertStatement(db: D1Database, planned: PlannedWrite): D1PreparedStatement {
  const columns = Object.keys(planned.columns);
  const sql =
    `INSERT INTO ${planned.table} (${columns.join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
  return db.prepare(sql).bind(...columns.map((column) => planned.columns[column]));
}

function conflictStatement(db: D1Database, planned: PlannedWrite): D1PreparedStatement {
  const sql =
    `SELECT digest FROM ${planned.table} WHERE ` +
    planned.keyColumns.map((column) => `${column} = ?`).join(" AND ");
  return db.prepare(sql).bind(...planned.keyValues);
}

/**
 * The known-panel inventory follows every panel sample. A panel that stops
 * reporting keeps its row here, which is how the matrix still lists it without
 * walking the stored samples to rediscover the panel list.
 *
 * The row is written once per panel, not once per slot: D1 counts every index
 * entry as a row written, so re-upserting the same roster every five minutes
 * cost 2 rows per panel per slot (about 12,000 rows/day for 21 panels) to move
 * a timestamp nobody reads. `last_seen_ts` records first sighting; the page
 * takes the newest slot from `panel_sample`, which is an indexed seek.
 */
function knownPanelStatement(db: D1Database, planned: PlannedWrite): D1PreparedStatement | null {
  if (planned.table !== "panel_sample") return null;
  return db
    .prepare(
      "INSERT INTO panel_known (collector_id, panel_id, last_seen_ts) VALUES (?, ?, ?)" +
        " ON CONFLICT DO NOTHING",
    )
    .bind(planned.columns.collector_id, planned.columns.panel_id, planned.columns.slot_ts);
}

/**
 * All-or-nothing batch: the same ID with the same digest is accepted again,
 * the same ID with different content is reported for isolation, and nothing
 * is written when any record conflicts.
 */
export async function writeRecords(
  db: D1Database,
  records: ValidRecord[],
  receivedTs: number,
): Promise<WriteOutcome> {
  const planned = await Promise.all(records.map((record) => planWrite(record, receivedTs)));
  const checks = await db.batch(planned.map((item) => conflictStatement(db, item)));
  const conflictingIds: string[] = [];
  checks.forEach((result, index) => {
    const row = (result?.results?.[0] ?? null) as { digest?: string } | null;
    if (row && row.digest !== planned[index].digest) conflictingIds.push(planned[index].recordId);
  });
  if (conflictingIds.length > 0) {
    return { ok: false, acceptedIds: [], conflictingIds, error: "conflict" };
  }
  const known = planned
    .map((item) => knownPanelStatement(db, item))
    .filter((statement): statement is D1PreparedStatement => statement !== null);
  await db.batch([...planned.map((item) => insertStatement(db, item)), ...known]);
  return { ok: true, acceptedIds: planned.map((item) => item.recordId), conflictingIds: [] };
}

/**
 * The ten-second live snapshot, kept as it is (2026-09-21) rather than moved
 * onto `site_minute`.
 *
 * ponytail: ceiling is 17,280 rows/day, the largest single D1 writer (8,640
 * overwrites at 2 rows each) plus as many Worker requests. Read "Measured write
 * budget, and the deferred latest_site change" in docs/architecture.md before
 * changing the cadence or retiring the table.
 */
export async function upsertLatestSite(db: D1Database, payload: Record<string, unknown>, receivedTs: number): Promise<void> {
  const columns: Record<string, unknown> = {
    collector_id: payload.collector_id,
    collected_ts: epochSeconds(payload.collected_at_utc),
    measured_ts: epochSeconds(payload.measured_at_utc),
    received_ts: receivedTs,
    quality: payload.quality,
    pv_kw: payload.pv_kw ?? null,
    load_kw_reported: payload.load_kw_reported ?? null,
    grid_kw: payload.grid_kw ?? null,
    battery_kw: payload.battery_kw ?? null,
    pv_kwh_total: payload.pv_kwh_total ?? null,
    load_kwh_total_reported: payload.load_kwh_total_reported ?? null,
    grid_net_kwh_total: payload.grid_net_kwh_total ?? null,
  };
  const names = Object.keys(columns);
  const sql =
    `INSERT INTO latest_site (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ` +
    `ON CONFLICT(collector_id) DO UPDATE SET ${names
      .filter((name) => name !== "collector_id")
      .map((name) => `${name} = excluded.${name}`)
      .join(", ")} WHERE excluded.collected_ts > latest_site.collected_ts`;
  await db.prepare(sql).bind(...names.map((name) => columns[name])).run();
}
