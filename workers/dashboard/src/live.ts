/** Latest-value read model: freshness and direction, never a fabricated zero. */

export const LIVE_THRESHOLD_SECONDS = 30;
export const DELAYED_THRESHOLD_SECONDS = 60;

export interface LiveRow {
  collected_ts: number | null;
  measured_ts: number | null;
  received_ts: number;
  quality: string;
  pv_kw: number | null;
  load_kw_reported: number | null;
  grid_kw: number | null;
  battery_kw: number | null;
  pv_kwh_total: number | null;
  load_kwh_total_reported: number | null;
  grid_net_kwh_total: number | null;
}

export type Freshness = "live" | "delayed" | "stale";

export function freshness(ageSeconds: number | null): Freshness | "unavailable" {
  if (ageSeconds === null || ageSeconds < 0) return "unavailable";
  if (ageSeconds <= LIVE_THRESHOLD_SECONDS) return "live";
  if (ageSeconds <= DELAYED_THRESHOLD_SECONDS) return "delayed";
  return "stale";
}

export function toIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function presentLatest(row: LiveRow | null, nowSeconds: number): Record<string, unknown> {
  if (row === null) {
    return {
      state: "unavailable",
      age_seconds: null,
      collected_at_utc: null,
      measured_at_utc: null,
      received_at_utc: null,
      quality: null,
      pv_kw: null,
      load_kw_reported: null,
      grid_kw: null,
      battery_kw: null,
      import_kw: null,
      export_kw: null,
      pv_kwh_total: null,
      grid_net_kwh_total: null,
      load_kwh_total_reported: null,
    };
  }
  // Freshness follows the PVS measurement time, with collection time as a check.
  const reference = row.measured_ts ?? row.collected_ts;
  const age = reference === null ? null : Math.max(0, Math.floor(nowSeconds - reference));
  const grid = typeof row.grid_kw === "number" ? row.grid_kw : null;
  return {
    state: freshness(age),
    age_seconds: age,
    collected_at_utc: toIso(row.collected_ts),
    measured_at_utc: toIso(row.measured_ts),
    received_at_utc: toIso(row.received_ts),
    quality: row.quality,
    pv_kw: row.pv_kw,
    load_kw_reported: row.load_kw_reported,
    grid_kw: grid,
    battery_kw: row.battery_kw,
    import_kw: grid === null ? null : Math.max(grid, 0),
    export_kw: grid === null ? null : Math.max(-grid, 0),
    pv_kwh_total: row.pv_kwh_total,
    grid_net_kwh_total: row.grid_net_kwh_total,
    load_kwh_total_reported: row.load_kwh_total_reported,
  };
}
