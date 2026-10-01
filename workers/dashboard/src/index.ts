/**
 * Dashboard Worker: GitHub login gate in front of the private page and API.
 *
 * `assets.run_worker_first = true` means every asset request passes through
 * this worker, so preview URLs and custom domains cannot bypass the session.
 */

import { presentLatest, type LiveRow } from "./live.js";
import {
  allowResolve,
  parseLocationBody,
  parseResolveInput,
  readLocation,
  resolvePlaces,
  saveLocation,
  type StoredLocation,
} from "./location.js";
import { authorizeUrl, exchangeCode, fetchUserId, isAllowedUser, oauthFailureCode } from "./oauth.js";
import { OAUTH_COOKIE, SCHEMA_VERSION, SESSION_COOKIE, SESSION_SECONDS } from "./constants.js";
import {
  MAX_ENERGY_SPAN_SECONDS,
  instantSeconds,
  parseRange,
  readAllPanelHistory,
  readHealth,
  readHistory,
  readPanelHistory,
  readPanelDayEnergy,
  readPanelsLatest,
} from "./query.js";
import { parseWeatherRange, readWeather } from "./weather.js";
import { syncWeather } from "../../shared/weather-sync.js";
import {
  clearCookie,
  pkceChallenge,
  pkceVerifier,
  randomToken,
  readCookie,
  setCookie,
  signSession,
  type Session,
  verifySession,
} from "./session.js";

export interface Env {
  DB: D1Database;
  ASSETS: AssetFetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ALLOWED_USER_IDS: string;
  COLLECTOR_ID?: string;
  GITHUB_ORIGIN?: string;
  DEPLOY_TAG?: string;
  GIT_SHA?: string;
}

export interface AssetFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Location bodies are small; anything larger is refused before parsing. */
const MAX_SMALL_BODY_BYTES = 4096;

interface OauthState {
  state: string;
  verifier: string;
  redirectUri: string;
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/auth/login") return login(request, env, url);
    if (url.pathname === "/auth/callback") return callback(request, env, url);
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      if (!sameOrigin(request, url)) return json({ error: "cross_origin" }, 403);
      const browser = request.headers.get("Accept")?.includes("text/html");
      return new Response(browser
        ? '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed out — Solar monitor</title><body><main><h1>Signed out</h1><p>Your dashboard session has ended.</p><a href="/auth/login">Sign in again</a></main></body></html>'
        : JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": browser ? "text/html; charset=utf-8" : "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": clearCookie(SESSION_COOKIE),
        },
      });
    }
    if (url.pathname === "/api/v1/version" && request.method === "GET") {
      return json({ service: "sunpower-monitor-dashboard", schema_version: SCHEMA_VERSION, tag: env.DEPLOY_TAG ?? "dev", sha: env.GIT_SHA ?? "unknown" });
    }
    const verified = await verifySession(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET, nowSeconds());
    const session = verified && isAllowedUser(verified.userId, env.ALLOWED_USER_IDS) ? verified : null;
    if (url.pathname.startsWith("/api/")) {
      if (!session) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/v1/live" && request.method === "GET") return live(env);
      if (url.pathname === "/api/v1/history" && request.method === "GET") return history(env, url);
      if (url.pathname === "/api/v1/panels" && request.method === "GET") return panels(env, url);
      if (url.pathname === "/api/v1/weather" && request.method === "GET") return weather(env, url);
      if (url.pathname === "/api/v1/location" && request.method === "GET") return getLocation(env);
      if (url.pathname === "/api/v1/calibration" && request.method === "GET") return getCalibration(env);
      if (url.pathname === "/api/v1/calibration" && request.method === "PUT") {
        if (!sameOrigin(request, url)) return json({ error: "cross_origin" }, 403);
        return putCalibration(request, env);
      }
      if (url.pathname === "/api/v1/location" && request.method === "PUT") {
        if (!sameOrigin(request, url)) return json({ error: "cross_origin" }, 403);
        return putLocation(request, env, context);
      }
      if (url.pathname === "/api/v1/location/resolve" && request.method === "POST") {
        if (!sameOrigin(request, url)) return json({ error: "cross_origin" }, 403);
        return resolveLocation(request, env, session);
      }
      if (url.pathname === "/api/v1/health" && request.method === "GET") return health(env);
      return json({ error: "not_found" }, 404);
    }
    if (!session) {
      if (request.headers.get("Accept")?.includes("text/html")) {
        return Response.redirect(`${url.origin}/auth/login`, 302);
      }
      return new Response("unauthorized", { status: 401 });
    }
    return serveAsset(request, env);
  },
};

/**
 * Browsers send Origin on same-origin PUT/POST. A missing header is only
 * accepted when the request is not marked cross-site, so a plain curl with the
 * session cookie still works while a hostile page does not.
 */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === url.origin;
  return request.headers.get("Sec-Fetch-Site") !== "cross-site";
}

async function readSmallJson(request: Request): Promise<{ ok: boolean; body?: unknown; status?: number }> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SMALL_BODY_BYTES) return { ok: false, status: 413 };
  const text = await request.text();
  if (text.length > MAX_SMALL_BODY_BYTES) return { ok: false, status: 413 };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function presentLocation(row: StoredLocation | null): Record<string, unknown> {
  if (row === null) {
    return { configured: false, latitude: null, longitude: null, timezone: null, source: null, updated_at_utc: null };
  }
  return {
    configured: true,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    source: row.source,
    updated_at_utc: isoOrNull(row.updated_ts),
  };
}

async function getLocation(env: Env): Promise<Response> {
  const row = await readLocation(env.DB, collectorId(env));
  return json({ schema_version: SCHEMA_VERSION, collector_id: collectorId(env), ...presentLocation(row) });
}

async function putLocation(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  const parsed = await readSmallJson(request);
  if (!parsed.ok) return json({ error: "body" }, parsed.status ?? 400);
  const validation = parseLocationBody(parsed.body);
  if (!validation.ok) return json({ error: validation.error }, 400);
  const place = validation.value!;
  const updatedTs = nowSeconds();
  await saveLocation(env.DB, collectorId(env), place, updatedTs);
  // Fetch weather once here, so a freshly confirmed location is not blind until
  // the next :17 cron tick. The location is already saved: a provider or
  // database failure must not turn this response into an error.
  const sync = syncWeather(env.DB, collectorId(env)).catch(() => undefined);
  if (context !== undefined && typeof context.waitUntil === "function") context.waitUntil(sync);
  else await sync;
  return json({
    schema_version: SCHEMA_VERSION,
    collector_id: collectorId(env),
    ...presentLocation({ ...place, updated_ts: updatedTs }),
  });
}

async function resolveLocation(request: Request, env: Env, session: Session): Promise<Response> {
  const parsed = await readSmallJson(request);
  if (!parsed.ok) return json({ error: "body" }, parsed.status ?? 400);
  const validation = parseResolveInput(parsed.body);
  if (!validation.ok) return json({ error: validation.error }, 400);
  if (!allowResolve(session.userId, nowSeconds())) return json({ error: "rate_limited" }, 429);
  const result = await resolvePlaces(fetch, validation.value!);
  if (!result.ok) return json({ error: result.error }, 502);
  return json({ schema_version: SCHEMA_VERSION, candidates: result.value });
}

async function weather(env: Env, url: URL): Promise<Response> {
  const range = parseWeatherRange(url.searchParams, nowSeconds());
  if (!range.ok) return json({ error: range.error }, 400);
  const id = collectorId(env);
  const location = await readLocation(env.DB, id);
  if (location === null) {
    return json({
      schema_version: SCHEMA_VERSION,
      collector_id: id,
      configured: false,
      location: presentLocation(null),
      from_utc: isoOrNull(range.value!.fromTs),
      to_utc: isoOrNull(range.value!.toTs),
      stale: true,
      newest_fetched_at_utc: null,
      hours: [],
      days: [],
    });
  }
  const view = await readWeather(env.DB, id, range.value!, location.timezone, nowSeconds());
  return json({
    schema_version: SCHEMA_VERSION,
    collector_id: id,
    configured: true,
    location: presentLocation(location),
    from_utc: isoOrNull(range.value!.fromTs),
    to_utc: isoOrNull(range.value!.toTs),
    stale: view.stale,
    newest_fetched_at_utc: isoOrNull(view.newestFetchedTs),
    hours: view.hours,
    days: view.days,
  });
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

async function login(request: Request, env: Env, url: URL): Promise<Response> {
  const state = randomToken();
  const verifier = pkceVerifier();
  const payload: OauthState = { state, verifier, redirectUri: `${url.origin}/auth/callback` };
  const authorize = authorizeUrl(
    { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: payload.redirectUri },
    state,
    await pkceChallenge(verifier),
  );
  return new Response(null, {
    status: 302,
    headers: { Location: authorize, "Set-Cookie": setCookie(OAUTH_COOKIE, btoa(JSON.stringify(payload)), { maxAge: 600 }) },
  });
}

async function callback(request: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const raw = readCookie(request, OAUTH_COOKIE);
  if (!code || !state || !raw) return new Response("bad_request", { status: 400 });
  let stored: OauthState;
  try {
    stored = JSON.parse(atob(raw)) as OauthState;
  } catch {
    return new Response("bad_request", { status: 400 });
  }
  if (stored.state !== state) return new Response("state_mismatch", { status: 400 });
  const config = {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    redirectUri: stored.redirectUri,
  };
  try {
    const token = await exchangeCode(fetch, config, code, stored.verifier);
    const userId = await fetchUserId(fetch, token);
    if (!isAllowedUser(userId, env.ALLOWED_USER_IDS)) return new Response("forbidden", { status: 403 });
    const session = await signSession({ userId, expiresAt: nowSeconds() + SESSION_SECONDS }, env.SESSION_SECRET);
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, session, { maxAge: SESSION_SECONDS }));
    headers.append("Set-Cookie", clearCookie(OAUTH_COOKIE));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return new Response(`oauth_failed:${oauthFailureCode(error)}`, {
      status: 502, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
}

async function live(env: Env): Promise<Response> {
  const [row, calibration] = await Promise.all([env.DB.prepare(
    "SELECT collected_ts, measured_ts, received_ts, quality, pv_kw, load_kw_reported, grid_kw, battery_kw," +
      " pv_kwh_total, load_kwh_total_reported, grid_net_kwh_total FROM latest_site LIMIT 1",
  ).first<LiveRow>(), readCalibration(env)]);
  return json({ ...presentLatest(row ?? null, nowSeconds()), calibration });
}

function collectorId(env: Env): string {
  return env.COLLECTOR_ID && env.COLLECTOR_ID.length > 0 ? env.COLLECTOR_ID : "home-pvs";
}

async function readCalibration(env: Env): Promise<{ grid_ratio: number; updated_at_utc: string | null }> {
  const row = await env.DB.prepare("SELECT grid_ratio, updated_ts FROM site_calibration WHERE collector_id = ?")
    .bind(collectorId(env)).first<{ grid_ratio: number; updated_ts: number }>();
  return { grid_ratio: row?.grid_ratio ?? 1, updated_at_utc: row ? isoOrNull(row.updated_ts) : null };
}

async function getCalibration(env: Env): Promise<Response> {
  return json({ schema_version: SCHEMA_VERSION, collector_id: collectorId(env), ...await readCalibration(env) });
}

async function putCalibration(request: Request, env: Env): Promise<Response> {
  const parsed = await readSmallJson(request);
  if (!parsed.ok) return json({ error: "body" }, parsed.status ?? 400);
  const body = parsed.body;
  const ratio = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).grid_ratio : undefined;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0.1 || ratio > 2) {
    return json({ error: "invalid_grid_ratio" }, 400);
  }
  const updatedTs = nowSeconds();
  await env.DB.prepare("INSERT INTO site_calibration (collector_id, grid_ratio, updated_ts) VALUES (?, ?, ?) " +
    "ON CONFLICT(collector_id) DO UPDATE SET grid_ratio = excluded.grid_ratio, updated_ts = excluded.updated_ts")
    .bind(collectorId(env), ratio, updatedTs).run();
  return json({ schema_version: SCHEMA_VERSION, collector_id: collectorId(env),
    grid_ratio: ratio, updated_at_utc: isoOrNull(updatedTs) });
}

async function history(env: Env, url: URL): Promise<Response> {
  const range = parseRange(url.searchParams, nowSeconds());
  if (!range.ok) return json({ error: range.error }, 400);
  const location = range.value!.resolution === "1d" ? await readLocation(env.DB, collectorId(env)) : null;
  const timezone = location?.timezone ?? "UTC";
  const [view, calibration] = await Promise.all([
    readHistory(env.DB, collectorId(env), range.value!, timezone), readCalibration(env),
  ]);
  return json({
    schema_version: SCHEMA_VERSION,
    collector_id: collectorId(env),
    resolution: view.resolution,
    timezone: view.resolution === "1d" ? timezone : null,
    from_utc: isoOrNull(view.fromTs),
    to_utc: isoOrNull(view.toTs),
    truncated: view.truncated,
    summary: view.summary,
    windows: view.windows,
    calibration,
  });
}

/**
 * Optional energy window for the panel matrix. The browser names the window so
 * "today" can be the site's day; without it the endpoint stays a single-slot
 * read, which is what the Live page polls every five minutes.
 */
function energyRange(params: URLSearchParams): { error?: string; fromTs?: number; toTs?: number } {
  if (!params.has("energy_from") && !params.has("energy_to")) return {};
  const fromTs = instantSeconds(params.get("energy_from"));
  const toTs = instantSeconds(params.get("energy_to"));
  if (fromTs === null || toTs === null || toTs <= fromTs || toTs - fromTs > MAX_ENERGY_SPAN_SECONDS) {
    return { error: "invalid_range" };
  }
  return { fromTs, toTs };
}

async function panels(env: Env, url: URL): Promise<Response> {
  const panelId = url.searchParams.get("panel_id");
  const historyMode = url.searchParams.get("history");
  if (historyMode !== null) {
    if (historyMode !== "all" || panelId !== null) return json({ error: "invalid_history_mode" }, 400);
    const fromTs = instantSeconds(url.searchParams.get("from"));
    const toTs = instantSeconds(url.searchParams.get("to"));
    if (fromTs === null || toTs === null || toTs <= fromTs || toTs - fromTs > MAX_ENERGY_SPAN_SECONDS) {
      return json({ error: "invalid_range" }, 400);
    }
    const view = await readAllPanelHistory(env.DB, collectorId(env), fromTs, toTs);
    return json({ schema_version: SCHEMA_VERSION, collector_id: collectorId(env), ...view });
  }
  if (panelId === null) {
    const latest = await readPanelsLatest(env.DB, collectorId(env), nowSeconds());
    const energy = energyRange(url.searchParams);
    if (energy.error !== undefined) return json({ error: energy.error }, 400);
    let panels = latest.panels;
    let coverageFrom: number | null = null;
    if (energy.fromTs !== undefined && energy.toTs !== undefined) {
      const moved = await readPanelDayEnergy(env.DB, collectorId(env), energy.fromTs, energy.toTs);
      const days = moved.values();
      for (const day of days) {
        if (coverageFrom === null || day.firstTs < coverageFrom) coverageFrom = day.firstTs;
      }
      panels = (latest.panels as Array<Record<string, unknown>>).map((panel) => {
        const day = moved.get(String(panel.panel_id));
        return {
          ...panel,
          energy_kwh: day ? day.kwh : null,
          energy_first_slot_utc: day ? isoOrNull(day.firstTs) : null,
          energy_last_slot_utc: day ? isoOrNull(day.lastTs) : null,
        };
      });
    }
    return json({
      schema_version: SCHEMA_VERSION,
      collector_id: collectorId(env),
      resolution: "5m",
      ...latest,
      panels,
      energy_from_utc: energy.fromTs === undefined ? null : isoOrNull(energy.fromTs),
      energy_to_utc: energy.toTs === undefined ? null : isoOrNull(energy.toTs),
      // The window a page asked for is rarely the window the data covers: a
      // late first slot makes every total a partial one, and saying so is
      // cheaper than a page guessing.
      energy_coverage_from_utc: isoOrNull(coverageFrom),
    });
  }
  if (!/^p[0-9]{1,4}$/.test(panelId)) return json({ error: "invalid_panel_id" }, 400);
  const toTs = instantSeconds(url.searchParams.get("to")) ?? nowSeconds();
  const fromTs = instantSeconds(url.searchParams.get("from")) ?? toTs - 24 * 3600;
  if (toTs <= fromTs) return json({ error: "invalid_range" }, 400);
  const view = await readPanelHistory(env.DB, collectorId(env), panelId, fromTs, toTs);
  return json({ schema_version: SCHEMA_VERSION, collector_id: collectorId(env), ...view });
}

async function health(env: Env): Promise<Response> {
  const view = await readHealth(env.DB, collectorId(env), nowSeconds());
  return json({ schema_version: SCHEMA_VERSION, ...view });
}

function isoOrNull(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
