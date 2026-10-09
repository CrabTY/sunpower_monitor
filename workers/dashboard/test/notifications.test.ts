import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import dashboard, { type Env } from "../src/index.js";
import { SESSION_COOKIE } from "../src/constants.js";
import { signSession } from "../src/session.js";
import { checkNotifications, decryptDeviceKey, encryptDeviceKey, getNotifications, mutateNotifications } from "../src/notifications.js";

const NOW = 1_800_000_000, SECRET = "synthetic-session-secret", KEY = "synthetic-bark-device", ID = "test-pvs";
const ok: typeof fetch = async () => new Response(JSON.stringify({ code: 200 }));

function database(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("workers/schema.sql", "utf8"));
  t.after(() => sqlite.close());
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let bound: SQLInputValue[] = [];
    return {
      bind(...values: unknown[]) { bound = values as SQLInputValue[]; return this; },
      async first() { return statement.get(...bound) ?? null; },
      async run() { const result = statement.run(...bound); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  } } as unknown as D1Database;
  const row = () => sqlite.prepare("SELECT * FROM site_notifications WHERE collector_id = ?").get(ID)!;
  const reading = (now: number, quality = "ok", measured: number | null = now, collected = now) => {
    sqlite.prepare("INSERT OR REPLACE INTO latest_site (collector_id, collected_ts, measured_ts, received_ts, quality, pv_kw) VALUES (?, ?, ?, ?, ?, 0)")
      .run(ID, collected, measured, now, quality);
  };
  const enable = (now = NOW) => mutateNotifications(db, SECRET, ID, "save", { enabled: true, device_key: KEY }, now, ok);
  return { db, sqlite, row, reading, enable };
}

test("device keys are encrypted, authenticated and scoped to a collector and secret", async () => {
  const cipher = await encryptDeviceKey(KEY, SECRET, ID);
  assert.ok(!cipher.includes(KEY));
  assert.notEqual(cipher, await encryptDeviceKey(KEY, SECRET, ID));
  assert.equal(await decryptDeviceKey(cipher, SECRET, ID), KEY);
  await assert.rejects(decryptDeviceKey(cipher, "rotated-secret", ID), /key_unavailable/);
  await assert.rejects(decryptDeviceKey(cipher, SECRET, "other-pvs"), /key_unavailable/);
  await assert.rejects(decryptDeviceKey(cipher + "x", SECRET, ID), /key_unavailable/);
  await assert.rejects(decryptDeviceKey("invalid", SECRET, ID), /key_unavailable/);
});

test("configuration defaults off, redacts keys, and supports test, pause, resume and deletion", async (t) => {
  const { db, enable, row } = database(t);
  assert.equal((await getNotifications(db, ID, NOW)).configured, false);
  await checkNotifications(db, SECRET, ID, NOW, async () => { throw new Error("must not send"); });
  assert.equal((await enable()).status, 200);
  const response = await getNotifications(db, ID, NOW + 181);
  assert.equal(response.monitoring, "not_running");
  assert.equal(response.enabled, true);
  assert.ok(!JSON.stringify(response).includes(KEY));
  assert.ok(!JSON.stringify(response).includes(String(row().device_key_cipher)));
  assert.equal((await mutateNotifications(db, SECRET, ID, "test", {}, NOW + 30, ok)).status, 200);
  assert.equal((await mutateNotifications(db, SECRET, ID, "save", { enabled: false }, NOW + 31, ok)).status, 200);
  assert.equal((await getNotifications(db, ID, NOW + 31)).configured, true);
  assert.equal((await mutateNotifications(db, SECRET, ID, "save", { enabled: true }, NOW + 60, ok)).status, 200);
  assert.equal((await mutateNotifications(db, SECRET, ID, "delete", null, NOW + 61, ok)).status, 200);
  assert.equal(row().device_key_cipher, null);
  assert.equal(row().enabled, 0);
});

test("invalid configuration cannot send; tests are rate-limited even across deletion", async (t) => {
  const { db, enable } = database(t);
  for (const body of [null, { enabled: "true" }, { enabled: true, device_key: "bad key" },
    { enabled: true, device_key: KEY, url: "https://untrusted.example" }, { enabled: false, device_key: KEY }]) {
    assert.equal((await mutateNotifications(db, SECRET, ID, "save", body, NOW, ok)).status, 400);
  }
  assert.equal((await enable()).status, 200);
  assert.equal((await mutateNotifications(db, SECRET, ID, "test", {}, NOW + 1, ok)).status, 429);
  await mutateNotifications(db, SECRET, ID, "delete", null, NOW + 2, ok);
  assert.equal((await enable(NOW + 3)).status, 429);
});

test("failed testing preserves the old device and hides provider response details", async (t) => {
  const { db, enable, row } = database(t);
  await enable();
  const cipher = row().device_key_cipher;
  const failure: typeof fetch = async () => new Response(JSON.stringify({ code: 400, message: KEY }));
  const result = await mutateNotifications(db, SECRET, ID, "save", { enabled: true, device_key: "another-synthetic-device" }, NOW + 30, failure);
  assert.deepEqual(result, { status: 502, body: { error: "bark_rejected" } });
  assert.equal(row().device_key_cipher, cipher);
  assert.equal(row().enabled, 1);
});

test("Bark redirects are rejected without forwarding the key using Workers-supported fetch options", async (t) => {
  const { db, row } = database(t);
  let calls = 0;
  const redirect: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://untrusted.example" } });
  };
  const result = await mutateNotifications(db, SECRET, ID, "save", { enabled: true, device_key: KEY }, NOW, redirect);
  assert.deepEqual(result, { status: 502, body: { error: "bark_rejected" } });
  assert.equal(calls, 1);
  assert.equal(row().device_key_cipher, null);
  assert.equal(row().enabled, 0);
});

test("missing data alerts once after grace, recovers after three checks, and re-arms", async (t) => {
  const { db, enable, reading, row } = database(t);
  const titles: string[] = [];
  const send: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.day.app/push");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.device_key, KEY);
    assert.equal(payload.group, "sunpower-monitor");
    assert.equal(payload.ttl, undefined);
    titles.push(payload.title);
    return ok(url, init);
  };
  await enable();
  await checkNotifications(db, SECRET, ID, NOW + 599, send);
  assert.equal(titles.length, 0);
  await checkNotifications(db, SECRET, ID, NOW + 660, send);
  await checkNotifications(db, SECRET, ID, NOW + 720, send);
  assert.deepEqual(titles, ["SunPower data alert"]);
  for (const offset of [780, 840, 900]) {
    reading(NOW + offset);
    await checkNotifications(db, SECRET, ID, NOW + offset, send);
  }
  assert.deepEqual(titles, ["SunPower data alert", "SunPower data recovered"]);
  assert.equal(row().notified, 0);
  await checkNotifications(db, SECRET, ID, NOW + 1500, send);
  assert.equal(titles.length, 3);
});

test("zero power is healthy, transient partial quality is ignored, sustained invalid data alerts", async (t) => {
  const { db, enable, reading } = database(t);
  let sent = 0;
  const send: typeof fetch = async () => { sent++; return ok(""); };
  await enable();
  reading(NOW);
  await checkNotifications(db, SECRET, ID, NOW, send);
  reading(NOW + 60, "partial");
  await checkNotifications(db, SECRET, ID, NOW + 60, send);
  reading(NOW + 120);
  await checkNotifications(db, SECRET, ID, NOW + 120, send);
  assert.equal(sent, 0);
  for (let offset = 180; offset <= 780; offset += 60) {
    reading(NOW + offset, "clock_invalid", null);
    await checkNotifications(db, SECRET, ID, NOW + offset, send);
  }
  assert.equal(sent, 1);
});

test("old measurements and old collected timestamps cannot recover an incident", async (t) => {
  const { db, enable, reading, row } = database(t);
  let sent = 0;
  const send: typeof fetch = async () => { sent++; return ok(""); };
  await enable();
  reading(NOW + 600, "ok", NOW);
  await checkNotifications(db, SECRET, ID, NOW + 600, send);
  assert.equal(row().observed_state, "measurement_invalid");
  assert.equal(sent, 1);
  reading(NOW + 660, "ok", NOW, NOW);
  await checkNotifications(db, SECRET, ID, NOW + 660, send);
  assert.equal(row().notified, 1);
  assert.equal(row().recovery_count, 0);
  assert.equal(sent, 1);
});

test("continuously lagging measurements alert even when their old timestamps keep advancing", async (t) => {
  const { db, enable, reading, row } = database(t);
  await enable();
  let sent = 0;
  const send: typeof fetch = async () => { sent++; return ok(""); };
  for (let offset = 0; offset <= 660; offset += 60) {
    reading(NOW + offset, "ok", NOW + offset - 300);
    await checkNotifications(db, SECRET, ID, NOW + offset, send);
  }
  assert.equal(row().failure_since_ts, NOW);
  assert.equal(sent, 1);
});

test("transient delivery failures retry with backoff; resolved unsent alerts are cancelled", async (t) => {
  const { db, enable, reading, row } = database(t);
  await enable();
  let sent = 0;
  const failure: typeof fetch = async () => { sent++; return new Response("private detail", { status: 503 }); };
  await checkNotifications(db, SECRET, ID, NOW + 600, failure);
  assert.equal(row().notified, 0);
  assert.equal(row().retry_at_ts, NOW + 660);
  await checkNotifications(db, SECRET, ID, NOW + 630, failure);
  assert.equal(sent, 1);
  await checkNotifications(db, SECRET, ID, NOW + 660, failure);
  assert.equal(row().retry_at_ts, NOW + 780);
  reading(NOW + 720);
  await checkNotifications(db, SECRET, ID, NOW + 720, failure);
  assert.equal(row().failure_since_ts, null);
  assert.equal(row().retry_at_ts, 0);
  assert.equal(sent, 2);
});

test("permanent rejection or session-secret rotation pauses alerts with a safe error", async (t) => {
  const { db, enable, row } = database(t);
  await enable();
  await checkNotifications(db, SECRET, ID, NOW + 600, async () => new Response(JSON.stringify({ code: 400, message: KEY })));
  assert.equal(row().enabled, 0);
  assert.equal(row().last_error, "bark_rejected");
  await enable(NOW + 700);
  await checkNotifications(db, "rotated-secret", ID, NOW + 1300, ok);
  assert.equal(row().enabled, 0);
  assert.equal(row().last_error, "key_unavailable");
});

test("a failed recovery notification retries without prematurely closing the incident", async (t) => {
  const { db, enable, reading, row } = database(t);
  await enable();
  await checkNotifications(db, SECRET, ID, NOW + 600, ok);
  let attempts = 0;
  const send: typeof fetch = async () => {
    attempts++;
    return attempts === 1 ? new Response("private detail", { status: 503 }) : ok("");
  };
  for (const offset of [660, 720, 780]) {
    reading(NOW + offset);
    await checkNotifications(db, SECRET, ID, NOW + offset, send);
  }
  assert.equal(row().notified, 1);
  assert.equal(row().observed_state, "recovering");
  reading(NOW + 840);
  await checkNotifications(db, SECRET, ID, NOW + 840, send);
  assert.equal(attempts, 2);
  assert.equal(row().notified, 0);
  assert.equal(row().observed_state, "normal");
});

test("network errors are safe, paused configurations do not send, and collector settings are isolated", async (t) => {
  const { db, enable, row } = database(t);
  await enable();
  await checkNotifications(db, SECRET, ID, NOW + 600, async () => { throw new Error(KEY); });
  assert.equal(row().last_error, "bark_unreachable");
  assert.equal(row().enabled, 1);
  assert.equal((await getNotifications(db, "other-pvs", NOW)).configured, false);
  await mutateNotifications(db, SECRET, ID, "save", { enabled: false }, NOW + 601, ok);
  await checkNotifications(db, SECRET, ID, NOW + 720, async () => { throw new Error("must not send"); });
  assert.equal(row().last_checked_ts, null);
});

test("overlapping checks and configuration changes cannot send twice or replace an in-flight device", async (t) => {
  const { db, enable, row } = database(t);
  await enable();
  let accept!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { accept = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let sends = 0;
  const slow: typeof fetch = async () => { sends++; started(); await waiting; return ok(""); };
  const first = checkNotifications(db, SECRET, ID, NOW + 600, slow);
  await entered;
  await checkNotifications(db, SECRET, ID, NOW + 600, slow);
  assert.equal((await mutateNotifications(db, SECRET, ID, "delete", null, NOW + 600, ok)).status, 429);
  accept(); await first;
  await checkNotifications(db, SECRET, ID, NOW + 600, slow);
  assert.equal(sends, 1);
  assert.equal(row().lease_token, null);
});

test("duplicate checks and scheduler gaps do not accelerate recovery", async (t) => {
  const { db, enable, reading, row } = database(t);
  await enable();
  await checkNotifications(db, SECRET, ID, NOW + 600, ok);
  reading(NOW + 660);
  await checkNotifications(db, SECRET, ID, NOW + 660, ok);
  await checkNotifications(db, SECRET, ID, NOW + 660, ok);
  assert.equal(row().recovery_count, 1);
  reading(NOW + 840);
  await checkNotifications(db, SECRET, ID, NOW + 840, ok);
  assert.equal(row().recovery_count, 1);
});

test("additive upgrade is repeatable and matches the installation schema", (t) => {
  const { sqlite } = database(t);
  const before = sqlite.prepare("PRAGMA table_info(site_notifications)").all();
  const upgrade = new DatabaseSync(":memory:");
  t.after(() => upgrade.close());
  const sql = readFileSync("workers/migrations/2026-10-09-notifications.sql", "utf8");
  upgrade.exec(sql); upgrade.exec(sql);
  assert.deepEqual(upgrade.prepare("PRAGMA table_info(site_notifications)").all(), before);
});

test("notification APIs require login, same origin, bounded bodies and redact stored secrets", async (t) => {
  const { db } = database(t);
  const cookie = await signSession({ userId: "123", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const env = { DB: db, SESSION_SECRET: SECRET, ALLOWED_USER_IDS: "123", COLLECTOR_ID: ID } as Env;
  const url = "https://solar.example/api/v1/notifications";
  const request = (method: string, body?: string, origin = "https://solar.example") => new Request(url, {
    method, headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Origin: origin }, body,
  });
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await dashboard.fetch(new Request(url, { method }), env)).status, 401);
  assert.equal((await dashboard.fetch(request("PUT", "{}", "https://attacker.example"), env)).status, 403);
  assert.equal((await dashboard.fetch(request("DELETE", undefined, "https://attacker.example"), env)).status, 403);
  assert.equal((await dashboard.fetch(request("PUT", "x".repeat(4097)), env)).status, 413);
  assert.equal((await dashboard.fetch(request("PUT", "{invalid"), env)).status, 400);
  assert.equal((await dashboard.fetch(request("PUT", JSON.stringify({ enabled: "true" })), env)).status, 400);
  assert.equal((await dashboard.fetch(request("POST", "{}"), env)).status, 405);
  assert.equal((await dashboard.fetch(new Request(url + "/test", { method: "POST", body: "{}" }), env)).status, 401);
  assert.equal((await dashboard.fetch(new Request(url + "/test", { method: "POST", body: "{}",
    headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Origin: "https://attacker.example" } }), env)).status, 403);
  const original = globalThis.fetch;
  globalThis.fetch = ok;
  try {
    const saved = await dashboard.fetch(request("PUT", JSON.stringify({ enabled: true, device_key: KEY })), env);
    assert.equal(saved.status, 200);
    const text = await saved.text();
    assert.ok(!text.includes(KEY) && !text.includes("device_key_cipher"));
    const get = await dashboard.fetch(request("GET"), env);
    assert.equal(get.headers.get("Cache-Control"), "no-store");
    assert.equal((await get.json() as { enabled: boolean }).enabled, true);
  } finally { globalThis.fetch = original; }
});
