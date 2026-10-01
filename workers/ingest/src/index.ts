/** Ingest Worker: authenticated Pi uploads only. No reads, no PVS proxy. */

import {
  MAX_BODY_BYTES,
  SCHEMA_VERSION,
  type ValidRecord,
  isPlainObject,
  validateBatch,
  validateLive,
} from "../../shared/contract.js";
import { upsertLatestSite, writeRecords } from "./store.js";
import { syncWeather } from "../../shared/weather-sync.js";
import { refreshSiteDays } from "../../shared/site-day.js";

export interface Env {
  DB: D1Database;
  UPLOAD_TOKEN: string;
  COLLECTOR_ID?: string;
  DEPLOY_TAG?: string;
  GIT_SHA?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/v1/version" && request.method === "GET") {
      return json({ service: "sunpower-monitor-ingest", schema_version: SCHEMA_VERSION, tag: env.DEPLOY_TAG ?? "dev", sha: env.GIT_SHA ?? "unknown" });
    }
    if (!authorized(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
    if (pathname === "/api/v1/live" && request.method === "PUT") return putLive(request, env);
    if (pathname === "/api/v1/records" && request.method === "POST") return postRecords(request, env);
    return json({ error: "not_found" }, 404);
  },

  /** Separate cron invocations keep each job inside the D1 query limit. */
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    if (controller.cron === "17 * * * *") context.waitUntil(syncWeather(env.DB, collectorId(env)));
    if (controller.cron === "47 * * * *") {
      context.waitUntil(refreshSiteDays(env.DB, collectorId(env), Math.floor(Date.now() / 1000)));
    }
  },
};

function collectorId(env: Env): string {
  return env.COLLECTOR_ID && env.COLLECTOR_ID.length > 0 ? env.COLLECTOR_ID : "home-pvs";
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return timingSafeEqual(header.slice(7), token);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function readJson(request: Request): Promise<{ ok: boolean; body?: unknown; status?: number }> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, status: 413 };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413 };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function putLive(request: Request, env: Env): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return json({ error: "body" }, parsed.status ?? 400);
  const validation = validateLive(parsed.body, Date.now());
  if (!validation.ok) return json({ error: validation.error }, 400);
  await upsertLatestSite(env.DB, validation.value as Record<string, unknown>, Math.floor(Date.now() / 1000));
  return new Response(null, { status: 204 });
}

async function postRecords(request: Request, env: Env): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return json({ error: "body" }, parsed.status ?? 400);
  if (!isPlainObject(parsed.body)) return json({ error: "body" }, 400);
  const envelope = parsed.body;
  if (envelope.schema_version !== SCHEMA_VERSION) return json({ error: "schema_version" }, 400);
  const validation = validateBatch(envelope.records, Date.now());
  if (!validation.ok) {
    const status = validation.error === "batch_too_large" ? 413 : 400;
    return json({ error: validation.error, invalid_ids: validation.invalidIds ?? [] }, status);
  }
  const records = validation.value as (Record<string, unknown> & { kind: string })[];
  if (records.some((record) => record.collector_id !== envelope.collector_id)) {
    return json({ error: "collector_mismatch", invalid_ids: [] }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const outcome = await writeRecords(env.DB, records as unknown as ValidRecord[], now);
  if (!outcome.ok) return json({ error: outcome.error, conflicting_ids: outcome.conflictingIds }, 409);
  // An offline Pi can replay old minutes after their daily view was finalized.
  // Mark only those old days dirty; the hourly rollup refreshes them in batches.
  const lateMinutes = records
    .filter((record) => record.kind === "site_minute")
    .map((record) => Date.parse(String(record.window_start_utc)) / 1000)
    .filter((ts) => Number.isFinite(ts) && ts < now - 86400);
  if (lateMinutes.length > 0) {
    await env.DB.prepare(
      "UPDATE site_day SET updated_ts = 0 WHERE collector_id = ? AND start_ts <= ? AND end_ts > ?",
    ).bind(String(envelope.collector_id), Math.max(...lateMinutes), Math.min(...lateMinutes)).run();
  }
  return json({ accepted_ids: outcome.acceptedIds }, 200);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
