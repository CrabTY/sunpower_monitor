import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_COOKIE } from "../src/constants.js";
import dashboard, { type Env } from "../src/index.js";
import { freshness, presentLatest } from "../src/live.js";
import { authorizeUrl, exchangeCode, fetchUserId, isAllowedUser, oauthFailureCode } from "../src/oauth.js";
import { pkceChallenge, signSession, verifySession } from "../src/session.js";

const SECRET = "test-session-secret";
const NOW = Math.floor(Date.parse("2026-09-18T03:00:00Z") / 1000);

function stubResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: () => ({ first: async () => null }) } as unknown as D1Database,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: SECRET,
    ALLOWED_USER_IDS: "123456",
    ...overrides,
  };
}

test("session cookies round-trip, reject tampering, and expire", async () => {
  const token = await signSession({ userId: "123456", expiresAt: NOW + 60 }, SECRET);
  assert.deepEqual(await verifySession(token, SECRET, NOW), { userId: "123456", expiresAt: NOW + 60 });
  assert.equal(await verifySession(token, "other-secret", NOW), null);
  const [payload, signature] = token.split(".");
  assert.equal(await verifySession(`${payload}.${signature}x`, SECRET, NOW), null);
  assert.equal(await verifySession(`${payload}x.${signature}`, SECRET, NOW), null);
  assert.equal(await verifySession(undefined, SECRET, NOW), null);
  assert.equal(await verifySession("garbage", SECRET, NOW), null);
  assert.equal(await verifySession(`${payload}.%`, SECRET, NOW), null);
  assert.equal(await verifySession(`${token}.extra`, SECRET, NOW), null);
  assert.equal(await verifySession(token, SECRET, NOW + 61), null);
});

test("pkce challenge matches the RFC 7636 example", async () => {
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("authorize url carries state, pkce, and no scopes", () => {
  const url = new URL(
    authorizeUrl({ clientId: "cid", clientSecret: "cs", redirectUri: "https://solar.example/auth/callback" }, "st", "ch"),
  );
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "");
});

test("token exchange and user lookup handle success and failure", async () => {
  const config = { clientId: "cid", clientSecret: "cs", redirectUri: "https://solar.example/auth/callback" };
  const ok: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("access_token")) return stubResponse({ access_token: "gho_test" });
    return stubResponse({ id: 123456, login: "example-user" });
  };
  assert.equal(await exchangeCode(ok, config, "code", "verifier"), "gho_test");
  assert.equal(await fetchUserId(ok, "gho_test"), "123456");

  const bad: typeof fetch = async () => stubResponse({ error: "bad_verification_code" });
  await assert.rejects(() => exchangeCode(bad, config, "code", "verifier"), /github_token_bad_verification_code/);
  const failing: typeof fetch = async () => stubResponse({}, 500);
  await assert.rejects(() => fetchUserId(failing, "gho_test"), /github_user_500/);
});

test("OAuth diagnostics expose fixed failure codes without leaking provider details", async () => {
  const config = { clientId: "cid", clientSecret: "cs", redirectUri: "https://solar.example/auth/callback" };
  for (const code of ["incorrect_client_credentials", "redirect_uri_mismatch", "bad_verification_code", "unverified_user_email"]) {
    await assert.rejects(() => exchangeCode(async () => stubResponse({
      error: code, error_description: "private provider detail",
    }), config, "code", "verifier"), (error) => oauthFailureCode(error) === `github_token_${code}`);
  }
  await assert.rejects(() => exchangeCode(async () => stubResponse({ error: "private-value" }), config, "code", "verifier"),
    (error) => oauthFailureCode(error) === "github_token_missing");
  assert.equal(oauthFailureCode(new Error("github_user_401")), "github_user_401");
  assert.equal(oauthFailureCode(new Error("github_token_missing secret-value")), "unknown");
  assert.equal(oauthFailureCode(new Error("private-value")), "unknown");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => stubResponse({ error: "incorrect_client_credentials", error_description: "private-value" });
  try {
    const cookie = btoa(JSON.stringify({ state: "expected", verifier: "v", redirectUri: config.redirectUri }));
    const response = await dashboard.fetch(new Request(`${config.redirectUri}?code=abc&state=expected`, {
      headers: { Cookie: `spm_oauth=${cookie}` },
    }), env());
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "oauth_failed:github_token_incorrect_client_credentials");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("allowlist accepts only listed numeric ids", () => {
  assert.equal(isAllowedUser("123456", "123456"), true);
  assert.equal(isAllowedUser("123456", "1, 123456 ,2"), true);
  assert.equal(isAllowedUser("123456", "1,2"), false);
  assert.equal(isAllowedUser("123456", ""), false);
});

test("freshness thresholds follow measurement age", () => {
  assert.equal(freshness(0), "live");
  assert.equal(freshness(30), "live");
  assert.equal(freshness(31), "delayed");
  assert.equal(freshness(60), "delayed");
  assert.equal(freshness(61), "stale");
  assert.equal(freshness(null), "unavailable");
});

test("a missing latest row is unavailable, never a zero reading", () => {
  const payload = presentLatest(null, NOW);
  assert.equal(payload.state, "unavailable");
  for (const field of ["pv_kw", "load_kw_reported", "grid_kw", "export_kw", "import_kw", "battery_kw"]) {
    assert.equal(payload[field], null);
  }
});

test("grid direction and staleness are reported from the stored row", () => {
  const row = {
    collected_ts: NOW - 5,
    measured_ts: NOW - 5,
    received_ts: NOW - 4,
    quality: "ok",
    pv_kw: 3.2,
    load_kw_reported: 1.4,
    grid_kw: -1.8,
    battery_kw: null,
    pv_kwh_total: 12345.6,
    load_kwh_total_reported: 67890.1,
    grid_net_kwh_total: -4321.0,
  };
  const fresh = presentLatest(row, NOW);
  assert.equal(fresh.state, "live");
  assert.equal(fresh.export_kw, 1.8);
  assert.equal(fresh.import_kw, 0);
  assert.equal(fresh.battery_kw, null);
  assert.equal(fresh.measured_at_utc, "2026-09-18T02:59:55Z");

  const stale = presentLatest({ ...row, measured_ts: NOW - 600 }, NOW);
  assert.equal(stale.state, "stale");
  assert.equal(stale.age_seconds, 600);
  assert.equal(stale.pv_kw, 3.2);
  assert.equal(stale.import_kw, 0);
  assert.equal(stale.export_kw, 1.8);
});

test("anonymous page, asset, and api requests are refused", async () => {
  const api = await dashboard.fetch(new Request("https://solar.example/api/v1/live"), env());
  assert.equal(api.status, 401);
  const page = await dashboard.fetch(
    new Request("https://solar.example/", { headers: { Accept: "text/html" } }),
    env(),
  );
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("Location"), "https://solar.example/auth/login");
  const asset = await dashboard.fetch(new Request("https://solar.example/app.js"), env());
  assert.equal(asset.status, 401);
  const malformed = await dashboard.fetch(new Request("https://solar.example/api/v1/live", {
    headers: { Cookie: `${SESSION_COOKIE}=payload.%` },
  }), env());
  assert.equal(malformed.status, 401);
});

test("version metadata is anonymous and does not touch the database", async () => {
  const response = await dashboard.fetch(new Request("https://solar.example/api/v1/version"), env());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as Record<string, unknown>).service, "sunpower-monitor-dashboard");
});

test("an authenticated session reads live values and assets", async () => {
  const cookie = await signSession({ userId: "123456", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const row = {
    collected_ts: Math.floor(Date.now() / 1000) - 4,
    measured_ts: Math.floor(Date.now() / 1000) - 4,
    received_ts: Math.floor(Date.now() / 1000) - 3,
    quality: "ok",
    pv_kw: 3.2,
    load_kw_reported: 1.4,
    grid_kw: 2.5,
    battery_kw: null,
    pv_kwh_total: 1,
    load_kwh_total_reported: 2,
    grid_net_kwh_total: 3,
  };
  const database = { prepare: (sql: string) => ({
    bind: () => ({ first: async () => null }),
    first: async () => sql.includes("latest_site") ? row : null,
  }) } as unknown as D1Database;
  const response = await dashboard.fetch(
    new Request("https://solar.example/api/v1/live", { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }),
    env({ DB: database }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.state, "live");
  assert.equal(payload.import_kw, 2.5);
  assert.equal(payload.export_kw, 0);
  assert.deepEqual(payload.calibration, { grid_ratio: 1, updated_at_utc: null });

  let served = false;
  const assets = {
    fetch: async () => {
      served = true;
      return new Response("asset", { status: 200 });
    },
  };
  const asset = await dashboard.fetch(
    new Request("https://solar.example/app.js", { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }),
    env({ ASSETS: assets }),
  );
  assert.equal(asset.status, 200);
  assert.equal(served, true);
  assert.equal(asset.headers.get("X-Content-Type-Options"), "nosniff");
});

test("login sets a short-lived pkce cookie and redirects to GitHub", async () => {
  const response = await dashboard.fetch(new Request("https://solar.example/auth/login"), env());
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Location") ?? "", /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const cookie = response.headers.get("Set-Cookie") ?? "";
  assert.match(cookie, /^spm_oauth=/);
  assert.match(cookie, /Max-Age=600/);
  assert.match(cookie, /HttpOnly/);
});

test("callback rejects a mismatched state", async () => {
  const cookie = btoa(JSON.stringify({ state: "expected", verifier: "v", redirectUri: "https://solar.example/auth/callback" }));
  const response = await dashboard.fetch(
    new Request("https://solar.example/auth/callback?code=abc&state=other", { headers: { Cookie: `spm_oauth=${cookie}` } }),
    env(),
  );
  assert.equal(response.status, 400);
});

test("unlisted GitHub users cannot log in or use an existing session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("access_token")
    ? stubResponse({ access_token: "test-token" }) : stubResponse({ id: 999999 });
  try {
    const cookie = btoa(JSON.stringify({ state: "expected", verifier: "v", redirectUri: "https://solar.example/auth/callback" }));
    const response = await dashboard.fetch(new Request("https://solar.example/auth/callback?code=abc&state=expected", {
      headers: { Cookie: `spm_oauth=${cookie}` },
    }), env());
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Set-Cookie"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const cookie = await signSession({ userId: "999999", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const privateEnv = env({
    DB: { prepare: () => { throw new Error("unauthorized database access"); } } as unknown as D1Database,
    ASSETS: { fetch: async () => { throw new Error("unauthorized asset access"); } },
  });
  for (const path of ["/api/v1/live", "/", "/app.js"]) {
    const response = await dashboard.fetch(new Request(`https://solar.example${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    }), privateEnv);
    assert.equal(response.status, 401, path);
  }
});

test("logout clears the session cookie", async () => {
  const response = await dashboard.fetch(new Request("https://solar.example/auth/logout", { method: "POST" }), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie") ?? "", /^spm_session=; Path=\/; Max-Age=0/);
  const browser = await dashboard.fetch(new Request("https://solar.example/auth/logout", {
    method: "POST", headers: { Accept: "text/html", Origin: "https://solar.example", "Sec-Fetch-Site": "same-origin" },
  }), env());
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.match(await browser.text(), /Signed out/);
  assert.match(browser.headers.get("Set-Cookie") ?? "", /^spm_session=; Path=\/; Max-Age=0/);
});

test("logout rejects cross-origin requests without clearing the session", async () => {
  const attempts: Record<string, string>[] = [
    { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: "https://solar.example.attacker.example", "Sec-Fetch-Site": "same-origin" },
  ];
  for (const headers of attempts) {
    for (const Accept of ["text/html", "application/json"]) {
      const response = await dashboard.fetch(new Request("https://solar.example/auth/logout", {
        method: "POST", headers: { ...headers, Accept },
      }), env());
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "cross_origin" });
      assert.equal(response.headers.get("Set-Cookie"), null);
    }
  }
});
