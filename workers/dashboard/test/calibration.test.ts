import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_COOKIE } from "../src/constants.js";
import dashboard, { type Env } from "../src/index.js";
import { signSession } from "../src/session.js";

test("calibration is private, same-origin, bounded, and saved per collector", async () => {
  const secret = "test-session-secret";
  const cookie = await signSession({ userId: "123456", expiresAt: Math.floor(Date.now() / 1000) + 60 }, secret);
  let stored: { grid_ratio: number; updated_ts: number } | null = null;
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => stored,
        run: async () => {
          assert.match(sql, /INSERT INTO site_calibration/);
          assert.equal(values[0], "home-pvs");
          stored = { grid_ratio: values[1] as number, updated_ts: values[2] as number };
        },
      }),
    }),
  } as unknown as D1Database;
  const env = { DB: db, SESSION_SECRET: secret, ALLOWED_USER_IDS: "123456" } as Env;
  const url = "https://solar.example/api/v1/calibration";
  const get = () => dashboard.fetch(new Request(url, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }), env);
  const put = (body: unknown, origin = "https://solar.example") => dashboard.fetch(new Request(url, {
    method: "PUT",
    headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);

  assert.equal((await dashboard.fetch(new Request(url), env)).status, 401);
  assert.equal((await (await get()).json() as { grid_ratio: number }).grid_ratio, 1);
  assert.equal((await put({ grid_ratio: 0.465 }, "https://attacker.example")).status, 403);
  for (const value of [0, 0.099, 2.001, "0.465", null]) {
    assert.equal((await put({ grid_ratio: value })).status, 400);
  }
  assert.equal(stored, null);
  assert.equal((await put({ grid_ratio: 0.465 })).status, 200);
  assert.equal((await (await get()).json() as { grid_ratio: number }).grid_ratio, 0.465);
  assert.equal((await put({ grid_ratio: 1 })).status, 200);
  assert.equal((await (await get()).json() as { grid_ratio: number }).grid_ratio, 1);
});
