/** Optional Bark configuration and cloud monitoring; keys never leave this module. */
import { isPlainObject } from "../../shared/contract.js";
import { base64UrlDecode, base64UrlEncode, randomToken } from "./session.js";
import { toIso } from "./live.js";

const FAILURE_SECONDS = 600;
const FRESH_SECONDS = 120;
const encoder = new TextEncoder();
type Issue = "data_missing" | "measurement_invalid";
interface Settings {
  collector_id: string;
  device_key_cipher: string | null;
  enabled: number;
  enabled_ts: number;
  observed_state: string;
  failure_since_ts: number | null;
  notified: number;
  recovery_count: number;
  last_checked_ts: number | null;
  last_sent_ts: number | null;
  last_error: string | null;
  retry_count: number;
  retry_at_ts: number;
  next_test_ts: number;
  lease_token: string | null;
  lease_until_ts: number;
}
interface Reading {
  received_ts: number;
  collected_ts: number;
  measured_ts: number | null;
  quality: string;
}
class NotificationError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new NotificationError("key_unavailable");
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("sunpower-monitor"), info: encoder.encode("bark-device-key/v1") },
  root, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptDeviceKey(key: string, secret: string, collector: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(collector) },
    await encryptionKey(secret), encoder.encode(key));
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

export async function decryptDeviceKey(cipher: string, secret: string, collector: string): Promise<string> {
  try {
    const [version, iv, value, extra] = cipher.split(".");
    if (version !== "v1" || !iv || !value || extra !== undefined) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(iv),
      additionalData: encoder.encode(collector) }, await encryptionKey(secret), base64UrlDecode(value));
    return new TextDecoder().decode(plain);
  } catch { throw new NotificationError("key_unavailable"); }
}

async function push(key: string, title: string, body: string, fetcher: typeof fetch): Promise<void> {
  try {
    const response = await fetcher("https://api.day.app/push", { method: "POST", redirect: "manual",
      signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_key: key, title, body, group: "sunpower-monitor" }) });
    if (!response.ok) throw new NotificationError("bark_rejected", response.status === 429 || response.status >= 500);
    const result: unknown = await response.json();
    if (!isPlainObject(result) || result.code !== 200) {
      throw new NotificationError("bark_rejected", !isPlainObject(result) || typeof result.code !== "number" ||
        result.code === 429 || result.code >= 500);
    }
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    throw new NotificationError("bark_unreachable", true);
  }
}

function present(row: Settings | null, now: number): Record<string, unknown> {
  return {
    configured: Boolean(row?.device_key_cipher), enabled: Boolean(row?.enabled),
    state: row?.observed_state ?? "normal", last_error: row?.last_error ?? null,
    last_checked_at_utc: toIso(row?.last_checked_ts ?? null), last_sent_at_utc: toIso(row?.last_sent_ts ?? null),
    monitoring: !row?.enabled ? "paused" : now - (row.last_checked_ts ?? row.enabled_ts) > 180 ? "not_running" :
      row.last_checked_ts === null ? "starting" : "running",
  };
}

async function read(db: D1Database, collector: string): Promise<Settings | null> {
  return db.prepare("SELECT * FROM site_notifications WHERE collector_id = ?").bind(collector).first<Settings>();
}

export async function getNotifications(db: D1Database, collector: string, now: number): Promise<Record<string, unknown>> {
  return present(await read(db, collector), now);
}

async function release(db: D1Database, collector: string, token: string): Promise<void> {
  await db.prepare("UPDATE site_notifications SET lease_token = NULL, lease_until_ts = 0 WHERE collector_id = ? AND lease_token = ?")
    .bind(collector, token).run();
}

export async function mutateNotifications(db: D1Database, secret: string, collector: string,
  action: "save" | "test" | "delete", body: unknown, now: number, fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (action !== "delete" && (!isPlainObject(body) || Object.keys(body).some((key) =>
    !["device_key", ...(action === "save" ? ["enabled"] : [])].includes(key)) ||
    (action === "save" && typeof body.enabled !== "boolean") ||
    (body.device_key !== undefined && (typeof body.device_key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.device_key))) ||
    (action === "save" && body.enabled === false && body.device_key !== undefined))) {
    return { status: 400, body: { error: "invalid_notification_settings" } };
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const sending = action === "test" || action === "save" && input.enabled === true;
  await db.prepare("INSERT INTO site_notifications (collector_id) VALUES (?) ON CONFLICT DO NOTHING").bind(collector).run();
  const token = randomToken();
  const row = await db.prepare("UPDATE site_notifications SET lease_token = ?, lease_until_ts = ?," +
    " next_test_ts = CASE WHEN ? THEN ? ELSE next_test_ts END WHERE collector_id = ? AND lease_until_ts <= ?" +
    " AND (? = 0 OR next_test_ts <= ?) RETURNING *")
    .bind(token, now + 40, Number(sending), now + 30, collector, now, Number(sending), now).first<Settings>();
  if (!row) return { status: 429, body: { error: "notification_busy" } };
  try {
    let cipher = row.device_key_cipher;
    if (sending) {
      if (!input.device_key && !cipher) return { status: 400, body: { error: "device_key_required" } };
      const key = typeof input.device_key === "string" ? input.device_key : await decryptDeviceKey(cipher!, secret, collector);
      if (action === "save") cipher = await encryptDeviceKey(key, secret, collector);
      await push(key, "SunPower notification test", "Test notification from your solar monitor.", fetcher);
    }
    if (action === "test") {
      await db.prepare("UPDATE site_notifications SET last_sent_ts = ?, last_error = NULL WHERE collector_id = ? AND lease_token = ?")
        .bind(now, collector, token).run();
    } else {
      await db.prepare("UPDATE site_notifications SET device_key_cipher = ?, enabled = ?, enabled_ts = ?," +
        " observed_state = 'normal', failure_since_ts = NULL, notified = 0, recovery_count = 0," +
        " last_checked_ts = NULL, last_error = NULL, retry_count = 0, retry_at_ts = 0," +
        " last_sent_ts = CASE WHEN ? THEN ? ELSE last_sent_ts END WHERE collector_id = ? AND lease_token = ?")
        .bind(action === "delete" ? null : cipher, Number(action === "save" && input.enabled === true), now,
          Number(sending), now, collector, token).run();
    }
    return { status: 200, body: { ...await getNotifications(db, collector, now), test_sent: sending } };
  } catch (error) {
    // Provider errors must never expose a device key or an upstream response body.
    return { status: 502, body: { error: error instanceof NotificationError ? error.code : "notification_storage_failed" } };
  } finally { await release(db, collector, token); }
}

function issue(reading: Reading | null, now: number): { state: Issue; since: number | null } | null {
  if (!reading) return { state: "data_missing", since: null };
  if (now - reading.received_ts > FRESH_SECONDS || now - reading.collected_ts > FRESH_SECONDS) {
    return { state: "data_missing", since: Math.min(reading.received_ts, reading.collected_ts) };
  }
  if (reading.measured_ts !== null && now - reading.measured_ts > FRESH_SECONDS) {
    return { state: "measurement_invalid", since: reading.measured_ts };
  }
  if (reading.quality !== "ok" || reading.measured_ts === null || reading.measured_ts > now + FRESH_SECONDS) {
    return { state: "measurement_invalid", since: null };
  }
  return null;
}

export async function checkNotifications(db: D1Database, secret: string, collector: string, now: number,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const settings = await read(db, collector);
  if (!settings?.enabled) return;
  const token = randomToken();
  const row = await db.prepare("UPDATE site_notifications SET lease_token = ?, lease_until_ts = ? WHERE collector_id = ?" +
    " AND enabled = 1 AND lease_until_ts <= ? AND (last_checked_ts IS NULL OR last_checked_ts <= ?) RETURNING *")
    .bind(token, now + 40, collector, now, now - 30).first<Settings>();
  if (!row) return;
  try {
    const reading = await db.prepare("SELECT received_ts, collected_ts, measured_ts, quality FROM latest_site WHERE collector_id = ?")
      .bind(collector).first<Reading>();
    const fault = issue(reading, now);
    const candidate = fault?.since ?? (reading === null ? row.enabled_ts : now);
    const since = fault ? Math.max(row.enabled_ts, Math.min(candidate, row.failure_since_ts ?? candidate)) : row.failure_since_ts;
    const recovery = fault ? 0 : row.notified ?
      (row.last_checked_ts !== null && now - row.last_checked_ts <= 90 ? row.recovery_count + 1 : 1) : 0;
    let notified = row.notified, error = row.last_error, retries = row.retry_count, retryAt = row.retry_at_ts;
    let lastSent = row.last_sent_ts, enabled = row.enabled;
    const alert = Boolean(fault && !notified && since !== null && now - since >= FAILURE_SECONDS);
    const recovered = !fault && notified && recovery >= 3;
    if (!fault && !notified) { error = null; retries = 0; retryAt = 0; }
    if ((alert || recovered) && now >= retryAt) {
      try {
        const key = await decryptDeviceKey(row.device_key_cipher!, secret, collector);
        // shortcut: a crash after Bark accepts a push can duplicate it; add delivery IDs if that becomes unacceptable.
        await push(key, recovered ? "SunPower data recovered" : "SunPower data alert", recovered ?
          `Current valid readings have resumed. Interruption lasted about ${Math.ceil((now - (since ?? now)) / 60)} minutes.` :
          fault!.state === "data_missing" ? "No current site readings for at least 10 minutes. Check your collector, network and PVS." :
            "Site readings have remained stale or invalid for at least 10 minutes. Check your PVS and collector.", fetcher);
        notified = recovered ? 0 : 1; lastSent = now; error = null; retries = 0; retryAt = 0;
      } catch (failure) {
        error = failure instanceof NotificationError ? failure.code : "notification_failed";
        retries += 1;
        retryAt = now + Math.min(3600, 60 * 2 ** Math.min(retries - 1, 6));
        if (!(failure instanceof NotificationError) || !failure.retryable) enabled = 0;
      }
    }
    await db.prepare("UPDATE site_notifications SET observed_state = ?, failure_since_ts = ?, notified = ?," +
      " recovery_count = ?, last_checked_ts = ?, last_sent_ts = ?, last_error = ?, retry_count = ?, retry_at_ts = ?, enabled = ?" +
      " WHERE collector_id = ? AND lease_token = ?")
      .bind(fault?.state ?? (notified ? "recovering" : "normal"), fault || notified ? since : null,
        notified, notified ? recovery : 0, now, lastSent, error, retries, retryAt, enabled, collector, token).run();
  } finally { await release(db, collector, token); }
}
