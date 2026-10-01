import assert from "node:assert/strict";
import { test } from "node:test";

import { dayBounds, localDay, refreshSiteDays } from "../../shared/site-day.js";

test("site day bounds keep 23 and 25-hour DST days", () => {
  const zone = "America/Los_Angeles";
  const spring = dayBounds("2026-03-08", zone);
  const fall = dayBounds("2026-11-01", zone);
  assert.deepEqual(spring, {
    start: Date.parse("2026-03-08T08:00:00Z") / 1000,
    end: Date.parse("2026-03-09T07:00:00Z") / 1000,
  });
  assert.equal(fall.end - fall.start, 25 * 3600);
  assert.equal(localDay(spring.start - 1, zone), "2026-03-07");
  assert.equal(localDay(spring.end - 1, zone), "2026-03-08");
});

test("the hourly refresh finalizes yesterday across a DST jump", async () => {
  const spring = dayBounds("2026-03-08", "America/Los_Angeles");
  const now = Date.parse("2026-03-09T07:17:00Z") / 1000;
  const writes: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) { statement.values = values; return statement; },
        async first() {
          if (sql.startsWith("SELECT timezone")) return { timezone: "America/Los_Angeles" };
          if (sql.startsWith("SELECT MIN")) return { first_ts: spring.start };
          return { windows: 1, ok_windows: 1, source_error_windows: 0, sample_count: 6, valid_count: 6 };
        },
        async all() {
          return { results: [{ local_date: "2026-03-08", timezone: "America/Los_Angeles", end_ts: spring.end, updated_ts: spring.start + 3600 }] };
        },
        async run() { writes.push(statement.values); return { success: true }; },
      };
      return statement;
    },
  };
  await refreshSiteDays(db as unknown as D1Database, "home-pvs", now);
  assert.deepEqual(writes.map((values) => values[1]).sort(), ["2026-03-08", "2026-03-09"]);
  assert.deepEqual(writes.find((values) => values[1] === "2026-03-08")?.slice(3, 5), [spring.start, spring.end]);
});
